/**
 * The two halves of FAST AI that decide whether a provider gets *paid*.
 *
 * A course inside the funder's ceilings can still earn nothing, and the RFQ says so in as many
 * words: a slot delivered past the per-employer cap, or to an employer without a current
 * eligibility confirmation memo, "is not reimbursable, and the selected Applicant carries that
 * risk", and "CommCorp will only pay for course completions". Those are the rules here, in the
 * same pure functions the enrolment action refuses with and the tenancy page reports through.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/fast-ai-compliance.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { FAST_AI_CLASS_PLAN, FAST_AI_COURSES, FAST_AI_SPONSOR_FEIN } from "../prisma/seed-fast-ai";
import {
  FAST_AI_CONTRACT_END,
  FAST_AI_DESCRIPTION_WORDS,
  FAST_AI_EMPLOYER_SLOT_CAP,
  FAST_AI_MAX_COURSES,
  FAST_AI_TOPIC_AREAS,
  courseSubmissionProblems,
  eligibilityProblems,
  employerSlotUsage,
  offeringSeatProblems,
  slotRequestProblems,
  unrecognisedTopics,
  wordCount,
  type EmployerSlotRow,
} from "../src/lib/program-rules";
import { reportSummary, type ReportRow } from "../src/lib/program-report";

/** One delivered slot, with everything but the fields under test defaulted. */
function slot(overrides: Partial<EmployerSlotRow>): EmployerSlotRow {
  return {
    employerId: "org-charles-river",
    employerName: "Charles River Home Care",
    enrolledOn: "2027-03-01",
    status: "COMPLETED",
    present: 2,
    pricePerSlotCents: 180_000,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  The per-employer cap (RFQ §1.5, §4.1, §4.2)                               */
/* -------------------------------------------------------------------------- */

test("cap: delivered slots are counted across every class, not per class", () => {
  // The RFQ counts them "per employer, per approved Applicant, over the contract term", so a
  // provider running four classes for one employer has one running total and one cap.
  const usage = employerSlotUsage(
    [
      slot({ enrolledOn: "2027-03-01" }),
      slot({ enrolledOn: "2027-04-01" }),
      slot({ enrolledOn: "2027-05-01" }),
    ],
    FAST_AI_EMPLOYER_SLOT_CAP,
  );

  assert.equal(usage.length, 1);
  assert.equal(usage[0].slotsUsed, 3);
  assert.equal(usage[0].remaining, 97);
  assert.equal(usage[0].reimbursableCompletions, 3);
  assert.equal(usage[0].reimbursableCents, 540_000);
});

test("cap: it consumes slots in delivery order, so the last completions are the unpaid ones", () => {
  const seven = Array.from({ length: 7 }, (_, index) =>
    slot({ enrolledOn: `2027-03-0${index + 1}` }),
  );
  const [usage] = employerSlotUsage(seven, 4);

  assert.equal(usage.slotsUsed, 7);
  assert.equal(usage.slotsWithinCap, 4);
  assert.equal(usage.reimbursableCompletions, 4);
  assert.equal(usage.unreimbursedCompletions, 3, "the three completions past the cap");
  assert.equal(usage.remaining, 0);
  assert.equal(usage.reimbursableCents, 720_000, "four slots at $1,800, not seven");
});

test("cap: a withdrawal after attendance took a slot, one who never turned up did not", () => {
  // A seat is delivered when somebody sat in it. Enrolment on its own is a plan, and a learner
  // who withdrew after attending was trained — the funder pays nothing for that either way, but
  // the slot is gone from the employer's allowance.
  const [usage] = employerSlotUsage(
    [
      slot({ enrolledOn: "2027-03-01", status: "WITHDRAWN", present: 2 }),
      slot({ enrolledOn: "2027-03-02", status: "WITHDRAWN", present: 0 }),
      slot({ enrolledOn: "2027-03-03", status: "ENROLLED", present: 0 }),
    ],
    FAST_AI_EMPLOYER_SLOT_CAP,
  );

  assert.equal(usage.slotsUsed, 1);
  assert.equal(usage.completions, 0);
  assert.equal(usage.reimbursableCents, 0);
  assert.equal(usage.remaining, 99);
});

test("cap: completions delivered after the cap are delivered, completed and unpaid", () => {
  // The failure this exists to make visible: 100 slots already taken, then two learners finish.
  const full = Array.from({ length: 100 }, (_, index) =>
    slot({ status: "ATTENDED", enrolledOn: new Date(Date.UTC(2027, 0, 1, 0, index)), present: 1 }),
  );
  const [usage] = employerSlotUsage(
    [...full, slot({ enrolledOn: "2027-06-01" }), slot({ enrolledOn: "2027-06-02" })],
    FAST_AI_EMPLOYER_SLOT_CAP,
  );

  assert.equal(usage.slotsUsed, 102);
  assert.equal(usage.slotsWithinCap, 100);
  assert.equal(usage.completions, 2);
  assert.equal(usage.reimbursableCompletions, 0, "the cap was already spent");
  assert.equal(usage.unreimbursedCompletions, 2);
  assert.equal(usage.reimbursableCents, 0);
});

test("cap: a program that caps nothing leaves every completion reimbursable", () => {
  const many = Array.from({ length: 150 }, (_, index) =>
    slot({ enrolledOn: new Date(Date.UTC(2027, 2, 1 + (index % 28), 0, index)) }),
  );
  const [usage] = employerSlotUsage(many, null);

  assert.equal(usage.cap, null);
  assert.equal(usage.remaining, null);
  assert.equal(usage.unreimbursedCompletions, 0);
  assert.equal(usage.reimbursableCompletions, 150);
});

test("cap: a class nobody sponsored takes no employer's slot", () => {
  const usage = employerSlotUsage([slot({ employerId: null }), slot({})], FAST_AI_EMPLOYER_SLOT_CAP);

  assert.equal(usage.length, 1, "an unsponsored class is not an employer's");
  assert.equal(usage[0].slotsUsed, 1);
});

test("cap: employers are counted separately, and the one past its cap reads first", () => {
  const usage = employerSlotUsage(
    [
      ...[1, 2, 3].map((day) => slot({ employerId: "org-a", employerName: "Alpha Care", enrolledOn: `2027-04-0${day}` })),
      ...[1, 2, 3, 4, 5, 6].map((day) =>
        slot({ employerId: "org-b", employerName: "Beta Care", enrolledOn: `2027-05-0${day}` }),
      ),
    ],
    4,
  );

  assert.equal(usage.length, 2);
  assert.equal(usage[0].employerId, "org-b");
  assert.equal(usage[0].employerName, "Beta Care");
  assert.equal(usage[0].unreimbursedCompletions, 2);
  assert.equal(usage[0].remaining, 0);
  assert.equal(usage[1].employerId, "org-a");
  assert.equal(usage[1].remaining, 1);
});

test("cap: the next seat is refused in words, with the number that decided it", () => {
  assert.deepEqual(
    slotRequestProblems({ employerName: "Charles River Home Care", slotsUsed: 96, cap: 100 }, 1),
    [],
    "the 97th slot is inside the cap",
  );

  const last = slotRequestProblems({ employerName: "Charles River Home Care", slotsUsed: 100, cap: 100 }, 1);
  assert.equal(last.length, 1);
  assert.match(last[0].message, /all 100 of its slots/);
  assert.match(last[0].message, /not reimbursable/);

  const tooMany = slotRequestProblems({ employerName: "Charles River Home Care", slotsUsed: 96, cap: 100 }, 8);
  assert.match(tooMany[0].message, /4 of its 100 slots left/);

  assert.deepEqual(
    slotRequestProblems({ employerName: "Any Employer", slotsUsed: 5_000, cap: null }, 1),
    [],
    "a program that caps nothing refuses nothing",
  );
});

/* -------------------------------------------------------------------------- */
/*  Employer eligibility (RFQ §2.2, §4.2)                                     */
/* -------------------------------------------------------------------------- */

const EMPLOYER = {
  name: "Charles River Home Care",
  preRegistered: true,
  fein: "04-3681297",
  memoExpiresOn: FAST_AI_CONTRACT_END,
};

test("eligibility: a pre-registered employer with a current memo may be enrolled", () => {
  assert.deepEqual(eligibilityProblems(EMPLOYER, "2027-03-01"), []);
  // Current on the day it expires: a memo dated 2029-01-31 covers work done on 2029-01-31.
  assert.deepEqual(eligibilityProblems(EMPLOYER, FAST_AI_CONTRACT_END), []);
});

test("eligibility: an expired memo is refused, and says which day it lapsed", () => {
  const problems = eligibilityProblems(EMPLOYER, "2029-02-01");
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /expired 2029-01-31/);
  assert.match(problems[0].message, /not reimbursable/);
});

test("eligibility: no memo on file is a refusal, not an assumption", () => {
  const problems = eligibilityProblems({ ...EMPLOYER, memoExpiresOn: null }, "2027-03-01");
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /no eligibility confirmation memo/);
});

test("eligibility: an employer CommCorp has not pre-registered is refused first", () => {
  const problems = eligibilityProblems({ ...EMPLOYER, preRegistered: false }, "2027-03-01");
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /not recorded as pre-registered/);
});

test("eligibility: the FEIN has to be there and has to be a FEIN", () => {
  assert.match(eligibilityProblems({ ...EMPLOYER, fein: null }, "2027-03-01")[0].message, /no FEIN on file/);
  assert.match(eligibilityProblems({ ...EMPLOYER, fein: "  " }, "2027-03-01")[0].message, /no FEIN on file/);

  const short = eligibilityProblems({ ...EMPLOYER, fein: "04-36812" }, "2027-03-01");
  assert.match(short[0].message, /is 7 digits; a FEIN is nine/);

  // Punctuation is the provider's business; the nine digits are the funder's.
  assert.deepEqual(eligibilityProblems({ ...EMPLOYER, fein: "043681297" }, "2027-03-01"), []);
});

/* -------------------------------------------------------------------------- */
/*  What a course has to say to be submitted (RFQ §3.2, §3.3)                 */
/* -------------------------------------------------------------------------- */

const SUBMISSION = {
  title: "Applied AI for the Frontline Role",
  description: "Six hours of hands-on practice with generative AI on tasks a frontline worker already does.",
  topicAreas: ["Generative AI"],
  courses: 1,
  maxCourses: FAST_AI_MAX_COURSES,
  courseNumber: 1,
  aiTools: ["Microsoft 365 Copilot"],
  targetOccupations: "Home health aide",
  targetIndustries: "Home and community care",
  workplaceTasks: "Summarising a client's history before a visit",
  maxSlotsPerOffering: 16,
};

test("submission: the description limit is 250 words, and a description is required", () => {
  assert.deepEqual(courseSubmissionProblems(SUBMISSION), []);

  assert.match(courseSubmissionProblems({ ...SUBMISSION, description: "  " })[0].message, /has no description/);

  const atTheLimit = Array.from({ length: FAST_AI_DESCRIPTION_WORDS }, () => "word").join(" ");
  assert.deepEqual(courseSubmissionProblems({ ...SUBMISSION, description: atTheLimit }), [], "250 is allowed");

  const over = Array.from({ length: FAST_AI_DESCRIPTION_WORDS + 1 }, () => "word").join(" ");
  const problems = courseSubmissionProblems({ ...SUBMISSION, description: over });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /runs to 251 words/);
});

test("submission: a course that claims no topic area cannot be placed in the directory", () => {
  const problems = courseSubmissionProblems({ ...SUBMISSION, topicAreas: [] });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /claims no in-scope topic area/);
});

test("submission: the course limit is refused, not silently trimmed", () => {
  assert.deepEqual(courseSubmissionProblems({ ...SUBMISSION, courses: FAST_AI_MAX_COURSES }), []);
  const problems = courseSubmissionProblems({ ...SUBMISSION, courses: FAST_AI_MAX_COURSES + 1 });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /would hold 21 courses/);
  assert.match(problems[0].message, /will not consider the rest/);

  assert.deepEqual(
    courseSubmissionProblems({ ...SUBMISSION, courses: 900, maxCourses: null }),
    [],
    "a program that sets no limit accepts whatever the provider writes",
  );
});

test("submission: a course is submitted under a number of its own, 1 to 20", () => {
  assert.match(courseSubmissionProblems({ ...SUBMISSION, courseNumber: null })[0].message, /has no course number/);
  assert.match(
    courseSubmissionProblems({ ...SUBMISSION, courseNumber: 0 })[0].message,
    /is submitted as course 0/,
  );
  assert.match(
    courseSubmissionProblems({ ...SUBMISSION, courseNumber: FAST_AI_MAX_COURSES + 1 })[0].message,
    /numbers courses 1 to 20/,
  );
  // Two courses answering to "3" is a budget form nobody can read.
  const duplicate = courseSubmissionProblems({ ...SUBMISSION, courseNumber: 3, takenNumbers: [1, 3] });
  assert.equal(duplicate.length, 1);
  assert.match(duplicate[0].message, /already number 3/);
  assert.deepEqual(
    courseSubmissionProblems({ ...SUBMISSION, courseNumber: FAST_AI_MAX_COURSES, takenNumbers: [1] }),
    [],
    "course 20 is inside the range and nobody else has it",
  );
});

test("submission: the tools, occupations, industries and tasks are asked for, not assumed", () => {
  /** The §3.3 details the funder asks each course to state, absent or blank. */
  type Override = {
    aiTools?: string[];
    targetOccupations?: string | null;
    targetIndustries?: string | null;
    workplaceTasks?: string | null;
  };
  const cases: Array<[Override, RegExp]> = [
    [{ aiTools: [] }, /names no AI tools/],
    [{ targetOccupations: null }, /states no target occupations/],
    [{ targetOccupations: "  " }, /states no target occupations/],
    [{ targetIndustries: null }, /states no target industries/],
    [{ workplaceTasks: null }, /states no workplace tasks/],
  ];
  for (const [override, expected] of cases) {
    const problems = courseSubmissionProblems({ ...SUBMISSION, ...override });
    assert.equal(problems.length, 1, `${Object.keys(override)[0]} should be the only refusal`);
    assert.match(problems[0].message, expected);
  }
});

test("submission: an offering's slot ceiling is stated, and a class may not exceed it", () => {
  assert.match(
    courseSubmissionProblems({ ...SUBMISSION, maxSlotsPerOffering: null })[0].message,
    /does not say how many training slots/,
  );

  const course = { title: "Applied AI for the Frontline Role", maxSlotsPerOffering: 16 };
  assert.deepEqual(offeringSeatProblems(course, { name: "Spring 2027", seats: 16 }), [], "exactly the ceiling");
  const over = offeringSeatProblems(course, { name: "Spring 2027", seats: 20 });
  assert.equal(over.length, 1);
  assert.match(over[0].message, /at most 16 training slots/);
  assert.match(over[0].message, /offers 20 seats/);
  assert.deepEqual(offeringSeatProblems(course, { name: "Spring 2027", seats: null }), []);
  assert.deepEqual(
    offeringSeatProblems({ title: "Open course", maxSlotsPerOffering: null }, { name: "Any", seats: 400 }),
    [],
  );
});

test("submission: an unlisted topic area is named for a person, not refused", () => {
  assert.deepEqual(
    unrecognisedTopics(["Generative AI", "generative ai", " AI productivity applications "]),
    [],
    "case and padding are not a different topic",
  );
  assert.deepEqual(unrecognisedTopics(["Quantum prompting"]), ["Quantum prompting"]);
  assert.deepEqual(unrecognisedTopics([]), []);
});

test("submission: the limits are the RFQ's own numbers", () => {
  // Pinned so a change is a deliberate act: these are printed in a funder's document, not
  // invented here, and 250 words against a 100-word limit is a refused application.
  assert.equal(FAST_AI_DESCRIPTION_WORDS, 250);
  assert.equal(FAST_AI_MAX_COURSES, 20);
  assert.equal(FAST_AI_EMPLOYER_SLOT_CAP, 100);
  assert.equal(FAST_AI_TOPIC_AREAS.length, 12);
  assert.equal(wordCount("one  two\nthree"), 3);
  assert.equal(wordCount(null), 0);
});

test("submission: the seeded catalogue is a submission the funder would accept", () => {
  const numbers = FAST_AI_COURSES.map((course) => course.courseNumber);
  assert.equal(new Set(numbers).size, numbers.length, "two seeded courses share a number");

  for (const [index, course] of FAST_AI_COURSES.entries()) {
    const problems = courseSubmissionProblems({
      title: course.title,
      description: course.summary,
      topicAreas: course.topicAreas,
      courses: index + 1,
      maxCourses: FAST_AI_MAX_COURSES,
      courseNumber: course.courseNumber,
      aiTools: course.aiTools,
      targetOccupations: course.targetOccupations.join("\n"),
      targetIndustries: course.targetIndustries.join("\n"),
      workplaceTasks: course.workplaceTasks.join("\n"),
      maxSlotsPerOffering: course.maxSlotsPerOffering,
      takenNumbers: numbers.filter((number) => number !== course.courseNumber),
    });
    assert.deepEqual(problems, [], `${course.title}: ${problems[0]?.message ?? ""}`);
    assert.deepEqual(unrecognisedTopics(course.topicAreas), [], `${course.title} claims a topic the RFQ does not list`);
  }
});

test("submission: every seeded class fits the offering it was submitted as", () => {
  // §3.3 gives each course a maximum number of training slots per offering, and the class's
  // seats are where that number becomes checkable.
  for (const klass of FAST_AI_CLASS_PLAN) {
    const course = FAST_AI_COURSES.find((candidate) => candidate.title === klass.courseTitle);
    assert.ok(course, `${klass.name} names a course that is not in the catalogue`);
    if (!course) continue;
    assert.deepEqual(
      offeringSeatProblems(course, { name: klass.name, seats: klass.seats }),
      [],
      `${klass.name} seats more learners than its course was submitted for`,
    );
  }
});

test("employer: the seeded sponsor is eligible for the whole contract term", () => {
  // Otherwise the demo's first enrolment would be refused on the eligibility rule, and a demo
  // that cannot enrol anybody teaches the wrong thing about what the rule costs.
  assert.equal(FAST_AI_SPONSOR_FEIN.replace(/\D/g, "").length, 9);
  assert.deepEqual(
    eligibilityProblems(
      {
        name: "Charles River Home Care",
        preRegistered: true,
        fein: FAST_AI_SPONSOR_FEIN,
        memoExpiresOn: FAST_AI_CONTRACT_END,
      },
      FAST_AI_CONTRACT_END,
    ),
    [],
  );
});

/* -------------------------------------------------------------------------- */
/*  What the funder pays (RFQ §4.1)                                           */
/* -------------------------------------------------------------------------- */

function reportRow(overrides: Partial<ReportRow>): ReportRow {
  return {
    tenant: "Massachusetts Workforce Development",
    tenantSlug: "mass-workforce-development",
    program: "Focused AI Skills Training (FAST AI)",
    funder: "Commonwealth Corporation",
    course: "Applied AI for the Frontline Role",
    klass: "FAST AI — Applied AI for the Frontline Role (Spring 2027)",
    joinCode: "FASTAP",
    sponsor: "Charles River Home Care",
    deliveryMode: "instructor-led",
    startsOn: "2027-03-02",
    endsOn: "2027-03-16",
    seats: 16,
    pricePerSlotCents: 180_000,
    slotValueCents: 2_880_000,
    learnerName: "Maria Ferreira",
    learnerEmail: "maria@ontrak.local",
    status: "COMPLETED",
    enrolledOn: "2027-02-20",
    completedOn: "2027-03-16",
    hoursAttended: 6,
    sittings: 2,
    present: 2,
    ...overrides,
  };
}

test("money: the funder pays for completions and for nothing else", () => {
  const summary = reportSummary([
    reportRow({ learnerEmail: "maria@ontrak.local", status: "COMPLETED" }),
    reportRow({ learnerEmail: "devon@ontrak.local", status: "ATTENDED", hoursAttended: 4 }),
    reportRow({ learnerEmail: "yusuf@ontrak.local", status: "WITHDRAWN", hoursAttended: 3 }),
  ]);

  assert.equal(summary.completed, 1);
  assert.equal(summary.reimbursableCents, 180_000, "one completion at $1,800");
  // Committed is the ceiling the class's seats add up to, not money earned: 16 × $1,800.
  assert.equal(summary.committedCents, 2_880_000);
  assert.ok(summary.reimbursableCents < summary.committedCents);
});

test("money: a class nobody completed reimburses nothing", () => {
  const summary = reportSummary([
    reportRow({ learnerEmail: "devon@ontrak.local", status: "ATTENDED" }),
    reportRow({ learnerEmail: "yusuf@ontrak.local", status: "ATTENDED" }),
  ]);

  assert.equal(summary.reimbursableCents, 0);
  assert.equal(summary.withdrawn, 0, "nobody left, they simply have not finished");
  assert.equal(summary.completionRate, 0);
});

test("money: two classes are paid at their own per-slot prices", () => {
  const summary = reportSummary([
    reportRow({ learnerEmail: "maria@ontrak.local" }),
    reportRow({
      learnerEmail: "devon@ontrak.local",
      klass: "FAST AI — AI-Assisted Customer Support (Spring 2027)",
      pricePerSlotCents: 240_000,
      seats: 14,
    }),
  ]);

  assert.equal(summary.classes, 2);
  assert.equal(summary.reimbursableCents, 420_000, "$1,800 + $2,400");
});
