/**
 * The classroom-completion boundary's rulebook.
 *
 * This is the second input the family accepts over HTTP from another product, so
 * the tests are mostly about refusal: what the door does with a body that is the
 * wrong shape, a score that is not a score, a completion id that is not a key, and
 * a clock that disagrees with itself. A body it cannot place is refused with every
 * problem named, and a good one is normalised the way the route will write it.
 *
 * The record itself is a database write and is not exercised here; what *is*
 * exercised is every decision that write makes — whether a certificate is issued,
 * what it names, what competencies it carries — because those are pure and are the
 * part a mistake would make hard to notice later.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/classroom-completion.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLASSROOM_COMPLETION_FORMAT,
  DEFAULT_CLASSROOM_PASS_SCORE,
  MAX_CLASSROOM_CHECKS,
  MAX_CLASSROOM_SECONDS,
  classroomCertificateFacts,
  classroomCompletionPassed,
  classroomPassScore,
  classroomSkills,
  classroomTimeSpentSec,
  readClassroomCompletion,
  type ClassroomCompletion,
} from "../src/lib/classroom-completion-rules";
import { certificatePatchFor, recordIntact } from "../src/lib/certificates";

const BODY = {
  format: CLASSROOM_COMPLETION_FORMAT,
  completionId: "openmaic:cls-1:learner-1:lesson-3",
  learnerEmail: "Ada@Acme.Test",
  course: { ref: "ITSP101", title: "IT Support Foundations" },
  lesson: { ref: "chapter-3", title: "Accounts and access" },
  score: 8,
  maxScore: 10,
  completedAt: "2026-10-05T09:20:00.000Z",
};

/** Read a body the test expects to be usable. */
function read(body: unknown = BODY): ClassroomCompletion {
  const result = readClassroomCompletion(body);
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join(" | "));
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

test("classroom completion: a minimal body is normalised the way the route writes it", () => {
  const value = read();
  assert.equal(value.completionId, "openmaic:cls-1:learner-1:lesson-3");
  assert.equal(value.learnerEmail, "ada@acme.test", "the email is lower-cased like every other door");
  assert.equal(value.courseRef, "ITSP101");
  assert.equal(value.courseTitle, "IT Support Foundations");
  assert.equal(value.lessonRef, "chapter-3");
  assert.equal(value.lessonTitle, "Accounts and access");
  assert.equal(value.score, 8);
  assert.equal(value.maxScore, 10);
  assert.equal(value.passScore, null, "absent means the shipped default, not zero");
  assert.equal(classroomPassScore(value), DEFAULT_CLASSROOM_PASS_SCORE);
  assert.equal(value.startedAt, null);
  assert.deepEqual(value.checks, []);
  assert.deepEqual(value.skills, []);
});

test("classroom completion: a full body keeps its pass mark, start, checks and skills", () => {
  const value = read({
    ...BODY,
    passScore: 60,
    startedAt: "2026-10-05T09:00:00.000Z",
    checks: [
      { checkId: "quiz-1", label: "Recognises an expired password", passed: true, points: 1, maxPoints: 1, skill: "Account administration" },
      { checkId: "quiz-2", label: "Explains MFA enrolment", passed: false, points: 0, maxPoints: 1 },
    ],
    skills: ["Helpdesk practice"],
  });
  assert.equal(value.passScore, 60);
  assert.equal(value.startedAt?.toISOString(), "2026-10-05T09:00:00.000Z");
  assert.equal(value.checks.length, 2);
  assert.equal(value.checks[0]?.skill, "Account administration");
  assert.equal(value.checks[1]?.skill, undefined);
  assert.deepEqual(value.skills, ["Helpdesk practice"]);
});

test("classroom completion: a body that is not an object says so", () => {
  const result = readClassroomCompletion(["not", "an", "object"]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.issues, ["The classroom completion is not an object."]);
});

test("classroom completion: a wrong format is named rather than ignored", () => {
  const result = readClassroomCompletion({ ...BODY, format: "ontrak.lab.completion/v1" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.issues.join(" "), /`format` must be "ontrak\.classroom\.completion\/v1"/);
});

test("classroom completion: the completion id is a key, so its shape is checked", () => {
  for (const completionId of ["", " has space", "../etc/passwd", "x".repeat(201)]) {
    const result = readClassroomCompletion({ ...BODY, completionId });
    assert.equal(result.ok, false, `"${completionId.slice(0, 20)}" should be refused`);
    if (result.ok) continue;
    assert.ok(
      result.issues.some((issue) => issue.includes("completionId")),
      result.issues.join(" | "),
    );
  }
});

test("classroom completion: the idempotency key may carry the classroom's own punctuation", () => {
  // The contract's own example is the shape a sender will produce.
  const value = read({ ...BODY, completionId: "openmaic:cls_1:learner.1:lesson-3" });
  assert.equal(value.completionId, "openmaic:cls_1:learner.1:lesson-3");
});

test("classroom completion: the documented key carries the learner's address, so `@` is allowed", () => {
  // `scripts/report-classroom-completion.py` derives
  // `openmaic:<classroom>:<learner email>:<lesson>`. A charset without `@` made
  // the door refuse the one key its own sender documents, which was found by
  // POSTing that key to a running app rather than by reading the two halves.
  const key = "openmaic:cls-1:ada@acme.test:ch-3";
  const value = read({ ...BODY, completionId: key });
  assert.equal(value.completionId, key);
  assert.equal(readClassroomCompletion({ ...BODY, completionId: "openmaic:a b@c.test" }).ok, false,
    "allowing `@` must not turn the key into free text");
});

test("classroom completion: the learner must be an address", () => {
  const missing = readClassroomCompletion({ ...BODY, learnerEmail: "" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.issues.join(" "), /no `learnerEmail`/);

  const bad = readClassroomCompletion({ ...BODY, learnerEmail: "not-an-address" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.issues.join(" "), /is not an email address/);
});

test("classroom completion: a course and a lesson are both required, with a reference and a title", () => {
  const noCourse = readClassroomCompletion({ ...BODY, course: undefined });
  assert.equal(noCourse.ok, false);
  if (!noCourse.ok) assert.ok(noCourse.issues.some((issue) => issue.includes("`course` object")));

  const noTitle = readClassroomCompletion({ ...BODY, course: { ref: "ITSP101" } });
  assert.equal(noTitle.ok, false);
  if (!noTitle.ok) assert.match(noTitle.issues.join(" "), /course\.title/);

  const noLesson = readClassroomCompletion({ ...BODY, lesson: { title: "Accounts" } });
  assert.equal(noLesson.ok, false);
  if (!noLesson.ok) assert.match(noLesson.issues.join(" "), /lesson\.ref/);
});

test("classroom completion: a score is whole, within its maximum, and the maximum is not zero", () => {
  for (const body of [
    { ...BODY, score: 7.5 },
    { ...BODY, score: -1 },
    { ...BODY, maxScore: 0 },
    { ...BODY, score: 11 },
    { ...BODY, maxScore: "10" },
  ]) {
    assert.equal(readClassroomCompletion(body).ok, false, JSON.stringify(body));
  }
});

test("classroom completion: a pass mark outside 0-100 is refused", () => {
  const high = readClassroomCompletion({ ...BODY, passScore: 101 });
  assert.equal(high.ok, false);
  if (!high.ok) assert.match(high.issues.join(" "), /passScore/);

  const fractional = readClassroomCompletion({ ...BODY, passScore: 69.5 });
  assert.equal(fractional.ok, false);
});

test("classroom completion: a completion instant is required, and the clock cannot run backwards", () => {
  const missing = readClassroomCompletion({ ...BODY, completedAt: undefined });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.issues.join(" "), /completedAt/);

  const backwards = readClassroomCompletion({
    ...BODY,
    startedAt: "2026-10-05T09:30:00.000Z",
    completedAt: "2026-10-05T09:20:00.000Z",
  });
  assert.equal(backwards.ok, false);
  if (!backwards.ok) assert.match(backwards.issues.join(" "), /startedAt` is after/);
});

test("classroom completion: checks are bounded and their points cannot exceed their maximum", () => {
  const notList = readClassroomCompletion({ ...BODY, checks: { a: 1 } });
  assert.equal(notList.ok, false);
  if (!notList.ok) assert.match(notList.issues.join(" "), /`checks` must be a list/);

  const tooMany = readClassroomCompletion({
    ...BODY,
    checks: Array.from({ length: MAX_CLASSROOM_CHECKS + 1 }, (_, index) => ({
      checkId: `c-${index}`,
      label: "check",
      passed: true,
      points: 1,
      maxPoints: 1,
    })),
  });
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.match(tooMany.issues.join(" "), /at most 200/);

  const over = readClassroomCompletion({
    ...BODY,
    checks: [{ checkId: "c-1", label: "check", passed: true, points: 2, maxPoints: 1 }],
  });
  assert.equal(over.ok, false);
  if (!over.ok) assert.match(over.issues.join(" "), /points cannot exceed maxPoints/);
});

test("classroom completion: skills are a bounded list of non-empty names", () => {
  const notList = readClassroomCompletion({ ...BODY, skills: "account administration" });
  assert.equal(notList.ok, false);
  if (!notList.ok) assert.match(notList.issues.join(" "), /`skills` must be a list/);

  const blank = readClassroomCompletion({ ...BODY, skills: ["ok", "  "] });
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.match(blank.issues.join(" "), /Skill 1 is empty/);

  const tooMany = readClassroomCompletion({
    ...BODY,
    skills: Array.from({ length: 13 }, (_, index) => `skill-${index}`),
  });
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.match(tooMany.issues.join(" "), /at most 12/);
});

test("classroom completion: every problem is named at once, so one pass fixes the body", () => {
  const result = readClassroomCompletion({ completionId: "has space", score: 1.5 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.length >= 6, result.issues.join(" | "));
  assert.ok(result.issues.some((issue) => issue.includes("completionId")));
  assert.ok(result.issues.some((issue) => issue.includes("learnerEmail")));
  assert.ok(result.issues.some((issue) => issue.includes("`course` object")));
  assert.ok(result.issues.some((issue) => issue.includes("`lesson` object")));
  assert.ok(result.issues.some((issue) => issue.includes("`score`")));
  assert.ok(result.issues.some((issue) => issue.includes("completedAt")));
});

test("classroom completion: a pass issues a stored, intact record naming the course", () => {
  const completion = read();
  const facts = classroomCertificateFacts(completion, { id: "u-1", name: "Ada Lovelace" });
  const patch = certificatePatchFor(facts, null, completion.completedAt);

  assert.equal(facts.scenarioId, "ITSP101");
  assert.equal(facts.scenarioTitle, "IT Support Foundations");
  assert.equal(facts.platform, "classroom");
  assert.equal(facts.mode, undefined, "no mode is claimed rather than a false `simulated`");
  assert.ok(patch.certificate, "8/10 clears the 70% default, so a record is issued");
  // `CertificatePatch` is Prisma's update shape, which takes a `Date` or an ISO string.
  assert.equal(new Date(patch.certificateIssuedAt as Date).toISOString(), "2026-10-05T09:20:00.000Z");

  const record = patch.certificate as unknown as Parameters<typeof recordIntact>[0];
  assert.equal(recordIntact(record), true, "the stored record verifies against its own digest");
  assert.equal(record.percent, 80);
  assert.equal(record.passed, true);
});

test("classroom completion: a failing completion issues no record at all", () => {
  const completion = read({ ...BODY, score: 6 });
  const facts = classroomCertificateFacts(completion, { id: "u-1", name: "Ada Lovelace" });
  const patch = certificatePatchFor(facts, null, completion.completedAt);
  assert.equal(patch.certificate, undefined);
  assert.equal(patch.certificateIssuedAt, undefined);
  assert.equal(classroomCompletionPassed(completion), false);
});

test("classroom completion: the reported pass mark is the one used, not the default", () => {
  const completion = read({ ...BODY, score: 6, passScore: 60 });
  const facts = classroomCertificateFacts(completion, { id: "u-1", name: "Ada Lovelace" });
  assert.equal(facts.passScore, 60);
  assert.equal(classroomCompletionPassed(completion), true, "6/10 is 60%, which clears 60%");
  assert.ok(certificatePatchFor(facts, null).certificate);
});

test("classroom completion: competency comes from the passed checks, fallback to the classroom's list", () => {
  const tagged = read({
    ...BODY,
    checks: [
      { checkId: "quiz-1", label: "a", passed: true, points: 1, maxPoints: 1, skill: "Account administration" },
      { checkId: "quiz-2", label: "b", passed: false, points: 0, maxPoints: 1, skill: "MFA enrolment" },
      { checkId: "quiz-3", label: "c", passed: true, points: 1, maxPoints: 1, skill: "Account administration" },
    ],
    skills: ["Ignored because the checks named their own"],
  });
  assert.deepEqual(classroomSkills(tagged), ["Account administration"], "a failed check proves nothing, and duplicates are one skill");

  const untagged = read({ ...BODY, skills: ["Helpdesk practice", "helpdesk practice"] });
  assert.deepEqual(classroomSkills(untagged), ["Helpdesk practice"], "the classroom's own list is the fallback, de-duplicated");
});

test("classroom completion: time spent is clamped, and an absent start is zero", () => {
  const start = new Date("2026-10-05T09:00:00.000Z");
  const end = new Date("2026-10-05T09:20:00.000Z");
  assert.equal(classroomTimeSpentSec(null, end), 0);
  assert.equal(classroomTimeSpentSec(start, end), 1200);
  assert.equal(
    classroomTimeSpentSec(new Date("2020-01-01T00:00:00.000Z"), end),
    MAX_CLASSROOM_SECONDS,
    "an implausible clock cannot overflow the column",
  );
});
