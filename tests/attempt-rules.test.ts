/**
 * Attempt-visibility tests.
 *
 * Scenarios are a shared staff catalog, but a student's attempt records are
 * not: this rule is what stops one instructor from reading another
 * instructor's cohort results. It is pure, so the whole matrix can be checked
 * without a database.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { attemptScopeWhere } from "../src/lib/attempt-rules";

test("attempt scope: an administrator sees every attempt", () => {
  assert.deepEqual(
    attemptScopeWhere({ id: "admin-1", role: "ADMIN" }, { studentIds: ["s1"], scenarioIds: ["sc1"] }),
    {},
  );
});

test("attempt scope: an instructor is limited to their students, scenarios and assignments", () => {
  const where = attemptScopeWhere(
    { id: "inst-1", role: "INSTRUCTOR" },
    { studentIds: ["s1", "s2"], scenarioIds: ["sc1"] },
  );
  assert.deepEqual(where, {
    OR: [
      { userId: { in: ["s1", "s2"] } },
      { scenarioId: { in: ["sc1"] } },
      { assignment: { createdById: "inst-1" } },
    ],
  });
});

test("attempt scope: a brand-new instructor still sees what they assign", () => {
  const where = attemptScopeWhere({ id: "inst-2", role: "INSTRUCTOR" }, { studentIds: [], scenarioIds: [] });
  assert.deepEqual(where, {
    OR: [
      { userId: { in: [] } },
      { scenarioId: { in: [] } },
      { assignment: { createdById: "inst-2" } },
    ],
  });
});

test("attempt scope: a student only ever sees their own attempts", () => {
  assert.deepEqual(
    attemptScopeWhere({ id: "student-1", role: "STUDENT" }, { studentIds: ["someone-else"], scenarioIds: ["sc1"] }),
    { userId: "student-1" },
  );
});

test("attempt scope: the id lists are copied so later mutation cannot widen access", () => {
  const studentIds = ["s1"];
  const where = attemptScopeWhere({ id: "inst-1", role: "INSTRUCTOR" }, { studentIds, scenarioIds: [] });
  studentIds.push("s2");
  const or = (where as { OR: { userId?: { in: string[] } }[] }).OR;
  assert.deepEqual(or[0].userId?.in, ["s1"]);
});
