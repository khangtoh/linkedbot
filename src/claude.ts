import Anthropic from "@anthropic-ai/sdk";
import { readJson, writeJsonAtomic } from "./store.js";
import { DATA_DIR } from "./vault.js";

// Which Claude model each feature uses, whether the server has a key, and a cheap connection test.
// The owner's choice (saved from the studio) wins over LINKEDBOT_MODEL / LINKEDBOT_GEN_MODEL, which
// win over the built-in defaults. The key itself never leaves the server; only its last characters do.

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", price: "$4 / $20" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", price: "$2 / $10" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", price: "$0.10 / $0.50" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", price: "$10 / $50" },
] as const;

export type Feature = "agent" | "generator";
const DEFAULTS: Record<Feature, () => string> = {
  agent: () => process.env.LINKEDBOT_MODEL || "claude-sonnet-5-5",
  generator: () => process.env.LINKEDBOT_GEN_MODEL || "claude-opus-5-5",
};

const PATH = `${DATA_DIR}/claude.json`;
const load = () => readJson<Partial<Record<Feature, string>>>(PATH, {});

export const modelFor = (feature: Feature): string => load()[feature] || DEFAULTS[feature]();

const label = (id: string) => MODELS.find((m) => m.id === id)?.label ?? id;

// Server-side refusal fallback ("default" routing) is not offered for Haiku.
export const supportsFallbacks = (model: string) => model !== "claude-haiku-5-5";

function key(): { source: "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN"; value: string } | undefined {
  for (const source of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const) {
    const value = process.env[source]?.trim();
    if (value) return { source, value };
  }
}

export function claudeSettings() {
  const k = key();
  const saved = load();
  const feature = (f: Feature) => ({ model: saved[f] || DEFAULTS[f](), default: DEFAULTS[f](), chosen: !!saved[f] });
  return {
    configured: !!k,
    source: k?.source ?? null,
    // Enough to tell two keys apart; short values show nothing.
    keyHint: k && k.value.length >= 16 ? `${k.value.startsWith("sk-ant-") ? "sk-ant-" : ""}…${k.value.slice(-4)}` : null,
    models: MODELS,
    features: { agent: feature("agent"), generator: feature("generator") },
  };
}

// null or "" puts a feature back on its default.
export function saveClaudeSettings(body: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  const next = load();
  for (const f of ["agent", "generator"] as const) {
    if (!(f in body)) continue;
    const v = body[f];
    if (v === null || v === "") delete next[f];
    else if (typeof v === "string" && MODELS.some((m) => m.id === v)) next[f] = v;
    else return { ok: false, error: `${f} must be one of ${MODELS.map((m) => m.id).join(", ")}` };
  }
  writeJsonAtomic(PATH, next);
  return { ok: true };
}

export type TestResult = { ok: boolean; model: string; ms: number; reply?: string; tokens?: number; error?: string };

// One tiny request: a few input tokens, low effort, a short cap. A reply cut off by the cap still
// proves the key and the model work.
export async function testClaude(model = modelFor("agent")): Promise<TestResult> {
  if (!key()) return { ok: false, model, ms: 0, error: "No API key on the server. Set ANTHROPIC_API_KEY and restart." };
  const client = new Anthropic({ timeout: 20_000, maxRetries: 0 });
  const started = Date.now();
  try {
    const res = await client.messages.create({
      model,
      max_tokens: 64,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Reply with just the word: ok" }],
    });
    const reply = res.content.flatMap((b) => (b.type === "text" ? [b.text.trim()] : [])).join(" ");
    return { ok: true, model, ms: Date.now() - started, reply: reply || undefined, tokens: res.usage.input_tokens + res.usage.output_tokens };
  } catch (e) {
    return { ok: false, model, ms: Date.now() - started, error: explain(e, model) };
  }
}

function explain(e: unknown, model: string): string {
  if (e instanceof Anthropic.AuthenticationError) return "The key was rejected. Check ANTHROPIC_API_KEY.";
  if (e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.NotFoundError) return `This key can't use ${label(model)}. Pick another model.`;
  if (e instanceof Anthropic.RateLimitError) return "Claude is rate-limiting this key. Try again in a minute.";
  if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach the Claude API from the server.";
  if (e instanceof Anthropic.APIError && (e.status ?? 0) >= 500) return "Claude is busy or having trouble. Try again in a minute.";
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status}: ${e.message}`;
  return (e as Error).message;
}
