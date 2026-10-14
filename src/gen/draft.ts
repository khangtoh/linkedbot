import { getOp, saveDraft } from "../ops/registry.js";
import { GenerationSession, type GenEvent, type GenRequest } from "./generator.js";

const TOOL_WORDS: Record<string, string> = {
  open_page: "Opening a LinkedIn page",
  outline: "Studying the page",
  selectors_for: "Finding the right elements",
  probe: "Checking what it found",
  scroll: "Scrolling to load more",
  expand: "Expanding a section",
  test_recipe: "Testing the API on the page",
  finish: "Running the finished API once more",
};

// Runs one generation and saves its recipe as a draft. The event log is returned so the owner can
// see what the generator did; nothing is published without the owner.
export async function generateDraft(req: GenRequest, report: (message: string) => void = () => {}) {
  const events: string[] = [];
  const log = (e: GenEvent) => {
    const line =
      e.type === "tool" ? `${e.isError ? "x" : "-"} ${e.name}: ${e.summary.split("\n")[0]}` :
      e.type === "note" ? `  ${e.text.slice(0, 300)}` :
      e.type === "status" ? `* ${e.text}` :
      e.type === "failed" ? `! ${e.reason}` :
      e.type === "done" ? "* finished" : null;
    if (e.type === "status") report(e.text);
    else if (e.type === "tool") report(TOOL_WORDS[e.name] ?? "Working");
    if (line) {
      events.push(line);
      console.log(`[generate] ${line}`);
    }
  };
  const session = new GenerationSession(req, { onEvent: log });
  const result = await session.run();
  if ("failed" in result) return { ok: false, reason: result.failed, pageLoads: session.pageLoadsUsed, events };

  // Keep the generator's name unless it is taken by something that is not a draft API.
  let name = String(result.recipe.name);
  for (let n = 2; getOp(name, { draft: true }) && getOp(name, { draft: true })!.kind !== "api"; n++) name = `${result.recipe.name}_${n}`;
  const { schemaVersion: _s, version: _v, updatedAt: _u, ...recipe } = result.recipe;
  const saved = saveDraft({ ...recipe, name, kind: "api" });
  return { ok: true, draft: name, problems: saved.errors, output: result.output, pageLoads: session.pageLoadsUsed, events };
}
