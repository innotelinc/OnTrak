/**
 * Admin-guard tests.
 *
 * Deleting an account is the most destructive action in the control room:
 * scenarios cascade from their author and attempts cascade from their
 * scenario. These pin the guard that stops it happening by accident.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { userDeleteProblem } from "../src/lib/admin-rules";

test("admin: an account with no authored work is safe to delete", () => {
  assert.equal(userDeleteProblem("Ada Lovelace", 0), null);
});

test("admin: an author is protected, and the message says what will be lost", () => {
  const problem = userDeleteProblem("Grace Hopper", 3);
  assert.ok(problem);
  assert.match(problem, /Grace Hopper authored 3 scenario\(s\)/);
  assert.match(problem, /every attempt against them/);
});

test("admin: a negative count is treated as none rather than as a guard", () => {
  assert.equal(userDeleteProblem("Nobody", -1), null);
});
