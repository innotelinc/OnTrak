/**
 * OnTrak Tix M2 integration tests: single sign-on against a real identity
 * provider.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m2-sso-local-idp.test.ts
 *
 * The rest of the SSO suite proves the *decisions* with fixtures. This boots a
 * real OIDC provider on a loopback port and signs real ID tokens, so the parts
 * that fixtures cannot cover are exercised for real:
 *
 *  - `HttpOidcClient.discover` against a served discovery document;
 *  - the authorize redirect, driven the way a browser would follow it;
 *  - the token exchange, including PKCE (`code_verifier` → `code_challenge`);
 *  - `jose` verifying the ID token's signature against the provider's JWKS;
 *  - and the identity service turning those verified claims into a session.
 *
 * It also proves the refusals: a replayed code, a wrong verifier, a token signed
 * with a key the provider does not publish, a wrong nonce, and a claim set the
 * tenant's own connection config forbids.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import { HttpOidcClient, createPkcePair, randomUrlSafe } from "../src/lib/oidc-client";
import { buildAuthorizationUrl, discoveryUrl, extractOidcClaims, homePathForRole, safeReturnTo, validateDiscovery } from "../src/lib/oidc-rules";
import { IdentityService, MemoryIdentityStore } from "../src/lib/identity-service";
import type { IdentityConnection } from "../src/lib/identity-rules";
import { createHash } from "node:crypto";
import { startLocalIdp, LOCAL_IDP_CLIENT_ID, type LocalIdp } from "./support/local-idp";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const REDIRECT_URI = "http://127.0.0.1:3001/api/sso/callback";

function connectionFor(idp: LocalIdp, overrides: Partial<IdentityConnection> = {}): IdentityConnection {
  return {
    id: "conn-1",
    tenantId: "tenant-a",
    protocol: "OIDC",
    issuer: idp.issuer,
    clientId: LOCAL_IDP_CLIENT_ID,
    scopes: ["email", "profile", "groups"],
    allowedDomains: ["acme.test"],
    defaultRole: "REQUESTER",
    roleMappings: [{ claim: "groups", value: "tix-dispatchers", role: "DISPATCHER" }],
    mfaRequired: false,
    scimEnabled: false,
    createdAt: "2026-09-20T09:00:00.000Z",
    updatedAt: "2026-09-20T09:00:00.000Z",
    ...overrides,
  };
}

/** What the `/api/sso/start` route would stash in its signed cookie. */
interface RoundTrip {
  client: HttpOidcClient;
  code: string;
  nonce: string;
  state: string;
  verifier: string;
  authorizationUrl: string;
  location: string;
}

/**
 * Drive the first half of the handshake: discover, build the authorization
 * request, and follow the provider's redirect. This mirrors `GET /api/sso/start`
 * and the browser hop to the IdP.
 */
async function start(connection: IdentityConnection): Promise<RoundTrip> {
  const client = new HttpOidcClient();
  const discovery = await client.discover(connection.issuer);
  const pkce = createPkcePair();
  const state = randomUrlSafe(24);
  const nonce = randomUrlSafe(24);

  const authorizationUrl = buildAuthorizationUrl(discovery, {
    clientId: connection.clientId,
    redirectUri: REDIRECT_URI,
    scopes: connection.scopes,
    state,
    nonce,
    codeChallenge: pkce.challenge,
  });

  // `manual` because we want the Location header, not a followed redirect.
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  assert.equal(response.status, 302, `the provider should redirect, got ${response.status}`);
  const location = response.headers.get("location") ?? "";
  const returned = new URL(location);
  assert.equal(returned.searchParams.get("state"), state, "the provider echoes the CSRF state");

  return {
    client,
    code: returned.searchParams.get("code") ?? "",
    nonce,
    state,
    verifier: pkce.verifier,
    authorizationUrl,
    location,
  };
}

/** The second half: exchange the code and verify the ID token, as the callback does. */
async function finish(round: RoundTrip, connection: IdentityConnection, options: { clientSecret?: string | null; verifier?: string } = {}) {
  return round.client.exchangeCode({
    discovery: await round.client.discover(connection.issuer),
    clientId: connection.clientId,
    clientSecret: options.clientSecret ?? null,
    code: round.code,
    redirectUri: REDIRECT_URI,
    codeVerifier: options.verifier ?? round.verifier,
  });
}

/* -------------------------------------------------------------- handshake */

test("the client discovers, exchanges and verifies a token from a real provider", async () => {
  const idp = await startLocalIdp();
  try {
    const connection = connectionFor(idp);

    // Discovery is validated against the configured issuer, not just fetched.
    const discovery = await new HttpOidcClient().discover(connection.issuer);
    assert.equal(discovery.issuer, idp.issuer);
    assert.equal(discovery.authorizationEndpoint, `${idp.issuer}/authorize`);
    assert.equal(discovery.jwksUri, `${idp.issuer}/jwks.json`);
    assert.ok(discovery.userinfoEndpoint);
    assert.equal(validateDiscovery({ ...discovery, issuer: "https://evil.example" }, connection.issuer).ok, false);
    assert.equal(discoveryUrl(idp.issuer), `${idp.issuer}/.well-known/openid-configuration`);

    const round = await start(connection);
    assert.ok(round.code, "the provider issued a code");
    // The authorization URL carried every parameter a strict provider needs.
    const sent = new URL(round.authorizationUrl).searchParams;
    assert.equal(sent.get("response_type"), "code");
    assert.equal(sent.get("code_challenge_method"), "S256");
    assert.equal(sent.get("scope"), "openid email profile groups");
    assert.ok(sent.get("code_challenge"));
    assert.equal(idp.calls.discovery, 2, "discovery is fetched, once per half");
    assert.equal(idp.calls.authorize, 1);

    // The exchange verifies the signature against the published JWKS — this is
    // the assertion that a fixture cannot make for you.
    const token = await finish(round, connection);
    assert.equal(token.payload.iss, idp.issuer);
    assert.equal(token.payload.aud, LOCAL_IDP_CLIENT_ID);
    assert.equal(token.payload.email, "sso.user@acme.test");
    assert.equal(idp.calls.jwks >= 1, true, "the JWKS was fetched to verify the token");

    // ...and the claims map onto the vocabulary the identity rules already use.
    const claims = extractOidcClaims(token.payload, { issuer: connection.issuer, nonce: round.nonce });
    assert.equal(claims.ok, true);
    if (!claims.ok) return;
    assert.equal(claims.claims.email, "sso.user@acme.test");
    assert.deepEqual(claims.claims.groups, ["tix-dispatchers"]);
    assert.deepEqual(claims.claims.amr, ["pwd", "otp"]);
    assert.equal(claims.claims.mfa, true);
    assert.equal(homePathForRole("DISPATCHER"), "/inbox");
  } finally {
    await idp.close();
  }
});

/* ------------------------------------------------------------- refusals */

test("the handshake refuses a replayed code, a wrong verifier and a forged token", async () => {
  const idp = await startLocalIdp();
  try {
    const connection = connectionFor(idp);

    // A wrong `code_verifier` cannot be redeemed: PKCE is checked for real.
    const wrongVerifier = await start(connection);
    await assert.rejects(
      () => finish(wrongVerifier, connection, { verifier: randomUrlSafe(32) }),
      /token endpoint answered 400/,
    );

    // The same code is single-use.
    const replayed = await start(connection);
    await finish(replayed, connection);
    await assert.rejects(() => finish(replayed, connection), /token endpoint answered 400/);

    // A token signed with a key the provider does not publish fails verification
    // even though the JWKS resolves and the token is well-formed.
    const forged = await startLocalIdp({ signWithUnpublishedKey: true });
    try {
      const forgedConnection = connectionFor(forged);
      const round = await start(forgedConnection);
      await assert.rejects(() => finish(round, forgedConnection), /signature/i);
    } finally {
      await forged.close();
    }

    // An unverified email is refused by the claim rules rather than trusted.
    const unverified = await startLocalIdp({ claims: { email_verified: false } });
    try {
      const unverifiedConnection = connectionFor(unverified);
      const round = await start(unverifiedConnection);
      const token = await finish(round, unverifiedConnection);
      const claims = extractOidcClaims(token.payload, { issuer: unverifiedConnection.issuer });
      assert.equal(claims.ok, false);
      if (!claims.ok) assert.match(claims.reason, /not verified/);
    } finally {
      await unverified.close();
    }

    // A token minted for another request (wrong nonce) is refused.
    const round = await start(connection);
    const token = await finish(round, connection);
    const wrongNonce = extractOidcClaims(token.payload, { issuer: connection.issuer, nonce: randomUrlSafe(16) });
    assert.equal(wrongNonce.ok, false);
    if (!wrongNonce.ok) assert.match(wrongNonce.reason, /did not match this sign-in request/);

    // A token from a different issuer is refused.
    const otherIssuer = extractOidcClaims(token.payload, { issuer: "https://someone-else.example" });
    assert.equal(otherIssuer.ok, false);
  } finally {
    await idp.close();
  }
});

test("a provider that demands a client secret is not satisfied without one", async () => {
  const idp = await startLocalIdp({ clientSecret: "local-client-secret" });
  try {
    const connection = connectionFor(idp);

    const missing = await start(connection);
    await assert.rejects(() => finish(missing, connection), /token endpoint answered 401/);

    const wrong = await start(connection);
    await assert.rejects(() => finish(wrong, connection, { clientSecret: "not-the-secret" }), /token endpoint answered 401/);

    const right = await start(connection);
    const token = await finish(right, connection, { clientSecret: "local-client-secret" });
    assert.equal(token.payload.email, "sso.user@acme.test");
  } finally {
    await idp.close();
  }
});

test("the authorization endpoint refuses a request without PKCE or a nonce", async () => {
  const idp = await startLocalIdp();
  try {
    const params = new URLSearchParams({
      client_id: LOCAL_IDP_CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      code_challenge: "challenge",
      code_challenge_method: "S256",
      nonce: "n",
    });
    const authorize = (overrides: Record<string, string | null> = {}) => {
      const search = new URLSearchParams(params);
      for (const [key, value] of Object.entries(overrides)) {
        if (value === null) search.delete(key);
        else search.set(key, value);
      }
      return fetch(`${idp.issuer}/authorize?${search.toString()}`, { redirect: "manual" });
    };

    const noPkce = await authorize({ code_challenge: null });
    assert.equal(noPkce.status, 400);
    assert.match(await noPkce.text(), /PKCE/);

    const wrongMethod = await authorize({ code_challenge_method: "plain" });
    assert.equal(wrongMethod.status, 400);

    const noNonce = await authorize({ nonce: null });
    assert.equal(noNonce.status, 400);
    assert.match(await noNonce.text(), /nonce/);

    const wrongClient = await authorize({ client_id: "someone-else" });
    assert.equal(wrongClient.status, 400);

    const wrongFlow = await authorize({ response_type: "token" });
    assert.equal(wrongFlow.status, 400);

    // The well-formed request is the control, so the refusals above mean what
    // they look like they mean.
    const good = await authorize();
    assert.equal(good.status, 302);
  } finally {
    await idp.close();
  }
});

/* ------------------------------------------------- signed in, for real */

test("an IdP sign-in provisions the user, maps the role, and audits every attempt", async () => {
  const idp = await startLocalIdp();
  try {
    const audit = new AuditLog(sha256);
    const store = new MemoryIdentityStore();
    const service = new IdentityService(store, audit);
    const connection = connectionFor(idp);
    await store.saveConnection(connection);

    const round = await start(connection);
    const token = await finish(round, connection);
    const claims = extractOidcClaims(token.payload, { issuer: connection.issuer, nonce: round.nonce });
    assert.equal(claims.ok, true);
    if (!claims.ok) return;

    const signedIn = await service.signIn("tenant-a", claims.claims);
    assert.equal(signedIn.ok, true);
    if (!signedIn.ok) return;
    // First sign-in provisions, and the group mapping decides the role.
    assert.equal(signedIn.value.provisioned, true);
    assert.equal(signedIn.value.user.email, "sso.user@acme.test");
    assert.equal(signedIn.value.user.displayName, "Ida SSO");
    assert.equal(signedIn.value.user.role, "DISPATCHER");
    assert.equal(signedIn.value.user.externalId, "idp-subject-1");

    const actions = audit.snapshot().events.map((event) => event.action);
    assert.deepEqual(actions, ["identity.signin"]);

    // Signing in again resolves the same user instead of creating a second one,
    // and the audit trail records that too.
    const again = await service.signIn("tenant-a", claims.claims);
    assert.equal(again.ok, true);
    if (again.ok) {
      assert.equal(again.value.provisioned, false);
      assert.equal(again.value.user.id, signedIn.value.user.id);
    }
    assert.equal(store.all("tenant-a").length, 1);
    assert.equal(audit.snapshot().events.length, 2);

    // A change in the IdP's groups changes the role, and the change is its own
    // event on the audit chain.
    const changed = extractOidcClaims({ ...token.payload, groups: ["tix-admins"] }, { issuer: connection.issuer, nonce: round.nonce });
    assert.equal(changed.ok, true);
    if (changed.ok) {
      const elevated = await service.signIn("tenant-a", { ...changed.claims });
      assert.equal(elevated.ok, true);
      if (elevated.ok) assert.equal(elevated.value.user.role, "REQUESTER", "an unmapped group falls back to the default role");
    }
    assert.ok(audit.snapshot().events.some((event) => event.action === "identity.role.change"));
  } finally {
    await idp.close();
  }
});

test("the tenant's own connection config can refuse a valid IdP assertion", async () => {
  const idp = await startLocalIdp({ claims: { email: "outsider@other.example", groups: ["tix-dispatchers"] } });
  try {
    const audit = new AuditLog(sha256);
    const store = new MemoryIdentityStore();
    const service = new IdentityService(store, audit);
    // The domain allow-list is the tenant's decision, independent of the IdP.
    await store.saveConnection(connectionFor(idp));

    const connection = connectionFor(idp);
    const round = await start(connection);
    const token = await finish(round, connection);
    const claims = extractOidcClaims(token.payload, { issuer: connection.issuer, nonce: round.nonce });
    assert.equal(claims.ok, true, "the IdP's token is perfectly valid");
    if (!claims.ok) return;

    const refused = await service.signIn("tenant-a", claims.claims);
    assert.equal(refused.ok, false, "but the tenant does not allow that domain");
    if (!refused.ok) assert.match(refused.error, /not an allowed sign-in domain/);
    assert.equal(store.all("tenant-a").length, 0, "nothing was provisioned");
    // A denied sign-in is exactly the event an investigation needs.
    assert.deepEqual(audit.snapshot().events.map((event) => event.action), ["identity.signin.denied"]);

    // Requiring MFA refuses an assertion with no second factor.
    const otp = await startLocalIdp({ claims: { amr: ["pwd"], mfa: false } });
    try {
      const strict = connectionFor(otp, { mfaRequired: true });
      // A tenant has one connection at a time; point it at the stricter provider.
      await store.saveConnection(strict);
      const otpRound = await start(strict);
      const otpToken = await finish(otpRound, strict);
      const otpClaims = extractOidcClaims(otpToken.payload, { issuer: strict.issuer, nonce: otpRound.nonce });
      assert.equal(otpClaims.ok, true);
      if (!otpClaims.ok) return;
      const noMfa = await service.signIn("tenant-a", otpClaims.claims);
      assert.equal(noMfa.ok, false);
      if (!noMfa.ok) assert.match(noMfa.error, /multi-factor/);
    } finally {
      await otp.close();
    }
  } finally {
    await idp.close();
  }
});

test("the open-redirect guard keeps a crafted returnTo out of the callback", () => {
  assert.equal(safeReturnTo("/inbox?filter=breached"), "/inbox?filter=breached");
  assert.equal(safeReturnTo("//evil.example"), null);
  assert.equal(safeReturnTo("https://evil.example"), null);
  assert.equal(safeReturnTo("/\\evil.example"), null);
  assert.equal(safeReturnTo(""), null);
  assert.equal(safeReturnTo(null), null);
});
