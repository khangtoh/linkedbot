// The tool being built, in the same shape the server stores (src/ops/chain.ts), plus helpers for
// editing it and for turning tapped data into expressions.

export type Expr = { $expr: string };
export type Value = string | number | boolean | null | Expr | undefined;
export type CallNode = { id: string; type: "call"; op: string; args: Record<string, Value>; disabled?: boolean };
export type LoopNode = { id: string; type: "forEach"; items: Expr; as: string; limit: number; onError: "stop" | "skip"; steps: Node[]; collect?: Value; disabled?: boolean };
export type Node = CallNode | LoopNode;
export type InputDef = { key: string; type: "string" | "integer" | "boolean"; required: boolean; description: string; test: string | boolean };
export type OutputField = { key: string; value: Value };
export type ToolDraft = { name: string; description: string; inputs: InputDef[]; steps: Node[]; outputFields: OutputField[]; rawOutput?: Value };

export const isExpr = (v: unknown): v is Expr => !!v && typeof v === "object" && typeof (v as Expr).$expr === "string";

export const emptyTool = (): ToolDraft => ({ name: "", description: "", inputs: [], steps: [], outputFields: [] });

// ---------- tree editing (by id) ----------

export function findNode(nodes: Node[], id: string): { node: Node; parent: Node[]; index: number; loop?: LoopNode } | undefined {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { node: n, parent: nodes, index: i };
    if (n.type === "forEach") {
      const inner = findNode(n.steps, id);
      if (inner) return { ...inner, loop: inner.loop ?? n };
    }
  }
}

const mapNodes = (nodes: Node[], fn: (n: Node) => Node | null): Node[] =>
  nodes.flatMap((n) => {
    const m = fn(n);
    if (!m) return [];
    return [m.type === "forEach" ? { ...m, steps: mapNodes(m.steps, fn) } : m];
  });

export const updateNode = (nodes: Node[], id: string, fn: (n: Node) => Node) => mapNodes(nodes, (n) => (n.id === id ? fn(n) : n));
export const removeNode = (nodes: Node[], id: string) => mapNodes(nodes, (n) => (n.id === id ? null : n));

export function moveNode(nodes: Node[], id: string, dir: -1 | 1): Node[] {
  const swap = (list: Node[]): Node[] => {
    const i = list.findIndex((n) => n.id === id);
    if (i >= 0) {
      const j = i + dir;
      if (j < 0 || j >= list.length) return list;
      const copy = [...list];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    }
    return list.map((n) => (n.type === "forEach" ? { ...n, steps: swap(n.steps) } : n));
  };
  return swap(nodes);
}

// Inserts after `afterId` (or at the start of `loopId`'s body / the top when afterId is null).
export function insertNode(nodes: Node[], node: Node, at: { afterId: string | null; loopId: string | null }): Node[] {
  if (at.loopId) return mapNodes(nodes, (n) => (n.id === at.loopId && n.type === "forEach" ? { ...n, steps: insertInto(n.steps, node, at.afterId) } : n));
  return insertInto(nodes, node, at.afterId);
}
const insertInto = (list: Node[], node: Node, afterId: string | null) => {
  if (afterId === null) return [node, ...list];
  const i = list.findIndex((n) => n.id === afterId);
  return i < 0 ? [...list, node] : [...list.slice(0, i + 1), node, ...list.slice(i + 1)];
};

export const allIds = (nodes: Node[]): string[] => nodes.flatMap((n) => [n.id, ...(n.type === "forEach" ? allIds(n.steps) : [])]);

export function uniqueId(nodes: Node[], base: string): string {
  const ids = new Set(allIds(nodes));
  const clean = base.replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "") || "step";
  if (!ids.has(clean)) return clean;
  for (let i = 2; ; i++) if (!ids.has(`${clean}_${i}`)) return `${clean}_${i}`;
}

// Steps whose output a node may use: earlier steps at its level and in enclosing loops, and loops
// (by their collected result) once they are finished.
export function visibleBefore(nodes: Node[], id: string): Node[] {
  const out: Node[] = [];
  const walk = (list: Node[]): boolean => {
    for (const n of list) {
      if (n.id === id) return true;
      if (n.type === "forEach" && allIds(n.steps).includes(id)) {
        return walk(n.steps);
      }
      out.push(n);
    }
    return false;
  };
  walk(nodes);
  return out;
}

// Loops enclosing a node, innermost last.
export function loopsAround(nodes: Node[], id: string): LoopNode[] {
  for (const n of nodes) {
    if (n.type === "forEach" && allIds(n.steps).includes(id)) return [n, ...loopsAround(n.steps, id)];
  }
  return [];
}

// ---------- expressions ----------

const seg = (k: string | number) => (typeof k === "number" ? `[${k}]` : /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? `.${k}` : `.\`${k}\``);
// A path into data, as JSONata. Index 0 inside a list of records means "each item": JSONata maps a
// path over a list, so `sample.url` is the list of urls.
export function pathExpr(root: string, path: (string | number)[], eachList = true): string {
  return root + path.map((p, i) => (eachList && p === 0 && typeof path[i + 1] === "string" ? "" : seg(p))).join("");
}

export type Source = { kind: "input" | "step" | "item"; id: string };

export function exprFor(source: Source, path: (string | number)[], loopVar?: string): string {
  if (source.kind === "input") return pathExpr("input", path);
  if (source.kind === "item") return pathExpr(`$${loopVar ?? source.id}`, path);
  return pathExpr(`steps.${source.id}.output`, path);
}

// A readable name for a chip: "found › sample › url", "person › url", "Input › keywords".
export function chipLabel(v: Expr): { text: string; simple: boolean } {
  const src = v.$expr.trim();
  let m = /^input((?:\.[A-Za-z_][A-Za-z0-9_]*)+)$/.exec(src);
  if (m) return { text: `Input › ${m[1].slice(1).split(".").join(" › ")}`, simple: true };
  m = /^steps\.([a-z][a-z0-9_]*)\.output((?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/.exec(src);
  if (m) return { text: [m[1], ...m[2].split(".").filter(Boolean)].join(" › "), simple: true };
  m = /^\$([a-zA-Z][a-zA-Z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/.exec(src);
  if (m) return { text: [m[1], ...m[2].split(".").filter(Boolean)].join(" › "), simple: true };
  return { text: src, simple: false };
}

// ---------- to and from the stored definition ----------

const literal = (v: Value) => (v === undefined ? "null" : JSON.stringify(v));
const exprOf = (v: Value) => (isExpr(v) ? v.$expr : literal(v));

export function toDefinition(t: ToolDraft) {
  const properties: Record<string, unknown> = {};
  for (const i of t.inputs) properties[i.key] = { type: i.type, ...(i.description ? { description: i.description } : {}) };
  const output = t.rawOutput !== undefined ? t.rawOutput : t.outputFields.length ? { $expr: `{ ${t.outputFields.map((f) => `${JSON.stringify(f.key)}: ${exprOf(f.value)}`).join(", ")} }` } : undefined;
  return {
    kind: "tool" as const,
    name: t.name,
    description: t.description,
    inputSchema: { type: "object", properties, required: t.inputs.filter((i) => i.required).map((i) => i.key) },
    steps: t.steps,
    ...(output !== undefined ? { output } : {}),
    ui: { testInput: testInput(t), outputFields: t.outputFields },
  };
}

export function testInput(t: ToolDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const i of t.inputs) {
    if (i.test === "" || i.test === undefined) continue;
    out[i.key] = i.type === "integer" ? Number(i.test) : i.type === "boolean" ? !!i.test : i.test;
  }
  return out;
}

export function fromDefinition(def: any): ToolDraft {
  const props = (def.inputSchema?.properties ?? {}) as Record<string, { type?: string; description?: string }>;
  const required = new Set<string>(def.inputSchema?.required ?? []);
  const test = (def.ui?.testInput ?? {}) as Record<string, string | boolean>;
  const fields: OutputField[] | undefined = def.ui?.outputFields;
  return {
    name: def.name,
    description: def.description ?? "",
    inputs: Object.entries(props).map(([key, p]) => ({ key, type: p.type === "integer" || p.type === "number" ? "integer" : p.type === "boolean" ? "boolean" : "string", required: required.has(key), description: p.description ?? "", test: test[key] === undefined ? "" : (test[key] as string | boolean) })),
    steps: def.steps ?? [],
    outputFields: fields ?? [],
    rawOutput: fields?.length || def.output === undefined ? undefined : def.output,
  };
}

// The tool cut off after a step, for "Run to here". A step inside a loop runs its whole loop.
export function truncatedAt(t: ToolDraft, id: string) {
  const top = t.steps.findIndex((n) => n.id === id || (n.type === "forEach" && allIds(n.steps).includes(id)));
  const def = toDefinition({ ...t, steps: t.steps.slice(0, top + 1), outputFields: [], rawOutput: undefined });
  return def;
}
