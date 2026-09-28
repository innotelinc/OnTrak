/**
 * Seed conventions (pure).
 *
 * The demo password lives here rather than inline in `prisma/seed.ts` so it has
 * exactly one definition and can be asserted against the sign-in schema in a
 * test. The bug this prevents is real: a demo password shorter than
 * `MIN_PASSWORD_LENGTH` seeds fine but can never be used to sign in, because
 * the login form rejects it before it reaches the database.
 */

import { MIN_PASSWORD_LENGTH } from "./auth-rules";

/** The env var a deployment sets to override the demo password. */
export const SEED_PASSWORD_ENV = "SEED_PASSWORD";

/** The demo password every seeded account gets unless overridden. */
export const DEMO_PASSWORD_DEFAULT = "ontrak-demo";

/** The password to seed with, from the environment when present. */
export function demoPassword(env: NodeJS.ProcessEnv = process.env): string {
  return env[SEED_PASSWORD_ENV] || DEMO_PASSWORD_DEFAULT;
}

/** Whether a demo password is usable for sign-in (the form enforces this too). */
export function isUsableDemoPassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH;
}
