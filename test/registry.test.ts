import { after, test } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir } from "./helpers.js";

useTempDataDir();
const registry = await import("../src/ops/registry.js");
const run = await import("../src/ops/run.js");
const { closeBrowser, lock } = await import("../src/browser.js");
after(closeBrowser);

// A stand-in stored kind: echoes its input through a "body" field, so registry and runner can be
// tested before the real chain and recipe kinds exist.
registry.registerKind("tool", {
  validate: (def) => (typeof def.body === "string" ? [] : ["body must be a string"]),
  cost: (_def, input: any) => ({ view_profile: input.n ?? 0 }),
  run: async (def, input, ctx) => ({ body: def.body, input, depth: ctx.depth, path: ctx.path }),
  usesLinkedIn: () => false,
});

const draft = (over: Record<string, unknown> = {}) => ({
  kind: "tool" as const,
  name: "echo_tool",
  description: "Echo for tests.",
  inputSchema: { type: "object" as const, properties: { n: { type: "integer", default: 0 } }, additionalProperties: false },
  body: "v1",
  ...over,
});

test("built-ins are listed and published", () => {
  const names = registry.listOps().map((o) => o.name);
  for (const n of ["whoami", "view_profile", "search_people", "list_leads", "agent"]) assert.ok(names.includes(n), n);
});

test("a draft is invisible until published, then versioned", () => {
  const { errors } = registry.saveDraft(draft());
  assert.deepEqual(errors, []);
  assert.equal(registry.getOp("echo_tool"), undefined);
  assert.equal(registry.getOp("echo_tool", { draft: true })?.status, "draft");

  const published = registry.publish("echo_tool");
  assert.ok(published.ok);
  assert.equal(registry.getOp("echo_tool")?.version, 1);
  assert.equal(registry.getOp("echo_tool", { draft: true })?.status, "published"); // no draft left

  registry.saveDraft(draft({ body: "v2" }));
  assert.equal((registry.getOp("echo_tool") as any).body, "v1"); // published copy keeps working
  assert.equal((registry.getOp("echo_tool", { draft: true }) as any).body, "v2");
  assert.ok(registry.publish("echo_tool").ok);
  assert.equal(registry.getOp("echo_tool")?.version, 2);
  assert.equal(registry.listOps({ drafts: true }).filter((o) => o.name === "echo_tool").length, 1);
});

test("invalid drafts are saved but cannot be published", () => {
  const { errors } = registry.saveDraft(draft({ name: "broken_tool", body: 42, description: " " }));
  assert.deepEqual(errors, ["description is required: it is what assistants read to decide when to use this"]);
  const res = registry.publish("broken_tool");
  assert.equal(res.ok, false);
  assert.ok(registry.getOp("broken_tool", { draft: true }));
});

test("names are checked, and built-ins cannot be replaced or removed", () => {
  assert.match(registry.saveDraft(draft({ name: "Bad-Name" })).errors[0], /lowercase letters/);
  assert.match(registry.saveDraft(draft({ name: "whoami" })).errors[0], /built-in/);
  assert.equal(registry.removeOp("whoami"), false);
  assert.equal(registry.getOp("../etc/passwd"), undefined);
});

test("removeOp deletes the draft and the published version", () => {
  registry.saveDraft(draft({ name: "gone_tool" }));
  registry.publish("gone_tool");
  assert.equal(registry.removeOp("gone_tool"), true);
  assert.equal(registry.getOp("gone_tool", { draft: true }), undefined);
});

test("validateInput fills defaults and reports problems by field", () => {
  const op = registry.getOp("search_people")!;
  assert.deepEqual(run.validateInput(op, { keywords: "data" }), { ok: true, value: { keywords: "data", pages: 1 } });
  const bad = run.validateInput(op, { keywords: "", pages: 9, extra: true });
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.errors.some((e) => e.includes("/pages")) && bad.errors.some((e) => e.includes("(extra)")));
});

test("runTopLevel validates, checks the budget and records a trace", async () => {
  const events: unknown[] = [];
  assert.deepEqual(await run.runTopLevel("echo_tool", {}, { onTrace: (e) => events.push(e) }), { body: "v2", input: { n: 0 }, depth: 0, path: "" });
  assert.equal(events.length, 1);
  await assert.rejects(run.runTopLevel("echo_tool", { n: 1000 }), /Would exceed today's cap for "view_profile"/);
  await assert.rejects(run.runTopLevel("echo_tool", { n: "x" }), run.InputError);
  await assert.rejects(run.runTopLevel("nope", {}), /Unknown operation "nope"/);
});

test("drafts only run when asked for", async () => {
  registry.saveDraft(draft({ name: "draft_only" }));
  await assert.rejects(run.runTopLevel("draft_only", {}), /Unknown operation/);
  assert.equal(((await run.runTopLevel("draft_only", {}, { allowDrafts: true })) as any).body, "v1");
});

test("list_leads runs without a browser", async () => {
  assert.deepEqual(await run.runTopLevel("list_leads", {}), []);
  assert.equal(lock.state().holder, undefined);
});

test("a LinkedIn built-in without a session fails cleanly and frees the browser", async () => {
  await assert.rejects(run.runTopLevel("whoami", {}), /No saved LinkedIn session/);
  assert.equal(lock.state().holder, undefined);
});
