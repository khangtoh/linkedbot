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
npm run cli -- login        # headed browser, log in yourself
npm run cli -- whoami
npm run cli -- agent "Summarize the profile at https://www.linkedin.com/in/someone"
```
`HEADFUL=1` shows the browser during runs. If the session hits a login wall/checkpoint,
automation stops with a clear error; re-run `login`.

## Layout
- `vault.ts` encrypted session store · `limits.ts` daily caps + human delays
- `browser.ts` session replay + health check · `actions/` typed actions
- `agent.ts` Claude tool loop with an approval gate for side-effect actions
