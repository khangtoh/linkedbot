// Thin client for the linkedbot HTTP API. The studio authenticates with a signed cookie (set by
// POST /api/session), so every call is same-origin with credentials.

export type JsonSchema = { type: "object"; properties?: Record<string, PropSchema>; required?: string[]; additionalProperties?: boolean };
export type PropSchema = { type?: string; description?: string; default?: unknown; minimum?: number; maximum?: number; enum?: unknown[]; pattern?: string };
export type OpSummary = { name: string; kind: "builtin" | "api" | "tool"; description: string; inputSchema: JsonSchema; status: "published" | "draft"; version: number; usesLinkedIn: boolean };
export type Caps = { view_profile: number; search: number; connect: number; message: number };
export type Status = {
  session: boolean;
  loginInProgress: boolean;
  linkedin: { open: boolean; reason?: string; since?: string };
  browser: { holder?: { holder: string; label: string }; waiting: { holder: string; label: string }[] };
  queue: { paused: boolean; pending: number };
  capsLeft: Caps;
  leads: number;
  jobs: JobSummary[];
};
export type JobStatus = "queued" | "running" | "done" | "error";
export type Progress = { stage: "queued" | "waiting" | "working"; message: string; since: string };
export type JobSummary = { id: string; cmd: string; status: JobStatus; createdAt: string; startedAt?: string; finishedAt?: string; progress?: Progress; error?: string };
export type Job<R = unknown> = JobSummary & { input: unknown; result?: R };
export type ClaudeFeature = { model: string; default: string; chosen: boolean };
export type ClaudeSettings = {
  configured: boolean;
  source: "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN" | null;
  keyHint: string | null;
  workspace: string | null;
  models: { id: string; label: string; price: string }[];
  features: { agent: ClaudeFeature; generator: ClaudeFeature };
};
export type ClaudeTest = { ok: boolean; model: string; ms: number; reply?: string; tokens?: number; error?: string };
export type Lead = { slug: string; url: string; name: string; headline: string; location: string; query: string; foundAt: string };

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: any) {
    super(message);
  }
}

// Fired when the server stops accepting this device's cookie (token replaced, or it expired).
export const signedOut = new EventTarget();

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (res.status === 401 && path !== "/session") signedOut.dispatchEvent(new Event("signedout"));
  if (!res.ok) throw new ApiError(res.status, (data && (data.error || data.errors?.join("; "))) || `Request failed (${res.status})`, data);
  return data as T;
}

export const api = {
  session: () => call<{ signedIn: boolean }>("GET", "/session/check"),
  signIn: (token: string) => call<{ signedIn: boolean }>("POST", "/session", { token }),
  signOut: () => call<{ signedIn: boolean }>("DELETE", "/session"),
  status: () => call<Status>("GET", "/status"),
  ops: (drafts = true) => call<OpSummary[]>("GET", `/ops${drafts ? "?drafts" : ""}`),
  op: (name: string, draft = true) => call<any>("GET", `/ops/${name}${draft ? "?draft" : ""}`),
  saveDraft: (def: unknown) => call<{ draft: any; errors: string[] }>("POST", "/ops", def),
  publish: (name: string) => call<any>("POST", `/ops/${name}/publish`),
  remove: (name: string, draftOnly = false) => call<unknown>("DELETE", `/ops/${name}${draftOnly ? "?draft" : ""}`),
  run: (name: string, input: Record<string, unknown>) => call<Job>("POST", "/jobs", { cmd: name, ...input }),
  job: <R = unknown>(id: string) => call<Job<R>>("GET", `/jobs/${id}`),
  preview: (def: unknown, input: unknown, loopCap = 2) => call<Job<PreviewResult>>("POST", "/preview", { def, input, loopCap }),
  leads: () => call<Lead[]>("GET", "/leads"),
  claude: () => call<ClaudeSettings>("GET", "/claude"),
  // null puts a feature back on its default model
  setClaudeModels: (models: Partial<Record<"agent" | "generator", string | null>>) => call<ClaudeSettings>("PUT", "/claude", models),
  testClaude: (model?: string) => call<ClaudeTest>("POST", "/claude/test", model ? { model } : {}),
  startLogin: () => call<{ url: string; expiresInMinutes: number }>("POST", "/login"),
};

export type PreviewResult = {
  ok: boolean;
  problems?: string[];
  cost?: Partial<Caps>;
  output?: unknown;
  error?: string;
  steps?: Record<string, { output?: unknown; status: string; error?: string; errors?: { index: number; error: string }[] }>;
  trace?: { op: string; path: string; output?: unknown; error?: string; ms: number }[];
};

export const finished = (j: { status: JobStatus }) => j.status === "done" || j.status === "error";

// Waits for a job, polling with a gentle backoff; resolves with the finished job.
export async function untilDone<R>(job: Job<R>, onUpdate?: (j: Job<R>) => void, signal?: AbortSignal): Promise<Job<R>> {
  let current = job;
  let delay = 1000;
  while (!finished(current)) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.4, 4000);
    current = await api.job<R>(current.id);
    onUpdate?.(current);
  }
  return current;
}

export const costText = (cost: Partial<Caps> | undefined) => {
  const parts = Object.entries(cost ?? {})
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${k === "view_profile" ? (n === 1 ? "profile view" : "profile views") : n === 1 ? "search" : "searches"}`);
  return parts.length ? parts.join(" + ") : "no LinkedIn page loads";
};

// "search_people" -> "Search people"
const NAMES: Record<string, string> = { whoami: "Who am I", agent: "Ask the agent", list_leads: "List leads", generate_api: "Generate an API" };
export const humanize = (name: string) => NAMES[name] ?? name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
