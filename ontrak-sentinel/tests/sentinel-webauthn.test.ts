/**
 * OnTrak Sentinel S1 tests: WebAuthn security keys as a second factor.
 *
 * The claims in a WebAuthn ceremony are cheap to assert and expensive to get right,
 * so each test here follows one of the ways a verifier can be *convinced* by
 * something other than a real ceremony:
 *
 *  - the wrong origin (a page somewhere else asking for a key bound to us);
 *  - the wrong challenge, or the same challenge twice (a captured ceremony, replayed);
 *  - a key created for a different relying party (a registration borrowed from
 *    another site);
 *  - an assertion replayed as a registration, or a signature over other bytes;
 *  - a signature counter that went backwards (one key, two copies);
 *  - and an attestation certificate this deployment never agreed to trust.
 *
 * The fixtures are real: an EC key pair is generated, the authenticator data is
 * assembled byte by byte and signed with `node:crypto`, so the only reason a
 * ceremony verifies is that `webauthn-rules.ts` checked it. See
 * `tests/webauthn-fixtures.ts`.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import { sha256Hex } from "../src/lib/hash";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog, type IdentityActor } from "../src/lib/identity-service";
import { MemoryMfaStore, MfaService, type MfaIds } from "../src/lib/mfa-service";
import {
  SUPPORTED_ALGORITHMS,
  base64UrlDecode,
  base64UrlEncode,
  cborDecode,
  cborEncode,
  parseCosePublicKey,
  parseStoredPublicKey,
  rpIdMatchesOrigin,
  validateWebAuthnConfig,
  verifyAssertion,
  verifyRegistration,
  type CborValue,
  type WebAuthnChallengeRecord,
} from "../src/lib/webauthn-rules";
import {
  MemoryWebAuthnChallengeStore,
  systemWebAuthnCrypto,
  WebAuthnService,
  type WebAuthnIds,
} from "../src/lib/webauthn-service";
import { createFixtureAuthenticator, packedSelfAttestation } from "./webauthn-fixtures";

const sha256: HashFn = sha256Hex;
const CRYPTO = systemWebAuthnCrypto();
const RP_ID = "id.sentinel.test";
const ORIGIN = "https://id.sentinel.test";

let harnessSeq = 0;

function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  let clock = Date.parse("2026-10-15T09:00:00.000Z");
  let n = 0;
  const scope = `w${++harnessSeq}`;

  const spine = new IdentityService(identities, audit, {
    id: () => `${scope}-id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  });
  const factors = new MemoryMfaStore();
  const challenges = new MemoryWebAuthnChallengeStore();
  const ids: WebAuthnIds = {
    id: () => `${scope}-challenge-${++n}`,
    challenge: () => base64UrlEncode(Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + n) % 256)),
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };
  const mfaIds: MfaIds = { ...ids, secret: () => "JBSWY3DPEHPK3PXP" };
  const mfa = new MfaService(factors, spine, audit, mfaIds);
  const webauthn = new WebAuthnService(factors, challenges, spine, { rpId: RP_ID, rpName: "OnTrak Sentinel", origin: ORIGIN }, audit, ids, CRYPTO);

  return {
    audit,
    spine,
    mfa,
    webauthn,
    store: factors,
    challenges,
    advance(ms: number) {
      clock += ms;
    },
    async organization(slug: string, admin: string) {
      const created = await spine.bootstrapOrganization("test", { name: slug, slug }, { identifier: admin, displayName: admin });
      assert.ok(created.ok, created.ok ? "" : created.error);
      const actor: IdentityActor = { id: created.value.admin.id, organizationId: created.value.organization.id, role: "ADMIN" };
      return { actor, admin: created.value.admin };
    },
  };
}

/** A challenge record as the service mints one, for the rules-only tests. */
function challengeRecord(overrides: Partial<WebAuthnChallengeRecord> = {}): WebAuthnChallengeRecord {
  return {
    id: "challenge-1",
    organizationId: "org-1",
    identityId: "identity-1",
    ceremony: "REGISTRATION",
    challenge: "Y2hhbGxlbmdlLWJ5dGVzLWZvci10aGUtdGVzdA",
    origin: ORIGIN,
    rpId: RP_ID,
    createdAt: 0,
    expiresAt: 120_000,
    usedAt: null,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  CBOR                                                                      */
/* -------------------------------------------------------------------------- */

test("webauthn: the CBOR reader round-trips what the writer produces", () => {
  const value = new Map<CborValue, CborValue>([
    ["fmt", "none"],
    ["attStmt", new Map<CborValue, CborValue>()],
    ["authData", Uint8Array.from([0, 1, 2, 250])],
    ["count", 300],
    ["negative", -7],
    ["flags", [true, false, null]],
  ]);
  const decoded = cborDecode(cborEncode(value));
  assert.ok(decoded instanceof Map);
  assert.equal(decoded.get("fmt"), "none");
  assert.equal(decoded.get("count"), 300);
  assert.equal(decoded.get("negative"), -7);
  assert.deepEqual([...(decoded.get("authData") as Uint8Array)], [0, 1, 2, 250]);
  assert.deepEqual(decoded.get("flags"), [true, false, null]);
});

test("webauthn: a truncated CBOR item is refused rather than half-read", () => {
  // A four-byte byte string announced, with two bytes present.
  assert.equal(cborDecode(Uint8Array.from([0x44, 0x01, 0x02])), undefined);
  assert.equal(cborDecode(Uint8Array.from([0xf8])), undefined);
});

test("webauthn: base64url survives the round trip and refuses impossible lengths", () => {
  const bytes = Uint8Array.from([251, 255, 0, 17, 42]);
  assert.deepEqual([...base64UrlDecode(base64UrlEncode(bytes))!], [...bytes]);
  assert.equal(base64UrlDecode("A"), null);
  assert.equal(base64UrlDecode("not a value!"), null);
});

/* -------------------------------------------------------------------------- */
/*  Registration                                                              */
/* -------------------------------------------------------------------------- */

test("webauthn: a real registration verifies and yields the key to store", () => {
  const authenticator = createFixtureAuthenticator();
  const challenge = challengeRecord();
  const result = verifyRegistration({
    response: authenticator.register({ challenge: challenge.challenge, origin: ORIGIN, rpId: RP_ID }),
    challenge,
    crypto: CRYPTO,
  });

  assert.equal(result.reason, null);
  assert.ok(result.ok, result.reason ?? "");
  assert.equal(result.credential?.credentialId, authenticator.credentialId);
  assert.equal(result.credential?.signCount, 0);
  assert.deepEqual(result.credential?.transports, ["usb"]);
  const stored = parseStoredPublicKey(result.credential!.publicKey);
  assert.ok(stored);
  assert.equal(stored.kty, "EC");
  assert.deepEqual([...(SUPPORTED_ALGORITHMS as readonly number[])], [-7, -257]);
});

test("webauthn: a registration from another origin is refused", () => {
  const authenticator = createFixtureAuthenticator();
  const challenge = challengeRecord();
  const result = verifyRegistration({
    response: authenticator.register({ challenge: challenge.challenge, origin: "https://id.sentinel.test.evil.test", rpId: RP_ID }),
    challenge,
    crypto: CRYPTO,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /different origin|relying party/);
});

test("webauthn: a registration for another relying party is refused even from our origin", () => {
  const authenticator = createFixtureAuthenticator();
  const challenge = challengeRecord();
  const result = verifyRegistration({
    response: authenticator.register({ challenge: challenge.challenge, origin: ORIGIN, rpId: "evil.test" }),
    challenge,
    crypto: CRYPTO,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /different relying party/);
});

test("webauthn: a registration answering the wrong challenge is refused", () => {
  const authenticator = createFixtureAuthenticator();
  const challenge = challengeRecord();
  const result = verifyRegistration({
    response: authenticator.register({ challenge: "some-other-challenge", origin: ORIGIN, rpId: RP_ID }),
    challenge,
    crypto: CRYPTO,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /challenge does not match/);
});

test("webauthn: an assertion cannot be posted as a registration", () => {
  const authenticator = createFixtureAuthenticator();
  const challenge = challengeRecord();
  const result = verifyRegistration({
    response: {
      type: "public-key",
      id: authenticator.credentialId,
      clientDataJSON: Buffer.from(
        JSON.stringify({ type: "webauthn.get", challenge: challenge.challenge, origin: ORIGIN }),
        "utf8",
      )
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
      attestationObject: authenticator.register({ challenge: challenge.challenge, origin: ORIGIN, rpId: RP_ID }).attestationObject,
    },
    challenge,
    crypto: CRYPTO,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /not a registration/);
});

test("webauthn: a packed self-attestation verifies, and a certificate-backed one is refused by name", () => {
  const authenticator = createFixtureAuthenticator();
  const challenge = challengeRecord();
  const selfAttested = packedSelfAttestation(authenticator, { challenge: challenge.challenge, origin: ORIGIN, rpId: RP_ID });
  const verified = verifyRegistration({ response: selfAttested, challenge, crypto: CRYPTO });
  assert.equal(verified.reason, null);
  assert.ok(verified.ok, verified.reason ?? "");

  // The same ceremony, with an `x5c` chain bolted on: we do not judge provenance.
  const core = cborDecode(base64UrlDecode(selfAttested.attestationObject)!) as Map<CborValue, CborValue>;
  const encoded = cborEncode(
    new Map<CborValue, CborValue>([
      ["fmt", "packed"],
      ["attStmt", new Map<CborValue, CborValue>([["alg", -7], ["sig", Uint8Array.from([1, 2, 3])], ["x5c", [Uint8Array.from([9])]]])],
      ["authData", core.get("authData") as Uint8Array],
    ]),
  );
  const refused = verifyRegistration({
    response: { ...selfAttested, attestationObject: base64UrlEncode(encoded) },
    challenge,
    crypto: CRYPTO,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? "", /certificate-backed attestation/);
});

test("webauthn: an unsupported COSE algorithm is refused where it is read", () => {
  const unsupported = parseCosePublicKey(
    new Map<CborValue, CborValue>([
      [1, 2],
      [3, -8], // EdDSA: real, and not one this provider verifies
      [-1, 1],
      [-2, Uint8Array.from([1])],
      [-3, Uint8Array.from([2])],
    ]),
  );
  assert.equal(unsupported.ok, false);

  const supported = parseCosePublicKey(
    new Map<CborValue, CborValue>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Uint8Array.from([1, 2])],
      [-3, Uint8Array.from([3, 4])],
    ]),
  );
  assert.ok(supported.ok);
  assert.equal(supported.ok && supported.key.kty, "EC");
});

/* -------------------------------------------------------------------------- */
/*  Assertion                                                                 */
/* -------------------------------------------------------------------------- */

function assertInput(authenticator = createFixtureAuthenticator()) {
  const registration = authenticator.register({ challenge: "reg-challenge", origin: ORIGIN, rpId: RP_ID });
  const registered = verifyRegistration({ response: registration, challenge: challengeRecord({ challenge: "reg-challenge" }), crypto: CRYPTO });
  assert.ok(registered.ok, registered.reason ?? "");
  const publicKey = parseStoredPublicKey(registered.credential!.publicKey);
  assert.ok(publicKey);
  return { authenticator, publicKey, credentialId: registered.credential!.credentialId };
}

test("webauthn: a real assertion verifies and reports the new counter", () => {
  const { authenticator, publicKey, credentialId } = assertInput();
  const challenge = challengeRecord({ ceremony: "AUTHENTICATION", challenge: "auth-challenge" });
  const response = authenticator.assert({ challenge: challenge.challenge, origin: ORIGIN, rpId: RP_ID, signCount: 7 });

  const result = verifyAssertion({
    response,
    challenge,
    stored: { credentialId, publicKey, signCount: 6 },
    crypto: CRYPTO,
  });
  assert.equal(result.reason, null);
  assert.ok(result.ok, result.reason ?? "");
  assert.equal(result.signCount, 7);
});

test("webauthn: an assertion whose signature covers other bytes is refused", () => {
  const { authenticator, publicKey, credentialId } = assertInput();
  const challenge = challengeRecord({ ceremony: "AUTHENTICATION", challenge: "auth-challenge" });
  const response = authenticator.assert({ challenge: challenge.challenge, origin: ORIGIN, rpId: RP_ID, signCount: 1 });
  // Swap the authenticator data for a different one, keeping a valid signature.
  const other = authenticator.assert({ challenge: challenge.challenge, origin: ORIGIN, rpId: "evil.test", signCount: 9 });

  const result = verifyAssertion({
    response: { ...response, authenticatorData: other.authenticatorData },
    challenge,
    stored: { credentialId, publicKey, signCount: 0 },
    crypto: CRYPTO,
  });
  assert.equal(result.ok, false);
});

test("webauthn: a counter that did not advance reads as a cloned key", () => {
  const { authenticator, publicKey, credentialId } = assertInput();
  const challenge = challengeRecord({ ceremony: "AUTHENTICATION", challenge: "auth-challenge" });
  const response = authenticator.assert({ challenge: challenge.challenge, origin: ORIGIN, rpId: RP_ID, signCount: 4 });

  const result = verifyAssertion({
    response,
    challenge,
    stored: { credentialId, publicKey, signCount: 9 },
    crypto: CRYPTO,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /cloned/);
});

test("webauthn: an authenticator that reports no counter is not treated as cloned", () => {
  const { authenticator, publicKey, credentialId } = assertInput();
  const challenge = challengeRecord({ ceremony: "AUTHENTICATION", challenge: "auth-challenge" });
  const response = authenticator.assert({ challenge: challenge.challenge, origin: ORIGIN, rpId: RP_ID, signCount: 0 });

  const result = verifyAssertion({ response, challenge, stored: { credentialId, publicKey, signCount: 0 }, crypto: CRYPTO });
  assert.ok(result.ok, result.reason ?? "");
});

test("webauthn: a challenge minted for a registration cannot answer an assertion", () => {
  const { authenticator, publicKey, credentialId } = assertInput();
  const challenge = challengeRecord({ ceremony: "REGISTRATION", challenge: "auth-challenge" });
  const result = verifyAssertion({
    response: authenticator.assert({ challenge: challenge.challenge, origin: ORIGIN, rpId: RP_ID, signCount: 1 }),
    challenge,
    stored: { credentialId, publicKey, signCount: 0 },
    crypto: CRYPTO,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /not started as an assertion/);
});

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

test("webauthn: an RP ID that does not cover its origin is a configuration error, not a browser mystery", () => {
  assert.equal(rpIdMatchesOrigin("sentinel.test", "https://id.sentinel.test"), true);
  assert.equal(rpIdMatchesOrigin("id.sentinel.test", "https://id.sentinel.test"), true);
  assert.equal(rpIdMatchesOrigin("sentinel.test", "https://id.sentinel.test.evil.test"), false);
  assert.equal(rpIdMatchesOrigin("", "https://id.sentinel.test"), false);

  const issues = validateWebAuthnConfig({ rpId: "https://id.sentinel.test", origin: ORIGIN, rpName: "Sentinel" });
  assert.ok(issues.length >= 1);
  assert.match(issues[0].message, /no scheme/);
  assert.deepEqual(validateWebAuthnConfig({ rpId: RP_ID, origin: ORIGIN, rpName: "Sentinel" }), []);
});

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

test("webauthn: a service with a mismatched RP ID refuses to construct", () => {
  const h = harness();
  assert.throws(
    () =>
      new WebAuthnService(
        h.store,
        h.challenges,
        h.spine,
        { rpId: "elsewhere.test", rpName: "Sentinel", origin: ORIGIN },
        null,
      ),
    /misconfigured/,
  );
});

test("webauthn: enrollment is self-service — an agent registers a key on their own identity", async () => {
  const h = harness();
  const { actor } = await h.organization("acme", "admin@acme.test");
  const created = await h.spine.createIdentity(actor, { identifier: "agent@acme.test", displayName: "Agent", role: "AGENT" });
  assert.ok(created.ok, created.ok ? "" : created.error);
  const agent: IdentityActor = { id: created.value.id, organizationId: actor.organizationId, role: "AGENT" };

  const options = await h.webauthn.registrationOptions(agent, agent.id);
  assert.ok(options.ok, options.ok ? "" : options.error);
  assert.equal(options.value.rp.id, RP_ID);
  assert.equal(options.value.attestation, "none");
  assert.equal(options.value.pubKeyCredParams.length, 2);
  assert.equal(options.value.user.name, "agent@acme.test");

  const authenticator = createFixtureAuthenticator();
  const finished = await h.webauthn.finishRegistration(agent, agent.id, options.value.challengeId, {
    response: authenticator.register({ challenge: options.value.challenge, origin: ORIGIN, rpId: RP_ID }),
  });
  assert.ok(finished.ok, finished.ok ? "" : finished.error);
  assert.equal(finished.value.credential.credentialId, authenticator.credentialId);

  const identity = await h.spine.identity(agent, agent.id);
  assert.ok(identity.ok);
  assert.equal(identity.value.mfaEnrolled, true);

  // The policy is satisfied by the key alone: a session is now issued. This is the
  // S0 refusal that used to be a dead end — nothing could set the flag by proving
  // anything — now satisfiable by the person themselves.
  const session = await h.spine.issueSession(agent.organizationId, agent.id);
  assert.ok(session.ok, session.ok ? "" : session.error);
});

test("webauthn: an agent cannot register a key on somebody else's identity", async () => {
  const h = harness();
  const { actor, admin } = await h.organization("acme", "admin@acme.test");
  const created = await h.spine.createIdentity(actor, { identifier: "agent@acme.test", displayName: "Agent", role: "AGENT" });
  assert.ok(created.ok, created.ok ? "" : created.error);
  const agent: IdentityActor = { id: created.value.id, organizationId: actor.organizationId, role: "AGENT" };

  const options = await h.webauthn.registrationOptions(agent, admin.id);
  assert.equal(options.ok, false);
  assert.match(options.ok ? "" : options.error, /administer identities/);
});

test("webauthn: a registered key signs in, and the counter is written back", async () => {
  const h = harness();
  const { actor } = await h.organization("acme", "admin@acme.test");
  const authenticator = createFixtureAuthenticator();

  const options = await h.webauthn.registrationOptions(actor, actor.id);
  assert.ok(options.ok, options.ok ? "" : options.error);
  const registration = authenticator.register({ challenge: options.value.challenge, origin: ORIGIN, rpId: RP_ID, signCount: 3 });
  const finished = await h.webauthn.finishRegistration(actor, actor.id, options.value.challengeId, { response: registration });
  assert.ok(finished.ok, finished.ok ? "" : finished.error);

  const assertionOptions = await h.webauthn.authenticationOptions({ organizationId: actor.organizationId, identityId: actor.id });
  assert.ok(assertionOptions.ok, assertionOptions.ok ? "" : assertionOptions.error);
  assert.deepEqual(assertionOptions.value.allowCredentials, [{ type: "public-key", id: authenticator.credentialId }]);

  const assertion = authenticator.assert({
    challenge: assertionOptions.value.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
    signCount: 4,
  });
  const verified = await h.webauthn.finishAuthentication({
    organizationId: actor.organizationId,
    identityId: actor.id,
    challengeId: assertionOptions.value.challengeId,
    response: assertion,
  });
  assert.equal(verified.reason, null);
  assert.ok(verified.ok, verified.reason ?? "");

  const factor = await h.store.findFactor(actor.organizationId, actor.id, "WEBAUTHN");
  assert.equal(factor?.signCount, 4);
  assert.ok(factor?.lastUsedAt);

  const trail = h.audit.trail(actor.organizationId).map((event) => event.action);
  assert.ok(trail.includes("mfa.webauthn.register"));
  assert.ok(trail.includes("mfa.webauthn.ok"));
  assert.equal(h.audit.verify(actor.organizationId).ok, true);
});

test("webauthn: one challenge answers one assertion", async () => {
  const h = harness();
  const { actor } = await h.organization("acme", "admin@acme.test");
  const authenticator = createFixtureAuthenticator();
  const options = await h.webauthn.registrationOptions(actor, actor.id);
  assert.ok(options.ok);
  await h.webauthn.finishRegistration(actor, actor.id, options.value.challengeId, {
    response: authenticator.register({ challenge: options.value.challenge, origin: ORIGIN, rpId: RP_ID }),
  });

  const first = await h.webauthn.authenticationOptions({ organizationId: actor.organizationId, identityId: actor.id });
  assert.ok(first.ok);
  const assertion = authenticator.assert({ challenge: first.value.challenge, origin: ORIGIN, rpId: RP_ID, signCount: 1 });
  const accepted = await h.webauthn.finishAuthentication({
    organizationId: actor.organizationId,
    identityId: actor.id,
    challengeId: first.value.challengeId,
    response: assertion,
  });
  assert.ok(accepted.ok, accepted.reason ?? "");

  const replayed = await h.webauthn.finishAuthentication({
    organizationId: actor.organizationId,
    identityId: actor.id,
    challengeId: first.value.challengeId,
    response: assertion,
  });
  assert.equal(replayed.ok, false);
  assert.match(replayed.reason ?? "", /already been used or has expired/);
});

test("webauthn: a registration ceremony cannot be replayed after its challenge expires", async () => {
  const h = harness();
  const { actor } = await h.organization("acme", "admin@acme.test");
  const authenticator = createFixtureAuthenticator();
  const options = await h.webauthn.registrationOptions(actor, actor.id);
  assert.ok(options.ok, options.ok ? "" : options.error);
  const response = authenticator.register({ challenge: options.value.challenge, origin: ORIGIN, rpId: RP_ID });

  // Two minutes plus a second: long enough for a person to tap a key, and past the
  // window on purpose.
  h.advance(121_000);
  const finished = await h.webauthn.finishRegistration(actor, actor.id, options.value.challengeId, { response });
  assert.equal(finished.ok, false);
  assert.match(finished.ok ? "" : finished.error, /already been used or has expired/);
});

test("webauthn: a second ceremony supersedes a pending challenge, so a reload is not a dead end", async () => {
  const h = harness();
  const { actor } = await h.organization("acme", "admin@acme.test");
  const authenticator = createFixtureAuthenticator();
  const first = await h.webauthn.registrationOptions(actor, actor.id);
  assert.ok(first.ok);
  const second = await h.webauthn.registrationOptions(actor, actor.id);
  assert.ok(second.ok);
  assert.notEqual(first.value.challengeId, second.value.challengeId);

  const stale = await h.webauthn.finishRegistration(actor, actor.id, first.value.challengeId, {
    response: authenticator.register({ challenge: first.value.challenge, origin: ORIGIN, rpId: RP_ID }),
  });
  assert.equal(stale.ok, false);

  const fresh = await h.webauthn.finishRegistration(actor, actor.id, second.value.challengeId, {
    response: authenticator.register({ challenge: second.value.challenge, origin: ORIGIN, rpId: RP_ID }),
  });
  assert.ok(fresh.ok, fresh.ok ? "" : fresh.error);
});

test("webauthn: another organization's key does not answer here", async () => {
  const h = harness();
  const acme = await h.organization("acme", "admin@acme.test");
  const other = await h.organization("other", "admin@other.test");
  const authenticator = createFixtureAuthenticator();

  const options = await h.webauthn.registrationOptions(acme.actor, acme.actor.id);
  assert.ok(options.ok);
  await h.webauthn.finishRegistration(acme.actor, acme.actor.id, options.value.challengeId, {
    response: authenticator.register({ challenge: options.value.challenge, origin: ORIGIN, rpId: RP_ID }),
  });

  const assertionOptions = await h.webauthn.authenticationOptions({
    organizationId: other.actor.organizationId,
    identityId: other.actor.id,
  });
  assert.equal(assertionOptions.ok, false);

  // And the registered credential is invisible from the other tenant: the query is
  // scoped by organization, so the same identity id returns nothing there.
  const listed = await h.webauthn.credentials(other.actor, acme.actor.id);
  assert.ok(listed.ok, listed.ok ? "" : listed.error);
  assert.deepEqual(listed.value, []);
  const mine = await h.webauthn.credentials(acme.actor, acme.actor.id);
  assert.ok(mine.ok);
  assert.equal(mine.value.length, 1);
});

test("webauthn: removing a key clears the flag only when no confirmed factor remains", async () => {
  const h = harness();
  const { actor } = await h.organization("acme", "admin@acme.test");
  const authenticator = createFixtureAuthenticator();

  const options = await h.webauthn.registrationOptions(actor, actor.id);
  assert.ok(options.ok);
  await h.webauthn.finishRegistration(actor, actor.id, options.value.challengeId, {
    response: authenticator.register({ challenge: options.value.challenge, origin: ORIGIN, rpId: RP_ID }),
  });

  const removed = await h.webauthn.removeCredential(actor, actor.id, authenticator.credentialId);
  assert.ok(removed.ok, removed.ok ? "" : removed.error);
  assert.equal(removed.value.removed, 1);
  assert.equal(removed.value.stillEnrolled, false);
  const identity = await h.spine.identity(actor, actor.id);
  assert.ok(identity.ok);
  assert.equal(identity.value.mfaEnrolled, false);

  // A second key and an authenticator app: removing one key must not claim the
  // identity owes no second factor, or its next sign-in is refused while a working
  // factor sits in its pocket.
  const again = await h.webauthn.registrationOptions(actor, actor.id);
  assert.ok(again.ok);
  const second = createFixtureAuthenticator();
  await h.webauthn.finishRegistration(actor, actor.id, again.value.challengeId, {
    response: second.register({ challenge: again.value.challenge, origin: ORIGIN, rpId: RP_ID }),
  });
  const app = await h.mfa.beginEnrollment(actor, actor.id);
  assert.ok(app.ok);

  const kept = await h.webauthn.removeCredential(actor, actor.id, second.credentialId);
  assert.ok(kept.ok, kept.ok ? "" : kept.error);
  // The TOTP enrollment is still pending, so nothing confirmed is left either — the
  // flag has to follow the confirmed facts, not the row count.
  assert.equal(kept.value.stillEnrolled, false);
});

test("webauthn: an identity with no key is told so, rather than handed an unusable prompt", async () => {
  const h = harness();
  const { actor } = await h.organization("acme", "admin@acme.test");
  const options = await h.webauthn.authenticationOptions({ organizationId: actor.organizationId, identityId: actor.id });
  assert.equal(options.ok, false);
  assert.match(options.ok ? "" : options.error, /No security key/);
});

test("webauthn: the audit trail records every refusal with its reason", async () => {
  const h = harness();
  const { actor } = await h.organization("acme", "admin@acme.test");
  const authenticator = createFixtureAuthenticator();
  const options = await h.webauthn.registrationOptions(actor, actor.id);
  assert.ok(options.ok);

  const refused = await h.webauthn.finishRegistration(actor, actor.id, options.value.challengeId, {
    response: {
      ...authenticator.register({ challenge: options.value.challenge, origin: ORIGIN, rpId: RP_ID }),
      clientDataJSON: base64UrlEncode(
        Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.value.challenge, origin: "https://elsewhere.test" }), "utf8"),
      ),
    },
  });
  assert.equal(refused.ok, false);

  const refusals = h.audit.trail(actor.organizationId).filter((event) => event.action === "mfa.webauthn.refuse");
  assert.equal(refusals.length, 1);
  assert.match(String((refusals[0].detail as { reason?: string }).reason), /different origin/);
  assert.equal(h.audit.verify(actor.organizationId).ok, true);
});
