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

## Remote login (`login --remote`)
Runs Chromium headless and streams it to a web page you open from any device (phone included).
You click/type into the stream to log in; when it reaches the feed the session is saved to the vault.
- Prints a one-time URL with a random token; the server binds to `127.0.0.1:8787` by default
  (`--host`, `--port` to change).
- Your password is typed through this connection. Reach it via localhost, an SSH tunnel
  (`ssh -L 8787:127.0.0.1:8787 server`) or an HTTPS tunnel; avoid plain HTTP over untrusted networks.
- The browser user agent used at login is stored with the session and reused on replay.
