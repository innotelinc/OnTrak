/**
 * The inbound lab-completion boundary's rulebook.
 *
 * This is the one input the family accepts over HTTP from another product, so the
 * tests are mostly about refusal: what the door does with a body that is the wrong
 * shape, a score that is not a score, a session id that is not a key, and a clock
 * that disagrees with itself. A body it cannot place is refused with every problem
 * named, and a good one is normalised the way the route will write it.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-completion.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LAB_COMPLETION_FORMAT,
  MAX_LAB_CHECKS,
  MAX_LAB_SECONDS,
  labTimeSpentSec,
  readLabCompletion,
} from "../src/lib/lab-completion-rules";

const BODY = {
  format: LAB_COMPLETION_FORMAT,
  sessionId: "sess-2026-0001",
  learnerEmail: "Ada@Acme.Test",
  scenarioSlug: "broken-nic",
  score: 8,
  maxScore: 10,
  completedAt: "2026-10-05T09:20:00.000Z",
};

test("lab completion: a minimal body is normalised the way the route writes it", () => {
  const read = readLabCompletion(BODY);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.value.sessionId, "sess-2026-0001");
  assert.equal(read.value.learnerEmail, "ada@acme.test", "the email is lower-cased like every other door");
  assert.equal(read.value.scenarioSlug, "broken-nic");
  assert.equal(read.value.scenarioId, null);
  assert.equal(read.value.score, 8);
  assert.equal(read.value.maxScore, 10);
  assert.equal(read.value.passScore, null, "absent means use the scenario's own mark");
  assert.equal(read.value.startedAt, null);
  assert.equal(read.value.completedAt.toISOString(), "2026-10-05T09:20:00.000Z");
  assert.deepEqual(read.value.checks, []);
});

test("lab completion: a full body keeps its checks, pass mark and start", () => {
  const read = readLabCompletion({
    ...BODY,
    passScore: 70,
    startedAt: "2026-10-05T09:00:00.000Z",
    checks: [
      { checkId: "nic-up", label: "NIC is up", passed: true, points: 4, maxPoints: 4 },
      { checkId: "route", label: "Route is present", passed: false, points: 0, maxPoints: 6 },
    ],
  });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.value.passScore, 70);
  assert.equal(read.value.startedAt?.toISOString(), "2026-10-05T09:00:00.000Z");
  assert.deepEqual(read.value.checks.map((check) => check.checkId), ["nic-up", "route"]);
  assert.equal(
    labTimeSpentSec(read.value.startedAt, read.value.completedAt),
    1200,
    "20 minutes between start and completion",
  );
});

test("lab completion: the format, when present, has to be this one", () => {
  const read = readLabCompletion({ ...BODY, format: "something/else" });
  assert.equal(read.ok, false);
  if (!read.ok) assert.match(read.issues.join(" "), /`format` must be "ontrak\.lab\.completion\/v1"/);
  // Omitting it is fine — the shape is checked field by field regardless.
  const { format: _dropped, ...withoutFormat } = BODY;
  assert.equal(readLabCompletion(withoutFormat).ok, true);
});

test("lab completion: a session id is a key, not free text", () => {
  for (const sessionId of ["", "   ", "has space", "quote'", "x".repeat(121)]) {
    const read = readLabCompletion({ ...BODY, sessionId });
    assert.equal(read.ok, false, `"${sessionId}" must be refused`);
  }
  const read = readLabCompletion({ ...BODY, sessionId: "a.b_c-d:e123" });
  assert.equal(read.ok, true);
});

test("lab completion: a learner, a scenario and a score are all required", () => {
  const read = readLabCompletion({ sessionId: "s1", completedAt: "2026-10-05T09:20:00.000Z" });
  assert.equal(read.ok, false);
  if (!read.ok) {
    const joined = read.issues.join(" ");
    assert.match(joined, /no `learnerEmail`/);
    assert.match(joined, /names no scenario/);
    assert.match(joined, /`score` must be a whole number/);
    assert.match(joined, /`maxScore` must be a whole number/);
  }
});

test("lab completion: a score that is not a score is refused, not clamped", () => {
  const outOfRange = readLabCompletion({ ...BODY, score: 11 });
  assert.equal(outOfRange.ok, false);
  if (!outOfRange.ok) assert.match(outOfRange.issues.join(" "), /`score` 11 is greater than `maxScore` 10/);

  const fractional = readLabCompletion({ ...BODY, score: 7.5 });
  assert.equal(fractional.ok, false);

  const zeroMax = readLabCompletion({ ...BODY, score: 0, maxScore: 0 });
  assert.equal(zeroMax.ok, false, "a scenario worth nothing cannot be graded");

  const negative = readLabCompletion({ ...BODY, score: -1 });
  assert.equal(negative.ok, false);

  const huge = readLabCompletion({ ...BODY, score: 1_000_000_000, maxScore: 1_000_000_000 });
  assert.equal(huge.ok, false, "a score past the cap cannot overflow the Int column");
});

test("lab completion: the clock has to agree with itself", () => {
  const bad = readLabCompletion({ ...BODY, completedAt: "yesterday" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.issues.join(" "), /`completedAt` must be an ISO-8601 date-time/);

  const backwards = readLabCompletion({ ...BODY, startedAt: "2026-10-05T10:00:00.000Z" });
  assert.equal(backwards.ok, false);
  if (!backwards.ok) assert.match(backwards.issues.join(" "), /`startedAt` is after `completedAt`/);

  const badStart = readLabCompletion({ ...BODY, startedAt: "not a time" });
  assert.equal(badStart.ok, false);
});

test("lab completion: a check list is bounded and each check has to add up", () => {
  const notAList = readLabCompletion({ ...BODY, checks: "none" });
  assert.equal(notAList.ok, false);
  if (!notAList.ok) assert.match(notAList.issues.join(" "), /`checks` must be a list/);

  const tooMany = readLabCompletion({
    ...BODY,
    checks: Array.from({ length: MAX_LAB_CHECKS + 1 }, (_, index) => ({
      checkId: `c${index}`,
      label: `check ${index}`,
      passed: true,
      points: 1,
      maxPoints: 1,
    })),
  });
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.match(tooMany.issues.join(" "), /at most 200 are accepted/);

  const badCheck = readLabCompletion({
    ...BODY,
    checks: [{ checkId: "", label: "x", passed: "yes", points: 5, maxPoints: 2 }],
  });
  assert.equal(badCheck.ok, false);
  if (!badCheck.ok) {
    const joined = badCheck.issues.join(" ");
    assert.match(joined, /Check 0/);
    assert.match(joined, /`checkId`/);
  }

  const pointsOver = readLabCompletion({
    ...BODY,
    checks: [{ checkId: "c1", label: "x", passed: true, points: 5, maxPoints: 2 }],
  });
  assert.equal(pointsOver.ok, false);
  if (!pointsOver.ok) assert.match(pointsOver.issues.join(" "), /points cannot exceed maxPoints/);
});

test("lab completion: the time on task is clamped so it cannot overflow a column", () => {
  const completed = new Date("2026-10-05T09:20:00.000Z");
  assert.equal(labTimeSpentSec(null, completed), 0, "no start means no measured time");
  assert.equal(labTimeSpentSec(completed, completed), 0);
  // A wrong clock (start in 1970) is a week at most, not four billion seconds.
  assert.equal(labTimeSpentSec(new Date("1970-01-01T00:00:00.000Z"), completed), MAX_LAB_SECONDS);
  // A start after the end cannot produce a negative number.
  assert.equal(labTimeSpentSec(new Date("2026-10-06T00:00:00.000Z"), completed), 0);
});
