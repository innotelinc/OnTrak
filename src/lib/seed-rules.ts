/**
 * Seed conventions (pure).
 *
 * The demo password lives here rather than inline in `prisma/seed.ts` so it has
 * exactly one definition and can be asserted against the sign-in schema in a
 * test. The bug this prevents is real: a demo password shorter than
 * `MIN_PASSWORD_LENGTH` seeds fine but can never be used to sign in, because
 * the login form rejects it before it reaches the database.
 *
 * The default below is a *placeholder that says so*, which is the posture the
 * rest of the stack takes (`INITIAL_PASSWORD=CHANGEME` and friends): a
 * deployment that forgets to set `SEED_PASSWORD` ends up with a throwaway value
 * it can see it has not chosen, rather than a password shaped like a real one.
 * A value that reads as a real credential is what the shared secret scan in
 * `scripts/secret-scan.py` exists to catch, and it is right to catch it here
 * too — the sandbox is meant to be deployed, and its seeded accounts are
 * public knowledge by design.
 */

import { MIN_PASSWORD_LENGTH } from "./auth-rules";

/** The env var a deployment sets to override the demo password. */
export const SEED_PASSWORD_ENV = "SEED_PASSWORD";

/** The demo password every seeded account gets unless overridden. */
export const DEMO_PASSWORD_DEFAULT = "change-me-ontrak";

/** The password to seed with, from the environment when present. */
export function demoPassword(env: NodeJS.ProcessEnv = process.env): string {
  return env[SEED_PASSWORD_ENV] || DEMO_PASSWORD_DEFAULT;
}

/** Whether a demo password is usable for sign-in (the form enforces this too). */
export function isUsableDemoPassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH;
}
