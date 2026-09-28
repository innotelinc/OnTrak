/**
 * SLA rules (M1): policies, business-hours calendars, and the response /
 * resolution clocks that hang off a ticket.
 *
 * Everything here is pure and framework-free, for the same reason the rest of
 * the rules modules are: the SLA engine decides whether a promise is kept, so
 * it has to be exhaustively testable without a database, a scheduler or a
 * request context. Time is injected (never read from the clock) and the
 * calendar is supplied, so a test can pin "Monday 09:00 in the desk's zone".
 *
 * Timezones: rather than pull in a date library, a calendar carries a fixed
 * `utcOffsetMinutes`. That is exact for zones without DST and a deliberate,
 * documented approximation otherwise — real DST handling is a backlog item, not
 * something to fake here. Wall-clock arithmetic is done on a shifted UTC axis,
 * so the code stays deterministic in any host timezone.
 */

import type { TicketPriority } from "./ticket-rules";

/** A single open window on a day, as minutes from local midnight (end-exclusive). */
export interface BusinessWindow {
  startMinute: number;
  endMinute: number;
}

/** ISO date (`YYYY-MM-DD`) a desk is closed regardless of its weekly pattern. */
export type HolidayDate = string;

export interface BusinessCalendar {
  name: string;
  /** Fixed offset from UTC, e.g. `-300` for US Eastern standard time. */
  utcOffsetMinutes: number;
  /** Open windows by weekday, `0` = Sunday … `6` = Saturday. */
  week: readonly (readonly BusinessWindow[])[];
  /** Extra closures, as `YYYY-MM-DD` in the calendar's own zone. */
  holidays?: readonly HolidayDate[];
}

/** A 09:00–17:00 Monday–Friday calendar in a given offset. */
export function weekdayCalendar(name: string, utcOffsetMinutes = 0): BusinessCalendar {
  const window = [{ startMinute: 9 * 60, endMinute: 17 * 60 }];
  return {
    name,
    utcOffsetMinutes,
    week: [[], window, window, window, window, window, []],
  };
}

/** A calendar that is never open — used by "around the clock" 24×7 desks. */
export const ALWAYS_OPEN_CALENDAR: BusinessCalendar = {
  name: "24x7",
  utcOffsetMinutes: 0,
  week: [
    [{ startMinute: 0, endMinute: 24 * 60 }],
    [{ startMinute: 0, endMinute: 24 * 60 }],
    [{ startMinute: 0, endMinute: 24 * 60 }],
    [{ startMinute: 0, endMinute: 24 * 60 }],
    [{ startMinute: 0, endMinute: 24 * 60 }],
    [{ startMinute: 0, endMinute: 24 * 60 }],
    [{ startMinute: 0, endMinute: 24 * 60 }],
  ],
};

export interface SlaPolicy {
  id: string;
  name: string;
  /** Business minutes allowed before the first agent response. */
  responseMinutes: number;
  /** Business minutes allowed before resolution. */
  resolutionMinutes: number;
  calendar: BusinessCalendar;
  /** Warn once this fraction of a target remains (e.g. `0.2` = last 20%). */
  warningFraction: number;
  /** Optional priority this policy is scoped to; omitted means "any". */
  priority?: TicketPriority;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** No calendar is ever closed for more than a year; this is a loop guard. */
const MAX_DAYS = 400;

/* -------------------------------------------------------------------------- */
/*  Calendar primitives                                                       */
/* -------------------------------------------------------------------------- */

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/** An instant → the calendar's wall-clock axis (local time rendered as UTC). */
function wallOf(instantMs: number, calendar: BusinessCalendar): number {
  return instantMs + calendar.utcOffsetMinutes * MINUTE_MS;
}

function instantOf(wallMs: number, calendar: BusinessCalendar): number {
  return wallMs - calendar.utcOffsetMinutes * MINUTE_MS;
}

function startOfWallDay(wallMs: number): number {
  const date = new Date(wallMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isoDateOfWall(wallMs: number): string {
  return new Date(wallMs).toISOString().slice(0, 10);
}

interface WallWindow {
  start: number;
  end: number;
}

/** The open windows of whichever local day `wallMs` falls on. */
function windowsForWall(wallMs: number, calendar: BusinessCalendar): WallWindow[] {
  const dayStart = startOfWallDay(wallMs);
  const date = isoDateOfWall(wallMs);
  if (calendar.holidays?.includes(date)) return [];
  const day = new Date(dayStart).getUTCDay();
  return (calendar.week[day] ?? []).map((window) => ({
    start: dayStart + window.startMinute * MINUTE_MS,
    end: dayStart + window.endMinute * MINUTE_MS,
  }));
}

/** The window containing `wallMs`, or `null` at the edge of a closed period. */
function windowContaining(wallMs: number, calendar: BusinessCalendar): WallWindow | null {
  return windowsForWall(wallMs, calendar).find((window) => window.start <= wallMs && wallMs < window.end) ?? null;
}

/** Whether the desk is open at an instant. */
export function isOpenAt(instant: Date | string, calendar: BusinessCalendar): boolean {
  return windowContaining(wallOf(toDate(instant).getTime(), calendar), calendar) !== null;
}

/** The next instant the desk opens at or after `instant` (itself if already open). */
export function nextOpen(instant: Date | string, calendar: BusinessCalendar): Date {
  const wall = wallOf(toDate(instant).getTime(), calendar);
  const dayStart = startOfWallDay(wall);

  for (let day = 0; day < MAX_DAYS; day += 1) {
    const probe = dayStart + day * DAY_MS;
    for (const window of windowsForWall(probe, calendar)) {
      const at = Math.max(window.start, wall);
      if (at < window.end) return new Date(instantOf(at, calendar));
    }
  }
  return toDate(instant);
}

/* -------------------------------------------------------------------------- */
/*  Business-time arithmetic                                                  */
/* -------------------------------------------------------------------------- */

/** Advance an instant by N *open* business minutes. Closed time does not count. */
export function addBusinessMinutes(from: Date | string, minutes: number, calendar: BusinessCalendar): Date {
  const startWall = wallOf(toDate(from).getTime(), calendar);
  if (!Number.isFinite(minutes) || minutes <= 0) return new Date(instantOf(startWall, calendar));

  let cursor = startWall;
  let remaining = Math.trunc(minutes);
  let guard = 0;

  while (remaining > 0 && guard < MAX_DAYS * 2) {
    guard += 1;
    const open = nextOpenWall(cursor, calendar);
    const window = windowContaining(open, calendar);
    if (!window) {
      // No open time found (all-closed calendar): stop rather than spin.
      break;
    }
    const available = (window.end - open) / MINUTE_MS;
    const take = Math.min(remaining, available);
    cursor = open + take * MINUTE_MS;
    remaining -= take;
  }

  return new Date(instantOf(cursor, calendar));
}

/** How many *open* business minutes lie between two instants (never negative). */
export function businessMinutesBetween(from: Date | string, to: Date | string, calendar: BusinessCalendar): number {
  const fromWall = wallOf(toDate(from).getTime(), calendar);
  const toWall = wallOf(toDate(to).getTime(), calendar);
  if (toWall <= fromWall) return 0;

  let cursor = fromWall;
  let total = 0;
  let guard = 0;

  while (cursor < toWall && guard < MAX_DAYS * 2) {
    guard += 1;
    const open = nextOpenWall(cursor, calendar);
    if (open >= toWall) break;
    const window = windowContaining(open, calendar);
    if (!window) break;
    const end = Math.min(window.end, toWall);
    total += (end - open) / MINUTE_MS;
    cursor = end;
  }

  return total;
}

function nextOpenWall(wallMs: number, calendar: BusinessCalendar): number {
  const dayStart = startOfWallDay(wallMs);
  for (let day = 0; day < MAX_DAYS; day += 1) {
    const probe = dayStart + day * DAY_MS;
    for (const window of windowsForWall(probe, calendar)) {
      const at = Math.max(window.start, wallMs);
      if (at < window.end) return at;
    }
  }
  return wallMs;
}

/* -------------------------------------------------------------------------- */
/*  Pause conditions                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A window during which the SLA clock does not run — a ticket waiting on the
 * customer, say. `endedAt === null` means the pause is still open.
 *
 * Pausing is what makes an SLA honest: time the desk is blocked on someone else
 * should never count against its attainment. A pause only removes *open business
 * minutes* inside its window, so a pause over a weekend subtracts nothing.
 */
export interface SlaPause {
  startedAt: Date | string;
  endedAt: Date | string | null;
}

/**
 * Coerce stored JSON (or anything else) into valid pauses, dropping malformed
 * entries rather than trusting the column. Kept here so both the ticket store
 * and any future importer validate a pause the same way.
 */
export function coercePauses(raw: unknown): SlaPause[] {
  if (!Array.isArray(raw)) return [];
  const pauses: SlaPause[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const startedAt = value.startedAt;
    if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) continue;
    const endedAt = value.endedAt;
    const ended = typeof endedAt === "string" && !Number.isNaN(Date.parse(endedAt)) ? endedAt : null;
    pauses.push({ startedAt, endedAt: ended });
  }
  return pauses;
}

/**
 * Pauses → the JSON shape stored on a ticket row. The inverse of
 * `coercePauses`, so a round-trip through the database is lossless.
 */
export function pausesToJson(pauses: readonly SlaPause[] | undefined): { startedAt: string; endedAt: string | null }[] {
  return (pauses ?? []).map((pause) => ({
    startedAt: toDate(pause.startedAt).toISOString(),
    endedAt: pause.endedAt === null ? null : toDate(pause.endedAt).toISOString(),
  }));
}

/** Completed pauses only — an open pause has no length yet and cannot extend a deadline. */
export function completedPauses(pauses: readonly SlaPause[] | undefined): SlaPause[] {
  return (pauses ?? []).filter((pause) => pause.endedAt !== null);
}

/** The still-open pause covering an instant, if any. */
export function openPauseAt(pauses: readonly SlaPause[] | undefined, instant: Date | string): SlaPause | null {
  const at = toDate(instant).getTime();
  for (const pause of pauses ?? []) {
    if (pause.endedAt !== null) continue;
    if (toDate(pause.startedAt).getTime() <= at) return pause;
  }
  return null;
}

/** Open business minutes that fall inside the given pauses, within `[from, to]`. */
export function pausedBusinessMinutes(
  from: Date | string,
  to: Date | string,
  calendar: BusinessCalendar,
  pauses: readonly SlaPause[] = [],
): number {
  const fromMs = toDate(from).getTime();
  const toMs = toDate(to).getTime();
  if (toMs <= fromMs) return 0;

  let total = 0;
  for (const pause of pauses) {
    const startMs = Math.max(fromMs, toDate(pause.startedAt).getTime());
    const endMs = Math.min(toMs, pause.endedAt === null ? toMs : toDate(pause.endedAt).getTime());
    if (endMs > startMs) total += businessMinutesBetween(new Date(startMs), new Date(endMs), calendar);
  }
  return total;
}

/** Open business minutes between two instants, not counting any paused time. */
export function businessMinutesElapsed(
  from: Date | string,
  to: Date | string,
  calendar: BusinessCalendar,
  pauses: readonly SlaPause[] = [],
): number {
  const total = businessMinutesBetween(from, to, calendar);
  return Math.max(0, total - pausedBusinessMinutes(from, to, calendar, pauses));
}

/** A pause expressed on the calendar's wall-clock axis. */
interface WallPause {
  start: number;
  end: number | null;
}

function toWallPauses(pauses: readonly SlaPause[], calendar: BusinessCalendar): WallPause[] {
  return pauses.map((pause) => ({
    start: wallOf(toDate(pause.startedAt).getTime(), calendar),
    end: pause.endedAt === null ? null : wallOf(toDate(pause.endedAt).getTime(), calendar),
  }));
}

function inWallPause(wallMs: number, pauses: readonly WallPause[]): WallPause | null {
  for (const pause of pauses) {
    const end = pause.end ?? Number.POSITIVE_INFINITY;
    if (pause.start <= wallMs && wallMs < end) return pause;
  }
  return null;
}

/** Advance past any pause the cursor sits inside, unless that pause is still open. */
function skipWallPauses(wallMs: number, pauses: readonly WallPause[]): number {
  let cursor = wallMs;
  for (let guard = 0; guard <= pauses.length; guard += 1) {
    const pause = inWallPause(cursor, pauses);
    if (!pause || pause.end === null) return cursor;
    cursor = Math.max(cursor, pause.end);
  }
  return cursor;
}

function nextWallPauseStart(wallMs: number, pauses: readonly WallPause[]): number | null {
  let best: number | null = null;
  for (const pause of pauses) {
    if (pause.start > wallMs && (best === null || pause.start < best)) best = pause.start;
  }
  return best;
}

/**
 * The next stretch of time that is both open and unpaused, starting at or after
 * `wallMs` and stopping at whichever comes first: the window closing, or the
 * next pause beginning. `null` when an open-ended pause blocks the way.
 */
function nextUnpausedBand(
  wallMs: number,
  calendar: BusinessCalendar,
  wallPauses: readonly WallPause[],
): { start: number; end: number } | null {
  const cursor = skipWallPauses(wallMs, wallPauses);
  if (inWallPause(cursor, wallPauses)?.end === null) return null;

  const dayStart = startOfWallDay(cursor);
  for (let day = 0; day < MAX_DAYS; day += 1) {
    for (const window of windowsForWall(dayStart + day * DAY_MS, calendar)) {
      const start = Math.max(window.start, cursor);
      if (start >= window.end) continue;
      const pauseStart = nextWallPauseStart(start, wallPauses);
      const end = pauseStart === null ? window.end : Math.min(window.end, pauseStart);
      if (end > start) return { start, end };
    }
  }
  return null;
}

/**
 * Advance by N *open, unpaused* business minutes. Paused time and closed time
 * both do not count, so the deadline of a ticket that sat waiting on a customer
 * moves out by exactly the business time it was paused. An open-ended pause
 * stops the walk, so a deadline can never be pushed through time that has not
 * elapsed yet — the deadline simply freezes until the pause closes.
 */
export function addUnpausedBusinessMinutes(
  from: Date | string,
  minutes: number,
  calendar: BusinessCalendar,
  pauses: readonly SlaPause[] = [],
): Date {
  const startWall = wallOf(toDate(from).getTime(), calendar);
  if (!Number.isFinite(minutes) || minutes <= 0) return new Date(instantOf(startWall, calendar));

  const wallPauses = toWallPauses(pauses, calendar);
  let cursor = startWall;
  let remaining = Math.trunc(minutes);
  let guard = 0;

  while (remaining > 0 && guard < MAX_DAYS * 3) {
    guard += 1;
    const band = nextUnpausedBand(cursor, calendar, wallPauses);
    if (!band) break;
    const span = (band.end - band.start) / MINUTE_MS;
    const take = Math.min(remaining, span);
    remaining -= take;
    cursor = take >= span ? band.end : band.start + take * MINUTE_MS;
  }

  return new Date(instantOf(cursor, calendar));
}

/* -------------------------------------------------------------------------- */
/*  Deadlines & clocks                                                        */
/* -------------------------------------------------------------------------- */

export interface SlaDeadlines {
  responseDueAt: Date;
  resolutionDueAt: Date;
}

/** The absolute deadlines a policy implies for a ticket started at `startedAt`. */
export function computeDeadlines(policy: SlaPolicy, startedAt: Date | string): SlaDeadlines {
  return {
    responseDueAt: addBusinessMinutes(startedAt, policy.responseMinutes, policy.calendar),
    resolutionDueAt: addBusinessMinutes(startedAt, policy.resolutionMinutes, policy.calendar),
  };
}

/**
 * The same deadlines, with completed pauses pushing them out. An open pause is
 * deliberately not applied yet: its length is unknown, so the deadline freezes
 * at the pause's start rather than being guessed.
 */
export function computeDeadlinesWithPauses(
  policy: SlaPolicy,
  startedAt: Date | string,
  pauses: readonly SlaPause[] = [],
): SlaDeadlines {
  const completed = completedPauses(pauses);
  return {
    responseDueAt: addUnpausedBusinessMinutes(startedAt, policy.responseMinutes, policy.calendar, completed),
    resolutionDueAt: addUnpausedBusinessMinutes(startedAt, policy.resolutionMinutes, policy.calendar, completed),
  };
}

export type SlaClockState = "met" | "on-track" | "warning" | "breached";
export type SlaClockKind = "response" | "resolution";

export interface SlaClockView {
  kind: SlaClockKind;
  targetMinutes: number;
  dueAt: Date;
  /** When the clock was satisfied, if it has been. */
  metAt: Date | null;
  /** Open business minutes consumed so far, paused time excluded. */
  elapsedMinutes: number;
  /** Open business minutes left before the deadline (`0` once past). */
  remainingMinutes: number;
  state: SlaClockState;
  /** True while an open pause is holding the clock (the values are frozen). */
  paused: boolean;
}

/** A ticket's SLA-relevant timing, independent of the persistence layer. */
export interface SlaInstance {
  policyId: string;
  startedAt: Date | string;
  /** First *public agent* reply, or `null` while the requester is still waiting. */
  firstResponseAt: Date | string | null;
  /** When the ticket was resolved, or `null`. */
  resolvedAt: Date | string | null;
  /** Windows during which the clock did not run (e.g. waiting on the customer). */
  pauses?: readonly SlaPause[];
}

/** The minimum a ticket must expose to build its SLA clocks. */
export interface SlaTimedTicket {
  createdAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  pauses?: readonly SlaPause[];
}

/** Project a ticket's timestamps onto the SLA instance the clocks read. */
export function slaInstanceFor(ticket: SlaTimedTicket, policyId: string): SlaInstance {
  return {
    policyId,
    startedAt: ticket.createdAt,
    firstResponseAt: ticket.firstResponseAt,
    resolvedAt: ticket.resolvedAt,
    pauses: ticket.pauses ?? [],
  };
}

function classify(remainingMinutes: number, targetMinutes: number, warningFraction: number): SlaClockState {
  if (remainingMinutes <= 0) return "breached";
  if (warningFraction > 0 && remainingMinutes <= targetMinutes * warningFraction) return "warning";
  return "on-track";
}

function view(
  kind: SlaClockKind,
  policy: SlaPolicy,
  instance: SlaInstance,
  targetMinutes: number,
  metAt: Date | null,
  now: Date,
): SlaClockView {
  const calendar = policy.calendar;
  const pauses = instance.pauses ?? [];
  const completed = completedPauses(pauses);
  const dueAt = addUnpausedBusinessMinutes(instance.startedAt, targetMinutes, calendar, completed);

  // While a pause is open the clock is frozen at the pause's start: elapsed and
  // remaining are computed as of that instant, so waiting on the customer can
  // neither burn the target nor trip a breach.
  const open = openPauseAt(pauses, now);
  const paused = open !== null;
  const effectiveNow = open ? toDate(open.startedAt) : toDate(now);

  const measuredTo = metAt ?? effectiveNow;
  const elapsedMinutes = businessMinutesElapsed(instance.startedAt, measuredTo, calendar, pauses);
  const remainingMinutes = metAt
    ? Math.max(0, targetMinutes - elapsedMinutes)
    : businessMinutesElapsed(effectiveNow, dueAt, calendar, completed);

  const state: SlaClockState = metAt
    ? elapsedMinutes <= targetMinutes
      ? "met"
      : "breached"
    : classify(remainingMinutes, targetMinutes, policy.warningFraction);

  return { kind, targetMinutes, dueAt, metAt, elapsedMinutes, remainingMinutes, state, paused };
}

/** The first-response clock: met the moment an agent first replies in public. */
export function responseClock(instance: SlaInstance, policy: SlaPolicy, now: Date | string): SlaClockView {
  const metAt = instance.firstResponseAt === null ? null : toDate(instance.firstResponseAt);
  return view("response", policy, instance, policy.responseMinutes, metAt, toDate(now));
}

/** The resolution clock: met the moment the ticket reaches `RESOLVED`. */
export function resolutionClock(instance: SlaInstance, policy: SlaPolicy, now: Date | string): SlaClockView {
  const metAt = instance.resolvedAt === null ? null : toDate(instance.resolvedAt);
  return view("resolution", policy, instance, policy.resolutionMinutes, metAt, toDate(now));
}

export interface SlaSummary {
  response: SlaClockView;
  resolution: SlaClockView;
  /** A clock is at risk while it is still running and warning or worse. */
  atRisk: boolean;
  /** Any clock that is already breached and unmet. */
  breached: boolean;
  /** Any running clock is held by an open pause. */
  paused: boolean;
  state: SlaClockState;
}

/**
 * Both clocks at once, plus the roll-up a dispatcher's view needs. `breached`
 * deliberately ignores a *met* clock: a ticket answered on time whose
 * resolution clock then lapsed is breached, but a resolved-early ticket is not.
 */
export function slaSummary(instance: SlaInstance, policy: SlaPolicy, now: Date | string): SlaSummary {
  const response = responseClock(instance, policy, now);
  const resolution = resolutionClock(instance, policy, now);

  const running = [response, resolution].filter((clock) => clock.metAt === null);
  const breached = running.some((clock) => clock.state === "breached");
  const atRisk = running.some((clock) => clock.state === "warning" || clock.state === "breached");
  const paused = running.some((clock) => clock.paused);
  const state: SlaClockState = breached ? "breached" : atRisk ? "warning" : response.state === "met" && resolution.state === "met" ? "met" : "on-track";

  return { response, resolution, atRisk, breached, paused, state };
}

/* -------------------------------------------------------------------------- */
/*  Policy selection & validation                                             */
/* -------------------------------------------------------------------------- */

/** The policy that applies to a ticket of this priority, most specific first. */
export function policyForPriority(policies: readonly SlaPolicy[], priority: TicketPriority): SlaPolicy | null {
  return policies.find((policy) => policy.priority === priority) ?? policies.find((policy) => policy.priority === undefined) ?? null;
}

export interface SlaPolicyIssue {
  field: string;
  message: string;
}

/** Validate a policy before it is stored. Returns every problem, not the first. */
export function validateSlaPolicy(policy: Partial<SlaPolicy>): SlaPolicyIssue[] {
  const issues: SlaPolicyIssue[] = [];

  if (!policy.name?.trim()) issues.push({ field: "name", message: "A policy name is required." });

  const response = policy.responseMinutes;
  if (typeof response !== "number" || !Number.isFinite(response) || response < 0) {
    issues.push({ field: "responseMinutes", message: "The response target must be zero or more minutes." });
  }
  const resolution = policy.resolutionMinutes;
  if (typeof resolution !== "number" || !Number.isFinite(resolution) || resolution < 0) {
    issues.push({ field: "resolutionMinutes", message: "The resolution target must be zero or more minutes." });
  }
  if (
    typeof response === "number" &&
    typeof resolution === "number" &&
    Number.isFinite(response) &&
    Number.isFinite(resolution) &&
    resolution < response
  ) {
    issues.push({ field: "resolutionMinutes", message: "Resolution cannot be due before the first response." });
  }

  const warning = policy.warningFraction;
  if (warning !== undefined && (typeof warning !== "number" || warning < 0 || warning > 1)) {
    issues.push({ field: "warningFraction", message: "The warning fraction must be between 0 and 1." });
  }

  if (policy.calendar && !isValidCalendar(policy.calendar)) {
    issues.push({ field: "calendar", message: "The calendar's weekly windows are malformed." });
  }

  return issues;
}

function isValidCalendar(calendar: BusinessCalendar): boolean {
  if (calendar.week.length !== 7) return false;
  return calendar.week.every((windows) =>
    windows.every((window) => window.startMinute >= 0 && window.endMinute <= 24 * 60 && window.startMinute < window.endMinute),
  );
}

/**
 * A weekly attainment figure: the share of closed clocks that met their target.
 * `null` when there is nothing to measure, so a report never shows a fake 100%.
 */
export function attainmentPercent(views: readonly SlaClockView[]): number | null {
  const decided = views.filter((clock) => clock.metAt !== null);
  if (decided.length === 0) return null;
  const met = decided.filter((clock) => clock.state === "met").length;
  return Math.round((met / decided.length) * 1000) / 10;
}

/** First-response and resolution durations for a resolved clock, in minutes. */
export function clockDurationMinutes(clock: SlaClockView): number | null {
  return clock.metAt === null ? null : clock.elapsedMinutes;
}
