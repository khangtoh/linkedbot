import { assertBudget, type Cost } from "../limits.js";
import { estimateCost, runChainDetailed, validateChain, type ChainDef } from "./chain.js";
import { createRunContext, validateAgainst } from "./run.js";
import type { TraceEvent } from "./types.js";

// Runs a tool that is still being built (unsaved, possibly cut off at "Run to here") so the studio can
// show what each step really returns. Loops run only their first few items unless asked otherwise.
export type PreviewRequest = { def: Omit<ChainDef, "schemaVersion" | "version" | "updatedAt" | "kind">; input?: unknown; loopCap?: number };
export type PreviewResult = {
  ok: boolean;
  problems?: string[];
  cost?: Cost;
  output?: unknown;
  error?: string;
  steps?: Record<string, unknown>;
  trace?: Pick<TraceEvent, "op" | "path" | "output" | "error" | "ms">[];
};

export async function previewTool({ def, input = {}, loopCap = 2 }: PreviewRequest, report?: (message: string, stage?: "waiting" | "working") => void): Promise<PreviewResult> {
  const full: ChainDef = { schemaVersion: 1, version: 0, updatedAt: "", kind: "tool", ...def, name: def.name || "preview_tool", description: def.description || "Preview", inputSchema: def.inputSchema ?? { type: "object" } } as ChainDef;
  const problems = validateChain(full);
  if (problems.length) return { ok: false, problems };
  const checked = validateAgainst(full.inputSchema, input);
  if (!checked.ok) return { ok: false, problems: checked.errors.map((e) => `test input: ${e}`) };
  const cost = await estimateCost(full, checked.value, loopCap);
  try {
    assertBudget(cost);
  } catch (e) {
    return { ok: false, problems: [(e as Error).message], cost };
  }
  const trace: PreviewResult["trace"] = [];
  const ctx = createRunContext({ label: "studio preview", allowDrafts: true, loopCap, onProgress: report, onTrace: ({ op, path, output, error, ms }) => trace.push({ op, path, output, error, ms }) });
  try {
    const run = await runChainDetailed(full, checked.value, ctx);
    return { ok: !run.error, cost, ...run, trace };
  } finally {
    await ctx.close();
  }
}
