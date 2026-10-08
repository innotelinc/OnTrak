/**
 * One rule, every surface.
 *
 * An attempt's score becomes a percentage and a verdict in the simulator's
 * report, the webhook payload, the results API, the CSV export, the certificate
 * and four screens. Each surface used to decide for itself, and they disagreed
 * about one case: a scenario worth zero points. The report called it 100% and a
 * pass, the certificate and the feed called it 0%, and the webhook refused to
 * call it a pass at all, so the same attempt was a pass on the learner's page and
 * a failure in the payload their employer received.
 *
 * These tests state the rule once, then hold every surface that can be reached
 * without a database against it, so a surface that starts re-deriving `passed`
 * fails here rather than in a consumer's database.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/score-rules.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { attemptPassed, attemptPercentOf, type CertificateAttempt } from "../src/lib/certificates";
import { resultCells, type ResultCsvRow } from "../src/lib/csv-rules";
import { clearedPassMark, scorePercent } from "../src/lib/score-rules";
import { createInitialState } from "../src/lib/sim/state";
import { gradeAttempt } from "../src/lib/sim/grade";
import type { ScenarioDefinition } from "../src/lib/sim/types";
import { gradedEventInput, percent, type GradedFactSource } from "../src/lib/webhook-rules";

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

/** The webhook's view of one attempt. */
const SOURCE: GradedFactSource = {
  attemptId: "att_1",
  status: "GRADED",
  learner: { id: "u1", email: "ada@acme.test", name: "Ada" },
  scenario: { id: "s1", title: "Fix a broken NIC", platform: "LINUX" },
  cohort: null,
  score: 8,
  maxScore: 10,
  passScore: 70,
  startedAt: "2026-10-05T09:00:00.000Z",
  submittedAt: "2026-10-05T09:20:00.000Z",
  gradedAt: "2026-10-05T09:20:01.000Z",
  timeSpentSec: 1200,
  certificate: null,
  checks: [],
};

/** The CSV's view of the same attempt. */
const CSV_ROW: ResultCsvRow = {
  attemptId: "att_1",
  learnerEmail: "ada@acme.test",
  learnerName: "Ada",
  scenarioId: "s1",
  scenarioTitle: "Fix a broken NIC",
  platform: "LINUX",
  status: "GRADED",
  score: 8,
  maxScore: 10,
  passScore: 70,
  startedAt: new Date("2026-10-05T09:00:00.000Z"),
  gradedAt: new Date("2026-10-05T09:20:01.000Z"),
  timeSpentSec: 1200,
  certificateCode: null,
  mode: "simulated",
};

/** The certificate's view of the same attempt. */
function certificateAttempt(overrides: Partial<CertificateAttempt> = {}): CertificateAttempt {
  return {
    learnerId: "u1",
    learnerName: "Ada",
    scenarioId: "s1",
    scenarioTitle: "Fix a broken NIC",
    platform: "LINUX",
    score: 8,
    maxScore: 10,
    passScore: 70,
    completedAt: new Date("2026-10-05T09:20:01.000Z"),
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  The rule                                                                  */
/* -------------------------------------------------------------------------- */

test("score: a percentage is whole, bounded, and zero when nothing was asked", () => {
  assert.equal(scorePercent(8, 10), 80);
  assert.equal(scorePercent(7, 10), 70);
  assert.equal(scorePercent(2, 3), 67, "rounded, because this is the number a person reads");
  assert.equal(scorePercent(0, 10), 0);
  assert.equal(scorePercent(10, 10), 100);

  // A scenario worth nothing has no percentage, however it is asked: 0/0 is not
  // "all of it", and a score against no marks is not over 100%.
  assert.equal(scorePercent(0, 0), 0);
  assert.equal(scorePercent(5, 0), 0);
  assert.equal(scorePercent(0, Number.NaN), 0);
});

test("score: the pass mark is a percentage, and zero points is not a pass", () => {
  assert.equal(clearedPassMark({ score: 8, maxScore: 10, passScore: 70 }), true);
  assert.equal(clearedPassMark({ score: 7, maxScore: 10, passScore: 70 }), true, "exactly on the mark");
  assert.equal(clearedPassMark({ score: 6, maxScore: 10, passScore: 70 }), false);

  // An unreadable mark is read as 0 rather than refusing every attempt.
  assert.equal(clearedPassMark({ score: 8, maxScore: 10, passScore: Number.NaN }), true);

  // Nothing was asked, so there is nothing to pass: not at 0%, not at 70%.
  assert.equal(clearedPassMark({ score: 0, maxScore: 0, passScore: 0 }), false);
  assert.equal(clearedPassMark({ score: 0, maxScore: 0, passScore: 70 }), false);
  assert.equal(clearedPassMark({ score: 5, maxScore: 0, passScore: 0 }), false);
});

/* -------------------------------------------------------------------------- */
/*  The surfaces                                                              */
/* -------------------------------------------------------------------------- */

test("score: the webhook, the CSV and the certificate agree on every attempt", () => {
  const cases = [
    { score: 8, maxScore: 10, passScore: 70, expected: true },
    { score: 6, maxScore: 10, passScore: 70, expected: false },
    // The case they used to disagree about.
    { score: 0, maxScore: 0, passScore: 0, expected: false },
  ];

  for (const { expected, ...facts } of cases) {
    const label = `${facts.score}/${facts.maxScore} against ${facts.passScore}%`;
    assert.equal(clearedPassMark(facts), expected, `${label}: the rule`);
    assert.equal(gradedEventInput({ ...SOURCE, ...facts }).passed, expected, `${label}: the webhook`);
    assert.equal(
      resultCells({ ...CSV_ROW, ...facts })[10],
      expected ? "yes" : "no",
      `${label}: the CSV`,
    );
    assert.equal(attemptPassed(certificateAttempt(facts)), expected, `${label}: the certificate`);
  }
});

test("score: the simulator's report uses the same rule as the wire", () => {
  // A scenario with no checks is worth zero points. Its report used to call that
  // 100% and a pass, which contradicted the stored attempt it was reporting on.
  const empty: ScenarioDefinition = {
    version: 1,
    platform: "LINUX",
    engine: "bash",
    objective: "Nothing was asked.",
    brief: "A scenario with no checks, so it is worth zero points.",
    tasks: [],
    machine: { hostname: "server01", user: "student", os: "Ubuntu 24.04.2 LTS", version: "24.04" },
    files: [],
    checks: [],
  };
  const report = gradeAttempt(empty, createInitialState(empty));
  assert.equal(report.maxScore, 0);
  assert.equal(report.percent, 0, "nothing asked is 0%, not full marks");
  assert.equal(report.passed, false);
  assert.equal(report.passed, clearedPassMark({ score: report.score, maxScore: report.maxScore, passScore: 70 }));
});

test("score: the pure helper is the one the older names delegate to", () => {
  assert.equal(percent(8, 10), scorePercent(8, 10), "webhook-rules.percent");
  assert.equal(percent(0, 0), 0);
  assert.equal(attemptPercentOf(certificateAttempt()), scorePercent(8, 10), "certificates.attemptPercentOf");
  assert.equal(attemptPercentOf(certificateAttempt({ score: 0, maxScore: 0 })), 0);
});
