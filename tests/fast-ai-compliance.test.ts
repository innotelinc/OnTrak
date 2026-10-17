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
  FAST_AI_PROGRAM,
  FAST_AI_TOPIC_AREAS,
  completionProblems,
  courseChangeProblems,
  courseSubmissionProblems,
  credentialProblems,
  eligibilityProblems,
  employerSlotUsage,
  foundationalContentProblems,
  moduleHourProblems,
  offeringSeatProblems,
  slotRequestProblems,
  unrecognisedTopics,
  wordCount,
  type CourseChangeShape,
  type EmployerSlotRow,
} from "../src/lib/program-rules";
import { reportCsv, reportSummary, type ReportRow } from "../src/lib/program-report";

/** One delivered slot, with everything but the fields under test defaulted. */
function slot(overrides: Partial<EmployerSlotRow>): EmployerSlotRow {
  return {
    employerId: "org-charles-river",
    employerName: "Charles River Home Care",
    enrolledOn: "2027-03-01",
    status: "COMPLETED",
    present: 2,
    pricePerSlotCents: 180_000,
    funded: true,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  The per-employer cap (RFQ §1.5, §4.1, §4.2)                               */
/* -------------------------------------------------------------------------- */

test("cap: completions are counted across every class, not per class", () => {
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
  assert.equal(usage[0].delivered, 3);
  assert.equal(usage[0].remaining, 97);
  assert.equal(usage[0].reimbursableCompletions, 3);
  assert.equal(usage[0].reimbursableCents, 540_000);
});

test("cap: it is spent in completion order, so the last completions are the unpaid ones", () => {
  const seven = Array.from({ length: 7 }, (_, index) =>
    slot({ enrolledOn: `2027-03-0${index + 1}` }),
  );
  const [usage] = employerSlotUsage(seven, 4);

  assert.equal(usage.slotsUsed, 7);
  assert.equal(usage.reimbursableCompletions, 4);
  assert.equal(usage.unreimbursedCompletions, 3, "the three completions past the cap");
  assert.equal(usage.remaining, 0);
  assert.equal(usage.reimbursableCents, 720_000, "four slots at $1,800, not seven");
});

test("cap: what was delivered but not completed spends nothing", () => {
  // The funder's own answer (RFQ answers, 2026-10-13, §4): "The 100-slot cap applies to slots
  // reimbursed by CommCorp. Slots for trainees who withdraw, do not attend, or do not complete a
  // course are not reimbursed and do not count toward the cap." So a withdrawal after attendance
  // is training the provider delivered and will not be paid for — a loss, not a spent slot — and
  // an employer whose seats keep dropping out is not one slot closer to its cap.
  const [usage] = employerSlotUsage(
    [
      slot({ enrolledOn: "2027-03-01", status: "WITHDRAWN", present: 2 }),
      slot({ enrolledOn: "2027-03-02", status: "WITHDRAWN", present: 0 }),
      slot({ enrolledOn: "2027-03-03", status: "ENROLLED", present: 0 }),
      slot({ enrolledOn: "2027-03-04", status: "ATTENDED", present: 2 }),
    ],
    FAST_AI_EMPLOYER_SLOT_CAP,
  );

  assert.equal(usage.slotsUsed, 0, "no completions, no slots spent");
  assert.equal(usage.delivered, 2, "two seats were sat in — the provider still ran the training");
  assert.equal(usage.completions, 0);
  assert.equal(usage.reimbursableCents, 0);
  assert.equal(usage.remaining, 100);
});

test("cap: completions past a spent cap are completed and unpaid", () => {
  // The failure this exists to make visible: 100 completions already paid for, then two learners
  // finish. What took the cap was the *completions*, so attended-but-unfinished seats lead here
  // just as fast as completed ones once they finish.
  const full = Array.from({ length: 100 }, (_, index) =>
    slot({ enrolledOn: new Date(Date.UTC(2027, 0, 1, 0, index)) }),
  );
  const [usage] = employerSlotUsage(
    [...full, slot({ enrolledOn: "2027-06-01" }), slot({ enrolledOn: "2027-06-02" })],
    FAST_AI_EMPLOYER_SLOT_CAP,
  );

  assert.equal(usage.slotsUsed, 102);
  assert.equal(usage.delivered, 102);
  assert.equal(usage.completions, 102);
  assert.equal(usage.reimbursableCompletions, 100);
  assert.equal(usage.unreimbursedCompletions, 2, "the two that finished after the cap was spent");
  assert.equal(usage.reimbursableCents, 18_000_000, "100 slots at $1,800");
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

test("cap: a seat is refused only once the employer's completions have spent the cap", () => {
  assert.deepEqual(
    slotRequestProblems({ employerName: "Charles River Home Care", slotsUsed: 96, cap: 100 }, 1),
    [],
    "the 97th slot is inside the cap",
  );

  // Room left is room left: enrolling past it is the provider's risk, not a breach — only the
  // completions inside the cap are paid for (RFQ answers, 2026-10-13, §4).
  assert.deepEqual(
    slotRequestProblems({ employerName: "Charles River Home Care", slotsUsed: 96, cap: 100 }, 8),
    [],
    "eight enrolments against four remaining slots is not refused; four of them can complete",
  );

  const last = slotRequestProblems({ employerName: "Charles River Home Care", slotsUsed: 100, cap: 100 }, 1);
  assert.equal(last.length, 1);
  assert.match(last[0].message, /completed all 100 of its slots/);
  assert.match(last[0].message, /not reimbursable|nothing is reimbursable/);

  const many = slotRequestProblems({ employerName: "Charles River Home Care", slotsUsed: 100, cap: 100 }, 3);
  assert.match(many[0].message, /another 3 seats/);

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
/*  What the funder's answers changed (2026-10-13)                            */
/* -------------------------------------------------------------------------- */

/** Every line of a seeded course that teaches something — what the rules below read. */
function teaches(course: (typeof FAST_AI_COURSES)[number]): string[] {
  return [
    course.summary,
    course.audience,
    ...course.modules.flatMap((module) => [
      module.title,
      ...module.objectives,
      module.activity,
      module.outcome,
    ]),
  ];
}

/** The provider the seeded catalogue is submitted by. */
const SEEDED_PROVIDER = "Massachusetts Workforce Development";

test("answers: basic digital skills are not funded content, and are named when a course teaches them", () => {
  const device = foundationalContentProblems({
    title: "Getting Started with AI",
    text: ["Setting up your laptop before the first session"],
  });
  assert.equal(device.length, 1);
  assert.match(device[0].message, /device setup/);
  assert.match(device[0].message, /WTFP/);

  const account = foundationalContentProblems({
    title: "Getting Started with AI",
    text: ["Creating an account in the assistant, then browsing to the tool"],
  });
  assert.match(account[0].message, /account access/);

  const browser = foundationalContentProblems({
    title: "Getting Started with AI",
    text: ["Browser use and file management"],
  });
  assert.match(browser[0].message, /browser use/);

  // Assumed, not taught: a prerequisite may say the learners have used a spreadsheet.
  assert.deepEqual(
    foundationalContentProblems({
      title: "Getting Started with AI",
      text: ["Applying AI to a task from your own workload"],
    }),
    [],
  );
});

test("answers: the seeded catalogue spends no funded hour on foundational digital skills", () => {
  for (const course of FAST_AI_COURSES) {
    assert.deepEqual(
      foundationalContentProblems({ title: course.title, text: teaches(course) }),
      [],
      `${course.title} teaches content the program does not fund`,
    );
  }
});

test("answers: a certificate the provider issues is not an industry-recognized credential", () => {
  assert.deepEqual(
    credentialProblems({ title: "Applied AI", credentials: "", provider: SEEDED_PROVIDER }),
    [],
    "a course that earns no credential claims none",
  );
  assert.deepEqual(
    credentialProblems({
      title: "Automating the Paperwork",
      credentials: "Microsoft Office Specialist (optional, at the employer's request)",
      provider: SEEDED_PROVIDER,
    }),
    [],
    "a licensed vendor's certification is a third party's",
  );

  const own = credentialProblems({
    title: "Applied AI",
    credentials: "Certificate of Completion",
    provider: SEEDED_PROVIDER,
  });
  assert.equal(own.length, 1);
  assert.match(own[0].message, /industry-recognized credential/);
  assert.match(own[0].message, /third party/);

  const named = credentialProblems({
    title: "Applied AI",
    credentials: `${SEEDED_PROVIDER} certificate in applied AI`,
    provider: SEEDED_PROVIDER,
  });
  assert.equal(named.length, 1, "a certificate the provider itself names does not count");
});

test("answers: every seeded course claims only credentials a third party issues", () => {
  for (const course of FAST_AI_COURSES) {
    assert.deepEqual(
      credentialProblems({ title: course.title, credentials: course.credentials, provider: SEEDED_PROVIDER }),
      [],
      `${course.title} claims a credential of its own`,
    );
  }
});

test("answers: only instructor-led time is instructional, so a course's modules add up to its hours", () => {
  const course = {
    title: "Applied AI for the Frontline Role",
    instructionalHours: 6,
    modules: [
      { title: "Where AI already sits in your work", hours: 1.5 },
      { title: "Prompting for a real task", hours: 2 },
      { title: "Checking the answer", hours: 1.5 },
      { title: "Taking it back to the team", hours: 1 },
    ],
  };
  assert.deepEqual(moduleHourProblems(course), []);

  // An hour the learners do between sessions is supplemental: it may exist, but it may not be
  // counted as instructional time or priced at up to $300 an hour.
  const withHomework = moduleHourProblems({
    ...course,
    modules: [...course.modules, { title: "Between sessions", hours: 1 }],
  });
  assert.equal(withHomework.length, 1);
  assert.match(withHomework[0].message, /teaches 7 instructor-led hours/);
  assert.match(withHomework[0].message, /against the 6 it states/);
  assert.match(withHomework[0].message, /between sessions/);

  assert.match(
    moduleHourProblems({ ...course, modules: [{ title: "One", hours: 3 }] })[0].message,
    /teaches 3 instructor-led hours/,
  );
  assert.match(
    moduleHourProblems({ ...course, modules: [] })[0].message,
    /breaks them into no modules/,
  );
});

test("answers: every seeded course's modules add up to the hours it states", () => {
  for (const course of FAST_AI_COURSES) {
    assert.deepEqual(
      moduleHourProblems({
        title: course.title,
        instructionalHours: course.instructionalHours,
        modules: course.modules.map((module) => ({ title: module.title, hours: module.hours })),
      }),
      [],
      `${course.title}'s modules do not add up to its instructional hours`,
    );
  }
});

const COURSE_BEFORE: CourseChangeShape = {
  title: "Applied AI for the Frontline Role",
  objectives: ["Write a prompt that states the audience, the format and the constraint"],
  topicAreas: ["Generative AI", "AI productivity applications"],
  instructionalHours: 6,
  deliveryMode: "instructor-led",
  pricePerSlotCents: 180_000,
};

test("answers: the five protected elements need written approval; a tool swap does not", () => {
  assert.deepEqual(courseChangeProblems(COURSE_BEFORE, { ...COURSE_BEFORE }), []);
  assert.deepEqual(
    courseChangeProblems(COURSE_BEFORE, {
      ...COURSE_BEFORE,
      topicAreas: [...COURSE_BEFORE.topicAreas].reverse(),
    }),
    [],
    "the same topics in another order are the same topics",
  );

  const price = courseChangeProblems(COURSE_BEFORE, { ...COURSE_BEFORE, pricePerSlotCents: 240_000 });
  assert.equal(price.length, 1);
  assert.match(price[0].message, /per-slot price changed from \$1,800\.00 to \$2,400\.00/);
  assert.match(price[0].message, /§4\.7/);

  assert.match(
    courseChangeProblems(COURSE_BEFORE, { ...COURSE_BEFORE, instructionalHours: 8 })[0].message,
    /instructional hours changed from 6 to 8/,
  );
  assert.match(
    courseChangeProblems(COURSE_BEFORE, { ...COURSE_BEFORE, deliveryMode: "hybrid" })[0].message,
    /delivery format changed from instructor-led to hybrid/,
  );
  assert.match(
    courseChangeProblems(COURSE_BEFORE, { ...COURSE_BEFORE, topicAreas: ["Generative AI"] })[0].message,
    /core topics changed/,
  );
  assert.match(
    courseChangeProblems(COURSE_BEFORE, {
      ...COURSE_BEFORE,
      objectives: [...COURSE_BEFORE.objectives, "Explain it to a colleague"],
    })[0].message,
    /learning objectives changed/,
  );

  // Two elements at once is two approvals, each named: a tool version, a prompt or an exercise
  // never reaches this comparison, which is the freedom the funder's answer grants.
  const both = courseChangeProblems(COURSE_BEFORE, {
    ...COURSE_BEFORE,
    instructionalHours: 8,
    pricePerSlotCents: 240_000,
  });
  assert.equal(both.length, 2);
});

test("answers: a completion needs every instructional hour, the assessment, and one slot", () => {
  const course = { title: "Applied AI for the Frontline Role", instructionalHours: 6 };
  const done = { learnerEmail: "maria@ontrak.local", hoursAttended: 6, assessmentComplete: true };
  assert.deepEqual(completionProblems(course, done), []);

  const short = completionProblems(course, { ...done, hoursAttended: 4 });
  assert.equal(short.length, 1);
  assert.match(short[0].message, /attended 4/);
  assert.match(short[0].message, /2 more hours/);
  assert.match(short[0].message, /make-up/);

  const unassessed = completionProblems(course, { ...done, assessmentComplete: false });
  assert.equal(unassessed.length, 1);
  assert.match(unassessed[0].message, /assessment or activity/);

  const twice = completionProblems(course, { ...done, priorReimbursements: 1 });
  assert.equal(twice.length, 1);
  assert.match(twice[0].message, /only once per trainee per course/);

  // Attendance is not a completion: four of six hours and no assessment is two problems, not one.
  assert.equal(
    completionProblems(course, { ...done, hoursAttended: 4, assessmentComplete: false }).length,
    2,
  );

  // A caller with no assessment record says nothing rather than saying it failed, which is what
  // the completion action does: the hours and the duplicate-slot test still run.
  assert.deepEqual(
    completionProblems(course, { learnerEmail: "maria@ontrak.local", hoursAttended: 6 }),
    [],
    "an unrecorded assessment is not a refusal",
  );
});

test("answers: the reporting cadence is the contract's, not one this app invented", () => {
  assert.notEqual(FAST_AI_PROGRAM.reportingCadence, "monthly");
  assert.match(FAST_AI_PROGRAM.reportingCadence, /contract/);
});

/* -------------------------------------------------------------------------- */
/*  What the funder pays (RFQ §4.1)                                           */
/* -------------------------------------------------------------------------- */

test("answers: an unfunded participant is in the class but not in the funder's arithmetic", () => {
  // An offering may include participants the program does not fund (RFQ answers, 2026-10-13,
  // §2.2): their seat is real, their completion is real, and neither is a slot CommCorp bought.
  const [usage] = employerSlotUsage(
    [slot({ status: "COMPLETED" }), slot({ status: "COMPLETED", funded: false })],
    100,
  );

  assert.equal(usage.completions, 1, "only the funded completion is a completion to report");
  assert.equal(usage.slotsUsed, 1, "an unfunded seat does not spend the employer's allowance");
  assert.equal(usage.reimbursableCents, 180_000);
  assert.equal(usage.delivered, 1);
});

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
    funded: true,
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

test("answers: an unfunded row is exported, marked, and paid for by nobody", () => {
  const rows = [
    reportRow({ learnerEmail: "maria@ontrak.local" }),
    reportRow({ learnerEmail: "self.paying@example.com", funded: false }),
  ];
  const summary = reportSummary(rows);

  assert.equal(summary.enrolments, 1, "the funder's enrolment figures are funded seats");
  assert.equal(summary.completed, 1);
  assert.equal(summary.reimbursableCents, 180_000, "one funded completion, not two");
  assert.equal(summary.learners, 1);

  // The file still carries the person: the funder asked to be able to tell which trainees are
  // its own, not to have the others erased from the class they attended.
  const csv = reportCsv(rows);
  assert.match(csv, /self\.paying@example\.com,no,COMPLETED/);
  assert.match(csv, /maria@ontrak\.local,yes,COMPLETED/);
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
