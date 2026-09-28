/**
 * Tests for the demo-reset selection rules.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/demo-reset.test.ts
 *
 * The script itself only applies these rules, so pinning them here is what keeps
 * "reset the lab" from also wiping something it should not.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEMO_STUDENT_EMAILS,
  isDemoStudentEmail,
  isSyntheticA11yEmail,
  shouldClearAttempts,
  shouldDeleteUser,
} from "../src/lib/demo-reset-rules";

test("every seeded demo student is recognised, case-insensitively and trimmed", () => {
  for (const email of DEMO_STUDENT_EMAILS) {
    assert.equal(isDemoStudentEmail(email), true, email);
    assert.equal(isDemoStudentEmail(`  ${email.toUpperCase()} `), true, email);
  }
  assert.equal(isDemoStudentEmail("admin@ontrak.local"), false);
  assert.equal(isDemoStudentEmail("instructor@ontrak.local"), false);
});

test("synthetic a11y accounts are matched by their timestamp suffix only", () => {
  assert.equal(isSyntheticA11yEmail("a11y-1727000000000@ontrak.local"), true);
  assert.equal(isSyntheticA11yEmail("a11y-1@ontrak.local"), true);
  // A real person's address that merely starts with a11y is not touched.
  assert.equal(isSyntheticA11yEmail("a11y-team@ontrak.local"), false);
  assert.equal(isSyntheticA11yEmail("a11y-123@example.com"), false);
});

test("the reset deletes synthetic accounts but never a seeded demo student", () => {
  for (const email of DEMO_STUDENT_EMAILS) assert.equal(shouldDeleteUser(email), false, email);
  assert.equal(shouldDeleteUser("a11y-1727000000000@ontrak.local"), true);
  assert.equal(shouldDeleteUser("admin@ontrak.local"), false);
});

test("attempts are cleared for demo students and synthetic accounts, no one else", () => {
  assert.equal(shouldClearAttempts("student@ontrak.local"), true);
  assert.equal(shouldClearAttempts("a11y-1727000000000@ontrak.local"), true);
  assert.equal(shouldClearAttempts("admin@ontrak.local"), false);
  assert.equal(shouldClearAttempts("katherine@ontrak.local"), true);
});
