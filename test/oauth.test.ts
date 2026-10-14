import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { useTempDataDir } from "./helpers.js";
import { startServer, TOKEN } from "./server.js";

const dir = useTempDataDir();
let server: Awaited<ReturnType<typeof startServer>>;
before(async () => (server = await startServer(dir)));
after(() => server.stop());

const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString(), redirect: "manual" as const });

async function register(redirect_uris = [CLAUDE], client_name = "Claude") {
  const res = await fetch(`${server.base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris, client_name, token_endpoint_auth_method: "none" }) });
  assert.equal(res.status, 201);
  return (await res.json()).client_id as string;
}

function authorizeParams(client_id: string, challenge: string, redirect_uri = CLAUDE) {
  return { response_type: "code", client_id, redirect_uri, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "mcp offline_access", resource: `${server.base}/mcp` };
}

async function signIn(client_id: string, redirect_uri = CLAUDE, token = "Apple Banana Cherry Delta") {
  const { verifier, challenge } = pkce();
  const res = await fetch(`${server.base}/oauth/authorize`, form({ ...authorizeParams(client_id, challenge, redirect_uri), decision: "allow", token }));
  return { res, verifier };
}

async function exchange(client_id: string, code: string, verifier: string, redirect_uri = CLAUDE) {
  return fetch(`${server.base}/oauth/token`, form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri, resource: `${server.base}/mcp` }));
}

test("an unauthenticated /mcp call points to the resource metadata", async () => {
  const res = await fetch(`${server.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), `Bearer resource_metadata="${server.base}/.well-known/oauth-protected-resource/mcp", scope="mcp"`);
  const prm = await fetch(`${server.base}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json());
  assert.deepEqual(prm.resource, `${server.base}/mcp`);
  assert.deepEqual(prm.authorization_servers, [server.base]);
  const as = await fetch(`${server.base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  assert.equal(as.issuer, server.base);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
});

test("the consent page names the app and its return address", async () => {
  const id = await register();
  const html = await fetch(`${server.base}/oauth/authorize?${new URLSearchParams(authorizeParams(id, pkce().challenge))}`).then((r) => r.text());
  assert.match(html, /Connect Claude <span class=m>\(claude\.ai\)<\/span>\?/);
  assert.match(html, /type=password/);
});

test("full flow: register, sign in with the token, exchange, call MCP, refresh", async () => {
  const id = await register();
  const { res, verifier } = await signIn(id);
  assert.equal(res.status, 302);
  const back = new URL(res.headers.get("location")!);
  assert.equal(`${back.origin}${back.pathname}`, CLAUDE);
  assert.equal(back.searchParams.get("state"), "xyz");
  assert.equal(back.searchParams.get("iss"), server.base);
  const code = back.searchParams.get("code")!;

  const tokens = await exchange(id, code, verifier).then((r) => r.json());
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.scope, "mcp offline_access");
  assert.ok(tokens.access_token && tokens.refresh_token);

  // the code works once
  assert.equal((await exchange(id, code, verifier).then((r) => r.json())).error, "invalid_grant");

  const client = new Client({ name: "oauth-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
  assert.ok((await client.listTools()).tools.some((t) => t.name === "whoami"));
  await client.close();

  // an access token is only good for /mcp
  assert.equal((await fetch(`${server.base}/status`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).status, 401);

  const refresh = () => fetch(`${server.base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: id })).then((r) => r.json());
  const first = await refresh();
  assert.ok(first.access_token && first.refresh_token !== tokens.refresh_token);
  assert.deepEqual(await refresh(), first); // a retried refresh gets the same pair
});

test("wrong token, deny, PKCE and client mismatches are refused", async () => {
  const id = await register();
  const wrong = await signIn(id, CLAUDE, "wrong words entirely here");
  assert.equal(wrong.res.status, 401);
  assert.match(await wrong.res.text(), /That token doesn&#39;t match/);

  const { challenge } = pkce();
  const deny = await fetch(`${server.base}/oauth/authorize`, form({ ...authorizeParams(id, challenge), decision: "deny" }));
  const back = new URL(deny.headers.get("location")!);
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("iss"), server.base);

  const { res, verifier } = await signIn(id);
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  assert.equal((await exchange(id, code, verifier + "x").then((r) => r.json())).error, "invalid_grant");

  const other = await register();
  const second = await signIn(id);
  const code2 = new URL(second.res.headers.get("location")!).searchParams.get("code")!;
  assert.equal((await exchange(other, code2, second.verifier).then((r) => r.json())).error, "invalid_grant");
});

test("an unregistered return address is never redirected to", async () => {
  const id = await register();
  const res = await fetch(`${server.base}/oauth/authorize?${new URLSearchParams(authorizeParams(id, pkce().challenge, "https://evil.example/cb"))}`, { redirect: "manual" });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("location"), null);
  const bad = await fetch(`${server.base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }) });
  assert.equal(bad.status, 400);
  const http = await fetch(`${server.base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
  assert.equal(http.status, 400);
});

test("loopback redirects match on any port (desktop clients)", async () => {
  const id = await register(["http://localhost/callback"], "Claude Code");
  const { res } = await signIn(id, "http://localhost:53682/callback");
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location")!, /^http:\/\/localhost:53682\/callback\?/);
});

test("replacing the API token disconnects OAuth clients", async () => {
  const id = await register();
  const { res, verifier } = await signIn(id);
  const tokens = await exchange(id, new URL(res.headers.get("location")!).searchParams.get("code")!, verifier).then((r) => r.json());
  const mcp = (base: string, token: string) =>
    fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.notEqual((await mcp(server.base, tokens.access_token)).status, 401);

  await server.stop();
  server = await startServer(dir, { LINKEDBOT_API_TOKEN: "echo-foxtrot-golf-hotel-india" });
  const after = await mcp(server.base, tokens.access_token);
  assert.equal(after.status, 401);
  assert.match(after.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  const refreshed = await fetch(`${server.base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: id })).then((r) => r.json());
  assert.equal(refreshed.error, "invalid_grant");
  await server.stop();
  server = await startServer(dir);
});

void TOKEN;

// Uses the real client metadata documents Claude Code and ChatGPT publish, so it needs internet access.
test("client ID metadata documents from Claude Code and ChatGPT are accepted", async (t) => {
  const online = await fetch("https://claude.ai/oauth/claude-code-client-metadata", { signal: AbortSignal.timeout(10_000) }).then((r) => r.ok, () => false);
  if (!online) return t.skip("no internet access");
  const claudeCode = "https://claude.ai/oauth/claude-code-client-metadata";
  const page = await fetch(`${server.base}/oauth/authorize?${new URLSearchParams(authorizeParams(claudeCode, pkce().challenge, "http://localhost:41234/callback"))}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Connect Claude Code/);

  const { res, verifier } = await signIn(claudeCode, "http://127.0.0.1:41234/callback");
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  const tokens = await exchange(claudeCode, code, verifier, "http://127.0.0.1:41234/callback").then((r) => r.json());
  assert.ok(tokens.access_token);

  const chatgpt = await (await fetch("https://chatgpt.com/oauth/client.json")).json();
  const redirect = chatgpt.redirect_uris.find((u: string) => u.includes("connector_platform_oauth_redirect")) ?? chatgpt.redirect_uris[0];
  const gpt = await fetch(`${server.base}/oauth/authorize?${new URLSearchParams(authorizeParams(chatgpt.client_id, pkce().challenge, redirect))}`);
  assert.equal(gpt.status, 200, `ChatGPT redirect ${redirect}`);

  const spoofed = await fetch(`${server.base}/oauth/authorize?${new URLSearchParams(authorizeParams(claudeCode, pkce().challenge, CLAUDE))}`, { redirect: "manual" });
  assert.equal(spoofed.status, 400); // claude.ai's callback is not in Claude Code's document
});
