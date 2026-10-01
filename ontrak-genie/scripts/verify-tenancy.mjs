#!/usr/bin/env node
/**
 * Prove that two accounts are actually isolated on a *running* console.
 *
 * The unit tests prove the decision and `tests/tenancy-http.test.ts` wires it:
 * two subjects resolve to two workspaces, two chat lists and two gateway keys.
 * What they cannot prove is the deployment fact v1.0's exit names — that the
 * console people are actually using resolves its accounts through the real
 * control plane, and gives each of them their own key, workspace and record.
 *
 * This asks a live console that question and answers it, end to end:
 *
 *   1. sign-in is configured — `/api/auth/status` says `oidc: true`, because a
 *      session is only honoured when it is (an unconfigured console falls back
 *      to `WEB_TOKEN`, which carries no subject to key on);
 *   2. tenancy is on — `/api/health` says `tenancy: true`, and each account's
 *      answer names *that account's* email;
 *   3. two accounts get two workspaces — each gets its own `cwd` under
 *      `accounts/<account>/`, and a folder one creates the other cannot see;
 *   4. two accounts get two chat lists — a chat one starts is not in the
 *      other's list;
 *   5. two accounts get two records — `/api/account/usage` returns each
 *      account's own spend and ceiling from the control plane.
 *
 * It signs in as the two accounts by minting the console's own session cookie:
 * the same `ONTRAK_OIDC_SESSION_SECRET` the deployment signs real sessions with,
 * an HMAC over `{ sub, email, exp }`. That is a powerful capability, which is
 * why this is an **operator** check to run on the host that holds the secret,
 * next to `scripts/verify-sso.py` — not something a deployment exposes.
 *
 *   node scripts/verify-tenancy.mjs \
 *     --account abfa2c48…=dhunter@innotel.us \
 *     --account 16d3d890…=admin@cerulean.innotel.us
 *
 * Config (a flag, then the environment, then `.env`):
 *   --url            ONTRAK_GENIE_URL            default http://127.0.0.1:3400
 *   --account        (repeatable, required)      sub=email
 *   --secret         ONTRAK_OIDC_SESSION_SECRET  the console's session secret
 *
 * Exit codes: 0 = every check passed, 1 = a check failed, 2 = cannot run from
 * here (no secret, fewer than two accounts, or the console is unreachable).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

function values(name) {
  const found = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === `--${name}` && args[i + 1] !== undefined) found.push(args[i + 1]);
  }
  return found;
}

function value(name) {
  return values(name)[0];
}

/** Minimal .env reader, mirroring src/config.ts. The real environment wins. */
function readDotEnv() {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const cleaned = match[2].replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
    if (process.env[match[1]] === undefined) process.env[match[1]] = cleaned;
  }
}

readDotEnv();

const base = (value("url") ?? process.env.ONTRAK_GENIE_URL ?? "http://127.0.0.1:3400").replace(/\/+$/, "");
const secret = value("secret") ?? process.env.ONTRAK_OIDC_SESSION_SECRET ?? "";
const sessionHours = Number(process.env.ONTRAK_OIDC_SESSION_HOURS ?? "12") || 12;

const accounts = values("account").map((pair) => {
  const at = pair.indexOf("=");
  return { sub: pair.slice(0, at), email: pair.slice(at + 1) };
});

if (secret === "") fail(2, "no session secret: set ONTRAK_OIDC_SESSION_SECRET (or pass --secret)");
if (accounts.length < 2) fail(2, "pass at least two --account <sub>=<email> pairs to compare");

const b64u = (text) => Buffer.from(text, "utf8").toString("base64url");

/** The console's own session cookie, signed the way `mintSession` signs it. */
function cookieFor(account) {
  const claims = {
    sub: account.sub,
    email: account.email,
    name: account.email,
    exp: Math.floor(Date.now() / 1000) + sessionHours * 3600,
  };
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64u(JSON.stringify(claims));
  const signature = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `ontrak_genie_session=${encodeURIComponent(`${header}.${payload}.${signature}`)}`;
}

async function call(account, route, init = {}) {
  let response;
  try {
    response = await fetch(`${base}${route}`, {
      ...init,
      headers: { cookie: cookieFor(account), "content-type": "application/json", ...(init.headers ?? {}) },
    });
  } catch (error) {
    fail(2, `cannot reach the console at ${base}: ${error.message}`);
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const results = [];
const check = (ok, label, detail = "") => {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : ` — ${detail}`}`);
};

function fail(code, message) {
  console.error(`verify-tenancy: ${message}`);
  process.exit(code);
}

// 1. Sign-in is configured: a session is only honoured when it is.
const status = await call(accounts[0], "/api/auth/status");
if (status.status !== 200) fail(2, `/api/auth/status answered ${status.status}`);
console.log(`console   ${base}`);
console.log(`sign-in   ${status.body.oidc === true ? "configured" : "NOT configured"}`);
if (status.body.oidc !== true) fail(2, "sign-in is not configured, so no session can carry a subject");

console.log(`accounts  ${accounts.map((a) => a.email).join(", ")}`);

// 2-5. Each account, then the comparisons between them.
const seen = new Map();
for (const account of accounts) {
  console.log(`\n== ${account.email}`);
  const health = await call(account, "/api/health");
  check(
    health.status === 200 && health.body.tenancy === true,
    "tenancy is on",
    `status ${health.status}, tenancy ${health.body.tenancy}`,
  );

  const workspace = await call(account, "/api/workspace");
  const cwd = workspace.body?.cwd ?? "";
  check(workspace.status === 200 && cwd.includes("/accounts/"), "own workspace", cwd);

  const folder = `verify-${account.sub.slice(0, 8)}`;
  await call(account, "/api/workspace/mkdir", { method: "POST", body: JSON.stringify({ name: folder }) });
  const files = await call(account, "/api/files?path=.");
  const names = (files.body?.entries ?? []).map((entry) => entry.name);
  check(names.includes(folder), "can write in its own workspace", names.join(", "));

  const created = await call(account, "/api/sessions", { method: "POST", body: "{}" });
  const chatId = created.body?.session?.id ?? "";
  check(created.status === 201 && chatId !== "", "can start a chat", chatId);

  const usage = await call(account, "/api/account/usage");
  check(
    usage.status === 200 && usage.body.email === account.email,
    "its own record",
    `email ${usage.body.email}, plan ${usage.body.quota?.plan}`,
  );

  seen.set(account, { cwd, names, chatId, usage: usage.body });
}

const [first, second] = accounts;
const a = seen.get(first);
const b = seen.get(second);

console.log("\n== isolation between accounts");
check(a.cwd !== b.cwd, "two distinct workspaces");
check(!b.names.includes(`verify-${first.sub.slice(0, 8)}`), "the second cannot see the first's folder");

const secondChats = await call(second, "/api/sessions");
const secondIds = (secondChats.body?.sessions ?? []).map((session) => session.id);
check(!secondIds.includes(a.chatId), "the second cannot see the first's chat");

const firstChats = await call(first, "/api/sessions");
const firstIds = (firstChats.body?.sessions ?? []).map((session) => session.id);
check(firstIds.includes(a.chatId), "the first still sees its own chat");

const firstRead = await call(first, `/api/file?path=verify-${second.sub.slice(0, 8)}`);
check(firstRead.status !== 200, "the first cannot read the second's folder", `status ${firstRead.status}`);

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
