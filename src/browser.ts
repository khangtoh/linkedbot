import { chromium, type BrowserContext, type Page } from "playwright";
import { hasSession, loadSession } from "./vault.js";

export class SessionExpiredError extends Error {}

export async function openSession(): Promise<{ ctx: BrowserContext; page: Page; close: () => Promise<void> }> {
  if (!hasSession()) throw new Error("No saved session. Run: npm run cli login");
  const browser = await chromium.launch({ headless: process.env.HEADFUL !== "1" });
  const ctx = await browser.newContext({
    storageState: loadSession(),
    viewport: { width: 1366, height: 800 },
    locale: "en-US",
  });
  const page = await ctx.newPage();
  return { ctx, page, close: () => browser.close() };
}

// Detects logout / checkpoint / captcha so automation stops instead of hammering.
export function assertHealthy(page: Page): void {
  const url = page.url();
  if (/\/(login|uas\/login|authwall|checkpoint)/.test(url)) {
    throw new SessionExpiredError(`Session needs attention (landed on ${url}). Run: npm run cli login`);
  }
}
