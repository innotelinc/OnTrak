/**
 * Timing integrity (2.2) — what the browser reported about time away from an
 * attempt, reduced to a record a person can read.
 *
 * Why the record is shaped the way it is:
 *
 *  - **It is a claim, not a measurement.** The intervals come from
 *    `visibilitychange` in the learner's browser, and a browser is software the
 *    learner controls. The record says `source: "browser-reported"` so neither a
 *    reviewer nor a later report can mistake it for something the server
 *    observed. It is evidence that an interval was reported, nothing more.
 *  - **It is never an input to a score.** Nothing here is imported by
 *    `sim/grade.ts`, and a re-grade does not read it. The control exists so a
 *    higher-stakes assessment can say "43 s away in 2 intervals" beside the
 *    result, not so a learner can be failed by a lost tab.
 *  - **Every claim is clamped to the attempt.** A client with a wrong clock, or
 *    a page left hidden overnight, cannot turn into a week off-task: intervals
 *    outside `[startedAt, submittedAt | now]` are trimmed, a single interval past
 *    `MAX_INTERVAL_MS` is discarded as broken, and the total is capped. The cap
 *    is recorded (`capped: true`) rather than silently applied.
 *  - **Intervals, not events.** A tab that loses focus five times in a minute is
 *    one period away. Overlapping and touching claims are merged before they are
 *    counted, which also makes a retried batch idempotent: the same claim merged
 *    twice is the same interval.
 *
 * Pure: no clock of its own, no database, no framework. The instants — including
 * "now" and the attempt's window — are passed in, which is what makes all of the
 * above testable without a browser.
 */

/** The only source a record may claim. */
export const TIMING_INTEGRITY_SOURCE = "browser-reported" as const;

/** A batch this large is a broken client, not a learner switching tabs. */
export const MAX_TIMING_CLAIMS = 500;

/** Short switches are redraws and mis-clicks, not time away. */
export const MIN_INTERVAL_MS = 1_000;

/**
 * One claimed interval longer than this is a page left hidden, a suspended
 * laptop, or a clock that moved — not a batch of work someone walked away from.
 * The interval is dropped rather than clamped to this number: the record should
 * say "we could not read that claim", not invent four hours.
 */
export const MAX_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * The most time away one attempt may record. A six-hour cap is far beyond any
 * honest sitting of a thirty-minute scenario, so hitting it means the claims are
 * not describing this attempt; the record states that it was capped.
 */
export const MAX_AWAY_SECONDS = 6 * 60 * 60;

/** One interval as the browser reports it: two ISO instants. */
export interface TimingClaim {
  hiddenAt: string;
  shownAt: string;
}

/** One merged, clamped interval as it is stored. */
export interface TimingSpan {
  start: string;
  end: string;
}

/**
 * What is written to `Attempt.integrity`.
 *
 * The spans are kept, not only the totals: a later batch has to be merged with
 * what is already stored, and a reviewer comparing two reports needs the periods
 * rather than a number that could have come from anywhere.
 */
export interface TimingIntegrityRecord {
  source: typeof TIMING_INTEGRITY_SOURCE;
  /** Merged, clamped, non-overlapping. */
  spans: TimingSpan[];
  intervals: number;
  awaySeconds: number;
  longestSeconds: number;
  firstHiddenAt: string | null;
  /** True when the cap, not the claims, decided `awaySeconds`. */
  capped: boolean;
  /** When the server wrote this record. The claims' own clock is not trusted. */
  reportedAt: string;
}

/** The attempt's own window; `end` is null while it is still running. */
export interface TimingWindow {
  start: Date | string | number;
  end?: Date | string | number | null;
}

function milliseconds(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a batch from a client without trusting it.
 *
 * Malformed entries are dropped here rather than refused: a broken batch must
 * not stop an attempt, and the batch is only ever a hint about focus. The
 * *newest* claims are kept when a client floods the door, because the alternative
 * drops what just happened in favour of what happened at the start.
 */
export function readTimingClaims(raw: unknown): TimingClaim[] {
  if (!Array.isArray(raw)) return [];
  const claims: TimingClaim[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    if (typeof entry.hiddenAt !== "string" || typeof entry.shownAt !== "string") continue;
    claims.push({ hiddenAt: entry.hiddenAt, shownAt: entry.shownAt });
  }
  return claims.slice(-MAX_TIMING_CLAIMS);
}

/** The stored spans, as claims, so a new batch can be merged with them. */
export function claimsFromSpans(spans: readonly TimingSpan[]): TimingClaim[] {
  return spans.map((span) => ({ hiddenAt: span.start, shownAt: span.end }));
}

/**
 * The record for a set of claims inside one attempt's window.
 *
 * `now` is the server's clock; when the attempt is still running it is also the
 * end of the window, so a claim that has not been closed yet is trimmed to this
 * moment rather than trusted to a future instant.
 */
export function timingRecordFor(
  claims: readonly TimingClaim[],
  window: TimingWindow,
  now: Date | number = Date.now(),
): TimingIntegrityRecord {
  const nowMs = milliseconds(now) ?? Date.now();
  const windowStart = milliseconds(window.start);
  const windowEnd = milliseconds(window.end ?? null) ?? nowMs;
  const reportedAt = new Date(nowMs).toISOString();

  if (windowStart === null || windowEnd <= windowStart) {
    return {
      source: TIMING_INTEGRITY_SOURCE,
      spans: [],
      intervals: 0,
      awaySeconds: 0,
      longestSeconds: 0,
      firstHiddenAt: null,
      capped: false,
      reportedAt,
    };
  }

  const intervals: { start: number; end: number }[] = [];
  for (const claim of claims.slice(-MAX_TIMING_CLAIMS)) {
    const hidden = milliseconds(claim.hiddenAt);
    const shown = milliseconds(claim.shownAt);
    if (hidden === null || shown === null) continue;
    // A claim that ends before it begins is not an interval; neither is one the
    // browser says lasted a week. Dropping it is the honest reading — clamping it
    // to the maximum would put four hours in the record that nobody reported.
    if (shown <= hidden) continue;
    if (shown - hidden > MAX_INTERVAL_MS) continue;

    const start = Math.max(hidden, windowStart);
    const end = Math.min(shown, windowEnd);
    if (end - start < MIN_INTERVAL_MS) continue;
    intervals.push({ start, end });
  }

  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    // Touching intervals are one period away: a tab that reports hidden/shown
    // twice across one switch is one absence, not two.
    if (last && interval.start <= last.end + 1) {
      last.end = Math.max(last.end, interval.end);
      continue;
    }
    merged.push({ ...interval });
  }

  const totalMs = merged.reduce((sum, interval) => sum + (interval.end - interval.start), 0);
  const longestMs = merged.reduce((most, interval) => Math.max(most, interval.end - interval.start), 0);
  const awaySeconds = Math.round(totalMs / 1000);

  return {
    source: TIMING_INTEGRITY_SOURCE,
    spans: merged.map((interval) => ({
      start: new Date(interval.start).toISOString(),
      end: new Date(interval.end).toISOString(),
    })),
    intervals: merged.length,
    awaySeconds: Math.min(MAX_AWAY_SECONDS, awaySeconds),
    longestSeconds: Math.min(MAX_AWAY_SECONDS, Math.round(longestMs / 1000)),
    firstHiddenAt: merged.length > 0 ? new Date(merged[0]!.start).toISOString() : null,
    capped: awaySeconds > MAX_AWAY_SECONDS,
    reportedAt,
  };
}

/**
 * Merge a new batch into the record already stored for the attempt.
 *
 * The stored spans go back through `timingRecordFor`, so a record written before
 * the window's end can be re-clamped as the attempt goes on, and a retried batch
 * lands on the intervals it already covered instead of counting twice.
 */
export function mergeTimingRecord(
  existing: TimingIntegrityRecord | null,
  claims: readonly TimingClaim[],
  window: TimingWindow,
  now: Date | number = Date.now(),
): TimingIntegrityRecord {
  return timingRecordFor([...claimsFromSpans(existing?.spans ?? []), ...claims], window, now);
}

/**
 * Read `Attempt.integrity` back into a record, or null when it is not one.
 *
 * Rows written by an older version, a hand edit, or a different product are not
 * a timing record, and a page renders nothing rather than guessing at the shape.
 * The stored spans are re-reduced, so a record that somehow holds overlapping
 * periods reads back with the same interval count the rules would have written.
 */
export function readTimingRecord(raw: unknown): TimingIntegrityRecord | null {
  if (!isRecord(raw)) return null;
  if (raw.source !== TIMING_INTEGRITY_SOURCE) return null;
  if (!Array.isArray(raw.spans)) return null;

  const spans: TimingSpan[] = [];
  for (const entry of raw.spans) {
    if (!isRecord(entry)) continue;
    if (typeof entry.start !== "string" || typeof entry.end !== "string") continue;
    const start = milliseconds(entry.start);
    const end = milliseconds(entry.end);
    if (start === null || end === null || end <= start) continue;
    spans.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  }

  const reportedAt = milliseconds(raw.reportedAt) ?? Date.now();
  if (spans.length === 0) {
    return {
      source: TIMING_INTEGRITY_SOURCE,
      spans: [],
      intervals: 0,
      awaySeconds: 0,
      longestSeconds: 0,
      firstHiddenAt: null,
      capped: false,
      reportedAt: new Date(reportedAt).toISOString(),
    };
  }

  // The spans are the record; the totals beside them are a convenience. Reducing
  // the spans again means a hand-edited total cannot disagree with the periods.
  const start = spans.reduce((earliest, span) => Math.min(earliest, milliseconds(span.start) ?? 0), Infinity);
  const end = spans.reduce((latest, span) => Math.max(latest, milliseconds(span.end) ?? 0), 0);
  return timingRecordFor(claimsFromSpans(spans), { start, end }, reportedAt);
}

/** A human duration for the record's one-line summary. */
export function formatTimingDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} s`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (minutes < 60) return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining === 0 ? `${hours} h` : `${hours} h ${remaining} min`;
}

/**
 * The sentence a report shows. It never says "cheating", "integrity violation" or
 * "proctored": the record cannot support any of those readings, and the control
 * is explicitly not a punishment.
 */
export function describeTimingRecord(record: TimingIntegrityRecord): string {
  if (record.intervals === 0) return "No time away was recorded.";
  const intervals = `${record.intervals} interval${record.intervals === 1 ? "" : "s"}`;
  const capped = record.capped ? ", capped" : "";
  return `${formatTimingDuration(record.awaySeconds)} away in ${intervals}${capped}; recorded, not scored.`;
}

/**
 * Whether a scenario opted into the control.
 *
 * Read from the definition rather than a column so the flag travels with an
 * exported/imported scenario and cannot disagree with the version a learner ran.
 * Anything other than an explicit `true` is off, including a missing block — the
 * default is the one that records nothing.
 */
export function timingIntegrityEnabled(definition: unknown): boolean {
  if (!isRecord(definition)) return false;
  const integrity = definition.integrity;
  return isRecord(integrity) && integrity.recordFocusLoss === true;
}
