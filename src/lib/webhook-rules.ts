/**
 * Attempt events, for a consumer outside this deployment.
 *
 * Grading already ends with a row and a page. A webhook is what makes the same
 * fact usable by a system this app does not own — an LMS, a skills matrix, a
 * spreadsheet somebody's manager maintains — and the whole difficulty of a
 * webhook is that the consumer is *not here*: nobody is watching the response,
 * so every claim the sender makes has to be checkable later and twice-delivered
 * facts have to be recognisable.
 *
 * Three decisions, all of them about that distance:
 *
 * * The event id is derived from `(event, attemptId, gradedAt)`, not from a
 *   random value or the delivery. A re-grade produces a *new* event, and a
 *   retry of the same event keeps its id, so a consumer that stores them can
 *   dedupe by id and cannot silently apply one grading twice.
 * * The body is canonicalised, so the signature is over exactly the bytes that
 *   were sent rather than over "the same object in some field order".
 * * The signature carries the timestamp, so a consumer can refuse a replay
 *   instead of accepting yesterday's delivery forever.
 *
 * This module is pure and has no framework imports: it is the part that must be
 * identical on both ends of the wire, so it is the part worth testing directly.
 */

import { createHash, createHmac } from "node:crypto";

import { canonicalize } from "./credentials";
import { normalizeGradingMode, type GradingMode } from "./grading-mode";

/** Bumped only for a change a consumer must notice; additive fields do not. */
export const WEBHOOK_EVENT_VERSION = 1;

export const WEBHOOK_GRADED_EVENT = "attempt.graded";

export const WEBHOOK_EVENTS = [WEBHOOK_GRADED_EVENT] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/** The header a consumer reads the signature from. */
export const SIGNATURE_HEADER = "x-ontrak-signature";

/** How far a delivery may be from the consumer's clock before it is a replay. */
export const SIGNATURE_TOLERANCE_SEC = 300;

/** A per-check summary in the payload. Deliberately no `detail` text. */
export interface WebhookCheck {
  checkId: string;
  label: string;
  passed: boolean;
  points: number;
  maxPoints: number;
}

export interface GradedEventInput {
  attemptId: string;
  status: string;
  /**
   * How this attempt was graded (docs/consolidation-audit.md §7 Step 6). Always
   * present and never null on the wire: a consumer that receives `passed` needs to
   * know whether a simulator or a live machine produced it, because the two numbers
   * are not comparable. Additive, so `WEBHOOK_EVENT_VERSION` stays 1.
   */
  mode: GradingMode;
  learner: { id: string; email: string; name: string };
  scenario: { id: string; title: string; platform: string };
  cohort: { id: string; name: string } | null;
  score: number;
  maxScore: number;
  passScore: number;
  /** True when the score cleared the scenario's pass mark. */
  passed: boolean;
  startedAt: string;
  submittedAt: string | null;
  gradedAt: string;
  timeSpentSec: number;
  certificate: {
    code: string;
    digest: string;
    issuedAt: string | null;
    revokedAt: string | null;
  } | null;
  checks: WebhookCheck[];
}

export interface WebhookEvent {
  id: string;
  event: WebhookEventName;
  version: number;
  deliveredAt: string;
  data: GradedEventInput;
}

/** A hard cap on per-check detail: a consumer's parser must not be the blast radius. */
export const MAX_CHECKS = 200;

/**
 * The loose facts a grading produces, before they are shaped into a payload.
 *
 * Kept separate from `GradedEventInput` only so the two rules that matter can
 * live in one place: `passed` is *derived* from the scenario's pass mark rather
 * than copied from a caller that might have got its comparison backwards, and
 * the check list is truncated rather than trusted to be small.
 */
export interface GradedFactSource {
  attemptId: string;
  status: string;
  /** The grader. Absent or unknown is normalized to `simulated` by `gradedEventInput`. */
  mode?: GradingMode | string | null;
  learner: { id: string; email: string; name: string };
  scenario: { id: string; title: string; platform: string };
  cohort: { id: string; name: string } | null;
  score: number;
  maxScore: number;
  passScore: number;
  startedAt: string;
  submittedAt: string | null;
  gradedAt: string;
  timeSpentSec: number;
  certificate: GradedEventInput["certificate"];
  checks: readonly WebhookCheck[];
}

export function gradedEventInput(source: GradedFactSource): GradedEventInput {
  const passScore = Number.isFinite(source.passScore) ? source.passScore : 0;
  return {
    attemptId: source.attemptId,
    status: source.status,
    // An unstated mode means the simulator graded it, which is what everything
    // graded before modes existed did. The default points at the weaker claim.
    mode: normalizeGradingMode(source.mode),
    learner: source.learner,
    scenario: source.scenario,
    cohort: source.cohort,
    score: source.score,
    maxScore: source.maxScore,
    passScore,
    // The pass mark is a *percentage*, so the score is compared as one: a raw
    // `score >= passScore` would fail an 8/10 attempt against a 70% mark. A
    // scenario worth zero points is not a pass even at zero: nothing was asked.
    passed: source.maxScore > 0 && percent(source.score, source.maxScore) >= passScore,
    startedAt: source.startedAt,
    submittedAt: source.submittedAt,
    gradedAt: source.gradedAt,
    timeSpentSec: source.timeSpentSec,
    certificate: source.certificate,
    checks: source.checks.slice(0, MAX_CHECKS).map((check) => ({
      checkId: check.checkId,
      label: check.label,
      passed: check.passed,
      points: check.points,
      maxPoints: check.maxPoints,
    })),
  };
}

/** Whole-percent score, 0–100, integer-rounded. Zero questions is zero. */
export function percent(score: number, maxScore: number): number {
  if (!Number.isFinite(maxScore) || maxScore <= 0) return 0;
  const value = (score / maxScore) * 100;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * The identity of one grading fact.
 *
 * Two gradings of the same attempt at different times are different facts, so
 * `gradedAt` is part of it; the delivery moment is not, so a retry is the same
 * fact as the send it replaces.
 */
export function eventId(event: WebhookEventName, attemptId: string, gradedAt: string): string {
  const digest = createHash("sha256").update(`${event}\n${attemptId}\n${gradedAt}`).digest("hex");
  return `evt_${digest.slice(0, 24)}`;
}

export function buildGradedEvent(input: GradedEventInput, deliveredAt: string): WebhookEvent {
  return {
    id: eventId(WEBHOOK_GRADED_EVENT, input.attemptId, input.gradedAt),
    event: WEBHOOK_GRADED_EVENT,
    version: WEBHOOK_EVENT_VERSION,
    deliveredAt,
    data: input,
  };
}

/** The exact bytes to sign and to send. */
export function webhookBody(event: WebhookEvent): string {
  return canonicalize(event as unknown as Record<string, unknown>);
}

/**
 * `t=<unix seconds>,sha256=<hex hmac of "t.body">`.
 *
 * The timestamp is inside the signed string, so it cannot be edited to widen the
 * replay window without invalidating the signature.
 */
export function signatureHeader(secret: string, timestampSec: number, body: string): string {
  return `t=${timestampSec},sha256=${signatureValue(secret, timestampSec, body)}`;
}

function signatureValue(secret: string, timestampSec: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestampSec}.${body}`).digest("hex");
}

/**
 * The check a consumer runs before it trusts a delivery.
 *
 * `nowSec` is a parameter rather than read from the clock so the tolerance is
 * testable without waiting five minutes. A header that is absent, malformed, or
 * older than the tolerance is refused — the point of the timestamp is that
 * "valid signature" does not mean "valid forever".
 */
export function verifySignature(
  secret: string,
  header: string | null | undefined,
  body: string,
  nowSec: number,
  toleranceSec = SIGNATURE_TOLERANCE_SEC,
): boolean {
  if (!header || !secret) return false;
  const match = /^t=(\d+),sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowSec - timestamp) > toleranceSec) return false;
  return match[2].toLowerCase() === signatureValue(secret, timestamp, body);
}

/** A body that is a JSON object, for the tests and for a consumer's own reader. */
export function readWebhookEvent(body: unknown): WebhookEvent | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const event = body as Record<string, unknown>;
  if (typeof event.id !== "string" || typeof event.event !== "string") return null;
  if (typeof event.deliveredAt !== "string") return null;
  if (event.data === null || typeof event.data !== "object" || Array.isArray(event.data)) return null;
  return event as unknown as WebhookEvent;
}
