import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpHandler, fromJsonSchema, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { enqueue, getJob, waitForJob, type Job } from "./jobs.js";
import { getOp, listOps, publish, removeOp, saveDraft, summarize, validateInput } from "./ops/index.js";
import type { JsonSchema, Op } from "./ops/types.js";

// Streamable HTTP MCP endpoint. Stateless on purpose: the host stops idle machines, and an in-memory
// session would die with the machine. Each request builds a fresh server from the registry, so a
// tool published a moment ago is listed on the client's next tools/list.
const WAIT_MS = 45_000; // longer runs answer with a job id instead; see get_job

const visible = (op: Op) => !(op.kind === "builtin" && op.hidden?.mcp);

const text = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  ...(value && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value as Record<string, unknown> } : {}),
  ...(isError ? { isError: true } : {}),
});

function jobResult(job: Job | undefined): CallToolResult {
  if (!job) return text("No such job. Results are kept for the 50 most recent runs.", true);
  if (job.status === "done") return text(job.result ?? null);
  if (job.status === "error") return text(`Failed: ${job.error}`, true);
  return text({ status: job.status, job_id: job.id, message: `Still ${job.status}. Call get_job with this job_id to wait for the result.` });
}

// Every call goes through the same queue as the HTTP API, so it shows up in Activity and respects
// the one-browser rule. Identical calls already in the queue are joined, not repeated.
async function call(name: string, input: unknown): Promise<CallToolResult> {
  const op = getOp(name);
  if (!op || !visible(op)) return text(`Unknown operation "${name}". Call list_operations to see what exists.`, true);
  const checked = validateInput(op, input);
  if (!checked.ok) return text(`Invalid input for ${name}: ${checked.errors.join("; ")}`, true);
  return jobResult(await waitForJob(enqueue(op.name, checked.value).id, WAIT_MS));
}

const schema = (s: JsonSchema) => fromJsonSchema(s as Parameters<typeof fromJsonSchema>[0]);

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "linkedbot", version: "0.2.0" },
    {
      instructions:
        "Read-only tools over the owner's LinkedIn account. Every LinkedIn page load counts against daily caps, so prefer few, targeted calls. " +
        "Long calls return a job_id; call get_job to wait for the result. Tools published after your tool list was loaded can be reached with list_operations and run_operation.",
    },
  );

  for (const op of listOps().filter(visible)) {
    server.registerTool(
      op.name,
      {
        description: op.description,
        inputSchema: schema(op.inputSchema),
        annotations: { readOnlyHint: true, openWorldHint: summarize(op).usesLinkedIn },
      },
      (args: unknown) => call(op.name, args),
    );
  }

  server.registerTool(
    "list_operations",
    {
      description: "List every published operation (built-ins, generated APIs and tools) with its input schema. Includes ones published after your tool list was loaded.",
      inputSchema: schema({ type: "object", properties: {}, additionalProperties: false }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => text({ operations: listOps().filter(visible).map(summarize) }),
  );

  server.registerTool(
    "run_operation",
    {
      description: "Run a published operation by name. Use this for operations that are not in your tool list yet.",
      inputSchema: schema({
        type: "object",
        properties: { name: { type: "string" }, input: { type: "object", description: "Input matching the operation's inputSchema" } },
        required: ["name"],
        additionalProperties: false,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args: unknown) => {
      const { name, input = {} } = args as { name: string; input?: unknown };
      return call(name, input);
    },
  );

  server.registerTool(
    "get_job",
    {
      description: "Get the result of a long-running call. Waits up to wait_seconds (default 30, max 45) for it to finish before answering.",
      inputSchema: schema({
        type: "object",
        properties: { job_id: { type: "string" }, wait_seconds: { type: "integer", minimum: 0, maximum: 45, default: 30 } },
        required: ["job_id"],
        additionalProperties: false,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: unknown) => {
      const { job_id, wait_seconds = 30 } = args as { job_id: string; wait_seconds?: number };
      if (!getJob(job_id)) return jobResult(undefined);
      return jobResult(await waitForJob(job_id, Math.min(45, wait_seconds) * 1000));
    },
  );

  server.registerTool(
    "define_tool",
    {
      description: DEFINE_TOOL_HELP,
      inputSchema: schema({
        type: "object",
        properties: {
          name: { type: "string", description: "lowercase_with_underscores, 2-64 characters" },
          description: { type: "string", description: "What the tool does and when to use it; this is what assistants read" },
          inputSchema: { type: "object", description: 'JSON Schema of the tool\'s input, type "object"' },
          steps: { type: "array", items: { type: "object" } },
          output: { description: "Optional value or { \"$expr\": ... } for what the tool returns; default is the last step's output" },
          publish: { type: "boolean", default: true, description: "Publish when valid. false keeps it as a draft for the owner to review in the studio" },
        },
        required: ["name", "description", "inputSchema", "steps"],
        additionalProperties: false,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args: unknown) => {
      const { publish: doPublish = true, ...def } = args as Record<string, unknown> & { name: string; description: string; inputSchema: JsonSchema; publish?: boolean };
      const existing = getOp(def.name, { draft: true });
      if (existing && existing.kind !== "tool") return text(`"${def.name}" is ${existing.kind === "builtin" ? "a built-in" : "a generated API"}; pick another name.`, true);
      const { errors } = saveDraft({ ...def, kind: "tool" });
      if (errors.length) return text(`Saved as a draft, but it needs fixing before it can be published:\n- ${errors.join("\n- ")}`, true);
      if (!doPublish) return text({ saved: def.name, status: "draft" });
      const published = publish(def.name);
      if (!published.ok) return text(published.errors.join("\n"), true);
      return text({ published: def.name, version: published.op.version, note: "Call it now with run_operation; it appears as its own tool when your client reloads its tool list." });
    },
  );

  server.registerTool(
    "remove_tool",
    {
      description: "Delete a tool made by chaining operations (its draft and published versions). Built-ins and generated APIs cannot be removed here.",
      inputSchema: schema({ type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args: unknown) => {
      const { name } = args as { name: string };
      const op = getOp(name, { draft: true });
      if (!op) return text(`There is no tool "${name}".`, true);
      if (op.kind !== "tool") return text(`"${name}" is not a chained tool, so it cannot be removed here.`, true);
      removeOp(name);
      return text({ removed: name });
    },
  );

  return server;
}

const DEFINE_TOOL_HELP = `Create or replace a tool that chains published operations. Example (search, then read each of the first 5 profiles):
{"name":"find_and_read","description":"Search people and read each profile","inputSchema":{"type":"object","properties":{"keywords":{"type":"string"}},"required":["keywords"]},
 "steps":[{"id":"found","type":"call","op":"search_people","args":{"keywords":{"$expr":"input.keywords"}}},
  {"id":"profiles","type":"forEach","items":{"$expr":"steps.found.output.sample"},"as":"person","limit":5,"onError":"skip",
   "steps":[{"id":"p","type":"call","op":"view_profile","args":{"url":{"$expr":"$person.url"}}}],"collect":{"$expr":"steps.p.output"}}],
 "output":{"$expr":"{ 'people': steps.profiles.output }"}}
Rules: step types are "call" and "forEach"; ids are unique lowercase names. Any value can be a literal or {"$expr": "<JSONata>"} evaluated over { input, steps.<id>.output }, plus $<as> and $index inside a loop. forEach needs a limit (1-25). Only operations from list_operations can be called. Every LinkedIn page load still counts against daily caps.`;

const handle = toNodeHandler(createMcpHandler(buildServer), { onerror: (e) => console.warn("mcp:", e.message) });

export function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handle(req, res);
}
