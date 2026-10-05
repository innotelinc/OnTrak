/**
 * Holidays — the days a desk is closed, as rules rather than as a form field.
 *
 * A weekly calendar says "we work 09:00–17:00". It does not say *which* of those
 * days the desk does not work at all, and every promise a desk makes runs through
 * that question: a four-hour first-response target issued on Christmas Eve is not
 * a four-hour promise if the desk is shut until the 27th. The calendar already
 * carries `holidays` and the clock arithmetic already honours them, so what was
 * missing — and what lives here — is the part that lets a person *state* them
 * safely.
 *
 * Three decisions, all of them about a hand-typed date being able to break a
 * promise:
 *
 * * **A date is checked to be a date.** `2026-02-30` is refused, not rolled
 *   forward to the 2nd of March, because a closure nobody meant is a target
 *   calculated against a day the desk was open.
 * * **The list is normalised, not stored as typed.** Sorted, de-duplicated, and
 *   capped, so two equal lists are one list and the cost of the whole thing can be
 *   stated before it is saved.
 * * **Everything is described in business minutes.** "Seven closures" is not a
 *   number an operator can act on; "seven closures, which remove 47 business
 *   hours from every running promise" is.
 *
 * Pure: no clock of its own, no database, no framework. The instants it needs are
 * passed in, which is what makes the wall-clock arithmetic testable.
 */

import { businessMinutesBetween, type BusinessCalendar, type HolidayDate } from "./sla-rules";

/** A desk's closures are a list of dates, not a diary: a year of them is plenty. */
export const MAX_HOLIDAYS = 200;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Far enough out to plan, near enough that a typo like `2206` is caught. */
const EARLIEST_YEAR = 2000;
const LATEST_YEAR = 2100;

export interface HolidayRefusal {
  /** What was written, as written, so a person can find it. */
  value: string;
  reason: string;
}

export interface HolidayList {
  /** Sorted, de-duplicated, and every entry a real calendar date. */
  dates: HolidayDate[];
  refused: HolidayRefusal[];
}

/**
 * A real calendar date in `YYYY-MM-DD`.
 *
 * The round trip is the check: JavaScript happily accepts `2026-02-30` and gives
 * back the 2nd of March, so a date that does not survive being printed again was
 * not a date.
 */
export function isHolidayDate(value: unknown): value is HolidayDate {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return false;
  if (new Date(parsed).toISOString().slice(0, 10) !== value) return false;
  const year = Number(value.slice(0, 4));
  return year >= EARLIEST_YEAR && year <= LATEST_YEAR;
}

function refusal(value: unknown): HolidayRefusal {
  const text = typeof value === "string" ? value.trim() : String(value);
  if (text === "") return { value: "(blank)", reason: "a closure needs a date" };
  if (!DATE.test(text)) {
    return { value: text.slice(0, 40), reason: `“${text.slice(0, 40)}” is not a date — write it as YYYY-MM-DD` };
  }
  if (!isHolidayDate(text)) {
    return { value: text, reason: `${text} is not a day that exists between ${EARLIEST_YEAR} and ${LATEST_YEAR}` };
  }
  return { value: text, reason: "the date was refused" };
}

/**
 * A list of dates from whatever a caller has.
 *
 * De-duplication is not tidiness: the same closure twice would be counted twice
 * in the cost the console shows, which is the number a desk uses to decide
 * whether it can afford the list.
 */
export function normalizeHolidays(values: unknown): HolidayList {
  const raw = Array.isArray(values)
    ? values
    : typeof values === "string" && values.trim() !== ""
      ? values.split(/[\n,]+/)
      : [];

  const dates: HolidayDate[] = [];
  const refused: HolidayRefusal[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const text = typeof entry === "string" ? entry.trim() : String(entry).trim();
    if (text === "") continue;
    if (!isHolidayDate(text)) {
      refused.push(refusal(text));
      continue;
    }
    if (seen.has(text)) continue;
    seen.add(text);
    dates.push(text);
  }

  dates.sort();
  if (dates.length > MAX_HOLIDAYS) {
    for (const overflow of dates.slice(MAX_HOLIDAYS)) {
      refused.push({ value: overflow, reason: `a calendar holds at most ${MAX_HOLIDAYS} closures` });
    }
    dates.length = MAX_HOLIDAYS;
  }

  return { dates, refused };
}

/**
 * The same list, typed by a person.
 *
 * One closure per line, or comma-separated; `#` starts a comment; and a label
 * after the date is accepted and discarded, because `2026-12-25 Christmas Day`
 * is how somebody actually writes it down. The calendar stores dates — a name is
 * not part of what a clock needs — so the label is convenience, and a line whose
 * *first* word is not a date is refused rather than guessed at.
 */
export function parseHolidayText(text: string): HolidayList {
  const entries: string[] = [];
  for (const line of (text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    for (const part of trimmed.split(",")) {
      const [first, ...rest] = part.trim().split(/\s+/);
      if (!first) continue;
      // The label is padding, not data: only the leading token is read.
      entries.push(rest.length > 0 && isHolidayDate(first) ? first : part.trim());
    }
  }
  return normalizeHolidays(entries);
}

/** The calendar with this closure list, and nothing else, changed. */
export function calendarWithHolidays(
  calendar: BusinessCalendar,
  holidays: readonly HolidayDate[],
): BusinessCalendar {
  return { ...calendar, holidays: [...holidays].sort() };
}

/** The same calendar with no closures — what the weekly pattern alone allows. */
function openDaysOnly(calendar: BusinessCalendar): BusinessCalendar {
  return { ...calendar, holidays: [] };
}

/**
 * What one closure costs a promise, in business minutes.
 *
 * Measured against the day *without* the closure, because the cost of a holiday
 * is the work it removes: if the desk would have been open for eight hours, the
 * holiday takes eight hours off every running clock. A date the desk is shut
 * anyway — a Saturday, a second closure on the same day — costs nothing, and
 * saying zero is more useful than hiding it.
 */
export function holidayCostOf(calendar: BusinessCalendar, date: HolidayDate): number {
  if (!isHolidayDate(date)) return 0;
  const startMs = Date.parse(`${date}T00:00:00Z`) - calendar.utcOffsetMinutes * 60_000;
  return businessMinutesBetween(new Date(startMs), new Date(startMs + DAY_MS), openDaysOnly(calendar));
}

export interface HolidayCost {
  dates: { date: HolidayDate; minutes: number }[];
  totalMinutes: number;
}

export function holidayCost(calendar: BusinessCalendar, dates: readonly HolidayDate[]): HolidayCost {
  const each = [...dates].sort().map((date) => ({ date, minutes: holidayCostOf(calendar, date) }));
  return {
    dates: each,
    totalMinutes: each.reduce((total, entry) => total + entry.minutes, 0),
  };
}

/**
 * The next closure ahead of `from`, in the calendar's own zone.
 *
 * A date today still counts as ahead: a desk that has not opened yet because of
 * a closure wants to be told that, not that the next one is next year.
 */
export function nextClosure(
  dates: readonly HolidayDate[],
  from: Date | string,
  calendar: BusinessCalendar,
): { date: HolidayDate; daysAway: number } | null {
  const today = localDateOf(from, calendar);
  const ahead = [...dates].sort().find((date) => date >= today);
  if (!ahead) return null;
  return { date: ahead, daysAway: Math.round((Date.parse(`${ahead}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS) };
}

/** The calendar's local date for an instant, as `YYYY-MM-DD`. */
export function localDateOf(instant: Date | string, calendar: BusinessCalendar): HolidayDate {
  const ms = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  if (!Number.isFinite(ms)) return new Date(0).toISOString().slice(0, 10);
  return new Date(ms + calendar.utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** One line a console can print: how many, what they cost, and what is next. */
export function describeHolidays(
  dates: readonly HolidayDate[],
  calendar: BusinessCalendar,
  at: Date | string,
): string {
  if (dates.length === 0) return "No closures — every working day counts.";
  const cost = holidayCost(calendar, dates);
  const hours = Math.round(cost.totalMinutes / 6) / 10;
  const next = nextClosure(dates, at, calendar);
  const ahead = next ? ` · next ${next.date}${next.daysAway === 0 ? " (today)" : ` (in ${next.daysAway} day${next.daysAway === 1 ? "" : "s"})`}` : "";
  return `${dates.length} closure${dates.length === 1 ? "" : "s"} · ${hours} business hour${hours === 1 ? "" : "s"} off every promise${ahead}`;
}
