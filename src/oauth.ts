import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DATA_DIR } from "./vault.js";
import { readJson, writeJsonAtomic } from "./store.js";
import { clientIp, isLimited, normalizeToken, recordFailure, setAccessTokenVerifier, tokenMatches, type Principal } from "./auth.js";

// A minimal OAuth 2.1 authorization server for MCP clients that cannot send a static header
// (claude.ai and ChatGPT connectors). The owner signs in by typing the same four-word token; the
// client then gets its own access and refresh tokens, bound to this server's /mcp URL.
// Follows the MCP authorization spec: RFC 9728 resource metadata, RFC 8414 server metadata,
// PKCE S256, RFC 8707 resource indicators, RFC 9207 `iss`, dynamic registration (RFC 7591) and
// client ID metadata documents.

const STORE = `${DATA_DIR}/oauth.json`;
const CODE_TTL = 5 * 60_000;
const ACCESS_TTL = 7 * 24 * 3600_000; // long, so a client rarely meets an expired token mid-chat
const REFRESH_TTL = 180 * 24 * 3600_000;
const REFRESH_GRACE = 60_000; // a client that retries a refresh within this window gets the same new pair
const MAX_CLIENTS = 200;
const SCOPES = ["mcp", "offline_access"];

type Client = { client_id: string; client_name?: string; redirect_uris: string[]; created_at: string };
type Code = { client_id: string; redirect_uri: string; code_challenge: string; scope: string; resource: string; expires: number; epoch: string };
type Token = { kind: "access" | "refresh"; client_id: string; scope: string; resource: string; expires: number; epoch: string; rotated?: number };
type Store = { clients: Record<string, Client>; codes: Record<string, Code>; tokens: Record<string, Token> };

const hash = (s: string) => createHash("sha256").update(s).digest("base64url");
const random = () => randomBytes(32).toString("base64url");
// Tokens issued under an older API token stop working when it is replaced.
const epoch = () => hash(`epoch:${normalizeToken(process.env.LINKEDBOT_API_TOKEN ?? "")}`).slice(0, 16);

function load(): Store {
  return readJson<Store>(STORE, { clients: {}, codes: {}, tokens: {} });
}

function save(s: Store): void {
  const now = Date.now();
  for (const [k, c] of Object.entries(s.codes)) if (c.expires < now) delete s.codes[k];
  for (const [k, t] of Object.entries(s.tokens)) if (t.expires < now || t.epoch !== epoch() || (t.rotated && t.rotated + REFRESH_GRACE < now)) delete s.tokens[k];
  const dcr = Object.values(s.clients).filter((c) => !c.client_id.startsWith("https://")).sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const c of dcr.slice(0, Math.max(0, dcr.length - MAX_CLIENTS))) delete s.clients[c.client_id];
  writeJsonAtomic(STORE, s);
}

// Successor pairs handed out by a refresh, kept briefly in memory so a retried refresh gets the same answer.
const recentRefreshes = new Map<string, { body: Record<string, unknown>; until: number }>();

export function publicOrigin(req: IncomingMessage): string {
  if (process.env.LINKEDBOT_PUBLIC_URL) return process.env.LINKEDBOT_PUBLIC_URL.replace(/\/$/, "");
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0].trim();
  return `${proto}://${req.headers.host}`;
}
export const mcpResource = (req: IncomingMessage) => `${publicOrigin(req)}/mcp`;

export function verifyAccessToken(token: string, resource: string): Principal | null {
  const t = load().tokens[hash(token)];
  if (!t || t.kind !== "access" || t.expires < Date.now() || t.epoch !== epoch() || t.resource !== resource) return null;
  return { via: "oauth", clientId: t.client_id };
}

setAccessTokenVerifier(verifyAccessToken);

export function challengeHeader(req: IncomingMessage, invalid: boolean): string {
  const meta = `${publicOrigin(req)}/.well-known/oauth-protected-resource/mcp`;
  return `Bearer resource_metadata="${meta}", scope="mcp"${invalid ? ', error="invalid_token"' : ""}`;
}

// ---------- redirect URIs and clients ----------

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BAD_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "ftp:", "ws:", "wss:"]);

export function redirectUriAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  return !BAD_SCHEMES.has(u.protocol); // private-use schemes of native apps, e.g. cursor://
}

// Exact match, except that a loopback redirect may use any port (RFC 8252 section 7.3).
export function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered), b = new URL(requested);
    return a.protocol === "http:" && b.protocol === "http:" && LOOPBACK.has(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

const cimdCache = new Map<string, { client: Client; until: number }>();

async function assertPublicHost(host: string): Promise<void> {
  if (isIP(host) || LOOPBACK.has(host) || /\.(local|internal|localhost)$/i.test(host)) throw new Error("client metadata host is not public");
  for (const { address } of await lookup(host, { all: true })) {
    if (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|f[cd]|fe80:)/i.test(address)) throw new Error("client metadata host resolves to a private address");
  }
}

// Client ID metadata document: the client_id is an https URL serving the client's own description.
async function fetchClientMetadata(url: string): Promise<Client> {
  const hit = cimdCache.get(url);
  if (hit && hit.until > Date.now()) return hit.client;
  const u = new URL(url);
  if (u.protocol !== "https:" || u.port || u.hash || u.username) throw new Error("client_id URL must be plain https");
  await assertPublicHost(u.hostname);
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`client metadata answered ${res.status}`);
  const body = await res.text();
  if (body.length > 64_000) throw new Error("client metadata is too large");
  const doc = JSON.parse(body);
  if (doc.client_id !== url) throw new Error("client metadata client_id does not match its URL");
  const redirect_uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((r: unknown) => typeof r === "string" && redirectUriAllowed(r)) : [];
  if (!redirect_uris.length) throw new Error("client metadata has no usable redirect_uris");
  const client: Client = { client_id: url, client_name: typeof doc.client_name === "string" ? doc.client_name.slice(0, 100) : undefined, redirect_uris, created_at: new Date().toISOString() };
  cimdCache.set(url, { client, until: Date.now() + 3600_000 });
  return client;
}

async function findClient(clientId: string): Promise<Client | undefined> {
  if (clientId.startsWith("https://")) return fetchClientMetadata(clientId).catch((e) => (console.warn(`oauth: ${clientId}: ${(e as Error).message}`), undefined));
  return load().clients[clientId];
}

// ---------- HTTP helpers ----------

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version" };

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...cors, ...extra }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new Error("Body too large");
  }
  if (String(req.headers["content-type"] ?? "").includes("application/json")) return raw ? JSON.parse(raw) : {};
  return Object.fromEntries(new URLSearchParams(raw));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type AuthorizeParams = { client: Client; redirect_uri: string; code_challenge: string; state?: string; scope: string; resource: string };

// Validates everything that decides where the browser may be sent. Until this passes, errors are shown
// on our own page: redirecting to an unverified URI would make this an open redirector.
async function checkAuthorize(req: IncomingMessage, p: Record<string, string>): Promise<{ ok: true; v: AuthorizeParams } | { ok: false; page: string } | { ok: false; redirect: string }> {
  const client = p.client_id ? await findClient(p.client_id) : undefined;
  if (!client) return { ok: false, page: "This app is not registered with linkedbot. Remove the connector and add it again." };
  const redirect_uri = p.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
  if (!redirect_uri || !client.redirect_uris.some((r) => redirectMatches(r, redirect_uri))) return { ok: false, page: "The app asked to return to an address it did not register." };
  const back = (error: string, description: string) => {
    const u = new URL(redirect_uri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (p.state) u.searchParams.set("state", p.state);
    u.searchParams.set("iss", publicOrigin(req));
    return { ok: false as const, redirect: u.href };
  };
  if (p.response_type !== "code") return back("unsupported_response_type", "response_type must be code");
  if (!p.code_challenge || p.code_challenge_method !== "S256") return back("invalid_request", "PKCE with S256 is required");
  if (p.resource && p.resource.replace(/\/$/, "") !== mcpResource(req)) return back("invalid_target", `resource must be ${mcpResource(req)}`);
  const requested = (p.scope ?? "mcp").split(/\s+/).filter(Boolean);
  const scope = [...new Set(["mcp", ...requested.filter((s) => SCOPES.includes(s))])].join(" ");
  return { ok: true, v: { client, redirect_uri, code_challenge: p.code_challenge, state: p.state, scope, resource: mcpResource(req) } };
}

function consentPage(req: IncomingMessage, p: Record<string, string>, v: AuthorizeParams, error?: string): string {
  const host = new URL(v.redirect_uri).host || v.redirect_uri;
  const name = v.client.client_name ? `${esc(v.client.client_name)} <span class=m>(${esc(host)})</span>` : esc(host);
  const hidden = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope", "resource"]
    .filter((k) => p[k] !== undefined)
    .map((k) => `<input type=hidden name=${k} value="${esc(p[k])}">`)
    .join("");
  return page(
    "Connect to linkedbot",
    `<h1>Connect ${name}?</h1>
<p>It will be able to use your linkedbot tools: read LinkedIn pages and your saved leads with your account, within the daily caps. It cannot post, connect or message.</p>
<form method=post action="${publicOrigin(req)}/oauth/authorize">${hidden}
<label for=t>Your four-word token</label>
<div class=pw><input id=t name=token type=password autocomplete=current-password autocapitalize=off autocorrect=off spellcheck=false required autofocus${error ? ' aria-invalid=true aria-describedby=e' : ""}>
<button type=button class=sec aria-controls=t aria-pressed=false onclick="var i=document.getElementById('t'),s=i.type==='password';i.type=s?'text':'password';this.textContent=s?'Hide':'Show';this.setAttribute('aria-pressed',s)">Show</button></div>
${error ? `<p id=e class=err role=alert>${esc(error)}</p>` : ""}
<div class=row><button name=decision value=allow>Allow</button><button name=decision value=deny class=sec formnovalidate>Deny</button></div>
</form>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark;--bg:oklch(97.8% .006 60);--fg:oklch(25% .015 50);--mute:oklch(45% .015 50);--line:oklch(88.5% .01 60);--acc:oklch(56% .14 40);--on:oklch(98.5% .01 60);--err:oklch(52% .17 28)}
@media (prefers-color-scheme:dark){:root{--bg:oklch(18.5% .01 50);--fg:oklch(94% .008 60);--mute:oklch(77% .012 60);--line:oklch(34% .014 50);--acc:oklch(72% .12 40);--on:oklch(20% .03 40);--err:oklch(74% .14 28)}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}main{max-width:26rem;margin:0 auto;padding:3rem 1rem}
h1{font-size:1.375rem;line-height:1.3;margin:0 0 .75rem}.m{color:var(--mute);font-weight:400}p{margin:0 0 1.5rem}label{display:block;font-weight:600;margin-bottom:.375rem}
.pw{display:flex;gap:.5rem}.pw input{flex:1;min-width:0}.pw button{padding:.75rem 1rem}
input#t{box-sizing:border-box;width:100%;font:inherit;padding:.75rem;border:1px solid var(--line);border-radius:.5rem;background:transparent;color:inherit}
input:focus-visible,button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}.err{color:var(--err);margin:.5rem 0 0}
.row{display:flex;gap:.75rem;margin-top:1.5rem}button{font:inherit;font-weight:600;padding:.75rem 1.25rem;border-radius:.5rem;border:1px solid var(--acc);background:var(--acc);color:var(--on);cursor:pointer}
button.sec{background:transparent;color:var(--fg);border-color:var(--line)}</style><main>${body}</main></html>`;
}

function sendPage(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'", "referrer-policy": "no-referrer" }).end(html);
}

function issueTokens(s: Store, client_id: string, scope: string, resource: string) {
  const access = random(), refresh = random(), e = epoch(), now = Date.now();
  s.tokens[hash(access)] = { kind: "access", client_id, scope, resource, expires: now + ACCESS_TTL, epoch: e };
  s.tokens[hash(refresh)] = { kind: "refresh", client_id, scope, resource, expires: now + REFRESH_TTL, epoch: e };
  return { access_token: access, token_type: "Bearer", expires_in: Math.floor(ACCESS_TTL / 1000), refresh_token: refresh, scope };
}

const tokenError = (res: ServerResponse, error: string, description: string) => sendJson(res, 400, { error, error_description: description });

// ---------- routes ----------

export async function handleOAuth(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const origin = publicOrigin(req);
  if (req.method === "OPTIONS" && (pathname.startsWith("/.well-known/") || pathname.startsWith("/oauth/"))) {
    res.writeHead(204, { ...cors, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-max-age": "86400" }).end();
    return true;
  }

  if (req.method === "GET" && (pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp")) {
    sendJson(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["mcp"], bearer_methods_supported: ["header"], resource_name: "linkedbot" });
    return true;
  }

  if (req.method === "GET" && (pathname === "/.well-known/oauth-authorization-server" || pathname === "/.well-known/oauth-authorization-server/mcp")) {
    sendJson(res, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: SCOPES,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/oauth/register") {
    let body: Record<string, any>;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "invalid_client_metadata", error_description: "body must be JSON" });
      return true;
    }
    const uris: unknown = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && redirectUriAllowed(u))) {
      sendJson(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uris must be https, loopback http, or an app scheme" });
      return true;
    }
    const client: Client = { client_id: `c_${randomBytes(16).toString("hex")}`, client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 100) : undefined, redirect_uris: uris as string[], created_at: new Date().toISOString() };
    const s = load();
    s.clients[client.client_id] = client;
    save(s);
    sendJson(res, 201, {
      ...client,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: body.application_type === "native" ? "native" : "web",
    });
    return true;
  }

  if (pathname === "/oauth/authorize" && (req.method === "GET" || req.method === "POST")) {
    const p = req.method === "GET" ? Object.fromEntries(new URL(req.url ?? "", "http://x").searchParams) : await readBody(req);
    const checked = await checkAuthorize(req, p);
    if (!checked.ok) {
      if ("redirect" in checked) res.writeHead(302, { location: checked.redirect, "cache-control": "no-store" }).end();
      else sendPage(res, 400, page("Can't connect", `<h1>Can't connect</h1><p>${esc(checked.page)}</p>`));
      return true;
    }
    const v = checked.v;
    if (req.method === "GET") {
      sendPage(res, 200, consentPage(req, p, v));
      return true;
    }
    const back = new URL(v.redirect_uri);
    if (v.state) back.searchParams.set("state", v.state);
    back.searchParams.set("iss", origin);
    if (p.decision === "deny") {
      back.searchParams.set("error", "access_denied");
      res.writeHead(302, { location: back.href, "cache-control": "no-store" }).end();
      return true;
    }
    const ip = clientIp(req);
    if (isLimited(ip)) {
      sendPage(res, 429, consentPage(req, p, v, "Too many attempts. Try again in a minute."));
      return true;
    }
    if (!tokenMatches(p.token ?? "")) {
      recordFailure(ip);
      sendPage(res, 401, consentPage(req, p, v, "That token doesn't match."));
      return true;
    }
    const code = random();
    const s = load();
    s.codes[hash(code)] = { client_id: v.client.client_id, redirect_uri: v.redirect_uri, code_challenge: v.code_challenge, scope: v.scope, resource: v.resource, expires: Date.now() + CODE_TTL, epoch: epoch() };
    save(s);
    back.searchParams.set("code", code);
    res.writeHead(302, { location: back.href, "cache-control": "no-store" }).end();
    return true;
  }

  if (req.method === "POST" && pathname === "/oauth/token") {
    let p: Record<string, string>;
    try {
      p = await readBody(req);
    } catch {
      tokenError(res, "invalid_request", "unreadable body");
      return true;
    }
    const s = load();
    if (p.grant_type === "authorization_code") {
      const key = hash(p.code ?? "");
      const c = s.codes[key];
      if (!c || c.expires < Date.now() || c.epoch !== epoch()) return void tokenError(res, "invalid_grant", "code is invalid or expired"), true;
      delete s.codes[key]; // single use, whatever happens next
      save(s);
      if (c.client_id !== p.client_id) return void tokenError(res, "invalid_grant", "code was issued to another client"), true;
      if (p.redirect_uri && p.redirect_uri !== c.redirect_uri) return void tokenError(res, "invalid_grant", "redirect_uri does not match"), true;
      if (!p.code_verifier || createHash("sha256").update(p.code_verifier).digest("base64url") !== c.code_challenge) return void tokenError(res, "invalid_grant", "PKCE verification failed"), true;
      if (p.resource && p.resource.replace(/\/$/, "") !== c.resource) return void tokenError(res, "invalid_target", "resource does not match"), true;
      const body = issueTokens(s, c.client_id, c.scope, c.resource);
      save(s);
      sendJson(res, 200, body, { pragma: "no-cache" });
      return true;
    }
    if (p.grant_type === "refresh_token") {
      const key = hash(p.refresh_token ?? "");
      const t = s.tokens[key];
      const replay = recentRefreshes.get(key);
      if (t?.rotated && replay && replay.until > Date.now() && t.client_id === p.client_id) return void sendJson(res, 200, replay.body, { pragma: "no-cache" }), true;
      if (!t || t.kind !== "refresh" || t.rotated || t.expires < Date.now() || t.epoch !== epoch()) return void tokenError(res, "invalid_grant", "refresh token is invalid or expired"), true;
      if (t.client_id !== p.client_id) return void tokenError(res, "invalid_grant", "refresh token was issued to another client"), true;
      t.rotated = Date.now();
      const body = issueTokens(s, t.client_id, t.scope, t.resource);
      save(s);
      recentRefreshes.set(key, { body, until: Date.now() + REFRESH_GRACE });
      sendJson(res, 200, body, { pragma: "no-cache" });
      return true;
    }
    tokenError(res, "unsupported_grant_type", "use authorization_code or refresh_token");
    return true;
  }
  return false;
}
