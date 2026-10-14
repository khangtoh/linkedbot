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
- `vault.ts` encrypted session store · `limits.ts` daily caps + human delays
- `browser.ts` session replay + health check · `actions/` typed actions
- `agent.ts` Claude tool loop with an approval gate for side-effect actions
- `server.ts` HTTP front for the same actions (hosted use) · `scripts/deploy.sh` InstaCloud pipeline

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
`LINKEDBOT_API_TOKEN` (generated once, never overwritten). `ANTHROPIC_API_KEY` is copied from your
shell if exported. Read a value back with `insta secrets --print`.

Everything except `/healthz` needs `Authorization: Bearer $LINKEDBOT_API_TOKEN`:
```
POST /login                 -> {url}: one-time page (10 min) streaming the login browser
POST /jobs {"cmd":"whoami"} | {"cmd":"search","keywords":"...","pages":2} | {"cmd":"agent","task":"..."}
GET  /jobs/<id>             -> status + result (jobs are async; poll)
GET  /status · /leads · /leads.csv
```
`insta run` injects the token without writing it to disk:
```
insta run -- sh -c 'curl -s -X POST -H "Authorization: Bearer $LINKEDBOT_API_TOKEN" https://<app-url>/login'
```
Hosted runs come from a datacenter IP. Expect LinkedIn to challenge the login (complete it in the
stream) and treat the account-restriction risk as higher than from your own machine.
