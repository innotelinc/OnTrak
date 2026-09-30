/**
 * OnTrak Sentinel S1 tests: logout and token revocation.
 *
 * Sign-out and revocation are the two halves of one promise — *a session that
 * ends stops working immediately* — so each test follows one of the ways that
 * promise can be quietly broken:
 *
 *  - a token that outlives the session it came from (the classic bug: the session
 *    is ended and the access token is not);
 *  - a session that outlives its tokens (the other half, and the reason logout
 *    ends the session through the spine rather than only stamping rows);
 *  - a `post_logout_redirect_uri` we did not register, which is how an IdP is
 *    turned into an open redirector;
 *  - and a revocation endpoint that answers differently for a live token and a
 *    dead one, which makes it a token oracle.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sha256Hex } from "../src/lib/hash";
import type { HashFn } from "../src/lib/audit-chain";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog, type IdentityActor } from "../src/lib/identity-service";
import { generateSigningKey, type SigningKey } from "../src/lib/oidc-keys";
import { codeChallengeFor, isTokenActive, validateLogoutRequest, validateRevocationRequest } from "../src/lib/oidc-rules";
import { routeOidc, type HttpRequest } from "../src/lib/oidc-http";
import { MemoryOidcStore, OidcService, type OidcIds } from "../src/lib/oidc-service";

const sha256: HashFn = sha256Hex;
const ISSUER = "https://identity.acme.test";
const KEYS: SigningKey = generateSigningKey();
const VERIFIER = "3lR6kQz1vB9wS2pJ8nH4tY7cM0xG5dF1aK9eU2rT6bN8sW";
const REDIRECT_URI = "https://tix.acme.test/api/sso/callback";

let harnessSeq = 0;

function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  let clock = Date.parse("2026-09-30T09:00:00.000Z");
  let n = 0;
  const scope = `o${++harnessSeq}`;
  const ids = {
    id: () => `${scope}-id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };
  const spine = new IdentityService(identities, audit, ids);
  const oidcIds: OidcIds = {
    id: () => `${scope}-ev-${++n}`,
    clientId: () => `${scope}-client-${++n}`,
    code: () => `${scope}-code-${++n}`,
    token: () => `${scope}-token-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };
  const store = new MemoryOidcStore();
  const oidc = new OidcService(store, identities, spine, { issuer: ISSUER, keys: KEYS }, audit, oidcIds, sha256);

  return {
    spine,
    oidc,
    store,
    identities,
    audit,
    ids,
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
    nowMs: () => clock,
  };
}

/** A bootstrapped organization, its admin, a live session, a client and a token. */
async function signedIn() {
  const h = harness();
  const created = await h.spine.bootstrapOrganization(
    "founder-1",
    { name: "Acme MSP", slug: `acme-${harnessSeq}-${Date.now()}` },
    { identifier: "admin@acme.test", displayName: "Ada Admin" },
  );
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) throw new Error("unreachable");
  const actor: IdentityActor = { id: created.value.admin.id, organizationId: created.value.organization.id, role: "ADMIN" };

  await h.spine.setMfaEnrolled(actor, actor.id, true);
  const session = await h.spine.issueSession(actor.organizationId, actor.id);
  assert.equal(session.ok, true);
  if (!session.ok) throw new Error("unreachable");

  const client = await h.oidc.registerClient(actor, {
    name: "OnTrak Tix",
    redirectUris: [REDIRECT_URI],
    scopes: ["openid", "profile", "email", "roles"],
  });
  assert.equal(client.ok, true, client.ok ? "" : client.error);
  if (!client.ok) throw new Error("unreachable");

  const code = await h.oidc.authorize({
    clientId: client.value.clientId,
    redirectUri: REDIRECT_URI,
    responseType: "code",
    scope: "openid profile email roles",
    state: "state-1",
    codeChallenge: codeChallengeFor(VERIFIER, sha256),
    codeChallengeMethod: "S256",
    sessionId: session.value.id,
  });
  assert.equal(code.ok, true, code.ok ? "" : code.error);
  if (!code.ok) throw new Error("unreachable");

  const tokens = await h.oidc.token({
    grantType: "authorization_code",
    clientId: client.value.clientId,
    code: code.code,
    redirectUri: REDIRECT_URI,
    codeVerifier: VERIFIER,
  });
  assert.equal(tokens.ok, true, tokens.ok ? "" : tokens.error);
  if (!tokens.ok) throw new Error("unreachable");

  h.advance(60);
  return {
    ...h,
    actor,
    orgId: created.value.organization.id,
    session: session.value,
    client: client.value,
    accessToken: tokens.accessToken,
  };
}

/* -------------------------------------------------------------------------- */
/*  Metadata and the pure rules                                               */
/* -------------------------------------------------------------------------- */

test("discovery advertises the end-session and revocation endpoints", () => {
  const doc = harness().oidc.discovery();
  assert.equal(doc.end_session_endpoint, `${ISSUER}/oauth2/logout`);
  assert.equal(doc.revocation_endpoint, `${ISSUER}/oauth2/revoke`);
  // Revocation is reached with the token itself, so the document does not claim
  // to want a secret for it.
  assert.deepEqual(doc.revocation_endpoint_auth_methods_supported, ["none"]);
});

test("revocation is checked before expiry, in one place every reader asks", () => {
  const live = { revokedAt: null, expiresAt: 2_000 };
  assert.equal(isTokenActive(live, 1_999), true);
  // Revoked beats unexpired: the desk's decision outranks the clock.
  assert.equal(isTokenActive({ revokedAt: 1_500, expiresAt: 2_000 }, 1_600), false);
  assert.equal(isTokenActive(live, 2_000), false);
});

test("logout refuses a client it does not know, and drops a redirect it did not register", () => {
  const client = {
    clientId: "client-1",
    organizationId: "org-1",
    name: "Tix",
    redirectUris: [REDIRECT_URI],
    scopes: ["openid" as const],
    kind: "public" as const,
    createdBy: "admin-1",
    createdAt: "2026-09-30T00:00:00.000Z",
  };

  // Without a client_id there is no way to know which tenant's session is ending.
  assert.equal(validateLogoutRequest({ sessionId: "s1" }, client).ok, false);
  assert.equal(validateLogoutRequest({ clientId: "client-1", sessionId: "s1" }, null).ok, false);

  // A registered destination is honoured, and the state comes back with it.
  const honoured = validateLogoutRequest(
    { clientId: "client-1", postLogoutRedirectUri: REDIRECT_URI, state: "abc", sessionId: "s1" },
    client,
  );
  assert.equal(honoured.ok, true);
  assert.equal(honoured.ok && honoured.redirectTo, `${REDIRECT_URI}?state=abc`);

  // An unregistered one is *dropped*, not refused: the session still ends and we
  // simply do not send the browser anywhere. Refusing would be a worse answer,
  // and honouring it would make the provider an open redirector.
  const dropped = validateLogoutRequest(
    { clientId: "client-1", postLogoutRedirectUri: "https://evil.test/", sessionId: "s1" },
    client,
  );
  assert.equal(dropped.ok, true);
  assert.equal(dropped.ok && dropped.redirectTo, null);
});

test("an unrecognised token type hint is ignored, as RFC 7009 requires", () => {
  assert.deepEqual(validateRevocationRequest({ token: "t" }), { ok: true, token: "t" });
  assert.deepEqual(validateRevocationRequest({ token: " t ", tokenTypeHint: "urn:whatever" }), { ok: true, token: "t" });
  assert.equal(validateRevocationRequest({}).ok, false);
});

/* -------------------------------------------------------------------------- */
/*  Sign-out                                                                  */
/* -------------------------------------------------------------------------- */

test("signing out ends the session and kills every token it minted", async () => {
  const s = await signedIn();

  // The token works, so the test is about the sign-out rather than about a token
  // that never worked.
  const before = await s.oidc.userinfo(s.accessToken);
  assert.equal(before.ok, true, before.ok ? "" : before.error);

  const out = await s.oidc.logout({
    clientId: s.client.clientId,
    postLogoutRedirectUri: REDIRECT_URI,
    state: "bye",
    sessionId: s.session.id,
  });
  assert.equal(out.ok, true, out.ok ? "" : out.error);
  assert.equal(out.ok && out.redirectTo, `${REDIRECT_URI}?state=bye`);
  assert.equal(out.ok && out.revokedTokens, 1);

  // Both halves: the session is dead through the spine...
  const session = await s.spine.checkSession(s.orgId, s.session.id);
  assert.equal(session.active, false);
  assert.match(session.active === false ? session.reason : "", /revoked/);

  // ...and the token is revoked, so a client holding it stops working *now*.
  const after = await s.oidc.userinfo(s.accessToken);
  assert.equal(after.ok, false);
  assert.match(after.ok === false ? after.error : "", /revoked/);

  // A fresh authorize with the same (now dead) session gets nothing.
  const regrant = await s.oidc.authorize({
    clientId: s.client.clientId,
    redirectUri: REDIRECT_URI,
    responseType: "code",
    scope: "openid",
    state: "state-2",
    codeChallenge: codeChallengeFor(VERIFIER, sha256),
    codeChallengeMethod: "S256",
    sessionId: s.session.id,
  });
  assert.equal(regrant.ok, false);
});

test("signing out twice is a success, and the second one revokes nothing", async () => {
  const s = await signedIn();
  const first = await s.oidc.logout({ clientId: s.client.clientId, sessionId: s.session.id });
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.revokedTokens, 1);

  // The session is no longer *usable*, so the second attempt is refused rather
  // than silently reporting a second kill — but nothing about the first is undone.
  const second = await s.oidc.logout({ clientId: s.client.clientId, sessionId: s.session.id });
  assert.equal(second.ok, false);
  assert.equal((await s.oidc.userinfo(s.accessToken)).ok, false);
});

test("every step of a sign-out is on the organization's chain", async () => {
  const s = await signedIn();
  await s.oidc.logout({ clientId: s.client.clientId, sessionId: s.session.id });

  const actions = s.audit.trail(s.orgId).map((event) => event.action);
  assert.ok(actions.includes("oauth.client.register"), "the client registration is recorded");
  assert.ok(actions.includes("oauth.authorize"));
  assert.ok(actions.includes("oauth.token"));
  assert.ok(actions.includes("session.signout"), "the session ending is recorded");
  assert.ok(actions.includes("oauth.logout"), "and the sign-out itself names the tokens it revoked");
});

/* -------------------------------------------------------------------------- */
/*  Revocation                                                                */
/* -------------------------------------------------------------------------- */

test("revoking one token kills it and leaves the session and its siblings alone", async () => {
  const s = await signedIn();

  const revoked = await s.oidc.revoke({ token: s.accessToken });
  assert.deepEqual(revoked, { ok: true, known: true });
  assert.equal((await s.oidc.userinfo(s.accessToken)).ok, false);

  // Revoking is *not* signing out: the session behind the token is still live, so
  // a new authorization still gets a code.
  assert.equal((await s.spine.checkSession(s.orgId, s.session.id)).active, true);
  const again = await s.oidc.authorize({
    clientId: s.client.clientId,
    redirectUri: REDIRECT_URI,
    responseType: "code",
    scope: "openid",
    state: "state-3",
    codeChallenge: codeChallengeFor(VERIFIER, sha256),
    codeChallengeMethod: "S256",
    sessionId: s.session.id,
  });
  assert.equal(again.ok, true);
});

test("revocation answers the same for a dead token and one that never existed", async () => {
  const s = await signedIn();

  // A token we do not recognise is still a 200-shaped success to the caller: the
  // alternative is an endpoint that tells an attacker whether a token is live.
  const unknown = await s.oidc.revoke({ token: "not-a-token-we-issued" });
  assert.deepEqual(unknown, { ok: true, known: false });

  const first = await s.oidc.revoke({ token: s.accessToken });
  assert.deepEqual(first, { ok: true, known: true });
  const second = await s.oidc.revoke({ token: s.accessToken });
  assert.deepEqual(second, { ok: true, known: false });
});

test("revocation is on the chain, and names the session the token belonged to", async () => {
  const s = await signedIn();
  await s.oidc.revoke({ token: s.accessToken, tokenTypeHint: "access_token" });

  const event = s.audit.trail(s.orgId).find((entry) => entry.action === "oauth.token.revoke");
  assert.ok(event, "a revoked token is recorded");
  assert.equal((event?.detail as { sessionId?: string }).sessionId, s.session.id);
});

/* -------------------------------------------------------------------------- */
/*  The HTTP surface                                                          */
/* -------------------------------------------------------------------------- */

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: "GET",
    url: `${ISSUER}/oauth2/logout`,
    headers: {},
    cookies: {},
    ...overrides,
  };
}

test("the end-session endpoint redirects to a registered destination and clears the cookie", async () => {
  const s = await signedIn();
  const response = await routeOidc(
    request({
      url: `${ISSUER}/oauth2/logout?client_id=${s.client.clientId}&post_logout_redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=bye`,
      cookies: { sentinel_session: s.session.id },
    }),
    s.oidc,
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, `${REDIRECT_URI}?state=bye`);
  assert.match(String(response.headers["set-cookie"] ?? ""), /sentinel_session=;/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal((await s.oidc.userinfo(s.accessToken)).ok, false);
});

test("an end-session request that names no client is a page, not a redirect", async () => {
  const s = await signedIn();
  const response = await routeOidc(request({ cookies: { sentinel_session: s.session.id } }), s.oidc);

  assert.equal(response.status, 400);
  assert.equal(response.headers.location, undefined);
  assert.match(response.body, /client_id/);
});

test("the end-session endpoint answers a POST form the same way it answers a GET", async () => {
  const s = await signedIn();
  const response = await routeOidc(
    request({
      method: "POST",
      url: `${ISSUER}/oauth2/logout`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `client_id=${s.client.clientId}&post_logout_redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
      cookies: { sentinel_session: s.session.id },
    }),
    s.oidc,
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, REDIRECT_URI);
});

test("the revocation endpoint returns an empty 200 that no proxy may cache", async () => {
  const s = await signedIn();
  const response = await routeOidc(
    request({
      method: "POST",
      url: `${ISSUER}/oauth2/revoke`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(s.accessToken)}&token_type_hint=access_token`,
    }),
    s.oidc,
  );

  assert.equal(response.status, 200);
  assert.equal(response.body, "");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal((await s.oidc.userinfo(s.accessToken)).ok, false);
});

test("the revocation endpoint refuses a request with no token at all", async () => {
  const s = await signedIn();
  const response = await routeOidc(
    request({
      method: "POST",
      url: `${ISSUER}/oauth2/revoke`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    }),
    s.oidc,
  );

  assert.equal(response.status, 400);
  assert.match(response.body, /token/);
});

test("the end-session endpoint refuses a verb it does not serve", async () => {
  const s = await signedIn();
  const response = await routeOidc(request({ method: "DELETE", url: `${ISSUER}/oauth2/logout` }), s.oidc);
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, "GET, POST");
});
