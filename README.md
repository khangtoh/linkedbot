# linkedbot

Single-user LinkedIn automation agent. You log in once in a real browser; the session
cookies are stored in an AES-256-GCM encrypted vault (`data/session.vault`) and replayed
in a headless Playwright context.

> Automating LinkedIn violates its User Agreement and can get your account restricted.
> Keep volumes low; caps live in `src/limits.ts`.

## Setup
```
npm install
export LINKEDBOT_PASSPHRASE='a long passphrase'
export ANTHROPIC_API_KEY=...
npx playwright install chromium
npm run cli -- login            # headed browser on this machine, log in yourself
npm run cli -- login --remote   # no screen / no dev tools: log in from any device (see below)
npm run cli -- whoami
npm run cli -- search "head of data fintech" 2   # scrape 2 result pages into data/leads.json
npm run cli -- leads leads.csv                    # export (omit file to print a table)
npm run cli -- agent "Summarize the profile at https://www.linkedin.com/in/someone"
```
`HEADFUL=1` shows the browser during runs. If the session hits a login wall/checkpoint,
automation stops with a clear error; re-run `login`.

## Layout
- `leads.ts` deduped lead store + CSV export · `actions/search.ts` People search scraper
- `vault.ts` encrypted session store · `limits.ts` daily caps, human delays, circuit breaker
- `browser.ts` one shared browser lease, session replay, cookie write-back · `actions/` typed actions
- `policy.ts` read-only network guard (`LINKEDBOT_GUARD=observe|enforce`) · `store.ts` crash-safe files
- `ops/` operation registry: built-ins, chained tools (`chain.ts`, JSONata in `expr.ts`), runner
- `agent.ts` Claude tool loop over the published operations
- `server.ts` HTTP API · `mcp.ts` MCP endpoint · `oauth.ts` OAuth sign-in for hosted MCP clients
- `auth.ts` token checks and rate limiting · `jobs.ts` serial, persisted job queue
- `ops/preview.ts` studio previews · `static.ts` serves the studio · `gen/` the API generator
- `web/` the studio (Vite + React) · `docs/journeys/` user journeys
- `scripts/deploy.sh` InstaCloud pipeline · `scripts/smoke.ts` checks a deployed service

## Remote login (`login --remote`)
Runs Chromium headless and streams it to a web page you open from any device (phone included).
You click/type into the stream to log in; when it reaches the feed the session is saved to the vault.
- Prints a one-time URL with a random token; the server binds to `127.0.0.1:8787` by default
  (`--host`, `--port` to change).
- Your password is typed through this connection. Reach it via localhost, an SSH tunnel
  (`ssh -L 8787:127.0.0.1:8787 server`) or an HTTPS tunnel; avoid plain HTTP over untrusted networks.
- The browser user agent used at login is stored with the session and reused on replay.

## Hosted (InstaCloud)
The CLI runs once and exits, so the hosted form is `src/server.ts`: one container with headless
Chromium, state on a persistent `/data` volume (`LINKEDBOT_DATA`), jobs run one at a time.
```
npm run deploy                        # check, package, provision, secrets, deploy, verify
scripts/deploy.sh deploy verify       # just the named stages (redeploy after a code change)
```
The image is built remotely from the `Dockerfile`; no local Docker. The pipeline creates the
project, a compute service `app` with a 1 Gi volume, and the secrets `LINKEDBOT_PASSPHRASE` and
`LINKEDBOT_API_TOKEN` (generated once, never overwritten; the token is four random words, and
`scripts/deploy.sh token` replaces it). `ANTHROPIC_API_KEY` is copied from your
shell if exported. Read a value back with `insta secrets --print`.

Everything except `/healthz` needs `Authorization: Bearer $LINKEDBOT_API_TOKEN`:
```
POST /login                 -> {url}: one-time page (10 min) streaming the login browser
POST /jobs {"cmd":"whoami"} | {"cmd":"search","keywords":"...","pages":2} | {"cmd":"agent","task":"..."}
GET  /jobs/<id>             -> status + result (jobs are async; poll)
GET  /status · /leads · /leads.csv
```
Full request and response schemas: `openapi.yaml` (OpenAPI 3.1).
`insta run` injects the token without writing it to disk:
```
insta run -- sh -c 'curl -s -X POST -H "Authorization: Bearer $LINKEDBOT_API_TOKEN" https://<app-url>/login'
```
### Logging in (hosted)
1. Start a login: `curl -s -X POST -H "Authorization: Bearer $LINKEDBOT_API_TOKEN" https://<app-url>/login`
   returns `{"url": "https://<app-url>/login?t=...", "expiresInMinutes": 10}`.
2. Open that `url` in any browser (a phone works). It shows the server's browser on LinkedIn's sign-in page.
3. Tap a field and type your email and password, then complete any 2FA or security check in the same view.
4. When LinkedIn reaches the feed, the page says "Logged in. Session saved." and the stream closes.
5. Confirm: `GET /status` shows `"session": true`, or queue `{"cmd":"whoami"}`.

The URL works for anyone who has it until the login finishes or 10 minutes pass, so don't share it.
Only one login runs at a time; calling `POST /login` again returns the same URL. If it expires,
call it again. Repeat the login whenever a job fails with "Session needs attention".

Hosted runs come from a datacenter IP. Expect LinkedIn to challenge the login (complete it in the
stream) and treat the account-restriction risk as higher than from your own machine.

## Studio
`https://<app-url>/studio/` is a phone-first web app for the same operations: sign in with the
four-word token, log in to LinkedIn, browse and run operations, build tools by chaining them (with
real previews of each step), generate APIs, and see runs and leads. Design context is in
`PRODUCT.md` and `DESIGN.md`; `node scripts/contrast.mjs` checks the colour tokens. Develop with
`npm run serve` and `npm run dev:web`; `npm run build:web` builds it into `web/dist`.

## MCP server
The hosted service is also an MCP server at `https://<app-url>/mcp` (Streamable HTTP; both the
2025 and 2026 protocol versions). Every published operation is a tool, plus `list_operations`,
`run_operation`, `get_job`, `define_tool` and `remove_tool`. Everything is read-only on LinkedIn.

**Clients that send a header** (Claude Code, Cursor, VS Code, Gemini CLI, the Anthropic and OpenAI
APIs, Claude Desktop through `mcp-remote`): use `Authorization: Bearer <four-word token>`.
```
claude mcp add --transport http linkedbot https://<app-url>/mcp --header "Authorization: Bearer $LINKEDBOT_API_TOKEN"
```

**claude.ai and ChatGPT** cannot send a header. Add a custom connector with the URL
`https://<app-url>/mcp` and no client id; a sign-in page opens and asks for the four-word token.
The client then holds its own tokens. Replacing the API token (`scripts/deploy.sh token`)
disconnects every OAuth client.

Calls that take longer than about 45 seconds return a `job_id`; `get_job` waits for the result.

### Tools made by chaining operations
`define_tool` (MCP) or `POST /api/ops` (HTTP) saves a tool: steps that call other operations, with
`{ "$expr": "<JSONata>" }` values to pass data between them and `forEach` loops (limit 1-25).
The `define_tool` description has a full example. Tools are checked when saved (unknown operations,
missing inputs, references to later steps, loops between tools) and before they run (worst-case
spend against today's caps). User journeys for this and what comes next are in `docs/journeys/`.

### Generating an API (early)
`generate_api` writes a read-only recipe for a LinkedIn page from a description and saves it as a
draft. It runs on the server, where the LinkedIn session is, and needs `ANTHROPIC_API_KEY`:
```
curl -s -X POST -H "Authorization: Bearer $LINKEDBOT_API_TOKEN" $BOT/jobs \
  -d '{"cmd":"generate_api","description":"Company name, industry, size and website","exampleUrl":"https://www.linkedin.com/company/anthropic/about/","budget":5}'
```
Poll `GET /jobs/<id>`; the result lists what the generator did, the output it got, and the draft's
name. Review the draft with `GET /api/ops/<name>?draft`. Publishing it (`POST /api/ops/<name>/publish`)
makes it an MCP tool and a `POST /jobs` command like any other.

### Tests
`npm test` runs the unit and integration tests (real Chromium against local pages; no LinkedIn).
`scripts/deploy.sh verify` runs `scripts/smoke.ts` against the deployed service. Set
`LINKEDBOT_BRANCH=<name>` to deploy to and verify an InstaCloud preview branch instead of main.
