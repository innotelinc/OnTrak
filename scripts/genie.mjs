#!/usr/bin/env node
/**
 * `genie` — run one turn through Genie's agent from a terminal.
 *
 * The console is a browser; this is the same turn without one. It posts to
 * `/api/chat`, streams the events the console renders, and exits non-zero when
 * the turn failed.
 *
 * Signing in is the deployment's own, not a second one:
 *
 *   genie login     open the browser, sign in there, and catch the session on a
 *                   loopback listener — the same `/api/auth/cli` handoff the
 *                   console's `genie login` uses. Nothing is stored until
 *                   `/api/auth/status` confirms the credential.
 *   genie whoami    say which account the stored credential belongs to.
 *   genie logout    forget it.
 *
 * `genie login --token <bearer>` remains for a deployment with sign-in off, and
 * a service can still set `GENIE_TOKEN` + `GENIE_ACTOR` without a config file.
 *
 * Configuration, highest precedence first:
 *
 *   --url / --actor / --token / --model
 *   GENIE_URL / GENIE_ACTOR / GENIE_TOKEN / GENIE_COOKIE / GENIE_MODEL
 *   ~/.config/genie/config.json   {"url": "...", "actor": "...", "cookie": "...", "token": "...", "model": "..."}
 *
 * Examples:
 *
 *   genie login
 *   genie "which files changed in the last commit?"
 *   genie --actor you@example.com --model gpt-4.1 "summarise the build"
 *   echo "explain this log" | genie
 *   genie --list                 # what the console says it can run
 *
 * The credential is read from the environment or the config file; it is never
 * echoed.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const NAME = "genie";
const VERSION = "1.1.0";
const SESSION_COOKIE = "ontrak_genie_session";

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

/** Merge into the config file, deleting empty keys, always `0600`. */
function writeConfig(patch) {
  const next = { ...readConfig() };
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value !== "string" || value.trim() === "") delete next[key];
    else next[key] = value.trim();
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, configPath);
  return next;
}

function usage() {
  console.log(`usage: ${NAME} [options] [prompt]
       ${NAME} login [--no-open | --token <bearer>]
       ${NAME} whoami | logout

Run one turn through Genie's agent and stream the answer.

commands:
  login             sign in through the deployment (the browser does the work)
  login --token X   store the deployment's shared bearer instead, after checking it
  whoami            show the server and the account the stored credential belongs to
  logout            forget the stored credential

options:
  --url <url>       Genie's base URL           (GENIE_URL)
  --actor <email>   the account the turn belongs to (GENIE_ACTOR)
  --token <token>   the deployment's shared bearer   (GENIE_TOKEN)
  --cookie <value>  a signed-in session value   (GENIE_COOKIE)
  --model <name>    model for this turn        (GENIE_MODEL)
  --json            print every stream event as JSON
  --no-color        never use ANSI colour
  -h, --help        show this help
  -V, --version     print the version

config: ${configPath}
  {"url": "http://127.0.0.1:3400", "cookie": "…"}   after \`${NAME} login\`
  {"url": "http://127.0.0.1:3400", "actor": "you@example.com", "token": "…"}

exit: 0 the turn completed (or sign-in succeeded), 1 the turn failed, 2 it could not be attempted`);
}

const argv = process.argv.slice(2);
const COMMANDS = new Set(["login", "logout", "whoami"]);
let command = COMMANDS.has(argv[0] ?? "") ? argv.shift() : "";
let url = "";
let actor = "";
let token = "";
let cookie = "";
let model = "";
let json = false;
let color = process.stdout.isTTY === true && !process.env.NO_COLOR;
let open = true;
/** Only an explicit `--token` means "store this bearer"; one in the config does not. */
let tokenFlag = "";
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
    tokenFlag = token;
  } else if (arg === "--cookie") {
    cookie = next();
  } else if (arg === "--model") {
    model = next();
  } else if (arg === "--json") {
    json = true;
  } else if (arg === "--no-open") {
    open = false;
  } else if (arg === "--no-color") {
    color = false;
  } else if (arg.startsWith("-") && arg !== "-") {
    console.error(`${NAME}: unknown option ${arg}\n`);
    usage();
    process.exit(2);
  } else if (command === "" && COMMANDS.has(arg)) {
    // `genie login` with the flag before the word, e.g. `genie --url … login`.
    command = arg;
  } else {
    promptParts.push(arg);
  }
}

url = pick(url, "GENIE_URL", "url").replace(/\/+$/, "");
actor = pick(actor, "GENIE_ACTOR", "actor").toLowerCase();
token = pick(token, "GENIE_TOKEN", "token");
cookie = pick(cookie, "GENIE_COOKIE", "cookie");
model = pick(model, "GENIE_MODEL", "model");

const dim = (text) => (color ? `\x1b[2m${text}\x1b[0m` : text);
const bold = (text) => (color ? `\x1b[1m${text}\x1b[0m` : text);
const red = (text) => (color ? `\x1b[31m${text}\x1b[0m` : text);
const green = (text) => (color ? `\x1b[32m${text}\x1b[0m` : text);

/** The headers that carry the credential, whichever kind it is. */
function authHeaders() {
  if (cookie !== "") {
    // A browser session names its own account; sending an actor header beside it
    // would be a second claim about the same turn.
    return { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` };
  }
  return {
    ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
    ...(actor === "" ? {} : { "x-genie-actor": actor }),
  };
}

async function authStatus(base) {
  let response;
  try {
    response = await fetch(`${base}/api/auth/status`, {
      headers: { ...authHeaders(), "cache-control": "no-store" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`could not reach ${base}: ${error?.message ?? error}`);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`/api/auth/status answered ${response.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`/api/auth/status did not answer JSON: ${text.slice(0, 120)}`);
  }
}

async function verifyCredential(base, credential) {
  const saved = { cookie, token };
  if (credential.cookie !== undefined) {
    cookie = credential.cookie;
    token = "";
  } else {
    cookie = "";
    token = credential.token;
  }
  try {
    const status = await authStatus(base);
    if (status.authenticated !== true) {
      throw new Error(
        credential.cookie !== undefined
          ? "this deployment requires sign-in and did not accept the session"
          : "the deployment did not accept that bearer",
      );
    }
    return status;
  } finally {
    cookie = saved.cookie;
    token = saved.token;
  }
}

/** The page the browser lands on: hand the fragment to the CLI, then say so. */
const LOOPBACK_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to genie</title>
<style>
 :root{color-scheme:dark}
 *{box-sizing:border-box}
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0c;color:#ececf1;
      font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
 .card{width:100%;max-width:26rem;background:#131318;border:1px solid #26262e;border-radius:16px;
       padding:28px;box-shadow:0 24px 60px rgba(0,0,0,.55)}
 .mark{display:flex;align-items:center;gap:10px;margin-bottom:18px}
 .dot{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#7c6cff,#22d3ee);
      display:grid;place-items:center;font-weight:700;font-size:13px;color:#0a0a0c}
 h1{font-size:16px;margin:0;font-weight:600;letter-spacing:-.01em}
 p{margin:0;color:#a7a7b4}
 .ok{color:#4ade80}.bad{color:#f87171}
 code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#c8c8d4;
      background:#1c1c23;border-radius:5px;padding:1px 5px}
 .hint{margin-top:16px;font-size:12px;color:#6f6f7e}
</style></head>
<body><div class="card">
  <div class="mark"><span class="dot">g</span><h1>genie</h1></div>
  <p id="msg">Finishing sign-in…</p>
  <p class="hint" id="hint"></p>
</div>
<script>
const params = new URLSearchParams(location.hash.replace(/^#/, ""));
const token = params.get("genie_token");
const msg = document.getElementById("msg");
const hint = document.getElementById("hint");
if (!token) {
  msg.textContent = "No credential came back. Start again with ";
  msg.insertAdjacentHTML("beforeend", "<code>genie login</code>.");
} else {
  fetch("/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  })
    .then((r) => r.json())
    .then((r) => {
      if (r.ok) {
        msg.className = "ok";
        msg.textContent = "Signed in as " + (r.email || "you") + ".";
        hint.textContent = "You can close this tab and return to the terminal.";
      } else {
        msg.className = "bad";
        msg.textContent = "The CLI refused the credential: " + (r.error || "unknown reason");
      }
      history.replaceState(null, "", location.pathname);
    })
    .catch((e) => {
      msg.className = "bad";
      msg.textContent = "Could not reach the CLI on this machine: " + e.message;
    });
}
</script></body></html>`;

function openBrowser(target) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // A machine with no browser is expected; the URL is printed either way.
  }
}

/** Listen on loopback, send the browser to the deployment, wait for the handoff. */
async function login(base) {
  // Ask before opening anything: a deployment with sign-in off would otherwise
  // bounce the browser to a 404 and leave the terminal waiting for five minutes.
  const probe = await authStatus(base).catch((error) => ({ error }));
  if (probe.error) {
    console.error(red(`${NAME}: ${probe.error.message}`));
    return 2;
  }
  if (probe.oidc !== true) {
    console.error(
      red(`${NAME}: ${base} has sign-in turned off. Set GENIE_TOKEN and GENIE_ACTOR, or run \`${NAME} login --token <bearer>\`.`),
    );
    return 2;
  }

  let settle;
  let fail;
  const handoff = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  let consumed = false;

  const server = http.createServer((req, res) => {
    const requested = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && requested.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(LOOPBACK_PAGE);
      return;
    }
    if (req.method === "POST" && requested.pathname === "/token") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        void (async () => {
          let value = "";
          try {
            value = String(JSON.parse(Buffer.concat(chunks).toString("utf8")).token ?? "");
          } catch {
            value = "";
          }
          if (value === "" || consumed) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "no credential" }));
            return;
          }
          try {
            const status = await verifyCredential(base, { cookie: value });
            consumed = true;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, email: status.identity?.email ?? "" }));
            settle({ value, status });
          } catch (error) {
            // Not stored, and the listener stays up: signing in again in the same
            // tab is the retry.
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: error?.message ?? String(error) }));
          }
        })();
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const start = `${base}/api/auth/cli?port=${port}`;

  console.log(bold(`${NAME} ${VERSION}`) + dim(` — signing in at ${base}`));
  console.log(`\n  ${start}\n`);
  console.log(dim(`Waiting for the browser. Listening on 127.0.0.1:${port} (Ctrl-C to cancel).`));
  if (open) openBrowser(start);

  const timer = setTimeout(
    () => fail(new Error("timed out waiting for the browser sign-in (5 minutes)")),
    5 * 60_000,
  );

  try {
    const { value, status } = await handoff;
    const identity = status.identity ?? { email: "" };
    writeConfig({ url: base, cookie: value, actor: identity.email ?? "", token: "" });
    console.log(green(`\nSigned in as ${identity.name || identity.email || "you"}${identity.email ? ` <${identity.email}>` : ""}.`));
    console.log(dim(`Credential stored at ${configPath} (0600). \`${NAME} logout\` forgets it.`));
    return 0;
  } catch (error) {
    console.error(red(`\n${NAME}: ${error?.message ?? error}`));
    return 1;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

async function loginWithToken(base, value) {
  const status = await verifyCredential(base, { token: value });
  const identity = status.identity ?? { email: "" };
  writeConfig({ url: base, token: value, cookie: "", actor: identity.email ?? actor });
  console.log(green(`Signed in as ${identity.name || identity.email || "token holder"} (shared bearer stored at ${configPath}).`));
  return 0;
}

async function whoami(base) {
  if (cookie === "" && token === "") {
    console.log(`${NAME} ${VERSION} — not signed in${base ? ` at ${base}` : ""}. Run \`${NAME} login\`.`);
    return 2;
  }
  const status = await authStatus(base).catch((error) => ({ error }));
  if (status.error) {
    console.error(red(`${NAME}: ${status.error.message}`));
    return 2;
  }
  const identity = status.identity ?? null;
  console.log(bold(`${NAME} ${VERSION}`) + dim(` — ${base}`));
  console.log(
    status.authenticated === true
      ? green(`signed in${identity ? ` as ${identity.name || identity.email} <${identity.email}>` : ""}`)
      : red("the stored credential is not accepted; run `genie login`"),
  );
  console.log(dim(`credential: ${cookie !== "" ? "browser session" : "shared bearer"}`));
  return status.authenticated === true ? 0 : 1;
}

function logout() {
  writeConfig({ cookie: "", token: "", actor: "" });
  console.log(`Signed out — ${configPath} no longer holds a credential.`);
  return 0;
}

if (url === "") {
  const fallback = command === "" ? "" : "http://127.0.0.1:3400";
  if (fallback === "") {
    console.error(`${NAME}: no Genie URL. Set GENIE_URL or pass --url (see ${configPath}).`);
    process.exit(2);
  }
  url = fallback;
}

if (command === "logout") {
  process.exit(logout());
}

if (command === "whoami") {
  process.exit(await whoami(url));
}

if (command === "login") {
  if (tokenFlag !== "") process.exit(await loginWithToken(url, tokenFlag));
  process.exit(await login(url));
}

if (actor === "" && cookie === "") {
  console.error(`${NAME}: no account. Run \`${NAME} login\`, or set GENIE_ACTOR and GENIE_TOKEN — Genie will not invent one.`);
  process.exit(2);
}

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
        ...authHeaders(),
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
    if (response.status === 401) {
      console.error(dim(`Run \`${NAME} login\`, or check the deployment's sign-in.`));
      return 1;
    }
    return 2;
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
const who = actor !== "" ? actor : "signed in";
console.log(bold(`${NAME} ${VERSION}`) + dim(` — ${who} at ${url}${model === "" ? "" : ` (${model})`}`));
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
