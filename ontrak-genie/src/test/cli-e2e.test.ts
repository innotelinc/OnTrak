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

/* -------------------------------------------------------------- projects -- */

/** The flags every project call here needs, so a case reads as its own words. */
const AT = ["--url", base, "--token", TOKEN];

function jsonOf<T>(run: Run, what: string): T {
  assert.equal(run.code, 0, `${what}: exit ${run.code}\n${run.stdout}\n${run.stderr}`);
  return JSON.parse(run.stdout) as T;
}

test("a project is saved, exported to one file and loaded back", async () => {
  // Save. `--json` rather than the sentence, because the test needs the
  // directory the server derived, and the payload is the machine-readable path.
  const saved = jsonOf<{ id: string; name: string; dir: string; path: string }>(
    await runCli(["projects", "new", "E2E Project", "--json", ...AT]),
    "projects new",
  );
  assert.equal(saved.name, "E2E Project");
  assert.match(saved.dir, /^e2e-project-[0-9a-f]{6}$/, "the directory is derived from the name");

  // Something for the bundle to carry: a file, in a subdirectory, written by
  // this test and not by the CLI.
  await fs.mkdir(path.join(saved.path, "src"), { recursive: true });
  await fs.writeFile(path.join(saved.path, "src", "notes.md"), "carried in the bundle\n", "utf8");

  // The list, as a person sees it: the row, and the open one marked.
  const list = await runCli(["projects", ...AT]);
  assert.equal(list.code, 0, `${list.stdout}\n${list.stderr}`);
  assert.match(list.stdout, /E2E Project/);
  assert.match(list.stdout, /\(open\)/);

  // `-o -` is the pipe shape: the bundle on stdout, the sentence on stderr.
  const piped = await runCli(["projects", "export", "-o", "-", ...AT]);
  assert.equal(piped.code, 0, piped.stderr);
  const pipedBundle = JSON.parse(piped.stdout) as { format: string; files: { path: string }[] };
  assert.equal(pipedBundle.format, "genie.project");
  assert.deepEqual(
    pipedBundle.files.map((file) => file.path),
    ["src/notes.md"],
    "stdout must be the bundle and nothing else",
  );

  // Export to a path, using the open project by default.
  const bundlePath = path.join(workspace, "e2e-bundle.json");
  const exported = jsonOf<{ filename: string; files: number; path: string; skipped: string[] }>(
    await runCli(["projects", "export", "--out", bundlePath, "--json", ...AT]),
    "projects export",
  );
  assert.equal(exported.filename, "e2e-project.genie-project.json");
  assert.equal(exported.files, 1);
  assert.deepEqual(exported.skipped, []);
  assert.equal(exported.path, bundlePath);

  // Load it back. The name is taken, so the server counts rather than overwrites
  // — which is also the proof that this is a new project and not the old one.
  const loaded = jsonOf<{ project: { name: string; path: string }; files: number }>(
    await runCli(["projects", "import", bundlePath, "--json", ...AT]),
    "projects import",
  );
  assert.equal(loaded.project.name, "E2E Project (2)");
  assert.notEqual(loaded.project.path, saved.path);
  assert.equal(loaded.files, 1);
  assert.equal(
    await fs.readFile(path.join(loaded.project.path, "src", "notes.md"), "utf8"),
    "carried in the bundle\n",
    "the file must have survived the round trip through the terminal",
  );
});

test("a project is named by its row number, not just its id", async () => {
  // The import above opened its project, so it is the most recent and row 1.
  const list = await runCli(["projects", "--json", ...AT]);
  const projects = jsonOf<{ id: string; name: string }[]>(list, "projects --json");
  const first = projects[0];
  assert.ok(first !== undefined, "the round trip above should have left projects behind");

  const opened = await runCli(["projects", "open", "1", ...AT]);
  assert.equal(opened.code, 0, `${opened.stdout}\n${opened.stderr}`);
  assert.match(opened.stdout, /^open\s/, "the confirmation names the project it opened");
  assert.ok(opened.stdout.includes(first.name), `row 1 is ${first.name}:\n${opened.stdout}`);
});

test("a file that is not a bundle is refused, not half-loaded", async () => {
  const notABundle = path.join(workspace, "not-a-bundle.json");
  await fs.writeFile(notABundle, '{"hello":"world"}\n', "utf8");

  const result = await runCli(["projects", "import", notABundle, ...AT]);
  assert.equal(result.code, 1, "a refusal from the server is not a usage error");
  assert.match(result.stderr, /not a Genie project bundle/);
});

test("a subcommand nobody defined is a usage error, and says what exists", async () => {
  const result = await runCli(["projects", "wibble", ...AT]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown projects subcommand/);
  assert.match(result.stderr, /export/);
});

test("naming a project that does not exist is a usage error, not a 404 page", async () => {
  const result = await runCli(["projects", "open", "No Such Project", ...AT]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no project matches/);
});

test("remove forgets the project, and only --files deletes the work", async () => {
  const kept = jsonOf<{ name: string; path: string }>(
    await runCli(["projects", "new", "Keep Me", "--json", ...AT]),
    "projects new",
  );
  await fs.writeFile(path.join(kept.path, "work.txt"), "the work\n", "utf8");

  // The default cannot lose anything: the entry goes, the directory stays.
  const removed = await runCli(["projects", "remove", "Keep Me", ...AT]);
  assert.equal(removed.code, 0, `${removed.stdout}\n${removed.stderr}`);
  assert.match(removed.stdout, /its folder is untouched/);
  assert.equal(
    await fs.readFile(path.join(kept.path, "work.txt"), "utf8"),
    "the work\n",
    "removing a project must not delete its files unless asked",
  );
  const listed = jsonOf<{ name: string }[]>(await runCli(["projects", "--json", ...AT]), "projects --json");
  assert.equal(listed.some((project) => project.name === "Keep Me"), false);

  // `--files` is the destructive spelling, and it is the only one that is.
  const doomed = jsonOf<{ name: string; path: string }>(
    await runCli(["projects", "new", "Delete Me", "--json", ...AT]),
    "projects new",
  );
  const purged = await runCli(["projects", "remove", "Delete Me", "--files", ...AT]);
  assert.equal(purged.code, 0, `${purged.stdout}\n${purged.stderr}`);
  assert.match(purged.stdout, /its folder went with it/);
  assert.equal(
    await fs.stat(doomed.path).then(() => true, () => false),
    false,
    "--files is the whole point of the flag: the directory goes too",
  );
});
