/**
 * MCP servers, seen as the console's own tools.
 *
 * A tool from a server is a `ToolDefinition` like any other — same schema shape,
 * same `run`, same approval path — so nothing downstream (the model's tool list,
 * `runTool`, the approval prompt, the transcript) needs to know where a tool came
 * from. Two decisions are made here, and they are the only two that could surprise:
 *
 *   * **the name**: `mcp__<server>__<tool>`, because a server's tool names are its
 *     own and a bare `analyze` would collide with the console's `search_code` the
 *     moment two servers each ship one;
 *   * **approval**: a tool the server declares `readOnlyHint` runs without asking,
 *     since the server has stated it changes nothing; everything else gets an
 *     `inspect`, which is what makes the console's existing approval flow treat it
 *     as a change. A server that declares nothing is treated as a change, which is
 *     the safe way round: an unannotated tool might well write.
 *
 * Discovered once and cached. `refreshMcpTools` exists because a server's tool
 * list is not a constant — REA's, for one, depends on which analysis engines are
 * installed — and re-reading it is cheap next to a console restart.
 */

import { resolveMcpServers } from "./mcp-config.js";
import { McpPool, type McpToolInfo } from "./mcp.js";
import { config } from "./config.js";
import type { ToolDefinition, ToolOutcome } from "./tools.js";

/** The separator between the server name and the tool name in a bridged tool. */
const SEPARATOR = "__";
const PREFIX = `mcp${SEPARATOR}`;

interface Discovered {
  server: string;
  tool: McpToolInfo;
}

let pool: McpPool | null = null;
let discovered: Discovered[] | null = null;
let problems: string[] = [];
let inFlight: Promise<void> | null = null;

/** The pool for this deployment, built from the configuration on first use. */
function currentPool(): McpPool {
  if (pool === null) {
    const resolved = resolveMcpServers(config.mcpServers, config.mcpConfigPaths);
    problems = resolved.problems;
    pool = new McpPool(resolved.servers);
  }
  return pool;
}

/** How the bridge names one server's tool. */
export function bridgeName(server: string, tool: string): string {
  return `${PREFIX}${server}${SEPARATOR}${tool}`;
}

/** The reverse: which server and tool an `mcp__…` name refers to. */
export function parseBridgeName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  const split = rest.indexOf(SEPARATOR);
  if (split <= 0 || split === rest.length - 1) return null;
  // A tool name may itself contain the separator (nothing forbids it), so the
  // split is on the *first* one: the server name is the part that cannot.
  return { server: rest.slice(0, split), tool: rest.slice(split + SEPARATOR.length) };
}

/** Discover the servers' tools, once per process unless `force` is set. */
export async function refreshMcpTools(force = false): Promise<void> {
  if (discovered !== null && !force) return;
  if (inFlight !== null) return inFlight;

  inFlight = (async () => {
    const found = await currentPool().listAll();
    discovered = found.tools;
    if (found.failures.length > 0) problems = [...problems, ...found.failures];
  })();
  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * The bridged tools, discovered if they have not been yet.
 *
 * Never throws: a deployment with no servers, or none that start, simply has no
 * extra tools. The console's own registry is the one thing that must always load.
 */
export async function mcpToolDefinitions(): Promise<ToolDefinition[]> {
  await primeMcpTools();
  return mcpToolSnapshot();
}

/**
 * Discovery once, for the start of a turn. Never throws.
 *
 * Called on the prompt path, so it is written to be harmless when it fails: the
 * model gets the console's own tools and a line in `mcpProblems()` rather than a
 * turn that refuses to start because an analyser is not installed.
 */
export async function primeMcpTools(): Promise<void> {
  try {
    await refreshMcpTools();
  } catch (error) {
    problems = [...problems, `MCP discovery failed: ${(error as Error).message}`];
  }
}

/**
 * The bridged tools as they are known *now*, without discovering anything.
 *
 * Synchronous because the tool registry is: `toolSchemas`, `runTool` and
 * `previewTool` are all called from synchronous code paths, and making them async
 * to accommodate a server that may not be running would spread this concern across
 * the whole agent loop. A turn therefore starts by awaiting `primeMcpTools()`, and
 * every call inside that turn reads this snapshot.
 */
export function mcpToolSnapshot(): ToolDefinition[] {
  const entries = discovered ?? [];
  const names = new Set<string>();
  const tools: ToolDefinition[] = [];

  for (const entry of entries) {
    const name = bridgeName(entry.server, entry.tool.name);
    // Two servers may legitimately expose the same tool name under one server
    // name only if the server name repeats, which the config layer refuses; this
    // is the belt to that braces.
    if (names.has(name)) continue;
    names.add(name);

    const readOnly = entry.tool.annotations?.readOnlyHint === true;
    const description =
      entry.tool.description ??
      `${entry.tool.name}, as offered by the "${entry.server}" MCP server`;

    const tool: ToolDefinition = {
      name,
      description: `${description}\n\nOffered by the "${entry.server}" MCP server over the Model Context Protocol.`,
      parameters: normalizeSchema(entry.tool.inputSchema),
      run: async (args) => runBridged(entry.server, entry.tool.name, args),
    };

    if (!readOnly) {
      // The approval prompt's text: what the server is, and what it is about to be
      // asked. The arguments are shown as-is because their meaning belongs to the
      // server, and paraphrasing them here could only be less accurate.
      tool.inspect = async (args) => ({
        summary: `Ask the "${entry.server}" MCP server to run "${entry.tool.name}" with ${summarizeArguments(args)}`,
      });
    }

    tools.push(tool);
  }

  return tools;
}

async function runBridged(server: string, tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await currentPool().call(server, tool, args);
  return { ok: !result.isError, content: result.text };
}

/** A short, single-line rendering of a tool call's arguments. */
function summarizeArguments(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "no arguments";
  let rendered: string;
  try {
    rendered = JSON.stringify(args);
  } catch {
    rendered = "[unrenderable arguments]";
  }
  return rendered.length > 300 ? `${rendered.slice(0, 300)}…` : rendered;
}

/**
 * The model's view of a tool's parameters.
 *
 * A server's `inputSchema` is JSON Schema and is passed through untouched when it
 * is an object: rewriting someone else's schema is how a call gets silently
 * rejected. A server that declares none gets an empty object schema, which is the
 * one shape the console can promise is valid.
 */
function normalizeSchema(schema: unknown): ToolDefinition["parameters"] {
  if (schema !== null && typeof schema === "object" && !Array.isArray(schema)) {
    const candidate = schema as Record<string, unknown>;
    return {
      type: "object",
      properties:
        candidate.properties !== null && typeof candidate.properties === "object" && !Array.isArray(candidate.properties)
          ? (candidate.properties as Record<string, unknown>)
          : {},
      ...(Array.isArray(candidate.required)
        ? { required: candidate.required.filter((value): value is string => typeof value === "string") }
        : {}),
    };
  }
  return { type: "object", properties: {} };
}

/** Problems seen while resolving or discovering servers, for the operator. */
export function mcpProblems(): string[] {
  return [...problems];
}

/** How many servers are configured, without starting any. */
export function mcpServerNames(): string[] {
  return currentPool().serverNames();
}

/** Drop every discovered tool and close the servers. For tests and reloads. */
export function resetMcpBridge(): void {
  pool?.close();
  pool = null;
  discovered = null;
  problems = [];
  inFlight = null;
}
