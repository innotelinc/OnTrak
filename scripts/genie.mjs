#!/usr/bin/env node
/**
 * `genie` — run one turn through Genie's agent from a terminal.
 *
 * The console is a browser; this is the same turn without one. It posts to
 * `/api/chat`, streams the events the console renders, and exits non-zero when
 * the turn failed. Nothing here is a second way to be signed in: Genie attributes
 * a turn to an account, so the CLI sends the deployment's shared bearer and
 * `x-genie-actor`, exactly as `scripts/genie-capture-smoke.mjs` does (and for the
 * same reason — see ontrak-genie/src/actor.ts).
 *
 * Configuration, highest precedence first:
 *
 *   --url / --actor / --token / --model
 *   GENIE_URL / GENIE_ACTOR / GENIE_TOKEN / GENIE_MODEL
 *   ~/.config/genie/config.json          {"url": "...", "actor": "...", "token": "...", "model": "..."}
 *
 * Examples:
 *
 *   genie "which files changed in the last commit?"
 *   genie --actor you@example.com --model gpt-4.1 "summarise the build"
 *   echo "explain this log" | genie
 *   genie --list                 # what the console says it can run
 *
 * The token is read from the environment or the config file; it is never echoed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const NAME = "genie";
const VERSION = "1.0.0";

const configPath = path.join(
  process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"),
  NAME,
  "config.json",
);

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

const fileConfig = readConfig();

function pick(flag, envName, configKey = envName.toLowerCase()) {
  // An unset flag arrives as "", which `??` would happily keep; every source is
  // checked for content instead, so a flag, then the environment, then the file.
  const explicit = (flag ?? "").trim();
  if (explicit !== "") return explicit;
  const fromEnv = (process.env[envName] ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  const fromFile = typeof fileConfig[configKey] === "string" ? fileConfig[configKey].trim() : "";
  return fromFile;
}

function usage() {
  console.log(`usage: ${NAME} [options] [prompt]

Run one turn through Genie's agent and stream the answer.

options:
  --url <url>       Genie's base URL           (GENIE_URL)
  --actor <email>   the account the turn belongs to (GENIE_ACTOR)
  --token <token>   the deployment's shared bearer   (GENIE_TOKEN)
  --model <name>    model for this turn        (GENIE_MODEL)
  --json            print every stream event as JSON
  --no-color        never use ANSI colour
  -h, --help        show this help
  -V, --version     print the version

config: ${configPath}
  {"url": "http://127.0.0.1:3400", "actor": "you@example.com", "token": "…"}

exit: 0 the turn completed, 1 the turn failed, 2 it could not be attempted`);
}

const argv = process.argv.slice(2);
let url = "";
let actor = "";
let token = "";
let model = "";
let json = false;
let color = process.stdout.isTTY === true && !process.env.NO_COLOR;
const promptParts = [];

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  const next = () => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`${NAME}: ${arg} needs a value`);
      process.exit(2);
    }
    i += 1;
    return value;
  };
  if (arg === "-h" || arg === "--help") {
    usage();
    process.exit(0);
  } else if (arg === "-V" || arg === "--version") {
    console.log(`${NAME} ${VERSION}`);
    process.exit(0);
  } else if (arg === "--url") {
    url = next();
  } else if (arg === "--actor") {
    actor = next();
  } else if (arg === "--token") {
    token = next();
  } else if (arg === "--model") {
    model = next();
  } else if (arg === "--json") {
    json = true;
  } else if (arg === "--no-color") {
    color = false;
  } else if (arg.startsWith("-") && arg !== "-") {
    console.error(`${NAME}: unknown option ${arg}\n`);
    usage();
    process.exit(2);
  } else {
    promptParts.push(arg);
  }
}

url = pick(url, "GENIE_URL", "url").replace(/\/+$/, "");
actor = pick(actor, "GENIE_ACTOR", "actor").toLowerCase();
token = pick(token, "GENIE_TOKEN", "token");
model = pick(model, "GENIE_MODEL", "model");

if (url === "") {
  console.error(`${NAME}: no Genie URL. Set GENIE_URL or pass --url (see ${configPath}).`);
  process.exit(2);
}
if (actor === "") {
  console.error(`${NAME}: no account. Set GENIE_ACTOR or pass --actor — Genie will not invent one.`);
  process.exit(2);
}

const dim = (text) => (color ? `\x1b[2m${text}\x1b[0m` : text);
const bold = (text) => (color ? `\x1b[1m${text}\x1b[0m` : text);
const red = (text) => (color ? `\x1b[31m${text}\x1b[0m` : text);

/** One turn, streamed. Resolves to the process exit status. */
async function turn(message, { timeoutMs = 600_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  let response;
  try {
    response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
        "x-genie-actor": actor,
      },
      body: JSON.stringify({ message, ...(model === "" ? {} : { model }) }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    console.error(red(`${NAME}: could not reach ${url}: ${error?.message ?? error}`));
    return 2;
  }

  if (!response.ok || response.body === null) {
    clearTimeout(timer);
    const detail = await response.text().catch(() => "");
    console.error(red(`${NAME}: the turn was refused (HTTP ${response.status})${detail === "" ? "" : `: ${detail.slice(0, 500)}`}`));
    return response.status === 401 ? 1 : 2;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let wroteText = false;
  let failed = false;
  let finished = false;

  const consume = (frame) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data === "" || data === "[DONE]") return;

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (json) {
      console.log(JSON.stringify(event));
      return;
    }
    if (event.type === "text" && typeof event.text === "string") {
      process.stdout.write(event.text);
      wroteText = true;
    } else if (event.type === "tool_call") {
      const args = event.args === undefined ? "" : ` ${JSON.stringify(event.args).slice(0, 300)}`;
      process.stderr.write(dim(`\n→ ${String(event.name ?? "tool")}${args}\n`));
    } else if (event.type === "tool_result") {
      const verdict = event.ok === false ? "failed" : "ok";
      process.stderr.write(dim(`← ${String(event.name ?? "tool")}: ${verdict}\n`));
    } else if (event.type === "error") {
      failed = true;
      process.stderr.write(red(`\n${NAME}: ${String(event.message ?? "the turn failed")}\n`));
    } else if (event.type === "done") {
      finished = true;
    }
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let at;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        consume(buffer.slice(0, at));
        buffer = buffer.slice(at + 2);
      }
      if (finished) break;
    }
    if (buffer.trim() !== "") consume(buffer);
  } catch (error) {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    console.error(red(`\n${NAME}: ${error?.name === "AbortError" ? `no answer within ${timeoutMs} ms` : String(error)}`));
    return 1;
  }
  clearTimeout(timer);
  await reader.cancel().catch(() => {});

  if (wroteText) process.stdout.write("\n");
  if (failed || !finished) {
    if (!failed) console.error(red(`${NAME}: the stream ended without a done event`));
    return 1;
  }
  return 0;
}

const inlinePrompt = promptParts.join(" ").trim();

if (inlinePrompt !== "") {
  process.exit(await turn(inlinePrompt));
}

if (!process.stdin.isTTY) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const piped = Buffer.concat(chunks).toString("utf8").trim();
  if (piped === "") {
    console.error(`${NAME}: no prompt on stdin`);
    process.exit(2);
  }
  process.exit(await turn(piped));
}

// Interactive: one turn per line. `:q`, `:quit` or `:exit` leaves; `:help` repeats
// the prompt; an empty line is ignored rather than sent as a turn.
console.log(bold(`${NAME} ${VERSION}`) + dim(` — ${actor} at ${url}${model === "" ? "" : ` (${model})`}`));
console.log(dim("One turn per line. :quit to leave.\n"));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "genie> " });
rl.prompt();
for await (const line of rl) {
  const message = line.trim();
  if (message === ":quit" || message === ":q" || message === ":exit") break;
  if (message === ":help") {
    console.log(dim("Type a prompt and press Enter. :quit leaves."));
  } else if (message !== "") {
    const status = await turn(message);
    if (status !== 0) console.error(dim(`(turn exited ${status})`));
  }
  rl.prompt();
}
rl.close();
