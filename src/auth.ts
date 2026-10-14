import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

// Everything that can prove it is the owner goes through authenticate(): the HTTP API, /mcp and,
// later, the studio cookie and OAuth access tokens.
export type Principal = { via: "bearer" } | { via: "oauth"; clientId: string } | { via: "studio" };
export type AuthResult = { ok: true; principal: Principal } | { ok: false; status: 401 | 429 };

const TOKEN = process.env.LINKEDBOT_API_TOKEN ?? "";

export function assertTokenConfigured(): void {
  if (TOKEN.length < 24) throw new Error("Set LINKEDBOT_API_TOKEN (>=24 chars) to protect the HTTP API.");
}

// Four-word tokens match regardless of case or of spaces versus hyphens between the words.
export const normalizeToken = (s: string) => s.trim().toLowerCase().split(/[\s-]+/).filter(Boolean).join("-");
const digest = (s: string) => createHash("sha256").update(s).digest();

export function tokenMatches(candidate: string): boolean {
  return TOKEN.length > 0 && timingSafeEqual(digest(normalizeToken(candidate)), digest(normalizeToken(TOKEN)));
}

// Failed attempts are limited per client address. The rightmost X-Forwarded-For entry is the one the
// platform's proxy added, so a client cannot choose it.
const FAILURES_PER_MINUTE = 10;
const failures = new Map<string, number[]>();

export function clientIp(req: IncomingMessage): string {
  const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff.at(-1) ?? req.socket.remoteAddress ?? "unknown";
}

function recent(ip: string): number[] {
  const cutoff = Date.now() - 60_000;
  const list = (failures.get(ip) ?? []).filter((t) => t > cutoff);
  if (list.length) failures.set(ip, list);
  else failures.delete(ip);
  return list;
}

export const isLimited = (ip: string) => recent(ip).length >= FAILURES_PER_MINUTE;

export function recordFailure(ip: string): void {
  if (failures.size > 10_000) failures.clear();
  failures.set(ip, [...recent(ip), Date.now()]);
}

// OAuth access tokens are only accepted for the resource they were issued for (the /mcp endpoint),
// so the caller passes `resource` there. The verifier is set by oauth.ts.
let accessTokenVerifier: ((token: string, resource: string) => Principal | null) | undefined;
export const setAccessTokenVerifier = (fn: typeof accessTokenVerifier) => void (accessTokenVerifier = fn);

// ---------- studio session cookie ----------
// A signed, stateless cookie (the machine may stop at any time, so no session table). Its key is
// derived from the API token, so replacing the token signs every device out.
export const SESSION_COOKIE = "lb_session";
const SESSION_DAYS = 30;
const cookieKey = () => createHash("sha256").update(`studio-cookie:${normalizeToken(TOKEN)}`).digest();
const sign = (payload: string) => createHmac("sha256", cookieKey()).update(payload).digest("base64url");

export function sessionCookie(req: IncomingMessage): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 86400_000 })).toString("base64url");
  const secure = String(req.headers["x-forwarded-proto"] ?? "").startsWith("https") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}
export const clearedSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

function validSession(req: IncomingMessage): boolean {
  const raw = /(?:^|;\s*)lb_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  const [payload, sig] = raw?.split(".") ?? [];
  if (!payload || !sig || TOKEN.length === 0) return false;
  const expected = Buffer.from(sign(payload));
  if (expected.length !== sig.length || !timingSafeEqual(expected, Buffer.from(sig))) return false;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now();
  } catch {
    return false;
  }
}

// A cookie rides along with any request the browser makes, so a state-changing request authenticated
// by it must come from this site (SameSite=Strict already stops most of these).
function sameOrigin(req: IncomingMessage): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET")) return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function authenticate(req: IncomingMessage, opts: { resource?: string } = {}): AuthResult {
  const ip = clientIp(req);
  if (isLimited(ip)) return { ok: false, status: 429 };
  if (!opts.resource && !req.headers.authorization && validSession(req) && sameOrigin(req)) return { ok: true, principal: { via: "studio" } };
  const header = req.headers.authorization ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1];
  if (bearer && tokenMatches(bearer)) return { ok: true, principal: { via: "bearer" } };
  const viaOAuth = bearer && opts.resource && accessTokenVerifier?.(bearer, opts.resource);
  if (viaOAuth) return { ok: true, principal: viaOAuth };
  if (header) recordFailure(ip);
  return { ok: false, status: 401 };
}
