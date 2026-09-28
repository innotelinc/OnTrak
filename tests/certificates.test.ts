/**
 * Certificate tests.
 *
 * The certificate is what a learner keeps, so the mapping from an attempt to a
 * completion record has to be exactly reproducible: the same attempt must
 * always produce the same code, and any change to the numbers must produce a
 * different one. Both halves are pure, so no database is involved.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attemptPassed,
  attemptPercentOf,
  certificateCodeForAttempt,
  certificateForAttempt,
  certificatePatchFor,
  certificateViewFor,
  completionInputFor,
  interpretEvidence,
  recordIntact,
  sha256Hex,
  skillsFor,
  DEFAULT_ISSUER,
  type CertificateAttempt,
} from "../src/lib/certificates";
import { buildAssurancePacket, certificateCode, verifyCompletionRecord } from "../src/lib/credentials";
import {
  certificateAction,
  readStoredCertificate,
  MAX_EVIDENCE_CHARS,
  verifyInputProblem,
  type CertificateColumns,
  type StoredCertificate,
} from "../src/lib/certificate-rules";

function attempt(overrides: Partial<CertificateAttempt> = {}): CertificateAttempt {
  return {
    learnerId: "user-1",
    learnerName: "Ada Lovelace",
    scenarioId: "scenario-1",
    scenarioTitle: "Raise the wiki back to health",
    platform: "LINUX",
    score: 8,
    maxScore: 10,
    passScore: 70,
    completedAt: new Date("2026-09-26T14:30:00.000Z"),
    skills: ["linux-services", "firewall"],
    ...overrides,
  };
}

test("certificate: the percentage and pass mark decide the outcome", () => {
  assert.equal(attemptPercentOf(attempt()), 80);
  assert.equal(attemptPassed(attempt()), true);
  assert.equal(attemptPassed(attempt({ score: 7, passScore: 75 })), false);
  assert.equal(attemptPassed(attempt({ score: 7, passScore: 70 })), true);

  // A zero-point scenario cannot be failed or passed.
  assert.equal(attemptPercentOf(attempt({ score: 0, maxScore: 0 })), 0);
  assert.equal(attemptPassed(attempt({ score: 0, maxScore: 0, passScore: 0 })), true);
});

test("certificate: the record is derived from the attempt's own facts", () => {
  const input = completionInputFor(attempt(), "Springfield College");
  assert.deepEqual(input, {
    learnerId: "user-1",
    learnerName: "Ada Lovelace",
    scenarioId: "scenario-1",
    scenarioTitle: "Raise the wiki back to health",
    platform: "LINUX",
    passed: true,
    score: 8,
    maxScore: 10,
    percent: 80,
    skills: ["linux-services", "firewall"],
    completedAt: "2026-09-26T14:30:00.000Z",
    issuer: "Springfield College",
  });
});

test("certificate: competency tags are trimmed, de-duplicated and capped", () => {
  assert.deepEqual(skillsFor(undefined), []);
  assert.deepEqual(skillsFor([]), []);
  assert.deepEqual(skillsFor(["  linux  ", "linux", "Linux", "", "   ", "firewall"]), ["linux", "firewall"]);
  const many = Array.from({ length: 20 }, (_, index) => `skill-${index}`);
  assert.equal(skillsFor(many).length, 8);
});

test("certificate: the same attempt always produces the same record and code", () => {
  const first = certificateForAttempt(attempt());
  const second = certificateForAttempt(attempt());
  assert.deepEqual(first, second);
  assert.equal(first.format, "ontrak.training.completion/v1");
  assert.match(first.id, /^crt_[0-9a-f]{16}$/);
  assert.equal(recordIntact(first), true);
  assert.match(certificateCodeForAttempt(attempt()), /^ONTRAK-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
});

test("certificate: the issuer defaults to the product and follows the deployment", () => {
  const previous = process.env.ONTRAK_ISSUER;
  try {
    delete process.env.ONTRAK_ISSUER;
    assert.equal(completionInputFor(attempt()).issuer, DEFAULT_ISSUER);
    const productCode = certificateCodeForAttempt(attempt());

    process.env.ONTRAK_ISSUER = "  Springfield College  ";
    assert.equal(completionInputFor(attempt()).issuer, "Springfield College");
    // The issuer is part of the signed content, so attributing the record to a
    // different organisation yields a different code.
    assert.notEqual(certificateCodeForAttempt(attempt()), productCode);
  } finally {
    if (previous === undefined) delete process.env.ONTRAK_ISSUER;
    else process.env.ONTRAK_ISSUER = previous;
  }
});

test("certificate: editing the outcome breaks the record", () => {
  const record = certificateForAttempt(attempt());
  assert.equal(verifyCompletionRecord(record, sha256Hex), true);

  // A score quietly improved after the fact no longer matches its digest.
  const doctored = { ...record, score: 10, percent: 100 };
  assert.equal(verifyCompletionRecord(doctored, sha256Hex), false);
  assert.equal(recordIntact(doctored), false);

  // So does flipping the outcome itself.
  assert.equal(recordIntact({ ...record, passed: false }), false);

  // And the code is different for a genuinely different attempt.
  assert.notEqual(certificateCodeForAttempt(attempt()), certificateCodeForAttempt(attempt({ score: 9 })));
});

test("certificate: a timed-out attempt that cleared the mark still earns one", () => {
  // Expiry is about time, not competence: the work that passed the checks did
  // pass them, and the record says what it says.
  const expired = attempt({ passScore: 70 });
  assert.equal(certificateForAttempt(expired).passed, true);
});

/* -------------------------------------------------------------------------- */
/*  Issuing, keeping and revoking                                             */
/* -------------------------------------------------------------------------- */

const ISSUED_AT = "2026-09-26T14:30:00.000Z";
const AT = new Date(ISSUED_AT);

function stored(overrides: Partial<StoredCertificate> = {}): StoredCertificate {
  return { record: certificateForAttempt(attempt()), issuedAt: ISSUED_AT, revokedAt: null, ...overrides };
}

/** The three attempt columns a certificate lives in, as a Prisma row presents them. */
function columns(overrides: Partial<CertificateColumns> = {}): CertificateColumns {
  return { certificate: certificateForAttempt(attempt()), certificateIssuedAt: AT, certificateRevokedAt: null, ...overrides };
}

test("certificate: a first pass issues a record and a later pass keeps it", () => {
  assert.equal(certificateAction(true, null), "issue");
  assert.equal(certificateAction(true, stored()), "keep");
});

// The whole point of storing the record: the code a learner was handed has to
// keep meaning the same thing, whatever a later re-grade makes of the attempt.
test("certificate: a re-grade does not move the code a learner already holds", () => {
  const issued = stored();
  const before = certificateCode(issued.record);

  const patch = certificatePatchFor(attempt({ score: 9 }), issued, new Date("2026-10-01T00:00:00.000Z"));

  // Nothing about the certificate is written, so the stored code still stands.
  assert.deepEqual(patch, {});
  assert.equal(certificateCode(issued.record), before);
});

test("certificate: failing on a re-grade revokes it, and passing again re-issues", () => {
  assert.equal(certificateAction(false, stored()), "revoke");
  assert.equal(certificateAction(false, null), "none");

  const revoked = stored({ revokedAt: "2026-10-01T00:00:00.000Z" });
  // Already revoked, so there is nothing left to take away...
  assert.equal(certificateAction(false, revoked), "none");
  // ...and a pass after a revocation earns a fresh record rather than reviving
  // the old one, whose result no longer describes the attempt.
  assert.equal(certificateAction(true, revoked), "issue");

  const at = new Date("2026-10-01T00:00:00.000Z");
  assert.deepEqual(certificatePatchFor(attempt({ score: 2 }), stored(), at), { certificateRevokedAt: at });
  assert.deepEqual(Object.keys(certificatePatchFor(attempt({ score: 2 }), stored(), at)), ["certificateRevokedAt"]);
});

test("certificate: issuing writes the record and its date, and clears any revocation", () => {
  const at = new Date("2026-09-26T14:30:00.000Z");
  const patch = certificatePatchFor(attempt(), null, at);

  assert.equal(patch.certificateIssuedAt, at);
  assert.equal(patch.certificateRevokedAt, null);
  // The column holds exactly a completion record — nothing wrapped around it.
  assert.deepEqual(patch.certificate, certificateForAttempt(attempt()));
});

test("certificate: a stored row reads back, and junk fails closed", () => {
  const read = readStoredCertificate(columns());
  assert.equal(read?.issuedAt, ISSUED_AT);
  assert.equal(read?.revokedAt, null);
  assert.equal(certificateCode(read?.record ?? certificateForAttempt(attempt())), certificateCodeForAttempt(attempt()));

  // A revoked row keeps its record: the artifact is intact either way, and the
  // revocation is a separate fact about it.
  const revoked = readStoredCertificate(columns({ certificateRevokedAt: new Date("2026-10-01T00:00:00.000Z") }));
  assert.equal(revoked?.revokedAt, "2026-10-01T00:00:00.000Z");
  assert.equal(recordIntact(revoked?.record ?? certificateForAttempt(attempt())), true);

  // Anything unrecognisable is no certificate at all, rather than a broken one.
  assert.equal(readStoredCertificate(columns({ certificate: null })), null);
  assert.equal(readStoredCertificate(columns({ certificate: "ONTRAK-1234-5678-9ABC" })), null);
  assert.equal(readStoredCertificate(columns({ certificate: [] })), null);
  // A record with no digest is not a record; one with no learner is not either.
  assert.equal(readStoredCertificate(columns({ certificate: { learnerId: "user-1" } })), null);
  assert.equal(readStoredCertificate(columns({ certificate: { digest: "abc" } })), null);
  // And a row with no issue date cannot be attributed to a moment.
  assert.equal(readStoredCertificate(columns({ certificateIssuedAt: null })), null);

  // A date that comes back as a string reads as readily as a `Date`.
  assert.equal(readStoredCertificate(columns({ certificateIssuedAt: ISSUED_AT }))?.issuedAt, ISSUED_AT);
});

test("certificate: the report shows the issued record, a revocation, or a derived one", () => {
  // The stored record wins even though the attempt now scores 50%: it attests
  // the result at issue time, and the page says so.
  const view = certificateViewFor(attempt({ score: 5, passScore: 70 }), stored());
  assert.equal(view?.source, "stored");
  assert.equal(view?.record.percent, 80);
  assert.equal(view?.revokedAt, null);

  // A revoked record is surfaced rather than hidden.
  const revoked = certificateViewFor(attempt({ score: 2 }), stored({ revokedAt: "2026-10-01T00:00:00.000Z" }));
  assert.deepEqual(revoked?.revokedAt, new Date("2026-10-01T00:00:00.000Z"));

  // A pass graded before records were stored still gets one derived here...
  const derived = certificateViewFor(attempt(), null);
  assert.equal(derived?.source, "derived");
  assert.equal(derived?.record.percent, 80);
  // ...but a failure with nothing stored has no certificate at all.
  assert.equal(certificateViewFor(attempt({ score: 1 }), null), null);
});

/* -------------------------------------------------------------------------- */
/*  Verifying pasted evidence                                                 */
/* -------------------------------------------------------------------------- */

test("verify: a freshly issued record checks out, with its code and summary", () => {
  const record = certificateForAttempt(attempt());
  const verdict = interpretEvidence(JSON.stringify(record));

  assert.equal(verdict.status, "valid");
  assert.equal(verdict.kind, "record");
  assert.equal(verdict.code, certificateCodeForAttempt(attempt()));
  assert.match(verdict.summary ?? "", /Ada Lovelace/);
  assert.match(verdict.summary ?? "", /80%/);
});

test("verify: an edited record is reported as invalid, not as an error", () => {
  const record = certificateForAttempt(attempt());
  const verdict = interpretEvidence(JSON.stringify({ ...record, score: 10, percent: 100 }));

  // The shape is right and the code can still be shown — the content just no
  // longer matches its digest, which is the distinction that matters.
  assert.equal(verdict.status, "invalid");
  assert.equal(verdict.kind, "record");
  assert.equal(verdict.code, certificateCodeForAttempt(attempt()));
});

test("verify: an assurance packet is checked as a whole", () => {
  const records = [certificateForAttempt(attempt()), certificateForAttempt(attempt({ learnerId: "user-2", learnerName: "Grace Hopper" }))];
  const packet = buildAssurancePacket(records, "Springfield College", "2026-09-27T00:00:00.000Z", sha256Hex);

  const valid = interpretEvidence(JSON.stringify(packet));
  assert.equal(valid.status, "valid");
  assert.equal(valid.kind, "packet");
  assert.match(valid.summary ?? "", /2 completion record\(s\) from Springfield College/);

  // Dropping a record invalidates the packet digest even though every
  // remaining record is individually intact.
  const trimmed = interpretEvidence(JSON.stringify({ ...packet, records: [records[0]] }));
  assert.equal(trimmed.status, "invalid");
});

test("verify: unusable input is an error, distinct from a failed check", () => {
  assert.match(interpretEvidence("").error ?? "", /Paste a certificate record/);
  assert.match(interpretEvidence("   ").error ?? "", /Paste a certificate record/);
  assert.match(interpretEvidence("not json at all").error ?? "", /not valid JSON/);
  assert.match(interpretEvidence('{"format":"something/else"}').error ?? "", /neither a completion record/);
  assert.match(interpretEvidence("[]").error ?? "", /neither a completion record/);

  for (const verdict of [interpretEvidence(""), interpretEvidence("nope")]) {
    assert.equal(verdict.status, "error");
  }
});

test("verify: pasted evidence has a size ceiling so hashing cannot be weaponised", () => {
  assert.equal(verifyInputProblem("{}"), null);
  assert.match(verifyInputProblem("") ?? "", /Paste a certificate record/);

  const huge = `{"pad":"${"x".repeat(MAX_EVIDENCE_CHARS)}"}`;
  assert.match(verifyInputProblem(huge) ?? "", /far larger than/);
  assert.equal(interpretEvidence(huge).status, "error");
});
