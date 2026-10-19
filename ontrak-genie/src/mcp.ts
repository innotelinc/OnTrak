/**
 * Genie speaks MCP.
 *
 * Until now the console's tools were the ones it shipped with; a server that
 * exposes tools over the Model Context Protocol had no way in. This is that way:
 * a stdio client, one child process per configured server, JSON-RPC messages
 * newline-delimited exactly as the transport specifies.
 *
 * Deliberately small and dependency-free. There is no SDK here because the wire
 * contract is four methods wide — `initialize`, `tools/list`, `tools/call`, and the
 * `notifications/initialized` that acknowledges the handshake — and a dependency
 * that large would be a bigger thing to keep patched than the protocol it speaks.
 * What is *not* skipped is the awkward half: a server that dies mid-call, a reply
 * for an id nobody is waiting on, a request the *server* sends *us* (which has to be
 * answered or the server hangs), and a timeout that has to outlive a long analysis.
 *
 * Where the servers come from is `mcpServers` in `config.ts`: a JSON array in
 * `MCP_SERVERS`, plus any standard agent config file found on the way
 * (`MCP_CONFIG_PATHS`). Reading the agent-config files is what makes registration
 * mutual — a tool like REA's `setup`, which writes the MCP registration an agent
 * expects at `/root/.agents/mcp.json`, is then *also* registering with Genie, with
 * nothing to configure twice.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { config, type McpServerConfig } from "./config.js";

/** A protocol failure: bad handshake, timeout, or a server that went away. */
export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}

/** One tool as the server describes it (the parts this client reads). */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  /**
   * MCP tool annotations. `readOnlyHint` is the one that matters here: a server
   * that declares a tool read-only is saying it changes nothing, which is what
   * lets the console skip the approval prompt instead of asking on every call.
   */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** The text of a `tools/call` result, and whether the server called it an error. */
export interface McpCallResult {
  text: string;
  isError: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** One server's child process and the requests waiting on it. */
class McpConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private starting: Promise<void> | null = null;
  private tools: McpToolInfo[] | null = null;
  private closed = false;
  private readonly label: string;

  constructor(private readonly server: McpServerConfig) {
    this.label = server.name;
  }

  /** Start the server and complete the handshake once, no matter how many callers ask. */
  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new McpError(`MCP server "${this.label}" was closed`);
    if (this.starting !== null) return this.starting;
    this.starting = this.start();
    try {
      await this.starting;
    } catch (error) {
      // A failed start must not be cached: the next attempt gets a fresh child
      // rather than the same rejection for the life of the process.
      this.starting = null;
      throw error;
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    const child = spawn(this.server.command, this.server.args, {
      env: { ...process.env, ...this.server.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    // stderr is the server's own log. Kept out of the transcript on purpose: a
    // chat that echoed a server's debug output would read as the console talking.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => undefined);
    child.on("exit", (code, signal) => this.onExit(code, signal));
    // A child that cannot even be started — a missing binary, a bad interpreter,
    // an unreadable file — reports an `error` event instead of an exit, and an
    // unhandled one is an uncaught exception: the host console would die because a
    // *server* was misconfigured. Measured: without this listener, a wrong `command`
    // took the whole process down. Same treatment as an exit, for the same reason.
    child.on("error", (error) => this.onExit(null, `start failed: ${(error as Error).message}`));
    // A stdin error means the child is gone; the handlers above report it.
    child.stdin.on("error", () => undefined);

    const version = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ontrak-genie", version: "1.0.0" },
    }, config.mcpStartupTimeoutMs);
    if (version === null || typeof version !== "object") {
      throw new McpError(`MCP server "${this.label}" answered the handshake with ${JSON.stringify(version)}`);
    }

    // The handshake is only complete once the client says so.
    this.notify("notifications/initialized");
  }

  private onExit(code: number | null, signal: string | null): void {
    const reason = `MCP server "${this.label}" exited (${signal ?? `code ${code ?? "unknown"}`})`;
    this.child = null;
    this.tools = null;
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      this.pending.delete(id);
      waiter.reject(new McpError(reason));
    }
    if (!this.closed) {
      // Not fatal to the console: the next call starts a fresh child, which is
      // what makes a crashed analyser recoverable without a restart.
      this.starting = null;
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // Newline-delimited JSON. A server that emits a pretty-printed object still
    // works: the split is on newlines, and blank lines are skipped.
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== "") this.onMessage(line);
    }
  }

  private onMessage(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return; // A line the protocol did not define; ignore rather than crash.
    }

    const id = message.id;
    if (id === undefined || id === null) return; // A notification, which needs no reply.

    // A request *from* the server. This client advertises no capabilities, so the
    // honest answer is "method not found" — but it has to be *an* answer, because a
    // server waiting on one blocks forever.
    if (typeof message.method === "string") {
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `client does not implement ${message.method}` },
      });
      return;
    }

    // Only a numeric id can be one this client sent: the protocol allows string
    // ids, and those belong to a server talking to somebody else.
    const numericId = typeof id === "number" ? id : null;
    const waiter = numericId === null ? undefined : this.pending.get(numericId);
    if (numericId === null || waiter === undefined) return; // A reply to something already timed out.

    this.pending.delete(numericId);
    clearTimeout(waiter.timer);
    if (message.error !== undefined && message.error !== null) {
      const error = message.error as { message?: unknown; code?: unknown };
      waiter.reject(new McpError(`MCP server "${this.label}": ${String(error.message ?? error.code ?? "unknown error")}`));
      return;
    }
    waiter.resolve(message.result);
  }

  private write(message: Record<string, unknown>): void {
    const child = this.child;
    if (child === null) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  /** Send a request and wait for its reply, or fail on the timeout. */
  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (child === null) return Promise.reject(new McpError(`MCP server "${this.label}" is not running`));

    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP server "${this.label}" did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      // Node keeps the process alive for a pending timer; this keeps a slow server
      // from holding the console open on shutdown.
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Every tool this server offers, from a listing cached for the process's life. */
  async listTools(): Promise<McpToolInfo[]> {
    if (this.tools !== null) return this.tools;
    await this.ensureStarted();

    const collected: McpToolInfo[] = [];
    let cursor: string | null = null;
    for (;;) {
      const params: Record<string, unknown> = cursor === null ? {} : { cursor };
      const result = (await this.request("tools/list", params, config.mcpStartupTimeoutMs)) as
        | { tools?: unknown; nextCursor?: unknown }
        | null;
      const rows = result?.tools;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row === null || typeof row !== "object") continue;
          const tool = row as Record<string, unknown>;
          if (typeof tool.name !== "string" || tool.name === "") continue;
          const info: McpToolInfo = { name: tool.name };
          if (typeof tool.description === "string") info.description = tool.description;
          if (tool.inputSchema !== undefined) info.inputSchema = tool.inputSchema;
          if (tool.annotations !== null && typeof tool.annotations === "object") {
            const annotations = tool.annotations as Record<string, unknown>;
            info.annotations = {
              readOnlyHint: annotations.readOnlyHint === true,
              destructiveHint: annotations.destructiveHint === true,
            };
          }
          collected.push(info);
        }
      }
      const next = result?.nextCursor;
      if (typeof next !== "string" || next === "") break;
      cursor = next;
    }

    this.tools = collected;
    return collected;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.ensureStarted();
    const result = (await this.request(
      "tools/call",
      { name, arguments: args },
      config.mcpToolTimeoutMs,
    )) as { content?: unknown; isError?: unknown } | null;

    const parts: string[] = [];
    const blocks = result?.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block === null || typeof block !== "object") continue;
        const entry = block as Record<string, unknown>;
        if (entry.type === "text" && typeof entry.text === "string") {
          parts.push(entry.text);
        } else if (typeof entry.type === "string") {
          // Images, audio and embedded resources have no place in a text
          // transcript, so the read is reported rather than silently dropped.
          parts.push(`[${entry.type} content omitted: the console returns text]`);
        }
      }
    }
    const text = parts.join("\n").trim();
    return {
      text: text === "" ? "(the server returned no text content)" : text,
      isError: result?.isError === true,
    };
  }

  /** Drop the cached listing, so the next call re-reads what the server offers. */
  forgetTools(): void {
    this.tools = null;
  }

  close(): void {
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (child !== null) {
      child.stdin.end();
      child.kill("SIGTERM");
    }
  }
}

/**
 * Every configured server, connected on demand.
 *
 * One connection per server name for the life of the process: an analyser that
 * takes a second to start should pay that once, not once per tool call. A server
 * that fails to start is remembered as failed *for this call* and retried on the
 * next, so a machine that was briefly out of resources comes back by itself.
 */
export class McpPool {
  private readonly connections = new Map<string, McpConnection>();

  constructor(private readonly servers: McpServerConfig[]) {}

  /** Which servers this deployment knows about, in configuration order. */
  serverNames(): string[] {
    return this.servers.map((server) => server.name);
  }

  private connection(name: string): McpConnection | null {
    const server = this.servers.find((candidate) => candidate.name === name);
    if (server === undefined) return null;
    const existing = this.connections.get(name);
    if (existing !== undefined) return existing;
    const created = new McpConnection(server);
    this.connections.set(name, created);
    return created;
  }

  /**
   * Every tool from every server, as `[server, tool]` pairs.
   *
   * A server that cannot be reached is reported back rather than thrown, because
   * one broken analyser must not take the console's own tools down with it: the
   * caller decides whether the failure is worth mentioning to the model.
   */
  async listAll(): Promise<{ tools: { server: string; tool: McpToolInfo }[]; failures: string[] }> {
    const tools: { server: string; tool: McpToolInfo }[] = [];
    const failures: string[] = [];
    const results = await Promise.all(
      this.servers.map(async (server) => {
        const connection = this.connection(server.name);
        if (connection === null) return { server: server.name, tools: [] as McpToolInfo[], failure: null };
        try {
          return { server: server.name, tools: await connection.listTools(), failure: null };
        } catch (error) {
          return { server: server.name, tools: [] as McpToolInfo[], failure: (error as Error).message };
        }
      }),
    );
    for (const result of results) {
      if (result.failure !== null) {
        failures.push(result.failure);
        continue;
      }
      for (const tool of result.tools) tools.push({ server: result.server, tool });
    }
    return { tools, failures };
  }

  /** Call one tool on one server. */
  async call(server: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const connection = this.connection(server);
    if (connection === null) throw new McpError(`no MCP server named "${server}"`);
    return connection.callTool(tool, args);
  }

  /** Forget the cached tool listings of every server (used by tests and reloads). */
  forgetTools(): void {
    for (const connection of this.connections.values()) connection.forgetTools();
  }

  close(): void {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}
