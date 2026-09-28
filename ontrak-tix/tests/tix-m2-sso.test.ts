/**
 * OnTrak Tix M2 tests: SSO (OIDC), the security-console renderer and the polled
 * vendor alert source.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m2-sso.test.ts
 */

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import {
  buildAuthorizationUrl,
  discoveryUrl,
  extractOidcClaims,
  homePathForRole,
  isAuthorizationState,
  safeReturnTo,
  stateExpired,
  validateDiscovery,
  type AuthorizationState,
} from "../src/lib/oidc-rules";
import { HttpOidcClient, MemoryOidcClient, codeChallengeFor, createPkcePair, randomUrlSafe } from "../src/lib/oidc-client";
import {
  HttpAlertSource,
  MemoryAlertSource,
  SecurityAlertConnector,
  VendorAlertPoller,
  alertSourceConfigFromEnv,
  toAlertDeliveries,
} from "../src/lib/security-alert-connector";
import { MemorySecurityAlertStore, SecurityAlertService, type SecurityAlertRecord } from "../src/lib/security-alert-service";
import type { PromotionRecord } from "../src/lib/alert-promotion-service";
import { SecurityAlertList } from "../src/components/SecurityAlertList";

const ISSUER = "https://idp.acme.test";

/* --------------------------------------------------------------- discovery */

test("discovery must describe the issuer we asked about", () => {
  const document = {
    issuer: `${ISSUER}/`,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks.json`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
  };
  const ok = validateDiscovery(document, ISSUER);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.discovery.tokenEndpoint, `${ISSUER}/token`);
    assert.equal(ok.discovery.userinfoEndpoint, `${ISSUER}/userinfo`);
  }

  assert.equal(validateDiscovery({ ...document, issuer: "https://evil.test" }, ISSUER).ok, false);
  assert.equal(validateDiscovery({ ...document, token_endpoint: "" }, ISSUER).ok, false);
  assert.equal(validateDiscovery("nope", ISSUER).ok, false);
  assert.equal(discoveryUrl(`${ISSUER}/`), `${ISSUER}/.well-known/openid-configuration`);
});

/* -------------------------------------------------------- authorization URL */

test("the authorization URL requests openid once and carries state, nonce and PKCE", () => {
  const url = new URL(
    buildAuthorizationUrl(
      { issuer: ISSUER, authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`, jwksUri: `${ISSUER}/jwks.json` },
      {
        clientId: "ontrak-tix",
        redirectUri: "https://desk.test/api/sso/callback",
        scopes: ["openid", "email", "groups", "email"],
        state: "s1",
        nonce: "n1",
        codeChallenge: "challenge",
      },
    ),
  );
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "openid email groups");
  assert.equal(url.searchParams.get("state"), "s1");
  assert.equal(url.searchParams.get("nonce"), "n1");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), "https://desk.test/api/sso/callback");
});

/* ------------------------------------------------------------------ claims */

test("ID-token claims are checked and mapped onto identity claims", () => {
  const payload = {
    iss: ISSUER,
    sub: "idp-1",
    email: "Sam@Acme.Test",
    name: "Sam Patel",
    nonce: "n1",
    groups: ["helpdesk"],
    roles: ["it-leads"],
    amr: ["pwd", "otp"],
  };
  const result = extractOidcClaims(payload, { issuer: ISSUER, nonce: "n1" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.claims.email, "Sam@Acme.Test");
  assert.deepEqual(result.claims.groups, ["helpdesk", "it-leads"]);
  assert.deepEqual(result.claims.amr, ["pwd", "otp"]);
  assert.equal(result.claims.claims?.roles instanceof Array, true);

  assert.equal(extractOidcClaims({ ...payload, iss: "https://evil.test" }, { issuer: ISSUER, nonce: "n1" }).ok, false);
  assert.equal(extractOidcClaims({ ...payload, nonce: "other" }, { issuer: ISSUER, nonce: "n1" }).ok, false);
  assert.equal(extractOidcClaims({ ...payload, sub: "" }, { issuer: ISSUER }).ok, false);
  assert.equal(extractOidcClaims({ ...payload, email: undefined, preferred_username: "bob" }, { issuer: ISSUER }).ok, false);
  assert.equal(extractOidcClaims({ ...payload, email_verified: false }, { issuer: ISSUER }).ok, false);
});

test("a preferred_username that looks like an email is accepted", () => {
  const result = extractOidcClaims({ iss: ISSUER, sub: "u", preferred_username: "jo@acme.test" }, { issuer: ISSUER });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.claims.email, "jo@acme.test");
});

/* ------------------------------------------------------------------- state */

test("authorization state is validated, expired and never an open redirect", () => {
  const state: AuthorizationState = {
    state: "s",
    nonce: "n",
    codeVerifier: "v",
    tenantId: "tenant-a",
    returnTo: "/inbox",
    at: "2026-09-01T12:00:00.000Z",
  };
  assert.equal(isAuthorizationState(state), true);
  assert.equal(isAuthorizationState({ ...state, codeVerifier: undefined }), false);
  assert.equal(isAuthorizationState(null), false);

  assert.equal(stateExpired(state, "2026-09-01T12:05:00.000Z"), false);
  assert.equal(stateExpired(state, "2026-09-01T12:11:00.000Z"), true);

  assert.equal(safeReturnTo("/inbox?filter=sla"), "/inbox?filter=sla");
  assert.equal(safeReturnTo("/portal"), "/portal");
  assert.equal(safeReturnTo("//evil.test"), null);
  assert.equal(safeReturnTo("https://evil.test"), null);
  assert.equal(safeReturnTo(""), null);
  assert.equal(homePathForRole("REQUESTER"), "/portal");
  assert.equal(homePathForRole("AGENT"), "/inbox");
});

/* ------------------------------------------------------------------ client */

test("PKCE derives the S256 challenge and the memory client answers from a fixture", async () => {
  const pkce = createPkcePair();
  assert.equal(pkce.challenge, codeChallengeFor(pkce.verifier));
  assert.notEqual(randomUrlSafe(16), randomUrlSafe(16));

  const client = new MemoryOidcClient({ payloads: { code1: { sub: "u1" } } });
  const discovery = await client.discover(ISSUER);
  assert.equal(discovery.tokenEndpoint, `${ISSUER}/token`);
  const token = await client.exchangeCode({
    discovery,
    clientId: "c",
    clientSecret: null,
    code: "code1",
    redirectUri: "https://desk/api/sso/callback",
    codeVerifier: "v",
  });
  assert.deepEqual(token.payload, { sub: "u1" });
  await assert.rejects(
    () => client.exchangeCode({ discovery, clientId: "c", clientSecret: null, code: "missing", redirectUri: "x", codeVerifier: "v" }),
    /No ID token fixture/,
  );
});

test("the HTTP client surfaces discovery and token failures", async () => {
  const failing = new HttpOidcClient(async () => new Response("nope", { status: 500 }));
  await assert.rejects(() => failing.discover(ISSUER), /answered 500/);

  const notJson = new HttpOidcClient(async () => new Response("<html>", { status: 200 }));
  await assert.rejects(() => notJson.discover(ISSUER), /not JSON/);

  const badIssuer = new HttpOidcClient(async () =>
    new Response(JSON.stringify({ issuer: "https://evil.test", authorization_endpoint: "x", token_endpoint: "y", jwks_uri: "z" }), { status: 200 }),
  );
  await assert.rejects(() => badIssuer.discover(ISSUER), /does not match/);

  const noIdToken = new HttpOidcClient(async () => new Response(JSON.stringify({ access_token: "a" }), { status: 200 }));
  await assert.rejects(
    () =>
      noIdToken.exchangeCode({
        discovery: { issuer: ISSUER, authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`, jwksUri: `${ISSUER}/jwks.json` },
        clientId: "c",
        clientSecret: null,
        code: "c1",
        redirectUri: "https://desk/api/sso/callback",
        codeVerifier: "v",
      }),
    /no ID token/,
  );
});

test("the HTTP client verifies the ID token against the issuer's JWKS", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  const idToken = await new SignJWT({ email: "sam@acme.test", nonce: "n1" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience("ontrak-tix")
    .setSubject("idp-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    const body = url.includes("jwks") ? { keys: [jwk] } : { id_token: idToken, access_token: "at" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const result = await new HttpOidcClient().exchangeCode({
      discovery: { issuer: ISSUER, authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`, jwksUri: `${ISSUER}/jwks.json` },
      clientId: "ontrak-tix",
      clientSecret: null,
      code: "c1",
      redirectUri: "https://desk/api/sso/callback",
      codeVerifier: "v",
    });
    assert.equal(result.payload.sub, "idp-1");
    assert.equal(result.payload.email, "sam@acme.test");
    assert.equal(result.accessToken, "at");

    const claims = extractOidcClaims(result.payload, { issuer: ISSUER, nonce: "n1" });
    assert.equal(claims.ok, true);
  } finally {
    globalThis.fetch = original;
  }
});

/* ------------------------------------------------------------- poll source */

test("a vendor list response is read in any of its shapes", () => {
  assert.deepEqual(toAlertDeliveries([{ id: "a" }, { externalId: "b" }]).map((d) => d.id), ["a", "b"]);
  assert.deepEqual(toAlertDeliveries({ alerts: [{ alertId: "c" }] }).map((d) => d.id), ["c"]);
  assert.deepEqual(toAlertDeliveries({ items: [{ eventId: "d" }] }).map((d) => d.id), ["d"]);
  // An envelope with its own id and a payload.
  assert.deepEqual(toAlertDeliveries({ data: [{ id: "e", payload: { vendor: "Snort" } }] })[0], { id: "e", payload: { vendor: "Snort" } });
  // No id at all still yields a stable positional id.
  assert.equal(toAlertDeliveries([{}, {}])[1].id, "idx-1");
  assert.deepEqual(toAlertDeliveries("nope"), []);
});

test("the HTTP source lists, acknowledges and tolerates a read-only config", async () => {
  const seen: { url: string; method: string }[] = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? "GET" });
    if (init?.method === "POST") return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ alerts: [{ id: "a1", vendor: "Snort" }] }), { status: 200 });
  };

  const source = new HttpAlertSource({ url: "https://vendor.test/alerts", token: "t", ackUrl: "https://vendor.test/alerts/<id>/ack", fetchImpl });
  const deliveries = await source.fetchUnseen(10);
  assert.deepEqual(deliveries, [{ id: "a1", payload: { id: "a1", vendor: "Snort" } }]);
  assert.match(seen[0].url, /limit=10/);
  await source.acknowledge("a1");
  assert.equal(seen[1].url, "https://vendor.test/alerts/a1/ack");
  assert.equal(seen[1].method, "POST");

  const readOnly = new HttpAlertSource({ url: "https://vendor.test/alerts", fetchImpl });
  await readOnly.acknowledge("a1"); // no ack URL: nothing happens, and nothing throws
  assert.equal(seen.length, 2);
});

test("a failing source and a missing config are reported, not swallowed", async () => {
  const failing = new HttpAlertSource({ url: "https://vendor.test/alerts", fetchImpl: async () => new Response("", { status: 503 }) });
  await assert.rejects(() => failing.fetchUnseen(5), /answered 503/);

  assert.equal(alertSourceConfigFromEnv({}), null);
  assert.deepEqual(alertSourceConfigFromEnv({ ONTRAK_TIX_ALERT_SOURCE_URL: "https://v.test/alerts" }), {
    url: "https://v.test/alerts",
    token: null,
    ackUrl: null,
  });
});

test("the poller drains a real source through the connector and defers failures", async () => {
  const service = new SecurityAlertService(new MemorySecurityAlertStore());
  const connector = new SecurityAlertConnector(service, "tenant-a");
  const source = new MemoryAlertSource();
  source.add({ vendor: "Snort", signature: "ET SCAN", timestamp: "2026-09-01T12:00:00Z", id: "x1" }, "d1");
  source.add({ vendor: "Snort", signature: "ET SCAN", timestamp: "2026-09-01T12:00:00Z", id: "x1" }, "d2");

  const result = await new VendorAlertPoller(connector, source).poll();
  assert.equal(result.outcomes.length, 2);
  assert.equal(result.deferred, 0);
  assert.equal(source.size, 0);
});

/* ---------------------------------------------------------- triage renderer */

function alert(overrides: Partial<SecurityAlertRecord> = {}): SecurityAlertRecord {
  return {
    id: "alert-1",
    tenantId: "tenant-a",
    source: "IDS",
    severity: "HIGH",
    triageSeverity: "CRITICAL",
    signature: "ET SCAN Potential SSH Scan",
    description: "Possible SSH scan from an external host",
    externalId: null,
    asset: "web-01",
    assetKnown: true,
    assetOwner: "platform",
    assetCriticality: "CRITICAL",
    clientId: "acme",
    identity: null,
    identityKnown: false,
    identityName: null,
    identityPrivileged: false,
    sourceIp: "203.0.113.9",
    rawRef: null,
    dedupeKey: "fp:IDS|et scan|web-01|-|2026-09-01T12:00:00.000Z",
    occurredAt: "2026-09-01T12:00:00.000Z",
    firstSeenAt: "2026-09-01T12:00:00.000Z",
    lastSeenAt: "2026-09-01T12:03:00.000Z",
    occurrences: 3,
    ticketId: null,
    ...overrides,
  };
}

test("the triage list renders severity, enrichment and the actions", () => {
  const html = renderToStaticMarkup(
    createElement(SecurityAlertList, {
      alerts: [alert()],
      actions: { promote: async () => {}, verdict: async () => {} },
    }),
  );
  assert.match(html, /ET SCAN Potential SSH Scan/);
  assert.match(html, /CRITICAL/);
  assert.match(html, /IDS/);
  assert.match(html, /critical asset/);
  assert.match(html, /Asset web-01 \(CRITICAL\)/);
  assert.match(html, /203\.0\.113\.9/);
  assert.match(html, /Open incident/);
  assert.match(html, /Mark false positive/);
});

test("a promoted alert links the ticket and drops the actions", () => {
  const html = renderToStaticMarkup(
    createElement(SecurityAlertList, {
      alerts: [alert({ ticketId: "tkt-1" })],
      promotionsFor: () => ({ id: "p1", tenantId: "tenant-a", alertId: "alert-1", decision: "PROMOTE", reason: "HIGH", ticketId: "tkt-1", ticketRef: "TIX-000042", at: "2026-09-01T12:04:00.000Z" }) as PromotionRecord,
      actions: { promote: async () => {}, verdict: async () => {} },
    }),
  );
  assert.match(html, /Promoted to/);
  assert.match(html, /TIX-000042/);
  assert.match(html, /\/inbox\/tkt-1/);
  assert.doesNotMatch(html, /Open incident/);
});

test("a suppressed alert shows its reason and the empty state is tailored", () => {
  const html = renderToStaticMarkup(
    createElement(SecurityAlertList, {
      alerts: [alert()],
      promotionsFor: () => ({ id: "p1", tenantId: "tenant-a", alertId: "alert-1", decision: "SUPPRESS", reason: "2 false-positive verdict(s).", ticketId: null, ticketRef: null, at: "2026-09-01T12:04:00.000Z" }) as PromotionRecord,
    }),
  );
  assert.match(html, /Suppressed — 2 false-positive verdict\(s\)\./);
  // With no actions supplied, the triage buttons are absent.
  assert.doesNotMatch(html, /Open incident/);

  const empty = renderToStaticMarkup(createElement(SecurityAlertList, { alerts: [] }));
  assert.match(empty, /No security alerts have been ingested yet/);
});
