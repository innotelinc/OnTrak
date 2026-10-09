/**
 * A session run *here*, filed in the same ledger a peer lab reports to.
 *
 * The HTTP door's rules are already covered (`tests/lab-completion.test.ts`). What this
 * file covers is the mapping stage 3 added, and the three decisions in it that a reader of
 * the family's tables would otherwise have to guess: the score is the blended percentage
 * on the family's scale, the check rows are the *machine* objectives (not the write-up's
 * rubric), and the session key is prefixed so a deployment running both labs cannot answer
 * one lab's session as a duplicate of the other's.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { IN_APP_SESSION_PREFIX, inAppSessionKey, labCompletionFrom } from "../src/lib/lab/completion";
import { readLabCompletion } from "../src/lib/lab-completion-rules";
import { loadScenarios } from "../src/lib/lab/dataset";
import { newCheckOutcome, newLabSession, newScoreReport, type LabSession } from "../src/lib/lab/models";

const SCENARIO = "net-dns-failure";
const scenario = loadScenarios().get(SCENARIO);

/** A finished session: ready at 09:00, graded at 09:30, two objectives, one passed. */
function facts(overrides: { session?: Partial<LabSession>; familyScenarioId?: string | null } = {}) {
  const session: LabSession = {
    ...newLabSession({ student: "ada", scenarioId: SCENARIO, id: 12 }),
    state: "passed",
    readyAt: "2026-10-09T09:00:00.000Z",
    createdAt: "2026-10-09T08:58:00.000Z",
    ...overrides.session,
  };
  const report = newScoreReport({ sessionId: 12, scenarioId: SCENARIO, createdAt: "2026-10-09T09:30:00.000Z" });
  const first = scenario.objectives[0];
  const second = scenario.objectives[1];
  report.outcomes = [
    newCheckOutcome({ objectiveId: first.id, passed: true, weight: first.weight }),
    newCheckOutcome({ objectiveId: second.id, passed: false, weight: second.weight }),
  ];
  report.machineScore = 62.4;
  report.ticketScore = 78.5;
  // A blended grade, not the machine half: 62.4 × 0.7 + 78.5 × 0.3.
  report.score = 67.2;
  report.resolved = false;
  return {
    session,
    scenario,
    report,
    learnerEmail: "Ada@Example.test",
    familyScenarioId: overrides.familyScenarioId === undefined ? "scn-1" : overrides.familyScenarioId,
    passScore: 80,
  };
}

test("completion: the idempotency key is prefixed, and the door's own reader accepts it", () => {
  assert.equal(inAppSessionKey(12), "in-app:12");
  assert.equal(IN_APP_SESSION_PREFIX, "in-app:");
  // The prefix is not decoration: the key travels through the same normaliser the HTTP
  // door uses, and a character it refused would make every in-app result unfilable.
  const read = readLabCompletion({
    sessionId: inAppSessionKey(12),
    learnerEmail: "ada@example.test",
    scenarioSlug: SCENARIO,
    score: 67,
    maxScore: 100,
    completedAt: "2026-10-09T09:30:00.000Z",
  });
  assert.equal(read.ok, true, read.ok ? "" : read.issues.join("; "));
});

test("completion: the score filed is the blended one, on the family's scale", () => {
  const completion = labCompletionFrom(facts());

  assert.equal(completion.score, 67, "rounded, and the blend rather than the machine half");
  assert.equal(completion.maxScore, 100);
  assert.equal(completion.passScore, 80, "the family's own pass mark wins when it has one");
  assert.equal(completion.learnerEmail, "ada@example.test", "lowercased: it is a unique key");
  assert.equal(completion.scenarioId, "scn-1");
  assert.equal(completion.scenarioSlug, SCENARIO, "and the lab's id travels beside it");
  assert.equal(completion.sessionId, "in-app:12");
});

test("completion: the check rows are the machine's objectives, in the scenario's own words", () => {
  const completion = labCompletionFrom(facts());
  assert.equal(completion.checks.length, 2);

  const [passed, failed] = completion.checks;
  assert.equal(passed.checkId, scenario.objectives[0].id);
  assert.equal(passed.label, scenario.objectives[0].text, "the briefing's words, not an id");
  assert.equal(passed.maxPoints, Math.round(scenario.objectives[0].weight));
  assert.equal(passed.points, passed.maxPoints, "a passed objective awards its weight");
  assert.equal(failed.passed, false);
  assert.equal(failed.points, 0, "and a failed one awards nothing, not a partial mark");
  assert.equal(failed.maxPoints, Math.round(scenario.objectives[1].weight));
});

test("completion: the clock is the session's, and the file name is the lab's", () => {
  const completion = labCompletionFrom(facts());
  assert.equal(completion.startedAt?.toISOString(), "2026-10-09T09:00:00.000Z", "from `readyAt`");
  assert.equal(completion.completedAt.toISOString(), "2026-10-09T09:30:00.000Z");

  // A session that never became ready falls back to when it was asked for, which is still
  // a true answer to "when did this start".
  const neverReady = labCompletionFrom(facts({ session: { readyAt: "", state: "error" } }));
  assert.equal(neverReady.startedAt?.toISOString(), "2026-10-09T08:58:00.000Z");

  // No family row yet: the slug is the only reference, and the door resolves it — or
  // refuses the whole completion, which is the honest end of an un-imported catalogue.
  const unimported = labCompletionFrom(facts({ familyScenarioId: null }));
  assert.equal(unimported.scenarioId, null);
  assert.equal(unimported.scenarioSlug, SCENARIO);
});

test("completion: an unsaved session is a caller bug, not a lobby of the ledger", () => {
  assert.throws(
    () => labCompletionFrom(facts({ session: { id: null } })),
    /saved before its result can be filed/,
  );
});
