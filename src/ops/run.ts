import { Ajv, type ValidateFunction } from "ajv";
import type { Page } from "playwright";
import { acquire, lock, type Holder, type Lease } from "../browser.js";
import { assertBudget, type Cost } from "../limits.js";
import { getOp, kindHandler } from "./registry.js";
import type { Op, RunContext, TraceEvent } from "./types.js";

const MAX_DEPTH = 5; // a tool calling a tool calling ... ; chains are validated to depth 3

const ajv = new Ajv({ useDefaults: true, allErrors: true, strict: false });
const compiled = new Map<string, ValidateFunction>();

function validatorFor(op: Op): ValidateFunction {
  const key = `${op.name}@${op.version}/${op.status}`;
  let v = compiled.get(key);
  if (!v) compiled.set(key, (v = ajv.compile(op.inputSchema)));
  return v;
}

export function checkSchema(schema: unknown): string[] {
  try {
    ajv.compile(schema as object);
    return [];
  } catch (e) {
    return [`inputSchema is not a valid JSON Schema: ${(e as Error).message}`];
  }
}

// Validates and fills in defaults. Returns a copy; the caller's object is not changed.
export function validateInput(op: Op, input: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] } {
  const value = structuredClone(input ?? {}) as Record<string, unknown>;
  const v = validatorFor(op);
  if (v(value)) return { ok: true, value };
  return { ok: false, errors: (v.errors ?? []).map((e) => `${e.instancePath || "input"} ${e.message}${e.params && "additionalProperty" in e.params ? ` (${e.params.additionalProperty})` : ""}`) };
}

// For schemas that change between calls (previews of unsaved tools): compiled each time, not cached.
export function validateAgainst(schema: unknown, input: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] } {
  const value = structuredClone(input ?? {}) as Record<string, unknown>;
  let v: ValidateFunction;
  try {
    v = ajv.compile(schema as object);
  } catch (e) {
    return { ok: false, errors: [`inputSchema is not valid: ${(e as Error).message}`] };
  }
  return v(value) ? { ok: true, value } : { ok: false, errors: (v.errors ?? []).map((e) => `${e.instancePath || "input"} ${e.message}`) };
}

export async function opCost(op: Op, input: unknown): Promise<Cost> {
  return op.kind === "builtin" ? op.cost(input) : ((await kindHandler(op.kind)?.cost(op, input)) ?? {});
}

// "profiles[2]/p" running view_profile -> "View profile (item 3 of the loop)"
function stepLabel(name: string, path: string): string {
  const op = name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const item = /\[(\d+)\][^\[]*$/.exec(path);
  return item ? `${op} (item ${Number(item[1]) + 1})` : op;
}

export class InputError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join("; "));
  }
}

export async function runOp(name: string, input: unknown, ctx: RunContext): Promise<unknown> {
  const op = getOp(name, { draft: ctx.allowDrafts });
  if (!op) throw new Error(`Unknown operation "${name}".`);
  if (ctx.depth > MAX_DEPTH) throw new Error(`Operations are nested too deeply (more than ${MAX_DEPTH}).`);
  const checked = validateInput(op, input);
  if (!checked.ok) throw new InputError(checked.errors.map((e) => `${name}: ${e}`));
  const started = Date.now();
  const event: TraceEvent = { op: name, path: ctx.path, input: checked.value, ms: 0 };
  if (ctx.depth > 0) ctx.progress(stepLabel(name, ctx.path));
  try {
    const output = op.kind === "builtin" ? await op.run(checked.value, ctx) : await kindHandler(op.kind)!.run(op, checked.value, ctx);
    event.output = output;
    return output;
  } catch (e) {
    event.error = (e as Error).message;
    throw e;
  } finally {
    event.ms = Date.now() - started;
    ctx.trace.push(event);
    ctx.onTrace?.(event);
  }
}

// A run owns at most one browser page, taken from the shared lease the first time a step needs it.
export type RunOptions = { label?: string; holder?: Holder; allowDrafts?: boolean; loopCap?: number; onTrace?: (e: TraceEvent) => void; onProgress?: (message: string, stage?: "waiting" | "working") => void };

// Why the browser is not free yet, in the owner's words.
function busyReason(): string | undefined {
  const h = lock.state().holder;
  if (!h) return undefined;
  if (h.holder === "login") return "Waiting for the browser: a LinkedIn login window is open";
  if (h.holder === "interactive") return `Waiting for the browser: ${h.label} is using it`;
  return `Waiting for the browser: "${h.label}" is using it`;
}

export function createRunContext(opts: RunOptions & { label: string }): RunContext & { close(): Promise<void> } {
  let lease: Lease | undefined;
  let page: Promise<Page> | undefined;
  const trace: TraceEvent[] = [];
  const make = (depth: number, path: string): RunContext => ({
    page: () =>
      (page ??= (async () => {
        const busy = busyReason();
        if (busy) opts.onProgress?.(busy, "waiting");
        lease = await acquire(opts.holder ?? "job", opts.label);
        opts.onProgress?.("Opening the browser");
        return lease.newPage();
      })()),
    progress: (message: string) => opts.onProgress?.(message),
    trace,
    onTrace: opts.onTrace,
    depth,
    path,
    allowDrafts: !!opts.allowDrafts,
    loopCap: opts.loopCap,
    child: (segment) => make(depth + 1, path ? `${path}/${segment}` : segment),
  });
  return {
    ...make(0, ""),
    async close() {
      if (page) await page.catch(() => {});
      await lease?.release({ persist: true });
    },
  };
}

// Entry point for jobs, MCP and the CLI: validates, checks the worst-case spend against what is left
// of today's caps, runs, and always gives the browser back.
export async function runTopLevel(name: string, input: unknown, opts: RunOptions = {}): Promise<unknown> {
  const op = getOp(name, { draft: opts.allowDrafts });
  if (!op) throw new Error(`Unknown operation "${name}".`);
  const checked = validateInput(op, input);
  if (!checked.ok) throw new InputError(checked.errors);
  assertBudget(await opCost(op, checked.value));
  const ctx = createRunContext({ ...opts, label: opts.label ?? name });
  try {
    return await runOp(name, checked.value, ctx);
  } finally {
    await ctx.close();
  }
}
