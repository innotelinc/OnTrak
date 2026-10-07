/**
 * The CLI, end to end, as a program.
 *
 * Everything else tests the CLI's parts; this runs the thing a person runs. It
 * spawns the built `dist/cli/main.js` as a child process against a real server
 * with a scripted gateway behind it, and reads what came out of the terminal —
 * so the SSE parsing, the event rendering, the approval round trip and the exit
 * code are all exercised the way a shell would exercise them.
 *
 * The gateway is the same stand-in `http.test.ts` uses: it answers
 * `/v1/chat/completions` from a scripted queue, streaming frames. Nothing here
 * needs a model or a network.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

interface Reply {
  content?: string;
  toolCall?: { name: string; args: unknown };
}

const queue: Reply[] = [];

function sse(res: http.ServerResponse, frames: unknown[]): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const gateway = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const url = req.url ?? "";
    if (url.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fake/model" }] }));
      return;
    }
    if (!url.startsWith("/v1/chat/completions")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const reply = queue.shift() ?? { content: "nothing scripted" };
    if (reply.toolCall) {
      sse(res, [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_scripted",
                    type: "function",
                    function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);
      return;
    }
    sse(res, [
      { choices: [{ delta: { content: reply.content ?? "" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
  });
});

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "genie-cli-e2e-"));
await fs.writeFile(path.join(workspace, "hello.txt"), "hello from disk\n", "utf8");
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const gatewayPort = (gateway.address() as AddressInfo).port;

process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_DATA_DIR = path.join(workspace, ".agent");
process.env.AGENT_SANDBOX = "host";
process.env.AGENT_APPROVAL = "risky";
process.env.AGENT_APPROVAL_TIMEOUT_MS = "5000";
process.env.AGENT_MODEL = "fake/model";
process.env.AGENT_FALLBACK_MODELS = "";
process.env.AGENT_FREE_MODELS = "fake/model";
process.env.AGENT_FORCE_AUTO_MODEL = "false";
process.env.AGENT_RETRY_ATTEMPTS = "1";
process.env.AGENT_RETRY_DELAY_MS = "0";
process.env.OMNIROUTE_URL = `http://127.0.0.1:${gatewayPort}/v1`;
process.env.AGENT_OFFLINE_URL = "";
process.env.WEB_TOKEN = "cli-e2e-token";

const { createServer } = await import("../server.js");
const { ensureWorkspace } = await import("../workspace.js");

await ensureWorkspace();
const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const TOKEN = "cli-e2e-token";
const CLI = path.resolve(import.meta.dirname, "..", "cli", "main.js");

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  await fs.rm(workspace, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the built CLI as a program, exactly as a shell would. */
function runCli(args: string[], timeoutMs = 30_000): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: workspace,
      env: {
        ...process.env,
        // A real config must not leak in, and no colour keeps the output
        // assertable without stripping escape codes.
        ONTRAK_GENIE_CONFIG: path.join(workspace, "cli-config.json"),
        ONTRAK_GENIE_TOKEN: "",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/* -------------------------------------------------------------------- tests */

test("ask runs a turn, runs a tool and prints the answer", async () => {
  const before = queue.length;
  queue.push(
    { toolCall: { name: "read_file", args: { path: "hello.txt" } } },
    { content: "The file says hello." },
  );
  const result = await runCli(["ask", "read hello.txt", "--url", base, "--token", TOKEN]);
  assert.equal(result.code, 0, `exit code ${result.code}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /◆ read_file/, "the tool call should be rendered as a card");
  assert.match(result.stdout, /hello from disk/, "the tool result should be shown");
  assert.match(result.stdout, /The file says hello\./, "the final answer should be printed");
  assert.ok(queue.length <= before, "the scripted replies should have been consumed");
});

test("a gated command is denied when there is no terminal to ask", async () => {
  // The proof that it did not run is a file the command would have created, not
  // the text of the prompt: the prompt necessarily quotes the command.
  const marker = path.join(workspace, "denied-marker.txt");
  await fs.rm(marker, { force: true });
  queue.push(
    { toolCall: { name: "run_command", args: { command: "touch denied-marker.txt" } } },
    { content: "I did not run it." },
  );
  const result = await runCli(["ask", "create a marker", "--url", base, "--token", TOKEN]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /denied/, "a crash cannot consent, so the default is deny");
  assert.equal(await fs.stat(marker).then(() => true, () => false), false, "a denied command must not have run");
});

test("--yes approves a gated command and it actually runs", async () => {
  const marker = path.join(workspace, "approved-marker.txt");
  await fs.rm(marker, { force: true });
  queue.push(
    { toolCall: { name: "run_command", args: { command: "touch approved-marker.txt" } } },
    { content: "Ran it." },
  );
  const result = await runCli(["ask", "create a marker", "--yes", "--url", base, "--token", TOKEN]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /approved/);
  assert.equal(await fs.stat(marker).then(() => true, () => false), true, "the approved command should have run");
});

test("sessions lists the chats the CLI created", async () => {
  const result = await runCli(["sessions", "--json", "--url", base, "--token", TOKEN]);
  assert.equal(result.code, 0);
  const sessions = JSON.parse(result.stdout) as { id: string }[];
  assert.ok(Array.isArray(sessions));
  assert.ok(sessions.length >= 1, "the turns above should have left chats behind");
});

test("a bad credential is reported, not hidden", async () => {
  const result = await runCli(["sessions", "--url", base, "--token", "wrong-token"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unauthorized/i);
});

test("an unreachable server is reported rather than hanging", async () => {
  const result = await runCli(["sessions", "--url", "http://127.0.0.1:9", "--token", TOKEN]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot reach/i);
});

test("whoami reports the server, identity and plan", async () => {
  const result = await runCli(["whoami", "--url", base, "--token", TOKEN]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /server\s+http/);
  assert.match(result.stdout, /approval\s+risky/);
});
