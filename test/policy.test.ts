import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { listen, useTempDataDir } from "./helpers.js";

const dir = useTempDataDir();
const { checkNavigation, installGuard, watchRateLimits, LINKEDIN_POLICY } = await import("../src/policy.js");
const limits = await import("../src/limits.js");

test("checkNavigation allows LinkedIn read pages only", () => {
  const ok = (u: string) => checkNavigation(u).ok;
  assert.equal(ok("https://www.linkedin.com/in/someone/"), true);
  assert.equal(ok("https://www.linkedin.com/company/anthropic/about/"), true);
  assert.equal(ok("https://www.linkedin.com/search/results/people/?keywords=x"), true);
  assert.equal(ok("http://www.linkedin.com/in/someone/"), false);
  assert.equal(ok("https://evil.com/in/someone/"), false);
  assert.equal(ok("https://www.linkedin.com.evil.com/in/x"), false);
  assert.equal(ok("https://user:pw@www.linkedin.com/in/x"), false);
  assert.equal(ok("https://www.linkedin.com/m/logout/"), false);
  assert.equal(ok("https://www.linkedin.com/comm/mynetwork/invite-accept"), false);
  assert.equal(ok("https://www.linkedin.com/psettings/"), false);
  assert.equal(ok("not a url"), false);
});

// The same rules pointed at a local server instead of linkedin.com.
let browser: Browser;
let site: Awaited<ReturnType<typeof listen>>;
const policy = { ...LINKEDIN_POLICY, hosts: /^127\.0\.0\.1$/, schemes: ["http:"], navHost: "127.0.0.1" };

before(async () => {
  browser = await chromium.launch();
  site = await listen((req, res) => {
    if (req.url === "/in/limited") return void res.writeHead(999).end("no");
    res.writeHead(200, { "content-type": "text/html" }).end(`<p>${req.method} ${req.url}</p>`);
  });
});
after(async () => {
  await browser.close();
  await site.close();
});

const logLines = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

test("enforce: reads pass; writes, off-policy pages and walls are blocked", async () => {
  const log = `${dir}/guard-enforce.log`;
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  await installGuard(ctx, { mode: "enforce", policy, log });
  const page = await ctx.newPage();

  const okRes = await page.goto(`${site.base}/in/someone`);
  assert.equal(okRes?.status(), 200);
  assert.equal(await page.evaluate(() => fetch("/voyager/api/me").then((r) => r.status)), 200);
  assert.equal(await page.evaluate(() => fetch("/voyager/api/x", { method: "POST" }).then(() => "sent", () => "blocked")), "blocked");
  await assert.rejects(page.goto(`${site.base}/m/logout`), /ERR_BLOCKED_BY_CLIENT/);

  assert.equal(limits.breakerState().open, false);
  await assert.rejects(page.goto(`${site.base}/authwall?trk=x`), /ERR_BLOCKED_BY_CLIENT/);
  assert.equal(limits.breakerState().open, true);
  limits.resetBreaker();

  assert.deepEqual(logLines(log).map(({ verdict, method, path }) => ({ verdict, method, path })), [
    { verdict: "write", method: "POST", path: "/voyager/api/x" },
    { verdict: "navigation", method: "GET", path: "/m/logout" },
    { verdict: "wall", method: "GET", path: "/authwall" },
  ]);
  await ctx.close();
});

test("observe: nothing is blocked, but the same things are logged", async () => {
  const log = `${dir}/guard-observe.log`;
  rmSync(log, { force: true });
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  await installGuard(ctx, { mode: "observe", policy, log });
  const page = await ctx.newPage();
  await page.goto(`${site.base}/in/someone`);
  assert.equal(await page.evaluate(() => fetch("/voyager/api/x", { method: "POST" }).then((r) => r.status)), 200);
  assert.equal((await page.goto(`${site.base}/m/logout`))?.status(), 200);
  assert.deepEqual(logLines(log).map((l) => l.verdict), ["write", "navigation"]);
  await ctx.close();
});

test("a 999 on a page load trips the breaker", async () => {
  const ctx = await browser.newContext();
  watchRateLimits(ctx, policy);
  const page = await ctx.newPage();
  await page.goto(`${site.base}/in/limited`);
  assert.equal(limits.breakerState().open, true);
  assert.match(limits.breakerState().reason ?? "", /999/);
  limits.resetBreaker();
  await ctx.close();
});
