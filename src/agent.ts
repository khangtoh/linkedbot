import Anthropic from "@anthropic-ai/sdk";
import type { RunContext } from "./ops/types.js";

const MODEL = process.env.LINKEDBOT_MODEL ?? "claude-sonnet-5-5";

// Claude tool loop over the published operations (built-ins, generated APIs and tools alike).
// Everything it can call is read-only, so there is no per-call approval step.
export async function runAgent(task: string, ctx: RunContext): Promise<string> {
  // Imported here: the registry lists the agent itself as a built-in.
  const { listOps } = await import("./ops/index.js");
  const { runOp } = await import("./ops/index.js");
  const tools: Anthropic.Tool[] = listOps()
    .filter((op) => !(op.kind === "builtin" && op.hidden?.agent))
    .map((op) => ({ name: op.name, description: op.description, input_schema: op.inputSchema as Anthropic.Tool.InputSchema }));
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  for (let turn = 0; turn < 15; turn++) {
    ctx.progress(turn === 0 ? "Thinking about the task" : "Thinking about the next step");
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: "You operate the user's own LinkedIn account via tools. Be sparing: every call counts against daily limits.",
      tools,
      messages,
    });
    messages.push({ role: "assistant", content: res.content });
    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!calls.length) {
      return res.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const c of calls) {
      let out: unknown;
      try {
        out = tools.some((t) => t.name === c.name) ? await runOp(c.name, c.input, ctx.child(c.name)) : `Unknown tool ${c.name}`;
      } catch (e) {
        out = `Error: ${(e as Error).message}`;
      }
      results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
  return "Stopped: turn limit reached before the task finished.";
}
