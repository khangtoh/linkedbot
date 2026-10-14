import { after, test } from "node:test";
import assert from "node:assert/strict";
import { listen, sleep, useTempDataDir } from "./helpers.js";

useTempDataDir();
const { PriorityLock, acquire, closeBrowser, withPage, lock } = await import("../src/browser.js");
const vault = await import("../src/vault.js");
const limits = await import("../src/limits.js");

test("the lock serves login, then interactive, then jobs, first come first served", async () => {
  const l = new PriorityLock();
  const order: string[] = [];
  const first = await l.acquire("job", "running");
  const queued = [
    l.acquire("job", "job1"),
    l.acquire("job", "job2"),
    l.acquire("interactive", "gen"),
    l.acquire("login", "login"),
  ].map((p, i) => p.then((release) => { order.push(["job1", "job2", "gen", "login"][i]); return release; }));
  assert.deepEqual(l.state().waiting.map((w) => w.label), ["login", "gen", "job1", "job2"]);
  first();
  for (let i = 0; i < 4; i++) {
    await sleep(5);
    const holder = l.state().holder!.label;
    (await queued[["job1", "job2", "gen", "login"].indexOf(holder)])();
  }
  assert.deepEqual(order, ["login", "gen", "job1", "job2"]);
});

test("a release callback is idempotent", async () => {
  const l = new PriorityLock();
  const r1 = await l.acquire("job", "a");
  const p2 = l.acquire("job", "b");
  const p3 = l.acquire("job", "c");
  r1();
  r1();
  await p2;
  assert.equal(l.state().holder?.label, "b");
  assert.equal(l.state().waiting.length, 1);
  (await p2)();
  (await p3)();
});

const site = await listen((req, res) => {
  res.writeHead(200, { "content-type": "text/html", "set-cookie": `seen=${req.url?.slice(1)}; Path=/` }).end("<p>ok</p>");
});
after(async () => {
  await closeBrowser();
  await site.close();
});

const seed = (cookies: { name: string; value: string }[]) =>
  vault.saveSession({ cookies: cookies.map((c) => ({ ...c, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" })), origins: [] }, "test-agent");
const cookieNames = () => vault.loadSession().state.cookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).sort();

test("without a saved session, acquiring a job lease fails and frees the lock", async () => {
  await assert.rejects(withPage("x", async () => 1), /No saved LinkedIn session/);
  assert.equal(lock.state().holder, undefined);
});

test("withPage replays the vault and writes healthy cookies back", async () => {
  seed([{ name: "li_at", value: "1" }]);
  await withPage("visit", async (page) => {
    await page.goto(`${site.base}/first`);
    assert.equal(await page.evaluate(() => navigator.userAgent), "test-agent");
  });
  assert.deepEqual(cookieNames(), ["li_at=1", "seen=first"]);
});

test("cookies are not written back while the breaker is open", async () => {
  limits.tripBreaker("test");
  await withPage("visit", (page) => page.goto(`${site.base}/second`));
  assert.deepEqual(cookieNames(), ["li_at=1", "seen=first"]);
  limits.resetBreaker();
});

test("cookies are not written back once li_at is gone", async () => {
  seed([{ name: "other", value: "1" }]);
  await withPage("visit", (page) => page.goto(`${site.base}/third`));
  assert.deepEqual(cookieNames(), ["other=1"]);
});

test("a new vault replaces the browser context; login leases get a clean one", async () => {
  seed([{ name: "li_at", value: "2" }]);
  const cookies = await withPage("visit", (page) => page.context().cookies());
  assert.deepEqual(cookies.map((c) => `${c.name}=${c.value}`), ["li_at=2"]);
  const login = await acquire("login", "login");
  assert.deepEqual(await login.context.cookies(), []);
  await login.release();
  assert.equal(lock.state().holder, undefined);
});
