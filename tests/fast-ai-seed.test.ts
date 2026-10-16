/**
 * The seeded FAST AI program, held against the request for qualifications.
 *
 * The seed is content, but it is content a funder would audit: a course priced above the
 * ceiling, a class outside the window, or a completion figure that counts a withdrawal
 * against the provider is a real submission refused for a real reason. These tests read the
 * seeded catalogue and class plan directly and run them through the same rules the forms and
 * the actions use, so the demo cannot quietly become an example of an ineligible bid.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/fast-ai-seed.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FAST_AI_CLASS_CODES,
  FAST_AI_CLASS_PLAN,
  FAST_AI_COURSES,
  FAST_AI_SPONSOR_SLUG,
  FAST_AI_TENANT_SLUG,
} from "../prisma/seed-fast-ai";
import { DEMO_STUDENT_EMAILS } from "../src/lib/demo-reset-rules";
import {
  FAST_AI_PROGRAM,
  awardProblems,
  bindingCeiling,
  priceProblems,
  scheduleProblems,
} from "../src/lib/program-rules";
import { REPORT_HEADERS, reportCsv, reportSummary, type ReportRow } from "../src/lib/program-report";

const CAPS = {
  costPerHourCents: FAST_AI_PROGRAM.costPerHourCents,
  costPerPersonCents: FAST_AI_PROGRAM.costPerPersonCents,
};

const WINDOW = { startsOn: FAST_AI_PROGRAM.startsOn, endsOn: FAST_AI_PROGRAM.endsOn };

/* -------------------------------------------------------------------------- */
/*  The tenancy                                                               */
/* -------------------------------------------------------------------------- */

test("seed: the tenancy and its sponsor are identified by stable keys", () => {
  // The seeder upserts on these, so a change here is a change of demo database identity
  // rather than a rename: worth pinning where it can be seen.
  assert.equal(FAST_AI_TENANT_SLUG, "mass-workforce-development");
  assert.equal(FAST_AI_SPONSOR_SLUG, "charles-river-home-care");
  assert.match(FAST_AI_TENANT_SLUG, /^[a-z0-9-]+$/);
});

test("seed: the program carries the funder's window and both ceilings", () => {
  assert.equal(FAST_AI_PROGRAM.funder, "Commonwealth Corporation");
  assert.equal(FAST_AI_PROGRAM.startsOn, "2027-02-01");
  assert.equal(FAST_AI_PROGRAM.endsOn, "2028-06-30");
  assert.equal(FAST_AI_PROGRAM.costPerHourCents, 30_000);
  assert.equal(FAST_AI_PROGRAM.costPerPersonCents, 300_000);
  assert.equal(FAST_AI_PROGRAM.awardCents, 40_000_000);
});

/* -------------------------------------------------------------------------- */
/*  The catalogue                                                             */
/* -------------------------------------------------------------------------- */

test("seed: every seeded course is priced inside both of the funder's ceilings", () => {
  assert.ok(FAST_AI_COURSES.length >= 3, "a program with one course is not a catalogue");
  for (const course of FAST_AI_COURSES) {
    const problems = priceProblems(CAPS, course);
    assert.deepEqual(problems, [], `${course.title}: ${problems[0]?.message ?? ""}`);
  }
});

test("seed: both ceilings are exercised, so neither can rot unnoticed", () => {
  // A catalogue that only ever tests the hourly ceiling would let a per-person regression
  // in unnoticed. One course of each kind is the point of the four.
  const bindings = FAST_AI_COURSES.map((course) => bindingCeiling(CAPS, course.instructionalHours));
  assert.ok(bindings.includes("hourly"), "one course should be bound by the hourly ceiling");
  assert.ok(bindings.includes("per-person"), "and one by the per-person ceiling");
});

test("seed: the authored modules add up to the course's instructional hours", () => {
  // A syllabus that claims six hours and lists four and a half is a syllabus a funder
  // queries, and the class price is derived from the hours it claims.
  for (const course of FAST_AI_COURSES) {
    const authored = course.modules.reduce((sum, module) => sum + module.hours, 0);
    assert.equal(
      authored,
      course.instructionalHours,
      `${course.title}: modules total ${authored}h against ${course.instructionalHours}h claimed`,
    );
    assert.ok(course.modules.length > 0, `${course.title} has no modules`);
    for (const module of course.modules) {
      assert.ok(module.objectives.length > 0, `${course.title} / ${module.title}: no objectives`);
      assert.ok(module.objectives.every((line) => line.trim() !== ""), `${course.title} / ${module.title}: blank objective`);
      assert.ok(module.activity.trim() !== "", `${course.title} / ${module.title}: no activity`);
      assert.ok(module.outcome.trim() !== "", `${course.title} / ${module.title}: nothing assessed`);
    }
  }
});

test("seed: no module is a lecture with nothing for the learner to do", () => {
  // The RFQ will not fund general AI literacy, so every module has to name both what the
  // learner does and what comes of it. Asserting a *verb list* would be a test that fails
  // whenever somebody writes "Audit the folder" instead of "Review the folder", so the
  // guard is the substance: two objectives, an activity written as a sentence, and an
  // assessed output that is a different thing from the activity.
  for (const course of FAST_AI_COURSES) {
    assert.notEqual(course.audience.trim(), "", `${course.title} does not say who it is for`);
    for (const module of course.modules) {
      assert.ok(module.objectives.length >= 2, `${course.title} / ${module.title}: fewer than two objectives`);
      assert.ok(
        module.activity.trim().split(/\s+/).length >= 8,
        `${course.title} / ${module.title}: the activity is not described in enough detail to run`,
      );
      assert.ok(
        module.outcome.trim().split(/\s+/).length >= 4,
        `${course.title} / ${module.title}: nothing a facilitator could mark`,
      );
      assert.notEqual(module.outcome.trim(), module.activity.trim(), `${course.title} / ${module.title}`);
    }
  }
});

test("seed: each course is contextualised to the learner's own work", () => {
  // "Contextualised to a worker's own role and tools" is the RFQ's phrase, and the way a
  // catalogue shows it is that its activities use the learner's material rather than a
  // sample dataset: their inbox, their queue, their shared drive.
  for (const course of FAST_AI_COURSES) {
    const grounded = course.modules.some((module) => /\b(own|their|yours?|they|you)\b/i.test(module.activity));
    assert.ok(grounded, `${course.title}: no module works on the learner's own material`);
  }
});

/* -------------------------------------------------------------------------- */
/*  The classes                                                               */
/* -------------------------------------------------------------------------- */

test("seed: every seeded class runs inside the funder's window", () => {
  for (const klass of FAST_AI_CLASS_PLAN) {
    const problems = scheduleProblems(WINDOW, {
      name: klass.name,
      startsOn: klass.startsOn,
      endsOn: klass.endsOn,
      seats: klass.seats,
      deliveryMode: "instructor-led",
    });
    assert.deepEqual(problems, [], `${klass.name}: ${problems[0]?.message ?? ""}`);
  }
});

test("seed: every seeded class is priced and sized within the funder's limits", () => {
  for (const klass of FAST_AI_CLASS_PLAN) {
    const course = FAST_AI_COURSES.find((candidate) => candidate.title === klass.courseTitle);
    assert.ok(course, `${klass.name} names a course that is not in the catalogue: ${klass.courseTitle}`);
    if (!course) continue;

    assert.equal(klass.instructionalHours, course.instructionalHours, `${klass.name}: hours differ from the course`);
    assert.deepEqual(
      priceProblems(CAPS, { title: course.title, instructionalHours: klass.instructionalHours, pricePerSlotCents: klass.pricePerSlotCents }),
      [],
      `${klass.name} is priced outside the ceilings`,
    );
    assert.deepEqual(
      awardProblems(FAST_AI_PROGRAM.awardCents, {
        name: klass.name,
        seats: klass.seats,
        pricePerSlotCents: klass.pricePerSlotCents,
      }),
      [],
      `${klass.name} does not fit the award`,
    );
  }
});

test("seed: the classes are keyed by distinct, readable join codes", () => {
  const codes = FAST_AI_CLASS_PLAN.map((klass) => klass.code);
  assert.equal(new Set(codes).size, codes.length, "two seeded classes share a join code");
  assert.deepEqual([...codes].sort(), [...FAST_AI_CLASS_CODES].sort());
  for (const code of codes) {
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/, `${code} is not in the alphabet a person can read aloud`);
  }
});

test("seed: the seeded learners are demo students a reset keeps", () => {
  // Not a formality: a learner account the reset deletes takes its enrolment, its
  // attendance and the report's only completion with it.
  const emails = new Set(FAST_AI_CLASS_PLAN.flatMap((klass) => klass.enroll));
  assert.ok(emails.size >= 3, "the demo should show more than a pair of learners");
  for (const email of emails) {
    assert.ok(
      (DEMO_STUDENT_EMAILS as readonly string[]).includes(email),
      `${email} is enrolled but is not on the demo-reset keep list`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  The funder's report                                                       */
/* -------------------------------------------------------------------------- */

/** A row as the report route builds it, with everything but the fields under test defaulted. */
function row(overrides: Partial<ReportRow>): ReportRow {
  return {
    tenant: "Massachusetts Workforce Development",
    tenantSlug: FAST_AI_TENANT_SLUG,
    program: "Focused AI Skills Training (FAST AI)",
    funder: "Commonwealth Corporation",
    course: "Applied AI for the Frontline Role",
    klass: "FAST AI — Applied AI for the Frontline Role (Spring 2027)",
    joinCode: "FASTAI",
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

test("report: the columns are the funder's figures, in a fixed order", () => {
  // Pinned rather than derived: a spreadsheet somebody has already built against this file
  // breaks if a column moves, so moving one has to be a deliberate act.
  assert.deepEqual([...REPORT_HEADERS], [
    "tenant",
    "tenant_key",
    "program",
    "funder",
    "course",
    "class",
    "join_code",
    "sponsor",
    "delivery",
    "starts_on",
    "ends_on",
    "seats",
    "price_per_slot_usd",
    "slot_value_usd",
    "learner_name",
    "learner_email",
    "enrolment_status",
    "enrolled_on",
    "completed_on",
    "hours_attended",
    "sittings",
    "sessions_present",
  ]);
});

test("report: money is written in dollars so the column sums in a spreadsheet", () => {
  const csv = reportCsv([row({})]);
  const [header, first] = csv.split("\r\n");
  const cells = first.split(",");
  assert.equal(cells[header.split(",").indexOf("price_per_slot_usd")], "1800.00");
  assert.equal(cells[header.split(",").indexOf("slot_value_usd")], "28800.00");
});

test("report: a class name containing a comma survives the round trip", () => {
  const csv = reportCsv([row({ klass: "FAST AI — Spring 2027, cohort 1" })]);
  assert.match(csv, /"FAST AI — Spring 2027, cohort 1"/);
  // One header and one data row, however many commas are inside the quoted field.
  assert.equal(csv.trimEnd().split("\r\n").length, 2);
});

test("report: a learner who withdrew does not count against the completion rate", () => {
  const summary = reportSummary([
    row({ learnerEmail: "maria@ontrak.local", status: "COMPLETED" }),
    row({ learnerEmail: "devon@ontrak.local", status: "COMPLETED" }),
    row({ learnerEmail: "yusuf@ontrak.local", status: "WITHDRAWN", hoursAttended: 3 }),
  ]);

  assert.equal(summary.enrolments, 3);
  assert.equal(summary.learners, 3);
  assert.equal(summary.completed, 2);
  assert.equal(summary.withdrawn, 1);
  // Two of the two who stayed, not two of three: a funder-eligible learner who finishes
  // has to be able to read as 100%.
  assert.equal(summary.completionRate, 1);
  assert.deepEqual(reportSummary([]).completionRate, null);
});

test("report: the committed figure is counted once per class, not once per learner", () => {
  // The regression this guards is a report whose award total multiplies with its roster.
  const summary = reportSummary([
    row({ learnerEmail: "maria@ontrak.local" }),
    row({ learnerEmail: "devon@ontrak.local" }),
    row({ learnerEmail: "yusuf@ontrak.local" }),
    row({ klass: "FAST AI — AI-Assisted Customer Support (Spring 2027)", seats: 14, pricePerSlotCents: 240_000 }),
  ]);

  assert.equal(summary.classes, 2);
  assert.equal(summary.enrolments, 4);
  assert.equal(summary.committedCents, 16 * 180_000 + 14 * 240_000);
  assert.equal(summary.hoursAttended, 24);
});
