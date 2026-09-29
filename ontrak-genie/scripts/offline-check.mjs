#!/usr/bin/env node
/**
 * Prove the offline fallback end to end, on a machine with no reachable model.
 *
 *   npm run offline:check
 *
 * The offline path is the one feature that cannot be checked by any test which
 * needs a working gateway: it only appears when every model on the primary one
 * has failed. So this starts a real server with the primary pointed at a port
 * nothing is listening on, sends one turn through `/api/chat`, and requires the
 * turn to finish on the local model anyway - writing a file, running it, and
 * reporting what it printed.
 *
 * It needs `AGENT_OFFLINE_URL` (and `AGENT_OFFLINE_MODELS`) in `.env`, pointing
 * at something like Ollama, and `dist/server.js` built. With no offline gateway
 * configured, or one that is not answering, it says so and exits 0: the check is
 * about a fallback that is configured, not about one that is installed.
 *
 *   node scripts/offline-check.mjs --keep     leave the scratch workspace behind
 *   node scripts/offline-check.mjs --timeout=600000
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const KEEP = process.argv.includes("--keep");
const TIMEOUT_MS = Number(
  (process.argv.find((arg) => arg.startsWith("--timeout=")) ?? "").split("=")[1] ?? 300_000,
);

/** Minimal .env reader, mirroring src/config.ts. The real environment wins. */
function envFromFile(key) {
  try {
    const raw = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match && match[1] === key) return (match[2] ?? "").trim();
    }
  } catch {
    /* no .env is fine */
  }
  return "";
}

const setting = (key) => (process.env[key] ?? "").trim() || envFromFile(key);

const offlineUrl = setting("AGENT_OFFLINE_URL").replace(/\/+$/, "");
const offlineKey = setting("AGENT_OFFLINE_KEY");
const offlineModels = setting("AGENT_OFFLINE_MODELS")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry !== "");

function skip(reason) {
  console.log(`SKIP  ${reason}`);
  process.exit(0);
}

function fail(reason, detail) {
  console.error(`FAIL  ${reason}`);
  if (detail !== undefined) console.error(detail);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A port nothing is listening on: bind one, note it, give it back. */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const auth = offlineKey === "" ? {} : { Authorization: `Bearer ${offlineKey}` };

if (offlineUrl === "" || offlineModels.length === 0) {
  skip("no offline gateway configured — set AGENT_OFFLINE_URL / AGENT_OFFLINE_MODELS in .env");
}

// Ask the local server directly first. Starting the whole app to discover that
// Ollama is not running would waste a minute and blame the wrong thing.
let advertised;
try {
  const response = await fetch(`${offlineUrl}/models`, {
    headers: auth,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) skip(`${offlineUrl} answered ${response.status}`);
  advertised = await response.json();
} catch (error) {
  skip(`${offlineUrl} is not reachable (${error.cause?.code ?? error.message})`);
}

const ids = (advertised?.data ?? []).map((entry) => entry?.id).filter((id) => typeof id === "string");
const missing = offlineModels.filter((model) => !ids.includes(model));
if (missing.length > 0) {
  skip(`${offlineUrl} is up but does not serve ${missing.join(", ")} (it has ${ids.length} models)`);
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-offline-"));
const dataDir = path.join(workspace, ".agent");
const deadPort = await freePort();
const port = await freePort();

const child = spawn(process.execPath, [path.join(ROOT, "dist", "server.js")], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    WEB_TOKEN: "",
    AGENT_WORKSPACE: workspace,
    AGENT_DATA_DIR: dataDir,
    AGENT_SANDBOX: "host",
    AGENT_APPROVAL: "off",
    // The point of the exercise: the primary gateway is a closed port. Variables
    // set here beat .env, which config.ts reads without overwriting them.
    OMNIROUTE_URL: `http://127.0.0.1:${deadPort}/v1`,
    OMNIROUTE_API_KEY: "unused",
    AGENT_FALLBACK_MODELS: "",
    AGENT_OFFLINE_URL: offlineUrl,
    AGENT_OFFLINE_KEY: offlineKey,
    AGENT_OFFLINE_MODELS: offlineModels.join(","),
    AGENT_HEALTH_INTERVAL_MS: "0",
    AGENT_RETRY_ATTEMPTS: "0",
    AGENT_STREAM: "true",
  },
});

let serverLog = "";
child.stdout.on("data", (chunk) => (serverLog += chunk));
child.stderr.on("data", (chunk) => (serverLog += chunk));

async function shutdown() {
  child.kill("SIGTERM");
  await sleep(300);
  child.kill("SIGKILL");
  if (!KEEP) await rm(workspace, { recursive: true, force: true });
  else console.log(`      kept ${workspace}`);
}

const base = `http://127.0.0.1:${port}`;

// Wait for the server to answer at all. It boots without touching the gateway.
let ready = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  await sleep(200);
  try {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) });
    if (response.ok) {
      ready = true;
      break;
    }
  } catch {
    /* not up yet */
  }
}
if (!ready) {
  await shutdown();
  fail(`the server did not come up on ${base}`, serverLog.slice(-2_000));
}

console.log(`Running one turn with the primary gateway at http://127.0.0.1:${deadPort}/v1`);
console.log(`Offline: ${offlineModels.join(", ")} via ${offlineUrl}`);
console.log("  (a 7B model on CPU: this takes a minute or two)");

const events = [];
let failure = null;

try {
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      maxSteps: 6,
      message:
        "Use write_file to create offline.py containing exactly this one line: " +
        "print('offline fallback works'). Then use run_command to run it with python3 " +
        "and tell me what it printed.",
    }),
  });
  if (!response.ok) fail(`POST /api/chat answered ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });

    let split = pending.indexOf("\n\n");
    while (split !== -1) {
      const frame = pending.slice(0, split);
      pending = pending.slice(split + 2);
      split = pending.indexOf("\n\n");

      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;
        try {
          events.push(JSON.parse(payload));
        } catch {
          /* ignore a malformed frame */
        }
      }
    }
  }
} catch (error) {
  failure = `the turn did not finish: ${error.message}`;
}

const kinds = (type) => events.filter((event) => event.type === type);

if (failure === null) {
  for (const event of events) {
    if (event.type === "notice") console.log(`notice   ${event.text}`);
    if (event.type === "gateway") {
      console.log(`gateway  mode: ${event.mode}, model: ${event.model}, url: ${event.url ?? "-"}`);
    }
    if (event.type === "tool_call") console.log(`tool     ${event.name}`);
    if (event.type === "error") console.log(`error    ${event.message}`);
  }
}

/** Every rule the check enforces, kept together so a failure names itself. */
const rules = [
  [
    "the primary gateway failure was reported",
    () => kinds("notice").some((event) => /on the offline gateway/.test(event.text)),
  ],
  [
    "the turn ran on the offline gateway",
    () => {
      const gateway = kinds("gateway")[0];
      return gateway !== undefined && gateway.mode === "offline";
    },
  ],
  ["the offline model was the one named", () => offlineModels.includes(kinds("gateway")[0]?.model)],
  ["no error event was sent", () => kinds("error").length === 0],
  ["a tool ran successfully", () => kinds("tool_result").some((event) => event.ok === true)],
  ["the turn finished", () => kinds("done").length === 1],
  [
    "the local model wrote the file",
    async () => {
      const written = await readFile(path.join(workspace, "offline.py"), "utf8").catch(() => "");
      return /offline fallback works/.test(written);
    },
  ],
  [
    "and ran it, printing what it promised",
    () => {
      const ran = kinds("tool_result").find((event) => /offline fallback works/.test(event.content));
      return ran !== undefined;
    },
  ],
];

let failures = 0;
if (failure !== null) {
  console.error(`FAIL  ${failure}`);
  failures += 1;
} else {
  for (const [name, rule] of rules) {
    const ok = await rule();
    if (ok) console.log(`  ok  ${name}`);
    else {
      console.error(`  not ok  ${name}`);
      failures += 1;
    }
  }
}

await shutdown();

if (failures > 0) {
  console.error(`\n${rules.length - failures}/${rules.length} offline checks passed`);
  if (serverLog.trim() !== "") console.error("\nserver log:\n" + serverLog.slice(-2000));
  process.exit(1);
}

console.log(`\n${rules.length}/${rules.length} offline checks passed`);
