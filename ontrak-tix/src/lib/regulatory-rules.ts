/**
 * Regulatory notification rules (M3): the clocks an incident starts.
 *
 * A serious incident does not only have to be *handled*; it has to be *told*.
 * Regulators run on short clocks (24 hours, 72 hours) that start from the moment
 * the organisation became aware, and the failure mode is never "we decided not
 * to notify" — it is that nobody was sure whether the clock had started.
 *
 * So the clock is data, not folklore: every regime declares the authority, the
 * window, and which timestamp it runs from, and the arithmetic lives in
 * `notificationDueAt`. Applicability is *suggested* from the incident's own
 * facts (`suggestedRegimes`) and then *decided* by a person, because "is this a
 * personal-data breach?" is a judgement the record should show someone made,
 * with a name against it.
 *
 * The deadlines below are the published ones for each regime, modelled in hours
 * so a test can check the arithmetic. The SEC rule is four *business* days and
 * NIS2's final report is one month; both are approximated here in hours, which
 * the console states plainly.
 */

import { atLeastAsSevere, type IncidentImpact, type IncidentSeverity } from "./incident-rules";

/* -------------------------------------------------------------------------- */
/*  Regimes                                                                   */
/* -------------------------------------------------------------------------- */

/** Which incident timestamp a regime's clock runs from. */
export type NotificationClock = "detected" | "declared";

export interface NotificationRegime {
  key: string;
  label: string;
  authority: string;
  /** Hours from the clock's start to the deadline. */
  hours: number;
  clock: NotificationClock;
  /** What the notification has to contain, in one line. */
  requirement: string;
}

export const NOTIFICATION_REGIMES: readonly NotificationRegime[] = [
  {
    key: "nis2-early-warning",
    label: "NIS2 early warning",
    authority: "National CSIRT",
    hours: 24,
    clock: "declared",
    requirement:
      "An early warning that a significant incident has occurred, whether it is suspected of being caused by an unlawful or malicious act, and whether it may have cross-border impact.",
  },
  {
    key: "contract-24h",
    label: "Client contract breach notice",
    authority: "Affected client(s)",
    hours: 24,
    clock: "declared",
    requirement: "Notify affected clients inside the contractual window, naming the services affected and the response under way.",
  },
  {
    key: "nis2-incident",
    label: "NIS2 incident notification",
    authority: "National CSIRT",
    hours: 72,
    clock: "declared",
    requirement: "An incident notification assessing severity, impact and indicators of compromise.",
  },
  {
    key: "gdpr-breach",
    label: "GDPR personal-data breach",
    authority: "Supervisory authority (Art. 33)",
    hours: 72,
    clock: "declared",
    requirement:
      "Notify the supervisory authority of a personal-data breach: its nature, the categories and approximate number affected, the likely consequences, and the measures taken.",
  },
  {
    key: "sec-8k",
    label: "SEC material cyber incident (Form 8-K Item 1.05)",
    authority: "Securities and Exchange Commission",
    hours: 96,
    clock: "declared",
    requirement:
      "Describe the material aspects of the incident's nature, scope and timing, and its material impact or reasonably likely material impact.",
  },
  {
    key: "nis2-final-report",
    label: "NIS2 final report",
    authority: "National CSIRT",
    hours: 720,
    clock: "declared",
    requirement: "A final report: detailed description of the incident, root cause, mitigation applied and cross-border impact.",
  },
  {
    key: "hipaa-breach",
    label: "HIPAA breach notification",
    authority: "HHS Office for Civil Rights",
    hours: 1440,
    clock: "declared",
    requirement: "Notify affected individuals — and, above the threshold, the Secretary — of a breach of unsecured protected health information.",
  },
];

export function isRegimeKey(value: unknown): value is string {
  return typeof value === "string" && NOTIFICATION_REGIMES.some((regime) => regime.key === value);
}

export function regimeByKey(key: string): NotificationRegime | null {
  return NOTIFICATION_REGIMES.find((regime) => regime.key === key) ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Applicability                                                             */
/* -------------------------------------------------------------------------- */

/** The incident facts applicability is judged from. */
export interface RegimeContext {
  severity: IncidentSeverity;
  impact: IncidentImpact;
}

export interface RegimeSuggestion {
  regime: NotificationRegime;
  /** Why this incident looks like it owes this notification. */
  because: string;
}

/**
 * The regimes an incident's own facts suggest. Deliberately conservative — it
 * proposes, it never notifies — and every proposal carries the reason so the
 * console can show a reader *why* it was offered.
 */
export function suggestedRegimes(context: RegimeContext): RegimeSuggestion[] {
  const suggestions: RegimeSuggestion[] = [];
  const significant = atLeastAsSevere(context.severity, "SEV2");

  if (significant) {
    for (const key of ["nis2-early-warning", "nis2-incident", "nis2-final-report"]) {
      suggestions.push({
        regime: regimeByKey(key)!,
        because: `a ${context.severity} incident is treated as significant under NIS2`,
      });
    }
  }

  if (context.severity === "SEV1") {
    suggestions.push({
      regime: regimeByKey("sec-8k")!,
      because: "a SEV1 is presumed material until assessed otherwise",
    });
    suggestions.push({
      regime: regimeByKey("contract-24h")!,
      because: "client contracts put a 24-hour notice duty on a SEV1",
    });
  }

  if (context.impact === "EXTENSIVE") {
    suggestions.push({
      regime: regimeByKey("gdpr-breach")!,
      because: "extensive impact is treated as a personal-data breach until the assessment says otherwise",
    });
  }

  return suggestions;
}

/* -------------------------------------------------------------------------- */
/*  The clock                                                                 */
/* -------------------------------------------------------------------------- */

/** When a regime's deadline falls, given the incident's own timestamps. */
export function notificationDueAt(regime: NotificationRegime, incident: { detectedAt: string; declaredAt: string }): string {
  const from = regime.clock === "detected" ? incident.detectedAt : incident.declaredAt;
  return new Date(new Date(from).getTime() + regime.hours * 3_600_000).toISOString();
}

/** Hours between two instants, to one decimal — how late a notice went out. */
export function hoursBetween(from: string, to: string): number {
  return Math.round(((new Date(to).getTime() - new Date(from).getTime()) / 3_600_000) * 10) / 10;
}

/* -------------------------------------------------------------------------- */
/*  The tracked obligation                                                    */
/* -------------------------------------------------------------------------- */

export type NotificationStatus = "PENDING" | "SENT" | "ACKNOWLEDGED" | "WAIVED";
export const NOTIFICATION_STATUSES: readonly NotificationStatus[] = ["PENDING", "SENT", "ACKNOWLEDGED", "WAIVED"];

export function isNotificationStatus(value: unknown): value is NotificationStatus {
  return typeof value === "string" && (NOTIFICATION_STATUSES as readonly string[]).includes(value);
}

/**
 * One tracked notification duty. The regime's description is *copied in* when it
 * is adopted rather than looked up on read: the record of what was notified has
 * to stay readable even after the rule changes.
 */
export interface NotificationObligation {
  id: string;
  tenantId: string;
  incidentId: string;
  regime: string;
  label: string;
  authority: string;
  requirement: string;
  clock: NotificationClock;
  dueAt: string;
  status: NotificationStatus;
  sentAt: string | null;
  sentBy: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  reference: string | null;
  note: string | null;
  waivedAt: string | null;
  waivedBy: string | null;
  waiverReason: string | null;
  createdAt: string;
}

/** Build the obligation an adopted regime creates, so the service just persists. */
export function buildObligation(input: {
  id: string;
  tenantId: string;
  incidentId: string;
  regime: NotificationRegime;
  incident: { detectedAt: string; declaredAt: string };
  note?: string | null;
  now: string;
}): NotificationObligation {
  return {
    id: input.id,
    tenantId: input.tenantId,
    incidentId: input.incidentId,
    regime: input.regime.key,
    label: input.regime.label,
    authority: input.regime.authority,
    requirement: input.regime.requirement,
    clock: input.regime.clock,
    dueAt: notificationDueAt(input.regime, input.incident),
    status: "PENDING",
    sentAt: null,
    sentBy: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    reference: null,
    note: input.note?.trim() || null,
    waivedAt: null,
    waivedBy: null,
    waiverReason: null,
    createdAt: input.now,
  };
}

/** How a tracked duty stands right now, which is what the console colours. */
export type NotificationState = "PENDING" | "DUE_SOON" | "OVERDUE" | "SENT" | "SENT_LATE" | "ACKNOWLEDGED" | "WAIVED";

/** How close to the deadline counts as "due soon". */
export const DUE_SOON_HOURS = 12;

/**
 * The state of a duty. `SENT_LATE` is deliberately distinct from `SENT`: a
 * notice that went out after the window is still a notice, but it is not the
 * same record, and an auditor will ask about the difference.
 */
export function notificationState(obligation: NotificationObligation, now: string): NotificationState {
  if (obligation.status === "WAIVED") return "WAIVED";
  if (obligation.status === "ACKNOWLEDGED") return "ACKNOWLEDGED";
  if (obligation.status === "SENT") {
    return obligation.sentAt && obligation.sentAt > obligation.dueAt ? "SENT_LATE" : "SENT";
  }
  if (now > obligation.dueAt) return "OVERDUE";
  return hoursBetween(now, obligation.dueAt) <= DUE_SOON_HOURS ? "DUE_SOON" : "PENDING";
}

export function notificationStateLabel(state: NotificationState): string {
  switch (state) {
    case "PENDING":
      return "pending";
    case "DUE_SOON":
      return "due soon";
    case "OVERDUE":
      return "overdue";
    case "SENT":
      return "sent";
    case "SENT_LATE":
      return "sent late";
    case "ACKNOWLEDGED":
      return "acknowledged";
    case "WAIVED":
      return "waived";
  }
}

/** Hours late (positive) or early (negative) the notice went out; null if unsent. */
export function notificationLateness(obligation: NotificationObligation): number | null {
  if (!obligation.sentAt) return null;
  return hoursBetween(obligation.dueAt, obligation.sentAt);
}

export function canSend(obligation: NotificationObligation): boolean {
  return obligation.status === "PENDING";
}

export function canAcknowledge(obligation: NotificationObligation): boolean {
  return obligation.status === "SENT";
}

export function canWaive(obligation: NotificationObligation): boolean {
  return obligation.status === "PENDING" || obligation.status === "SENT";
}

/* -------------------------------------------------------------------------- */
/*  Roll-up                                                                   */
/* -------------------------------------------------------------------------- */

export interface NotificationSummary {
  total: number;
  pending: number;
  dueSoon: number;
  overdue: number;
  sent: number;
  acknowledged: number;
  waived: number;
  /** The most urgent deadline still open, if any. */
  nextDueAt: string | null;
}

/** Where an incident's notification duties stand, for a page header. */
export function notificationSummary(obligations: readonly NotificationObligation[], now: string): NotificationSummary {
  const summary: NotificationSummary = {
    total: obligations.length,
    pending: 0,
    dueSoon: 0,
    overdue: 0,
    sent: 0,
    acknowledged: 0,
    waived: 0,
    nextDueAt: null,
  };

  for (const obligation of obligations) {
    const state = notificationState(obligation, now);
    switch (state) {
      case "PENDING":
        summary.pending += 1;
        break;
      case "DUE_SOON":
        summary.dueSoon += 1;
        break;
      case "OVERDUE":
        summary.overdue += 1;
        break;
      case "SENT":
      case "SENT_LATE":
        summary.sent += 1;
        break;
      case "ACKNOWLEDGED":
        summary.acknowledged += 1;
        break;
      case "WAIVED":
        summary.waived += 1;
        break;
    }
    const open = state === "PENDING" || state === "DUE_SOON" || state === "OVERDUE";
    if (open && (summary.nextDueAt === null || obligation.dueAt < summary.nextDueAt)) {
      summary.nextDueAt = obligation.dueAt;
    }
  }

  return summary;
}

/** Validate a tracked duty's descriptive fields before they are stored. */
export function validateNotification(input: { regime?: string; note?: string | null }): string[] {
  const issues: string[] = [];
  if (!input.regime) issues.push("Choose a notification regime.");
  else if (!isRegimeKey(input.regime)) issues.push(`Unknown notification regime "${input.regime}".`);
  if (input.note != null && input.note.length > 2_000) issues.push("The note may be at most 2000 characters.");
  return issues;
}
