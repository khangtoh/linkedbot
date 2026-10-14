import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { WebSocketServer } from "ws";
import { openSession } from "./browser.js";
import { whoami } from "./actions/profile.js";
import { searchPeople } from "./actions/search.js";
import { runAgent } from "./agent.js";
import { loadLeads, leadsToCsv } from "./leads.js";
import { LOGIN_PAGE, startLoginStream } from "./remoteLogin.js";
import { DATA_DIR, hasSession } from "./vault.js";

// Long-lived HTTP front for the same actions the CLI runs, so the bot can live on a host
// that expects a server (container platforms). Everything except /healthz and the one-time
// login page needs `Authorization: Bearer $LINKEDBOT_API_TOKEN`.
const PORT = Number(process.env.PORT ?? 8080);
const API_TOKEN = process.env.LINKEDBOT_API_TOKEN ?? "";
if (API_TOKEN.length < 24) throw new Error("Set LINKEDBOT_API_TOKEN (>=24 chars) to protect the HTTP API.");

const sha = (s: string) => createHash("sha256").update(s).digest();
const authed = (req: IncomingMessage) =>
  timingSafeEqual(sha(req.headers.authorization ?? ""), sha(`Bearer ${API_TOKEN}`));

type Job = {
  id: string;
  cmd: string;
  input: unknown;
  status: "queued" | "running" | "done" | "error";
  result?: unknown;
  error?: string;
  createdAt: string;
  finishedAt?: string;
};

// Jobs are kept on disk: the host may stop an idle machine before the caller polls for the result.
const JOBS_PATH = `${DATA_DIR}/jobs.json`;
const jobs: Job[] = existsSync(JOBS_PATH) ? JSON.parse(readFileSync(JOBS_PATH, "utf8")) : [];
for (const j of jobs) if (j.status === "queued" || j.status === "running") Object.assign(j, { status: "error", error: "Interrupted by a restart." });
function saveJobs(): void {
  jobs.splice(0, Math.max(0, jobs.length - 50));
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(JOBS_PATH, JSON.stringify(jobs));
}

const RUNNERS: Record<string, { needs?: string; run: (input: any) => Promise<unknown> }> = {
  whoami: {
    run: async () => {
      const s = await openSession();
      try { return await whoami(s.page); } finally { await s.close(); }
    },
  },
  search: {
    needs: "keywords",
    run: async ({ keywords, pages }) => {
      const s = await openSession();
      try { return await searchPeople(s.page, { keywords, pages: Number(pages) || 1 }); } finally { await s.close(); }
    },
  },
  agent: { needs: "task", run: ({ task }) => runAgent(task) },
};

// One browser at a time: there is a single LinkedIn session and the pacing in limits.ts assumes serial use.
let queue: Promise<void> = Promise.resolve();
function enqueue(cmd: string, input: unknown): Job {
  const job: Job = { id: randomBytes(8).toString("hex"), cmd, input, status: "queued", createdAt: new Date().toISOString() };
  jobs.push(job);
  saveJobs();
  queue = queue.then(async () => {
    job.status = "running";
    saveJobs();
    try {
      job.result = await RUNNERS[cmd].run(input);
      job.status = "done";
    } catch (e) {
      job.error = (e as Error).message;
      job.status = "error";
    }
    job.finishedAt = new Date().toISOString();
    saveJobs();
  });
  return job;
}

// At most one remote-login browser. Its page is reached with a one-time token in the URL
// (a phone browser can't send a bearer header), so the API token never appears in a URL.
let login: { token: string; wss: WebSocketServer } | undefined;
async function beginLogin(): Promise<string> {
  if (login) return login.token;
  const { wss, done } = await startLoginStream();
  const current = (login = { token: randomBytes(24).toString("hex"), wss });
  done
    .catch((e) => console.warn("remote login ended without a session:", (e as Error).message.split("\n")[0]))
    .finally(() => { if (login === current) login = undefined; });
  return current.token;
}
const loginOk = (url?: string) => !!login && new URL(url ?? "", "http://x").searchParams.get("t") === login.token;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new Error("Body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? "", "http://x");
    const route = `${req.method} ${pathname}`;
    if (route === "GET /healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    if (route === "GET /login") {
      if (!loginOk(req.url)) return void res.writeHead(403).end("forbidden");
      return void res.writeHead(200, { "content-type": "text/html", "referrer-policy": "no-referrer" }).end(LOGIN_PAGE);
    }
    if (!authed(req)) return json(res, 401, { error: "Missing or wrong bearer token." });

    if (route === "GET /status") {
      return json(res, 200, {
        session: hasSession(),
        loginInProgress: !!login,
        leads: loadLeads().length,
        jobs: jobs.slice(-10).map(({ id, cmd, status, createdAt, finishedAt }) => ({ id, cmd, status, createdAt, finishedAt })),
      });
    }
    if (route === "POST /login") {
      const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0];
      return json(res, 200, { url: `${proto}://${req.headers.host}/login?t=${await beginLogin()}`, expiresInMinutes: 10 });
    }
    if (route === "POST /jobs") {
      const { cmd, ...input } = await readJson(req);
      if (!Object.hasOwn(RUNNERS, cmd)) return json(res, 400, { error: `cmd must be one of: ${Object.keys(RUNNERS).join(", ")}` });
      const { needs } = RUNNERS[cmd];
      if (needs && (typeof input[needs] !== "string" || !input[needs].trim())) return json(res, 400, { error: `${cmd} needs "${needs}"` });
      return json(res, 202, enqueue(cmd, input));
    }
    if (req.method === "GET" && pathname.startsWith("/jobs/")) {
      const job = jobs.find((j) => j.id === pathname.slice("/jobs/".length));
      return job ? json(res, 200, job) : json(res, 404, { error: "No such job." });
    }
    if (route === "GET /leads") return json(res, 200, loadLeads());
    if (route === "GET /leads.csv") return void res.writeHead(200, { "content-type": "text/csv" }).end(leadsToCsv(loadLeads()));
    json(res, 404, { error: "Not found." });
  } catch (e) {
    json(res, e instanceof SyntaxError ? 400 : 500, { error: (e as Error).message });
  }
});

server.on("upgrade", (req, sock, head) => {
  const { wss } = login ?? {};
  if (!wss || new URL(req.url ?? "", "http://x").pathname !== "/ws" || !loginOk(req.url)) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws));
});

server.listen(PORT, "0.0.0.0", () => console.log(`linkedbot listening on :${PORT} (data dir: ${DATA_DIR})`));
// As PID 1 in a container Node ignores SIGTERM unless something handles it.
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0));
