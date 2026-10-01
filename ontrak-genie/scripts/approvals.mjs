#!/usr/bin/env node
/**
 * The approval gate, from a terminal or a CI job.
 *
 *   npm run approvals -- list
 *   npm run approvals -- approve <id>
 *   npm run approvals -- deny <id>
 *
 * The gate is what makes the agent safe to run, and it used to be reachable only
 * by watching the browser tab that started the turn. That makes the gate and
 * unattended running mutually exclusive: a CI job cannot click. This is the second
 * channel — it lists exactly what the cards would show and answers the same route,
 * so "unattended" means answered on purpose, on the record, rather than answered
 * by nobody.
 *
 * It authenticates the way every other client does: `WEB_TOKEN` if the deployment
 * sets one, or the session cookie a signed-in browser would carry. It is
 * deliberately not a new privilege — a caller who can answer a prompt already
 * could, from the console.
 *
 * The server records every decision in `<AGENT_DATA_DIR>/approvals.jsonl` with who
 * answered, so `approvals list` shows what is waiting and the log answers who let
 * it run afterwards.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

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

const argv = process.argv.slice(2);
const flags = argv.filter((arg) => arg.startsWith("--"));
const positionals = argv.filter((arg) => !arg.startsWith("--"));
const [command = "list", id] = positionals;
const asJson = flags.includes("--json");

/** Where the console is. `--url=` wins, then .env, then the default bind. */
function consoleUrl() {
  const explicit =
    flags.find((flag) => flag.startsWith("--url="))?.slice("--url=".length) ??
    setting("AGENT_URL");
  if (explicit) return explicit.replace(/\/+$/, "");
  // `HOST=0.0.0.0` is how a deployment binds; it is not an address to dial.
  const host = setting("HOST") || "127.0.0.1";
  return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${setting("PORT") || "3400"}`;
}

const base = consoleUrl();
const token = setting("WEB_TOKEN");
const headers = {
  "Content-Type": "application/json",
  ...(token === "" ? {} : { Authorization: `Bearer ${token}` }),
};

function usage() {
  console.error(
    "usage: approvals [list] | approve <id> | deny <id>\n" +
      "  --json       machine-readable output\n" +
      "  --url=<base> override the console address (default from .env, else :3400)",
  );
}

async function call(pathname, init) {
  try {
    return await fetch(`${base}${pathname}`, { ...init, headers, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    console.error(`cannot reach the console at ${base} (${error.cause?.code ?? error.message})`);
    process.exit(1);
  }
}

async function list() {
  const response = await call("/api/approvals", { method: "GET" });
  if (!response.ok) {
    console.error(`the console answered ${response.status} for ${base}/api/approvals`);
    process.exit(1);
  }
  const { pending } = await response.json();

  if (asJson) {
    console.log(JSON.stringify(pending, null, 2));
    return;
  }
  if (pending.length === 0) {
    console.log("nothing is waiting for approval");
    return;
  }
  for (const entry of pending) {
    console.log(`${entry.id}  ${entry.name}\n    ${entry.summary}\n    expires ${entry.expiresAt}`);
  }
}

async function decide(decision) {
  if (!id) {
    usage();
    process.exit(1);
  }
  const response = await call(`/api/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });
  if (response.status === 404) {
    console.error(`no prompt ${id} is waiting — it was already answered, or the turn ended`);
    process.exit(1);
  }
  if (!response.ok) {
    console.error(`the console answered ${response.status} answering ${id}`);
    process.exit(1);
  }
  console.log(`${decision === "approve" ? "approved" : "denied"} ${id}`);
}

if (command === "list") await list();
else if (command === "approve" || command === "deny") await decide(command);
else {
  usage();
  process.exit(1);
}
