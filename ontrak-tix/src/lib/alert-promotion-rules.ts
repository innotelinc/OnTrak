/**
 * Alert → ticket promotion rules (M2): when does an alert become work?
 *
 * An alert stream is not a worklist. Most of what a sensor emits is noise the
 * desk has already decided about, and a desk that opens a ticket for every
 * alert stops reading its own queue. So promotion is a *decision*, made by the
 * same three things a human triager uses:
 *
 *  1. **Severity.** An alert at or above the promotion bar is work on sight.
 *  2. **Repetition.** Something below the bar that keeps firing is work too —
 *     a detection that will not go away is the one worth a ticket.
 *  3. **History.** A detection the desk has already called a false positive, or
 *     that a suppression rule covers, is not work at all.
 *
 * The result is one of three outcomes, never a silent drop:
 *
 *  - `PROMOTE` — open an incident.
 *  - `OBSERVE` — keep it in the stream; not a ticket (yet).
 *  - `SUPPRESS` — recorded as a decision, so "why did nobody work this?" has an
 *    answer that is a reason rather than an absence.
 *
 * Pure: no store, no clock, no ticket service. A service decides what to persist
 * with these rules; this module only decides *what the alert is worth*.
 */

import {
  SECURITY_SEVERITIES,
  type AssetCriticality,
  type SecuritySeverity,
  type SecuritySource,
} from "./security-alert-rules";
import { SUBJECT_MAX, type TicketPriority } from "./ticket-rules";

/** The decision. `OBSERVE` is deliberately distinct from `SUPPRESS`. */
export type PromotionOutcome = "PROMOTE" | "OBSERVE" | "SUPPRESS";

/**
 * The minimum an alert has to expose to be judged. `SecurityAlertRecord` is
 * assignable, so the rules never depend on the persistence shape.
 */
export interface PromotionCandidate {
  id: string;
  source: SecuritySource;
  severity: SecuritySeverity;
  triageSeverity: SecuritySeverity;
  signature: string;
  description: string;
  asset: string | null;
  assetCriticality: AssetCriticality | null;
  assetOwner: string | null;
  identity: string | null;
  identityPrivileged: boolean;
  sourceIp: string | null;
  occurredAt: string;
  occurrences: number;
  /** Set once the alert has been promoted; a promoted alert is never re-promoted. */
  ticketId: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Suppression                                                               */
/* -------------------------------------------------------------------------- */

export type SuppressionField = "signature" | "asset" | "identity" | "source";
export const SUPPRESSION_FIELDS: readonly SuppressionField[] = ["signature", "asset", "identity", "source"];

/**
 * A rule the desk has configured: never promote alerts matching this field. The
 * match is a case-insensitive substring, so a rule can cover a family of
 * detections ("ET SCAN") without enumerating every signature.
 */
export interface SuppressionRule {
  field: SuppressionField;
  match: string;
  reason: string;
  /** The rule lapses at or after this instant; `null`/absent means permanent. */
  until?: string | null;
}

/** A suppression rule as it is stored, with its identity and provenance. */
export interface StoredSuppressionRule extends SuppressionRule {
  id: string;
  tenantId: string;
  createdBy?: string | null;
  createdAt: string;
}

function fieldValue(alert: PromotionCandidate, field: SuppressionField): string | null {
  switch (field) {
    case "signature":
      return alert.signature;
    case "asset":
      return alert.asset;
    case "identity":
      return alert.identity;
    case "source":
      return alert.source;
  }
}

/** Whether a rule covers an alert right now. A lapsed rule never matches. */
export function matchesSuppression(alert: PromotionCandidate, rule: SuppressionRule, now: string): boolean {
  if (rule.until && now >= rule.until) return false;
  const value = fieldValue(alert, rule.field);
  if (!value) return false;
  const needle = rule.match.trim().toLowerCase();
  return needle.length > 0 && value.toLowerCase().includes(needle);
}

/** The first rule that covers an alert, in the order supplied. */
export function activeSuppression(
  alert: PromotionCandidate,
  rules: readonly SuppressionRule[],
  now: string,
): SuppressionRule | null {
  for (const rule of rules) {
    if (matchesSuppression(alert, rule, now)) return rule;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  False-positive tracking                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A staff member's verdict on a detection. `FALSE_POSITIVE` and `BENIGN` both
 * mean "this is not work"; `TRUE_POSITIVE` records that it was, which keeps the
 * history honest without suppressing anything.
 */
export type VerdictKind = "FALSE_POSITIVE" | "BENIGN" | "TRUE_POSITIVE";
export const VERDICT_KINDS: readonly VerdictKind[] = ["FALSE_POSITIVE", "BENIGN", "TRUE_POSITIVE"];

export interface AlertVerdictInput {
  signature: string;
  verdict: VerdictKind;
  at: string;
  by?: string | null;
  note?: string | null;
}

/** A verdict as it is stored, with its identity. */
export interface AlertVerdict extends AlertVerdictInput {
  id: string;
  tenantId: string;
}

/** The window a false-positive verdict is counted over. */
export function verdictWindowStart(now: string, windowDays: number): string {
  const ms = new Date(now).getTime() - windowDays * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

/**
 * How many false-positive/benign verdicts a signature has collected inside the
 * window. A `TRUE_POSITIVE` verdict does not count toward suppression — it is
 * evidence the detection was right.
 */
export function falsePositiveCount(
  alert: Pick<PromotionCandidate, "signature">,
  verdicts: readonly AlertVerdictInput[],
  now: string,
  windowDays: number,
): number {
  const since = verdictWindowStart(now, windowDays);
  const signature = alert.signature.trim().toLowerCase();
  return verdicts.filter(
    (verdict) =>
      verdict.signature.trim().toLowerCase() === signature &&
      verdict.at >= since &&
      verdict.at <= now &&
      (verdict.verdict === "FALSE_POSITIVE" || verdict.verdict === "BENIGN"),
  ).length;
}

/* -------------------------------------------------------------------------- */
/*  The policy                                                                */
/* -------------------------------------------------------------------------- */

export interface PromotionPolicy {
  /** An alert at or above this triage severity is work on first sighting. */
  minPromoteSeverity: SecuritySeverity;
  /** …or when the same detection has repeated this many times. */
  promoteAtOccurrences: number;
  /** This many false-positive verdicts inside the window suppress a signature. */
  falsePositiveThreshold: number;
  falsePositiveWindowDays: number;
  /** Configured suppressions, merged with any stored per tenant. */
  suppressionRules: readonly SuppressionRule[];
}

/**
 * The defaults a desk starts with: HIGH-and-above promotes immediately, a
 * sub-threshold detection promotes once it has repeated five times, and two
 * false-positive verdicts in a month silence a signature. All three are policy,
 * not constants — a noisy tenant can raise the bar without a code change.
 */
export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = {
  minPromoteSeverity: "HIGH",
  promoteAtOccurrences: 5,
  falsePositiveThreshold: 2,
  falsePositiveWindowDays: 30,
  suppressionRules: [],
};

/** A severity's rung on the ladder, so "at or above" is a comparison. */
export function severityRank(severity: SecuritySeverity): number {
  return SECURITY_SEVERITIES.indexOf(severity);
}

/** The ticket priority an alert's triage severity deserves. */
export function promotionPriority(severity: SecuritySeverity): TicketPriority {
  switch (severity) {
    case "CRITICAL":
      return "URGENT";
    case "HIGH":
      return "HIGH";
    case "MEDIUM":
      return "NORMAL";
    default:
      return "LOW";
  }
}

/* -------------------------------------------------------------------------- */
/*  The decision                                                              */
/* -------------------------------------------------------------------------- */

export interface PromotionDecision {
  alertId: string;
  outcome: PromotionOutcome;
  /** Why, in the desk's words — shown in the stream and written to the record. */
  reason: string;
  /** The priority the ticket would carry; always computed, even when suppressed. */
  priority: TicketPriority;
  signature: string;
}

export interface PromotionContext {
  verdicts?: readonly AlertVerdictInput[];
  /** Extra rules merged over the policy's, so stored suppressions can be layered. */
  rules?: readonly SuppressionRule[];
  now?: string;
}

/**
 * Decide whether an alert is work. Order matters: a suppression or a
 * false-positive history outranks severity, because the point of those records
 * is precisely that severity alone has already proven to be the wrong signal.
 */
export function decidePromotion(
  alert: PromotionCandidate,
  policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
  context: PromotionContext = {},
): PromotionDecision {
  const now = context.now ?? new Date().toISOString();
  const priority = promotionPriority(alert.triageSeverity);
  const base = { alertId: alert.id, priority, signature: alert.signature };

  if (alert.ticketId) {
    return { ...base, outcome: "SUPPRESS", reason: "This alert has already been promoted to a ticket." };
  }

  const rules = [...policy.suppressionRules, ...(context.rules ?? [])];
  const rule = activeSuppression(alert, rules, now);
  if (rule) {
    return { ...base, outcome: "SUPPRESS", reason: `Suppressed by rule (${rule.field} matches "${rule.match}"): ${rule.reason}` };
  }

  const falsePositives = falsePositiveCount(alert, context.verdicts ?? [], now, policy.falsePositiveWindowDays);
  if (falsePositives >= policy.falsePositiveThreshold) {
    return {
      ...base,
      outcome: "SUPPRESS",
      reason: `Suppressed: ${falsePositives} false-positive verdict(s) for this detection in the last ${policy.falsePositiveWindowDays} day(s).`,
    };
  }

  if (severityRank(alert.triageSeverity) >= severityRank(policy.minPromoteSeverity)) {
    return {
      ...base,
      outcome: "PROMOTE",
      reason: `${alert.triageSeverity} alert at or above the ${policy.minPromoteSeverity} promotion bar.`,
    };
  }

  if (alert.occurrences >= policy.promoteAtOccurrences) {
    return {
      ...base,
      outcome: "PROMOTE",
      reason: `Detection repeated ${alert.occurrences} times (threshold ${policy.promoteAtOccurrences}).`,
    };
  }

  return {
    ...base,
    outcome: "OBSERVE",
    reason: `${alert.triageSeverity} alert below the ${policy.minPromoteSeverity} bar with ${alert.occurrences} occurrence(s) — kept in the stream.`,
  };
}

/** The idempotency key for an alert's promotion, so one alert is one ticket. */
export function promotionKey(alertId: string): string {
  return `alert:${alertId}`;
}

/* -------------------------------------------------------------------------- */
/*  The ticket draft                                                          */
/* -------------------------------------------------------------------------- */

export interface PromotionDraft {
  subject: string;
  description: string;
  type: "INCIDENT";
  priority: TicketPriority;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** The ticket subject, kept inside `SUBJECT_MAX` however long the signature is. */
export function promotionSubject(alert: PromotionCandidate): string {
  const where = alert.asset ? ` on ${alert.asset}` : alert.identity ? ` for ${alert.identity}` : "";
  return truncate(`${alert.signature}${where}`, SUBJECT_MAX);
}

/**
 * The ticket body: every fact the triager needs, with the alert's identity so
 * the ticket and the alert can always be traced to each other. This is written
 * once at promotion and is evidence — it is never rewritten as the alert
 * changes.
 */
export function promotionDescription(alert: PromotionCandidate): string {
  const lines = [
    `Promoted from a ${alert.source} security alert.`,
    "",
    `Detection: ${alert.signature}`,
    `Detail: ${alert.description}`,
    `Sensor severity: ${alert.severity}`,
    `Triage severity: ${alert.triageSeverity}`,
    `Occurred: ${alert.occurredAt}`,
    `Occurrences: ${alert.occurrences}`,
  ];
  if (alert.asset) {
    const criticality = alert.assetCriticality ? ` (${alert.assetCriticality})` : "";
    const owner = alert.assetOwner ? `, owner ${alert.assetOwner}` : "";
    lines.push(`Asset: ${alert.asset}${criticality}${owner}`);
  }
  if (alert.identity) {
    lines.push(`Identity: ${alert.identity}${alert.identityPrivileged ? " (privileged)" : ""}`);
  }
  if (alert.sourceIp) lines.push(`Source IP: ${alert.sourceIp}`);
  return lines.join("\n");
}

/** The draft a promoted alert becomes. The requester is the caller's to supply. */
export function promotionDraft(alert: PromotionCandidate, policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY): PromotionDraft {
  return {
    subject: promotionSubject(alert),
    description: promotionDescription(alert),
    type: "INCIDENT",
    priority: promotionPriority(alert.triageSeverity),
  };
}
