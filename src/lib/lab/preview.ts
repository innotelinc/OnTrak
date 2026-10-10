/**
 * A check or a write-up *preview*, held in process memory and nowhere else.
 *
 * The lab is results-only: a student's own "check my work" is shown and never stored, and a
 * write-up can be marked for feedback before it is handed in. The Python portal kept both
 * in `app.state.preview_reports` / `preview_tickets` — dictionaries on the ASGI app — and
 * this is the same thing for a Next server: a module-level map, keyed by the student and
 * the session, with a short life.
 *
 * **Why not the database.** Because a preview is not a result. Storing one would put an
 * unsubmitted attempt in the results table, which is the leak the port's ticket design
 * already refuses twice (`store.ts`: "a draft is not a grade"). What a preview needs is to
 * survive the redirect that shows it, and nothing more.
 *
 * **Why it is best-effort, and why that is stated rather than hidden.** A server action's
 * redirect and the page render that follows are not guaranteed to be the same process — a
 * deployment running several instances, or one that restarts between the two, will simply
 * not have the preview. That is a *smaller* loss than it sounds: the action's flash message
 * carries the grade summary either way, the submission's own feedback is served from the
 * stored grade, and a preview that is missing shows as "no preview yet" rather than as a
 * wrong number.
 *
 * Bounded on purpose: a process that lives for weeks must not accumulate every preview
 * every student ever ran, so entries expire and the map is capped.
 */

import type { ScoreReport } from "./models";
import type { TicketGrade } from "./tickets";

/** A preview is worth remembering for as long as a student might look at the page. */
export const PREVIEW_TTL_MS = 30 * 60_000;
/** The most previews one process holds. The oldest are dropped first. */
export const PREVIEW_LIMIT = 500;

export interface Preview {
  /** The machine half: the last check the student ran, unrecorded. */
  report: ScoreReport | null;
  /** The write-up half: the last preview of the ticket, unmarked in the ledger. */
  grade: TicketGrade | null;
  at: number;
}

const previews = new Map<string, Preview>();

/** One student's preview of one session. The student is in the key: two people share no preview. */
export function previewKey(student: string, sessionId: number): string {
  return `${student.trim().toLowerCase()}\u0000${sessionId}`;
}

/** Remember a preview, replacing whichever half of it was there before. */
export function rememberPreview(
  key: string,
  value: { report?: ScoreReport | null; grade?: TicketGrade | null },
  now: number = Date.now(),
): void {
  const previous = previews.get(key);
  previews.set(key, {
    report: value.report !== undefined ? value.report : (previous?.report ?? null),
    grade: value.grade !== undefined ? value.grade : (previous?.grade ?? null),
    at: now,
  });
  // `Map` iterates in insertion order, so the first key is the oldest.
  while (previews.size > PREVIEW_LIMIT) {
    const oldest = previews.keys().next();
    if (oldest.done === true) break;
    previews.delete(oldest.value);
  }
}

/** The preview for a key, or `null` — expired entries are forgotten as they are read. */
export function readPreview(key: string, now: number = Date.now()): Preview | null {
  const found = previews.get(key);
  if (found === undefined) return null;
  if (now - found.at > PREVIEW_TTL_MS) {
    previews.delete(key);
    return null;
  }
  return found;
}

/** Forget a session's preview: its result is now a stored one, and two answers are one too many. */
export function forgetPreview(key: string): void {
  previews.delete(key);
}

/** Drop every preview. For tests, and for a host shutting down. */
export function forgetAllPreviews(): void {
  previews.clear();
}
