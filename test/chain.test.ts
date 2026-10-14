import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir } from "./helpers.js";

useTempDataDir();
const ops = await import("../src/ops/index.js");
const { estimateCost } = await import("../src/ops/chain.js");

// Fake LinkedIn operations as stored "api" definitions with a stand-in runner: deterministic data,
// no browser. fake_search returns `n` people; fake_profile fails for urls containing "bad".
const calls: string[] = [];
ops.registerKind("api", {
  validate: () => [],
  cost: (def) => (def.name === "fake_search" ? { search: 1 } : { view_profile: 1 }),
  usesLinkedIn: () => true,
  run: async (def, input: any) => {
    calls.push(`${def.name} ${JSON.stringify(input)}`);
    if (def.name === "fake_search") return { sample: Array.from({ length: input.n ?? 3 }, (_, i) => ({ name: `P${i}`, url: `u${i}${input.bad ? "bad" : ""}` })) };
    if (String(input.url).includes("bad")) throw new Error(`no profile at ${input.url}`);
    return { url: input.url, headline: `headline of ${input.url}` };
  },
});
const api = (name: string, properties: Record<string, unknown>, required: string[] = []) => {
  ops.saveDraft({ kind: "api", name, description: name, inputSchema: { type: "object", properties, required, additionalProperties: false } });
  assert.ok(ops.publish(name).ok);
};
api("fake_search", { keywords: { type: "string" }, n: { type: "integer", default: 3 }, bad: { type: "boolean" } }, ["keywords"]);
api("fake_profile", { url: { type: "string" } }, ["url"]);

const tool = (name: string, body: Record<string, unknown>, inputSchema: any = { type: "object", properties: { keywords: { type: "string" } }, required: ["keywords"] }) =>
  ops.saveDraft({ kind: "tool", name, description: `test tool ${name}`, inputSchema, ...body });

const findAndRead = {
  steps: [
    { id: "found", type: "call", op: "fake_search", args: { keywords: { $expr: "input.keywords" }, n: 4 } },
    {
      id: "profiles",
      type: "forEach",
      items: { $expr: "steps.found.output.sample" },
      as: "person",
      limit: 3,
      steps: [{ id: "p", type: "call", op: "fake_profile", args: { url: { $expr: "$person.url" } } }],
      collect: { $expr: "{ 'name': $person.name, 'headline': steps.p.output.headline, 'n': $index }" },
    },
  ],
  output: { $expr: "{ 'query': input.keywords, 'people': steps.profiles.output }" },
};

test("a search-then-read-each chain runs and maps data between steps", async () => {
  assert.deepEqual(tool("find_and_read", findAndRead).errors, []);
  assert.ok(ops.publish("find_and_read").ok);
  calls.length = 0;
  const out = await ops.runTopLevel("find_and_read", { keywords: "data" });
  assert.deepEqual(out, {
    query: "data",
    people: [0, 1, 2].map((i) => ({ name: `P${i}`, headline: `headline of u${i}`, n: i })),
  });
  assert.deepEqual(calls, ['fake_search {"keywords":"data","n":4}', 'fake_profile {"url":"u0"}', 'fake_profile {"url":"u1"}', 'fake_profile {"url":"u2"}']);
});

test("the trace records every call with its path", async () => {
  const events: { op: string; path: string }[] = [];
  await ops.runTopLevel("find_and_read", { keywords: "x" }, { onTrace: (e) => events.push({ op: e.op, path: e.path }) });
  assert.deepEqual(events.map((e) => `${e.op}@${e.path}`), [
    "fake_search@found",
    "fake_profile@profiles[0]/p",
    "fake_profile@profiles[1]/p",
    "fake_profile@profiles[2]/p",
    "find_and_read@",
  ]);
});

test("previews cap loops; worst-case cost multiplies by the loop limit", async () => {
  calls.length = 0;
  const out = (await ops.runTopLevel("find_and_read", { keywords: "x" }, { loopCap: 2 })) as any;
  assert.equal(out.people.length, 2);
  const def = ops.getOp("find_and_read") as any;
  assert.deepEqual(await estimateCost(def, { keywords: "x" }), { search: 1, view_profile: 3 });
  assert.deepEqual(await estimateCost(def, { keywords: "x" }, 2), { search: 1, view_profile: 2 });
});

test("without output, a tool returns its last step; a failing loop item stops it unless skipped", async () => {
  const body = (onError: string) => ({
    steps: [
      { id: "found", type: "call", op: "fake_search", args: { keywords: "x", bad: true, n: 2 } },
      { id: "each", type: "forEach", items: { $expr: "steps.found.output.sample" }, as: "person", limit: 5, onError, steps: [{ id: "p", type: "call", op: "fake_profile", args: { url: { $expr: "$person.url" } } }] },
    ],
  });
  tool("stops", body("stop"));
  await assert.rejects(ops.runTopLevel("stops", { keywords: "x" }, { allowDrafts: true }), /no profile at u0bad/);
  tool("skips", body("skip"));
  assert.deepEqual(await ops.runTopLevel("skips", { keywords: "x" }, { allowDrafts: true }), []);
});

test("a single result still loops once; an empty result loops zero times", async () => {
  tool("one_or_none", {
    steps: [
      { id: "found", type: "call", op: "fake_search", args: { keywords: "x", n: { $expr: "input.n" } } },
      { id: "each", type: "forEach", items: { $expr: "steps.found.output.sample.url" }, as: "url", limit: 5, steps: [{ id: "p", type: "call", op: "fake_profile", args: { url: { $expr: "$url" } } }], collect: { $expr: "steps.p.output.url" } },
    ],
  }, { type: "object", properties: { n: { type: "integer" } } });
  assert.deepEqual(await ops.runTopLevel("one_or_none", { n: 1 }, { allowDrafts: true }), ["u0"]);
  assert.deepEqual(await ops.runTopLevel("one_or_none", { n: 0 }, { allowDrafts: true }), []);
});

test("validation explains what is wrong, step by step", () => {
  const errs = (body: Record<string, unknown>) => tool("checked", body).errors;
  assert.deepEqual(errs({ steps: [] }), ["a tool needs at least one step"]);
  assert.match(errs({ steps: [{ id: "a", type: "call", op: "nope" }] })[0], /no published operation "nope"/);
  assert.match(errs({ steps: [{ id: "a", type: "call", op: "agent", args: { task: "x" } }] })[0], /no published operation "agent"/);
  assert.match(errs({ steps: [{ id: "a", type: "call", op: "fake_profile" }] })[0], /needs "url"/);
  assert.match(errs({ steps: [{ id: "a", type: "call", op: "fake_profile", args: { url: "x", extra: 1 } }] })[0], /has no input "extra"/);
  assert.match(errs({ steps: [{ id: "a", type: "call", op: "fake_profile", args: { url: { $expr: "steps.b.output" } } }, { id: "b", type: "call", op: "whoami" }] })[0], /"steps\.b" is not an earlier step/);
  assert.match(errs({ steps: [{ id: "a", type: "call", op: "fake_profile", args: { url: { $expr: "input.(" } } }] })[0], /Expected/);
  assert.match(errs({ steps: [{ id: "a", type: "if", cond: true }] })[0], /unknown step type "if"/);
  assert.match(errs({ steps: [{ id: "a", type: "call", op: "whoami" }, { id: "a", type: "call", op: "whoami" }] })[0], /used twice/);
  const loop = errs({ steps: [{ id: "l", type: "forEach", items: "x", as: "index", limit: 99, steps: [] }] });
  assert.equal(loop.length, 4, loop.join("\n")); // items, as, limit, empty body
  // a loop's inner steps are not visible after it
  assert.match(errs({
    steps: [{ id: "l", type: "forEach", items: { $expr: "[1]" }, as: "x", limit: 1, steps: [{ id: "inner", type: "call", op: "whoami" }] }],
    output: { $expr: "steps.inner.output" },
  })[0], /"steps\.inner" is not an earlier step/);
});

test("tools can call tools, but not in a loop", () => {
  assert.ok(ops.publish("find_and_read").ok || true);
  tool("wrapper", { steps: [{ id: "w", type: "call", op: "find_and_read", args: { keywords: { $expr: "input.keywords" } } }] });
  assert.ok(ops.publish("wrapper").ok);
  // find_and_read -> wrapper -> find_and_read
  const errors = tool("find_and_read", { ...findAndRead, steps: [...findAndRead.steps, { id: "again", type: "call", op: "wrapper", args: { keywords: "x" } }] }).errors;
  assert.ok(errors.some((e) => /loop: find_and_read -> wrapper -> find_and_read/.test(e)), errors.join("\n"));
  ops.removeOp("find_and_read", { draftOnly: true });
});

test("a tool calling a tool runs with nested trace paths", async () => {
  const events: string[] = [];
  await ops.runTopLevel("wrapper", { keywords: "y" }, { loopCap: 1, onTrace: (e) => events.push(`${e.op}@${e.path}`) });
  assert.deepEqual(events, ["fake_search@w/found", "fake_profile@w/profiles[0]/p", "find_and_read@w", "wrapper@"]);
});

test("cost preflight refuses a run that would exceed today's caps", async () => {
  tool("too_big", {
    steps: [{ id: "each", type: "forEach", items: { $expr: "[1..25]" }, as: "i", limit: 25, steps: [
      { id: "a", type: "call", op: "fake_search", args: { keywords: "x" } },
      { id: "b", type: "call", op: "fake_search", args: { keywords: "y" } },
    ] }],
  }, { type: "object", properties: {} });
  assert.ok(ops.publish("too_big").ok);
  await assert.rejects(ops.runTopLevel("too_big", {}), /Would exceed today's cap for "search" \(needs 50/);
});
