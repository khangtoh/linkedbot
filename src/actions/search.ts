import type { Page } from "playwright";
import { assertHealthy } from "../browser.js";
import { addLeads, type Lead } from "../leads.js";
import { consume, humanDelay } from "../limits.js";

export type SearchOpts = { keywords: string; pages?: number; onPage?: (page: number, of: number) => void };

type Raw = { slug: string; name: string; lines: string[] };

// Scrapes one results page. Selector-light on purpose: find unique /in/ anchors
// in the results, then read the nearest list item's text lines.
async function scrapePage(page: Page): Promise<Raw[]> {
  return page.evaluate(() => {
    const out: Raw[] = [];
    const seen = new Set<string>();
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("main a[href*='/in/']"))) {
      const m = a.href.match(/\/in\/([^/?#]+)/);
      if (!m || seen.has(m[1]) || m[1] === "me") continue;
      const card = a.closest("li") ?? a.parentElement?.parentElement;
      if (!card) continue;
      const lines = (card as HTMLElement).innerText
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s && !/^(Connect|Follow|Message|Pending|• ?(1st|2nd|3rd\+?))$/i.test(s));
      if (!lines.length) continue;
      seen.add(m[1]);
      out.push({ slug: m[1], name: lines[0].replace(/\s*View .*profile$/i, ""), lines });
    }
    return out;
  }) as Promise<Raw[]>;
}

// Searches People and stores the results as leads. Each results page counts as one "search".
export async function searchPeople(page: Page, { keywords, pages = 1, onPage }: SearchOpts) {
  const found: Lead[] = [];
  for (let p = 1; p <= Math.min(pages, 5); p++) {
    onPage?.(p, Math.min(pages, 5));
    consume("search");
    const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}&page=${p}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main a[href*='/in/']", { timeout: 15_000 }).catch(() => {});
    await humanDelay(1500, 3500);
    assertHealthy(page);
    // Scroll so lazily rendered cards load.
    await page.mouse.wheel(0, 2500);
    await humanDelay(1000, 2000);

    const rows = await scrapePage(page);
    if (!rows.length) break; // no more results (or markup changed)
    for (const r of rows) {
      // lines[0]=name, then degree/headline/location in order; take the first two remaining lines.
      const rest = r.lines.slice(1).filter((l) => !/^(1st|2nd|3rd)/i.test(l));
      found.push({
        slug: r.slug,
        url: `https://www.linkedin.com/in/${r.slug}/`,
        name: r.name,
        headline: rest[0] ?? "",
        location: rest[1] ?? "",
        query: keywords,
        foundAt: new Date().toISOString(),
      });
    }
    await humanDelay();
  }
  const added = addLeads(found);
  return { scraped: found.length, newLeads: added, sample: found.slice(0, 5).map(({ name, headline, location, url }) => ({ name, headline, location, url })) };
}
