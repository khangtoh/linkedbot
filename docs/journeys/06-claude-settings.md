# Journey 6: Check and tune the Claude connection

**Status:** building

## Who and when

The owner, after deploying, or when "Ask the agent" or "Generate an API" fails with an API-key
error. Also when they want a cheaper or stronger model for one of the two Claude features.

## Entry points

- Studio: Settings, "Claude" section.
- Error help for a key problem (`web/src/explain.ts`) points here.

## What it shows

1. **Connection.** "Enabled" when the server has `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`),
   with the key's last four characters so the owner can tell which key it is. The key itself never
   leaves the server. "Not set" otherwise, with how to set it (`scripts/deploy.sh secrets`, or
   `export ANTHROPIC_API_KEY=...` before `npm run serve`).
2. **Models.** One picker per feature that uses Claude:
   - *Agent* ("Ask the agent"): default Claude Sonnet 5.5.
   - *API generator* ("Generate an API"): default Claude Opus 5.5.
   Choices: Claude Opus 5.5, Claude Sonnet 5.5, Claude Haiku 5.5, Claude Fable 5.1, each with its
   price per million tokens. A change saves on pick and applies to the next run; a run already going
   keeps its model. `LINKEDBOT_MODEL` / `LINKEDBOT_GEN_MODEL` still set the defaults; a choice made
   here overrides them, and "Default" puts the env/default back.
3. **Test.** "Test connection" sends one tiny request (a few dozen tokens, low effort) to the model
   picked for the agent and shows the outcome: reply, time taken and tokens used, or what went wrong
   in plain words. It never touches LinkedIn.

## States

| State | What you see |
|---|---|
| No key | "Not set" pill, how to set it; pickers still work; Test is disabled. |
| Key set | "Enabled" pill, `sk-ant-…abcd`. |
| Test passes | "Connected to Claude Sonnet 5.5 in 0.8 s, 23 tokens." |
| Key rejected (401) | "The key was rejected. Check ANTHROPIC_API_KEY." |
| Model not available to the key (403/404) | "This key can't use Claude Fable 5.1. Pick another model." |
| Rate limited / overloaded | "Claude is busy or rate-limited. Try again in a minute." |
| Network | "Couldn't reach the Claude API from the server." |

## Success check

Owner with a fresh deploy opens Settings, sees "Enabled", taps Test, sees "Connected" in under a few
seconds, and switches the agent to Haiku 5.5; the next "Ask the agent" run uses Haiku.
