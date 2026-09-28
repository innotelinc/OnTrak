/**
 * Pure coercion rules for values that arrive from HTML forms.
 *
 * Server actions read `FormData` directly, so every numeric or date field needs
 * one place that decides how the raw string is interpreted. Keeping those rules
 * here rather than inline in the actions is what pins the *units* down: the
 * "time limit" bug was exactly a mismatch between what a label promised
 * (minutes) and what the action assumed (seconds).
 */

/* -------------------------------------------------------------------------- */
/*  Identifiers                                                               */
/* -------------------------------------------------------------------------- */

/** Read an optional id field: blank or whitespace means "not supplied". */
export function optionalId(value: unknown): string | null {
  const id = String(value ?? "").trim();
  return id.length > 0 ? id : null;
}

/* -------------------------------------------------------------------------- */
/*  Assignment overrides                                                      */
/* -------------------------------------------------------------------------- */

const SECONDS_PER_MINUTE = 60;

/**
 * Convert an assignment time-limit override entered in minutes into the seconds
 * the database column and the expiry maths expect.
 *
 * Blank, zero, negative and non-numeric input all mean "no override", so the
 * caller falls back to the scenario's own limit. Returns `null` in that case.
 */
export function assignmentTimeLimitSec(minutes: unknown): number | null {
  const value = typeof minutes === "number" ? minutes : Number(String(minutes ?? "").trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * SECONDS_PER_MINUTE);
}

/* -------------------------------------------------------------------------- */
/*  Dates                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Outcome of parsing a raw date field.
 *
 * A blank field is a legitimate "no date" rather than an error, whereas a
 * present-but-malformed value is something the action should flash back instead
 * of handing Prisma an `Invalid Date` (which throws).
 */
export type DateParseResult =
  | { ok: true; date: Date | null }
  | { ok: false; reason: string };

const BLANK_DATE: DateParseResult = { ok: true, date: null };
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Build a UTC instant from explicit components, rejecting anything `Date` would
 * silently roll over (Feb 31, hour 25, minute 61, ...).
 */
function utcInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  endOfDay: boolean,
): Date | null {
  const parsed = endOfDay
    ? new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999))
    : new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  if (
    !endOfDay &&
    (parsed.getUTCHours() !== hour || parsed.getUTCMinutes() !== minute || parsed.getUTCSeconds() !== second)
  ) {
    return null;
  }
  return parsed;
}

/**
 * Interpret a `<input type="date">` value (`YYYY-MM-DD`) as a deadline.
 *
 * HTML date inputs carry no time, so the only sensible reading of "expires on
 * the 26th" is the *end* of that day: a licence shown as expiring on 2026-09-26
 * stays valid all through that date and lapses at midnight UTC afterwards.
 * Blank input yields `{ ok: true, date: null }`; an impossible value is an
 * error the caller can surface.
 */
export function parseDateInput(value: unknown): DateParseResult {
  const raw = String(value ?? "").trim();
  if (!raw) return BLANK_DATE;

  const match = DATE_PATTERN.exec(raw);
  if (!match) return { ok: false, reason: "That is not a valid date." };

  const date = utcInstant(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, 0, true);
  return date ? { ok: true, date } : { ok: false, reason: "That is not a valid date." };
}

/**
 * Interpret a `<input type="datetime-local">` value (`YYYY-MM-DDTHH:mm`) as an
 * instant.
 *
 * The value carries no timezone, so it is read as UTC to match how the rest of
 * the app stores and renders timestamps — reading it as server-local time would
 * make a deadline shift with the host's timezone.
 */
export function parseDateTimeInput(value: unknown): DateParseResult {
  const raw = String(value ?? "").trim();
  if (!raw) return BLANK_DATE;

  const match = DATETIME_PATTERN.exec(raw);
  if (!match) return { ok: false, reason: "That is not a valid date and time." };

  const date = utcInstant(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0),
    false,
  );
  return date ? { ok: true, date } : { ok: false, reason: "That is not a valid date and time." };
}

/* -------------------------------------------------------------------------- */
/*  Account edits                                                            */
/* -------------------------------------------------------------------------- */

export interface UserEditInput<TRole extends string = string> {
  /** Is the editor changing their own account? */
  isSelf: boolean;
  /** Raw `role` field, or "" when the control was disabled and submitted nothing. */
  requestedRole: string;
  /** Roles the action is willing to store. */
  validRoles: readonly TRole[];
  /** Raw `active` field; `"on"`/`"true"` mean the box was checked. */
  activeField: unknown;
  currentRole: TRole;
  currentActive: boolean;
}

export interface UserEditResolution<TRole extends string = string> {
  role: TRole;
  active: boolean;
  /** Set when the edit would strip the editor's own administrator access. */
  error?: string;
}

/**
 * Work out the role and active flag an account edit should write.
 *
 * When an administrator edits their own row the role select and active checkbox
 * are `disabled`, and a disabled control submits nothing — so a naive read sees
 * an empty role and a deactivated account. For self-edits we hold the current
 * values instead, then refuse any change that would remove the editor's own
 * administrator access.
 */
export function resolveUserEdit<TRole extends string>({
  isSelf,
  requestedRole,
  validRoles,
  activeField,
  currentRole,
  currentActive,
}: UserEditInput<TRole>): UserEditResolution<TRole> {
  const role = (validRoles as readonly string[]).includes(requestedRole) ? (requestedRole as TRole) : currentRole;
  const active = isSelf ? currentActive : activeField === "on" || activeField === "true";

  if (isSelf && (!active || role !== "ADMIN")) {
    return { role, active, error: "You cannot remove your own administrator access." };
  }
  return { role, active };
}
