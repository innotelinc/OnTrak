/**
 * One answer to "how well was this attempt scored, and did it clear the bar?"
 *
 * Six surfaces used to answer that question independently — the simulator's
 * report, the webhook payload, the results API, the CSV export, the certificate
 * and four screens — and they disagreed in the one case that matters: a
 * scenario worth zero points. `sim/grade.ts` called it **100%**, the certificate
 * and the results feed called it **0%**, and the webhook refused to call it a
 * pass at all — so the same attempt could be a pass on the learner's page and
 * not a pass in the payload their employer received.
 *
 * The rule here is the webhook's, because it is the only one that said why:
 * **a scenario worth zero points is not a pass.** Nothing was asked, so nothing
 * was demonstrated; a percentage of "nothing" is as misleading as a certificate
 * for it. `validate.ts` already warns an author that such a scenario is worth
 * zero points, so the honest reading of that warning is "this cannot be graded",
 * not "this passed".
 *
 * Import-free on purpose, so the same definition can be used by a browser
 * component, a route handler and the Node-only signing path alike.
 */

/**
 * Whole-percent score, 0–100, integer-rounded. A scenario worth nothing is 0%.
 *
 * Rounded rather than fractional because this is the number a person reads and
 * the number a certificate stores. The one caller that wants a fractional mean
 * (`analytics-rules.ts`, averaging many attempts) computes its own and says so.
 */
export function scorePercent(score: number, maxScore: number): number {
  if (!Number.isFinite(maxScore) || maxScore <= 0) return 0;
  const value = (score / maxScore) * 100;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Did this attempt clear its scenario's pass mark?
 *
 * The mark is a *percentage*, so the score is compared as one: a raw
 * `score >= passScore` calls an 8/10 attempt a failure against a 70% mark. A
 * scenario worth zero points cannot pass, even at a 0% mark — hence the guard
 * rather than a comparison against the percentage alone.
 *
 * A pass mark that is not a finite number is read as 0, so a bad value in a
 * payload cannot turn every attempt into a failure.
 */
export function clearedPassMark(input: {
  score: number;
  maxScore: number;
  passScore: number;
}): boolean {
  if (!(input.maxScore > 0)) return false;
  const mark = Number.isFinite(input.passScore) ? input.passScore : 0;
  return scorePercent(input.score, input.maxScore) >= mark;
}
