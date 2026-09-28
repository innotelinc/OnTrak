/**
 * Rota and handoff rules (M4): who is on, when, and what changed hands.
 *
 * A desk that never writes a rota still has one — it lives in somebody's head,
 * and it is wrong exactly when it matters: a handover nobody wrote down, an
 * on-call week nobody can name, an hour with nobody watching. So the rota is
 * here for three questions, all of which have a wrong answer that costs money:
 *
 *  - **Who is on call at 03:00 Thursday?** `coverageAt` answers it, and answers
 *    it from the shifts themselves rather than from a field somebody forgot to
 *    update.
 *  - **Where is nobody on call?** `coverageGaps` returns the uncovered intervals
 *    inside a window, because a gap you can see is a gap somebody fixes.
 *  - **What changed hands?** A handoff outlives the shift it happened in: it
 *    names the person handing over, the person taking it, and — this is the part
 *    a chat message loses — **the work that was still open**, by reference.
 *
 * Three refusals worth stating, because each is a real desk's failure mode
 * rather than a theoretical one:
 *
 *  - **A shift cannot overlap another for the same person.** Double-booking is
 *    how somebody ends up on call twice and on it neither time.
 *  - **A shift cannot be longer than a day.** Past 24 hours it is not a rota
 *    entry, it is an unbroken on-call week typed into one field.
 *  - **A handoff needs a note.** "Anything to report? — no" is information; an
 *    empty handoff is the thing this module exists to prevent.
 */

import { hasPermission, type Actor, type Role } from "./access-rules";

export const SHIFT_NOTE_MAX = 1000;
export const HANDOFF_NOTE_MAX = 2000;
/** A handoff note shorter than this is not a handoff, it is a shrug. */
export const HANDOFF_MIN_NOTE = 8;
/** Past this, the "shift" is a mis-typed on-call week, not a shift. */
export const MAX_SHIFT_MINUTES = 24 * 60;
/** How far ahead a rota may be published, so a typo cannot fill the calendar. */
export const MAX_SHIFT_HORIZON_DAYS = 400;

export type ShiftKind = "SHIFT" | "ON_CALL";

export interface RotaShiftRecord {
  id: string;
  tenantId: string;
  /** The queue the person covers, or `null` for the whole desk. */
  queueId: string | null;
  userId: string;
  kind: ShiftKind;
  startsAt: string;
  endsAt: string;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface HandoffRecord {
  id: string;
  tenantId: string;
  queueId: string | null;
  fromUserId: string;
  toUserId: string | null;
  note: string;
  /** The work handed over, named by reference so nothing depends on memory. */
  openTicketRefs: string[];
  at: string;
}

export interface RotaIssue {
  field: string;
  message: string;
}

/* -------------------------------------------------------------------------- */
/*  Writing a shift                                                           */
/* -------------------------------------------------------------------------- */

export function validateShift(input: {
  startsAt?: string;
  endsAt?: string;
  note?: string | null;
}): RotaIssue[] {
  const issues: RotaIssue[] = [];

  const start = input.startsAt ? new Date(input.startsAt) : null;
  const end = input.endsAt ? new Date(input.endsAt) : null;

  if (!start || Number.isNaN(start.getTime())) {
    issues.push({ field: "startsAt", message: "Give the shift a start time." });
  }
  if (!end || Number.isNaN(end.getTime())) {
    issues.push({ field: "endsAt", message: "Give the shift an end time." });
  }
  if (start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
    if (end.getTime() <= start.getTime()) {
      issues.push({ field: "endsAt", message: "A shift has to end after it starts." });
    } else if (end.getTime() - start.getTime() > MAX_SHIFT_MINUTES * 60_000) {
      issues.push({
        field: "endsAt",
        message: `A shift may be at most ${MAX_SHIFT_MINUTES / 60} hours. Split the period into the shifts people actually work.`,
      });
    }
  }

  const note = (input.note ?? "").trim();
  if (note.length > SHIFT_NOTE_MAX) {
    issues.push({ field: "note", message: `A shift note may be at most ${SHIFT_NOTE_MAX} characters.` });
  }

  return issues;
}

/** Two windows that share any time at all. Touching ends do not overlap. */
export function shiftsOverlap(a: Pick<RotaShiftRecord, "startsAt" | "endsAt">, b: Pick<RotaShiftRecord, "startsAt" | "endsAt">): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

/**
 * The shift a candidate collides with, if any.
 *
 * Only the *same person* can collide. Covering the same hours as a colleague is
 * called a team; being in two places at once is called a mistake. A worked shift
 * and an on-call window are the same person's time either way, so the collision
 * check ignores `kind` — the desk cannot have somebody working 09:00–17:00 and
 * on call 09:00–17:00 and expect either to mean anything.
 */
export function shiftConflict(
  candidate: Pick<RotaShiftRecord, "userId" | "startsAt" | "endsAt">,
  existing: readonly RotaShiftRecord[],
  ignoreId?: string,
): RotaShiftRecord | null {
  return (
    existing.find(
      (shift) => shift.userId === candidate.userId && shift.id !== ignoreId && shiftsOverlap(candidate, shift),
    ) ?? null
  );
}

/* -------------------------------------------------------------------------- */
/*  Coverage                                                                  */
/* -------------------------------------------------------------------------- */

export interface CoverageAt {
  /** The moment asked about. */
  at: string;
  working: RotaShiftRecord[];
  onCall: RotaShiftRecord[];
  covered: boolean;
  /** Who to reach, on-call first — the person to wake is the one holding the pager. */
  reachable: string[];
}

/** Who is covering a moment: working first, then on the pager. */
export function coverageAt(shifts: readonly RotaShiftRecord[], at: string, queueId?: string | null): CoverageAt {
  const active = shifts.filter(
    (shift) =>
      (queueId === undefined || shift.queueId === queueId) &&
      shift.startsAt <= at &&
      at < shift.endsAt,
  );
  const onCall = active.filter((shift) => shift.kind === "ON_CALL");
  return {
    at,
    working: active.filter((shift) => shift.kind === "SHIFT"),
    onCall,
    covered: onCall.length > 0,
    reachable: [...new Set([...onCall, ...active.filter((s) => s.kind === "SHIFT")].map((shift) => shift.userId))],
  };
}

export interface CoverageGap {
  from: string;
  to: string;
  minutes: number;
}

/**
 * The intervals inside a window with nobody on call.
 *
 * Uses on-call shifts only: somebody being at their desk is not cover at 03:00,
 * and the whole value of this list is that it names the hours nobody is holding
 * the pager. Windows are walked in order, so overlapping shifts merge instead of
 * producing a gap that has already been filled.
 */
export function coverageGaps(
  shifts: readonly RotaShiftRecord[],
  from: string,
  to: string,
  queueId?: string | null,
): CoverageGap[] {
  const onCall = shifts
    .filter((shift) => shift.kind === "ON_CALL" && (queueId === undefined || shift.queueId === queueId))
    .filter((shift) => shift.endsAt > from && shift.startsAt < to)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || b.endsAt.localeCompare(a.endsAt));

  const gaps: CoverageGap[] = [];
  let cursor = from;

  for (const shift of onCall) {
    const start = shift.startsAt < from ? from : shift.startsAt;
    if (start > cursor) gaps.push(gap(cursor, start));
    if (shift.endsAt > cursor) cursor = shift.endsAt > to ? to : shift.endsAt;
  }

  if (cursor < to) gaps.push(gap(cursor, to));
  return gaps;
}

function gap(from: string, to: string): CoverageGap {
  return { from, to, minutes: Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000) };
}

export interface RotaLoad {
  userId: string;
  shiftMinutes: number;
  onCallMinutes: number;
  shifts: number;
  /** True when one person holds more than half of a window's on-call hours. */
  overloaded: boolean;
}

/**
 * How the on-call hours are shared out. Reported per person because the failure
 * this catches — one name on every window — is invisible in a list of shifts and
 * obvious in a column of totals.
 */
export function rotaLoad(shifts: readonly RotaShiftRecord[], from: string, to: string): RotaLoad[] {
  const inside = shifts.filter((shift) => shift.endsAt > from && shift.startsAt < to);
  const totalOnCall = inside
    .filter((shift) => shift.kind === "ON_CALL")
    .reduce((sum, shift) => sum + overlapMinutes(shift, from, to), 0);

  const byUser = new Map<string, RotaLoad>();
  for (const shift of inside) {
    const minutes = overlapMinutes(shift, from, to);
    const current = byUser.get(shift.userId) ?? { userId: shift.userId, shiftMinutes: 0, onCallMinutes: 0, shifts: 0, overloaded: false };
    if (shift.kind === "ON_CALL") current.onCallMinutes += minutes;
    else current.shiftMinutes += minutes;
    current.shifts += 1;
    byUser.set(shift.userId, current);
  }

  return [...byUser.values()]
    .map((load) => ({ ...load, overloaded: totalOnCall > 0 && load.onCallMinutes > totalOnCall / 2 }))
    .sort((a, b) => b.onCallMinutes - a.onCallMinutes || a.userId.localeCompare(b.userId));
}

function overlapMinutes(shift: Pick<RotaShiftRecord, "startsAt" | "endsAt">, from: string, to: string): number {
  const start = shift.startsAt < from ? from : shift.startsAt;
  const end = shift.endsAt > to ? to : shift.endsAt;
  return Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000));
}

/* -------------------------------------------------------------------------- */
/*  Handing over                                                              */
/* -------------------------------------------------------------------------- */

export interface HandoffIssue {
  field: string;
  message: string;
}

export interface HandoffDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Whether a handoff may be recorded.
 *
 * The person handing over has to be the one actually on the shift (or run the
 * desk, because a manager covering for somebody who went home is not a violation
 * of anything), and the note has to say something. The tickets being handed over
 * are named rather than counted, since "3 open tickets" tells the next person
 * nothing they can act on.
 */
export function handoffDecision(input: {
  actor: Actor;
  onDuty: readonly RotaShiftRecord[];
  onDutyNow: boolean;
  note: string;
  toUserId?: string | null;
}): HandoffDecision {
  const role = input.actor.role as Role;
  if (!hasPermission(role, "ticket:update")) {
    return { allowed: false, reason: "You do not hand work over." };
  }
  if (!input.onDutyNow && !hasPermission(role, "queue:manage")) {
    const next = input.onDuty[0];
    return {
      allowed: false,
      reason: next
        ? `That work belongs to the shift on now. It is covered by ${next.userId}; hand it over from there.`
        : "You are not on the rota for the desk right now, so there is nothing for you to hand over.",
    };
  }
  if (input.note.trim().length < HANDOFF_MIN_NOTE) {
    return { allowed: false, reason: "Write what the next person needs to know — an empty handoff loses exactly what it exists to keep." };
  }
  if (input.toUserId && input.toUserId === input.actor.id) {
    return { allowed: false, reason: "You cannot hand work to yourself." };
  }
  return { allowed: true, reason: `Handed over with ${input.note.trim().length} characters of context.` };
}

export function validateHandoff(input: { note?: string; openTicketRefs?: readonly string[] }): HandoffIssue[] {
  const issues: HandoffIssue[] = [];
  const note = (input.note ?? "").trim();
  if (note.length > HANDOFF_NOTE_MAX) {
    issues.push({ field: "note", message: `A handoff note may be at most ${HANDOFF_NOTE_MAX} characters.` });
  }
  const refs = input.openTicketRefs ?? [];
  if (refs.length > 200) {
    issues.push({ field: "openTicketRefs", message: "Hand over at most 200 tickets at once — if it is more than that, the queue is the problem." });
  }
  return issues;
}

/**
 * The work handed over that has not been mentioned since.
 *
 * A handoff that lists a ticket and a later handoff that does not is the signal
 * that it was dealt with — which is the question the next shift actually asks,
 * and the reason handing over is worth writing down at all.
 */
/**
 * The work that survived the last change of hands.
 *
 * Each handoff lists what was open when it was written, so the *newest* one is
 * the current answer and an older one is history: a ticket that appeared in an
 * earlier handoff and not in the latest one was resolved, moved or taken — which
 * is exactly the question the arriving shift asks, and the reason the list is
 * written down rather than remembered.
 */
export function outstandingFrom(handoffs: readonly HandoffRecord[], refs: readonly string[]): string[] {
  const newest = [...handoffs].sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!newest) return [];
  return refs.filter((ref) => newest.openTicketRefs.includes(ref));
}

/** One line for the console: what the rota says about right now. */
export function coverageSummary(coverage: CoverageAt): string {
  if (!coverage.covered) {
    const working = coverage.working.length > 0 ? ` ${coverage.working.length} on shift, nobody on call.` : " Nobody is on call.";
    return `No cover at ${coverage.at}.${working}`;
  }
  const names = coverage.onCall.map((shift) => shift.userId).join(", ");
  return `On call at ${coverage.at}: ${names}.`;
}
