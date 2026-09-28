/**
 * Seed credential guard.
 *
 * A demo password that fails the sign-in schema is a nasty bug: `db:seed`
 * reports success, the accounts exist, and signing in still says "that email
 * and password combination did not match". These tests pin the invariant so the
 * seed can never drift below the form's minimum length again.
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CREDENTIALS, MIN_PASSWORD_LENGTH } from "../src/lib/auth-rules";
import { DEMO_PASSWORD_DEFAULT, demoPassword, isUsableDemoPassword } from "../src/lib/seed-rules";

/** The demo accounts the seed provisions (see README "Demo accounts"). */
const DEMO_EMAILS = [
  "admin@ontrak.local",
  "instructor@ontrak.local",
  "student@ontrak.local",
  "katherine@ontrak.local",
  "linus@ontrak.local",
];

/** Parse exactly what the sign-in form would send. */
function parses(email: string, password: string): boolean {
  return CREDENTIALS.safeParse({ email, password }).success;
}

test("seed: the default demo password satisfies the sign-in schema", () => {
  assert.equal(
    isUsableDemoPassword(DEMO_PASSWORD_DEFAULT),
    true,
    `the demo password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  );
  assert.equal(parses("student@ontrak.local", DEMO_PASSWORD_DEFAULT), true);
});

test("seed: every demo account can actually sign in", () => {
  for (const email of DEMO_EMAILS) {
    assert.equal(parses(email, demoPassword()), true, `${email} should be a usable demo login`);
  }
});

test("seed: SEED_PASSWORD overrides the default", () => {
  assert.equal(demoPassword({ SEED_PASSWORD: "a-longer-passphrase" } as unknown as NodeJS.ProcessEnv), "a-longer-passphrase");
  assert.equal(demoPassword({} as unknown as NodeJS.ProcessEnv), DEMO_PASSWORD_DEFAULT);
});

test("seed: a too-short password is exactly what the schema rejects", () => {
  // The regression this guards against: the old default was six characters.
  assert.equal(parses("student@ontrak.local", "ontrak"), false);
});
