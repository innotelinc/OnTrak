/**
 * Re-grading rule tests.
 *
 * The rule decides whether a stored attempt may be scored again and what status
 * a re-grade leaves behind. Getting this wrong is destructive: re-grading an
 * in-progress attempt would mark work GRADED that the student never handed in.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { canRegrade, REGRADABLE_STATUSES, regradedStatus } from "../src/lib/grading-rules";

test("regrade: only a finished attempt can be re-scored", () => {
  assert.equal(canRegrade("SUBMITTED"), true);
  assert.equal(canRegrade("GRADED"), true);
  assert.equal(canRegrade("EXPIRED"), true);

  assert.equal(canRegrade("IN_PROGRESS"), false);
  assert.equal(canRegrade("ABANDONED"), false);
});

test("regrade: the regradable set is exactly the finished statuses", () => {
  assert.deepEqual([...REGRADABLE_STATUSES], ["SUBMITTED", "GRADED", "EXPIRED"]);
});

test("regrade: a re-grade leaves a timeout marked as expired", () => {
  assert.equal(regradedStatus("EXPIRED"), "EXPIRED");
  assert.equal(regradedStatus("SUBMITTED"), "GRADED");
  assert.equal(regradedStatus("GRADED"), "GRADED");
});
