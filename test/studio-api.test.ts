import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { useTempDataDir } from "./helpers.js";
import { startServer } from "./server.js";

const dir = useTempDataDir();
const web = `${dir}/web`;
mkdirSync(`${web}/assets`, { recursive: true });
writeFileSync(`${web}/index.html`, "<!doctype html><div id=root></div>");
writeFileSync(`${web}/assets/app-abc123.js`, "console.log(1)");

let server: Awaited<ReturnType<typeof startServer>>;
before(async () => (server = await startServer(dir, { LINKEDBOT_WEB_DIST: web })));
after(() => server.stop());

const signIn = async (token: string) =>
  fetch(`${server.base}/api/session`, { method: "POST", headers: { "content-type": "application/json", origin: server.base }, body: JSON.stringify({ token }) });

test("the studio is served under /studio/ with app routes falling back to index.html", async () => {
  const root = await fetch(`${server.base}/`, { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/studio/");
  const page = await fetch(`${server.base}/studio/build/new`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-cache");
  assert.match(await page.text(), /id=root/);
  const asset = await fetch(`${server.base}/studio/assets/app-abc123.js`);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal((await fetch(`${server.base}/studio/assets/missing.js`)).status, 404);
  assert.equal((await fetch(`${server.base}/studio/..%2f..%2fpackage.json`)).status, 404);
});

test("signing in with the token sets a strict, http-only cookie that works for the API", async () => {
  assert.equal((await signIn("wrong words here please")).status, 401);
  const res = await signIn("Apple Banana Cherry Delta");
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie")!;
  assert.match(cookie, /^lb_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
  const jar = cookie.split(";")[0];

  assert.deepEqual(await fetch(`${server.base}/api/session`, { headers: { cookie: jar } }).then((r) => r.json()), { signedIn: true, via: "studio" });
  assert.equal((await fetch(`${server.base}/api/status`, { headers: { cookie: jar } })).status, 200);

  // writes need the request to come from this site
  const def = JSON.stringify({ kind: "tool", name: "cookie_tool", description: "d", inputSchema: { type: "object" }, steps: [{ id: "a", type: "call", op: "list_leads" }] });
  assert.equal((await fetch(`${server.base}/api/ops`, { method: "POST", headers: { cookie: jar, "content-type": "application/json" }, body: def })).status, 401);
  assert.equal((await fetch(`${server.base}/api/ops`, { method: "POST", headers: { cookie: jar, "content-type": "application/json", origin: "https://evil.example" }, body: def })).status, 401);
  assert.equal((await fetch(`${server.base}/api/ops`, { method: "POST", headers: { cookie: jar, "content-type": "application/json", origin: server.base }, body: def })).status, 200);

  // the cookie is not a way into MCP
  assert.equal((await fetch(`${server.base}/mcp`, { method: "POST", headers: { cookie: jar, "content-type": "application/json" }, body: "{}" })).status, 401);

  // a forged or tampered cookie is refused
  assert.equal((await fetch(`${server.base}/api/status`, { headers: { cookie: jar.replace(/.$/, (c) => (c === "A" ? "B" : "A")) } })).status, 401);

  const out = await fetch(`${server.base}/api/session`, { method: "DELETE", headers: { cookie: jar, origin: server.base } });
  assert.match(out.headers.get("set-cookie")!, /Max-Age=0/);
});

test("preview runs an unsaved tool and returns each step's output", async () => {
  const jar = (await signIn("apple-banana-cherry-delta")).headers.get("set-cookie")!.split(";")[0];
  const preview = (body: unknown) =>
    fetch(`${server.base}/api/preview`, { method: "POST", headers: { cookie: jar, "content-type": "application/json", origin: server.base }, body: JSON.stringify(body) }).then((r) => r.json());

  const job = await preview({
    def: { name: "draft", inputSchema: { type: "object", properties: { n: { type: "integer", default: 2 } } }, steps: [{ id: "all", type: "call", op: "list_leads", args: { limit: { $expr: "input.n" } } }], output: { $expr: "{ 'count': $count(steps.all.output) }" } },
    input: {},
  });
  assert.equal(job.status, "done");
  assert.equal(job.result.ok, true);
  assert.deepEqual(job.result.output, { count: 0 });
  assert.deepEqual(job.result.steps.all, { output: [], status: "done" });
  assert.equal(job.result.trace[0].op, "list_leads");

  const bad = await preview({ def: { steps: [{ id: "x", type: "call", op: "nope" }] } });
  assert.equal(bad.result.ok, false);
  assert.match(bad.result.problems[0], /no published operation "nope"/);
});
