import { after, test } from "node:test";
import assert from "node:assert/strict";
import { listen, useTempDataDir } from "./helpers.js";

useTempDataDir();
const { GenerationSession } = await import("../src/gen/generator.js");
const { LINKEDIN_POLICY } = await import("../src/policy.js");
const { closeBrowser, lock } = await import("../src/browser.js");
const vault = await import("../src/vault.js");
const limits = await import("../src/limits.js");

const COMPANY = `<!doctype html><title>Acme | LinkedIn</title><main>
<h1>Acme Corp</h1>
<section><h2>Overview</h2><p>We make widgets.</p>
<dl><dt>Industry</dt><dd>Widgets</dd><dt>Company size</dt><dd>51-200 employees</dd></dl></section>
<section><h2>People</h2><ul>${[0, 1, 2].map((i) => `<li><a href="/in/p${i}/">Person ${i}</a><div>Engineer</div></li>`).join("")}</ul></section>
</main>`;
const site = await listen((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(req.url === "/company/acme/about/" ? COMPANY : "<p>other</p>"));
after(async () => {
  await closeBrowser();
  await site.close();
});
vault.saveSession({ cookies: [{ name: "li_at", value: "1", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }], origins: [] }, "test-agent");
const policy = { ...LINKEDIN_POLICY, hosts: /^127\.0\.0\.1$/, schemes: ["http:"], navHost: "127.0.0.1" };

// A stand-in for Claude that follows the intended workflow, reading handles out of tool results the
// way the model would. Each step returns one tool call.
function scriptedClient(steps: ((lastResult: string) => { name: string; input: unknown } | string)[]) {
  let i = 0;
  const requests: any[] = [];
  return {
    requests,
    beta: {
      messages: {
        create: async (params: any) => {
          requests.push(params);
          const last = params.messages.at(-1);
          const lastResult = Array.isArray(last.content) ? last.content.map((c: any) => c.content ?? "").join("\n") : String(last.content);
          const step = steps[i++]?.(lastResult) ?? "done";
          if (typeof step === "string") return { content: [{ type: "text", text: step }], stop_reason: "end_turn" };
          return { content: [{ type: "text", text: `calling ${step.name}` }, { type: "tool_use", id: `t${i}`, name: step.name, input: step.input }], stop_reason: "tool_use" };
        },
      },
    },
  };
}
const handleOf = (outline: string, pattern: RegExp) => {
  const line = outline.split("\n").find((l) => pattern.test(l));
  assert.ok(line, `no line matching ${pattern} in:\n${outline}`);
  return /\[(n\d+)\]/.exec(line!)![1];
};

const url = `${site.base}/company/acme/about/`;
const recipe = (name: string, people: string) => ({
  name: "company_overview",
  description: "Name, industry and people of a company page.",
  inputSchema: { type: "object", properties: { company: { type: "string" } }, required: ["company"] },
  cost: "view_profile",
  steps: [
    { type: "goto", url: { $expr: `'${site.base}/company/' & input.company & '/about/'` } },
    { type: "extract", as: "company", fields: { name: { selector: name, required: true }, industry: { selector: "dt:text-is(\"Industry\") + dd" } } },
    { type: "extractList", as: "people", item: people, fields: { name: { selector: "a" }, url: { selector: "a", attr: "href" } } },
  ],
  output: { $expr: "{ 'name': vars.company.name, 'industry': vars.company.industry, 'people': vars.people }" },
});

test("the generator explores, gets verified selectors, tests on the open page and finishes", async () => {
  let outline = "", nameSel = "", itemSel = "";
  const client = scriptedClient([
    () => ({ name: "open_page", input: { url } }),
    (r) => ((outline = r), { name: "selectors_for", input: { handle: handleOf(r, /h1 "Acme Corp"/), mode: "single" } }),
    (r) => ((nameSel = JSON.parse(r).candidates[0].selector), { name: "selectors_for", input: { handle: handleOf(outline, /a href=\/in\/p0\//), mode: "list" } }),
    (r) => {
      const res = JSON.parse(r);
      itemSel = res.candidates[0].selector;
      return { name: "test_recipe", input: { recipe: recipe(nameSel, itemSel), input: { company: "acme" } } };
    },
    (r) => (assert.deepEqual(JSON.parse(r).missing, []), { name: "finish", input: { recipe: recipe(nameSel, itemSel), input: { company: "acme" }, summary: "done" } }),
  ]);
  const events: any[] = [];
  const before = limits.remaining().view_profile;
  const session = new GenerationSession({ description: "company name, industry and people", exampleUrl: url, budget: 3 }, { client: client as any, policy, delay: [0, 0], onEvent: (e) => events.push(e) });
  const result = await session.run();

  assert.ok("recipe" in result, JSON.stringify(result));
  assert.equal(nameSel, "h1");
  assert.match(itemSel, /li/);
  assert.deepEqual((result as any).output, {
    name: "Acme Corp",
    industry: "Widgets",
    people: [0, 1, 2].map((i) => ({ name: `Person ${i}`, url: `${site.base}/in/p${i}/` })),
  });
  assert.equal(session.pageLoadsUsed, 2); // explore + the final run; testing was free
  assert.equal(limits.remaining().view_profile, before - 2);
  assert.deepEqual(events.filter((e) => e.type === "tool").map((e) => e.name), ["open_page", "selectors_for", "selectors_for", "test_recipe", "finish"]);
  assert.equal(events.at(-1).type, "done");
  assert.equal(lock.state().holder, undefined); // the browser was given back

  // What was sent to the API: the default model, adaptive thinking, caching and refusal fallbacks.
  const sent = client.requests[0];
  assert.equal(sent.model, "claude-opus-5-5");
  assert.deepEqual(sent.thinking, { type: "adaptive" });
  assert.equal(sent.fallbacks, "default");
  assert.deepEqual(sent.cache_control, { type: "ephemeral" });
  // the history only grows: every earlier message is resent unchanged
  assert.deepEqual(client.requests.at(-1).messages.slice(0, sent.messages.length), sent.messages);
});

test("the budget, the navigation policy and bad recipes come back as tool errors", async () => {
  const client = scriptedClient([
    () => ({ name: "open_page", input: { url: "https://evil.example/in/x" } }),
    () => ({ name: "open_page", input: { url } }),
    () => ({ name: "open_page", input: { url } }),
    () => ({ name: "test_recipe", input: { recipe: { ...recipe("div.x7Fa9Q2", "li"), steps: [{ type: "click", selector: "a" }] }, input: {} } }),
    () => ({ name: "expand", input: { handle: "n1" } }),
    () => "This cannot be built.",
    () => "Still cannot.",
  ]);
  const events: any[] = [];
  const result = await new GenerationSession({ description: "x", exampleUrl: url, budget: 1 }, { client: client as any, policy, delay: [0, 0], onEvent: (e) => events.push(e) }).run();
  assert.deepEqual(result, { failed: "Still cannot." });
  const tools = events.filter((e) => e.type === "tool");
  assert.match(tools[0].summary, /Not allowed/);
  assert.equal(tools[0].isError, true);
  assert.match(tools[1].summary, /^Opened/);
  assert.match(tools[2].summary, /budget for this generation \(1\) is used up/);
  assert.match(tools[3].summary, /problems/);
  assert.match(tools[4].summary, /not a plain button|Expanded/);
  assert.equal(lock.state().holder, undefined);
});
