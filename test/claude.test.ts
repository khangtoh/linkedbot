import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { listen, useTempDataDir } from "./helpers.js";
import { startServer, TOKEN } from "./server.js";

// A stand-in for the Claude API with a key that is not scoped to a workspace: a request without
// anthropic-workspace-id is refused, Fable is "not available to this key", everything else answers.
const seen: any[] = [];
let fake: Awaited<ReturnType<typeof listen>>;
let keyed: Awaited<ReturnType<typeof startServer>>;
let keyless: Awaited<ReturnType<typeof startServer>>;
let noWorkspace: Awaited<ReturnType<typeof startServer>>;

before(async () => {
  fake = await listen(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    seen.push({ path: req.url, key: req.headers["x-api-key"], workspace: req.headers["anthropic-workspace-id"], body });
    if (!req.headers["anthropic-workspace-id"]) {
      const message = "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.";
      return void res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
    }
    if (body.model === "claude-fable-5-1") {
      return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model not found" } }));
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 14, output_tokens: 3 } }),
    );
  });
  const key = { ANTHROPIC_API_KEY: "sk-ant-test-key-ending-WXYZ", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: fake.base, LINKEDBOT_MODEL: "" };
  [keyed, keyless, noWorkspace] = await Promise.all([
    startServer(useTempDataDir(), { ...key, ANTHROPIC_WORKSPACE_ID: "wrkspc_test" }),
    startServer(useTempDataDir(), { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: fake.base }),
    startServer(useTempDataDir(), { ...key, ANTHROPIC_WORKSPACE_ID: "" }),
  ]);
});
after(() => Promise.all([keyed?.stop(), keyless?.stop(), noWorkspace?.stop(), fake?.close()]));

const call = (s: { base: string }, method: string, path: string, body?: unknown) =>
  fetch(`${s.base}/api${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("settings show whether a key is set, without revealing it", async () => {
  const on = (await call(keyed, "GET", "/claude")).body;
  assert.equal(on.configured, true);
  assert.equal(on.source, "ANTHROPIC_API_KEY");
  assert.equal(on.keyHint, "sk-ant-…WXYZ");
  assert.equal(on.workspace, "wrkspc_test");
  assert.doesNotMatch(JSON.stringify(on), /test-key/);
  assert.deepEqual(on.features.agent, { model: "claude-sonnet-5-5", default: "claude-sonnet-5-5", chosen: false });
  assert.deepEqual(on.features.generator, { model: "claude-opus-5-5", default: "claude-opus-5-5", chosen: false });
  assert.ok(on.models.some((m: any) => m.id === "claude-haiku-5-5"));

  const off = (await call(keyless, "GET", "/claude")).body;
  assert.equal(off.configured, false);
  assert.equal(off.keyHint, null);
});

test("a chosen model is saved, validated, and can be put back to the default", async () => {
  let r = await call(keyed, "PUT", "/claude", { agent: "claude-haiku-5-5" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.features.agent, { model: "claude-haiku-5-5", default: "claude-sonnet-5-5", chosen: true });
  assert.equal((await call(keyed, "GET", "/claude")).body.features.agent.model, "claude-haiku-5-5");

  r = await call(keyed, "PUT", "/claude", { generator: "gpt-4" });
  assert.equal(r.status, 400);

  r = await call(keyed, "PUT", "/claude", { agent: null });
  assert.equal(r.body.features.agent.chosen, false);
  assert.equal(r.body.features.agent.model, "claude-sonnet-5-5");
});

test("the connection test sends one tiny request and explains failures", async () => {
  seen.length = 0;
  let r = await call(keyed, "POST", "/claude/test", {});
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.model, "claude-sonnet-5-5");
  assert.equal(r.body.reply, "ok");
  assert.equal(r.body.tokens, 17);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, "/v1/messages");
  assert.equal(seen[0].key, "sk-ant-test-key-ending-WXYZ");
  assert.equal(seen[0].workspace, "wrkspc_test");
  assert.equal(seen[0].body.max_tokens, 64);
  assert.deepEqual(seen[0].body.output_config, { effort: "low" });

  r = await call(keyed, "POST", "/claude/test", { model: "claude-fable-5-1" });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /can't use Claude Fable 5\.1/);

  assert.equal((await call(keyed, "POST", "/claude/test", { model: "nope" })).status, 400);

  r = await call(noWorkspace, "POST", "/claude/test", {});
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /isn't scoped to a workspace\. Set ANTHROPIC_WORKSPACE_ID/);

  seen.length = 0;
  r = await call(keyless, "POST", "/claude/test", {});
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /No API key/);
  assert.equal(seen.length, 0);
});
