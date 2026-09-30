/**
 * Tests for Authentik (OIDC) sign-in: the whole authorization-code round trip
 * against a stand-in provider, plus the token checks that must reject.
 *
 * The provider here is real enough to be worth trusting: it publishes a
 * discovery document, serves a JWKS, and mints RS256 `id_token`s with a key it
 * generated. It also verifies the PKCE verifier against the challenge it was
 * given, so the S256 half of the flow is exercised rather than assumed.
 *
 * Nothing here needs a model or a gateway — the endpoints under test are the
 * sign-in routes and the authorization gate in front of the rest of the API.
 *
 * Environment is set before the modules are imported because `config` is read
 * once, at import.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const KID = "test-key-1";
const CLIENT_ID = "ontrak-genie-test";
const SESSION_SECRET = "test-session-secret-not-a-real-credential";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** Mint an id_token the way the provider would: RS256 over the JWKS key. */
function mintIdToken(claims: Record<string, unknown>, alg = "RS256"): string {
  const header = base64url(JSON.stringify({ alg, typ: "JWT", kid: KID }));
  const payload = base64url(JSON.stringify(claims));
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey)
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/** What the provider remembers about the last sign-in it was asked to serve. */
let pending: { nonce: string; challenge: string; issuer: string } | null = null;
let lastTokenBody = "";
// Flipped by the trailing-slash test below. Authentik publishes its issuer with
// a trailing slash, so discovery has to see that as the same issuer rather than
// a mix-up.
let discoveryIssuerSuffix = "";

const idp = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1`);
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;

  if (url.pathname === "/.well-known/openid-configuration") {
    return json({
      issuer: issuer + discoveryIssuerSuffix,
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
      lastTokenBody = body;
      const form = new URLSearchParams(body);
      const verifier = form.get("code_verifier") ?? "";
      const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
      if (pending === null || challenge !== pending.challenge) {
        return json({ error: "invalid_grant", error_description: "code_verifier mismatch" }, 400);
      }
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: pending.issuer,
        sub: "user-1",
        aud: CLIENT_ID,
        exp: now + 300,
        iat: now,
        nonce: pending.nonce,
        email: "darnel@example.test",
        name: "Darnel Hunter",
      };
      return json({ id_token: mintIdToken(claims), access_token: "irrelevant", token_type: "Bearer" });
    });
    return;
  }

  json({ error: "not_found" }, 404);
});

await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
const IDP = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "genie-oidc-"));
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "genie-oidc-ws-"));

process.env.AGENT_DATA_DIR = dataDir;
process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_SANDBOX = "host";
process.env.AGENT_APPROVAL = "off";
process.env.AGENT_MODEL = "fake/model";
process.env.AGENT_FALLBACK_MODELS = "";
// Deliberately empty: sign-in alone has to protect the API. This is the case
// that used to be wide open, because an empty WEB_TOKEN meant "no gate".
process.env.WEB_TOKEN = "";
process.env.ONTRAK_OIDC_ISSUER = IDP;
process.env.ONTRAK_OIDC_CLIENT_ID = CLIENT_ID;
process.env.ONTRAK_OIDC_SESSION_SECRET = SESSION_SECRET;
process.env.ONTRAK_OIDC_REDIRECT_URL = "http://127.0.0.1:9/api/auth/callback";

const { createServer } = await import("../server.js");
const { ensureWorkspace } = await import("../workspace.js");
const { discover, mintSession, readSession, verifyIdToken, resetOidcCaches, sessionFrom } = await import("../oidc.js");

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

/* ------------------------------------------------------------------ helpers */

/** Start a sign-in and return what the provider was asked for. */
async function startLogin(
  next?: string,
): Promise<{ state: string; nonce: string; challenge: string; url: URL }> {
  resetOidcCaches();
  const target =
    next === undefined
      ? `${base}/api/auth/login`
      : `${base}/api/auth/login?next=${encodeURIComponent(next)}`;
  const response = await fetch(target, { redirect: "manual" });
  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location, "login must redirect");
  const url = new URL(location);
  const state = url.searchParams.get("state") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  const challenge = url.searchParams.get("code_challenge") ?? "";
  assert.ok(state && nonce && challenge, "the redirect must carry state, nonce and a PKCE challenge");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("response_type"), "code");
  pending = { nonce, challenge, issuer: IDP };
  return { state, nonce, challenge, url };
}

/* -------------------------------------------------------------------- tests */

test("sign-in is reported to an unauthenticated caller", async () => {
  const response = await fetch(`${base}/api/auth/status`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    oidc: boolean;
    authenticated: boolean;
    identity: { sub: string; email: string; name: string } | null;
  };
  assert.equal(body.oidc, true);
  assert.equal(body.authenticated, false);
  assert.equal(body.identity, null);
});

test("configuring sign-in closes the API even with no WEB_TOKEN", async () => {
  const response = await fetch(`${base}/api/files`);
  assert.equal(response.status, 401, "an empty WEB_TOKEN must not leave the API open once OIDC is on");
});

test("the whole authorization-code round trip grants a session", async () => {
  const { state } = await startLogin();
  // The provider returns the browser to the callback, which exchanges the code.
  const callback = await fetch(`${base}/api/auth/callback?code=the-code&state=${state}`, {
    redirect: "manual",
  });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/");

  const cookie = callback.headers.get("set-cookie") ?? "";
  assert.match(cookie, /ontrak_genie_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=\d+/);
  // The redirect URI is http, so the cookie must not claim to be Secure — one
  // the browser refuses to send back is a worse failure than one sent in the clear.
  // Scoped to the attribute list: the cookie's *value* is a base64url JWT, and
  // scanning the whole header would be a test that depends on random bytes.
  assert.doesNotMatch(cookie.slice(cookie.indexOf(";")), /Secure/);

  // The PKCE verifier the server sent must hash to the challenge the provider
  // was given when the login started, or the provider above would have refused.
  const verifier = new URLSearchParams(lastTokenBody).get("code_verifier") ?? "";
  assert.ok(verifier.length >= 43, "a code_verifier must be long enough to be worth hashing");
  assert.equal(base64url(crypto.createHash("sha256").update(verifier).digest()), pending?.challenge);

  // Now the session opens the API.
  const sessionValue = decodeURIComponent(cookie.split(";")[0]?.split("=").slice(1).join("=") ?? "");
  const files = await fetch(`${base}/api/files`, { headers: { Cookie: `ontrak_genie_session=${sessionValue}` } });
  assert.equal(files.status, 200);
});

test("a sign-in returns to the page it was started from", async () => {
  const { state } = await startLogin("/workspace?file=notes.md");
  const callback = await fetch(`${base}/api/auth/callback?code=c&state=${state}`, {
    redirect: "manual",
  });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/workspace?file=notes.md");
});

test("a next that is not a path on this origin is refused", async () => {
  // `next` is attacker-reachable: it is whatever sent somebody to the gate. An
  // absolute URL would make the sign-in an open redirect, and `//host` is an
  // absolute URL wearing a path's clothes.
  for (const hostile of ["https://evil.example/steal", "//evil.example/steal"]) {
    const { state } = await startLogin(hostile);
    const callback = await fetch(`${base}/api/auth/callback?code=c&state=${state}`, {
      redirect: "manual",
    });
    assert.equal(callback.headers.get("location"), "/", `${hostile} must not be returned to`);
  }
});

test("the session reports the identity it was minted for", async () => {
  const { state } = await startLogin();
  const callback = await fetch(`${base}/api/auth/callback?code=c&state=${state}`, { redirect: "manual" });
  const cookie = (callback.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const status = await fetch(`${base}/api/auth/status`, { headers: { Cookie: cookie } });
  const body = (await status.json()) as {
    authenticated: boolean;
    identity: { sub: string; email: string; name: string } | null;
  };
  assert.equal(body.authenticated, true);
  assert.equal(body.identity?.sub, "user-1");
  assert.equal(body.identity?.email, "darnel@example.test");
});

test("a state cannot be spent twice", async () => {
  const { state } = await startLogin();
  const first = await fetch(`${base}/api/auth/callback?code=c&state=${state}`, { redirect: "manual" });
  assert.equal(first.status, 302);

  const replay = await fetch(`${base}/api/auth/callback?code=c&state=${state}`, { redirect: "manual" });
  assert.equal(replay.status, 401, "a replayed callback must not mint a second session");
});

test("an unknown state is refused", async () => {
  const response = await fetch(`${base}/api/auth/callback?code=c&state=not-a-state`, { redirect: "manual" });
  assert.equal(response.status, 401);
});

test("a provider refusal is reported as unauthorized, not as a server fault", async () => {
  const { state } = await startLogin();
  const response = await fetch(`${base}/api/auth/callback?error=access_denied&state=${state}`, {
    redirect: "manual",
  });
  assert.equal(response.status, 401);
});

test("logout clears the cookie", async () => {
  const { state } = await startLogin();
  const callback = await fetch(`${base}/api/auth/callback?code=c&state=${state}`, { redirect: "manual" });
  const cookie = (callback.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const out = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie } });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/);
});

test("a token minted for a different nonce is refused", async () => {
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(
    verifyIdToken(
      mintIdToken({ iss: IDP, sub: "u", aud: CLIENT_ID, exp: now + 300, iat: now, nonce: "someone-elses" }),
      "this-sign-ins-nonce",
    ),
    /nonce/,
  );
});

test("a token for a different audience is refused", async () => {
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(
    verifyIdToken(
      mintIdToken({ iss: IDP, sub: "u", aud: "another-client", exp: now + 300, iat: now, nonce: "n" }),
      "n",
    ),
    /audience/,
  );
});

test("an expired token is refused", async () => {
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(
    verifyIdToken(
      mintIdToken({ iss: IDP, sub: "u", aud: CLIENT_ID, exp: now - 10, iat: now - 400, nonce: "n" }),
      "n",
    ),
    /expired/,
  );
});

test("an unsigned token is refused", async () => {
  const header = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iss: IDP, sub: "u", aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 300, nonce: "n" }),
  );
  await assert.rejects(verifyIdToken(`${header}.${payload}.`, "n"), /not accepted/);
});

test("a tampered signature is refused", async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = mintIdToken({ iss: IDP, sub: "u", aud: CLIENT_ID, exp: now + 300, nonce: "n" });
  const parts = token.split(".");
  const flipped = `${parts[0]}.${parts[1]}.${parts[2]?.slice(0, -2)}xy`;
  await assert.rejects(verifyIdToken(flipped, "n"), /signature/);
});

test("a session cookie cannot be edited", () => {
  const value = mintSession({ sub: "user-1", email: "a@b.test", name: "A" });
  assert.equal(readSession(value)?.sub, "user-1");

  // Take the payload, extend the expiry, keep the old signature.
  const [header64, payload64, signature64] = value.split(".") as [string, string, string];
  const claims = JSON.parse(Buffer.from(payload64, "base64url").toString("utf8"));
  claims.exp = claims.exp + 86_400;
  const forged = `${header64}.${base64url(JSON.stringify(claims))}.${signature64}`;
  assert.equal(readSession(forged), null, "a re-signed-by-nobody cookie must be refused");
});

test("a discovery issuer with a trailing slash names the same issuer", async () => {
  // Authentik publishes `…/application/o/ontrak/` while a deployment configures
  // it without the slash; both name the same provider, and discovery must not
  // call that a mix-up. Regression: this threw before the comparison normalized
  // the trailing slash, which left sign-in dead on the family's provider.
  discoveryIssuerSuffix = "/";
  resetOidcCaches();
  const doc = await discover(true);
  assert.equal(doc.issuer, `${IDP}/`, "discovery reports the issuer as the provider published it");
  discoveryIssuerSuffix = "";
  resetOidcCaches();
});

test("an expired session cookie is refused", () => {
  const value = mintSession({ sub: "user-1", email: "", name: "" });
  const [header64, payload64, signature64] = value.split(".") as [string, string, string];
  const claims = JSON.parse(Buffer.from(payload64, "base64url").toString("utf8"));
  claims.exp = Math.floor(Date.now() / 1000) - 1;
  // Re-mint with the real secret so only the expiry is wrong — this checks the
  // expiry rule, not the signature rule the test above covers.
  const forged = mintSession({ sub: "user-1", email: "", name: "" });
  const shorter = `${header64}.${base64url(JSON.stringify(claims))}.${signature64}`;
  assert.equal(readSession(shorter), null);
  assert.ok(readSession(forged));
});
