/**
 * `genie login`, over the wire.
 *
 * A CLI cannot read the session cookie the deployment sets — the cookie belongs
 * to the deployment's origin — so a sign-in started at `/api/auth/cli?port=N`
 * finishes by sending the browser to that port on loopback instead. These tests
 * pin the three things that make that safe rather than clever:
 *
 *   - the port is bounded to loopback, so a crafted link cannot deliver a
 *     freshly minted session to somebody else's host;
 *   - the credential travels in the URL **fragment**, which a browser never
 *     sends to a server (so it cannot land in an access log or a `Referer`);
 *   - an ordinary browser sign-in is unchanged — it still gets the cookie and
 *     still returns to the page it started from.
 *
 * The provider is the same stand-in `oidc.test.ts` uses: a discovery document, a
 * JWKS and RS256 tokens minted with a key it generated.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const KID = "cli-key-1";
const CLIENT_ID = "ontrak-genie-cli-test";
const SESSION_SECRET = "test-session-secret-not-a-real-credential";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

let pending: { nonce: string } | null = null;

const idp = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;

  if (url.pathname === "/.well-known/openid-configuration") {
    return json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    });
  }
  if (url.pathname === "/jwks") {
    return json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }] });
  }
  if (url.pathname === "/token" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void body;
      const now = Math.floor(Date.now() / 1000);
      const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }));
      const payload = base64url(
        JSON.stringify({
          iss: issuer,
          sub: "user-cli",
          aud: CLIENT_ID,
          exp: now + 300,
          iat: now,
          nonce: pending?.nonce ?? "",
          email: "cli@example.test",
          name: "CLI User",
        }),
      );
      const signature = crypto
        .sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey)
        .toString("base64url");
      return json({ id_token: `${header}.${payload}.${signature}` });
    });
    return;
  }
  json({ error: "not_found" }, 404);
});

await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
const IDP = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "genie-cli-"));
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "genie-cli-ws-"));

process.env.AGENT_DATA_DIR = dataDir;
process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_SANDBOX = "host";
process.env.AGENT_APPROVAL = "off";
process.env.AGENT_MODEL = "fake/model";
process.env.AGENT_FALLBACK_MODELS = "";
process.env.WEB_TOKEN = "";
process.env.ONTRAK_OIDC_ISSUER = IDP;
process.env.ONTRAK_OIDC_CLIENT_ID = CLIENT_ID;
process.env.ONTRAK_OIDC_SESSION_SECRET = SESSION_SECRET;
process.env.ONTRAK_OIDC_REDIRECT_URL = "http://127.0.0.1:9/api/auth/callback";

const { createServer } = await import("../server.js");
const { ensureWorkspace } = await import("../workspace.js");
const { cliHandoffPort, cliHandoffUrl, resetOidcCaches } = await import("../oidc.js");
const { verifyCredential, LoginFailure } = await import("../cli/login.js");

await ensureWorkspace();
const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => idp.close(() => resolve()));
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

async function startCliLogin(port: number): Promise<string> {
  resetOidcCaches();
  const response = await fetch(`${base}/api/auth/cli?port=${port}`, { redirect: "manual" });
  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location, "the CLI sign-in must redirect to the provider");
  const url = new URL(location);
  pending = { nonce: url.searchParams.get("nonce") ?? "" };
  return url.searchParams.get("state") ?? "";
}

/* ------------------------------------------------------------ pure helpers */

test("cliHandoffPort accepts only a loopback port", () => {
  assert.equal(cliHandoffPort("3400"), 3400);
  assert.equal(cliHandoffPort("65535"), 65535);
  // Below 1024 is a privileged port and not something a CLI should be handed;
  // anything out of range, non-numeric or absent is refused rather than coerced.
  assert.equal(cliHandoffPort("80"), null);
  assert.equal(cliHandoffPort("0"), null);
  assert.equal(cliHandoffPort("70000"), null);
  assert.equal(cliHandoffPort("abc"), null);
  assert.equal(cliHandoffPort(""), null);
  assert.equal(cliHandoffPort(null), null);
  assert.equal(cliHandoffPort(undefined), null);
});

test("the handoff carries the credential in the fragment, never the query", () => {
  const url = new URL(cliHandoffUrl(4321, "the-session"));
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "4321");
  assert.equal(url.search, "", "a query string is sent to servers and logged; a fragment is not");
  assert.equal(new URLSearchParams(url.hash.slice(1)).get("genie_token"), "the-session");
});

/* --------------------------------------------------------------- the route */

test("an invalid port is refused rather than redirected to", async () => {
  for (const port of ["80", "0", "99999", "nope", ""]) {
    const response = await fetch(`${base}/api/auth/cli?port=${port}`, { redirect: "manual" });
    assert.equal(response.status, 400, `port=${port} must be refused`);
  }
  // No port at all: the caller forgot the one thing that makes it a CLI handoff.
  const missing = await fetch(`${base}/api/auth/cli`, { redirect: "manual" });
  assert.equal(missing.status, 400);
});

test("a CLI sign-in finishes on the caller's loopback port with no cookie", async () => {
  const port = 45123;
  const state = await startCliLogin(port);
  const callback = await fetch(`${base}/api/auth/callback?code=the-code&state=${state}`, {
    redirect: "manual",
  });

  assert.equal(callback.status, 302);
  const location = new URL(callback.headers.get("location") ?? "");
  assert.equal(location.hostname, "127.0.0.1");
  assert.equal(location.port, String(port));
  const token = new URLSearchParams(location.hash.slice(1)).get("genie_token") ?? "";
  assert.ok(token.length > 20, "the handoff must carry a real session");
  // A CLI is not a browser: setting a cookie nobody can use would be misleading.
  assert.equal(callback.headers.get("set-cookie"), null);
});

test("an ordinary browser sign-in is unchanged: it gets the cookie and returns to its page", async () => {
  resetOidcCaches();
  const login = await fetch(`${base}/api/auth/login?next=${encodeURIComponent("/workspace")}`, {
    redirect: "manual",
  });
  const url = new URL(login.headers.get("location") ?? "");
  pending = { nonce: url.searchParams.get("nonce") ?? "" };
  const state = url.searchParams.get("state") ?? "";

  const callback = await fetch(`${base}/api/auth/callback?code=c&state=${state}`, { redirect: "manual" });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/workspace");
  assert.match(callback.headers.get("set-cookie") ?? "", /ontrak_genie_session=/);
});

test("a handoff port cannot be smuggled through an ordinary login", async () => {
  // `/api/auth/login` takes `next` and nothing else; a `port` on it must not
  // turn a browser sign-in into a credential delivery to loopback.
  resetOidcCaches();
  const login = await fetch(`${base}/api/auth/login?port=45123`, { redirect: "manual" });
  const url = new URL(login.headers.get("location") ?? "");
  pending = { nonce: url.searchParams.get("nonce") ?? "" };
  const state = url.searchParams.get("state") ?? "";

  const callback = await fetch(`${base}/api/auth/callback?code=c&state=${state}`, { redirect: "manual" });
  assert.equal(callback.headers.get("location"), "/");
  assert.match(callback.headers.get("set-cookie") ?? "", /ontrak_genie_session=/);
});

/* ------------------------------------------------------- the CLI's own check */

test("verifyCredential accepts a handoff session and reports who it is", async () => {
  const port = 45124;
  const state = await startCliLogin(port);
  const callback = await fetch(`${base}/api/auth/callback?code=c&state=${state}`, { redirect: "manual" });
  const token =
    new URLSearchParams(new URL(callback.headers.get("location") ?? "").hash.slice(1)).get("genie_token") ?? "";

  const status = await verifyCredential(base, { cookie: token });
  assert.equal(status.authenticated, true);
  assert.equal(status.identity?.email, "cli@example.test");
});

test("verifyCredential refuses a credential the server does not accept", async () => {
  await assert.rejects(
    verifyCredential(base, { cookie: "not-a-real-session" }),
    (error: unknown) => error instanceof LoginFailure && /requires sign-in/.test((error as Error).message),
  );
});

test("verifyCredential reports an unreachable server rather than pretending to sign in", async () => {
  await assert.rejects(
    verifyCredential("http://127.0.0.1:9", { cookie: "x" }),
    (error: unknown) => error instanceof LoginFailure && /cannot reach/.test((error as Error).message),
  );
});
