import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserContext, Request } from "playwright";
import { tripBreaker } from "./limits.js";
import { DATA_DIR } from "./vault.js";

// What a browser working on the user's behalf may do on LinkedIn. Read-only is enforced here, at the
// network layer, rather than by trusting which buttons a script clicks.
export type Policy = {
  hosts: RegExp; // hosts the guard watches
  schemes: string[]; // URL schemes a top-level page may use
  navHost: string; // the only host top-level pages may load from
  readPaths: string[]; // path prefixes a top-level page may load
  wallPaths: RegExp; // login wall / checkpoint: loading one pauses all LinkedIn work
  allowWrites: { method: string; path: RegExp }[]; // non-GET requests let through when enforcing
};

export const LINKEDIN_POLICY: Policy = {
  hosts: /(^|\.)linkedin\.com$/,
  schemes: ["https:"],
  navHost: "www.linkedin.com",
  readPaths: ["/in/", "/company/", "/search/results/", "/jobs/", "/posts/", "/feed/update/"],
  wallPaths: /^\/(login|uas\/login|authwall|checkpoint)\b/,
  allowWrites: [],
};

export type NavCheck = { ok: true } | { ok: false; reason: string };

export function checkNavigation(url: string, policy: Policy = LINKEDIN_POLICY): NavCheck {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: `not a URL: ${url}` };
  }
  if (!policy.schemes.includes(u.protocol)) return { ok: false, reason: `${u.protocol} URLs are not allowed` };
  if (u.hostname !== policy.navHost) return { ok: false, reason: `only ${policy.navHost} is allowed (${u.hostname})` };
  if (u.username || u.password) return { ok: false, reason: "URLs with credentials are not allowed" };
  if (!policy.readPaths.some((p) => u.pathname.startsWith(p))) return { ok: false, reason: `${u.pathname} is not a page generated APIs may read` };
  return { ok: true };
}

// observe: let everything through and log what enforce would block. enforce: block it.
export type GuardMode = "observe" | "enforce";
export const guardMode = (): GuardMode => (process.env.LINKEDBOT_GUARD === "enforce" ? "enforce" : "observe");

type Verdict = "write" | "navigation" | "wall";

function isTopLevelNavigation(req: Request): boolean {
  if (!req.isNavigationRequest() || req.resourceType() !== "document") return false;
  try {
    return req.frame().parentFrame() === null;
  } catch {
    return false; // service worker requests have no frame
  }
}

function judge(req: Request, policy: Policy): { verdict: Verdict; url: URL } | null {
  const url = new URL(req.url());
  if (!policy.hosts.test(url.hostname)) return null;
  const method = req.method();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    return policy.allowWrites.some((a) => a.method === method && a.path.test(url.pathname)) ? null : { verdict: "write", url };
  }
  if (!isTopLevelNavigation(req)) return null;
  if (policy.wallPaths.test(url.pathname)) return { verdict: "wall", url };
  return checkNavigation(url.href, policy).ok ? null : { verdict: "navigation", url };
}

export async function installGuard(ctx: BrowserContext, opts: { mode: GuardMode; policy?: Policy; log?: string }): Promise<void> {
  const policy = opts.policy ?? LINKEDIN_POLICY;
  const log = opts.log ?? `${DATA_DIR}/guard.log`;
  mkdirSync(dirname(log), { recursive: true });
  // Method, host and path only: never query strings or bodies.
  const record = (verdict: Verdict, req: Request, url: URL) =>
    appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), mode: opts.mode, verdict, method: req.method(), host: url.hostname, path: url.pathname }) + "\n");

  if (opts.mode === "observe") {
    ctx.on("request", (req) => {
      const j = judge(req, policy);
      if (!j) return;
      record(j.verdict, req, j.url);
      if (j.verdict === "wall") tripBreaker(`LinkedIn sent the browser to ${j.url.pathname}`);
    });
    return;
  }
  await ctx.route((url) => policy.hosts.test(url.hostname), async (route) => {
    const req = route.request();
    const j = judge(req, policy);
    if (!j) return route.fallback();
    record(j.verdict, req, j.url);
    if (j.verdict === "wall") tripBreaker(`LinkedIn sent the browser to ${j.url.pathname}`);
    return route.abort("blockedbyclient");
  });
}

// LinkedIn answers 429, or its own 999, when it is rate-limiting or blocking a client.
export function watchRateLimits(ctx: BrowserContext, policy: Policy = LINKEDIN_POLICY): void {
  ctx.on("response", (res) => {
    const req = res.request();
    if (![429, 999].includes(res.status()) || !isTopLevelNavigation(req)) return;
    if (policy.hosts.test(new URL(req.url()).hostname)) tripBreaker(`LinkedIn answered ${res.status()}`);
  });
}
