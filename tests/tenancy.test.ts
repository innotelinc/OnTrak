/**
 * The two rule sets a multi-tenant, funded training deployment turns on.
 *
 * The tenancy half decides who can see whose rows, and the funded-program half decides
 * what a provider may charge and when a class may run. Both are pure functions on
 * purpose: a rule that only exists inside a page is a rule nobody can test, and these are
 * the rules a funder would check.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tenancy.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FAST_AI_AWARD_CENTS,
  FAST_AI_COST_PER_HOUR_CENTS,
  FAST_AI_COST_PER_PERSON_CENTS,
  FAST_AI_EMPLOYER_SLOT_CAP,
  FAST_AI_MAX_COURSES,
  FAST_AI_PROGRAM,
  awardProblems,
  bindingCeiling,
  money,
  priceProblems,
  scheduleProblems,
  slotCeilingCents,
} from "../src/lib/program-rules";
import { canAdministerTenant, canCreateTenants, canManageTenant, catalogFilter, tenantFilter } from "../src/lib/tenancy";

const operator = { organizationId: null, platformAdmin: true, role: "ADMIN" as const };
const massAdmin = { organizationId: "org-mass", platformAdmin: false, role: "ADMIN" as const };
const massInstructor = { organizationId: "org-mass", platformAdmin: false, role: "INSTRUCTOR" as const };
const rhodeIsland = { organizationId: "org-ri", platformAdmin: false, role: "ADMIN" as const };
const unplaced = { organizationId: null, platformAdmin: false, role: "STUDENT" as const };

/* -------------------------------------------------------------------------- */
/*  Tenancy                                                                    */
/* -------------------------------------------------------------------------- */

test("tenancy: a query is scoped to the caller's own organisation", () => {
  assert.deepEqual(tenantFilter(massAdmin), { organizationId: "org-mass" });
  assert.deepEqual(tenantFilter(rhodeIsland), { organizationId: "org-ri" });
  // The operator is the one caller who sees every tenancy — that is the job.
  assert.deepEqual(tenantFilter(operator), {});
});

test("tenancy: an account with no organisation reads nothing, not everything", () => {
  // The failure this guards is subtle and total: an empty filter in Prisma returns every
  // row, so a person who has not been placed in a tenancy yet would read all of them.
  const filter = tenantFilter(unplaced);
  assert.ok(filter.organizationId, "an unplaced account must still be filtered");
  assert.notDeepEqual(filter, {});
  assert.equal(filter.organizationId && filter.organizationId !== "org-mass", true);
});

test("tenancy: the catalogue is the shared built-ins plus your own", () => {
  assert.deepEqual(catalogFilter(massAdmin), {
    OR: [{ organizationId: null }, { organizationId: "org-mass" }],
  });
  // Nothing of your own yet, so the shared catalogue is all you see.
  assert.deepEqual(catalogFilter(unplaced), { organizationId: null });
  assert.deepEqual(catalogFilter(operator), {});
});

test("tenancy: only the operator creates tenancies", () => {
  assert.equal(canCreateTenants(operator), true);
  assert.equal(canCreateTenants(massAdmin), false, "a tenant administrator is not an operator");
});

test("tenancy: administering one tenancy is not administering another", () => {
  assert.equal(canAdministerTenant(massAdmin, "org-mass"), true);
  assert.equal(canAdministerTenant(massAdmin, "org-ri"), false);
  assert.equal(canAdministerTenant(operator, "org-ri"), true);
  assert.equal(canAdministerTenant(massInstructor, "org-mass"), false, "an instructor is not an administrator");
});

test("tenancy: managing rows needs staff in the owning tenancy", () => {
  assert.equal(canManageTenant(massInstructor, "org-mass"), true);
  assert.equal(canManageTenant(massInstructor, "org-ri"), false);
  assert.equal(canManageTenant(unplaced, "org-mass"), false);
  // A shared built-in scenario belongs to nobody, so nobody edits it through a tenancy.
  assert.equal(canManageTenant(massAdmin, null), false);
});

/* -------------------------------------------------------------------------- */
/*  The funded program's arithmetic                                            */
/* -------------------------------------------------------------------------- */

test("program: money prints the way a funder's paperwork writes it", () => {
  assert.equal(money(30_000), "$300.00");
  assert.equal(money(300_000), "$3,000.00");
  assert.equal(money(0), "$0.00");
  assert.equal(money(null), "—");
});

test("program: the binding ceiling is the lesser of the two, and both are real", () => {
  const caps = {
    costPerHourCents: FAST_AI_COST_PER_HOUR_CENTS,
    costPerPersonCents: FAST_AI_COST_PER_PERSON_CENTS,
  };
  // A short course is bounded by the hour; a long one by the person, where the hourly
  // ceiling alone would have allowed four times as much.
  assert.equal(slotCeilingCents(caps, 3), 90_000, "3 hours × $300 = $900");
  assert.equal(bindingCeiling(caps, 3), "hourly");
  assert.equal(slotCeilingCents(caps, 10), 300_000, "10 hours × $300 = $3,000, the per-person cap");
  assert.equal(bindingCeiling(caps, 10), "per-person");
  assert.equal(slotCeilingCents(caps, 40), 300_000, "40 hours × $300 = $12,000, capped at $3,000");
  assert.equal(bindingCeiling(caps, 40), "per-person");
});

test("program: a program that caps nothing refuses nothing", () => {
  const none = { costPerHourCents: null, costPerPersonCents: null };
  assert.equal(slotCeilingCents(none, 8), null);
  assert.deepEqual(priceProblems(none, { title: "Open course", instructionalHours: 8, pricePerSlotCents: 9_999_900 }), []);
});

test("program: a course priced over the cap is refused, and says which cap decided it", () => {
  const caps = {
    costPerHourCents: FAST_AI_COST_PER_HOUR_CENTS,
    costPerPersonCents: FAST_AI_COST_PER_PERSON_CENTS,
  };
  const over = priceProblems(caps, { title: "AI for the front desk", instructionalHours: 6, pricePerSlotCents: 200_000 });
  assert.equal(over.length, 1);
  assert.match(over[0].message, /may not exceed \$1,800\.00/);
  assert.match(over[0].message, /per instructional hour/);

  const atTheCap = priceProblems(caps, { title: "AI for the front desk", instructionalHours: 6, pricePerSlotCents: 180_000 });
  assert.deepEqual(atTheCap, [], "exactly at the ceiling is allowed");

  const perPerson = priceProblems(caps, { title: "Applied AI, 40 hours", instructionalHours: 40, pricePerSlotCents: 300_100 });
  assert.equal(perPerson.length, 1);
  assert.match(perPerson[0].message, /per person per course/);
});

test("program: a course has to state hours and a price before either can be judged", () => {
  const caps = { costPerHourCents: FAST_AI_COST_PER_HOUR_CENTS, costPerPersonCents: FAST_AI_COST_PER_PERSON_CENTS };
  assert.match(priceProblems(caps, { title: "No hours", instructionalHours: 0, pricePerSlotCents: 100 })[0].message, /instructional hours/);
  assert.match(priceProblems(caps, { title: "No price", instructionalHours: 4, pricePerSlotCents: 0 })[0].message, /price per training slot/);
});

test("program: the funder's window is enforced at both ends", () => {
  const window = { startsOn: FAST_AI_PROGRAM.startsOn, endsOn: FAST_AI_PROGRAM.endsOn };
  const base = { name: "Spring cohort", seats: 12, deliveryMode: "instructor-led" };

  assert.deepEqual(
    scheduleProblems(window, { ...base, startsOn: "2027-02-01", endsOn: "2027-03-15" }),
    [],
    "a class inside the window is schedulable",
  );
  const early = scheduleProblems(window, { ...base, startsOn: "2027-01-15", endsOn: "2027-03-15" });
  assert.equal(early.length, 1);
  assert.match(early[0].message, /may not start before 2027-02-01/);

  const late = scheduleProblems(window, { ...base, startsOn: "2028-06-01", endsOn: "2028-07-04" });
  assert.equal(late.length, 1);
  assert.match(late[0].message, /complete by 2028-06-30/);

  assert.match(
    scheduleProblems(window, { ...base, startsOn: "2027-05-01", endsOn: "2027-04-01" })[0].message,
    /ends before it starts/,
  );
});

test("program: the funded delivery is instructor-led, and seats are counted", () => {
  const window = { startsOn: FAST_AI_PROGRAM.startsOn, endsOn: FAST_AI_PROGRAM.endsOn };
  const selfPaced = scheduleProblems(window, {
    name: "Self-paced AI",
    startsOn: "2027-03-01",
    endsOn: "2027-03-30",
    seats: 5,
    deliveryMode: "self-paced",
  });
  assert.equal(selfPaced.length, 1);
  assert.match(selfPaced[0].message, /instructor-led/);

  assert.match(
    scheduleProblems(window, { name: "No seats", startsOn: "2027-03-01", endsOn: "2027-03-30", seats: 0, deliveryMode: "instructor-led" })[0].message,
    /at least one seat/,
  );
});

test("program: a class cannot be scheduled beyond the provider's award", () => {
  const affordable = awardProblems(FAST_AI_AWARD_CENTS, { name: "Cohort", seats: 10, pricePerSlotCents: 300_000 });
  assert.deepEqual(affordable, [], "10 × $3,000 is $30,000 of a $400,000 award");

  const over = awardProblems(FAST_AI_AWARD_CENTS, { name: "Cohort", seats: 200, pricePerSlotCents: 300_000 });
  assert.equal(over.length, 1);
  assert.match(over[0].message, /\$600,000\.00, over the \$400,000\.00 award/);
});

test("program: the seeded FAST AI program is the one the rules describe", () => {
  // Drift here is a provider quoting the wrong numbers to a funder, so the seeded record
  // and the constants the checks use are asserted against the published figures together.
  assert.equal(FAST_AI_PROGRAM.funder, "Commonwealth Corporation");
  assert.equal(FAST_AI_PROGRAM.startsOn, "2027-02-01");
  assert.equal(FAST_AI_PROGRAM.endsOn, "2028-06-30");
  assert.equal(FAST_AI_PROGRAM.costPerHourCents, 30_000);
  assert.equal(FAST_AI_PROGRAM.costPerPersonCents, 300_000);
  assert.equal(FAST_AI_PROGRAM.awardCents, 40_000_000);
  // The employer-side numbers, which decide whether a delivered slot is paid for at all.
  assert.equal(FAST_AI_PROGRAM.employerSlotCap, 100);
  assert.equal(FAST_AI_PROGRAM.maxCourses, 20);
  assert.equal(FAST_AI_PROGRAM.allocationCents, 161_500_000, "the FY27 pool is not the provider's award");
  assert.equal(FAST_AI_PROGRAM.contractStartsOn, "2027-02-01");
  assert.equal(FAST_AI_PROGRAM.contractEndsOn, "2029-01-31");
  assert.ok(FAST_AI_PROGRAM.contractEndsOn > FAST_AI_PROGRAM.endsOn, "the cap runs over the contract, not the window");
  assert.equal(FAST_AI_PROGRAM.employerSlotCap, FAST_AI_EMPLOYER_SLOT_CAP);
  assert.equal(FAST_AI_PROGRAM.maxCourses, FAST_AI_MAX_COURSES);
});
