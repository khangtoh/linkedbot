import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { WebSocketServer } from "ws";
import { closeBrowser, lock } from "./browser.js";
import { loadLeads, leadsToCsv } from "./leads.js";
import { LOGIN_PAGE, startLoginStream } from "./remoteLogin.js";
import { DATA_DIR, hasSession } from "./vault.js";
import { assertTokenConfigured, authenticate, clearedSessionCookie, clientIp, isLimited, recordFailure, sessionCookie, tokenMatches } from "./auth.js";
import { enqueue, getJob, initJobs, markInterrupted, queueState, recentJobs, waitForJob } from "./jobs.js";
import { breakerState, remaining } from "./limits.js";
import { getOp, listOps, publish, removeOp, runTopLevel, saveDraft, summarize, validateInput } from "./ops/index.js";
import { handleMcp } from "./mcp.js";
import { challengeHeader, handleOAuth, mcpResource } from "./oauth.js";
import { previewTool } from "./ops/preview.js";
import { serveStudio } from "./static.js";

// Long-lived HTTP front for the same actions the CLI runs, so the bot can live on a host
// that expects a server (container platforms). Everything except /healthz and the one-time
// login page needs `Authorization: Bearer $LINKEDBOT_API_TOKEN`. Every path also answers under /api/.
const PORT = Number(process.env.PORT ?? 8080);
// When this process started (epoch seconds), so a deploy can tell the new build is the one serving.
const STARTED = String(Math.floor(Date.now() / 1000));
assertTokenConfigured();

// Older names accepted by POST /jobs.
const ALIASES: Record<string, string> = { search: "search_people" };
const canonical = (cmd: string) => ALIASES[cmd] ?? cmd;
// "__preview" runs an unsaved tool for the studio; everything else is a published operation.
initJobs((name) => (name === "__preview" ? (input, report) => previewTool(input, report) : getOp(name) ? (input, report) => runTopLevel(name, input, { onProgress: report }) : undefined));

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
    const rawPath = new URL(req.url ?? "", "http://x").pathname;
    const pathname = rawPath.replace(/^\/api(?=\/)/, "");
    const route = `${req.method} ${pathname}`;
    if (route === "GET /healthz") return void res.writeHead(200, { "content-type": "text/plain", "x-linkedbot-started": STARTED }).end("ok");
    if (route === "GET /login") {
      if (!loginOk(req.url)) return void res.writeHead(403).end("forbidden");
      return void res.writeHead(200, { "content-type": "text/html", "referrer-policy": "no-referrer" }).end(LOGIN_PAGE);
    }
    if (serveStudio(req, res, rawPath)) return;
    if (await handleOAuth(req, res, rawPath)) return;
    // Studio sign-in: trade the four-word token for a signed cookie.
    if (route === "POST /session") {
      const ip = clientIp(req);
      if (isLimited(ip)) return json(res, 429, { error: "Too many attempts. Try again in a minute." });
      const { token } = await readJson(req);
      if (typeof token !== "string" || !tokenMatches(token)) {
        recordFailure(ip);
        return json(res, 401, { error: "That token doesn't match." });
      }
      res.setHeader("set-cookie", sessionCookie(req));
      return json(res, 200, { signedIn: true });
    }
    // Whether this device is signed in, without an error when it is not (the studio asks on load).
    if (route === "GET /session/check") {
      const a = authenticate(req);
      return json(res, 200, { signedIn: a.ok });
    }
    if (route === "DELETE /session") {
      res.setHeader("set-cookie", clearedSessionCookie());
      return json(res, 200, { signedIn: false });
    }
    const auth = authenticate(req, rawPath === "/mcp" ? { resource: mcpResource(req) } : {});
    if (rawPath === "/mcp") {
      if (auth.ok) return await handleMcp(req, res);
      // Tells OAuth clients (claude.ai, ChatGPT) where to sign in.
      const status = auth.status;
      res.setHeader("www-authenticate", challengeHeader(req, !!req.headers.authorization));
      if (status === 429) res.setHeader("retry-after", "60");
      return json(res, status, { error: status === 429 ? "Too many attempts. Try again in a minute." : "Missing or wrong bearer token." });
    }
    if (!auth.ok && auth.status === 429) {
      res.setHeader("retry-after", "60");
      return json(res, 429, { error: "Too many attempts. Try again in a minute." });
    }
    if (!auth.ok) return json(res, 401, { error: "Missing or wrong bearer token." });

    if (route === "GET /session") return json(res, 200, { signedIn: true, via: auth.principal.via });
    // Run a tool that is still being built; answers within 45s or with a job to poll.
    if (route === "POST /preview") {
      const body = await readJson(req);
      if (!body || typeof body.def !== "object") return json(res, 400, { error: "def is required" });
      const job = enqueue("__preview", { def: body.def, input: body.input ?? {}, loopCap: Math.min(Math.max(Number(body.loopCap) || 2, 1), 25) });
      return json(res, 200, await waitForJob(job.id, 45_000));
    }
    if (route === "GET /status") {
      return json(res, 200, {
        session: hasSession(),
        loginInProgress: !!login,
        linkedin: breakerState(),
        browser: lock.state(),
        queue: queueState(),
        capsLeft: remaining(),
        leads: loadLeads().length,
        jobs: recentJobs(10).map(({ id, cmd, status, createdAt, startedAt, finishedAt, progress, error }) => ({ id, cmd, status, createdAt, startedAt, finishedAt, progress, error })),
      });
    }
    if (route === "POST /login") {
      const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0];
      return json(res, 200, { url: `${proto}://${req.headers.host}/login?t=${await beginLogin()}`, expiresInMinutes: 10 });
    }
    if (route === "POST /jobs") {
      const { cmd, ...input } = await readJson(req);
      const op = typeof cmd === "string" ? getOp(canonical(cmd)) : undefined;
      if (!op) return json(res, 400, { error: `cmd must be the name of a published operation (GET /api/ops lists them)` });
      const checked = validateInput(op, input);
      if (!checked.ok) return json(res, 400, { error: checked.errors.join("; ") });
      return json(res, 202, enqueue(op.name, checked.value));
    }
    // Operations: ?drafts=1 includes drafts. A saved draft returns the problems that block publishing.
    if (route === "GET /ops") return json(res, 200, listOps({ drafts: new URL(req.url ?? "", "http://x").searchParams.has("drafts") }).map(summarize));
    if (route === "POST /ops") {
      const def = await readJson(req);
      if (def.kind !== "tool" && def.kind !== "api") return json(res, 400, { error: 'kind must be "tool" or "api"' });
      const existing = typeof def.name === "string" ? getOp(def.name, { draft: true }) : undefined;
      if (existing && existing.kind !== def.kind) return json(res, 409, { error: `"${def.name}" is already used by a ${existing.kind}.` });
      const saved = saveDraft(def);
      return json(res, 200, { draft: saved.def, errors: saved.errors });
    }
    const opPath = /^\/ops\/([a-z][a-z0-9_]{1,63})(\/publish)?$/.exec(pathname);
    if (opPath && req.method === "GET") {
      const op = getOp(opPath[1], { draft: new URL(req.url ?? "", "http://x").searchParams.has("draft") });
      return op ? json(res, 200, op.kind === "builtin" ? summarize(op) : op) : json(res, 404, { error: "No such operation." });
    }
    if (opPath?.[2] && req.method === "POST") {
      const result = publish(opPath[1]);
      return result.ok ? json(res, 200, result.op) : json(res, 400, { errors: result.errors });
    }
    if (opPath && req.method === "DELETE") {
      const draftOnly = new URL(req.url ?? "", "http://x").searchParams.has("draft");
      return removeOp(opPath[1], { draftOnly }) ? json(res, 200, { removed: opPath[1], draftOnly }) : json(res, 404, { error: "No such operation, or it is a built-in." });
    }
    if (req.method === "GET" && pathname.startsWith("/jobs/")) {
      const job = getJob(pathname.slice("/jobs/".length));
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
// As PID 1 in a container Node ignores SIGTERM unless something handles it. Record the interrupted
// job and close Chromium, but never let a stuck browser hold up the stop.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    markInterrupted();
    setTimeout(() => process.exit(0), 5_000).unref();
    void closeBrowser().finally(() => process.exit(0));
  });
}
