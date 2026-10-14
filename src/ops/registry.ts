import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { DATA_DIR } from "../vault.js";
import { readJson, writeJsonAtomic } from "../store.js";
import type { Cost } from "../limits.js";
import { BUILTINS } from "./builtins.js";
import type { Op, OpSummary, RunContext, StoredOp } from "./types.js";

// Generated APIs and tools: /data/ops/<name>.json is the published version, <name>.draft.json the one
// being edited. A published operation keeps working while its draft changes.
const OPS_DIR = `${DATA_DIR}/ops`;
export const NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
export const registryEvents = new EventEmitter();

// What each stored kind contributes. Registered by the chain and recipe modules.
export type KindHandler = {
  validate(def: StoredOp): string[];
  cost(def: StoredOp, input: unknown): Cost | Promise<Cost>;
  run(def: StoredOp, input: unknown, ctx: RunContext): Promise<unknown>;
  usesLinkedIn(def: StoredOp): boolean;
};
const kinds = new Map<StoredOp["kind"], KindHandler>();
export const registerKind = (kind: StoredOp["kind"], handler: KindHandler) => void kinds.set(kind, handler);
export const kindHandler = (kind: StoredOp["kind"]) => kinds.get(kind);

const pathOf = (name: string, draft: boolean) => `${OPS_DIR}/${name}${draft ? ".draft" : ""}.json`;

function load(name: string, draft: boolean): Op | undefined {
  const def = readJson<StoredOp | null>(pathOf(name, draft), null);
  return def ? { ...def, status: draft ? "draft" : "published" } : undefined;
}

// Published by default; with `draft`, the draft if there is one, else the published version.
export function getOp(name: string, opts: { draft?: boolean } = {}): Op | undefined {
  const builtin = BUILTINS.find((b) => b.name === name);
  if (builtin) return builtin;
  if (!NAME_PATTERN.test(name)) return undefined;
  return (opts.draft ? load(name, true) : undefined) ?? load(name, false);
}

export function listOps(opts: { drafts?: boolean } = {}): Op[] {
  const stored = existsSync(OPS_DIR) ? readdirSync(OPS_DIR).filter((f) => f.endsWith(".json")) : [];
  const names = [...new Set(stored.map((f) => f.replace(/(\.draft)?\.json$/, "")))].sort();
  const ops: Op[] = [...BUILTINS];
  for (const name of names) {
    const published = load(name, false);
    if (published) ops.push(published);
    if (opts.drafts) {
      const draft = load(name, true);
      if (draft) ops.push(draft);
    }
  }
  return ops;
}

export function summarize(op: Op): OpSummary {
  const usesLinkedIn = op.kind === "builtin" ? op.usesLinkedIn : (kinds.get(op.kind)?.usesLinkedIn(op) ?? true);
  return { name: op.name, kind: op.kind, description: op.description, inputSchema: op.inputSchema, status: op.status, version: op.version, usesLinkedIn };
}

export function validateDefinition(def: StoredOp): string[] {
  const errors: string[] = [];
  if (def.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (def.kind !== "api" && def.kind !== "tool") errors.push('kind must be "api" or "tool"');
  if (typeof def.name !== "string" || !NAME_PATTERN.test(def.name)) errors.push("name must be 2-64 characters: lowercase letters, digits and underscores, starting with a letter");
  else if (BUILTINS.some((b) => b.name === def.name)) errors.push(`"${def.name}" is a built-in operation`);
  if (typeof def.description !== "string" || !def.description.trim()) errors.push("description is required: it is what assistants read to decide when to use this");
  else if (def.description.length > 1024) errors.push("description must be 1024 characters or fewer");
  if (!def.inputSchema || def.inputSchema.type !== "object") errors.push('inputSchema must be a JSON Schema with type "object"');
  if (errors.length) return errors;
  const handler = kinds.get(def.kind);
  return handler ? handler.validate(def) : [`${def.kind} operations are not supported yet`];
}

// Saves a draft (never touches the published version). Returns the problems that block publishing;
// a draft is saved even when it has some, so work in progress is never lost.
export type DraftInput = Pick<StoredOp, "kind" | "name" | "description" | "inputSchema"> & Record<string, unknown>;

export function saveDraft(input: DraftInput): { def: StoredOp; errors: string[] } {
  const current = getOp(input.name, { draft: true });
  if (current?.kind === "builtin") return { def: input as StoredOp, errors: [`"${input.name}" is a built-in operation`] };
  const def: StoredOp = { ...input, schemaVersion: 1, version: current?.status === "draft" ? current.version : (current?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
  delete (def as Partial<Op>).status;
  const errors = validateDefinition(def);
  if (NAME_PATTERN.test(def.name) && !BUILTINS.some((b) => b.name === def.name)) {
    mkdirSync(OPS_DIR, { recursive: true });
    writeJsonAtomic(pathOf(def.name, true), def);
    registryEvents.emit("change", def.name);
  }
  return { def, errors };
}

export function publish(name: string): { ok: true; op: Op } | { ok: false; errors: string[] } {
  const draft = load(name, true);
  if (!draft) return { ok: false, errors: [`"${name}" has no draft to publish`] };
  const { status: _status, ...def } = draft as StoredOp & { status: string };
  const errors = validateDefinition(def as StoredOp);
  if (errors.length) return { ok: false, errors };
  writeJsonAtomic(pathOf(name, false), { ...def, updatedAt: new Date().toISOString() });
  rmSync(pathOf(name, true), { force: true });
  registryEvents.emit("change", name);
  return { ok: true, op: getOp(name)! };
}

export function removeOp(name: string, opts: { draftOnly?: boolean } = {}): boolean {
  if (BUILTINS.some((b) => b.name === name) || !NAME_PATTERN.test(name)) return false;
  const paths = opts.draftOnly ? [pathOf(name, true)] : [pathOf(name, true), pathOf(name, false)];
  const existed = paths.some(existsSync);
  for (const p of paths) rmSync(p, { force: true });
  if (existed) registryEvents.emit("change", name);
  return existed;
}
