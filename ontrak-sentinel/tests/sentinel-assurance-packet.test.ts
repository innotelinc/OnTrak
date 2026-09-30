/**
 * OnTrak Sentinel S4 tests: the compliance packet, and the format it shares with Tix.
 *
 * Sentinel's roadmap set this as its next step in its own words — "define the shared
 * assurance-packet format with OnTrak Tix before either ships exports, so both are
 * compatible from the start". So the first test here is about the *format* rather than
 * about Sentinel: the version and the algorithm are asserted as literals, which means
 * the day one product changes its envelope this file fails instead of the two drifting
 * into documents a single verifier cannot read.
 *
 * The rest is the property that makes a signed packet worth anything: an edit after
 * signing is caught, an edit that somebody also recomputes the digests for is *still*
 * caught, and the three hashes keep doing their separate jobs — a later timestamp does
 * not disturb the record fingerprint, while a longer evidence chain does change the
 * content digest, because "where in history was this cut?" is part of the assertion.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ASSURANCE_ALGORITHM,
  ASSURANCE_PACKET_VERSION,
  COMPLIANCE_PACKET_KIND,
  buildCompliancePacket,
  packetVerificationReport,
  postureSummary,
  verifyCompliancePacket,
  type CompliancePacket,
  type CompliancePacketInput,
} from "../src/lib/assurance-packet";
import { assuranceSecret, hmacSigner } from "../src/lib/assurance-sign";
import { stableStringify } from "../src/lib/audit-chain";
import { sha256Hex } from "../src/lib/hash";
import { CONSOLE_PATHS, renderCompliance, type ConsoleComplianceView } from "../src/lib/console-rules";

const T0 = "2026-09-30T06:00:00.000Z";
const T1 = "2026-09-30T06:00:01.000Z";
const KEY = "packet-test-key-long-enough";
const sign = hmacSigner(KEY);

function view(overrides: Partial<ConsoleComplianceView> = {}): ConsoleComplianceView {
  return {
    actor: {
      identifier: "admin@innotel.us",
      displayName: "Admin",
      role: "ADMIN",
      organizationName: "Innotel",
      organizationSlug: "innotel",
    },
    session: { id: "session-1", issuedAt: T0, expiresAt: T1, lastSeenAt: T0 },
    generatedAt: T0,
    controls: [
      { control: "A second factor is required before a session is granted", state: "OK", detail: "All 3 scopes require one." },
      { control: "An active administrator exists", state: "OK", detail: "1 active administrator(s)." },
    ],
    roles: [
      {
        scope: "ALL",
        title: "Everyone",
        identities: 2,
        active: 2,
        mfaEnrolled: 2,
        requireMfa: true,
        maxSessionSeconds: 43200,
        idleTimeoutSeconds: 3600,
        stored: true,
      },
    ],
    identities: { total: 2, humans: 2, services: 0, active: 2, inactive: 0, mfaEnrolled: 2 },
    alerts: null,
    chain: { ok: true, length: 12, detail: "The organization's evidence chain verifies end to end." },
    policies: { stored: 1, baselineStored: true, scopes: 3 },
    ...overrides,
  };
}

function input(overrides: Partial<CompliancePacketInput> = {}): CompliancePacketInput {
  return {
    generatedAt: T0,
    organization: "Innotel",
    generatedBy: "admin@innotel.us",
    view: view(),
    audit: { verified: true, length: 12, detail: "The organization's evidence chain verifies end to end." },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  The shared format                                                          */
/* -------------------------------------------------------------------------- */

test("the packet is the family's format, not a Sentinel dialect", () => {
  // Literals on purpose: this is the agreement with OnTrak Tix, and a test that read
  // the constant from the same module could not notice the agreement changing.
  assert.equal(ASSURANCE_PACKET_VERSION, "1.0");
  assert.equal(ASSURANCE_ALGORITHM, "HMAC-SHA256");

  const packet = buildCompliancePacket(input(), sha256Hex, sign);
  assert.equal(packet.version, "1.0");
  assert.equal(packet.algorithm, "HMAC-SHA256");
  // And it says which subject it is, so one verifier can hold both products' packets.
  assert.equal(packet.packet, COMPLIANCE_PACKET_KIND);
  assert.notEqual(packet.packet, "ontrak-tix-incident");
});

test("the record fingerprint ignores the clock and the anchor", () => {
  const a = buildCompliancePacket(input(), sha256Hex, sign);
  const b = buildCompliancePacket(
    input({
      generatedAt: "2027-01-01T00:00:00.000Z",
      audit: { verified: true, length: 400, detail: "grown since" },
    }),
    sha256Hex,
    sign,
  );

  // Same posture, so the same record hash — which is what makes an archived packet
  // comparable with a fresh one.
  assert.equal(a.recordHash, b.recordHash);
  // A longer chain and a later export move the content digest: both are part of what
  // the packet asserts about *when* it was taken.
  assert.notEqual(a.contentHash, b.contentHash);
  assert.notEqual(a.signature, b.signature);
});

test("the same posture exported twice is byte-identical", () => {
  const a = buildCompliancePacket(input(), sha256Hex, sign);
  const b = buildCompliancePacket(input(), sha256Hex, sign);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

/* -------------------------------------------------------------------------- */
/*  Verification                                                              */
/* -------------------------------------------------------------------------- */

test("an untouched packet verifies", () => {
  const packet = buildCompliancePacket(input(), sha256Hex, sign);
  const result = verifyCompliancePacket(packet, sha256Hex, sign);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.contentHash, packet.contentHash);
});

test("an edited control fails verification", () => {
  const packet = buildCompliancePacket(input(), sha256Hex, sign);
  const edited: CompliancePacket = {
    ...packet,
    controls: [{ ...packet.controls[0], state: "OK", detail: "all fine, really" }, packet.controls[1]],
  };
  const result = verifyCompliancePacket(edited, sha256Hex, sign);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /content hash|record hash/);
});

test("a re-signed edit is refused by anyone without the key", () => {
  // The attack a digest alone does not stop: change the document, then recompute every
  // digest the document carries. The digests agree; only the signature disagrees, which
  // is the whole reason the format has one.
  const packet = buildCompliancePacket(input(), sha256Hex, sign);
  const { generatedAt, recordHash, contentHash, signature, algorithm, ...content } = {
    ...packet,
    generatedBy: "somebody.else@example.test",
  };
  void generatedAt;
  void recordHash;
  void contentHash;
  void signature;
  void algorithm;

  const { audit, ...record } = content;
  void audit;
  const recomputedContent = sha256Hex(stableStringify(content));
  const reSigned: CompliancePacket = {
    ...content,
    audit,
    generatedAt: packet.generatedAt,
    algorithm: packet.algorithm,
    recordHash: sha256Hex(stableStringify(record)),
    contentHash: recomputedContent,
    signature: sign(recomputedContent),
  };

  // Every digest checks out, so a verifier that only hashed would pass it.
  const { contentHash: _, recordHash: __, signature: ___, algorithm: ____, generatedAt: _____, ...forCheck } = reSigned;
  void _;
  void __;
  void ___;
  void ____;
  void _____;
  assert.equal(sha256Hex(stableStringify(forCheck)), reSigned.contentHash);

  // With the key, the forgery is a valid packet — provenance, not truthfulness, is what
  // a signature proves, and the holder of the key *is* the deployment.
  assert.equal(verifyCompliancePacket(reSigned, sha256Hex, sign).ok, true);
  // Without it, the identical document is refused.
  const wrongKey = verifyCompliancePacket(reSigned, sha256Hex, hmacSigner("another-key-long-enough"));
  assert.equal(wrongKey.ok, false);
  if (!wrongKey.ok) assert.match(wrongKey.reason, /signature/);
});

test("a packet whose anchor was moved fails the content check", () => {
  const packet = buildCompliancePacket(input(), sha256Hex, sign);
  const moved: CompliancePacket = {
    ...packet,
    audit: { verified: false, length: 0, detail: "the chain could not be read" },
  };
  const result = verifyCompliancePacket(moved, sha256Hex, sign);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /content hash/);
});

test("an unknown algorithm is refused by name", () => {
  const packet = buildCompliancePacket(input(), sha256Hex, sign);
  const relabelled: CompliancePacket = { ...packet, algorithm: "HS256" };
  const result = verifyCompliancePacket(relabelled, sha256Hex, sign);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /HS256/);
});

/* -------------------------------------------------------------------------- */
/*  What a person reads                                                        */
/* -------------------------------------------------------------------------- */

test("the posture is counted, and a failing control changes the headline", () => {
  const clean = buildCompliancePacket(input(), sha256Hex, sign);
  assert.deepEqual(postureSummary(clean), { failed: 0, warned: 0, ok: 2 });
  assert.match(packetVerificationReport(clean, { ok: true, contentHash: clean.contentHash }).headline, /every control reads OK/);

  const failing = buildCompliancePacket(
    input({
      view: view({
        controls: [
          { control: "An active administrator exists", state: "FAIL", detail: "Nobody could administer this organization." },
          { control: "Every active identity has a second factor enrolled", state: "WARN", detail: "1 of 2 active identit(ies) have one on record." },
        ],
        chain: { ok: false, length: 0, detail: "The evidence chain is broken." },
      }),
    }),
    sha256Hex,
    sign,
  );
  assert.deepEqual(postureSummary(failing), { failed: 1, warned: 1, ok: 0 });
  const report = packetVerificationReport(failing, { ok: true, contentHash: failing.contentHash });
  assert.match(report.headline, /intact/);
  assert.match(report.headline, /1 control\(s\) read FAIL/);
  // Intact and clean are separate questions, and the report answers both.
  assert.equal(report.ok, true);
});

test("a failed verification reports the reason rather than a summary", () => {
  const packet = buildCompliancePacket(input(), sha256Hex, sign);
  const report = packetVerificationReport(packet, { ok: false, reason: "The signature does not match this deployment's key." });
  assert.equal(report.ok, false);
  assert.match(report.headline, /FAILED — The signature/);
});

/* -------------------------------------------------------------------------- */
/*  Getting one out of the console                                             */
/* -------------------------------------------------------------------------- */

test("the packet has its own path, and the page offers it", () => {
  // A path of its own, because it answers with a document rather than a screen; and
  // under the page it belongs to, so the console's own routing stays predictable.
  assert.equal(CONSOLE_PATHS.compliancePacket, "/console/compliance/packet");
  assert.ok(CONSOLE_PATHS.compliancePacket.startsWith(`${CONSOLE_PATHS.compliance}/`));

  const page = renderCompliance(view());
  assert.match(page, /href="\/console\/compliance\/packet"/);
  assert.match(page, /download/);
});

/* -------------------------------------------------------------------------- */
/*  The key                                                                    */
/* -------------------------------------------------------------------------- */

test("signing needs a key, and says which variable to set", () => {
  assert.throws(() => assuranceSecret({}), /SENTINEL_ASSURANCE_SECRET/);
  assert.throws(() => assuranceSecret({ SENTINEL_ASSURANCE_SECRET: "short" }), /too short/);
  // The IdP's own key is the fallback, so a deployment with an identity provider can
  // export a packet without being told about a second variable first.
  assert.equal(assuranceSecret({ SENTINEL_SIGNING_KEY: "a-signing-key-long-enough" }), "a-signing-key-long-enough");
  assert.equal(assuranceSecret({ SENTINEL_ASSURANCE_SECRET: "dedicated-key-long-enough" }), "dedicated-key-long-enough");
});

test("the signer is deterministic and key-dependent", () => {
  const a = hmacSigner(KEY)("payload");
  assert.equal(a, hmacSigner(KEY)("payload"));
  assert.notEqual(a, hmacSigner("another-key-long-enough")("payload"));
  assert.match(a, /^[0-9a-f]{64}$/);
});
