import type { Page } from "playwright";
import { assertHealthy } from "../browser.js";
import { consume, humanDelay } from "../limits.js";

// LinkedIn renders the profile with scripts after the first HTML arrives, and its newer layout has no
// h1 and only generated class names. So: take the name from the page title ("Name | LinkedIn"), find
// that text on the page, and read the headline as the first line after it in the same card that is
// not a button, a connection degree or pronouns. The older selectors are still tried first.
const NOT_HEADLINE = /^(enhance profile|add section|add profile section|open to|more|message|connect|follow|following|pending|contact info|resources|visit my website|view my newsletter|·.*|\(.*\)|(1st|2nd|3rd\+?)( degree connection)?|he\/him|she\/her|they\/them)$/i;

async function readProfile(page: Page) {
  await page.waitForFunction(() => /\S/.test(document.title.replace(/\|?\s*LinkedIn\s*$/i, "")) && !!document.querySelector("main"), undefined, { timeout: 15_000 }).catch(() => {});
  await page.locator("main h1, main [aria-label] p").first().waitFor({ timeout: 10_000 }).catch(() => {});
  const text = async (sel: string) => (await page.locator(sel).first().innerText({ timeout: 2_000 }).catch(() => "")).trim();
  const meta = async (sel: string) => ((await page.locator(sel).first().getAttribute("content", { timeout: 1_000 }).catch(() => null)) ?? "").trim();
  const title = (await page.title().catch(() => "")).replace(/\s*\|\s*LinkedIn\s*$/i, "").replace(/^\(\d+\)\s*/, "").trim();
  const name = (await text("main h1")) || title || (await text("h1"));
  const fromCard = name
    ? await page
        .evaluate(
          ({ name, notHeadline }) => {
            const skip = new RegExp(notHeadline, "i");
            // Prefer the visible name (inside a labelled link) over headings that repeat it for screen readers.
            const hits = Array.from(document.querySelectorAll("main *")).filter((e) => e.childElementCount === 0 && (e.textContent ?? "").trim() === name);
            const leaf = hits.find((e) => e.closest("[aria-label], a") && !/^H\d$/.test(e.tagName)) ?? hits.find((e) => !/^H\d$/.test(e.tagName)) ?? hits[0];
            if (!leaf) return "";
            let card: Element = leaf;
            for (let i = 0; i < 10 && card.parentElement; i++) {
              card = card.parentElement;
              if ((card as HTMLElement).innerText.split("\n").filter((l) => l.trim()).length >= 3) break;
            }
            const lines = (card as HTMLElement).innerText.split("\n").map((l) => l.trim()).filter(Boolean);
            return lines.slice(lines.indexOf(name) + 1).find((l) => l !== name && l.length > 2 && !skip.test(l)) ?? "";
          },
          { name, notHeadline: NOT_HEADLINE.source },
        )
        .catch(() => "")
    : "";
  const headline = (await text("main div.text-body-medium")) || fromCard || (await meta('meta[property="og:description"]')) || (await meta('meta[name="description"]'));
  return { url: page.url().replace(/\?isSelfProfile=true$/, ""), name, headline };
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
