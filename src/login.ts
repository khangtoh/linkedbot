import { chromium } from "playwright";
import { saveSession } from "./vault.js";
import { resetBreaker } from "./limits.js";

// Opens a real (headed) browser. You log in yourself (2FA included);
// we never see the password, only the resulting cookies.
export async function captureLogin(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("https://www.linkedin.com/login");
  console.log("Log in in the browser window. Waiting for the feed...");
  await page.waitForURL(/linkedin\.com\/feed/, { timeout: 5 * 60_000 });
  saveSession(await ctx.storageState(), await page.evaluate(() => navigator.userAgent));
  resetBreaker();
  await browser.close();
  console.log("Session saved to the encrypted vault.");
}
