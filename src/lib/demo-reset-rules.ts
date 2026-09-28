/**
 * Demo-reset selection rules.
 *
 * The seeded lab is meant to be handed to a cohort over and over, but state
 * accumulates: a student exhausts an assignment's attempt cap, and the browser
 * accessibility sweep leaves synthetic `a11y-*` accounts behind. None of that is
 * part of the demo, so this module names exactly what a reset removes while the
 * script that applies it stays thin and testable.
 *
 * Kept pure and dependency-free so it can be unit tested without a database.
 */

/** The seeded student accounts. Their attempts are cleared, but the accounts stay. */
export const DEMO_STUDENT_EMAILS = [
  "student@ontrak.local",
  "katherine@ontrak.local",
  "linus@ontrak.local",
] as const;

/** Accounts created by the browser test runs, e.g. `a11y-1727000000000@ontrak.local`. */
const SYNTHETIC_A11Y_EMAIL = /^a11y-\d+@ontrak\.local$/i;

/** A synthetic account created by a test run rather than a person. */
export function isSyntheticA11yEmail(email: string): boolean {
  return SYNTHETIC_A11Y_EMAIL.test(email.trim());
}

/** One of the seeded demo students whose attempts a reset clears. */
export function isDemoStudentEmail(email: string): boolean {
  return (DEMO_STUDENT_EMAILS as readonly string[]).includes(email.trim().toLowerCase());
}

/**
 * A user the reset deletes outright. Demo students are kept — their accounts are
 * part of the lab — so only the synthetic test accounts go.
 */
export function shouldDeleteUser(email: string): boolean {
  return isSyntheticA11yEmail(email);
}

/**
 * Whether an account's attempts are cleared by a reset. Demo students keep the
 * account and lose their attempts (which is what un-blocks an exhausted attempt
 * cap); a synthetic account is deleted whole, taking its attempts with it.
 */
export function shouldClearAttempts(email: string): boolean {
  return isDemoStudentEmail(email) || isSyntheticA11yEmail(email);
}
