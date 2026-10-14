import { viewProfile, whoami } from "../actions/profile.js";
import { searchPeople } from "../actions/search.js";
import { loadLeads } from "../leads.js";
import { runAgent } from "../agent.js";
import type { BuiltinOp } from "./types.js";

const builtin = (op: Omit<BuiltinOp, "kind" | "status" | "version">): BuiltinOp => ({ ...op, kind: "builtin", status: "published", version: 1 });

export const BUILTINS: BuiltinOp[] = [
  builtin({
    name: "whoami",
    description: "Get the logged-in user's own name and headline.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    usesLinkedIn: true,
    cost: () => ({ view_profile: 1 }),
    run: async (_input, ctx) => {
      const page = await ctx.page();
      ctx.progress("Opening your profile");
      return whoami(page);
    },
  }),
  builtin({
    name: "view_profile",
    description: "Read a LinkedIn profile (name, headline, about) by its URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", pattern: "^https://(www\\.)?linkedin\\.com/in/", description: "Profile URL, https://www.linkedin.com/in/<slug>/" } },
      required: ["url"],
      additionalProperties: false,
    },
    usesLinkedIn: true,
    cost: () => ({ view_profile: 1 }),
    run: async ({ url }, ctx) => {
      const page = await ctx.page();
      ctx.progress("Opening the profile");
      return viewProfile(page, url);
    },
  }),
  builtin({
    name: "search_people",
    description: "Search LinkedIn People by keywords (e.g. 'head of data fintech London') and save the results as leads. Each page (~10 results) counts toward the daily search cap.",
    inputSchema: {
      type: "object",
      properties: {
        keywords: { type: "string", minLength: 1 },
        pages: { type: "integer", minimum: 1, maximum: 5, default: 1, description: "Result pages to read, 1-5" },
      },
      required: ["keywords"],
      additionalProperties: false,
    },
    usesLinkedIn: true,
    cost: ({ pages = 1 }) => ({ search: pages }),
    run: async (input, ctx) => {
      const page = await ctx.page();
      return searchPeople(page, { ...input, onPage: (n: number, of: number) => ctx.progress(of > 1 ? `Reading results page ${n} of ${of}` : "Reading the search results") });
    },
  }),
  builtin({
    name: "list_leads",
    description: "List stored leads (no LinkedIn call). Optional case-insensitive filter over name, headline and location.",
    inputSchema: {
      type: "object",
      properties: { filter: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 500, default: 25 } },
      additionalProperties: false,
    },
    usesLinkedIn: false,
    cost: () => ({}),
    run: async ({ filter, limit = 25 }) => {
      const f = filter?.toLowerCase();
      return loadLeads()
        .filter((l) => !f || `${l.name} ${l.headline} ${l.location}`.toLowerCase().includes(f))
        .slice(0, limit);
    },
  }),
  builtin({
    name: "generate_api",
    description: "Generate a read-only API for a LinkedIn page from a description, and save it as a draft for review. Spends Claude API tokens and up to `budget` page loads.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", minLength: 10, description: "What the API should return" },
        exampleUrl: { type: "string", pattern: "^https://www\\.linkedin\\.com/", description: "A LinkedIn page it should work on" },
        budget: { type: "integer", minimum: 2, maximum: 10, default: 6, description: "Page loads this generation may use" },
      },
      required: ["description", "exampleUrl"],
      additionalProperties: false,
    },
    usesLinkedIn: true,
    cost: ({ budget = 6 }) => ({ view_profile: budget }),
    run: async (input, ctx) => {
      const { generateDraft } = await import("../gen/draft.js");
      return generateDraft(input, (m) => ctx.progress(m));
    },
    // Needs the owner watching (journey 4); until the studio exists it runs as an HTTP job only.
    hidden: { mcp: true, agent: true, chains: true },
  }),
  builtin({
    name: "agent",
    description: "Give Claude a task to carry out with the other operations. Needs ANTHROPIC_API_KEY on the server.",
    inputSchema: { type: "object", properties: { task: { type: "string", minLength: 1 } }, required: ["task"], additionalProperties: false },
    usesLinkedIn: true,
    cost: () => ({}), // each operation it calls is checked and counted on its own
    run: ({ task }, ctx) => runAgent(task, ctx),
    hidden: { mcp: true, agent: true, chains: true }, // MCP clients are agents already
  }),
];
