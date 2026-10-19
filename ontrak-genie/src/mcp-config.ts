/**
 * Which MCP servers this deployment has, and where that was decided.
 *
 * Two sources, deliberately, because the tools come from two directions:
 *
 *   1. **`MCP_SERVERS`** — the operator's own list, a JSON array in the
 *      environment, so a deployment states its servers in the place it states
 *      everything else;
 *   2. **the standard agent config files** in `MCP_CONFIG_PATHS` — the
 *      `{"mcpServers": {…}}` shape every agent client already reads. This is what
 *      makes a tool's own installer count: REA's `setup` writes that file, and a
 *      console that reads it is registered with by the same command, with nobody
 *      configuring a second time.
 *
 * Files are read in order, and a server named in the environment wins over one of
 * the same name in a file: the explicit setting is the one the operator typed most
 * recently, and shadowing it silently would be the wrong way round.
 *
 * Nothing here throws. A malformed `MCP_SERVERS` value, or a config file that is
 * not valid JSON, is reported in `problems` and skipped — a typo in one server's
 * configuration must not stop the console from starting, or from loading the rest.
 */

import fs from "node:fs";

import type { McpServerConfig } from "./config.js";

/** One entry as it appears in an agent config file or in `MCP_SERVERS`. */
interface RawServer {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  /** Some clients spell the same thing `url`; a stdio console cannot dial it. */
  url?: unknown;
  /** The per-service form some clients use. */
  servers?: unknown;
}

export interface ResolvedMcpServers {
  servers: McpServerConfig[];
  problems: string[];
}

/** Coerce one raw entry into a server this console can actually start. */
function coerceServer(name: string, raw: unknown, problems: string[]): McpServerConfig | null {
  if (raw === null || typeof raw !== "object") {
    problems.push(`MCP server "${name}" is not an object`);
    return null;
  }
  const entry = raw as RawServer;
  if (entry.url !== undefined && entry.command === undefined) {
    // Reporting this is the point: a remote server would otherwise look like a
    // server that simply has no tools, which is a confusing way to learn the
    // console only speaks stdio.
    problems.push(`MCP server "${name}" is a URL server; this console starts stdio servers only`);
    return null;
  }
  if (typeof entry.command !== "string" || entry.command.trim() === "") {
    problems.push(`MCP server "${name}" has no command`);
    return null;
  }

  const args: string[] = [];
  if (Array.isArray(entry.args)) {
    for (const value of entry.args) {
      if (typeof value === "string") args.push(value);
      else problems.push(`MCP server "${name}" has a non-string argument, which was dropped`);
    }
  } else if (entry.args !== undefined) {
    problems.push(`MCP server "${name}" has a non-list "args"`);
  }

  const env: Record<string, string> = {};
  if (entry.env !== null && typeof entry.env === "object" && !Array.isArray(entry.env)) {
    for (const [key, value] of Object.entries(entry.env as Record<string, unknown>)) {
      if (typeof value === "string") env[key] = value;
    }
  }

  return { name, command: entry.command, args, env };
}

/** Parse the operator's `MCP_SERVERS` value: a JSON array, or an object of servers. */
export function parseServersSetting(raw: string, problems: string[]): McpServerConfig[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    problems.push(`MCP_SERVERS is not valid JSON (${(error as Error).message})`);
    return [];
  }

  // Both shapes appear in the wild: a list of named servers, and the
  // `{"mcpServers": {…}}` object an agent config file uses. Accepting both means an
  // operator can paste either one.
  let entries: [string, unknown][] = [];
  if (Array.isArray(parsed)) {
    entries = parsed.map((entry, index) => {
      const name = entry !== null && typeof entry === "object" && typeof (entry as RawServer & { name?: unknown }).name === "string"
        ? String((entry as { name: string }).name)
        : `server-${index + 1}`;
      return [name, entry];
    });
  } else if (parsed !== null && typeof parsed === "object") {
    const object = parsed as Record<string, unknown>;
    const inner = object.mcpServers ?? object.servers ?? object;
    if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
      entries = Object.entries(inner as Record<string, unknown>);
    } else {
      problems.push("MCP_SERVERS has no server entries");
    }
  } else {
    problems.push("MCP_SERVERS must be a JSON array or object");
  }

  const servers: McpServerConfig[] = [];
  for (const [name, entry] of entries) {
    const server = coerceServer(name, entry, problems);
    if (server !== null) servers.push(server);
  }
  return servers;
}

/** Read one agent-style config file. A missing file is not a problem. */
function readConfigFile(path: string, problems: string[]): McpServerConfig[] {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    problems.push(`${path} is not valid JSON (${(error as Error).message})`);
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    problems.push(`${path} does not hold an object`);
    return [];
  }
  const object = parsed as Record<string, unknown>;
  const inner = object.mcpServers ?? object.servers;
  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return [];

  const servers: McpServerConfig[] = [];
  for (const [name, entry] of Object.entries(inner as Record<string, unknown>)) {
    const server = coerceServer(name, entry, problems);
    if (server !== null) servers.push(server);
  }
  return servers;
}

/**
 * Every server this deployment will start, environment first, then files.
 *
 * A name appearing twice keeps the first entry — the environment's — and the
 * duplicate is noted, because two different commands under one name is a
 * configuration mistake worth seeing rather than a mystery to debug later.
 */
export function resolveMcpServers(setting: string, configPaths: string[]): ResolvedMcpServers {
  const problems: string[] = [];
  const servers: McpServerConfig[] = [];
  const seen = new Set<string>();

  const add = (server: McpServerConfig): void => {
    if (seen.has(server.name)) {
      problems.push(`MCP server "${server.name}" is configured more than once; the first entry is used`);
      return;
    }
    seen.add(server.name);
    servers.push(server);
  };

  for (const server of parseServersSetting(setting, problems)) add(server);
  for (const path of configPaths) {
    for (const server of readConfigFile(path, problems)) add(server);
  }

  return { servers, problems };
}
