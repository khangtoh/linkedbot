// Smoke test for a deployed linkedbot: health, auth, MCP over both protocol eras, OAuth discovery.
// Read-only: it touches no LinkedIn pages and leaves at most one registered OAuth client behind.
//   LINKEDBOT_API_TOKEN=... npx tsx scripts/smoke.ts https://<app-url>
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
const token = process.env.LINKEDBOT_API_TOKEN ?? "";
if (!base || !token) {
  console.error("usage: LINKEDBOT_API_TOKEN=... tsx scripts/smoke.ts https://<app-url>");
  process.exit(2);
}

let failed = 0;
async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const note = await fn();
    console.log(`  ok    ${name}${note ? `: ${note}` : ""}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}: ${(e as Error).message}`);
  }
}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const auth = { authorization: `Bearer ${token}` };

await check("health (allows for a cold start)", async () => {
  for (let i = 0; i < 30; i++) {
    if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("no 200 from /healthz within 90s");
});

await check("API refuses a missing token and accepts the right one", async () => {
  expect((await fetch(`${base}/status`)).status === 401, "expected 401 without a token");
  const status = await fetch(`${base}/status`, { headers: auth });
  expect(status.ok, `status answered ${status.status}`);
  const s = await status.json();
  return `LinkedIn session ${s.session ? "saved" : "not saved yet"}, ${s.leads} leads`;
});

await check("studio is served", async () => {
  const page = await fetch(`${base}/studio/`);
  expect(page.ok, `/studio/ answered ${page.status}`);
  const asset = /\/studio\/assets\/[^"]+\.js/.exec(await page.text())?.[0];
  expect(asset, "no script in the studio page");
  expect((await fetch(`${base}${asset}`)).ok, `${asset} did not load`);
});

await check("MCP challenge and OAuth discovery", async () => {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(res.status === 401, `expected 401, got ${res.status}`);
  const challenge = res.headers.get("www-authenticate") ?? "";
  expect(challenge.includes(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`), `challenge points elsewhere: ${challenge}`);
  const prm = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json());
  expect(prm.resource === `${base}/mcp`, `resource is ${prm.resource}`);
  const as = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  expect(as.issuer === base, `issuer is ${as.issuer}`);
  const reg = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "smoke test", redirect_uris: ["http://localhost/callback"] }) });
  expect(reg.status === 201, `register answered ${reg.status}`);
  const { client_id } = await reg.json();
  const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "http://localhost:9/callback", code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: `${base}/mcp` });
  const page = await fetch(`${base}/oauth/authorize?${q}`);
  expect(page.status === 200 && (await page.text()).includes("four-word token"), `sign-in page answered ${page.status}`);
});

await check("MCP (2026 protocol) lists and calls tools", async () => {
  const client = new Client({ name: "smoke", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth } }));
  const { tools } = await client.listTools();
  expect(tools.some((t) => t.name === "whoami"), "whoami is not listed");
  const res = await client.callTool({ name: "list_leads", arguments: { limit: 1 } });
  expect(!res.isError, "list_leads failed");
  await client.close();
  return `${tools.length} tools`;
});

await check("MCP (2025 protocol) lists and calls tools", async () => {
  const client = new LegacyClient({ name: "smoke-legacy", version: "1" });
  await client.connect(new LegacyTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth } }));
  const { tools } = await client.listTools();
  const res = await client.callTool({ name: "list_leads", arguments: { limit: 1 } });
  expect(!res.isError, "list_leads failed");
  await client.close();
  return `${tools.length} tools`;
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
