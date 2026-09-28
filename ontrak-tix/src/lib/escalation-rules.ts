/**
 * SLA escalation rules (M1): turning the running clocks into a rung on a ladder.
 *
 * The point of an SLA is not the deadline, it is acting *before* it passes.
 * So the engine walks each clock up a ladder of thresholds — half the window,
 * nearing the deadline, breached — and raises each rung exactly once. Pure: no
 * timers, no store, no clock. A sweep decides *what* to raise; the service
 * decides when it has already been raised.
 */

import type { SlaClockKind, SlaClockView, SlaSummary } from "./sla-rules";

/** Who a rung is aimed at. Escalation widens the audience as it rises. */
export type EscalationAudience = "AGENT" | "DISPATCHER" | "MANAGER";

export interface EscalationThreshold {
  /** Monotonic, so "have we already raised this rung?" is a simple comparison. */
  level: number;
  /** Fraction of the target consumed at which this rung fires (0–1). */
  atFraction: number;
  label: string;
  audience: EscalationAudience;
}

/**
 * The default ladder. It warns well before the deadline (level 2 is the
 * "breaches surfaced before they happen" the milestone asks for) rather than
 * only crying after the fact.
 */
export const DEFAULT_ESCALATION_LADDER: readonly EscalationThreshold[] = [
  { level: 1, atFraction: 0.5, label: "Half the window used", audience: "AGENT" },
  { level: 2, atFraction: 0.8, label: "Approaching the deadline", audience: "DISPATCHER" },
  { level: 3, atFraction: 1, label: "Deadline passed", audience: "MANAGER" },
];

/** Fraction of the target a clock has consumed, clamped to `[0, 1]`. */
export function consumedFraction(view: SlaClockView): number {
  if (view.state === "breached") return 1;
  if (view.targetMinutes <= 0) return 1;
  const used = view.targetMinutes - view.remainingMinutes;
  return Math.min(1, Math.max(0, used / view.targetMinutes));
}

/** The highest rung a clock has reached, or `null` while it is comfortably running. */
export function reachedThreshold(
  view: SlaClockView,
  ladder: readonly EscalationThreshold[] = DEFAULT_ESCALATION_LADDER,
): EscalationThreshold | null {
  // A clock met on time is done, however long ago it was.
  if (view.state === "met") return null;

  const fraction = consumedFraction(view);
  let best: EscalationThreshold | null = null;
  for (const threshold of ladder) {
    if (fraction >= threshold.atFraction && (best === null || threshold.level > best.level)) {
      best = threshold;
    }
  }
  return best;
}

/** A stable identity for one rung on one clock, so it is raised at most once. */
export function escalationKey(ticketId: string, kind: SlaClockKind, level: number): string {
  return `${ticketId}:${kind}:${level}`;
}

/** One clock the sweep is considering. */
export interface EscalationCandidate {
  ticketId: string;
  ticketRef: string;
  kind: SlaClockKind;
  view: SlaClockView;
  /** Rungs already raised for this clock, so the sweep is idempotent. */
  alreadyRaised?: readonly number[];
}

export interface SlaEscalationPlan {
  ticketId: string;
  ticketRef: string;
  kind: SlaClockKind;
  level: number;
  audience: EscalationAudience;
  label: string;
  reason: string;
  dedupeKey: string;
}

/**
 * The rungs to raise right now. A clock raises its highest *new* rung; a rung
 * already raised is skipped, which is what makes the sweep safe to run as often
 * as you like.
 */
export function planEscalations(
  candidates: readonly EscalationCandidate[],
  ladder: readonly EscalationThreshold[] = DEFAULT_ESCALATION_LADDER,
): SlaEscalationPlan[] {
  const plans: SlaEscalationPlan[] = [];

  for (const candidate of candidates) {
    const threshold = reachedThreshold(candidate.view, ladder);
    if (!threshold) continue;
    if ((candidate.alreadyRaised ?? []).includes(threshold.level)) continue;

    plans.push({
      ticketId: candidate.ticketId,
      ticketRef: candidate.ticketRef,
      kind: candidate.kind,
      level: threshold.level,
      audience: threshold.audience,
      label: threshold.label,
      reason: `${candidate.ticketRef} ${candidate.kind} SLA — ${threshold.label.toLowerCase()}.`,
      dedupeKey: escalationKey(candidate.ticketId, candidate.kind, threshold.level),
    });
  }

  return plans;
}

/** The two clocks of a ticket as escalation candidates. */
export function candidatesFor(
  ticketId: string,
  ticketRef: string,
  summary: SlaSummary,
  alreadyRaised: Partial<Record<SlaClockKind, readonly number[]>> = {},
): EscalationCandidate[] {
  return [
    { ticketId, ticketRef, kind: "response", view: summary.response, alreadyRaised: alreadyRaised.response },
    { ticketId, ticketRef, kind: "resolution", view: summary.resolution, alreadyRaised: alreadyRaised.resolution },
  ];
}
