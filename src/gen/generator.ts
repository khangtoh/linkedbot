import Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";
import { acquire, assertHealthy, type Lease } from "../browser.js";
import { claudeClient, modelFor, supportsFallbacks } from "../claude.js";
import { consume, humanDelay, remaining } from "../limits.js";
import { checkNavigation, LINKEDIN_POLICY, type Policy } from "../policy.js";
import { runRecipeOnPage, validateRecipe, type RecipeDef } from "../ops/recipe.js";
import { describeAt, outline, selectorsFor } from "./outline.js";

// Generates a read-only API (a recipe, see ops/recipe.ts) from a description. Claude explores the
// page through the shared browser lease, picks elements by handle, and lets code write and verify
// the selectors. Candidate recipes are checked against the page that is already loaded; only
// opening a page counts against the page-load budget and the daily caps.

export type GenRequest = {
  description: string; // what the owner wants
  exampleUrl: string; // a page it should work on
  budget?: number; // page loads for this generation, default 6
};

export type GenEvent =
  | { type: "status"; text: string }
  | { type: "note"; text: string } // what the model says between tool calls
  | { type: "tool"; name: string; input: unknown; summary: string; isError?: boolean }
  | { type: "draft"; recipe: unknown; output?: unknown; missing?: string[] }
  | { type: "done"; recipe: RecipeDef; output: unknown }
  | { type: "failed"; reason: string };

export type GenOptions = {
  onEvent?: (e: GenEvent) => void;
  policy?: Policy;
  delay?: [number, number];
  client?: Anthropic;
  model?: string;
  maxTurns?: number;
  hints?: () => string[]; // owner corrections queued since the last turn ("correct by pointing")
};

const SYSTEM = `You build read-only "APIs" for LinkedIn: small declarative recipes that open a LinkedIn page and extract data from it. The owner of the account is watching the browser while you work.

How to work:
1. open_page the example URL, then outline it. Elements carry handles like [n12].
2. For each field you need, find the element in the outline (outline a section by its handle to see more), then call selectors_for with its handle. Use the selectors it returns: they are verified against the live page. Use mode "list" for repeating items.
3. Use probe to check a selector, and scroll or expand when content is lazy or collapsed.
4. Call test_recipe with a full recipe. It runs on the page that is already open and costs no page load. Fix missing fields and test again.
5. When the output is right, call finish with the recipe. finish runs it once more from scratch.

Recipe format:
{ "name": "company_overview", "description": "What it returns and when to use it",
  "inputSchema": { "type": "object", "properties": { "company": { "type": "string", "description": "...", "pattern": "^[A-Za-z0-9_-]+$" } }, "required": ["company"] },
  "cost": "view_profile" (or "search" for search result pages),
  "steps": [
    { "type": "goto", "url": { "$expr": "'https://www.linkedin.com/company/' & input.company & '/about/'" } },
    { "type": "waitFor", "selector": "main h1" },
    { "type": "scroll", "until": { "selector": "<item selector>", "count": 10 }, "maxScrolls": 3 },
    { "type": "expand", "selector": "<a 'see more' button>" },
    { "type": "extract", "as": "company", "fields": { "name": { "selector": "h1", "required": true }, "website": { "selector": "...", "attr": "href" } } },
    { "type": "extractList", "as": "people", "item": "<item selector>", "limit": 25, "dedupeBy": "url", "fields": { "url": { "selector": "a[href*='/in/']", "attr": "href" }, "title": { "selector": ":scope", "attr": "lines", "line": 1 } } }
  ],
  "output": optional { "$expr": "<JSONata over { input, vars }>" } }
Field options: selector (or a list of fallbacks), attr ("text" default, "lines" with "line", "href", or any attribute), pattern (regex, first group kept), required.

Rules:
- Inputs must identify the page the way a person would (a slug, a URL, keywords). The goto URL is built from them; it must stay on https://www.linkedin.com under /in/, /company/, /search/results/, /jobs/, /posts/ or /feed/update/.
- Never use generated class names (like .x7Fa9Q2); LinkedIn changes them every release. Prefer the selectors selectors_for gives you.
- Read-only: there is no way to type, submit or follow links, and you must not try.
- Page loads are limited and count against the owner's daily LinkedIn caps; re-test on the open page instead of reopening it.
- If the data is not on the page or cannot be read reliably, say so plainly instead of guessing.`;

type ToolInput = Record<string, any>;

const TOOLS: Anthropic.Beta.BetaTool[] = [
  { name: "open_page", description: "Open a LinkedIn page in the browser. Costs one page load.", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } },
  { name: "outline", description: "Outline of the open page, or of the part under a handle. Elements carry handles like [n12].", input_schema: { type: "object", properties: { handle: { type: "string" }, max_lines: { type: "integer", minimum: 20, maximum: 600 } }, additionalProperties: false } },
  { name: "selectors_for", description: 'Verified selectors for the element with this handle ("single"), or for the repeating list items it belongs to ("list").', input_schema: { type: "object", properties: { handle: { type: "string" }, mode: { type: "string", enum: ["single", "list"] } }, required: ["handle", "mode"], additionalProperties: false } },
  { name: "probe", description: "How many elements a selector matches on the open page, and the first values.", input_schema: { type: "object", properties: { selector: { type: "string" }, attr: { type: "string" } }, required: ["selector"], additionalProperties: false } },
  { name: "scroll", description: "Scroll down to load more content.", input_schema: { type: "object", properties: { times: { type: "integer", minimum: 1, maximum: 5 } }, additionalProperties: false } },
  { name: "expand", description: "Click a 'see more'-style button by handle, to reveal collapsed content in place.", input_schema: { type: "object", properties: { handle: { type: "string" } }, required: ["handle"], additionalProperties: false } },
  { name: "test_recipe", description: "Run a recipe's extraction on the page that is already open (no page load). Returns its output, missing fields and problems.", input_schema: { type: "object", properties: { recipe: { type: "object" }, input: { type: "object", description: "Input for the goto expression, e.g. {\"company\":\"anthropic\"}" } }, required: ["recipe", "input"], additionalProperties: false } },
  { name: "finish", description: "Submit the finished recipe. It is run once more from a fresh page load and saved as a draft for the owner to review.", input_schema: { type: "object", properties: { recipe: { type: "object" }, input: { type: "object" }, summary: { type: "string" } }, required: ["recipe", "input", "summary"], additionalProperties: false } },
];

const asRecipe = (r: ToolInput): RecipeDef => ({ schemaVersion: 1, kind: "api", version: 0, updatedAt: "", ...r } as RecipeDef);
const json = (v: unknown, max = 12_000) => {
  const s = JSON.stringify(v, null, 1);
  return s.length > max ? `${s.slice(0, max)}… (truncated)` : s;
};

export class GenerationSession {
  private lease?: Lease;
  private page?: Page;
  private loads = 0;
  private finished?: { recipe: RecipeDef; output: unknown };

  constructor(private readonly req: GenRequest, private readonly opts: GenOptions = {}) {}

  private emit(e: GenEvent): void {
    this.opts.onEvent?.(e);
  }

  get pageLoadsUsed(): number {
    return this.loads;
  }

  // The current page, for streaming it to the owner and for resolving taps.
  get currentPage(): Page | undefined {
    return this.page;
  }

  async pick(x: number, y: number) {
    return this.page ? describeAt(this.page, x, y) : null;
  }

  private async openPage(url: string): Promise<string> {
    const policy = this.opts.policy ?? LINKEDIN_POLICY;
    const nav = checkNavigation(url, policy);
    if (!nav.ok) throw new Error(`Not allowed: ${nav.reason}`);
    const budget = this.req.budget ?? 6;
    if (this.loads >= budget) throw new Error(`The page-load budget for this generation (${budget}) is used up. Work with the page that is open, or finish.`);
    const category = new URL(url).pathname.startsWith("/search/") ? "search" : "view_profile";
    consume(category);
    this.loads++;
    const page = this.page!;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const [a, b] = this.opts.delay ?? [2000, 4000];
    await humanDelay(a, b);
    assertHealthy(page);
    this.emit({ type: "status", text: `Opened ${page.url()} (${this.loads} of ${budget} page loads)` });
    return `Opened ${page.url()}. Page loads used: ${this.loads} of ${budget}.\n\n${await outline(page, { maxLines: 150 })}`;
  }

  private async runTool(name: string, input: ToolInput): Promise<string> {
    const page = this.page!;
    switch (name) {
      case "open_page":
        return this.openPage(String(input.url));
      case "outline":
        return outline(page, { root: input.handle, maxLines: input.max_lines });
      case "selectors_for": {
        const res = await selectorsFor(page, String(input.handle), input.mode === "list" ? "list" : "single");
        if (!res) return `No element ${input.handle} on this page; handles reset when the page reloads.`;
        if (!res.candidates.length) return `No robust selector found for ${input.handle}. Try a nearby element (its parent or a labelled sibling).`;
        return json(res);
      }
      case "probe": {
        const loc = page.locator(String(input.selector));
        const count = await loc.count();
        const values: (string | null)[] = [];
        for (let i = 0; i < Math.min(count, 5); i++) {
          const el = loc.nth(i);
          values.push(input.attr ? await el.getAttribute(String(input.attr)) : ((await el.innerText({ timeout: 2_000 }).catch(() => "")) || "").replace(/\s+/g, " ").trim().slice(0, 120));
        }
        return json({ count, values });
      }
      case "scroll": {
        for (let i = 0; i < (input.times ?? 1); i++) {
          await page.mouse.wheel(0, 2500);
          await humanDelay(600, 1200);
        }
        return "Scrolled. Outline again to see what loaded.";
      }
      case "expand": {
        const el = page.locator(`[data-lb-id="${input.handle}"]`);
        const safe = await el.evaluate((n) => (n.tagName === "BUTTON" || n.getAttribute("role") === "button") && !n.closest("form") && !n.closest("a[href]")).catch(() => false);
        if (!safe) return "That element is not a plain button, so it cannot be clicked. Only 'see more'-style buttons can be expanded.";
        const before = page.url();
        await el.click({ timeout: 3_000 });
        await humanDelay(500, 1000);
        if (page.url() !== before) throw new Error(`Clicking ${input.handle} navigated away to ${page.url()}.`);
        return "Expanded.";
      }
      case "test_recipe":
      case "finish": {
        const recipe = asRecipe(input.recipe ?? {});
        const errors = validateRecipe(recipe, this.opts.policy);
        if (errors.length) return json({ problems: errors });
        if (name === "finish") {
          // A full run from a fresh page load: the same thing a caller will do.
          const budget = this.req.budget ?? 6;
          if (this.loads >= budget) return json({ problems: [`No page load left for the final check (budget ${budget}).`] });
          this.loads++;
          const run = await runRecipeOnPage(recipe, input.input ?? {}, page, { policy: this.opts.policy, delay: this.opts.delay });
          this.emit({ type: "draft", recipe, output: run.output, missing: run.missing });
          this.finished = { recipe, output: run.output };
          return json({ accepted: true, output: run.output, missing: run.missing });
        }
        const run = await runRecipeOnPage(recipe, input.input ?? {}, page, { policy: this.opts.policy, delay: [0, 0], skipNavigation: true });
        this.emit({ type: "draft", recipe, output: run.output, missing: run.missing });
        return json({ output: run.output, missing: run.missing, log: run.log });
      }
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  }

  async run(): Promise<{ recipe: RecipeDef; output: unknown } | { failed: string }> {
    const budget = this.req.budget ?? 6;
    const left = remaining();
    if (left.view_profile < budget) return this.fail(`Only ${left.view_profile} profile views are left today; a generation may use up to ${budget}.`);
    const client = this.opts.client ?? claudeClient();
    const model = this.opts.model ?? modelFor("generator"); // fixed for the whole run
    this.emit({ type: "status", text: "Waiting for the browser" });
    this.lease = await acquire("interactive", "API generator");
    try {
      this.page = await this.lease.newPage();
      const messages: Anthropic.Beta.BetaMessageParam[] = [
        { role: "user", content: `What the owner wants: ${this.req.description}\nExample page: ${this.req.exampleUrl}\nPage-load budget: ${budget}.` },
      ];
      let nudges = 0;
      for (let turn = 0; turn < (this.opts.maxTurns ?? 30); turn++) {
        const hints = this.opts.hints?.() ?? [];
        if (hints.length) messages.push({ role: "user", content: `The owner pointed at the page:\n${hints.join("\n")}` });
        const res = await client.beta.messages.create({
          model,
          max_tokens: 16000,
          ...(supportsFallbacks(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          cache_control: { type: "ephemeral" },
          system: SYSTEM,
          tools: TOOLS,
          messages,
        });
        messages.push({ role: "assistant", content: res.content }); // append-only: thinking blocks stay valid
        for (const b of res.content) if (b.type === "text" && b.text.trim()) this.emit({ type: "note", text: b.text.trim() });

        if (res.stop_reason === "refusal") return this.fail("The model declined this request.");
        if (res.stop_reason === "max_tokens") return this.fail("The model's reply was cut off.");
        if (res.stop_reason === "pause_turn") continue;
        const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (!calls.length) {
          if (nudges++ >= 1) return this.fail(res.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.Beta.BetaTextBlock).text).join("\n") || "The generator stopped without a recipe.");
          messages.push({ role: "user", content: "Call finish with the recipe, or say plainly why it cannot be built." });
          continue;
        }
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const call of calls) {
          let content: string;
          let isError = false;
          try {
            content = await this.runTool(call.name, (call.input ?? {}) as ToolInput);
          } catch (e) {
            content = (e as Error).message;
            isError = true;
          }
          this.emit({ type: "tool", name: call.name, input: call.input, summary: content.slice(0, 200), isError });
          results.push({ type: "tool_result", tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) });
        }
        messages.push({ role: "user", content: results });
        if (this.finished) {
          this.emit({ type: "done", ...this.finished });
          return this.finished;
        }
      }
      return this.fail("The generator ran out of turns.");
    } catch (e) {
      return this.fail((e as Error).message);
    } finally {
      await this.lease.release({ persist: true });
      this.page = undefined;
    }
  }

  private fail(reason: string): { failed: string } {
    this.emit({ type: "failed", reason });
    return { failed: reason };
  }
}
