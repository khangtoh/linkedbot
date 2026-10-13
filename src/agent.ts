import Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "node:readline/promises";
import { openSession } from "./browser.js";
import { viewProfile, whoami } from "./actions/profile.js";
import { searchPeople } from "./actions/search.js";
import { loadLeads } from "./leads.js";

const MODEL = process.env.LINKEDBOT_MODEL ?? "claude-sonnet-5-5";

const tools: Anthropic.Tool[] = [
  { name: "whoami", description: "Get the logged-in user's own name and headline.", input_schema: { type: "object", properties: {} } },
  {
    name: "view_profile",
    description: "Read a LinkedIn profile (name, headline, about) by URL.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "search_people",
    description: "Search LinkedIn People by keywords (e.g. 'head of data fintech London'). Saves results as leads. Each page (~10 results) counts toward the daily search cap.",
    input_schema: {
      type: "object",
      properties: { keywords: { type: "string" }, pages: { type: "number", description: "1-5, default 1" } },
      required: ["keywords"],
    },
  },
  {
    name: "list_leads",
    description: "List stored leads (no LinkedIn call). Optional case-insensitive filter over name/headline/location.",
    input_schema: { type: "object", properties: { filter: { type: "string" }, limit: { type: "number" } } },
  },
];

// Actions with side effects must be listed here and are confirmed by the human.
const NEEDS_APPROVAL = new Set<string>([]);

async function approve(msg: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${msg} [y/N] `);
  rl.close();
  return a.trim().toLowerCase() === "y";
}

export async function runAgent(task: string): Promise<void> {
  const client = new Anthropic();
  const s = await openSession();
  try {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
    for (let turn = 0; turn < 15; turn++) {
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
        console.log(res.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n"));
        return;
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const c of calls) {
        let out: unknown;
        try {
          if (NEEDS_APPROVAL.has(c.name) && !(await approve(`Run ${c.name} ${JSON.stringify(c.input)}?`))) {
            out = "Denied by user.";
          } else if (c.name === "whoami") out = await whoami(s.page);
          else if (c.name === "view_profile") out = await viewProfile(s.page, (c.input as any).url);
          else if (c.name === "search_people") out = await searchPeople(s.page, c.input as any);
          else if (c.name === "list_leads") {
            const { filter, limit } = c.input as { filter?: string; limit?: number };
            const f = filter?.toLowerCase();
            out = loadLeads()
              .filter((l) => !f || `${l.name} ${l.headline} ${l.location}`.toLowerCase().includes(f))
              .slice(0, limit ?? 25);
          } else out = `Unknown tool ${c.name}`;
        } catch (e) {
          out = `Error: ${(e as Error).message}`;
        }
        results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out) });
      }
      messages.push({ role: "user", content: results });
    }
  } finally {
    await s.close();
  }
}
