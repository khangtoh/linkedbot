# User journeys

Each journey is written before it is built, then updated with screenshots once its screens exist.
Status: **draft** (written, not built), **building**, **built** (works and is tested, not yet proven live end to end), **shipped**.

| # | Journey | Surface | Status |
|---|---|---|---|
| 1 | [Sign in and log in to LinkedIn](01-sign-in.md) | Studio, HTTP API | built: studio sign-in and LinkedIn login (opens in a new tab); in-app live view comes with journey 4 |
| 2 | [Connect an MCP client](02-connect-mcp-client.md) | MCP | building: header and OAuth paths work and are tested with the MCP SDK clients; live claude.ai and ChatGPT test pending |
| 3 | [Compose a tool by chaining APIs](03-compose-tool.md) | Studio, MCP | built: studio builder (QA'd on phone and desktop) and `define_tool` over MCP |
| 4 | [Generate a missing API](04-generate-api.md) | Studio, MCP | building: generator works on test pages and has a first studio screen; live LinkedIn spike, live view and pointing pending |
| 5 | [Run things and read results](05-run-and-results.md) | Studio, MCP, HTTP API | built: Library, run sheet, Activity and Leads in the studio; MCP and HTTP |
| 6 | [Check and tune the Claude connection](06-claude-settings.md) | Studio, HTTP API | building: key status, per-feature model, connection test |

## Who this is for

One person: the owner of the LinkedIn account. They use the studio from a phone as often as from a
desktop, often in short sessions between other things, and they reach the same operations from MCP
clients (Claude, ChatGPT, Cursor and others) when they want an assistant to do the work.

## Words used in these docs

- **Operation**: anything that can be run. Three kinds: a *built-in* (hand-written), an *API*
  (generated from a description) and a *tool* (a chain of other operations).
- **Draft / published**: only published operations appear as MCP tools. Editing a published
  operation creates a draft beside it; the published version keeps working until the draft is published.
- **Daily caps**: per-category limits on LinkedIn page loads (see `src/limits.ts`). Every journey that
  touches LinkedIn shows what it will spend before it spends it.
- **Read-only**: generated APIs and chains can only navigate and read. They cannot connect, message,
  follow, like or post. Viewing a profile is still visible to that profile's owner.
