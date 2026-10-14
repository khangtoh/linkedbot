import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { useTempDataDir } from "./helpers.js";
import { startServer, TOKEN } from "./server.js";

const dir = useTempDataDir();
let server: Awaited<ReturnType<typeof startServer>>;
before(async () => (server = await startServer(dir)));
after(() => server.stop());

async function connect(token = TOKEN): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

const textOf = (r: any) => r.content.map((c: any) => c.text).join("");

test("lists the published operations plus the meta tools, not the agent", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["define_tool", "get_job", "list_leads", "list_operations", "remove_tool", "run_operation", "search_people", "view_profile", "whoami"]);
  const search = tools.find((t) => t.name === "search_people")!;
  assert.deepEqual(search.inputSchema.required, ["keywords"]);
  assert.equal(search.annotations?.readOnlyHint, true);
  await client.close();
});

test("calls an operation through the job queue", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "list_leads", arguments: {} });
  assert.equal(res.isError, undefined);
  assert.deepEqual(JSON.parse(textOf(res)), []);
  const status = await fetch(`${server.base}/status`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());
  assert.equal(status.jobs.at(-1).cmd, "list_leads");
  await client.close();
});

test("errors come back as tool errors, not protocol errors", async () => {
  const client = await connect();
  const noSession = await client.callTool({ name: "whoami", arguments: {} });
  assert.equal(noSession.isError, true);
  assert.match(textOf(noSession), /No saved LinkedIn session/);

  const bad = await client.callTool({ name: "run_operation", arguments: { name: "search_people", input: { keywords: "x", pages: 9 } } });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /pages must be <= 5/);

  const unknown = await client.callTool({ name: "run_operation", arguments: { name: "agent", input: { task: "x" } } });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /Unknown operation "agent"/);
  await client.close();
});

test("list_operations and get_job", async () => {
  const client = await connect();
  const ops = JSON.parse(textOf(await client.callTool({ name: "list_operations", arguments: {} })));
  assert.ok(ops.operations.some((o: any) => o.name === "search_people"));
  const missing = await client.callTool({ name: "get_job", arguments: { job_id: "nope", wait_seconds: 0 } });
  assert.equal(missing.isError, true);
  await client.close();
});

test("a wrong token is refused before MCP is reached", async () => {
  await assert.rejects(connect("wrong-words-here-now"));
  const res = await fetch(`${server.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
});

test("a 2025-era client (SDK v1) is served statelessly", async () => {
  const client = new LegacyClient({ name: "legacy", version: "1.0.0" });
  await client.connect(new LegacyTransport(new URL(`${server.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  assert.match(client.getServerVersion()?.name ?? "", /linkedbot/);
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === "search_people"));
  const res = await client.callTool({ name: "list_leads", arguments: { limit: 1 } });
  assert.deepEqual(JSON.parse((res.content as any)[0].text), []);
  await client.close();
});

test("define_tool creates a chained tool that is callable at once and listed on reload", async () => {
  const client = await connect();
  const def = {
    name: "lead_digest",
    description: "Count stored leads and return the first few.",
    inputSchema: { type: "object", properties: { n: { type: "integer", default: 2 } } },
    steps: [{ id: "all", type: "call", op: "list_leads", args: { limit: { $expr: "input.n" } } }],
    output: { $expr: "{ 'count': $count(steps.all.output), 'first': steps.all.output }" },
  };
  const bad = await client.callTool({ name: "define_tool", arguments: { ...def, steps: [{ id: "x", type: "call", op: "nope" }] } });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /no published operation "nope"/);

  const ok = await client.callTool({ name: "define_tool", arguments: def });
  assert.equal(ok.isError, undefined, textOf(ok));
  assert.equal(JSON.parse(textOf(ok)).published, "lead_digest");

  const run = await client.callTool({ name: "run_operation", arguments: { name: "lead_digest", input: { n: 3 } } });
  assert.deepEqual(JSON.parse(textOf(run)), { count: 0, first: [] });
  await client.close();

  const fresh = await connect();
  assert.ok((await fresh.listTools()).tools.some((t) => t.name === "lead_digest"));
  const direct = await fresh.callTool({ name: "lead_digest", arguments: {} });
  assert.deepEqual(JSON.parse(textOf(direct)), { count: 0, first: [] });
  assert.equal((await fresh.callTool({ name: "remove_tool", arguments: { name: "whoami" } })).isError, true);
  assert.deepEqual(JSON.parse(textOf(await fresh.callTool({ name: "remove_tool", arguments: { name: "lead_digest" } }))), { removed: "lead_digest" });
  await fresh.close();
});

test("HTTP: save a draft, publish it, delete it", async () => {
  const h = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const def = { kind: "tool", name: "http_tool", description: "d", inputSchema: { type: "object" }, steps: [{ id: "a", type: "call", op: "list_leads" }] };
  const saved = await fetch(`${server.base}/api/ops`, { method: "POST", headers: h, body: JSON.stringify(def) }).then((r) => r.json());
  assert.deepEqual(saved.errors, []);
  assert.equal((await fetch(`${server.base}/api/ops/http_tool`, { headers: h })).status, 404); // drafts are not published
  assert.equal((await fetch(`${server.base}/api/ops/http_tool?draft`, { headers: h })).status, 200);
  assert.equal((await fetch(`${server.base}/api/ops/http_tool/publish`, { method: "POST", headers: h })).status, 200);
  assert.equal((await fetch(`${server.base}/api/ops/http_tool`, { headers: h }).then((r) => r.json())).version, 1);
  assert.equal((await fetch(`${server.base}/api/ops`, { method: "POST", headers: h, body: JSON.stringify({ ...def, name: "whoami" }) })).status, 409);
  assert.equal((await fetch(`${server.base}/api/ops/http_tool`, { method: "DELETE", headers: h })).status, 200);
});
