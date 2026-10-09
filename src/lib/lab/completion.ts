/**
 * A ported lab session, as the family's completion shape.
 *
 * The lab has two ways to finish now, and this is the one that keeps them converged. A
 * peer deployment reports its result over HTTP in `ontrak.lab.completion/v1` (the format
 * `lab-completion-rules.ts` reads); this app runs the same control plane itself and holds
 * the session, the report and the write-up in memory. Both end up as a `LabCompletion`,
 * and `recordLabCompletion` writes it — so the attempt, the certificate, the evidence and
 * the audit entry cannot differ depending on which half of the port did the grading.
 *
 * Three mappings are decisions rather than conversions, and each is stated here because a
 * reader of the family's tables will otherwise have to guess:
 *
 * **The score is the blended one on the family's scale.** The session's report is a
 * percentage (stage 3a blended the machine half and the write-up), and the family's
 * `Attempt.score` is a whole number out of `maxScore`, so this is `Math.round` against
 * `maxScore = 100`. That is the same arithmetic the simulated attempts use, which is what
 * lets one results page quote both without a footnote.
 *
 * **The check rows are the machine objectives, not the write-up.** `CheckResult` is the
 * per-objective breakdown the instructor's regeneration view re-runs; a ticket field is
 * not an objective and has no engine to re-run, so the rubric's own mark lives in the
 * blended score and in the lab's own tables rather than being forced into a column whose
 * meaning it would break.
 *
 * **The session key is prefixed.** `Attempt.labSessionId` is the idempotency key, and a
 * deployment can run a peer lab beside the in-app one; the lab's own ids are small
 * integers, so `in-app:12` and `12` cannot be mistaken for each other and a session run
 * here can never be answered as a duplicate of somebody else's.
 */

import type { LabCompletion, LabCompletionCheck } from "@/lib/lab-completion-rules";

import { type LabSession, type ScoreReport, objectiveIn, parseIso } from "./models";
import type { Scenario } from "./scenarios";

/** The prefix that keeps this app's session ids out of the peer's namespace. */
export const IN_APP_SESSION_PREFIX = "in-app:";

/** The idempotency key for a session this app ran. */
export function inAppSessionKey(sessionId: number): string {
  return `${IN_APP_SESSION_PREFIX}${sessionId}`;
}

/** The family's scale. A percentage is the lab's, and 100 is what it is out of. */
export const LAB_MAX_SCORE = 100;

export interface LabCompletionFacts {
  session: LabSession;
  /** The lab's own scenario, for its objectives' text and weights. */
  scenario: Scenario;
  report: ScoreReport;
  /** The signed-in student's email — the family's unique key for them. */
  learnerEmail: string;
  /** The family's scenario row, once the caller has found it (`familyScenarioFor`). */
  familyScenarioId: string | null;
  /** The family's pass mark for the task, when it has one; the lab's is the fallback. */
  passScore?: number | null;
}

/**
 * The completion this session represents.
 *
 * `session.id` has to exist: an unsaved session has nothing to file against, and a caller
 * that has one is looking at a row the database has not seen.
 */
export function labCompletionFrom(facts: LabCompletionFacts): LabCompletion {
  const { session, scenario, report } = facts;
  if (session.id === null) {
    throw new Error("a lab session has to be saved before its result can be filed");
  }

  return {
    sessionId: inAppSessionKey(session.id),
    learnerEmail: facts.learnerEmail.trim().toLowerCase(),
    scenarioId: facts.familyScenarioId,
    scenarioSlug: scenario.id,
    score: Math.round(report.score),
    maxScore: LAB_MAX_SCORE,
    passScore: facts.passScore ?? Math.round(scenario.passScore),
    // The clock starts when the machine was handed over, which is when the student could
    // first touch it; a session that never became ready falls back to when it was asked for.
    startedAt: parseIso(session.readyAt) ?? parseIso(session.createdAt),
    completedAt: parseIso(report.createdAt) ?? new Date(),
    checks: report.outcomes.map((outcome) => checkFor(scenario, outcome)),
  };
}

function checkFor(
  scenario: Scenario,
  outcome: ScoreReport["outcomes"][number],
): LabCompletionCheck {
  const objective = objectiveIn(scenario.objectives, outcome.objectiveId);
  const weight = Math.round(objective?.weight ?? outcome.weight ?? 0);
  return {
    checkId: outcome.objectiveId,
    // The objective's own words, so the instructor's view reads like the briefing rather
    // than like an id. A check the scenario no longer declares keeps its id as its label
    // rather than being dropped: it is evidence that something was graded.
    label: objective?.text ?? outcome.objectiveId,
    passed: outcome.passed,
    points: outcome.passed ? weight : 0,
    maxPoints: weight,
  };
}
