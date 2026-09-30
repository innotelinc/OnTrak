/**
 * OnTrak Sentinel tests: upstream (provider) sign-in for the console.
 *
 * The console has always had a password form; this is the other door, where Cerulean's
 * Authentik signs the person in. The tests follow the ways a brokered login goes wrong:
 *
 *  - a callback a stranger crafts (no cookie, a tampered cookie, a state that does not
 *    match) — which is the login-CSRF the sealed state exists to stop;
 *  - an ID token signed by somebody else, or issued for another client, or answering a
 *    different request — every one of which is only caught if the signature is checked
 *    before the claims are believed;
 *  - a login the provider never marked as multi-factor, which must not become a session
 *    when the policy requires one;
 *  - and a return path that is really an absolute URL, which is how a login page becomes
 *    an open redirector.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { constants, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { sha256Hex } from "../src/lib/hash";
import { ConsoleService } from "../src/lib/console-service";
import { routeConsole } from "../src/lib/console-http";
import { CONSOLE_PATHS, CONSOLE_SESSION_COOKIE } from "../src/lib/console-rules";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog } from "../src/lib/identity-service";
import { MemoryMfaStore, MfaService } from "../src/lib/mfa-service";
import type { HttpRequest } from "../src/lib/oidc-http";
import {
  buildAuthorizeUrl,
  identifierFromClaims,
  parseDiscovery,
  readCallback,
  roleFromClaims,
  safeReturnTo,
  UPSTREAM_STATE_COOKIE,
  upstreamAssertsMfa,
  upstreamConfigFromEnv,
} from "../src/lib/upstream-rules";
import { UpstreamSignInService, open, pkceChallenge, seal } from "../src/lib/upstream-service";

const ISSUER = "https://auth.cerulean.innotel.us/application/o/sentinel/";
const AUTH = "https://auth.cerulean.innotel.us/application/o/authorize/";
const TOKEN = "https://auth.cerulean.innotel.us/application/o/token/";
const JWKS = "https://auth.cerulean.innotel.us/application/o/sentinel/jwks/";
const REDIRECT = "https://sentinel.ontrak.innotel.us/console/sign-in/upstream/callback";
const SECRET = "test-state-secret";

function config(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    clientId: "sentinel",
    clientSecret: "shhh",
    redirectUri: REDIRECT,
    scopes: ["openid", "email", "profile"],
    adminGroup: "cerulean-platform",
    defaultOrganizationSlug: "demo",
    landingPath: "/console",
    trustAssertedMfa: false,
    stateTtlSeconds: 600,
    label: "Cerulean SSO",
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Sign an ID token with a generated key, the way a provider would. */
function signIdToken(claims: Record<string, unknown>, key: KeyObject, kid: string): string {
  const input = `${encode({ alg: "RS256", typ: "JWT", kid })}.${encode(claims)}`;
  const signature = sign("sha256", Buffer.from(input, "utf8"), { key, padding: constants.RSA_PKCS1_PADDING });
  return `${input}.${signature.toString("base64url")}`;
}

function publicJwk(key: KeyObject, kid: string): Record<string, unknown> {
  return { ...(key.export({ format: "jwk" }) as Record<string, unknown>), kid, alg: "RS256", use: "sig" };
}

async function makeSpine(scope: string) {
  const store = new MemoryIdentityStore();
  const audit = new OrganizationAuditLog(sha256Hex);
  let n = 0;
  const spine = new IdentityService(store, audit, {
    id: () => `${scope}-id-${++n}`,
    now: () => new Date(Date.UTC(2026, 8, 30)).toISOString(),
    nowMs: () => Date.UTC(2026, 8, 30),
  });
  const boot = await spine.bootstrapOrganization(
    `${scope}-script`,
    { name: "Sentinel demo", slug: "demo" },
    { identifier: "admin@demo.test", displayName: "Demo Admin" },
  );
  assert.ok(boot.ok);
  return { store, audit, spine };
}

/* -------------------------------------------------------------------------- */
/*  Configuration                                                              */
/* -------------------------------------------------------------------------- */

test("an unconfigured upstream is off, not an error", () => {
  assert.equal(upstreamConfigFromEnv({}), null);
});

test("a half-configured upstream is an error rather than a surprise", () => {
  assert.throws(() => upstreamConfigFromEnv({ SENTINEL_UPSTREAM_ISSUER: ISSUER }), /CLIENT_ID/);
  assert.throws(
    () => upstreamConfigFromEnv({ SENTINEL_UPSTREAM_ISSUER: "not-a-url", SENTINEL_UPSTREAM_CLIENT_ID: "x", SENTINEL_UPSTREAM_REDIRECT_URI: REDIRECT }),
    /absolute URL/,
  );
});

test("a configured upstream parses into sane defaults", () => {
  const parsed = upstreamConfigFromEnv({
    SENTINEL_UPSTREAM_ISSUER: ISSUER,
    SENTINEL_UPSTREAM_CLIENT_ID: "sentinel",
    SENTINEL_UPSTREAM_REDIRECT_URI: REDIRECT,
    SENTINEL_UPSTREAM_LABEL: "Cerulean SSO",
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.scopes, ["openid", "email", "profile"]);
  assert.equal(parsed.trustAssertedMfa, false);
  assert.equal(parsed.label, "Cerulean SSO");
});

/* -------------------------------------------------------------------------- */
/*  The request                                                                */
/* -------------------------------------------------------------------------- */

test("PKCE S256 matches the RFC's own vector", () => {
  assert.equal(
    pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("the authorization URL carries the code challenge and method", () => {
  const url = new URL(
    buildAuthorizeUrl(
      { issuer: ISSUER, authorizationEndpoint: AUTH, tokenEndpoint: TOKEN, jwksUri: JWKS, endSessionEndpoint: null },
      config() as never,
      { state: "st", nonce: "no", codeChallenge: "ch" },
    ),
  );
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "sentinel");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "ch");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
});

test("a callback without a state is not a reply to a sign-in we started", () => {
  assert.equal(readCallback(new URLSearchParams({ code: "c" })).ok, false);
  const refused = readCallback(new URLSearchParams({ error: "access_denied", error_description: "no" }));
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /provider refused/);
});

test("discovery must name the issuer we configured", () => {
  const wrong = parseDiscovery({ issuer: "https://evil.test", authorization_endpoint: AUTH, token_endpoint: TOKEN, jwks_uri: JWKS }, ISSUER);
  assert.ok("error" in wrong);
  const right = parseDiscovery({ issuer: ISSUER, authorization_endpoint: AUTH, token_endpoint: TOKEN, jwks_uri: JWKS }, ISSUER);
  assert.ok(!("error" in right));
});

test("only a rooted path is ever a return path", () => {
  assert.equal(safeReturnTo("/console/mfa"), "/console/mfa");
  assert.equal(safeReturnTo("//evil.test"), null);
  assert.equal(safeReturnTo("https://evil.test"), null);
  assert.equal(safeReturnTo("/\\evil"), null);
  assert.equal(safeReturnTo(null), null);
});

/* -------------------------------------------------------------------------- */
/*  Claims                                                                     */
/* -------------------------------------------------------------------------- */

test("the person is named by email, and the role only by the admin group", () => {
  const claims = { email: "Ada@Innotel.US", groups: ["cerulean-platform", "other"] };
  assert.equal(identifierFromClaims(claims), "ada@innotel.us");
  assert.equal(roleFromClaims(claims, "cerulean-platform"), "ADMIN");
  assert.equal(roleFromClaims(claims, null), "AGENT");
  assert.equal(roleFromClaims({ email: "x@y.z", groups: ["other"] }, "cerulean-platform"), "AGENT");
});

test("only an explicit factor assertion counts as multi-factor", () => {
  assert.equal(upstreamAssertsMfa({ amr: ["pwd", "otp"] }), true);
  assert.equal(upstreamAssertsMfa({ amr: ["pwd"] }), false);
  assert.equal(upstreamAssertsMfa({ amr: "pwd,mfa" }), true);
  assert.equal(upstreamAssertsMfa({ acr: "urn:mfa" }), true);
  assert.equal(upstreamAssertsMfa({}), false);
});

test("sealing round-trips and refuses a tampered envelope", () => {
  const sealed = seal({ state: "s" }, SECRET);
  assert.deepEqual(open<{ state: string }>(sealed, SECRET), { state: "s" });
  assert.equal(open(sealed, "another-secret"), null);
  const [body] = sealed.split(".");
  assert.equal(open(`${body}x.${sealed.split(".")[1]}`, SECRET), null);
});

/* -------------------------------------------------------------------------- */
/*  The whole handshake                                                        */
/* -------------------------------------------------------------------------- */

test("a full upstream sign-in issues a session and provisions the identity", async () => {
  const { store, audit, spine } = await makeSpine("up");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let token = "";

  const fetcher = async (url: string) => {
    if (url.endsWith("/.well-known/openid-configuration")) {
      return jsonResponse(200, { issuer: ISSUER, authorization_endpoint: AUTH, token_endpoint: TOKEN, jwks_uri: JWKS });
    }
    if (url === TOKEN) return jsonResponse(200, { id_token: token });
    if (url === JWKS) return jsonResponse(200, { keys: [publicJwk(publicKey, "k1")] });
    return jsonResponse(404, {});
  };

  const service = new UpstreamSignInService(config() as never, store, spine, {
    secret: SECRET,
    audit,
    fetchImpl: fetcher,
    now: () => Date.UTC(2026, 8, 30),
  });

  const started = await service.start();
  assert.ok(started.ok);
  const sealed = started.value.setCookie.split(";")[0]!.split("=")[1]!;
  const attempt = open<{ state: string; nonce: string }>(sealed, SECRET)!;

  token = signIdToken(
    {
      iss: ISSUER,
      aud: "sentinel",
      exp: Math.floor(Date.UTC(2026, 8, 30) / 1000) + 300,
      nonce: attempt.nonce,
      email: "ada@innotel.us",
      name: "Ada Lovelace",
      groups: ["cerulean-platform"],
      amr: ["pwd", "otp"],
    },
    privateKey,
    "k1",
  );

  const done = await service.complete({ code: "code", state: attempt.state, stateCookie: sealed });
  assert.ok(done.ok, done.ok ? "" : done.error);
  const session = await spine.resolveOwnSession(done.value.sessionId);
  assert.ok(session.ok);
  assert.equal(session.value.identity.identifier, "ada@innotel.us");
  assert.equal(session.value.identity.role, "ADMIN");
});

test("a tampered state cookie is refused before any code is spent", async () => {
  const { store, spine } = await makeSpine("tamper");
  const fetcher = async (url: string) =>
    url.endsWith("/.well-known/openid-configuration")
      ? jsonResponse(200, { issuer: ISSUER, authorization_endpoint: AUTH, token_endpoint: TOKEN, jwks_uri: JWKS })
      : jsonResponse(404, {});
  const service = new UpstreamSignInService(config() as never, store, spine, { secret: SECRET, fetchImpl: fetcher, now: () => Date.UTC(2026, 8, 30) });
  const started = await service.start();
  assert.ok(started.ok);
  const sealed = started.value.setCookie.split(";")[0]!.split("=")[1]!;
  const tampered = `${sealed.slice(0, -2)}xx`;
  const done = await service.complete({ code: "code", state: "whatever", stateCookie: tampered });
  assert.equal(done.ok, false);
});

test("an ID token signed by another key is refused", async () => {
  const { store, spine } = await makeSpine("forge");
  const provider = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let token = "";
  const fetcher = async (url: string) => {
    if (url.endsWith("/.well-known/openid-configuration")) return jsonResponse(200, { issuer: ISSUER, authorization_endpoint: AUTH, token_endpoint: TOKEN, jwks_uri: JWKS });
    if (url === TOKEN) return jsonResponse(200, { id_token: token });
    if (url === JWKS) return jsonResponse(200, { keys: [publicJwk(provider.publicKey, "k1")] });
    return jsonResponse(404, {});
  };
  const service = new UpstreamSignInService(config() as never, store, spine, { secret: SECRET, fetchImpl: fetcher, now: () => Date.UTC(2026, 8, 30) });
  const started = await service.start();
  assert.ok(started.ok);
  const sealed = started.value.setCookie.split(";")[0]!.split("=")[1]!;
  const attempt = open<{ state: string; nonce: string }>(sealed, SECRET)!;
  token = signIdToken(
    { iss: ISSUER, aud: "sentinel", exp: Math.floor(Date.UTC(2026, 8, 30) / 1000) + 300, nonce: attempt.nonce, email: "ada@innotel.us", amr: ["otp"] },
    attacker.privateKey,
    "k1",
  );
  const done = await service.complete({ code: "code", state: attempt.state, stateCookie: sealed });
  assert.equal(done.ok, false);
});

test("a login the provider did not mark multi-factor is refused when MFA is required", async () => {
  const { store, spine } = await makeSpine("nomfa");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let token = "";
  const fetcher = async (url: string) => {
    if (url.endsWith("/.well-known/openid-configuration")) return jsonResponse(200, { issuer: ISSUER, authorization_endpoint: AUTH, token_endpoint: TOKEN, jwks_uri: JWKS });
    if (url === TOKEN) return jsonResponse(200, { id_token: token });
    if (url === JWKS) return jsonResponse(200, { keys: [publicJwk(publicKey, "k1")] });
    return jsonResponse(404, {});
  };
  const service = new UpstreamSignInService(config() as never, store, spine, { secret: SECRET, fetchImpl: fetcher, now: () => Date.UTC(2026, 8, 30) });
  const started = await service.start();
  assert.ok(started.ok);
  const sealed = started.value.setCookie.split(";")[0]!.split("=")[1]!;
  const attempt = open<{ state: string; nonce: string }>(sealed, SECRET)!;
  token = signIdToken(
    { iss: ISSUER, aud: "sentinel", exp: Math.floor(Date.UTC(2026, 8, 30) / 1000) + 300, nonce: attempt.nonce, email: "ada@innotel.us", amr: ["pwd"] },
    privateKey,
    "k1",
  );
  const done = await service.complete({ code: "code", state: attempt.state, stateCookie: sealed });
  assert.equal(done.ok, false);
});

/* -------------------------------------------------------------------------- */
/*  The console's second door, end to end                                      */
/* -------------------------------------------------------------------------- */

/** A request as the console router sees one, carrying the cookies a browser would send. */
function consoleRequest(method: string, path: string, cookies: Record<string, string> = {}): HttpRequest {
  return { method, url: `https://sentinel.ontrak.innotel.us${path}`, headers: {}, cookies };
}

/**
 * The whole way in, through the router rather than the service.
 *
 * The unit tests above prove each leg; this one proves they add up to a session a person
 * can actually use, which is the only thing "sign in with SSO" means. It is also where
 * the shape of the two cookies is pinned: the callback clears the spent attempt *and* sets
 * the session, and the failure mode of packing both into one comma-joined `Set-Cookie` is
 * silent — a browser takes the first cookie and the person is told they are not signed in
 * by the page they were just sent to. Two headers, so a browser has nothing to guess at.
 */
test("the console's SSO door ends in a session the console itself accepts", async () => {
  const { store, audit, spine } = await makeSpine("door");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let token = "";
  const fetcher = async (url: string) => {
    if (url.endsWith("/.well-known/openid-configuration")) {
      return jsonResponse(200, { issuer: ISSUER, authorization_endpoint: AUTH, token_endpoint: TOKEN, jwks_uri: JWKS });
    }
    if (url === TOKEN) return jsonResponse(200, { id_token: token });
    if (url === JWKS) return jsonResponse(200, { keys: [publicJwk(publicKey, "k1")] });
    return jsonResponse(404, {});
  };
  const provider = new UpstreamSignInService(config() as never, store, spine, {
    secret: SECRET,
    audit,
    fetchImpl: fetcher,
    now: () => Date.UTC(2026, 8, 30),
  });
  const mfa = new MfaService(new MemoryMfaStore(), spine, audit, {
    id: () => "door-factor",
    secret: () => "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    now: () => new Date(Date.UTC(2026, 8, 30)).toISOString(),
    nowMs: () => Date.UTC(2026, 8, 30),
  });
  const doors = new ConsoleService(spine, mfa, null, null, null, null, "demo", null, null, null, provider);

  // The form names the provider the deployment configured rather than drawing a control
  // that could never work.
  const page = await routeConsole(consoleRequest("GET", CONSOLE_PATHS.signIn), doors);
  assert.equal(page.status, 200);
  assert.match(page.body, /Sign in with Cerulean SSO/);

  // Starting seals the attempt into a cookie and hands the browser to the provider.
  const started = await routeConsole(consoleRequest("GET", CONSOLE_PATHS.upstreamStart), doors);
  assert.equal(started.status, 303);
  assert.match(String(started.headers.location), /^https:\/\/auth\.cerulean\.innotel\.us\/application\/o\/authorize\//);
  const sealed = String(started.headers["set-cookie"]).split(";")[0]!.split("=")[1]!;
  const attempt = open<{ state: string; nonce: string }>(sealed, SECRET)!;

  token = signIdToken(
    {
      iss: ISSUER,
      aud: "sentinel",
      exp: Math.floor(Date.UTC(2026, 8, 30) / 1000) + 300,
      nonce: attempt.nonce,
      email: "ada@innotel.us",
      name: "Ada Lovelace",
      groups: ["cerulean-platform"],
      amr: ["pwd", "otp"],
    },
    privateKey,
    "k1",
  );

  const callback = await routeConsole(
    consoleRequest("GET", `${CONSOLE_PATHS.upstreamCallback}?code=code&state=${encodeURIComponent(attempt.state)}`, {
      [UPSTREAM_STATE_COOKIE]: sealed,
    }),
    doors,
  );
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.location, CONSOLE_PATHS.home);
  const cookies = callback.headers["set-cookie"];
  assert.ok(Array.isArray(cookies), "the two cookies travel as two headers");
  assert.match(cookies[0]!, new RegExp(`^${UPSTREAM_STATE_COOKIE}=;`), "and the spent attempt is cleared");
  assert.match(cookies[1]!, new RegExp(`^${CONSOLE_SESSION_COOKIE}=`), "while the session is set");

  // The session the provider brokered is the one the console accepts: the page renders
  // rather than bouncing the person straight back to the door they just came through.
  const sessionId = cookies[1]!.split(";")[0]!.split("=")[1]!;
  const home = await routeConsole(consoleRequest("GET", CONSOLE_PATHS.home, { [CONSOLE_SESSION_COOKIE]: sessionId }), doors);
  assert.equal(home.status, 200);
  assert.match(home.body, new RegExp(sessionId));
});
