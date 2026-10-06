/**
 * OnTrak Tix: the days a desk is closed.
 *
 * The calendar has honoured holidays for as long as it has computed clocks, but
 * nothing could state them, so a desk that shuts for Christmas had either to
 * pretend it does not or to leave its promises measured through a day nobody was
 * at work. These are the rules that let a person say it — and, more importantly,
 * the refusals: a date that does not exist, a line that is prose, or a list long
 * enough to be a mistake must not become a closure that quietly never ends.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-holidays.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import {
  MAX_HOLIDAYS,
  calendarWithHolidays,
  describeHolidays,
  holidayCost,
  holidayCostOf,
  isHolidayDate,
  nextClosure,
  nextClosureLabel,
  normalizeHolidays,
  parseHolidayText,
} from "../src/lib/holiday-rules";
import {
  ALWAYS_OPEN_CALENDAR,
  addBusinessMinutes,
  isOpenAt,
  weekdayCalendar,
} from "../src/lib/sla-rules";
import { MemorySlaPolicyStore, SlaPolicyService } from "../src/lib/sla-policy-service";
import { asBusinessCalendar, toSlaPolicy } from "../src/lib/sla-store-prisma";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const ADMIN = { id: "admin-1", tenantId: "tenant-a", role: "ADMIN" as const };
/** A Friday, inside the business week, so a closure on it must cost a day. */
const FRIDAY = "2026-12-25";
/** The next day, a Saturday, which the weekly calendar is shut on anyway. */
const SATURDAY = "2026-12-26";
const NOW = "2026-12-01T09:00:00.000Z";

function harness() {
  const audit = new AuditLog(sha256);
  const store = new MemorySlaPolicyStore();
  let n = 0;
  const service = new SlaPolicyService(store, audit, null, { id: () => `policy-${++n}`, now: () => NOW });
  return { service, store, audit };
}

test("holidays: a date has to be a day that exists", () => {
  assert.equal(isHolidayDate("2026-12-25"), true);
  assert.equal(isHolidayDate("2026-02-30"), false, "February has no 30th");
  assert.equal(isHolidayDate("2026-2-3"), false, "not the stated format");
  assert.equal(isHolidayDate("25/12/2026"), false);
  assert.equal(isHolidayDate("Christmas"), false);
  assert.equal(isHolidayDate("1999-12-25"), false, "before the supported range");
  assert.equal(isHolidayDate("2206-12-25"), false, "a century typo, not a closure");
  assert.equal(isHolidayDate(20261225), false);
});

test("holidays: a list is sorted and de-duplicated, and the bad rows are named", () => {
  const read = normalizeHolidays(["2027-01-01", "2026-12-25", "2026-02-30", "  ", "2026-12-25", "Christmas"]);
  assert.deepEqual(read.dates, ["2026-12-25", "2027-01-01"]);
  assert.deepEqual(
    read.refused.map((entry) => entry.value),
    ["2026-02-30", "Christmas"],
  );
  assert.match(read.refused[0].reason, /not a day that exists/);
  assert.match(read.refused[1].reason, /write it as YYYY-MM-DD/);
  assert.deepEqual(read.dates, [...read.dates].sort(), "sorted, so two equal lists read the same");
});

test("holidays: a calendar holds a year's worth, and says so rather than truncating silently", () => {
  const many = Array.from({ length: MAX_HOLIDAYS + 3 }, (_, index) => {
    const day = new Date(Date.UTC(2026, 0, 1) + index * 86_400_000);
    return day.toISOString().slice(0, 10);
  });
  const read = normalizeHolidays(many);
  assert.equal(read.dates.length, MAX_HOLIDAYS);
  assert.equal(read.refused.length, 3);
  assert.match(read.refused[0].reason, /at most/);
});

test("holidays: the box a person types in takes labels and comments", () => {
  const read = parseHolidayText(
    ["# the desk is shut", "2026-12-25 Christmas Day", "  2027-01-01, 2027-04-05 Easter Monday", "", "Bank holiday"].join("\n"),
  );
  assert.deepEqual(read.dates, ["2026-12-25", "2027-01-01", "2027-04-05"]);
  assert.deepEqual(
    read.refused.map((entry) => entry.value),
    ["Bank holiday"],
    "a line whose first word is not a date is refused rather than guessed at",
  );
});

test("holidays: a closure closes the clock, and the weekly pattern still runs beside it", () => {
  const calendar = calendarWithHolidays(weekdayCalendar("Weekdays", 0), [FRIDAY]);
  assert.equal(isOpenAt("2026-12-24T12:00:00.000Z", calendar), true, "the day before the closure is an ordinary working day");
  assert.equal(isOpenAt("2026-12-25T12:00:00.000Z", calendar), false, "…and the closure shuts the working day itself");

  // Thursday 17:00 plus four business hours is Monday, because Friday is closed
  // and the weekend follows it. That is the whole point of stating a closure.
  const after = addBusinessMinutes("2026-12-24T17:00:00.000Z", 240, calendar);
  assert.equal(after.toISOString(), "2026-12-28T13:00:00.000Z");
});

test("holidays: what a closure costs is the work it removes", () => {
  const business = weekdayCalendar("Weekdays", 0);
  assert.equal(holidayCostOf(business, FRIDAY), 480, "nine to five is eight hours");
  assert.equal(holidayCostOf(business, SATURDAY), 0, "a day the desk is shut anyway costs nothing");
  assert.equal(holidayCostOf(ALWAYS_OPEN_CALENDAR, FRIDAY), 1_440);
  assert.equal(holidayCostOf(business, "not-a-date"), 0);

  const cost = holidayCost(business, normalizeHolidays([FRIDAY, SATURDAY, "2027-01-01"]).dates);
  assert.equal(cost.totalMinutes, 480 + 0 + 480);
  assert.deepEqual(cost.dates.map((entry) => entry.minutes), [480, 0, 480]);
});

test("holidays: the next closure is ahead of you, and today counts", () => {
  const calendar = weekdayCalendar("Weekdays", 0);
  const dates = [FRIDAY, "2027-01-01"];
  assert.deepEqual(nextClosure(dates, NOW, calendar), { date: FRIDAY, daysAway: 24 });
  assert.deepEqual(nextClosure(dates, "2026-12-25T08:00:00.000Z", calendar), { date: FRIDAY, daysAway: 0 });
  assert.equal(nextClosure(dates, "2027-02-01T00:00:00.000Z", calendar), null);
  assert.equal(nextClosure([], NOW, calendar), null);
});

test("holidays: one line says how many, what they cost and what is next", () => {
  const business = weekdayCalendar("Weekdays", 0);
  assert.match(describeHolidays([], business, NOW), /^No closures/);
  assert.equal(
    describeHolidays([FRIDAY], business, NOW),
    "1 closure · 8 business hours off every promise · next 2026-12-25 (in 24 days)",
  );
  assert.equal(
    describeHolidays(["2026-12-25", "2026-12-26"], business, NOW),
    "2 closures · 8 business hours off every promise · next 2026-12-25 (in 24 days)",
  );
  assert.match(describeHolidays([FRIDAY], business, "2026-12-25T08:00:00.000Z"), /\(today\)/);
});

test("holidays: a promise can carry closures, and a write that breaks one saves nothing", async () => {
  const h = harness();
  const created = await h.service.create(ADMIN, {
    name: "Contract desk",
    responseMinutes: 240,
    resolutionMinutes: 1_440,
    holidays: ["2026-12-25", "2027-01-01"],
  });
  assert.equal(created.ok, true);
  assert.deepEqual(created.ok ? created.value.calendar.holidays : null, ["2026-12-25", "2027-01-01"]);

  const policyId = created.ok ? created.value.id : "";
  const before = await h.store.listForTenant("tenant-a");

  const refused = await h.service.update(ADMIN, policyId, {
    name: "Contract desk",
    responseMinutes: 240,
    resolutionMinutes: 1_440,
    holidays: ["2026-12-25", "25/12/2027"],
  });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /YYYY-MM-DD/);
  assert.deepEqual(await h.store.listForTenant("tenant-a"), before, "a refused list must not be half-written");
});

test("holidays: an edit that says nothing about closures keeps them, and an empty box clears them", async () => {
  const h = harness();
  const created = await h.service.create(ADMIN, {
    name: "Contract desk",
    responseMinutes: 240,
    resolutionMinutes: 1_440,
    holidays: [FRIDAY],
  });
  if (!created.ok) throw new Error(created.error);

  const renamed = await h.service.update(ADMIN, created.value.id, {
    name: "Contract desk (2027)",
    responseMinutes: 240,
    resolutionMinutes: 1_440,
  });
  assert.equal(renamed.ok, true);
  assert.deepEqual(renamed.ok ? renamed.value.calendar.holidays : null, [FRIDAY], "a rename is not a policy decision");

  const cleared = await h.service.update(ADMIN, created.value.id, {
    name: "Contract desk (2027)",
    responseMinutes: 240,
    resolutionMinutes: 1_440,
    holidays: "",
  });
  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.ok ? cleared.value.calendar.holidays : null, []);
});

test("holidays: saving a name does not move a 24x7 desk onto weekdays", async () => {
  const h = harness();
  const created = await h.service.create(ADMIN, {
    name: "Always on",
    responseMinutes: 60,
    resolutionMinutes: 240,
    hours: "always",
  });
  if (!created.ok) throw new Error(created.error);
  assert.equal(created.value.calendar.name, "24x7");

  const renamed = await h.service.update(ADMIN, created.value.id, {
    name: "Always on (managed)",
    responseMinutes: 60,
    resolutionMinutes: 240,
  });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.ok ? renamed.value.calendar.name : null, "24x7", "the promise's hours are not an edit's business");
  assert.equal(renamed.ok ? isOpenAt("2026-12-27T03:00:00.000Z", renamed.value.calendar) : null, true);
});

test("holidays: a hand-edited row cannot put a closure the clock cannot read in front of a promise", () => {
  const calendar = asBusinessCalendar({
    ...weekdayCalendar("Weekdays", 0),
    holidays: ["2026-12-25", "2026-02-30", 42, "2026-12-25"],
  });
  assert.deepEqual(calendar.holidays, ["2026-12-25"], "drop what is not a date, and fail towards the desk being open");

  const policy = toSlaPolicy({
    id: "p1",
    tenantId: "tenant-a",
    name: "Desk default",
    priority: null,
    responseMinutes: 240,
    resolutionMinutes: 1_440,
    calendar,
    warningFraction: 0.2,
    queueId: null,
    clientId: null,
  });
  assert.deepEqual(policy.calendar.holidays, ["2026-12-25"]);
  assert.equal(isOpenAt("2027-01-01T12:00:00.000Z", policy.calendar), true, "a bad row does not close a day");
});

test("holidays: the line the console puts beside a promise names the next day the desk is shut", () => {
  const business = calendarWithHolidays(weekdayCalendar("Weekdays", 0), [FRIDAY, "2027-01-01"]);
  assert.equal(nextClosureLabel(business.holidays ?? [], business, NOW), "shut 2026-12-25 (in 24 days)");
  assert.equal(
    nextClosureLabel(business.holidays ?? [], business, "2026-12-25T08:00:00.000Z"),
    "shut 2026-12-25 (today)",
    "a day the desk is shut right now is the closure to state, not next year's",
  );

  // Past the last closure there is nothing to say, and an empty line is better
  // than "shut never": the ladder should read as a promise, not as an absence.
  assert.equal(nextClosureLabel(business.holidays ?? [], business, "2027-02-01T09:00:00.000Z"), null);
  assert.equal(nextClosureLabel([], business, NOW), null);
});
