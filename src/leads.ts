import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DATA_DIR } from "./vault.js";

export type Lead = {
  slug: string; // /in/<slug>, the dedupe key
  url: string;
  name: string;
  headline: string;
  location: string;
  query: string;
  foundAt: string;
};

const PATH = `${DATA_DIR}/leads.json`;

export function loadLeads(): Lead[] {
  return existsSync(PATH) ? (JSON.parse(readFileSync(PATH, "utf8")) as Lead[]) : [];
}

// Merges new leads, skipping slugs already stored. Returns how many were new.
export function addLeads(incoming: Lead[]): number {
  const all = loadLeads();
  const seen = new Set(all.map((l) => l.slug));
  let added = 0;
  for (const l of incoming) {
    if (seen.has(l.slug)) continue;
    seen.add(l.slug);
    all.push(l);
    added++;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PATH, JSON.stringify(all, null, 2));
  return added;
}

const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;

export function leadsToCsv(leads: Lead[]): string {
  const head = ["name", "headline", "location", "url", "query", "foundAt"];
  return [head.join(","), ...leads.map((l) => head.map((h) => esc(String((l as any)[h] ?? ""))).join(","))].join("\n");
}
