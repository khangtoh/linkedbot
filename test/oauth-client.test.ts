import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { useTempDataDir } from "./helpers.js";
import { startServer } from "./server.js";

// The reference MCP client (SDK v1) runs its own discovery, dynamic registration, PKCE and token
// exchange against the server. The test only plays the person in the browser.
const dir = useTempDataDir();
let server: Awaited<ReturnType<typeof startServer>>;
before(async () => (server = await startServer(dir)));
after(() => server.stop());

class Provider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = "";
  authorizationUrl?: URL;
  get redirectUrl() {
    return "http://localhost:33418/callback";
  }
  get clientMetadata() {
    return { client_name: "Reference client", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() { return this.info; }
  saveClientInformation(info: OAuthClientInformationMixed) { this.info = info; }
  tokens() { return this.saved; }
  saveTokens(t: OAuthTokens) { this.saved = t; }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
}

// What the owner does in the browser: open the page, type the token, press Allow.
async function approveInBrowser(url: URL, token: string): Promise<URL> {
  assert.equal((await fetch(url)).status, 200);
  const body = new URLSearchParams({ ...Object.fromEntries(url.searchParams), decision: "allow", token });
  const res = await fetch(`${url.origin}${url.pathname}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, redirect: "manual" });
  assert.equal(res.status, 302);
  return new URL(res.headers.get("location")!);
}

test("the reference client discovers, registers, signs in and connects", async () => {
  const provider = new Provider();
  const url = new URL(`${server.base}/mcp`);
  const first = new StreamableHTTPClientTransport(url, { authProvider: provider });
  await assert.rejects(new Client({ name: "ref", version: "1" }).connect(first), UnauthorizedError);
  assert.ok(provider.info?.client_id, "registered dynamically");
  assert.ok(provider.authorizationUrl);
  assert.equal(provider.authorizationUrl!.searchParams.get("resource"), `${server.base}/mcp`);
  assert.equal(provider.authorizationUrl!.searchParams.get("code_challenge_method"), "S256");

  const back = await approveInBrowser(provider.authorizationUrl!, "apple banana cherry delta");
  assert.equal(back.searchParams.get("iss"), server.base);
  await first.finishAuth(back.searchParams.get("code")!);
  assert.ok(provider.saved?.access_token);

  const client = new Client({ name: "ref", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === "search_people"));
  const res = await client.callTool({ name: "list_leads", arguments: {} });
  assert.deepEqual(JSON.parse((res.content as any)[0].text), []);
  await client.close();
});
