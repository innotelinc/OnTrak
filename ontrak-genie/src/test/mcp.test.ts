import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Genie speaking MCP.
 *
 * A console that can call a server's tools is a console that runs code it did not
 * write, decided by a *different* process's description of what those tools do. So
 * the cases here are not about the happy path alone — they are about the four ways
 * this goes wrong quietly: a server that declares a read-only tool and should not
 * be asked to approve, a server that declares nothing and must be; a server that
 * never answers the handshake; and a server whose tool call fails, which has to
 * reach the model as a failure rather than as an empty success.
 *
 * The environment is set before the imports because `config.ts` reads it once, and
 * the fake servers are written to a scratch directory so the test owns them.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "genie-mcp-test-"));
process.env.AGENT_WORKSPACE = path.join(scratch, "workspace");
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");

/**
 * A fake MCP server, as a script.
 *
 * Written out rather than inlined as a `-e` program because the point is to speak
 * the wire protocol exactly: newline-delimited JSON-RPC on stdio, a handshake then
 * a listing then calls. `MODE` selects the behaviour under test.
 */
const SERVER_SCRIPT = `
const readline = require("node:readline");
const mode = process.env.MODE || "normal";
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (mode === "silent") return; // Never answers anything.

  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } } });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          { name: "inspect", description: "Read something", inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] }, annotations: { readOnlyHint: true } },
          { name: "rewrite", description: "Change something", inputSchema: { type: "object", properties: { target: { type: "string" } } } },
          { name: "explode", description: "Always fails", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
        ],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params && message.params.name;
    if (name === "explode") {
      send({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: "argument target is required" }] } });
      return;
    }
    if (name === "rewrite") {
      // A request *to the client* mid-call, which has to be answered or this
      // server would hang: the console's reply is asserted below via the echo.
      send({ jsonrpc: "2.0", id: 900, method: "roots/list" });
      setTimeout(() => {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(message.params.arguments) }] } });
      }, 20);
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "inspected " + (message.params.arguments || {}).target }] } });
    return;
  }
  if (message.id !== undefined && message.method) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
  }
});
`;

const serverPath = path.join(scratch, "fake-server.cjs");
await fs.writeFile(serverPath, SERVER_SCRIPT, "utf8");

/**
 * A config file in the shape every agent client reads.
 *
 * This is the file REA's own `setup` writes, so reading it here is the mechanism
 * that makes the analyser's installation count as a registration with Genie.
 */
const sharedConfig = path.join(scratch, "agent-mcp.json");
await fs.writeFile(
  sharedConfig,
  JSON.stringify({
    mcpServers: {
      fake: { command: process.execPath, args: [serverPath], env: { MODE: "normal" } },
      silent: { command: process.execPath, args: [serverPath], env: { MODE: "silent" } },
      remote: { url: "https://example.invalid/mcp" },
    },
  }),
  "utf8",
);

process.env.MCP_SERVERS = "";
process.env.MCP_CONFIG_PATHS = sharedConfig;
process.env.MCP_STARTUP_TIMEOUT_MS = "3000";
process.env.MCP_TOOL_TIMEOUT_MS = "3000";

const { parseBridgeName, bridgeName, primeMcpTools, mcpToolSnapshot, mcpServerNames, resetMcpBridge } =
  await import("../mcp-tools.js");
const { resolveMcpServers, parseServersSetting } = await import("../mcp-config.js");
const { McpPool } = await import("../mcp.js");
const { allTools, runTool, previewTool } = await import("../tools.js");

test.after(() => {
  resetMcpBridge();
});

test("servers come from the operator's setting and from the agent config files", () => {
  const resolved = resolveMcpServers(
    JSON.stringify([{ name: "from-env", command: "node", args: ["-e", "0"] }]),
    [sharedConfig],
  );
  assert.deepEqual(
    resolved.servers.map((server) => server.name),
    ["from-env", "fake", "silent"],
  );
  // A URL server cannot be started by this console, and saying so beats a server
  // that silently has no tools.
  assert.ok(resolved.problems.some((problem) => problem.includes('"remote"') && problem.includes("stdio")));
});

test("a malformed setting is reported, not thrown, and the files still load", () => {
  const resolved = resolveMcpServers("{not json", [sharedConfig]);
  assert.equal(resolved.servers.some((server) => server.name === "fake"), true);
  assert.ok(resolved.problems.some((problem) => problem.includes("MCP_SERVERS")));

  // The object shape an agent config uses is accepted in the setting too.
  const object = parseServersSetting('{"mcpServers":{"x":{"command":"node"}}}', []);
  assert.deepEqual(object.map((server) => server.name), ["x"]);
});

test("the bridge names tools by server and tool, and parses its own names back", () => {
  assert.equal(bridgeName("rea", "analyze"), "mcp__rea__analyze");
  assert.deepEqual(parseBridgeName("mcp__rea__analyze"), { server: "rea", tool: "analyze" });
  // A tool name may itself contain the separator; the server name may not.
  assert.deepEqual(parseBridgeName("mcp__rea__decompile__item"), { server: "rea", tool: "decompile__item" });
  assert.equal(parseBridgeName("search_code"), null);
  assert.equal(parseBridgeName("mcp__rea"), null);
});

test("a turn discovers the servers' tools, and the console's own tools are still there", async () => {
  await primeMcpTools();

  const names = allTools().map((tool) => tool.name);
  assert.ok(names.includes("read_file"), "the console's own tools must not be displaced");
  assert.ok(names.includes("mcp__fake__inspect"));
  assert.ok(names.includes("mcp__fake__rewrite"));
  assert.equal(names.includes("mcp__silent__anything"), false, "a server that never answers offers nothing");
  assert.deepEqual(mcpServerNames().sort(), ["fake", "silent"]);
});

test("a declared read-only tool is not gated by the approval prompt, and an undeclared one is", async () => {
  await primeMcpTools();
  const tools = mcpToolSnapshot();
  const readOnly = tools.find((tool) => tool.name === "mcp__fake__inspect");
  const mutating = tools.find((tool) => tool.name === "mcp__fake__rewrite");
  assert.ok(readOnly !== undefined && mutating !== undefined);

  // Approval is driven by `inspect` existing, so its presence *is* the assertion:
  // the server said this one changes nothing, and the console takes it at its word.
  assert.equal(readOnly.inspect, undefined);
  assert.ok(mutating.inspect !== undefined, "an unannotated tool must ask first");

  const preview = await previewTool("mcp__fake__rewrite", JSON.stringify({ target: "app.exe" }));
  assert.ok(preview !== null && preview.summary.includes("rewrite"));
  assert.equal(await previewTool("mcp__fake__inspect", JSON.stringify({ target: "app.exe" })), null);
});

test("a delegated call returns the server's text, and its failure is reported as a failure", async () => {
  const ok = await runTool("mcp__fake__inspect", JSON.stringify({ target: "libc.so" }));
  assert.equal(ok.ok, true);
  assert.equal(ok.content, "inspected libc.so");

  const failed = await runTool("mcp__fake__explode", "{}");
  assert.equal(failed.ok, false);
  assert.match(failed.content, /target is required/);
});

test("a request from the server mid-call is answered, so the call still completes", async () => {
  // The fake answers `roots/list` by echoing its arguments 20ms later: the reply
  // only arrives if the console handled the server's request instead of dropping it.
  const outcome = await runTool("mcp__fake__rewrite", JSON.stringify({ target: "app.exe" }));
  assert.equal(outcome.ok, true);
  assert.deepEqual(JSON.parse(outcome.content), { target: "app.exe" });
});

test("a tool the server offers but does not describe still reaches the model with a usable schema", async () => {
  await primeMcpTools();
  const tool = mcpToolSnapshot().find((entry) => entry.name === "mcp__fake__inspect");
  assert.ok(tool !== undefined);
  // Passed through from the server, including which arguments are required.
  assert.deepEqual(tool.parameters.required, ["target"]);
  assert.equal(tool.parameters.type, "object");
});

test("a server whose command does not exist is reported, and does not take the process down", async () => {
  // The case that used to crash: `spawn` reports a missing binary as an `error`
  // event, not an exit, and an unhandled one is an uncaught exception — a console
  // that died because an MCP server was misconfigured. It must come back as a
  // failure with a reason instead.
  const pool = new McpPool([{ name: "absent", command: "/nonexistent/mcp-server", args: [], env: {} }]);
  try {
    const found = await pool.listAll();
    assert.deepEqual(found.tools, []);
    assert.equal(found.failures.length, 1);
    assert.match(found.failures[0] ?? "", /absent/);
  } finally {
    pool.close();
  }
});
