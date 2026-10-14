import type { Page } from "playwright";
import type { Cost } from "../limits.js";

// An operation is anything that can be run: a hand-written built-in, a generated API (a recipe)
// or a tool (a chain of other operations). MCP, the HTTP API, the built-in agent and the studio
// all work from the same registry of operations.
export type OpKind = "builtin" | "api" | "tool";
export type JsonSchema = { type: "object"; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };

export type OpSummary = {
  name: string;
  kind: OpKind;
  description: string;
  inputSchema: JsonSchema;
  status: "published" | "draft";
  version: number;
  usesLinkedIn: boolean;
};

export interface BuiltinOp extends OpSummary {
  kind: "builtin";
  // Worst-case daily-cap spend for this input, checked before the run starts.
  cost(input: any): Cost;
  run(input: any, ctx: RunContext): Promise<unknown>;
  hidden?: { mcp?: boolean; agent?: boolean; chains?: boolean }; // surfaces that must not offer it
}

// Generated APIs and tools live on the volume as one JSON file each.
export interface StoredOp {
  schemaVersion: 1;
  kind: "api" | "tool";
  name: string;
  description: string;
  inputSchema: JsonSchema;
  version: number;
  updatedAt: string;
  [k: string]: unknown; // kind-specific body (steps, output, ...)
}

export type Op = BuiltinOp | (StoredOp & { status: "published" | "draft" });

export type TraceEvent = {
  op: string;
  path: string; // where in a nested run this happened, e.g. "find_and_read/profiles[2]/p"
  input: unknown;
  output?: unknown;
  error?: string;
  ms: number;
};

export interface RunContext {
  // One browser page per run, opened the first time a step needs LinkedIn and shared by every step.
  page(): Promise<Page>;
  readonly trace: TraceEvent[];
  onTrace?: (e: TraceEvent) => void;
  readonly depth: number;
  readonly path: string;
  readonly allowDrafts: boolean;
  readonly loopCap?: number; // previews run only the first few items of each loop
  progress(message: string): void; // what the run is doing now, shown to the owner
  child(segment: string): RunContext;
}
