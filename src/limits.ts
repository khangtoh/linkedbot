import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DATA_DIR } from "./vault.js";

// Conservative daily caps per action type. Tune down, not up.
export const DAILY_CAPS: Record<string, number> = {
  view_profile: 80,
  search: 40,
  connect: 15,
  message: 25,
};

const PATH = `${DATA_DIR}/usage.json`;
type Usage = { day: string; counts: Record<string, number> };

function load(): Usage {
  const today = new Date().toISOString().slice(0, 10);
  if (existsSync(PATH)) {
    const u = JSON.parse(readFileSync(PATH, "utf8")) as Usage;
    if (u.day === today) return u;
  }
  return { day: today, counts: {} };
}

export function consume(action: string): void {
  const u = load();
  const cap = DAILY_CAPS[action] ?? 0;
  if ((u.counts[action] ?? 0) >= cap) throw new Error(`Daily cap reached for "${action}" (${cap}).`);
  u.counts[action] = (u.counts[action] ?? 0) + 1;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PATH, JSON.stringify(u));
}

// Human-ish pause between actions.
export function humanDelay(minMs = 2000, maxMs = 6000): Promise<void> {
  return new Promise((r) => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));
}
