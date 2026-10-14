import { after, test } from "node:test";
import assert from "node:assert/strict";
import { listen, useTempDataDir } from "./helpers.js";

useTempDataDir();
const ops = await import("../src/ops/index.js");
const { recipeKind, validateRecipe } = await import("../src/ops/recipe.js");
const { LINKEDIN_POLICY } = await import("../src/policy.js");
const { closeBrowser } = await import("../src/browser.js");
const vault = await import("../src/vault.js");
const limits = await import("../src/limits.js");

// Pages shaped like LinkedIn's: a company page with a "see more" button, a lazily loaded people
// list, a link dressed up as an expander, and redirects to places recipes must not read.
const COMPANY = `<!doctype html><main>
<h1>Acme Corp</h1>
<section id=about><p class=about-text>Short about.</p><button class="see-more" onclick="document.querySelector('.about-text').textContent='Long about text, expanded.'">see more</button></section>
<dl><dt>Industry</dt><dd data-field=industry>Widgets</dd><dt>Company size</dt><dd data-field=size>51-200 employees</dd></dl>
<a href="/company/acme/people/" class="see-more">Show all people</a>
<a href="https://acme.example" data-test=website>acme.example</a>
</main>`;
const PEOPLE = `<!doctype html><main><ul id=people></ul></main><script>
let n=0;const add=()=>{for(let i=0;i<5&&n<12;i++,n++){const li=document.createElement('li');li.innerHTML='<a href="/in/person-'+(n%10)+'/">Person '+(n%10)+'</a><div>Engineer</div><div>London</div>';document.getElementById('people').append(li)}};
add();addEventListener('scroll',add);addEventListener('wheel',add);</script>`;

const site = await listen((req, res) => {
  const url = req.url ?? "";
  if (url === "/company/acme/about/") return void res.writeHead(200, { "content-type": "text/html" }).end(COMPANY);
  if (url === "/company/acme/people/") return void res.writeHead(200, { "content-type": "text/html" }).end(PEOPLE);
  if (url === "/company/walled/") return void res.writeHead(302, { location: "/authwall?x=1" }).end();
  if (url === "/company/moved/") return void res.writeHead(302, { location: "/feed/" }).end();
  res.writeHead(200, { "content-type": "text/html" }).end(`<p>${url}</p>`);
});
after(async () => {
  await closeBrowser();
  await site.close();
});

const policy = { ...LINKEDIN_POLICY, hosts: /^127\.0\.0\.1$/, schemes: ["http:"], navHost: "127.0.0.1" };
ops.registerKind("api", recipeKind({ policy, delay: [0, 0] }));
vault.saveSession({ cookies: [{ name: "li_at", value: "1", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }], origins: [] }, "test-agent");

const companyApi = {
  kind: "api" as const,
  name: "company_overview",
  description: "Name, about, industry, size and website of a company page.",
  inputSchema: { type: "object" as const, properties: { company: { type: "string", pattern: "^[a-z0-9-]+$" } }, required: ["company"] },
  cost: "view_profile",
  steps: [
    { type: "goto", url: { $expr: `'${site.base}/company/' & input.company & '/about/'` } },
    { type: "waitFor", selector: "main h1" },
    { type: "expand", selector: ".see-more", max: 2 },
    {
      type: "extract",
      as: "company",
      fields: {
        name: { selector: "h1", required: true },
        about: { selector: "#about p" },
        industry: { selector: ["[data-field=industry]", "dt:has-text('Industry') + dd"] },
        employees: { selector: "[data-field=size]", pattern: "^([\\d,]+-[\\d,]+)" },
        website: { selector: "a[data-test=website]", attr: "href" },
        founded: { selector: "[data-field=founded]" },
      },
    },
  ],
};

test("a recipe opens, expands in place, and extracts fields", async () => {
  assert.deepEqual(ops.saveDraft(companyApi).errors, []);
  assert.ok(ops.publish("company_overview").ok);
  const before = limits.remaining().view_profile;
  const out = await ops.runTopLevel("company_overview", { company: "acme" });
  assert.deepEqual(out, { name: "Acme Corp", about: "Long about text, expanded.", industry: "Widgets", employees: "51-200", website: "https://acme.example/", founded: null });
  assert.equal(limits.remaining().view_profile, before - 1); // one page load
});

test("extractList scrolls until enough items load, dedupes and reads lines", async () => {
  ops.saveDraft({
    kind: "api",
    name: "company_people",
    description: "People listed on a company page.",
    inputSchema: { type: "object", properties: {} },
    cost: "view_profile",
    steps: [
      { type: "goto", url: `${site.base}/company/acme/people/` },
      { type: "scroll", until: { selector: "#people li", count: 12 }, maxScrolls: 5 },
      { type: "extractList", as: "people", item: "#people li", dedupeBy: "url", fields: { name: { selector: "a" }, url: { selector: "a", attr: "href" }, title: { selector: ":scope", attr: "lines", line: 1 } } },
    ],
  });
  const people = (await ops.runTopLevel("company_people", {}, { allowDrafts: true })) as any[];
  assert.equal(people.length, 10); // 12 items, 2 duplicates
  assert.deepEqual(people[0], { name: "Person 0", url: `${site.base}/in/person-0/`, title: "Engineer" });
});

test("a missing required field fails the run with a clear message", async () => {
  ops.saveDraft({ ...companyApi, name: "needs_founded", steps: [companyApi.steps[0], { type: "extract", as: "c", fields: { founded: { selector: "[data-field=founded]", required: true } } }] });
  await assert.rejects(ops.runTopLevel("needs_founded", { company: "acme" }, { allowDrafts: true }), /Could not find c\.founded/);
});

test("pages outside the policy are refused, and a login wall pauses everything", async () => {
  const at = (name: string, path: string) => {
    ops.saveDraft({ ...companyApi, name, inputSchema: { type: "object", properties: {} }, steps: [{ type: "goto", url: { $expr: `'${site.base}${path}'` } }, { type: "extract", as: "x", fields: { p: { selector: "p" } } }] });
    return ops.runTopLevel(name, {}, { allowDrafts: true });
  };
  await assert.rejects(at("to_settings", "/psettings/"), /Refusing to open .*not a page generated APIs may read/);
  await assert.rejects(at("to_feed", "/company/moved/"), /sent the browser to .*\/feed\//);
  await assert.rejects(at("to_wall", "/company/walled/"), /Session needs attention/);
  assert.equal(limits.breakerState().open, true);
  limits.resetBreaker();
});

test("validation rejects unsafe or brittle recipes", () => {
  const errs = (over: Record<string, unknown>) => validateRecipe({ ...companyApi, schemaVersion: 1, version: 1, updatedAt: "", ...over } as any, policy);
  assert.deepEqual(errs({}), []);
  assert.match(errs({ cost: "message" })[0], /cost must be/);
  assert.match(errs({ steps: [{ type: "extract", as: "a", fields: { x: { selector: "h1" } } }] })[0], /first step must be "goto"/);
  assert.match(errs({ steps: [{ type: "goto", url: "https://evil.example/in/x" }, { type: "extract", as: "a", fields: { x: { selector: "h1" } } }] })[0], /URLs are not allowed|only 127/);
  assert.match(errs({ steps: [companyApi.steps[0], { type: "click", selector: "a" }, { type: "extract", as: "a", fields: { x: { selector: "h1" } } }] })[0], /unknown step type/);
  assert.match(errs({ steps: [companyApi.steps[0], { type: "type", selector: "input", text: "hi" }] }).join(), /unknown step type/);
  assert.match(errs({ steps: [companyApi.steps[0], { type: "extract", as: "a", fields: { x: { selector: "div.x7Fa9Q2 span" } } }] })[0], /looks like a generated class name/);
  assert.deepEqual(errs({ steps: [companyApi.steps[0], { type: "extract", as: "a", fields: { x: { selector: ".text-body-medium" }, y: { selector: "h2" } } }] }), []);
  assert.match(errs({ steps: [companyApi.steps[0], { type: "waitFor", selector: "h1" }] }).join(), /at least one extract/);
});

test("expand never follows links", async () => {
  ops.saveDraft({ ...companyApi, name: "expand_links", steps: [companyApi.steps[0], { type: "expand", selector: "a.see-more" }, companyApi.steps[3]] });
  const out = (await ops.runTopLevel("expand_links", { company: "acme" }, { allowDrafts: true })) as any;
  assert.equal(out.name, "Acme Corp"); // still on the about page: the link was skipped, not clicked
});
