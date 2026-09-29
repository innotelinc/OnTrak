/**
 * Single sign-on tests.
 *
 * Three layers, because they fail differently:
 *
 *  1. **The rules** — configuration, discovery, the authorization URL, claim
 *     extraction and authorization. Pure, so every refusal is cheap to assert.
 *  2. **The account resolution** — what an authorized assertion does to a local
 *     account, against a fake store: provisioning, adopting an existing account by
 *     email, following a rename by subject, and the refusals.
 *  3. **The handshake**, against a real HTTP OpenID Connect provider on a loopback
 *     port (`tests/support/local-idp.ts`). The rules adding up is not the same
 *     claim as "the exchange works": this signs a real ID token with a real key,
 *     makes `jose` verify it against the published JWKS, and proves the forgeries
 *     are refused.
 *
 * The one thing not covered here is the Next route handlers themselves
 * (`src/app/api/sso/*`), which need a running app and a real session; the README's
 * deployment notes describe how those are exercised against the stack.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { HttpOidcClient, MemoryOidcClient, createPkcePair, randomUrlSafe } from "../src/lib/oidc-client";
import {
  SSO_STATE_COOKIE,
  applySsoRole,
  authorizeSso,
  buildAuthorizationUrl,
  deploymentOrigin,
  discoveryUrl,
  extractOidcClaims,
  isAuthorizationState,
  parseRoleMappings,
  ssoConfigFromEnv,
  ssoRedirectUri,
  stateExpired,
  validateDiscovery,
  type SsoAuthorization,
  type SsoConfig,
} from "../src/lib/oidc-rules";
import {
  resolveSsoSignIn,
  ssoDeniedAudit,
  ssoSignInAudit,
  type SsoAuditEvent,
  type SsoUserRecord,
  type SsoUserStore,
} from "../src/lib/oidc-service";
import { safeRelativePath } from "../src/lib/auth-rules";
import { LOCAL_IDP_CLIENT_ID, startLocalIdp } from "./support/local-idp";

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

function config(issuer: string, overrides: Partial<SsoConfig> = {}): SsoConfig {
  return {
    issuer,
    clientId: LOCAL_IDP_CLIENT_ID,
    clientSecret: null,
    scopes: ["profile", "email"],
    defaultRole: "STUDENT",
    roleMappings: [{ claim: "groups", value: "instructors", role: "INSTRUCTOR" }],
    allowedDomains: [],
    requireMfa: false,
    ...overrides,
  };
}

/** The claims the local provider signs, as `extractOidcClaims` returns them. */
function claims(issuer: string, overrides: Record<string, unknown> = {}) {
  const extracted = extractOidcClaims(
    {
      iss: issuer,
      sub: "idp-subject-1",
      email: "sso.user@ontrak.local",
      email_verified: true,
      name: "Ida SSO",
      groups: ["instructors"],
      amr: ["pwd", "otp"],
      mfa: true,
      ...overrides,
    },
    { issuer },
  );
  assert.equal(extracted.ok, true);
  return extracted.ok ? extracted.claims : assert.fail("claims did not extract");
}

/** An in-memory `SsoUserStore`, so the resolution rules need no database. */
function fakeStore(initial: SsoUserRecord[] = []) {
  const users = [...initial];
  let created = 0;
  const store: SsoUserStore = {
    async findBySubject(subject) {
      return users.find((user) => user.externalId === subject) ?? null;
    },
    async findByEmail(email) {
      const wanted = email.trim().toLowerCase();
      return users.find((user) => user.email === wanted) ?? null;
    },
    async countOtherActiveAdmins(excludeId) {
      return users.filter((user) => user.role === "ADMIN" && user.active && user.id !== excludeId).length;
    },
    async create(input) {
      created += 1;
      const user: SsoUserRecord = { id: `new-${created}`, active: true, ...input };
      users.push(user);
      return user;
    },
    async update(id, patch) {
      const index = users.findIndex((user) => user.id === id);
      assert.notEqual(index, -1);
      users[index] = { ...users[index], ...patch };
      return users[index];
    },
  };
  return { store, users };
}

function account(overrides: Partial<SsoUserRecord> = {}): SsoUserRecord {
  return {
    id: "user-1",
    email: "sso.user@ontrak.local",
    name: "Ida SSO",
    role: "STUDENT",
    active: true,
    accent: "violet",
    externalId: null,
    ...overrides,
  };
}

/** Drive the login flow to the point where an assertion has been verified. */
async function exchange(
  issuer: string,
  clientSecret: string | null,
  options: { verifier?: string; nonce?: string; code?: string } = {},
) {
  const redirectUri = ssoRedirectUri("http://127.0.0.1:3000");
  const client = new HttpOidcClient();
  const discovery = await client.discover(issuer);
  const pkce = createPkcePair();
  const state = randomUrlSafe(16);
  const nonce = options.nonce ?? randomUrlSafe(16);

  const authorizationUrl = buildAuthorizationUrl(discovery, {
    clientId: LOCAL_IDP_CLIENT_ID,
    redirectUri,
    scopes: ["profile", "email"],
    state,
    nonce,
    codeChallenge: pkce.challenge,
  });

  const authorized = await fetch(authorizationUrl, { redirect: "manual" });
  const location = authorized.headers.get("location");
  assert.ok(location, "the provider did not redirect back");
  const code = options.code ?? new URL(location).searchParams.get("code") ?? "";

  const token = await client.exchangeCode({
    discovery,
    clientId: LOCAL_IDP_CLIENT_ID,
    clientSecret,
    code,
    redirectUri,
    codeVerifier: options.verifier ?? pkce.verifier,
  });
  return { token, nonce, discovery };
}

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

test("SSO is off when the deployment names no provider", () => {
  const result = ssoConfigFromEnv({});
  assert.equal(result.enabled, false);
  assert.equal(result.config, null);
  assert.deepEqual(result.issues, []);
});

test("SSO is refused aloud when it is only half configured", () => {
  const issuerOnly = ssoConfigFromEnv({ ONTRAK_OIDC_ISSUER: "https://idp.test" });
  assert.equal(issuerOnly.enabled, true);
  assert.equal(issuerOnly.config, null);
  assert.match(issuerOnly.issues[0], /ONTRAK_OIDC_CLIENT_ID/);

  const clientOnly = ssoConfigFromEnv({ ONTRAK_OIDC_CLIENT_ID: "app" });
  assert.equal(clientOnly.config, null);
  assert.match(clientOnly.issues[0], /ONTRAK_OIDC_ISSUER/);

  const notAUrl = ssoConfigFromEnv({ ONTRAK_OIDC_ISSUER: "idp.test", ONTRAK_OIDC_CLIENT_ID: "app" });
  assert.equal(notAUrl.config, null);
  assert.match(notAUrl.issues[0], /absolute http\(s\) URL/);
});

test("a configured provider gets sensible defaults", () => {
  const result = ssoConfigFromEnv({
    ONTRAK_OIDC_ISSUER: "https://idp.test/",
    ONTRAK_OIDC_CLIENT_ID: "app",
  });
  assert.ok(result.config);
  // A trailing slash is not significant in an issuer identifier.
  assert.equal(result.config.issuer, "https://idp.test");
  assert.equal(result.config.clientSecret, null);
  assert.deepEqual(result.config.scopes, ["profile", "email"]);
  assert.equal(result.config.defaultRole, "STUDENT");
  assert.equal(result.config.requireMfa, false);
});

test("a configuration mistake stops sign-in rather than degrading it", () => {
  const badRole = ssoConfigFromEnv({
    ONTRAK_OIDC_ISSUER: "https://idp.test",
    ONTRAK_OIDC_CLIENT_ID: "app",
    ONTRAK_OIDC_DEFAULT_ROLE: "SUPERVISOR",
  });
  assert.equal(badRole.config, null);
  assert.match(badRole.issues[0], /ADMIN, INSTRUCTOR or STUDENT/);

  const badMapping = ssoConfigFromEnv({
    ONTRAK_OIDC_ISSUER: "https://idp.test",
    ONTRAK_OIDC_CLIENT_ID: "app",
    ONTRAK_OIDC_ROLE_MAPPINGS: "instructors",
  });
  assert.equal(badMapping.config, null);
  assert.match(badMapping.issues[0], /value=ROLE/);

  const badDomain = ssoConfigFromEnv({
    ONTRAK_OIDC_ISSUER: "https://idp.test",
    ONTRAK_OIDC_CLIENT_ID: "app",
    ONTRAK_OIDC_ALLOWED_DOMAINS: "not a domain",
  });
  assert.equal(badDomain.config, null);
  assert.match(badDomain.issues[0], /is not a domain/);
});

test("role mappings default to the groups claim and report every problem", () => {
  const parsed = parseRoleMappings(
    ["# a comment", "", "instructors=INSTRUCTOR", "roles:it-ops=ADMIN", "broken", "x=NOPE"].join("\n"),
  );
  assert.deepEqual(parsed.mappings, [
    { claim: "groups", value: "instructors", role: "INSTRUCTOR" },
    { claim: "roles", value: "it-ops", role: "ADMIN" },
  ]);
  assert.equal(parsed.errors.length, 2);
});

test("scopes and domains are read as lists, with or without the at-sign", () => {
  const result = ssoConfigFromEnv({
    ONTRAK_OIDC_ISSUER: "https://idp.test",
    ONTRAK_OIDC_CLIENT_ID: "app",
    ONTRAK_OIDC_SCOPES: "profile, email,groups",
    ONTRAK_OIDC_ALLOWED_DOMAINS: "@ontrak.local, innotel.us",
    ONTRAK_OIDC_REQUIRE_MFA: "true",
  });
  assert.ok(result.config);
  assert.deepEqual(result.config.scopes, ["profile", "email", "groups"]);
  assert.deepEqual(result.config.allowedDomains, ["ontrak.local", "innotel.us"]);
  assert.equal(result.config.requireMfa, true);
});

/* -------------------------------------------------------------------------- */
/*  Discovery and the authorization request                                    */
/* -------------------------------------------------------------------------- */

test("discovery must describe the issuer the deployment configured", () => {
  const document = {
    issuer: "https://idp.test",
    authorization_endpoint: "https://idp.test/authorize",
    token_endpoint: "https://idp.test/token",
    jwks_uri: "https://idp.test/jwks.json",
  };
  assert.equal(validateDiscovery(document, "https://idp.test/").ok, true);

  const foreign = validateDiscovery({ ...document, issuer: "https://evil.test" }, "https://idp.test");
  assert.equal(foreign.ok, false);
  assert.match(foreign.ok ? "" : foreign.reason, /does not match the configured issuer/);

  const incomplete = validateDiscovery({ issuer: "https://idp.test" }, "https://idp.test");
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.ok ? "" : incomplete.reason, /no authorization endpoint/);
});

test("the discovery URL is the well-known location of the issuer", () => {
  assert.equal(discoveryUrl("https://idp.test/"), "https://idp.test/.well-known/openid-configuration");
});

test("the authorization request always asks for openid, and never repeats a scope", () => {
  const url = new URL(
    buildAuthorizationUrl(
      {
        issuer: "https://idp.test",
        authorizationEndpoint: "https://idp.test/authorize",
        tokenEndpoint: "https://idp.test/token",
        jwksUri: "https://idp.test/jwks.json",
      },
      {
        clientId: "app",
        redirectUri: "https://app.test/api/sso/callback",
        scopes: ["openid", "email", "email"],
        state: "state-1",
        nonce: "nonce-1",
        codeChallenge: "challenge-1",
      },
    ),
  );
  assert.equal(url.searchParams.get("scope"), "openid email");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), "https://app.test/api/sso/callback");
});

/* -------------------------------------------------------------------------- */
/*  Claims                                                                    */
/* -------------------------------------------------------------------------- */

test("an assertion from somebody else's provider is refused", () => {
  const result = extractOidcClaims({ iss: "https://evil.test", sub: "1", email: "a@b.test" }, { issuer: "https://idp.test" });
  assert.equal(result.ok, false);
});

test("a replayed assertion is refused", () => {
  const payload = { iss: "https://idp.test", sub: "1", email: "a@b.test", nonce: "ours" };
  assert.equal(extractOidcClaims(payload, { issuer: "https://idp.test", nonce: "theirs" }).ok, false);
  assert.equal(extractOidcClaims(payload, { issuer: "https://idp.test", nonce: "ours" }).ok, true);
});

test("an unverified or missing address is refused", () => {
  const unverified = extractOidcClaims(
    { iss: "https://idp.test", sub: "1", email: "a@b.test", email_verified: false },
    { issuer: "https://idp.test" },
  );
  assert.equal(unverified.ok, false);
  assert.match(unverified.ok ? "" : unverified.reason, /not verified/);

  const addressed = extractOidcClaims({ iss: "https://idp.test", sub: "1" }, { issuer: "https://idp.test" });
  assert.equal(addressed.ok, false);

  const nameless = extractOidcClaims({ iss: "https://idp.test", email: "a@b.test" }, { issuer: "https://idp.test" });
  assert.equal(nameless.ok, false);
  assert.match(nameless.ok ? "" : nameless.reason, /no subject/);
});

test("groups and roles are both read, and a second factor is recognised", () => {
  const withGroups = extractOidcClaims(
    { iss: "https://idp.test", sub: "1", email: "a@b.test", groups: ["a"], roles: ["b"], amr: ["pwd", "otp"] },
    { issuer: "https://idp.test" },
  );
  assert.ok(withGroups.ok);
  assert.deepEqual(withGroups.claims.groups, ["a", "b"]);
  assert.equal(withGroups.claims.mfa, true);

  const passwordOnly = extractOidcClaims(
    { iss: "https://idp.test", sub: "1", email: "a@b.test", amr: ["pwd"] },
    { issuer: "https://idp.test" },
  );
  assert.ok(passwordOnly.ok);
  assert.equal(passwordOnly.claims.mfa, false);
});

/* -------------------------------------------------------------------------- */
/*  Authorization                                                             */
/* -------------------------------------------------------------------------- */

test("a mapped group decides the role, and the default covers everybody else", () => {
  const mapped = authorizeSso(config("https://idp.test"), claims("https://idp.test"));
  assert.ok(mapped.ok);
  assert.equal(mapped.authorization.role, "INSTRUCTOR");
  assert.equal(mapped.authorization.mapped, true);

  const unmapped = authorizeSso(
    config("https://idp.test"),
    claims("https://idp.test", { groups: [], sub: "2", email: "student@ontrak.local", name: undefined }),
  );
  assert.ok(unmapped.ok);
  assert.equal(unmapped.authorization.role, "STUDENT");
  assert.equal(unmapped.authorization.mapped, false);
  // With no name asserted, the address's local part is the best available answer.
  assert.equal(unmapped.authorization.name, "student");
});

test("group matching ignores case, because providers disagree about it", () => {
  const result = authorizeSso(
    config("https://idp.test", { roleMappings: [{ claim: "groups", value: "Instructors", role: "INSTRUCTOR" }] }),
    claims("https://idp.test", { groups: ["INSTRUCTORS"] }),
  );
  assert.ok(result.ok);
  assert.equal(result.authorization.role, "INSTRUCTOR");
});

test("a domain allow-list and a required second factor are both enforced", () => {
  const domain = authorizeSso(
    config("https://idp.test", { allowedDomains: ["innotel.us"] }),
    claims("https://idp.test"),
  );
  assert.equal(domain.ok, false);
  assert.match(domain.ok ? "" : domain.reason, /not an allowed sign-in domain/);

  const mfa = authorizeSso(
    config("https://idp.test", { requireMfa: true }),
    claims("https://idp.test", { mfa: undefined, amr: ["pwd"] }),
  );
  assert.equal(mfa.ok, false);
  assert.match(mfa.ok ? "" : mfa.reason, /multi-factor/);
});

test("a repeat sign-in never reactivates, and never leaves the deployment without an administrator", () => {
  assert.deepEqual(
    applySsoRole({ current: "STUDENT", mapped: "ADMIN", otherActiveAdmins: 3, active: false }),
    { role: "STUDENT", note: null },
  );

  const lastAdmin = applySsoRole({ current: "ADMIN", mapped: "STUDENT", otherActiveAdmins: 0, active: true });
  assert.equal(lastAdmin.role, "ADMIN");
  assert.match(lastAdmin.note ?? "", /no administrator/);

  const demoted = applySsoRole({ current: "ADMIN", mapped: "STUDENT", otherActiveAdmins: 1, active: true });
  assert.equal(demoted.role, "STUDENT");
  assert.equal(demoted.note, null);
});

/* -------------------------------------------------------------------------- */
/*  The round trip's state                                                    */
/* -------------------------------------------------------------------------- */

test("the authorization state has to be complete to be trusted", () => {
  const complete = {
    state: "s",
    nonce: "n",
    codeVerifier: "v",
    returnTo: "/student",
    at: new Date().toISOString(),
  };
  assert.equal(isAuthorizationState(complete), true);
  assert.equal(isAuthorizationState({ ...complete, codeVerifier: "" }), false);
  assert.equal(isAuthorizationState(null), false);
  assert.equal(SSO_STATE_COOKIE, "ontrak_training_sso");

  const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  assert.equal(stateExpired({ ...complete, at: old }, new Date().toISOString()), true);
  assert.equal(stateExpired(complete, new Date().toISOString()), false);
});

test("only a same-site path may survive as a destination", () => {
  assert.equal(safeRelativePath("/student"), "/student");
  assert.equal(safeRelativePath("//evil.test"), null);
  assert.equal(safeRelativePath("https://evil.test"), null);
});

test("the deployment states its own address, and falls back to the request's", () => {
  assert.equal(deploymentOrigin("https://training.test/", "http://0.0.0.0:3000"), "https://training.test");
  assert.equal(deploymentOrigin(undefined, "http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
  assert.equal(
    ssoRedirectUri("https://training.test"),
    "https://training.test/api/sso/callback",
  );
});

/* -------------------------------------------------------------------------- */
/*  Resolving an assertion to an account                                      */
/* -------------------------------------------------------------------------- */

test("a first sign-in provisions an account with no local password", async () => {
  const { store, users } = fakeStore();
  const authorization: SsoAuthorization = {
    email: "sso.user@ontrak.local",
    subject: "idp-subject-1",
    name: "Ida SSO",
    role: "INSTRUCTOR",
    mapped: true,
  };

  const result = await resolveSsoSignIn(store, authorization);
  assert.ok(result.ok);
  assert.equal(result.value.provisioned, true);
  assert.equal(users.length, 1);
  assert.equal(users[0].externalId, "idp-subject-1");
  assert.equal(users[0].role, "INSTRUCTOR");
  assert.equal(users[0].active, true);
  assert.ok(users[0].accent);
});

test("an account that predates SSO is adopted by its email, not duplicated", async () => {
  const { store, users } = fakeStore([account({ id: "user-1", role: "STUDENT", externalId: null })]);
  const result = await resolveSsoSignIn(store, {
    email: "sso.user@ontrak.local",
    subject: "idp-subject-1",
    name: "Ida SSO",
    role: "STUDENT",
    mapped: true,
  });
  assert.ok(result.ok);
  assert.equal(result.value.provisioned, false);
  assert.equal(users.length, 1);
  assert.equal(users[0].id, "user-1");
  assert.equal(users[0].externalId, "idp-subject-1");
});

test("a rename at the provider is a move, not a second account", async () => {
  const { store, users } = fakeStore([account({ id: "user-1", externalId: "idp-subject-1" })]);
  const result = await resolveSsoSignIn(store, {
    email: "ida.renamed@ontrak.local",
    subject: "idp-subject-1",
    name: "Ida Renamed",
    role: "STUDENT",
    mapped: true,
  });
  assert.ok(result.ok);
  assert.equal(users.length, 1);
  assert.equal(users[0].email, "ida.renamed@ontrak.local");
  assert.equal(users[0].name, "Ida Renamed");
});

test("an assertion cannot take over an address another account already holds", async () => {
  const { store, users } = fakeStore([
    account({ id: "user-1", email: "first@ontrak.local", externalId: "idp-subject-1" }),
    account({ id: "user-2", email: "second@ontrak.local", externalId: "idp-subject-2" }),
  ]);
  const result = await resolveSsoSignIn(store, {
    email: "second@ontrak.local",
    subject: "idp-subject-1",
    name: "Not Yours",
    role: "STUDENT",
    mapped: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /already belongs to another account/);
  assert.equal(users[1].name, "Ida SSO");
});

test("a deactivated account stays deactivated, whatever the directory says", async () => {
  const { store } = fakeStore([account({ active: false, externalId: "idp-subject-1" })]);
  const result = await resolveSsoSignIn(store, {
    email: "sso.user@ontrak.local",
    subject: "idp-subject-1",
    name: "Ida SSO",
    role: "INSTRUCTOR",
    mapped: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /deactivated/);
});

test("a role the directory changed is written, and a demotion that would strand the deployment is not", async () => {
  const { store, users } = fakeStore([account({ id: "user-1", role: "ADMIN", externalId: "idp-subject-1" })]);
  const stranded = await resolveSsoSignIn(store, {
    email: "sso.user@ontrak.local",
    subject: "idp-subject-1",
    name: "Ida SSO",
    role: "STUDENT",
    mapped: true,
  });
  assert.ok(stranded.ok);
  assert.equal(stranded.value.roleChanged, false);
  assert.match(stranded.value.note ?? "", /no administrator/);
  assert.equal(users[0].role, "ADMIN");

  const { store: shared, users: people } = fakeStore([
    account({ id: "user-1", role: "ADMIN", externalId: "idp-subject-1" }),
    account({ id: "user-2", email: "other@ontrak.local", role: "ADMIN", externalId: "idp-subject-2" }),
  ]);
  const moved = await resolveSsoSignIn(shared, {
    email: "sso.user@ontrak.local",
    subject: "idp-subject-1",
    name: "Ida SSO",
    role: "INSTRUCTOR",
    mapped: true,
  });
  assert.ok(moved.ok);
  assert.equal(moved.value.roleChanged, true);
  assert.equal(people[0].role, "INSTRUCTOR");
});

test("the audit records a sign-in without recording the address", () => {
  const event = ssoSignInAudit(
    { email: "sso.user@ontrak.local", subject: "s", name: "Ida", role: "INSTRUCTOR", mapped: true },
    { user: account({ role: "INSTRUCTOR" }), provisioned: true, roleChanged: false, note: null },
    "https://idp.test",
  );
  assert.equal(event.action, "auth.sso_sign_in");
  assert.equal(event.detail.provider, "https://idp.test");
  assert.equal(event.detail.provisioned, true);
  assert.equal(JSON.stringify(event.detail).includes("sso.user@"), false);

  const denied: SsoAuditEvent = ssoDeniedAudit("https://idp.test", "Not allowed.");
  assert.equal(denied.action, "auth.sso_sign_in_denied");
  assert.equal(denied.actorId, null);
  assert.equal(JSON.stringify(denied.detail).includes("sso.user@"), false);
});

/* -------------------------------------------------------------------------- */
/*  The handshake, against a real provider                                     */
/* -------------------------------------------------------------------------- */

test("sso: a full authorization-code handshake proves the identity and resolves an account", async () => {
  const idp = await startLocalIdp();
  try {
    const { token, nonce } = await exchange(idp.issuer, null);

    // The signature was verified against the JWKS the provider published, which
    // means `jose` fetched it and the ES256 signature checked out.
    assert.equal(idp.calls.jwks > 0, true);
    assert.equal(token.idToken.split(".").length, 3);

    const claimsResult = extractOidcClaims(token.payload, { issuer: idp.issuer, nonce });
    assert.ok(claimsResult.ok);
    assert.equal(claimsResult.claims.email, "sso.user@ontrak.local");

    const authorized = authorizeSso(config(idp.issuer), claimsResult.claims);
    assert.ok(authorized.ok);
    assert.equal(authorized.authorization.role, "INSTRUCTOR");

    const { store, users } = fakeStore();
    const signedIn = await resolveSsoSignIn(store, authorized.authorization);
    assert.ok(signedIn.ok);
    assert.equal(users.length, 1);
    assert.equal(users[0].externalId, "idp-subject-1");
    assert.equal(users[0].role, "INSTRUCTOR");
  } finally {
    await idp.close();
  }
});

test("sso: a token signed with a key the provider never published is refused", async () => {
  const idp = await startLocalIdp({ signWithUnpublishedKey: true });
  try {
    await assert.rejects(() => exchange(idp.issuer, null), /token endpoint answered|signature/i);
  } finally {
    await idp.close();
  }
});

test("sso: an authorization code is single use", async () => {
  const idp = await startLocalIdp();
  try {
    const first = await exchange(idp.issuer, null);
    assert.ok(first.token.idToken);

    // The code `exchange` just used, presented a second time.
    const replay = await fetch(new URL("/token", idp.issuer), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: idp.issuedCodes[0],
        redirect_uri: ssoRedirectUri("http://127.0.0.1:3000"),
        client_id: LOCAL_IDP_CLIENT_ID,
      }).toString(),
    });
    assert.equal(replay.status, 400);
    const body = (await replay.json()) as { error?: string };
    assert.equal(body.error, "invalid_grant");
  } finally {
    await idp.close();
  }
});

test("sso: a wrong PKCE verifier, a wrong client secret and a replayed code are each refused", async () => {
  const idp = await startLocalIdp();
  try {
    await assert.rejects(() => exchange(idp.issuer, null, { verifier: "not-the-verifier" }), /token endpoint answered 400/);
  } finally {
    await idp.close();
  }

  const strict = await startLocalIdp({ clientSecret: "s3cret" });
  try {
    await assert.rejects(() => exchange(strict.issuer, null), /token endpoint answered 401/);
    const withSecret = await exchange(strict.issuer, "s3cret");
    assert.ok(withSecret.token.idToken);
  } finally {
    await strict.close();
  }
});

test("sso: the memory client drives the same rules without a provider", async () => {
  const issuer = "https://memory.test";
  const client = new MemoryOidcClient({
    payloads: {
      "code-1": {
        iss: issuer,
        sub: "memory-subject",
        email: "memory.user@ontrak.local",
        email_verified: true,
        name: "Memory User",
        groups: ["instructors"],
      },
    },
  });

  const discovery = await client.discover(issuer);
  assert.equal(discovery.tokenEndpoint, `${issuer}/token`);

  const pkce = createPkcePair();
  const token = await client.exchangeCode({
    discovery,
    clientId: "app",
    clientSecret: null,
    code: "code-1",
    redirectUri: ssoRedirectUri("https://training.test"),
    codeVerifier: pkce.verifier,
  });

  const claimsResult = extractOidcClaims(token.payload, { issuer });
  assert.ok(claimsResult.ok);
  const authorized = authorizeSso(config(issuer), claimsResult.claims);
  assert.ok(authorized.ok);
  assert.equal(authorized.authorization.role, "INSTRUCTOR");
});
