import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { hasSession, loadSession, saveSession, sessionVersion } from "./vault.js";
import { normalUserAgent } from "./ua.js";
import { breakerState, tripBreaker } from "./limits.js";
import { guardMode, installGuard, watchRateLimits } from "./policy.js";

export class SessionExpiredError extends Error {}

// One owner of the LinkedIn identity: a single browser, a single session context, one holder at a
// time. Waiters are served by priority (login, then interactive work, then queued jobs), and first
// come first served within a priority.
export type Holder = "login" | "interactive" | "job";
const PRIORITY: Record<Holder, number> = { login: 0, interactive: 1, job: 2 };

type Waiter = { holder: Holder; label: string; seq: number; grant: () => void };

export class PriorityLock {
  private held?: { holder: Holder; label: string };
  private waiters: Waiter[] = [];
  private seq = 0;

  state() {
    return { holder: this.held, waiting: this.waiters.map(({ holder, label }) => ({ holder, label })) };
  }

  acquire(holder: Holder, label: string): Promise<() => void> {
    return new Promise((resolve) => {
      const w: Waiter = {
        holder,
        label,
        seq: this.seq++,
        grant: () => {
          this.held = { holder, label };
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.held = undefined;
            this.pump();
          });
        },
      };
      this.waiters.push(w);
      this.waiters.sort((a, b) => PRIORITY[a.holder] - PRIORITY[b.holder] || a.seq - b.seq);
      this.pump();
    });
  }

  private pump(): void {
    if (this.held) return;
    this.waiters.shift()?.grant();
  }
}

export const lock = new PriorityLock();

export interface Lease {
  readonly holder: Holder;
  readonly context: BrowserContext;
  readonly userAgent: string;
  newPage(): Promise<Page>;
  // persist: write the context's cookies back to the vault if the session is still healthy.
  release(opts?: { persist?: boolean }): Promise<void>;
}

const WARM_MS = 60_000; // keep the browser open this long after the last lease, for back-to-back jobs
let browser: Browser | undefined;
let session: { ctx: BrowserContext; version: number; userAgent: string } | undefined;
let idleTimer: NodeJS.Timeout | undefined;

async function getBrowser(): Promise<Browser> {
  if (!browser?.isConnected()) browser = await chromium.launch({ headless: process.env.HEADFUL !== "1" });
  return browser;
}

// The guarded context replaying the saved session; rebuilt whenever the vault changes (a new login).
async function sessionContext() {
  if (!hasSession()) throw new SessionExpiredError("No saved LinkedIn session. Log in to LinkedIn first.");
  const version = sessionVersion();
  if (session?.version === version) return session;
  await session?.ctx.close().catch(() => {});
  session = undefined;
  const b = await getBrowser();
  const saved = loadSession();
  // Reuse the UA the session was created with so LinkedIn sees a consistent client.
  const userAgent = saved.userAgent ?? normalUserAgent(b);
  const ctx = await b.newContext({
    storageState: saved.state,
    userAgent,
    viewport: { width: 1366, height: 800 },
    locale: "en-US",
    serviceWorkers: "block", // routes cannot see service-worker requests
  });
  await installGuard(ctx, { mode: guardMode() });
  watchRateLimits(ctx);
  session = { ctx, version, userAgent };
  return session;
}

// Only cookies from a healthy session are kept, so a login wall never overwrites a good vault.
async function writeBack(s: NonNullable<typeof session>): Promise<void> {
  if (breakerState().open || session !== s) return;
  const state = await s.ctx.storageState();
  if (!state.cookies.some((c) => c.name === "li_at" && c.value)) return;
  saveSession(state, s.userAgent);
  s.version = sessionVersion();
}

function scheduleIdleClose(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void closeBrowser(), WARM_MS);
  idleTimer.unref();
}

export async function acquire(holder: Holder, label: string, opts: { viewport?: { width: number; height: number } } = {}): Promise<Lease> {
  const unlock = await lock.acquire(holder, label);
  clearTimeout(idleTimer);
  try {
    let ctx: BrowserContext, userAgent: string, onRelease: (persist: boolean) => Promise<void>;
    if (holder === "login") {
      // A clean, unguarded context: the login flow must reach /login and /checkpoint, and writes to sign in.
      const b = await getBrowser();
      userAgent = normalUserAgent(b);
      ctx = await b.newContext({ viewport: opts.viewport ?? { width: 1280, height: 800 }, userAgent, locale: "en-US" });
      onRelease = () => ctx.close();
    } else {
      const s = await sessionContext();
      ({ ctx, userAgent } = s);
      onRelease = (persist) => (persist ? writeBack(s) : Promise.resolve());
    }
    const pages: Page[] = [];
    let released = false;
    return {
      holder,
      context: ctx,
      userAgent,
      async newPage() {
        const p = await ctx.newPage();
        pages.push(p);
        return p;
      },
      async release({ persist = false } = {}) {
        if (released) return;
        released = true;
        try {
          await Promise.all(pages.map((p) => p.close().catch(() => {})));
          await onRelease(persist).catch((e) => console.warn("releasing the browser:", (e as Error).message));
        } finally {
          unlock();
          if (!lock.state().holder) scheduleIdleClose();
        }
      },
    };
  } catch (e) {
    unlock();
    scheduleIdleClose();
    throw e;
  }
}

// Runs fn with a page from the shared session and writes healthy cookies back afterwards.
export async function withPage<T>(label: string, fn: (page: Page) => Promise<T>, holder: Holder = "job"): Promise<T> {
  const lease = await acquire(holder, label);
  try {
    return await fn(await lease.newPage());
  } finally {
    await lease.release({ persist: true });
  }
}

export async function closeBrowser(): Promise<void> {
  clearTimeout(idleTimer);
  const b = browser;
  browser = undefined;
  session = undefined;
  await b?.close().catch(() => {});
}

// Detects logout / checkpoint / captcha so automation stops instead of hammering.
export function assertHealthy(page: Page): void {
  const url = page.url();
  if (/\/(login|uas\/login|authwall|checkpoint)/.test(url)) {
    tripBreaker(`LinkedIn showed ${new URL(url).pathname}`);
    throw new SessionExpiredError(`Session needs attention (landed on ${url}). Log in to LinkedIn again.`);
  }
  const b = breakerState();
  if (b.open) throw new SessionExpiredError(`LinkedIn work is paused: ${b.reason}. Log in to LinkedIn again.`);
}
