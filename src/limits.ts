import { EventEmitter } from "node:events";
import { DATA_DIR } from "./vault.js";
import { readJson, writeJsonAtomic } from "./store.js";

// Conservative daily caps per action type. Tune down, not up.
export const DAILY_CAPS = {
  view_profile: 80,
  search: 40,
  connect: 15,
  message: 25,
} as const;
export type CapCategory = keyof typeof DAILY_CAPS;
export type Cost = Partial<Record<CapCategory, number>>;
export const isCapCategory = (s: string): s is CapCategory => Object.hasOwn(DAILY_CAPS, s);

const PATH = `${DATA_DIR}/usage.json`;
type Usage = { day: string; counts: Partial<Record<CapCategory, number>> };

function load(): Usage {
  const today = new Date().toISOString().slice(0, 10);
  const u = readJson<Usage | null>(PATH, null);
  return u?.day === today ? u : { day: today, counts: {} };
}

export function remaining(): Record<CapCategory, number> {
  const { counts } = load();
  const out = {} as Record<CapCategory, number>;
  for (const k of Object.keys(DAILY_CAPS) as CapCategory[]) out[k] = Math.max(0, DAILY_CAPS[k] - (counts[k] ?? 0));
  return out;
}

// Fails before anything runs when a whole run would not fit in what is left today.
export function assertBudget(cost: Cost): void {
  const left = remaining();
  for (const [k, n] of Object.entries(cost) as [CapCategory, number][]) {
    if (n > left[k]) throw new Error(`Would exceed today's cap for "${k}" (needs ${n}, ${left[k]} left of ${DAILY_CAPS[k]}).`);
  }
}

export function consume(action: CapCategory): void {
  const u = load();
  const cap = DAILY_CAPS[action];
  if ((u.counts[action] ?? 0) >= cap) throw new Error(`Daily cap reached for "${action}" (${cap}).`);
  u.counts[action] = (u.counts[action] ?? 0) + 1;
  writeJsonAtomic(PATH, u);
}

// Human-ish pause between actions.
export function humanDelay(minMs = 2000, maxMs = 6000): Promise<void> {
  return new Promise((r) => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));
}

// Circuit breaker: once LinkedIn shows a login wall or rate-limits us, nothing touches LinkedIn again
// until a new login. Persisted, so a restart does not start hammering again.
const BREAKER_PATH = `${DATA_DIR}/breaker.json`;
export type Breaker = { open: boolean; reason?: string; since?: string };
export const breakerEvents = new EventEmitter();

export function breakerState(): Breaker {
  return readJson<Breaker>(BREAKER_PATH, { open: false });
}

export function tripBreaker(reason: string): void {
  if (breakerState().open) return;
  writeJsonAtomic(BREAKER_PATH, { open: true, reason, since: new Date().toISOString() });
  console.warn(`LinkedIn paused: ${reason}`);
  breakerEvents.emit("change");
}

export function resetBreaker(): void {
  if (!breakerState().open) return;
  writeJsonAtomic(BREAKER_PATH, { open: false });
  breakerEvents.emit("change");
}

export async function waitForBreakerClosed(): Promise<void> {
  while (breakerState().open) await new Promise((r) => breakerEvents.once("change", r));
}
