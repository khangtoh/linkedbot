import type { Cost } from "../limits.js";
import { evalValue, exprError, exprsIn, isExpr, stepRefs, type Expr } from "./expr.js";
import { getOp, registerKind, summarize } from "./registry.js";
import { checkSchema, opCost, runOp } from "./run.js";
import type { Op, RunContext, StoredOp } from "./types.js";

// A tool is a chain of calls to other operations.
//
// Every node names its `type`, and nesting is always an array of nodes, so new node types (if/else,
// parallel branches) can be added later without changing tools saved now. Scope inside a node is
// { input, steps: { <id>: { output, status, error } } }; a loop body also sees its loop variable
// ($<as>) and $index, and only the loop's own result is visible after it.
export type CallNode = { id: string; type: "call"; op: string; args?: Record<string, unknown>; disabled?: boolean };
export type ForEachNode = {
  id: string;
  type: "forEach";
  items: Expr;
  as: string;
  limit: number;
  onError?: "stop" | "skip";
  steps: ChainNode[];
  collect?: unknown;
  disabled?: boolean;
};
export type ChainNode = CallNode | ForEachNode;
export type ChainDef = StoredOp & { kind: "tool"; steps: ChainNode[]; output?: unknown };

export const MAX_LOOP = 25;
const MAX_TOOL_DEPTH = 3;
const ID = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED = new Set(["input", "steps", "index", "item"]);

// firstItem (loops only) is what the loop variable held on the first pass; the studio shows it.
type StepResult = { output?: unknown; status: "done" | "error" | "skipped"; error?: string; errors?: { index: number; error: string }[]; firstItem?: unknown };
type Scope = { input: unknown; steps: Record<string, StepResult> };

// ---------- validation ----------

function callableFromChains(op: Op | undefined): op is Op {
  return !!op && !(op.kind === "builtin" && op.hidden?.chains);
}

// Tools this definition calls, directly or through other tools, for cycle and depth checks.
function toolDepth(name: string, seen: string[], errors: string[]): number {
  const op = getOp(name);
  if (!op || op.kind !== "tool") return 0;
  if (seen.includes(name)) {
    errors.push(`calling "${name}" here creates a loop: ${[...seen, name].join(" -> ")}`);
    return 0;
  }
  const calls = callsIn((op as unknown as ChainDef).steps ?? []);
  return 1 + Math.max(0, ...calls.map((c) => toolDepth(c.op, [...seen, name], errors)));
}

const callsIn = (nodes: ChainNode[]): CallNode[] =>
  nodes.flatMap((n) => (n?.type === "call" ? [n] : n?.type === "forEach" && Array.isArray(n.steps) ? callsIn(n.steps) : []));

export function validateChain(def: ChainDef): string[] {
  const errors: string[] = [...checkSchema(def.inputSchema)];
  const ids = new Set<string>();
  const checkExprs = (where: string, value: unknown, visible: Set<string>) => {
    for (const src of exprsIn(value)) {
      const err = exprError(src);
      if (err) errors.push(`${where}: ${err}`);
      for (const ref of stepRefs(src)) if (!visible.has(ref)) errors.push(`${where}: "steps.${ref}" is not an earlier step here`);
    }
  };

  const walk = (nodes: unknown, visible: Set<string>, where: string) => {
    if (!Array.isArray(nodes)) return void errors.push(`${where}: steps must be a list`);
    for (const raw of nodes as ChainNode[]) {
      const at = `${where}${raw?.id ? ` > ${raw.id}` : ""}`;
      if (!raw || typeof raw !== "object") {
        errors.push(`${at}: each step must be an object`);
        continue;
      }
      if (typeof raw.id !== "string" || !ID.test(raw.id) || RESERVED.has(raw.id)) errors.push(`${at}: id must be lowercase letters, digits and underscores (and not ${[...RESERVED].join(", ")})`);
      else if (ids.has(raw.id)) errors.push(`${at}: id "${raw.id}" is used twice`);
      ids.add(raw.id);

      if (raw.type === "call") {
        const op = getOp(raw.op);
        if (raw.op === def.name) errors.push(`${at}: a tool cannot call itself`);
        else if (!callableFromChains(op)) errors.push(`${at}: there is no published operation "${raw.op}" that tools can call`);
        else {
          if (raw.args !== undefined && (typeof raw.args !== "object" || Array.isArray(raw.args) || raw.args === null)) errors.push(`${at}: args must be an object`);
          const args = raw.args ?? {};
          const props = (op.inputSchema.properties ?? {}) as Record<string, unknown>;
          for (const req of op.inputSchema.required ?? []) if (!(req in args)) errors.push(`${at}: "${raw.op}" needs "${req}"`);
          if (op.inputSchema.additionalProperties === false) for (const k of Object.keys(args)) if (!(k in props)) errors.push(`${at}: "${raw.op}" has no input "${k}"`);
          checkExprs(at, args, visible);
          if (op.kind === "tool") {
            const depth = 1 + toolDepth(raw.op, [def.name], errors);
            if (depth >= MAX_TOOL_DEPTH) errors.push(`${at}: tools may nest at most ${MAX_TOOL_DEPTH} deep`);
          }
        }
      } else if (raw.type === "forEach") {
        if (!isExpr(raw.items)) errors.push(`${at}: items must be an expression, e.g. { "$expr": "steps.found.output.sample" }`);
        else checkExprs(`${at} items`, raw.items, visible);
        if (typeof raw.as !== "string" || !/^[a-z][a-zA-Z0-9_]*$/.test(raw.as) || RESERVED.has(raw.as)) errors.push(`${at}: "as" names the loop variable, e.g. "person"`);
        if (!Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > MAX_LOOP) errors.push(`${at}: limit must be a whole number from 1 to ${MAX_LOOP}`);
        if (raw.onError !== undefined && raw.onError !== "stop" && raw.onError !== "skip") errors.push(`${at}: onError must be "stop" or "skip"`);
        if (!Array.isArray(raw.steps) || !raw.steps.length) errors.push(`${at}: a loop needs at least one step`);
        const inner = new Set(visible);
        walk(raw.steps, inner, at);
        checkExprs(`${at} collect`, raw.collect, inner);
      } else {
        errors.push(`${at}: unknown step type "${(raw as { type?: unknown }).type}" (supported: call, forEach)`);
      }
      if (typeof raw.id === "string") visible.add(raw.id);
    }
  };

  if (!Array.isArray(def.steps) || !def.steps.length) errors.push("a tool needs at least one step");
  const top = new Set<string>();
  walk(def.steps ?? [], top, def.name);
  checkExprs("output", def.output, top);
  return errors;
}

// ---------- cost ----------

const add = (a: Cost, b: Cost, times = 1): Cost => {
  const out: Cost = { ...a };
  for (const [k, n] of Object.entries(b) as [keyof Cost, number][]) out[k] = (out[k] ?? 0) + n * times;
  return out;
};

// Worst case for one run. Arguments known before the run (literals and expressions over `input`) are
// used; anything that depends on earlier steps falls back to the operation's defaults.
export async function estimateCost(def: ChainDef, input: unknown, loopCap = MAX_LOOP): Promise<Cost> {
  const scope = { input, steps: {} };
  const walk = async (nodes: ChainNode[]): Promise<Cost> => {
    let total: Cost = {};
    for (const n of nodes) {
      if (n.disabled) continue;
      if (n.type === "call") {
        const op = getOp(n.op);
        if (!op) continue;
        const args = (await evalValue(n.args ?? {}, scope).catch(() => ({}))) as Record<string, unknown>;
        const cost = op.kind === "tool" ? await estimateCost(op as unknown as ChainDef, args, loopCap) : await opCost(op, args);
        total = add(total, cost);
      } else total = add(total, await walk(n.steps), Math.min(n.limit, loopCap));
    }
    return total;
  };
  return walk(def.steps);
}

// ---------- running ----------

async function runNodes(nodes: ChainNode[], scope: Scope, bindings: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
  let last: unknown;
  for (const node of nodes) {
    if (node.disabled) {
      scope.steps[node.id] = { status: "skipped" };
      continue;
    }
    if (node.type === "call") {
      const args = await evalValue(node.args ?? {}, scope, bindings);
      try {
        last = await runOp(node.op, args, ctx.child(node.id));
        scope.steps[node.id] = { output: last, status: "done" };
      } catch (e) {
        scope.steps[node.id] = { status: "error", error: (e as Error).message };
        throw e;
      }
      continue;
    }
    // forEach
    const raw = await evalValue(node.items, scope, bindings);
    const items = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
    const cap = Math.min(node.limit, ctx.loopCap ?? MAX_LOOP);
    const results: unknown[] = [];
    const errors: { index: number; error: string }[] = [];
    for (const [index, item] of items.slice(0, cap).entries()) {
      // Each iteration sees the outer steps plus its own; nothing leaks between iterations.
      const iter: Scope = { input: scope.input, steps: { ...scope.steps } };
      const b = { ...bindings, [node.as]: item, index };
      try {
        const lastInner = await runNodes(node.steps, iter, b, ctx.child(`${node.id}[${index}]`));
        results.push(node.collect === undefined ? lastInner : await evalValue(node.collect, iter, b));
      } catch (e) {
        if (node.onError !== "skip") {
          scope.steps[node.id] = { status: "error", error: (e as Error).message, output: results, firstItem: items[0] };
          throw e;
        }
        errors.push({ index, error: (e as Error).message });
      }
    }
    last = results;
    scope.steps[node.id] = { output: results, status: "done", ...(errors.length ? { errors } : {}), ...(items.length ? { firstItem: items[0] } : {}) };
  }
  return last;
}

export async function runChain(def: ChainDef, input: unknown, ctx: RunContext): Promise<unknown> {
  const scope: Scope = { input, steps: {} };
  const last = await runNodes(def.steps, scope, {}, ctx);
  return def.output === undefined ? last : evalValue(def.output, scope);
}

// For previews: every step's result, including the ones that ran before a failure.
export async function runChainDetailed(def: ChainDef, input: unknown, ctx: RunContext): Promise<{ output?: unknown; error?: string; steps: Record<string, StepResult> }> {
  const scope: Scope = { input, steps: {} };
  try {
    const last = await runNodes(def.steps, scope, {}, ctx);
    return { output: def.output === undefined ? last : await evalValue(def.output, scope), steps: scope.steps };
  } catch (e) {
    return { error: (e as Error).message, steps: scope.steps };
  }
}

registerKind("tool", {
  validate: (def) => validateChain(def as ChainDef),
  cost: (def, input) => estimateCost(def as ChainDef, input),
  run: (def, input, ctx) => runChain(def as ChainDef, input, ctx),
  usesLinkedIn: (def) => callsIn((def as ChainDef).steps ?? []).some((c) => {
    const op = getOp(c.op);
    return !op || summarize(op).usesLinkedIn;
  }),
});
