# Journey 2: Connect an MCP client

**Status:** draft

## Who and when

The owner, wanting an assistant (Claude Code, Claude, ChatGPT, Cursor, VS Code, Gemini CLI) to use
linkedbot's operations as tools. Usually done once per client.

## Entry points

- Studio: Settings, "Connect a client". Shows the server URL, a copy button, and the steps for the
  client you pick.
- README "MCP" section, for the same steps without the studio.

The MCP endpoint is `https://<app-url>/mcp`. There are two ways in, both using the same four-word token.

## Steps: clients that accept a header

Claude Code, Cursor, VS Code, Gemini CLI, Claude Desktop (through `mcp-remote`), and the Anthropic and
OpenAI APIs.

1. Copy the server URL from Settings.
2. Add it with the header `Authorization: Bearer <four-word token>`. Examples (also shown in Settings):
   - Claude Code: `claude mcp add --transport http linkedbot https://<app-url>/mcp --header "Authorization: Bearer $LINKEDBOT_API_TOKEN"`
   - Cursor / VS Code / Gemini CLI: a `headers` entry in that client's MCP config.
3. The client lists the tools straight away.

## Steps: clients that need OAuth

claude.ai (web, desktop, mobile connectors) and ChatGPT.

1. In the client, add a custom connector with the URL `https://<app-url>/mcp`, no client id.
2. The client opens linkedbot's sign-in page in a browser tab. It names the client asking for access
   (for example "claude.ai") and asks for the four-word token.
3. Type the token, choose Allow. The tab returns to the client, which lists the tools.
4. The connection stays signed in. Replacing the token (`scripts/deploy.sh token`) disconnects every
   OAuth client; each one then asks you to sign in again.

## What the client sees

- One tool per published operation, named after it (`whoami`, `search_people`, your tools and APIs).
- `list_operations` and `run_operation`: reach an operation published after the client last loaded its
  tool list. ChatGPT needs its manual refresh to show new tools as tools.
- `get_job`: fetch the result of a long call (see journey 5).
- `define_tool` / `remove_tool`: create or delete a chain from the conversation (journey 3).
- `request_api`: ask for an API that does not exist yet (journey 4).

## States

| State | What you see |
|---|---|
| Wrong token in a header | The client reports 401 "unauthorized". |
| Wrong token on the OAuth page | "That token doesn't match." and the page stays open. |
| Too many attempts | "Too many attempts. Try again in a minute." |
| Server cold-starting | The first request after idle can take several seconds. Clients wait. |
| Token replaced | Header clients get 401 until updated; OAuth clients are asked to sign in again. |

## Success check

The client lists `whoami`, and calling it returns your name (or "No saved session", which means journey 1
is not done yet).

## Notes

- Live compatibility of the OAuth path with claude.ai and ChatGPT must be tested before this journey is
  marked shipped; it is built to their published requirements but not yet proven.
- ChatGPT custom MCP servers may need a Business or Enterprise plan.
