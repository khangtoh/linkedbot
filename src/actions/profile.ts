import type { Page } from "playwright";
import { assertHealthy } from "../browser.js";
import { consume, humanDelay } from "../limits.js";

export async function whoami(page: Page) {
  consume("view_profile");
  await page.goto("https://www.linkedin.com/in/me/", { waitUntil: "domcontentloaded" });
  await humanDelay();
  assertHealthy(page);
  return {
    url: page.url(),
    name: (await page.locator("h1").first().innerText().catch(() => "")).trim(),
    headline: (await page.locator("div.text-body-medium").first().innerText().catch(() => "")).trim(),
  };
}

export async function viewProfile(page: Page, url: string) {
  if (!/^https:\/\/(www\.)?linkedin\.com\/in\//.test(url)) throw new Error("Not a LinkedIn profile URL");
  consume("view_profile");
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await humanDelay();
  assertHealthy(page);
  return {
    url: page.url(),
    name: (await page.locator("h1").first().innerText().catch(() => "")).trim(),
    headline: (await page.locator("div.text-body-medium").first().innerText().catch(() => "")).trim(),
    about: (await page.locator("section:has(#about)").first().innerText().catch(() => "")).trim().slice(0, 2000),
  };
}
