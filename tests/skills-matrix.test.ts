/**
 * Skills matrix tests.
 *
 * The matrix makes a claim about people — *this person can do this* — so what it
 * counts matters more than how it draws. Each case below is one of the
 * certificate's own rules read back through the aggregate: a revoked record
 * demonstrates nothing, a record with no competencies demonstrates nothing, and
 * the same competency earned twice is one competency earned since the first pass.
 *
 * The rows are built from real certificates (`certificateForAttempt`) rather than
 * hand-written JSON, so a change to the record's shape fails here instead of
 * quietly emptying a column.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { certificateForAttempt, type CertificateAttempt } from "../src/lib/certificates";
import { holdsSkill, skillKey, skillsMatrixFrom, type SkillRow } from "../src/lib/skills-rules";

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

/** An `Attempt` row carrying a stored certificate, as the page reads it. */
function row(overrides: Partial<CertificateAttempt> = {}, revokedAt: Date | null = null): SkillRow {
  const built = attempt(overrides);
  return {
    userId: built.learnerId,
    learnerName: built.learnerName,
    certificate: certificateForAttempt(built),
    certificateIssuedAt: new Date(built.completedAt),
    certificateRevokedAt: revokedAt,
  };
}

/* -------------------------------------------------------------------------- */
/*  What counts                                                               */
/* -------------------------------------------------------------------------- */

test("skills: a pass in several competencies puts the learner in each column", () => {
  const matrix = skillsMatrixFrom([
    row({ learnerId: "user-1", learnerName: "Ada Lovelace", skills: ["networking", "linux-permissions", "dns"] }),
    row({ learnerId: "user-2", learnerName: "Grace Hopper", skills: ["dns"] }),
  ]);

  assert.deepEqual(matrix.skills, ["dns", "linux-permissions", "networking"]);
  assert.equal(matrix.learners.length, 2);
  assert.equal(matrix.counted, 2);

  const ada = matrix.learners.find((learner) => learner.userId === "user-1");
  assert.deepEqual(ada?.skills.map((earned) => earned.skill), ["dns", "linux-permissions", "networking"]);
  assert.equal(ada?.skills.every((earned) => earned.certificates === 1), true);

  // The holder count is people, not certificates, and a column nobody holds is a
  // column that is not there at all.
  assert.deepEqual(matrix.holders, { dns: 2, "linux-permissions": 1, networking: 1 });
});

test("skills: two spellings of one competency are one column, whoever tagged them", () => {
  const matrix = skillsMatrixFrom([
    row({ learnerId: "user-1", learnerName: "Ada", skills: ["Linux"] }),
    row({ learnerId: "user-2", learnerName: "Grace", skills: ["  linux  "] }),
  ]);

  // One competency, labelled with the first spelling seen rather than two columns
  // that each answer "who can do this" with half the people.
  assert.deepEqual(matrix.skills, ["Linux"]);
  assert.deepEqual(matrix.holders, { linux: 2 });
  assert.equal(matrix.learners.every((learner) => holdsSkill(learner, "linux")), true);
  assert.equal(skillKey("  LINUX "), "linux");
});

test("skills: the same competency earned twice is one, first demonstrated the earliest", () => {
  const matrix = skillsMatrixFrom([
    // Deliberately newest-first, so an implementation that keeps the last date or
    // appends a second entry fails rather than passes by input order.
    row({ learnerId: "user-1", learnerName: "Ada", skills: ["dns"], completedAt: new Date("2026-10-01T09:00:00.000Z") }),
    row({ learnerId: "user-1", learnerName: "Ada", skills: ["dns"], completedAt: new Date("2026-09-01T09:00:00.000Z") }),
  ]);

  const ada = matrix.learners.find((learner) => learner.userId === "user-1");
  assert.equal(ada?.skills.length, 1, "one competency, not two");
  const earned = ada?.skills.find((entry) => entry.skill === "dns");
  assert.equal(earned?.certificates, 2);
  assert.equal(earned?.firstEarnedAt, "2026-09-01T09:00:00.000Z");
});

test("skills: a certificate with no competencies contributes nothing", () => {
  const matrix = skillsMatrixFrom([
    row({ learnerId: "user-1", learnerName: "Ada", skills: [] }),
    row({ learnerId: "user-2", learnerName: "Grace", skills: undefined }),
  ]);

  // Two live certificates are counted — they are certificates — and yet the
  // matrix claims no competence from either, because neither attests one.
  assert.equal(matrix.counted, 2);
  assert.deepEqual(matrix.skills, []);
  assert.deepEqual(matrix.holders, {});
  assert.equal(matrix.learners.length, 2);
  assert.equal(matrix.learners.every((learner) => learner.skills.length === 0), true);
});

/* -------------------------------------------------------------------------- */
/*  Revocation — the rule the matrix exists to respect                         */
/* -------------------------------------------------------------------------- */

test("skills: a revoked certificate takes its competency away and the person stays visible", () => {
  const revokedAt = new Date("2026-10-02T00:00:00.000Z");
  const matrix = skillsMatrixFrom([
    row({ learnerId: "user-1", learnerName: "Ada", skills: ["networking"] }, revokedAt),
  ]);

  assert.equal(matrix.counted, 0, "a revoked record is not a live certificate");
  assert.equal(matrix.revoked, 1);
  assert.deepEqual(matrix.skills, [], "and its competency is nobody's");
  assert.deepEqual(matrix.holders, {});

  // The row survives on purpose: dropping it would make the withdrawal invisible
  // in the one view that exists to show what people can do.
  assert.equal(matrix.learners.length, 1);
  const ada = matrix.learners.find((learner) => learner.userId === "user-1");
  assert.equal(ada?.skills.length, 0);
  assert.equal(ada?.revoked, 1);
});

test("skills: revoking one of two records keeps the competency the other earned", () => {
  const matrix = skillsMatrixFrom([
    row({ learnerId: "user-1", learnerName: "Ada", skills: ["dns"], completedAt: new Date("2026-09-01T09:00:00.000Z") }),
    row(
      { learnerId: "user-1", learnerName: "Ada", skills: ["dns", "networking"], completedAt: new Date("2026-10-01T09:00:00.000Z") },
      new Date("2026-10-02T00:00:00.000Z"),
    ),
  ]);

  const ada = matrix.learners.find((learner) => learner.userId === "user-1");
  assert.equal(matrix.counted, 1);
  assert.equal(matrix.revoked, 1);
  assert.deepEqual(ada?.skills.map((earned) => earned.skill), ["dns"]);
  // The revoked record still carried `networking`, so it must not appear.
  assert.equal(ada ? holdsSkill(ada, "networking") : true, false);
  assert.equal(ada?.revoked, 1);
});

/* -------------------------------------------------------------------------- */
/*  Rows that cannot be read, and nothing at all                              */
/* -------------------------------------------------------------------------- */

test("skills: a record this build cannot read is reported rather than counted", () => {
  const matrix = skillsMatrixFrom([
    row({ learnerId: "user-1", learnerName: "Ada" }),
    { userId: "user-2", learnerName: "Grace", certificate: null, certificateIssuedAt: new Date(), certificateRevokedAt: null },
    { userId: "user-3", learnerName: "Alan", certificate: "ONTRAK-1234-5678-9ABC", certificateIssuedAt: null, certificateRevokedAt: null },
  ]);

  assert.equal(matrix.counted, 1);
  assert.equal(matrix.unreadable, 2, "both the junk record and the row with no issue date");
  assert.deepEqual(matrix.skills, ["firewall", "linux-services"]);
  // Still listed, with nothing in the row: the page shows the count so an
  // operator can see something is wrong instead of seeing a short matrix.
  assert.equal(matrix.learners.length, 3);
});

test("skills: an empty matrix is empty rather than absent", () => {
  const matrix = skillsMatrixFrom([]);
  assert.deepEqual(matrix, {
    skills: [],
    learners: [],
    holders: {},
    counted: 0,
    revoked: 0,
    unreadable: 0,
  });
});
