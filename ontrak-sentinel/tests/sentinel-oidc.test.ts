/**
 * OnTrak Sentinel S1 tests: the authorization-code flow, with PKCE.
 *
 * The whole point of the provider is that a client can trust what it receives,
 * so each test follows one of the four things that could make that untrue: a
 * code delivered to the wrong place, a code exchanged twice, a token whose
 * signature does not check out, and a grant that outlives the session behind it.
 * The success path is asserted down to the claims, because a flow that "works"
 * but hands over the wrong `sub` is worse than one that fails.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sha256Hex } from "../src/lib/hash";
import type { HashFn } from "../src/lib/audit-chain";
import { DEFAULT_IDENTITY_POLICY } from "../src/lib/identity-rules";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog, type IdentityActor } from "../src/lib/identity-service";
import { generateSigningKey, verifyJwt, type SigningKey } from "../src/lib/oidc-keys";
import { codeChallengeFor, validateClient } from "../src/lib/oidc-rules";
import { MemoryOidcStore, OidcService, type OidcIds } from "../src/lib/oidc-service";

const sha256: HashFn = sha256Hex;
const ISSUER = "https://identity.acme.test";

/** One key for the whole file: generating RSA pairs per test buys nothing. */
const KEYS: SigningKey = generateSigningKey();
const VERIFIER = "3lR6kQz1vB9wS2pJ8nH4tY7cM0xG5dF1aK9eU2rT6bN8sW";

function otherVerifier(): string {
  return `${VERIFIER.slice(0, -1)}X`;
}

let harnessSeq = 0;

function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  let clock = Date.parse("2026-09-28T09:00:00.000Z");
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
  const oidc = new OidcService(new MemoryOidcStore(), identities, spine, { issuer: ISSUER, keys: KEYS }, audit, oidcIds, sha256);

  return {
    spine,
    oidc,
    identities,
    audit,
    ids,
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
    nowMs: () => clock,
  };
}

/** A bootstrapped organization, its admin, and a live session for them. */
async function signedIn(h = harness()) {
  const created = await h.spine.bootstrapOrganization("founder-1", { name: "Acme MSP", slug: `acme-${harnessSeq}-${Date.now()}` }, {
    identifier: "admin@acme.test",
    displayName: "Ada Admin",
  });
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) throw new Error("unreachable");
  const actor: IdentityActor = {
    id: created.value.admin.id,
    organizationId: created.value.organization.id,
    role: "ADMIN",
  };

  await h.spine.setMfaEnrolled(actor, actor.id, true);
  const session = await h.spine.issueSession(actor.organizationId, actor.id);
  assert.equal(session.ok, true);
  if (!session.ok) throw new Error("unreachable");

  const client = await h.oidc.registerClient(actor, {
    name: "OnTrak Tix",
    redirectUris: ["https://tix.acme.test/api/sso/callback"],
    scopes: ["openid", "profile", "email", "roles"],
  });
  assert.equal(client.ok, true, client.ok ? "" : client.error);
  if (!client.ok) throw new Error("unreachable");

  return { ...h, actor, org: created.value.organization, session: session.value, client: client.value, redirectUri: "https://tix.acme.test/api/sso/callback" };
}

type Signed = Awaited<ReturnType<typeof signedIn>>;

async function authorized(s: Signed, overrides: Record<string, unknown> = {}) {
  return s.oidc.authorize({
    clientId: s.client.clientId,
    redirectUri: s.redirectUri,
    responseType: "code",
    scope: "openid profile email roles",
    state: "state-1",
    nonce: "nonce-1",
    codeChallenge: codeChallengeFor(VERIFIER, sha256),
    codeChallengeMethod: "S256",
    sessionId: s.session.id,
    ...overrides,
  });
}

async function exchange(s: Signed, code: string, verifier = VERIFIER) {
  return s.oidc.token({
    grantType: "authorization_code",
    clientId: s.client.clientId,
    code,
    redirectUri: s.redirectUri,
    codeVerifier: verifier,
  });
}

/* -------------------------------------------------------------------------- */
/*  Metadata                                                                  */
/* -------------------------------------------------------------------------- */

test("discovery advertises what is implemented, and nothing more", async () => {
  const { oidc } = harness();
  const doc = oidc.discovery();

  assert.equal(doc.issuer, ISSUER);
  assert.equal(doc.authorization_endpoint, `${ISSUER}/oauth2/authorize`);
  assert.equal(doc.token_endpoint, `${ISSUER}/oauth2/token`);
  assert.deepEqual(doc.code_challenge_methods_supported, ["S256"], "plain is not offered at all");
  assert.deepEqual(doc.grant_types_supported, ["authorization_code"]);
  // Client secrets are not built yet, so the provider does not claim to accept
  // them — an integrator finds that out from the document, not from production.
  assert.deepEqual(doc.token_endpoint_auth_methods_supported, ["none"]);
});

test("the JWKS publishes the public half of the signing key, and signs nothing else", async () => {
  const set = harness().oidc.jwks();
  const key = set.keys[0];

  assert.equal(set.keys.length, 1);
  assert.equal(key.kid, KEYS.kid);
  assert.equal(key.alg, "RS256");
  assert.equal(key.kty, "RSA");
  assert.equal(key.use, "sig");
  assert.ok(typeof key.n === "string" && key.n.length > 100);
  // The private half must not be anywhere near a document a client fetches: a
  // published `d` (or `p`/`q`) would let anyone mint identity as this provider.
  for (const secretOf of ["d", "p", "q", "dp", "dq", "qi"]) {
    assert.equal(secretOf in key, false, `the JWK Set leaked “${secretOf}”`);
  }
});

/* -------------------------------------------------------------------------- */
/*  Client registration                                                       */
/* -------------------------------------------------------------------------- */

test("a redirect URI must be https, or http on a loopback address", () => {
  assert.equal(validateClient({ name: "Tix", redirectUris: ["https://tix.acme.test/cb"], scopes: ["openid"] }).length, 0);
  assert.equal(validateClient({ name: "CLI", redirectUris: ["http://127.0.0.1:8787/cb"], scopes: ["openid"] }).length, 0);

  for (const uri of ["http://tix.acme.test/cb", "/callback", "https://tix.acme.test/cb#frag", "https://user:pw@tix.acme.test/cb"]) {
    const issues = validateClient({ name: "Tix", redirectUris: [uri], scopes: ["openid"] });
    assert.ok(issues.length > 0, `“${uri}” should not be registrable`);
  }
});

test("a client must be allowed openid, and only scopes this provider issues", () => {
  assert.match(validateClient({ name: "Tix", redirectUris: ["https://t.acme.test/cb"], scopes: ["profile"] })[0].message, /openid/);
  assert.match(
    validateClient({ name: "Tix", redirectUris: ["https://t.acme.test/cb"], scopes: ["openid", "phone"] })[0].message,
    /not a scope/,
  );
});

test("registering a client is an administrator's act, and it is recorded", async () => {
  const h = harness();
  const created = await h.spine.bootstrapOrganization("founder-1", { name: "Acme", slug: "acme-reg" }, {
    identifier: "admin@acme.test",
    displayName: "Ada",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const actor: IdentityActor = { id: created.value.admin.id, organizationId: created.value.organization.id, role: "ADMIN" };
  const asAgent: IdentityActor = { ...actor, role: "AGENT" };

  assert.equal((await h.oidc.registerClient(asAgent, { name: "X", redirectUris: ["https://x.acme.test/cb"], scopes: ["openid"] })).ok, false);

  const registered = await h.oidc.registerClient(actor, {
    name: "OnTrak Tix",
    redirectUris: ["https://tix.acme.test/cb"],
    scopes: ["openid", "email"],
  });
  assert.equal(registered.ok, true);
  assert.ok(h.audit.trail(actor.organizationId).some((event) => event.action === "oauth.client.register"));
});

/* -------------------------------------------------------------------------- */
/*  The happy path                                                            */
/* -------------------------------------------------------------------------- */

test("a code is issued to a registered client and exchanged for a signed ID token", async () => {
  const s = await signedIn();
  const granted = await authorized(s);
  assert.equal(granted.ok, true, granted.ok ? "" : granted.error);
  if (!granted.ok) return;

  // The browser comes back to the registered URI, with the state it sent.
  const returned = new URL(granted.redirectTo);
  assert.equal(returned.origin + returned.pathname, s.redirectUri);
  assert.equal(returned.searchParams.get("state"), "state-1");
  const code = returned.searchParams.get("code");
  assert.ok(code);

  const token = await exchange(s, code);
  assert.equal(token.ok, true, token.ok ? "" : token.error);
  if (!token.ok) return;
  assert.equal(token.tokenType, "Bearer");
  assert.equal(token.scope, "openid profile email roles");

  const verified = verifyJwt(token.idToken, KEYS, {
    issuer: ISSUER,
    audience: s.client.clientId,
    nonce: "nonce-1",
    nowMs: s.nowMs(),
  });
  assert.equal(verified.ok, true, verified.ok ? "" : verified.reason);
  if (!verified.ok) return;
  assert.equal(verified.claims.sub, s.actor.id, "the subject is the identity, not the session");
  assert.equal(verified.claims.sid, s.session.id);
  assert.equal(verified.claims.email, "admin@acme.test");
  assert.equal(verified.claims.name, "Ada Admin");
  assert.deepEqual(verified.claims.roles, ["ADMIN"]);
  assert.deepEqual(verified.claims.amr, ["pwd", "mfa"], "the second factor is part of the evidence");
  assert.equal(typeof verified.claims.auth_time, "number");
});

test("the access token answers userinfo with the same subject the ID token named", async () => {
  const s = await signedIn();
  const granted = await authorized(s);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  const token = await exchange(s, new URL(granted.redirectTo).searchParams.get("code") as string);
  assert.equal(token.ok, true);
  if (!token.ok) return;

  const info = await s.oidc.userinfo(token.accessToken);
  assert.equal(info.ok, true);
  if (!info.ok) return;
  assert.equal(info.value.sub, s.actor.id);
  assert.equal(info.value.email, "admin@acme.test");
  assert.deepEqual(info.value.roles, ["ADMIN"]);
});

test("a claim is only released by the scope that asked for it", async () => {
  const s = await signedIn();
  const granted = await authorized(s, { scope: "openid" });
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  const token = await exchange(s, new URL(granted.redirectTo).searchParams.get("code") as string);
  assert.equal(token.ok, true);
  if (!token.ok) return;

  const verified = verifyJwt(token.idToken, KEYS, { issuer: ISSUER, audience: s.client.clientId });
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.claims.email, undefined, "a client that did not ask for email does not get one");
  assert.equal(verified.claims.name, undefined);
  assert.equal(verified.claims.sub, s.actor.id, "but it always knows who this is");
});

test("the signature is what makes the token trustworthy", async () => {
  const s = await signedIn();
  const granted = await authorized(s);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  const token = await exchange(s, new URL(granted.redirectTo).searchParams.get("code") as string);
  assert.equal(token.ok, true);
  if (!token.ok) return;

  const [headerPart, claimsPart, signaturePart] = token.idToken.split(".");
  const tampered = `${headerPart}.${Buffer.from(JSON.stringify({ sub: "admin" })).toString("base64url")}.${signaturePart}`;

  const checked = verifyJwt(tampered, KEYS, { issuer: ISSUER, audience: s.client.clientId });
  assert.equal(checked.ok, false);
  assert.match(checked.ok === false ? checked.reason : "", /signature does not verify/);
});

test("a token minted for another client, or for another request, is refused", async () => {
  const s = await signedIn();
  const granted = await authorized(s);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  const token = await exchange(s, new URL(granted.redirectTo).searchParams.get("code") as string);
  assert.equal(token.ok, true);
  if (!token.ok) return;

  assert.equal(verifyJwt(token.idToken, KEYS, { audience: "somebody-else" }).ok, false);
  assert.equal(verifyJwt(token.idToken, KEYS, { nonce: "replayed" }).ok, false);
  assert.equal(verifyJwt(token.idToken, KEYS, { issuer: "https://evil.test" }).ok, false);
});

/* -------------------------------------------------------------------------- */
/*  The refusals                                                              */
/* -------------------------------------------------------------------------- */

test("a redirect URI is matched exactly, and an unregistered one is not redirected to", async () => {
  const s = await signedIn();

  // A plausible neighbour of the registered URI: same origin, one path segment
  // more. A prefix match would have accepted it, which is the whole attack.
  const nearMiss = await authorized(s, { redirectUri: `${s.redirectUri}/extra` });
  assert.equal(nearMiss.ok, false);
  assert.equal(nearMiss.ok === false && nearMiss.redirectUri, null, "an error is never sent to a URI we do not know");

  // A registered URI, refused for another reason, *is* redirected to.
  const noState = await authorized(s, { state: "" });
  assert.equal(noState.ok, false);
  assert.equal(noState.ok === false && noState.redirectUri, s.redirectUri);
});

test("an unknown client, a missing nonce-carrying state and a plain challenge are all refused", async () => {
  const s = await signedIn();

  const unknown = await authorized(s, { clientId: "nobody" });
  assert.match(unknown.ok === false ? unknown.error : "", /Unknown client/);

  const noState = await authorized(s, { state: "  " });
  assert.match(noState.ok === false ? noState.error : "", /no state/);

  const plain = await authorized(s, { codeChallengeMethod: "plain", codeChallenge: VERIFIER });
  assert.match(plain.ok === false ? plain.error : "", /PKCE with S256/);

  const implicit = await authorized(s, { responseType: "token" });
  assert.match(implicit.ok === false ? implicit.error : "", /authorization code flow/);
});

test("a scope the provider does not issue is refused, not silently dropped", async () => {
  const s = await signedIn();
  const granted = await authorized(s, { scope: "openid phone" });
  assert.equal(granted.ok, false);
  assert.match(granted.ok === false ? granted.error : "", /does not issue the scope phone/);
});

test("a code is good for one exchange, and a wrong verifier burns it", async () => {
  const s = await signedIn();
  const granted = await authorized(s);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  const code = new URL(granted.redirectTo).searchParams.get("code") as string;

  // Wrong verifier first: the exchange fails...
  const wrong = await exchange(s, code, otherVerifier());
  assert.equal(wrong.ok, false);
  assert.match(wrong.ok === false ? wrong.error : "", /does not match the challenge/);

  // ...and the code is spent, so the *right* verifier no longer helps. Otherwise
  // the token endpoint would be a free oracle for guessing the verifier.
  const retried = await exchange(s, code);
  assert.equal(retried.ok, false);
  assert.match(retried.ok === false ? retried.error : "", /already been exchanged/);
});

test("the second exchange of a good code is refused, and the reuse is recorded", async () => {
  const s = await signedIn();
  const granted = await authorized(s);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  const code = new URL(granted.redirectTo).searchParams.get("code") as string;

  assert.equal((await exchange(s, code)).ok, true);
  const replay = await exchange(s, code);
  assert.equal(replay.ok, false);
  assert.equal(replay.ok === false && replay.code, "invalid_grant");
  assert.ok(s.audit.trail(s.org.id).some((event) => event.action === "oauth.token.reuse"));
});

test("a code expires on its own, without anyone using it", async () => {
  const s = await signedIn();
  const granted = await authorized(s);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  const code = new URL(granted.redirectTo).searchParams.get("code") as string;

  s.advance(61);

  const late = await exchange(s, code);
  assert.equal(late.ok, false);
  assert.match(late.ok === false ? late.error : "", /expired/);
});

test("a grant does not outlive the session it was made for", async () => {
  const s = await signedIn();
  const granted = await authorized(s);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;

  // The session is revoked in the sixty seconds between the code and the token,
  // so the code is worthless — and so is any token already issued to it.
  await s.spine.revokeSession(s.actor, s.session.id, "user signed out elsewhere");
  const exchanged = await exchange(s, new URL(granted.redirectTo).searchParams.get("code") as string);
  assert.equal(exchanged.ok, false);
  assert.match(exchanged.ok === false ? exchanged.error : "", /revoked/);
});

test("an access token stops answering once its session is revoked", async () => {
  const s = await signedIn();
  const granted = await authorized(s);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  const token = await exchange(s, new URL(granted.redirectTo).searchParams.get("code") as string);
  assert.equal(token.ok, true);
  if (!token.ok) return;

  assert.equal((await s.oidc.userinfo(token.accessToken)).ok, true);

  await s.spine.revokeSession(s.actor, s.session.id, "leaver: left the company");

  const after = await s.oidc.userinfo(token.accessToken);
  assert.equal(after.ok, false);
  assert.match(after.ok === false ? after.error : "", /no longer usable/);
});

test("a token that was never issued is refused rather than guessed at", async () => {
  const s = await signedIn();
  assert.equal((await s.oidc.userinfo("not-a-token")).ok, false);
  assert.equal((await s.oidc.userinfo("  ")).ok, false);
});

/* -------------------------------------------------------------------------- */
/*  Isolation and evidence                                                    */
/* -------------------------------------------------------------------------- */

test("a client cannot be driven by another organization's session", async () => {
  const h = harness();
  const acme = await signedIn(h);
  const beaconOrg = await h.spine.bootstrapOrganization("founder-2", { name: "Beacon", slug: "beacon-iso" }, {
    identifier: "admin@beacon.test",
    displayName: "Bea",
  });
  assert.equal(beaconOrg.ok, true);
  if (!beaconOrg.ok) return;
  const beacon: IdentityActor = {
    id: beaconOrg.value.admin.id,
    organizationId: beaconOrg.value.organization.id,
    role: "ADMIN",
  };
  await h.spine.setMfaEnrolled(beacon, beacon.id, true);
  const beaconSession = await h.spine.issueSession(beacon.organizationId, beacon.id);
  assert.equal(beaconSession.ok, true);
  if (!beaconSession.ok) return;

  // Beacon's live session, presented at Acme's client: the session is looked up
  // inside the client's organization, so it is not found at all.
  const attempted = await authorized(acme, { sessionId: beaconSession.value.id });
  assert.equal(attempted.ok, false);
  assert.match(attempted.ok === false ? attempted.error : "", /session does not exist/);

  // And the client list is scoped the same way: Beacon sees its own registry,
  // which is empty, not Acme's client.
  const beaconClients = await h.oidc.listClients(beacon);
  assert.equal(beaconClients.ok && beaconClients.value.length, 0);
});

test("client registration, authorization and the token are all on the organization's chain", async () => {
  const s = await signedIn();
  const granted = await authorized(s);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  const token = await exchange(s, new URL(granted.redirectTo).searchParams.get("code") as string);
  assert.equal(token.ok, true);
  if (!token.ok) return;

  const actions = s.audit.trail(s.org.id).map((event) => event.action);
  assert.ok(actions.includes("oauth.client.register"));
  assert.ok(actions.includes("oauth.authorize"));
  assert.ok(actions.includes("oauth.token"));
  assert.deepEqual(s.audit.verify(s.org.id), { ok: true, length: actions.length });

  const grantedEvent = s.audit.trail(s.org.id).find((event) => event.action === "oauth.authorize");
  assert.equal((grantedEvent?.detail as { subject: string }).subject, s.actor.id);
});

test("the session policy is the same one OIDC enforces, so MFA gates a sign-in", async () => {
  const h = harness();
  const created = await h.spine.bootstrapOrganization("founder-1", { name: "Acme", slug: "acme-mfa" }, {
    identifier: "admin@acme.test",
    displayName: "Ada",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const actor: IdentityActor = { id: created.value.admin.id, organizationId: created.value.organization.id, role: "ADMIN" };

  // No second factor yet: the default policy refuses a session outright, so
  // there is nothing for the provider to authorize.
  const refused = await h.spine.issueSession(actor.organizationId, actor.id);
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.error : "", /MFA is required/);

  // And an idle session cannot be used either.
  await h.spine.setMfaEnrolled(actor, actor.id, true);
  const session = await h.spine.issueSession(actor.organizationId, actor.id);
  assert.equal(session.ok, true);
  if (!session.ok) return;
  const client = await h.oidc.registerClient(actor, {
    name: "Tix",
    redirectUris: ["https://tix.acme.test/cb"],
    scopes: ["openid"],
  });
  assert.equal(client.ok, true);
  if (!client.ok) return;

  h.advance(DEFAULT_IDENTITY_POLICY.idleTimeoutSeconds + 1);
  const late = await h.oidc.authorize({
    clientId: client.value.clientId,
    redirectUri: "https://tix.acme.test/cb",
    responseType: "code",
    scope: "openid",
    state: "s",
    codeChallenge: codeChallengeFor(VERIFIER, sha256),
    codeChallengeMethod: "S256",
    sessionId: session.value.id,
  });
  assert.equal(late.ok, false);
  assert.match(late.ok === false ? late.error : "", /idle timeout/);
});
