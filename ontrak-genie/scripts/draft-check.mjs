#!/usr/bin/env node
/**
 * Check that a real turn on the configured model actually previews the file it
 * writes.
 *
 *   npm run draft:check                  # report what the gateway does
 *   npm run draft:check -- --require-fragmented
 *
 * The preview pane is fed by `draft` events, which exist because a model writes a
 * file through a tool call whose arguments stream in. That is a property of the
 * provider and the gateway, not of this code, and it is one that can quietly go
 * away: a gateway that buffers the whole call into the final JSON, or a provider
 * that switches to a different transport, leaves the pane showing nothing until the
 * write is already finished - with no error anywhere to say so.
 *
 * So this runs one real turn against whatever `AGENT_MODEL` is configured, and
 * reports how the call arrived: how many drafts, how the body grew, and whether it
 * came in one piece. One draft means the pane cannot show a file before it is
 * complete; `--require-fragmented` turns that into a failure, for pinning a
 * provider to the behaviour you actually want.
 *
 * It needs a reachable gateway and `dist/server.js` built. With no gateway it says
 * so and exits 0 - the check is about a gateway that is there.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const KEEP = process.argv.includes("--keep");
const REQUIRE_FRAGMENTED = process.argv.includes("--require-fragmented");
const TIMEOUT_MS = Number(
  (process.argv.find((arg) => arg.startsWith("--timeout=")) ?? "").split("=")[1] ?? 180_000,
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

const gatewayUrl = setting("OMNIROUTE_URL").replace(/\/+$/, "") || "http://127.0.0.1:20128/v1";
const gatewayKey = setting("OMNIROUTE_API_KEY");
const model = setting("AGENT_MODEL") || "auto/coding";

function skip(reason) {
  console.log(`SKIP  ${reason}`);
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

try {
  const response = await fetch(`${gatewayUrl}/models`, {
    headers: gatewayKey === "" ? {} : { Authorization: `Bearer ${gatewayKey}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) skip(`${gatewayUrl} answered ${response.status}`);
} catch (error) {
  skip(`${gatewayUrl} is not reachable (${error.cause?.code ?? error.message})`);
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-draft-"));
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
    AGENT_DATA_DIR: path.join(workspace, ".agent"),
    AGENT_SANDBOX: "host",
    AGENT_APPROVAL: "off",
    AGENT_HEALTH_INTERVAL_MS: "0",
    // The chain is left exactly as configured: this is a check of *that* model on
    // *that* gateway, which is the part that can change without this repo moving.
  },
});

let serverLog = "";
child.stdout.on("data", (chunk) => (serverLog += chunk));
child.stderr.on("data", (chunk) => (serverLog += chunk));

const base = `http://127.0.0.1:${port}`;

async function shutdown() {
  child.kill("SIGTERM");
  await sleep(300);
  child.kill("SIGKILL");
  if (!KEEP) await rm(workspace, { recursive: true, force: true });
  else console.log(`      kept ${workspace}`);
}

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
  console.error(`FAIL  the server did not come up on ${base}`);
  console.error(serverLog.slice(-2_000));
  process.exit(1);
}

console.log(`Model    ${model}`);
console.log(`Gateway  ${gatewayUrl}`);
console.log("Writing one small file through a real turn...\n");

const events = [];
let failure = null;

try {
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      maxSteps: 4,
      message:
        "Use write_file to create draft_check.py containing exactly these two lines: " +
        "# draft check\nprint('draft check'). Write the file, then stop.",
    }),
  });
  if (!response.ok) throw new Error(`POST /api/chat answered ${response.status}`);

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

const drafts = events.filter((event) => event.type === "draft");
const call = events.find((event) => event.type === "tool_call" && event.name === "write_file");
const written = await readFile(path.join(workspace, "draft_check.py"), "utf8").catch(() => "");

/** The sizes of the successive bodies, split at each reset (a new attempt). */
function growth() {
  const segments = [[]];
  for (const draft of drafts) {
    if (draft.reset === true && segments.at(-1).length > 0) segments.push([]);
    segments.at(-1).push(draft.content.length);
  }
  return segments;
}

function monotonic() {
  return growth().every((segment) => segment.every((size, index) => index === 0 || size >= segment[index - 1]));
}

const rules = [
  ["the turn finished without an error", () => events.some((event) => event.type === "done")],
  [`draft events were sent (frame: ${drafts.length})`, () => drafts.length > 0],
  ["every draft named the same file", () => drafts.every((draft) => draft.path === drafts[0]?.path)],
  ["the body only ever grew within an attempt", monotonic],
  ["exactly one attempt was drafted", () => growth().length === 1],
  ["the last draft was marked complete", () => drafts.at(-1)?.complete === true],
  [
    "the write really happened",
    () => call !== undefined && written.includes("draft check"),
  ],
  [
    "the drafted body is what was written",
    () => drafts.length > 0 && written.trim() === String(drafts.at(-1)?.content).trim(),
  ],
];

let failures = 0;
if (failure !== null) {
  console.error(`FAIL  ${failure}`);
  failures += 1;
} else {
  const profile = growth()[0] ?? [];
  if (profile.length > 0) {
    const shown = profile.length > 8 ? [...profile.slice(0, 4), "...", ...profile.slice(-2)] : profile;
    console.log(`Drafts   ${drafts.length}, body grew ${shown.join(" → ")} characters`);
  }
  for (const [name, rule] of rules) {
    const ok = rule();
    if (ok) console.log(`  ok  ${name}`);
    else {
      console.error(`  not ok  ${name}`);
      failures += 1;
    }
  }

  if (drafts.length === 1) {
    const message =
      "the gateway sent the whole tool call in one frame, so the pane can only show " +
      "this file once it is finished, never while it is being written";
    if (REQUIRE_FRAGMENTED) {
      console.error(`  not ok  the call arrives in fragments — ${message}`);
      failures += 1;
    } else {
      console.log(`\nNOTE  ${message}.\n      That is a provider property, not a bug here: pass --require-fragmented to fail on it.`);
    }
  }
}

await shutdown();

if (failures > 0) {
  console.error(`\n${rules.length - failures}/${rules.length} draft checks passed`);
  if (serverLog.trim() !== "") console.error("\nserver log:\n" + serverLog.slice(-2000));
  process.exit(1);
}

console.log(`\n${rules.length}/${rules.length} draft checks passed`);
