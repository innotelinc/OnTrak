/**
 * Decisions the admin actions make before touching the database, as pure
 * functions.
 *
 * Deletion is the destructive half of the control room, so its guard deserves
 * to be pinned down by a test: a scenario cascades from its author and every
 * attempt cascades from its scenario, which means removing one instructor can
 * silently take a whole catalog's worth of student work with it.
 */

/**
 * Why this account must not be deleted, or `null` when it is safe to remove.
 *
 * The caller counts the rows (rather than this rule querying them) so the
 * decision stays pure and testable.
 */
export function userDeleteProblem(name: string, authoredScenarios: number): string | null {
  if (authoredScenarios <= 0) return null;
  return `${name} authored ${authoredScenarios} scenario(s). Deleting the account would delete those scenarios and every attempt against them — remove the scenarios first.`;
}
