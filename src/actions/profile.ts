import type { Page } from "playwright";
import { assertHealthy } from "../browser.js";
import { consume, humanDelay } from "../limits.js";

// LinkedIn renders the profile with scripts after the first HTML arrives, so wait for the name to
// appear, and fall back to the page title ("Name | LinkedIn") and description if the layout changed.
async function readProfile(page: Page) {
  await page.locator("main h1").first().waitFor({ timeout: 15_000 }).catch(() => {});
  const text = async (sel: string) => (await page.locator(sel).first().innerText({ timeout: 2_000 }).catch(() => "")).trim();
  const meta = async (sel: string) => ((await page.locator(sel).first().getAttribute("content", { timeout: 1_000 }).catch(() => null)) ?? "").trim();
  const title = (await page.title().catch(() => "")).replace(/\s*\|\s*LinkedIn\s*$/i, "").replace(/^\(\d+\)\s*/, "").trim();
  const name = (await text("main h1")) || (await text("h1")) || title;
  const headline = (await text("main div.text-body-medium")) || (await text("div.text-body-medium")) || (await meta('meta[property="og:description"]')) || (await meta('meta[name="description"]'));
  return { url: page.url(), name, headline };
}

export async function whoami(page: Page) {
  consume("view_profile");
  await page.goto("https://www.linkedin.com/in/me/", { waitUntil: "domcontentloaded" });
  await humanDelay();
  assertHealthy(page);
  return readProfile(page);
}

export async function viewProfile(page: Page, url: string) {
  if (!/^https:\/\/(www\.)?linkedin\.com\/in\//.test(url)) throw new Error("Not a LinkedIn profile URL");
  consume("view_profile");
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await humanDelay();
  assertHealthy(page);
  return {
    ...(await readProfile(page)),
    about: (await page.locator("section:has(#about)").first().innerText({ timeout: 2_000 }).catch(() => "")).trim().slice(0, 2000),
  };
}
