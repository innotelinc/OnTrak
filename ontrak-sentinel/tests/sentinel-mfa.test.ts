/**
 * OnTrak Sentinel S1 tests: TOTP second factors.
 *
 * S0's session policy already refused a session to an identity that had not
 * enrolled a second factor — with nothing in the product able to enroll one. Each
 * test here follows one of the ways that dead end can be "fixed" wrongly:
 *
 *  - flipping `mfaEnrolled` without a confirmed factor (the checkbox, rather than
 *    the factor), which is why the flag is only ever set from a verified code;
 *  - accepting a code that has already been spent inside its own window, which
 *    makes a captured code as good as the password it was meant to strengthen;
 *  - accepting a code from an arbitrary distance away, which turns six digits into
 *    a lottery;
 *  - and a factor that belongs to one organization answering for another.
 *
 * The arithmetic itself is pinned to the RFC 6238 §Appendix B vectors, because a
 * TOTP implementation that is merely self-consistent is one that agrees with
 * itself and nobody's phone.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sha256Hex } from "../src/lib/hash";
import type { HashFn } from "../src/lib/audit-chain";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog, type IdentityActor } from "../src/lib/identity-service";
import { sessionDecision } from "../src/lib/identity-rules";
import {
  TOTP_DRIFT_STEPS,
  base32Decode,
  base32Encode,
  formatTotpSecret,
  normalizeTotpCode,
  otpauthUri,
  totpCode,
  totpCounter,
  verifyTotp,
} from "../src/lib/mfa-rules";
import { MemoryMfaStore, MfaService, systemTotpSigner, type MfaIds } from "../src/lib/mfa-service";

const sha256: HashFn = sha256Hex;

/** RFC 6238's ASCII test secret, in base32 — the value the vectors are computed from. */
const RFC_SECRET_ASCII = "12345678901234567890";
const RFC_SECRET = base32Encode(Buffer.from(RFC_SECRET_ASCII, "ascii"));
const SIGNER = systemTotpSigner();

/** The code an authenticator app would show for this secret at this instant. */
function codeAt(secret: string, atMs: number, digits = 6): string {
  const bytes = base32Decode(secret);
  assert.ok(bytes, "the test secret should decode");
  return totpCode(bytes, totpCounter(atMs), SIGNER, digits);
}

let harnessSeq = 0;

function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  let clock = Date.parse("2026-10-01T09:00:00.000Z");
  let n = 0;
  const scope = `m${++harnessSeq}`;

  const spine = new IdentityService(identities, audit, {
    id: () => `${scope}-id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  });

  // A fixed secret, so a test can compute the code the "phone" would show.
  const mfaIds: MfaIds = {
    id: () => `${scope}-factor-${++n}`,
    secret: () => RFC_SECRET,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };
  const store = new MemoryMfaStore();
  const mfa = new MfaService(store, spine, audit, mfaIds, SIGNER, "Sentinel test");

  return {
    spine,
    audit,
    store,
    mfa,
    now: () => clock,
    setClock: (ms: number) => {
      clock = ms;
    },
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
    /**
     * The code the "phone" shows at the harness's own instant.
     *
     * The service reads the clock it was given, not `Date.now()`, so a test that
     * computed its code from the wall clock would be testing a different second.
     */
    code: (offsetSeconds = 0) => codeAt(RFC_SECRET, clock + offsetSeconds * 1000),
  };
}

async function organization() {
  const h = harness();
  const created = await h.spine.bootstrapOrganization(
    "test",
    { name: "Acme", slug: `acme-${++harnessSeq}` },
    { identifier: `admin-${harnessSeq}@acme.test`, displayName: "Admin" },
  );
  assert.ok(created.ok, created.ok ? "" : created.error);
  const actor: IdentityActor = {
    id: created.value.admin.id,
    organizationId: created.value.organization.id,
    role: "ADMIN",
  };
  return { ...h, actor, organizationId: actor.organizationId };
}

/* -------------------------------------------------------------------------- */
/*  The arithmetic                                                            */
/* -------------------------------------------------------------------------- */

test("TOTP: the RFC 6238 SHA-1 vectors reproduce exactly", () => {
  // Eight digits, because that is how the RFC prints them. If this fails, the
  // implementation agrees with itself and with nobody's authenticator app.
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  const bytes = base32Decode(RFC_SECRET);
  assert.ok(bytes);
  for (const [seconds, expected] of vectors) {
    assert.equal(totpCode(bytes, totpCounter(seconds * 1000), SIGNER, 8), expected, `T=${seconds}`);
  }
});

test("base32: round-trips, and accepts the spellings other tools produce", () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const encoded = base32Encode(bytes);
  assert.deepEqual(Array.from(base32Decode(encoded) ?? []), Array.from(bytes));

  // Lower case and padding are what a secret pasted from another system looks
  // like; refusing them would reject a working secret for a cosmetic reason.
  assert.deepEqual(Array.from(base32Decode(encoded.toLowerCase()) ?? []), Array.from(bytes));
  assert.deepEqual(Array.from(base32Decode(`${encoded}======`) ?? []), Array.from(bytes));

  assert.equal(base32Decode("not-base32-1"), null);
  assert.equal(base32Decode(""), null);
});

test("code normalisation: spaces and dashes are how a person types six digits", () => {
  assert.equal(normalizeTotpCode("123 456"), "123456");
  assert.equal(normalizeTotpCode("123-456"), "123456");
  assert.equal(normalizeTotpCode("12345"), null);
  assert.equal(normalizeTotpCode("1234567"), null);
  assert.equal(normalizeTotpCode("12345a"), null);
});

test("formatTotpSecret: groups of four, which is how a secret is read back", () => {
  assert.equal(formatTotpSecret("ABCDEFGH"), "ABCD EFGH");
});

test("otpauth URI: names the issuer twice and states the parameters", () => {
  const uri = new URL(otpauthUri({ issuer: "OnTrak Sentinel", account: "sam@acme.test", secret: RFC_SECRET }));
  assert.equal(uri.protocol, "otpauth:");
  assert.equal(uri.host, "totp");
  assert.equal(decodeURIComponent(uri.pathname.replace(/^\//, "")), "OnTrak Sentinel:sam@acme.test");
  assert.equal(uri.searchParams.get("secret"), RFC_SECRET);
  // Twice on purpose: authenticator apps disagree about which one they read.
  assert.equal(uri.searchParams.get("issuer"), "OnTrak Sentinel");
  assert.equal(uri.searchParams.get("algorithm"), "SHA1");
  assert.equal(uri.searchParams.get("digits"), "6");
  assert.equal(uri.searchParams.get("period"), "30");
});

/* -------------------------------------------------------------------------- */
/*  Verification                                                              */
/* -------------------------------------------------------------------------- */

test("verifyTotp: the current step verifies, one step of drift is tolerated, two is not", () => {
  const secret = base32Decode(RFC_SECRET);
  assert.ok(secret);
  const at = Date.parse("2026-10-01T09:00:00.000Z");

  const now = verifyTotp({ secret, code: codeAt(RFC_SECRET, at), atMs: at, signer: SIGNER });
  assert.equal(now.ok, true);
  assert.equal(now.drift, 0);

  const behind = verifyTotp({ secret, code: codeAt(RFC_SECRET, at - 30_000), atMs: at, signer: SIGNER });
  assert.equal(behind.ok, true);
  assert.equal(behind.drift, -1);

  const ahead = verifyTotp({ secret, code: codeAt(RFC_SECRET, at + 30_000), atMs: at, signer: SIGNER });
  assert.equal(ahead.ok, true);
  assert.equal(ahead.drift, 1);

  // Two steps out is where a code stops being this instant's code, and where the
  // guessing window would start to matter.
  assert.equal(TOTP_DRIFT_STEPS, 1);
  const tooOld = verifyTotp({ secret, code: codeAt(RFC_SECRET, at - 60_000), atMs: at, signer: SIGNER });
  assert.equal(tooOld.ok, false);
  assert.match(tooOld.reason ?? "", /did not match/);
});

test("verifyTotp: a shape that is not a code is refused before any comparison", () => {
  const secret = base32Decode(RFC_SECRET);
  assert.ok(secret);
  const at = Date.parse("2026-10-01T09:00:00.000Z");
  const result = verifyTotp({ secret, code: "abcdef", atMs: at, signer: SIGNER });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /digits/);
});

test("verifyTotp: a step already spent cannot be spent again", () => {
  const secret = base32Decode(RFC_SECRET);
  assert.ok(secret);
  const at = Date.parse("2026-10-01T09:00:00.000Z");
  const code = codeAt(RFC_SECRET, at);

  const first = verifyTotp({ secret, code, atMs: at, signer: SIGNER });
  assert.equal(first.ok, true);

  const replay = verifyTotp({ secret, code, atMs: at, signer: SIGNER, lastUsedCounter: first.counter });
  assert.equal(replay.ok, false);
  assert.match(replay.reason ?? "", /already been used/);
});

/* -------------------------------------------------------------------------- */
/*  Enrollment                                                                */
/* -------------------------------------------------------------------------- */

test("enrollment: the flag is set only by a code that verifies", async () => {
  const { mfa, spine, actor, organizationId, code } = await organization();

  // The policy from S0: a session is refused while no second factor is enrolled.
  const before = await spine.issueSession(organizationId, actor.id);
  assert.equal(before.ok, false);
  assert.match(before.ok ? "" : before.error, /MFA is required/);

  const begun = await mfa.beginEnrollment(actor, actor.id, { account: "admin@acme.test" });
  assert.ok(begun.ok, begun.ok ? "" : begun.error);
  assert.equal(begun.value.secret, RFC_SECRET);
  assert.match(begun.value.uri, /^otpauth:\/\/totp\//);

  // A secret exists, and the flag does not: an enrollment is not a factor.
  const pending = await mfa.status(actor, actor.id);
  assert.ok(pending.ok);
  assert.equal(pending.value.enrolled, false);
  assert.ok(pending.value.pending);
  assert.equal(pending.value.confirmed, null);

  // A wrong code is refused, and the flag stays down.
  const wrong = await mfa.confirmEnrollment(actor, actor.id, "000000");
  assert.equal(wrong.ok, false);
  const stillPending = await mfa.status(actor, actor.id);
  assert.ok(stillPending.ok);
  assert.equal(stillPending.value.enrolled, false);

  const confirmed = await mfa.confirmEnrollment(actor, actor.id, code());
  assert.ok(confirmed.ok, confirmed.ok ? "" : confirmed.error);
  assert.equal(confirmed.value.factor.confirmedAt !== null, true);

  // Now the same policy grants, because the spine's flag was set from a verified
  // factor rather than from a boolean somebody passed in.
  const after = await spine.issueSession(organizationId, actor.id);
  assert.ok(after.ok, after.ok ? "" : after.error);
});

test("enrollment: only an administrator administers factors", async () => {
  const { mfa, spine, actor, organizationId, code } = await organization();

  const agent = await spine.createIdentity(actor, {
    identifier: "sam@acme.test",
    displayName: "Sam Agent",
    kind: "HUMAN",
    role: "AGENT",
  });
  assert.ok(agent.ok, agent.ok ? "" : agent.error);
  const asAgent: IdentityActor = { id: agent.value.id, organizationId, role: "AGENT" };

  // Enrollment is an administrator's act in v1 — S0 has no "self" actor yet — and
  // the refusal is the service's, not the console's, so no caller routes around it.
  const refused = await mfa.beginEnrollment(asAgent, actor.id, { account: "admin@acme.test" });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /do not administer/);

  const begun = await mfa.beginEnrollment(actor, agent.value.id, { account: "sam@acme.test" });
  assert.ok(begun.ok, begun.ok ? "" : begun.error);
  assert.ok((await mfa.confirmEnrollment(actor, agent.value.id, code())).ok);
});

test("enrollment: starting again discards the secret nobody confirmed", async () => {
  const { mfa, actor, code } = await organization();

  const first = await mfa.beginEnrollment(actor, actor.id, { account: "admin@acme.test" });
  assert.ok(first.ok);
  const second = await mfa.beginEnrollment(actor, actor.id, { account: "admin@acme.test" });
  assert.ok(second.ok);
  assert.notEqual(second.value.factor.id, first.value.factor.id);

  // The superseded factor is gone, so a code from a secret the user was told to
  // throw away cannot confirm anything.
  const listed = await mfa.listFactors(actor, actor.id);
  assert.ok(listed.ok);
  assert.equal(listed.value.length, 1);
  assert.equal(listed.value[0].id, second.value.factor.id);

  // And a confirmed factor is not silently replaced.
  assert.ok((await mfa.confirmEnrollment(actor, actor.id, code())).ok);
  const again = await mfa.beginEnrollment(actor, actor.id, { account: "admin@acme.test" });
  assert.equal(again.ok, false);
  assert.match(again.ok ? "" : again.error, /already has a confirmed authenticator/);
});

/* -------------------------------------------------------------------------- */
/*  Verifying at the login path                                               */
/* -------------------------------------------------------------------------- */

test("verify: the login path needs no actor, and a spent code is refused", async () => {
  const { mfa, actor, organizationId, advance, code } = await organization();
  await mfa.beginEnrollment(actor, actor.id, { account: "admin@acme.test" });
  await mfa.confirmEnrollment(actor, actor.id, code());

  // The code that confirmed the enrollment was itself spent, so it cannot be
  // presented again as the first sign-in's second factor.
  const replay = await mfa.verify({ organizationId, identityId: actor.id, code: code() });
  assert.equal(replay.ok, false);
  assert.match(replay.reason ?? "", /already been used/);

  advance(30);
  const good = await mfa.verify({ organizationId, identityId: actor.id, code: code() });
  assert.equal(good.ok, true, good.reason ?? "");
  assert.equal(good.drift, 0);
  assert.ok(good.factorId);

  // And the code just spent is refused the second time.
  const twice = await mfa.verify({ organizationId, identityId: actor.id, code: code() });
  assert.equal(twice.ok, false);
});

test("verify: an identity with no confirmed factor is refused in one sentence", async () => {
  const { mfa, spine, actor, organizationId } = await organization();
  const other = await spine.createIdentity(actor, {
    identifier: "nobody@acme.test",
    displayName: "Nobody",
    kind: "HUMAN",
    role: "AGENT",
  });
  assert.ok(other.ok);

  const result = await mfa.verify({ organizationId, identityId: other.value.id, code: "123456" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no confirmed authenticator is enrolled");
  assert.equal(result.factorId, null);
});

/* -------------------------------------------------------------------------- */
/*  Lifecycle and isolation                                                   */
/* -------------------------------------------------------------------------- */

test("remove: the factor and the flag go together", async () => {
  const { mfa, spine, actor, organizationId, code } = await organization();
  await mfa.beginEnrollment(actor, actor.id, { account: "admin@acme.test" });
  await mfa.confirmEnrollment(actor, actor.id, code());
  assert.ok((await spine.issueSession(organizationId, actor.id)).ok);

  const removed = await mfa.removeEnrollment(actor, actor.id);
  assert.ok(removed.ok);
  assert.equal(removed.value.removed, 1);

  // The spine's flag is down, so the policy refuses a session again…
  const session = await spine.issueSession(organizationId, actor.id);
  assert.equal(session.ok, false);
  // …and the old code cannot verify either, because the factor is gone.
  assert.equal((await mfa.verify({ organizationId, identityId: actor.id, code: code() })).ok, false);
});

test("isolation: one organization's factor never answers for another's", async () => {
  const first = await organization();
  const second = await organization();

  await first.mfa.beginEnrollment(first.actor, first.actor.id, { account: "admin@acme.test" });
  await first.mfa.confirmEnrollment(first.actor, first.actor.id, first.code());

  // The second organization's administrator names the first's identity id. The
  // answer is the one a caller can act on: there is nothing there.
  const status = await second.mfa.status(second.actor, first.actor.id);
  assert.ok(status.ok);
  assert.equal(status.value.enrolled, false);
  assert.equal(status.value.confirmed, null);

  const verified = await second.mfa.verify({
    organizationId: second.organizationId,
    identityId: first.actor.id,
    code: first.code(),
  });
  assert.equal(verified.ok, false);
  assert.equal(verified.reason, "no confirmed authenticator is enrolled");
});

test("evidence: every enrollment, refusal and verification is on the chain", async () => {
  const { mfa, audit, actor, organizationId, advance, code } = await organization();
  await mfa.beginEnrollment(actor, actor.id, { account: "admin@acme.test" });
  await mfa.confirmEnrollment(actor, actor.id, "000000");
  advance(30);
  await mfa.confirmEnrollment(actor, actor.id, code());
  await mfa.verify({ organizationId, identityId: actor.id, code: "111111" });

  const actions = audit.trail(organizationId).map((event) => event.action);
  assert.ok(actions.includes("mfa.enroll.begin"));
  assert.ok(actions.includes("mfa.enroll.refuse"));
  assert.ok(actions.includes("mfa.enroll.confirm"));
  assert.ok(actions.includes("mfa.verify.refuse"));
  // The flag flip is the spine's own event, not a second copy of this service's.
  assert.ok(actions.includes("identity.mfa.enroll"));

  // And nothing on the chain carries the secret.
  const serialized = JSON.stringify(audit.trail(organizationId));
  assert.equal(serialized.includes(RFC_SECRET), false);

  const verified = audit.verify(organizationId);
  assert.equal(verified.ok, true);
});

test("the policy still reads one flag, and the flag is the spine's", async () => {
  const { mfa, actor, organizationId, code } = await organization();
  await mfa.beginEnrollment(actor, actor.id, { account: "admin@acme.test" });
  await mfa.confirmEnrollment(actor, actor.id, code());

  const session = await mfa.status(actor, actor.id);
  assert.ok(session.ok);
  // `sessionDecision` is the one place the policy is asked; a confirmed factor is
  // what makes it say yes, and there is no second source of truth for it.
  assert.equal(
    sessionDecision(
      { id: actor.id, role: "ADMIN", active: true, mfaEnrolled: session.value.enrolled },
      { issuedAt: Date.now(), lastSeenAt: Date.now(), revokedAt: null },
    ).active,
    true,
  );
  assert.equal(session.value.enrolled, true);
});
