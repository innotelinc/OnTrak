/**
 * Rubric bands and competencies (2.2), as rules rather than as prose.
 *
 * Two questions live here, and both are pure for the same reason the grader is:
 * a report has to be reproducible from its snapshot, so nothing that decides
 * points or claims a competence may depend on a clock, a locale or a database.
 *
 * **A band is 0, half or full.** The half condition is authored as an ordinary
 * check attached to its parent by `halfOf` (see `sim/types.ts`), which is
 * evaluated by the same evaluator as every other check. This module only says
 * what half of a check's points *is*.
 *
 * **A competency is earned, not declared.** The certificate's skills are read from
 * the checks that carry a `competency` and reached **full** credit, so a claim on
 * a record can always be traced back to the work that proved it. A half band is
 * deliberately not enough: it says the learner is partway there, which is exactly
 * the thing a competence record must not round up. `certificateSkillsFor` keeps
 * the old scenario tags as the fallback for scenarios that tag no check, so a
 * catalog authored before 2.2 keeps issuing the records it always did.
 */

import type { CheckEvaluation, CompetencyTally } from "./sim/types";

/**
 * Half of a check's points, as a whole number.
 *
 * `validate.ts` requires an even total of at least 2 on any check that has a half
 * band, so this is exactly half rather than a rounding rule nobody can predict.
 * It still floors, because a hand-written definition that skipped the validator
 * (or an old bundle) must grade to *something* rather than to NaN.
 */
export function halfCreditFor(points: number): number {
  if (!Number.isFinite(points) || points <= 0) return 0;
  return Math.floor(points / 2);
}

/**
 * One entry per competency the report's checks name, in author order.
 *
 * Two spellings of one skill are one competency, keyed case- and
 * whitespace-insensitively — the same rule the skills matrix uses, because a
 * certificate that wrote `Linux` and `linux` would open two columns for one
 * competence. The label is the first spelling seen, which is the author's.
 */
export function competencyTally(results: readonly CheckEvaluation[]): CompetencyTally[] {
  const byKey = new Map<string, CompetencyTally>();
  for (const result of results) {
    const skill = (result.competency ?? "").trim();
    if (skill === "") continue;
    const key = skill.toLowerCase();
    let tally = byKey.get(key);
    if (tally === undefined) {
      tally = { skill, earned: false, checkIds: [], earnedCheckIds: [] };
      byKey.set(key, tally);
    }
    if (!tally.checkIds.includes(result.checkId)) tally.checkIds.push(result.checkId);
    // `band` is the 2.2 answer; `passed` is the same question for a caller that
    // built an evaluation before bands existed (a stored row read back).
    if (result.band === "full" || (result.band === undefined && result.passed)) {
      tally.earned = true;
      if (!tally.earnedCheckIds.includes(result.checkId)) tally.earnedCheckIds.push(result.checkId);
    }
  }
  return [...byKey.values()];
}

/** The competencies a report earned, in author order. */
export function earnedCompetencies(results: readonly CheckEvaluation[]): string[] {
  return competencyTally(results)
    .filter((tally) => tally.earned)
    .map((tally) => tally.skill);
}

/**
 * What a certificate should carry as its competencies.
 *
 * A scenario that tags at least one check gets the earned tags, and nothing else:
 * the record then names evidence. A scenario that tags no check keeps the tags it
 * always had, because a catalog written before per-check tagging must not start
 * issuing certificates with no skills — including one whose checks all landed in
 * the half band, which is a report with no competence to attest rather than a
 * reason to fall back to a scenario-wide label.
 */
export function certificateSkillsFor(
  results: readonly CheckEvaluation[],
  fallbackTags: readonly string[] | undefined,
): string[] {
  if (competencyTally(results).length === 0) return [...(fallbackTags ?? [])];
  return earnedCompetencies(results);
}
