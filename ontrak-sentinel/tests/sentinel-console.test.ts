/**
 * OnTrak Sentinel S0/S1 tests: the console shell.
 *
 * The console is where an IdP stops being a set of endpoints and becomes something
 * a person can use, so each test follows one way that can go wrong:
 *
 *  - a page reachable without a session (an IdP console that renders for anybody is
 *    a directory disclosure);
 *  - a shared secret that outlives the response that showed it, or leaks into a URL;
 *  - a second factor that can be enrolled for *somebody else* without permission, or
 *    cannot be enrolled for oneself (the dead end this milestone exists to remove);
 *  - a sign-out that ends the session but leaves its access tokens working;
 *  - somebody else's text rendered as markup;
 *  - and a path the console does not serve answering with a page instead of a `404`,
 *    which would stop the OIDC and SAML routers behind it from ever being asked.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import { CONSOLE_PATHS, CONSOLE_SESSION_COOKIE } from "../src/lib/console-rules";
import { ConsoleService } from "../src/lib/console-service";
import { routeConsole } from "../src/lib/console-http";
import { sha256Hex } from "../src/lib/hash";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog, type IdentityActor } from "../src/lib/identity-service";
import { base32Decode, totpCode, totpCounter } from "../src/lib/mfa-rules";
import { MemoryMfaStore, MfaService, systemTotpSigner, type MfaIds } from "../src/lib/mfa-service";
import { MemoryOidcStore, type AccessTokenRecord } from "../src/lib/oidc-service";
import { MemoryScimStore, ScimService, type ScimIds, type ScimTokenRevoker } from "../src/lib/scim-service";
import type { HttpRequest } from "../src/lib/oidc-http";
import { base64UrlEncode } from "../src/lib/webauthn-rules";
import { MemoryWebAuthnChallengeStore, WebAuthnService, type WebAuthnIds } from "../src/lib/webauthn-service";
import { createFixtureAuthenticator } from "./webauthn-fixtures";

const sha256: HashFn = sha256Hex;
const ORIGIN = "https://id.sentinel.test";
const RP_ID = "id.sentinel.test";
const SIGNER = systemTotpSigner();

let harnessSeq = 0;

function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  const tokens = new MemoryOidcStore();
  let clock = Date.parse("2026-10-20T09:00:00.000Z");
  let n = 0;
  const scope = `c${++harnessSeq}`;

  const spine = new IdentityService(identities, audit, {
    id: () => `${scope}-id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  });
  const factors = new MemoryMfaStore();
  const mfaIds: MfaIds = {
    id: () => `${scope}-factor-${++n}`,
    // A fixed, deterministic base32 secret: a test's code has to be reproducible, and
    // the value itself is not the thing under test.
    secret: () => "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };
  const mfa = new MfaService(factors, spine, audit, mfaIds);
  const webAuthnIds: WebAuthnIds = {
    id: () => `${scope}-challenge-${++n}`,
    challenge: () => base64UrlEncode(Uint8Array.from({ length: 32 }, (_, index) => (index * 11 + n) % 256)),
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };
  const webauthn = new WebAuthnService(
    factors,
    new MemoryWebAuthnChallengeStore(),
    spine,
    { rpId: RP_ID, rpName: "OnTrak Sentinel", origin: ORIGIN },
    audit,
    webAuthnIds,
  );
  const scimIds: ScimIds = {
    id: () => `${scope}-scim-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
    // 24 bytes as base64url is 32 characters — the length the real mint produces.
    token: () => `sc1_${"c".repeat(24)}${`${++n}`.padStart(8, "0")}`,
  };
  const scimRevoker: ScimTokenRevoker = { revokeTokensForSession: async () => 1 };
  const scim = new ScimService(new MemoryScimStore(), spine, { baseUrl: `${ORIGIN}/scim/v2` }, audit, scimRevoker, scimIds);
  const console_ = new ConsoleService(spine, mfa, webauthn, tokens, scim);

  return {
    spine,
    mfa,
    webauthn,
    tokens,
    scim,
    audit,
    service: console_,
    nowMs: () => clock,
    advance(ms: number) {
      clock += ms;
    },
    /**
     * A bootstrapped organization with a live administrator session.
     *
     * `factor: false` sets the enrolled *flag* without a factor — the shortcut the
     * other S1 suites use — so a test can see the page's "not enrolled" state and still
     * hold a session. Otherwise a real factor is enrolled through the product, so the
     * page and the flag agree.
     */
    async organization(slug: string, options: { factor?: boolean; admin?: string } = {}) {
      const admin = options.admin ?? `admin@${slug}.test`;
      const created = await spine.bootstrapOrganization("test", { name: `${slug} Inc`, slug }, { identifier: admin, displayName: `Admin ${slug}` });
      assert.ok(created.ok, created.ok ? "" : created.error);
      const actor: IdentityActor = { id: created.value.admin.id, organizationId: created.value.organization.id, role: "ADMIN" };

      if (options.factor === false) {
        assert.ok((await spine.setMfaEnrolled(actor, actor.id, true)).ok);
      } else {
        const begun = await mfa.beginEnrollment(actor, actor.id);
        assert.ok(begun.ok, begun.ok ? "" : begun.error);
        const confirmed = await mfa.confirmEnrollment(actor, actor.id, codeFor(begun.value.secret, clock));
        assert.ok(confirmed.ok, confirmed.ok ? "" : confirmed.error);
      }

      const session = await spine.issueSession(actor.organizationId, actor.id);
      if (!session.ok) throw new Error(session.error);
      return { actor, admin: created.value.admin, sessionId: session.value.id };
    },
  };
}

function codeFor(secret: string, atMs: number): string {
  const bytes = base32Decode(secret);
  assert.ok(bytes, "the test secret should decode");
  return totpCode(bytes, totpCounter(atMs), SIGNER);
}

function request(
  method: string,
  path: string,
  options: { sessionId?: string | null; body?: string; contentType?: string } = {},
): HttpRequest {
  const headers: Record<string, string | undefined> = {};
  const cookies: Record<string, string> = {};
  if (options.sessionId) cookies[CONSOLE_SESSION_COOKIE] = options.sessionId;
  if (options.body) headers["content-type"] = options.contentType ?? "application/x-www-form-urlencoded";
  return { method, url: `${ORIGIN}${path}`, headers, body: options.body, cookies };
}

/* -------------------------------------------------------------------------- */
/*  Reaching the console                                                      */
/* -------------------------------------------------------------------------- */

test("console: a page with no session is bounced to the sign-in form", async () => {
  // Not an error page. A person who is not signed in is the normal case at the front
  // door, and the one screen that can help them is the sign-in form — which the page
  // used to merely link to, after asserting a cookie they had not sent.
  const h = harness();
  const response = await routeConsole(request("GET", CONSOLE_PATHS.home), h.service);
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, CONSOLE_PATHS.signIn);
  assert.match(response.headers["set-cookie"] ?? "", /Max-Age=0/, "the dead cookie is expired on the way");
  assert.equal(response.headers["cache-control"], "no-store");
});

test("console: a session id that does not exist is bounced, not guessed into one", async () => {
  const h = harness();
  await h.organization("acme");
  const response = await routeConsole(request("GET", CONSOLE_PATHS.mfa, { sessionId: "not-a-session" }), h.service);
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, CONSOLE_PATHS.signIn);
  assert.match(response.headers["set-cookie"] ?? "", /Max-Age=0/);
});

test("console: provisioning is an administrator's page, and a minted token is shown once in a body rather than a URL", async () => {
  const h = harness();
  const { sessionId } = await h.organization("acme", { factor: false });

  const page = await routeConsole(request("GET", CONSOLE_PATHS.provisioning, { sessionId }), h.service);
  assert.equal(page.status, 200);
  // The nav reaches it, and the page says where a connector points.
  assert.match(page.body, new RegExp(CONSOLE_PATHS.provisioning));
  assert.match(page.body, /scim\/v2/);
  assert.match(page.body, /No token yet/);

  const minted = await routeConsole(
    request("POST", CONSOLE_PATHS.mintToken, { sessionId, body: "label=Entra+ID" }),
    h.service,
  );
  // Rendered, not redirected: a token in a `Location` header ends up in browser history,
  // in `Referer` and in a proxy log, which is the last place a credential may be.
  assert.equal(minted.status, 200);
  assert.equal(minted.headers.location, undefined);
  const plaintext = /sc1_[A-Za-z0-9_-]+/.exec(minted.body)?.[0];
  assert.ok(plaintext, "the token should be shown once");
  assert.match(minted.body, /Entra ID/);

  // And only once: the listing afterwards names it without carrying its value.
  const listed = await routeConsole(request("GET", CONSOLE_PATHS.provisioning, { sessionId }), h.service);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.includes(plaintext!), false);
  const value = /name="tokenId" value="([^"]+)"/.exec(listed.body)?.[1];
  assert.ok(value, "a live token should offer a Revoke form");

  const revoked = await routeConsole(
    request("POST", CONSOLE_PATHS.revokeToken, { sessionId, body: `tokenId=${encodeURIComponent(value)}` }),
    h.service,
  );
  // A state change that finished redirects, so a refresh re-reads the page.
  assert.equal(revoked.status, 303);
  assert.match(revoked.headers.location, /provisioning/);

  const after = await routeConsole(request("GET", CONSOLE_PATHS.provisioning, { sessionId }), h.service);
  assert.match(after.body, /revoked/);
  assert.equal(after.body.includes("name=\"tokenId\""), false);
});

test("console: provisioning is refused to an identity that does not administer identities", async () => {
  const h = harness();
  const { actor } = await h.organization("acme", { factor: false });
  const agent = await h.spine.createIdentity(actor, {
    identifier: "agent@acme.test",
    displayName: "Agent",
    role: "AGENT",
  });
  assert.ok(agent.ok);
  assert.ok((await h.spine.setMfaEnrolled(actor, agent.value.id, true)).ok);
  const session = await h.spine.issueSession(actor.organizationId, agent.value.id);
  assert.ok(session.ok);

  const page = await routeConsole(request("GET", CONSOLE_PATHS.provisioning, { sessionId: session.value.id }), h.service);
  assert.equal(page.status, 403);

  // The mint is refused at the same door, and nothing was minted.
  const minted = await routeConsole(request("POST", CONSOLE_PATHS.mintToken, { sessionId: session.value.id }), h.service);
  assert.equal(minted.status, 403);
  const tokens = await h.scim.listTokens(actor);
  assert.ok(tokens.ok);
  assert.equal(tokens.value.length, 0);
});

test("console: the overview shows who you are, whether a factor is enrolled, and the chain", async () => {
  const h = harness();
  const { sessionId, admin } = await h.organization("acme", { factor: false });
  const response = await routeConsole(request("GET", CONSOLE_PATHS.home, { sessionId }), h.service);
  assert.equal(response.status, 200);
  assert.match(response.body, /Admin acme/);
  assert.match(response.body, new RegExp(admin.identifier.replace(".", "\\.")));
  assert.match(response.body, /acme Inc/);
  assert.match(response.body, /Not enrolled/);
  assert.match(response.body, /verifies end to end/);
  // The chain is read through the spine, so the org's own writes are on the page.
  assert.match(response.body, /organization\.create/);
});

test("console: a page the console does not serve is a 404, so the other routers still get asked", async () => {
  const h = harness();
  const response = await routeConsole(request("GET", "/oauth2/authorize"), h.service);
  assert.equal(response.status, 404);
  assert.match(response.body, /not_found/);
});

test("console: the bare host sends a person to the console instead of a JSON 404", async () => {
  const h = harness();
  const response = await routeConsole(request("GET", "/"), h.service);
  // 303, not 302: both mean "look over there", and 303 is the one that says the
  // *next* request is a plain GET on the new URL — which is what this is.
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, CONSOLE_PATHS.home);
  assert.equal(response.headers["cache-control"], "no-store");
  // A redirect, not a page: nothing is rendered, so the root cannot be mistaken for
  // the console or leak a signed-out shell that a proxy later caches.
  assert.equal(response.body, "");
});

test("console: the root redirect answers a POST the way every other GET-only page does", async () => {
  const h = harness();
  const response = await routeConsole(request("POST", "/", { body: "" }), h.service);
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, "GET");
});

test("console: a GET-only page answers a POST with 405 rather than doing something", async () => {
  const h = harness();
  const { sessionId } = await h.organization("acme");
  const response = await routeConsole(request("POST", CONSOLE_PATHS.home, { sessionId, body: "" }), h.service);
  assert.equal(response.status, 405);
  assert.match(response.headers.allow ?? "", /GET/);
});

/* -------------------------------------------------------------------------- */
/*  Self-service enrollment                                                   */
/* -------------------------------------------------------------------------- */

test("console: enrolling an authenticator app shows the secret once and never again", async () => {
  const h = harness();
  const { sessionId } = await h.organization("acme", { factor: false });

  const begun = await routeConsole(
    request("POST", CONSOLE_PATHS.totpBegin, { sessionId, body: "label=Phone" }),
    h.service,
  );
  assert.equal(begun.status, 200);
  assert.match(begun.body, /otpauth:\/\/totp\//);
  assert.match(begun.body, /shown once/);
  assert.match(begun.body, /Phone/);

  // The secret is in the body of the POST that asked for it, and nowhere else. A URL
  // would put it in browser history, in `Referer`, and in every proxy log between.
  const secret = /<pre>([A-Z2-7 ]+)<\/pre>/.exec(begun.body)?.[1].replace(/ /g, "");
  assert.ok(secret, "the enrollment page should show a secret");

  const reloaded = await routeConsole(request("GET", CONSOLE_PATHS.mfa, { sessionId }), h.service);
  assert.equal(reloaded.status, 200);
  assert.doesNotMatch(reloaded.body, new RegExp(secret));
  // The enrollment is still waiting, so the page offers the confirmation form.
  assert.match(reloaded.body, /Finish enrolling the app/);
  assert.match(reloaded.body, /An enrollment is waiting/);
});

test("console: a code from the secret completes the enrollment, and the policy is satisfied", async () => {
  const h = harness();
  const { sessionId, actor } = await h.organization("acme", { factor: false });
  const begun = await routeConsole(request("POST", CONSOLE_PATHS.totpBegin, { sessionId, body: "" }), h.service);
  const secret = /<pre>([A-Z2-7 ]+)<\/pre>/.exec(begun.body)![1].replace(/ /g, "");

  const confirmed = await routeConsole(
    request("POST", CONSOLE_PATHS.totpConfirm, { sessionId, body: `code=${codeFor(secret, h.nowMs())}` }),
    h.service,
  );
  assert.equal(confirmed.status, 303);
  assert.match(confirmed.headers.location ?? "", /flash=/);

  const identity = await h.spine.identity(actor, actor.id);
  assert.ok(identity.ok);
  assert.equal(identity.value.mfaEnrolled, true);

  // A fresh session is now grantable: the S0 dead end is closed by the person
  // themselves, with no administrator in the loop.
  const session = await h.spine.issueSession(actor.organizationId, actor.id);
  assert.ok(session.ok, session.ok ? "" : session.error);

  const page = await routeConsole(request("GET", CONSOLE_PATHS.mfa, { sessionId }), h.service);
  assert.match(page.body, /The session policy is satisfied/);
  assert.match(page.body, /Authenticator app/);
});

test("console: a wrong code is refused and leaves the identity unenrolled", async () => {
  const h = harness();
  const { sessionId, actor } = await h.organization("acme", { factor: false });
  await routeConsole(request("POST", CONSOLE_PATHS.totpBegin, { sessionId, body: "" }), h.service);

  const refused = await routeConsole(
    request("POST", CONSOLE_PATHS.totpConfirm, { sessionId, body: "code=000000" }),
    h.service,
  );
  assert.equal(refused.status, 400);
  assert.match(refused.body, /did not verify|did not match/);

  // Nothing was confirmed: the enrollment is still waiting for a code that proves
  // it, which is the difference between a second factor and a checkbox.
  const status = await h.mfa.status(actor, actor.id);
  assert.ok(status.ok, status.ok ? "" : status.error);
  assert.equal(status.value.pending?.confirmedAt, null);
  assert.equal(status.value.factors.filter((factor) => factor.confirmed).length, 0);
});

test("console: an agent's own session adds a factor without an administrator", async () => {
  const h = harness();
  const { actor, admin } = await h.organization("acme");
  const created = await h.spine.createIdentity(actor, { identifier: "agent@acme.test", displayName: "Agent", role: "AGENT" });
  assert.ok(created.ok, created.ok ? "" : created.error);
  const agent: IdentityActor = { id: created.value.id, organizationId: actor.organizationId, role: "AGENT" };

  // The bootstrap S1 has, stated plainly: the console needs a live session, and the
  // default policy refuses one without a second factor, so an identity's *first*
  // factor has to come from an administrator (or from a login path that prompts for
  // one — S2's password credentials). Everything after that is the person's own.
  const bootstrapped = await h.mfa.beginEnrollment(actor, agent.id);
  assert.ok(bootstrapped.ok, bootstrapped.ok ? "" : bootstrapped.error);
  assert.ok((await h.mfa.confirmEnrollment(actor, agent.id, codeFor(bootstrapped.value.secret, h.nowMs()))).ok);
  const session = await h.spine.issueSession(agent.organizationId, agent.id);
  assert.ok(session.ok, session.ok ? "" : session.error);
  const sessionId = session.value.id;

  const page = await routeConsole(request("GET", CONSOLE_PATHS.mfa, { sessionId }), h.service);
  assert.equal(page.status, 200);
  assert.match(page.body, /The session policy is satisfied/);

  // The agent registers a security key alongside the app, with no administrator in
  // the request at all.
  const options = await routeConsole(request("POST", CONSOLE_PATHS.webauthnBegin, { sessionId }), h.service);
  assert.equal(options.status, 200);
  const parsed = JSON.parse(options.body) as { challengeId: string; challenge: string };
  const authenticator = createFixtureAuthenticator();
  const finished = await routeConsole(
    request("POST", CONSOLE_PATHS.webauthnFinish, {
      sessionId,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: parsed.challengeId,
        response: authenticator.register({ challenge: parsed.challenge, origin: ORIGIN, rpId: RP_ID }),
      }),
    }),
    h.service,
  );
  assert.equal(finished.status, 200);
  assert.match(page.body, /Authenticator app/);

  // The same agent, reaching for the administrator's factors: refused, because the
  // permission follows the identity, not the session.
  const theirs = await h.mfa.status(agent, admin.id);
  assert.equal(theirs.ok, false);
  assert.match(theirs.ok ? "" : theirs.error, /administer identities/);
});

test("console: removing the last factor ends every session, including the one that asked", async () => {
  const h = harness();
  const { sessionId, actor } = await h.organization("acme");

  const removed = await routeConsole(request("POST", CONSOLE_PATHS.removeAll, { sessionId, body: "" }), h.service);
  assert.equal(removed.status, 303);
  assert.match(decodeURIComponent(removed.headers.location ?? ""), /Every session for this identity is now refused/);

  // This is the consequence the page warns about, and it is deliberate: the default
  // policy refuses a session that owes a second factor, everywhere. Getting back in is
  // an administrator's act — or a login path that prompts for one.
  const afterwards = await routeConsole(request("GET", CONSOLE_PATHS.mfa, { sessionId }), h.service);
  assert.equal(afterwards.status, 303, "the session that is now refused lands on the sign-in form");
  assert.equal(afterwards.headers.location, CONSOLE_PATHS.signIn);

  // And an administrator can still bootstrap a new factor for the identity.
  const again = await h.mfa.beginEnrollment(actor, actor.id);
  assert.ok(again.ok, again.ok ? "" : again.error);
  assert.ok((await h.mfa.confirmEnrollment(actor, actor.id, codeFor(again.value.secret, h.nowMs()))).ok);
  const fresh = await h.spine.issueSession(actor.organizationId, actor.id);
  assert.ok(fresh.ok, fresh.ok ? "" : fresh.error);
  const page = await routeConsole(request("GET", CONSOLE_PATHS.mfa, { sessionId: fresh.value.id }), h.service);
  assert.equal(page.status, 200);
});

test("console: removing every factor clears the flag, and the next session is refused", async () => {
  const h = harness();
  const { sessionId, actor } = await h.organization("acme", { factor: false });
  const begun = await routeConsole(request("POST", CONSOLE_PATHS.totpBegin, { sessionId, body: "" }), h.service);
  const secret = /<pre>([A-Z2-7 ]+)<\/pre>/.exec(begun.body)![1].replace(/ /g, "");
  await routeConsole(request("POST", CONSOLE_PATHS.totpConfirm, { sessionId, body: `code=${codeFor(secret, h.nowMs())}` }), h.service);

  const removed = await routeConsole(request("POST", CONSOLE_PATHS.removeAll, { sessionId, body: "" }), h.service);
  assert.equal(removed.status, 303);
  assert.match(decodeURIComponent(removed.headers.location ?? ""), /Removed 1 factor/);

  const identity = await h.spine.identity(actor, actor.id);
  assert.ok(identity.ok);
  assert.equal(identity.value.mfaEnrolled, false);
  const next = await h.spine.issueSession(actor.organizationId, actor.id);
  assert.equal(next.ok, false);
});

/* -------------------------------------------------------------------------- */
/*  Security keys through the console                                         */
/* -------------------------------------------------------------------------- */

test("console: a security key is registered through the page's own ceremony", async () => {
  const h = harness();
  const { sessionId, actor } = await h.organization("acme", { factor: false });

  const options = await routeConsole(request("POST", CONSOLE_PATHS.webauthnBegin, { sessionId }), h.service);
  assert.equal(options.status, 200);
  const parsed = JSON.parse(options.body) as { challengeId: string; challenge: string; rp: { id: string }; user: { name: string } };
  assert.equal(parsed.rp.id, RP_ID);
  assert.equal(parsed.user.name, "admin@acme.test");

  const authenticator = createFixtureAuthenticator();
  const response = authenticator.register({ challenge: parsed.challenge, origin: ORIGIN, rpId: RP_ID });
  const finished = await routeConsole(
    request("POST", CONSOLE_PATHS.webauthnFinish, {
      sessionId,
      contentType: "application/json",
      body: JSON.stringify({ challengeId: parsed.challengeId, label: "YubiKey", response }),
    }),
    h.service,
  );
  assert.equal(finished.status, 200);
  assert.match(finished.body, /"ok":true/);

  const identity = await h.spine.identity(actor, actor.id);
  assert.ok(identity.ok);
  assert.equal(identity.value.mfaEnrolled, true);

  const page = await routeConsole(request("GET", CONSOLE_PATHS.mfa, { sessionId }), h.service);
  assert.match(page.body, /Security key/);
  assert.match(page.body, /YubiKey/);

  // And it can be removed on its own, by the credential id the page carries.
  const removed = await routeConsole(
    request("POST", CONSOLE_PATHS.webauthnRemove, { sessionId, body: `credentialId=${encodeURIComponent(authenticator.credentialId)}` }),
    h.service,
  );
  assert.equal(removed.status, 303);
  const after = await h.spine.identity(actor, actor.id);
  assert.ok(after.ok);
  assert.equal(after.value.mfaEnrolled, false);
});

test("console: a registration body that is not a credential is a 400, not a crash", async () => {
  const h = harness();
  const { sessionId } = await h.organization("acme", { factor: false });
  const notJson = await routeConsole(
    request("POST", CONSOLE_PATHS.webauthnFinish, { sessionId, contentType: "application/json", body: "not json" }),
    h.service,
  );
  assert.equal(notJson.status, 400);

  const noCredential = await routeConsole(
    request("POST", CONSOLE_PATHS.webauthnFinish, { sessionId, contentType: "application/json", body: JSON.stringify({ challengeId: "x" }) }),
    h.service,
  );
  assert.equal(noCredential.status, 400);
  assert.match(noCredential.body, /credential is required/);
});

/* -------------------------------------------------------------------------- */
/*  Signing out                                                               */
/* -------------------------------------------------------------------------- */

test("console: signing out ends the session and revokes the tokens it minted", async () => {
  const h = harness();
  const { sessionId, actor } = await h.organization("acme");

  // Three tokens for this session, as a client that fetched one per call would have.
  for (let index = 0; index < 3; index += 1) {
    const token: AccessTokenRecord = {
      tokenHash: `hash-${index}`,
      organizationId: actor.organizationId,
      clientId: "client-1",
      identityId: actor.id,
      sessionId,
      scopes: ["openid"],
      issuedAt: h.nowMs(),
      expiresAt: h.nowMs() + 3_600_000,
      revokedAt: null,
    };
    await h.tokens.insertToken(token);
  }

  const response = await routeConsole(request("POST", CONSOLE_PATHS.logout, { sessionId, body: "" }), h.service);
  assert.equal(response.status, 200);
  assert.match(response.body, /Signed out/);
  assert.match(response.body, /revoked/);
  // The cookie is expired as part of the answer: a live session id would just be sent
  // again by the browser.
  assert.match(response.headers["set-cookie"] ?? "", new RegExp(`^${CONSOLE_SESSION_COOKIE}=;`));

  const session = await h.spine.checkSession(actor.organizationId, sessionId);
  assert.equal(session.active, false);
  assert.match(session.reason, /revoked/);

  for (let index = 0; index < 3; index += 1) {
    const token = await h.tokens.findToken(`hash-${index}`);
    assert.ok(token?.revokedAt);
  }

  // And the cookie is worthless afterwards, which is the point of signing out.
  const afterwards = await routeConsole(request("GET", CONSOLE_PATHS.home, { sessionId }), h.service);
  assert.equal(afterwards.status, 303);
  assert.equal(afterwards.headers.location, CONSOLE_PATHS.signIn);
});

test("console: signing out of one session leaves another of the same identity alone", async () => {
  const h = harness();
  const { sessionId, actor } = await h.organization("acme");
  const second = await h.spine.issueSession(actor.organizationId, actor.id);
  assert.ok(second.ok);

  await routeConsole(request("POST", CONSOLE_PATHS.logout, { sessionId, body: "" }), h.service);
  const other = await h.spine.checkSession(actor.organizationId, second.value.id);
  assert.equal(other.active, true);
});

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                 */
/* -------------------------------------------------------------------------- */

test("console: somebody else's text is escaped, not rendered", async () => {
  const h = harness();
  const { actor } = await h.organization("acme", { factor: false });
  const created = await h.spine.createIdentity(actor, {
    identifier: "script@acme.test",
    displayName: '<script>alert("x")</script>',
    role: "AGENT",
  });
  assert.ok(created.ok, created.ok ? "" : created.error);
  const target: IdentityActor = { id: created.value.id, organizationId: actor.organizationId, role: "AGENT" };
  assert.ok((await h.spine.setMfaEnrolled(actor, target.id, true)).ok);
  const session = await h.spine.issueSession(target.organizationId, target.id);
  assert.ok(session.ok, session.ok ? "" : session.error);

  // The display name is rendered in the page header, so this is the real thing: an
  // identity whose name is markup.
  const page = await routeConsole(request("GET", CONSOLE_PATHS.home, { sessionId: session.value.id }), h.service);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.body, /<script>alert/);
  assert.match(page.body, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);

  // A factor's label is escaped the same way.
  const label = '<img src=x onerror="alert(1)">';
  const begun = await h.mfa.beginEnrollment(target, target.id, { label });
  assert.ok(begun.ok, begun.ok ? "" : begun.error);
  const factorPage = await routeConsole(
    request("GET", CONSOLE_PATHS.mfa, { sessionId: session.value.id }),
    h.service,
  );
  assert.doesNotMatch(factorPage.body, /<img src=x/);
  assert.match(factorPage.body, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("console: a service identity gets its own page, minus an evidence section it may not read", async () => {
  const h = harness();
  const { actor } = await h.organization("acme");
  const created = await h.spine.createIdentity(actor, { identifier: "svc@acme.test", displayName: "Service", role: "SERVICE" });
  assert.ok(created.ok, created.ok ? "" : created.error);
  const service: IdentityActor = { id: created.value.id, organizationId: actor.organizationId, role: "SERVICE" };

  const begun = await h.mfa.beginEnrollment(actor, service.id);
  assert.ok(begun.ok, begun.ok ? "" : begun.error);
  assert.ok((await h.mfa.confirmEnrollment(actor, service.id, codeFor(begun.value.secret, h.nowMs()))).ok);
  const session = await h.spine.issueSession(service.organizationId, service.id);
  assert.ok(session.ok, session.ok ? "" : session.error);

  const page = await routeConsole(request("GET", CONSOLE_PATHS.home, { sessionId: session.value.id }), h.service);
  // A 200 with the state it owns, rather than a refusal that would hide the fact that
  // its second factor is enrolled. The trail is a directory read it does not have.
  assert.equal(page.status, 200);
  assert.match(page.body, /svc@acme\.test/);
  assert.match(page.body, /access to the audit trail/);
  assert.doesNotMatch(page.body, /organization\.create/);
});
