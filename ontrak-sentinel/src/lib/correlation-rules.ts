/**
 * Correlation (S3): several detections on one subject, as one incident.
 *
 * This is the piece a SIEM exists for and that a pile of signatures cannot do. Each rule
 * in `detection-rules.ts` answers *one* question — was this port touched, did this address
 * spray, did this host run a dumping tool — and an intrusion is almost never one answer.
 * It is a scan and then a spray; it is credential theft and then a persistence mechanism on
 * the same machine. Read separately those are three alerts an analyst has to remember to
 * put together; read through a correlation rule they are one incident with three pieces of
 * evidence, which is the difference between a queue and a picture.
 *
 * Decisions worth stating out loud:
 *
 *  - **A correlation rule needs *different* detections, not more of the same one.** The bar
 *    is `minDistinctRules`, so "the spray rule fired eleven times" is still the spray rule
 *    behaving exactly as designed and is *not* an incident. What is worth escalating is two
 *    different detections agreeing about one subject — and `minAlerts` is there for the
 *    rules that also want volume.
 *  - **Correlation is a *derived detection*, not a second alert system.** An incident comes
 *    out of this module as an alert draft that the pipeline raises through the same store,
 *    the same deduplication, the same mute, the same delivery and the same queue as every
 *    other alert. A parallel path for correlated alerts would be a second place for
 *    suppression to be forgotten.
 *  - **The cooldown is a property of the incident, not of the rule.** The deduplication key
 *    is bucketed on the cooldown window, so a correlation that keeps matching folds into the
 *    row that already exists (bumping `occurrences`) instead of raising a new incident every
 *    batch. A sprawling intrusion is one incident that is still going, not four hundred.
 *  - **A correlated incident is at least as bad as its worst member.** The rule's severity
 *    is a *floor*: an incident that includes a CRITICAL detection is CRITICAL however mild
 *    the correlation rule that noticed it.
 *  - **A subject is required.** A group key of `null` would mean "several things happened
 *    somewhere", and correlating on it would produce one estate-wide incident per batch.
 *    A candidate with no subject for the rule's group is not correlated at all.
 *
 * Everything here is pure: candidates in, incidents out, no clock and no store.
 */

import type { Severity } from "./detection-rules";

/* -------------------------------------------------------------------------- */
/*  The rules                                                                 */
/* -------------------------------------------------------------------------- */

/** What a correlation groups on. A subject, never a free-text field. */
export type CorrelationGroupKey = "sourceAddress" | "identityId" | "asset" | "device";

export interface CorrelationRule {
  id: string;
  version: number;
  name: string;
  /**
   * The *floor* of the incident's severity.
   *
   * The incident taken from the rule is at least this bad and at least as bad as its worst
   * member — see `incidentSeverity`. A rule that says HIGH cannot quietly downgrade a
   * CRITICAL detection it happens to group.
   */
  severity: Severity;
  description: string;
  references: readonly string[];
  groupBy: CorrelationGroupKey;
  /** Distinct alerts that must agree before this fires. Never below `minDistinctRules`. */
  minAlerts: number;
  /** Distinct *rules* that must agree. This is the field that makes it a correlation. */
  minDistinctRules: number;
  /** How far apart the members may be and still be one incident. */
  windowMs: number;
  /**
   * How long this incident stays one incident.
   *
   * A repeat inside the cooldown folds into the existing row — the incident is still going.
   * After it, a matching set is a *new* incident, because an hour-old containment is not
   * evidence about what is happening now.
   */
  cooldownMs: number;
  /** Contributions carried on the incident. The ceiling is the alert's own evidence cap. */
  maxMembers: number;
  /** Only alerts at or above this severity participate. Absent means every severity. */
  minSeverity?: Severity;
  /** Only these rule ids participate. Absent means every rule. */
  ruleIds?: readonly string[];
}

const SEVERITY_ORDER: readonly Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

/** The worse of two severities. Total, so a report never has to guess. */
export function worseSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;
}

export function severityAtLeast(severity: Severity, floor: Severity): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(floor);
}

/* -------------------------------------------------------------------------- */
/*  Candidates                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One alert, as correlation sees it.
 *
 * The narrowest possible projection of an alert: a subject, a detection, a severity and a
 * moment. Correlation does not read evidence, notes or assignment, so it is not given them
 * — a module that cannot see a field cannot quietly make a decision about it.
 */
export interface CorrelationCandidate {
  alertId: string;
  ruleId: string;
  severity: Severity;
  /** The alert's first sighting, in epoch milliseconds. */
  at: number;
  sourceAddress: string | null;
  identityId: string | null;
  asset: string | null;
  device: string | null;
}

/** The alert fields `toCorrelationCandidate` reads, so any alert shape can be handed in. */
export interface CorrelatableAlert {
  id: string;
  ruleId: string;
  severity: Severity;
  firstSeenAt: string;
  sourceAddress: string | null;
  identityId: string | null;
  asset: string | null;
  device: string | null;
}

export function toCorrelationCandidate(alert: CorrelatableAlert): CorrelationCandidate {
  const at = Date.parse(alert.firstSeenAt);
  return {
    alertId: alert.id,
    ruleId: alert.ruleId,
    severity: alert.severity,
    at: Number.isFinite(at) ? at : 0,
    sourceAddress: alert.sourceAddress,
    identityId: alert.identityId,
    asset: alert.asset,
    device: alert.device,
  };
}

function groupValue(candidate: CorrelationCandidate, groupBy: CorrelationGroupKey): string | null {
  switch (groupBy) {
    case "sourceAddress":
      return candidate.sourceAddress;
    case "identityId":
      return candidate.identityId;
    case "asset":
      return candidate.asset;
    case "device":
      return candidate.device;
  }
}

/* -------------------------------------------------------------------------- */
/*  Incidents                                                                 */
/* -------------------------------------------------------------------------- */

/** One alert that contributed to an incident. */
export interface CorrelationMember {
  alertId: string;
  ruleId: string;
  severity: Severity;
  /** Epoch milliseconds, so a caller can lay the members out on a timeline. */
  at: number;
}

export interface CorrelatedIncident {
  /** The correlation rule that noticed. */
  ruleId: string;
  ruleVersion: number;
  ruleName: string;
  description: string;
  references: string[];
  /** The severity the raised alert carries: the worse of the rule and its worst member. */
  severity: Severity;
  groupBy: CorrelationGroupKey;
  /** The subject the members agree on. Never null: correlation requires one. */
  group: string;
  /** Every contributing alert, oldest first. */
  members: CorrelationMember[];
  /** The distinct detections that agreed. This is what made it an incident. */
  distinctRules: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  /**
   * The key a raised alert is stored under, so a repeat inside the cooldown folds in.
   *
   * Derived from the *incident*, not from the batch: the rule, the group and the cooldown
   * bucket. Two batches that see the same intrusion produce the same key on purpose.
   */
  dedupeKey: string;
}

function incidentSeverity(rule: CorrelationRule, members: readonly CorrelationMember[]): Severity {
  return members.reduce((worst, member) => worseSeverity(worst, member.severity), rule.severity);
}

/** The key an incident's raised alert is stored under. Exported so a test can pin it. */
export function incidentDedupeKey(rule: CorrelationRule, group: string, now: number): string {
  const bucket = rule.cooldownMs > 0 ? Math.floor(now / rule.cooldownMs) : now;
  return `${rule.id}@${rule.version}|${group}|${bucket}`;
}

/**
 * Apply every correlation rule to a pool of alerts.
 *
 * `now` is required and is the *only* clock: it decides the cooldown bucket, and passing it
 * rather than reading a clock is what makes "the same intrusion seen twice is one incident"
 * a property a test can assert instead of a property of when the test ran.
 *
 * The pool is the candidates — typically the alerts raised in this batch plus whatever the
 * org already has inside the widest window. Handing in a pool that is too small cannot
 * invent an incident; it can only miss one, which is why the caller is told to pass the
 * store's recent alerts rather than only the batch.
 */
export function correlateAlerts(
  candidates: readonly CorrelationCandidate[],
  rules: readonly CorrelationRule[],
  options: { now: number },
): CorrelatedIncident[] {
  const correlationRuleIds = new Set(rules.map((rule) => rule.id));
  // A correlated alert is not evidence for a correlation. Without this, one incident would
  // feed the next rule and a busy estate would correlate itself into noise.
  const pool = candidates.filter((candidate) => !correlationRuleIds.has(candidate.ruleId));
  const incidents: CorrelatedIncident[] = [];

  for (const rule of rules) {
    const eligible = pool.filter((candidate) => {
      if (rule.minSeverity && !severityAtLeast(candidate.severity, rule.minSeverity)) return false;
      if (rule.ruleIds && !rule.ruleIds.includes(candidate.ruleId)) return false;
      return groupValue(candidate, rule.groupBy) !== null;
    });

    const groups = new Map<string, CorrelationCandidate[]>();
    for (const candidate of eligible) {
      const group = groupValue(candidate, rule.groupBy)!;
      groups.set(group, [...(groups.get(group) ?? []), candidate]);
    }

    for (const [group, inGroup] of groups) {
      const ordered = [...inGroup].sort((a, b) => a.at - b.at);

      // A sliding window, walked forwards: the first window that clears both bars is the
      // incident, and the walk resumes past its end so one long intrusion yields one
      // incident rather than one per contributing alert.
      let cursor = 0;
      while (cursor < ordered.length) {
        const window = ordered.filter(
          (candidate) => candidate.at >= ordered[cursor].at && candidate.at <= ordered[cursor].at + rule.windowMs,
        );
        const distinctRules = [...new Set(window.map((candidate) => candidate.ruleId))].sort();

        if (window.length < rule.minAlerts || distinctRules.length < rule.minDistinctRules) {
          cursor += 1;
          continue;
        }

        const members: CorrelationMember[] = window
          .slice(0, rule.maxMembers)
          .map((candidate) => ({
            alertId: candidate.alertId,
            ruleId: candidate.ruleId,
            severity: candidate.severity,
            at: candidate.at,
          }));

        incidents.push({
          ruleId: rule.id,
          ruleVersion: rule.version,
          ruleName: rule.name,
          description: rule.description,
          references: [...rule.references],
          severity: incidentSeverity(rule, members),
          groupBy: rule.groupBy,
          group,
          members,
          distinctRules: [...new Set(members.map((member) => member.ruleId))].sort(),
          firstSeenAt: members[0].at,
          lastSeenAt: members[members.length - 1].at,
          dedupeKey: incidentDedupeKey(rule, group, options.now),
        });

        // Resume after the window, so the alerts it consumed cannot start a second incident
        // for the same rule.
        const windowEnd = ordered[cursor].at + rule.windowMs;
        const next = ordered.findIndex((candidate) => candidate.at > windowEnd);
        cursor = next === -1 ? ordered.length : next;
      }
    }
  }

  // Stable order: the earliest incident first, then by rule, so two runs over one pool
  // produce the same list.
  return incidents.sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.ruleId.localeCompare(b.ruleId));
}

/* -------------------------------------------------------------------------- */
/*  The rules this build ships                                                */
/* -------------------------------------------------------------------------- */

/**
 * Scanning and authentication abuse from one address.
 *
 * The classic opening: something sweeps the estate looking for a way in and then starts
 * guessing credentials. Each half is a detection on its own — and each half on its own is
 * also what a vulnerability scanner and a mistyped password look like. Together, from one
 * address inside half an hour, they are somebody working the network.
 */
export const RECON_THEN_AUTH_CORRELATION: CorrelationRule = {
  id: "SG-COR-001",
  version: 1,
  name: "Reconnaissance and authentication abuse from one address",
  severity: "HIGH",
  description:
    "More than one kind of detection fired against the same source address inside half an hour — typically a scan or a lateral sweep and then a spray or a stuffing attempt. Either half alone is ordinary; both from one address is somebody working the network.",
  references: ["MITRE:T1595", "MITRE:T1046", "MITRE:T1110"],
  groupBy: "sourceAddress",
  minAlerts: 2,
  minDistinctRules: 2,
  windowMs: 30 * 60_000,
  cooldownMs: 30 * 60_000,
  maxMembers: 12,
};

/**
 * Two different detections on one host: the machine itself is compromised.
 *
 * A host that dumped credentials *and* installed a persistence mechanism, or a web server
 * that spawned a shell *and* started listening on something new. The single detections are
 * what a rulebook sees; the pair is what an incident review sees, and it is the reason the
 * alert names an asset rather than an address.
 */
export const HOST_COMPROMISE_CORRELATION: CorrelationRule = {
  id: "SG-COR-002",
  version: 1,
  name: "Multiple compromise signals on one host",
  severity: "CRITICAL",
  description:
    "Two or more different host detections on the same asset inside half an hour — credential dumping beside a persistence mechanism, or a web server's shell beside a new listener. One of these is an incident; two of them is a machine that has been taken.",
  references: ["MITRE:T1003", "MITRE:T1053", "MITRE:T1190", "MITRE:T1205"],
  groupBy: "asset",
  minAlerts: 2,
  minDistinctRules: 2,
  windowMs: 30 * 60_000,
  cooldownMs: 30 * 60_000,
  maxMembers: 12,
  minSeverity: "MEDIUM",
};

/**
 * An identity that several detections agree about.
 *
 * The identity-aware one, and the reason Guard and the IdP are one product: a spray from one
 * address and a successful sign-in correlated to a person is *that person's* session being
 * guessed at. Correlation runs on the identity id, so it only fires when the pipeline
 * actually joined alerts to a session — a correlation that fired on an unnamed identity
 * would be correlating on `null`.
 */
export const IDENTITY_TARGETED_CORRELATION: CorrelationRule = {
  id: "SG-COR-003",
  version: 1,
  name: "Identity under multiple attacks",
  severity: "HIGH",
  description:
    "Two or more different authentication detections against the same identity inside fifteen minutes. Separate alerts say somebody is being guessed at; together they say the same account is the target, which is when a second factor and a session revocation stop being optional.",
  references: ["MITRE:T1110", "MITRE:T1078", "MITRE:T1531"],
  groupBy: "identityId",
  minAlerts: 2,
  minDistinctRules: 2,
  windowMs: 15 * 60_000,
  cooldownMs: 15 * 60_000,
  maxMembers: 12,
  minSeverity: "MEDIUM",
};

export const CORRELATION_RULES: readonly CorrelationRule[] = [
  RECON_THEN_AUTH_CORRELATION,
  HOST_COMPROMISE_CORRELATION,
  IDENTITY_TARGETED_CORRELATION,
];

/**
 * A name for the correlation corpus as a whole, the same way `rulebookVersion` names the
 * detection corpus.
 *
 * A correlation rule is code too, and "which correlation was running" is the same question
 * about an incident as "which rulebook was running" is about an alert.
 */
export function correlationVersion(rules: readonly CorrelationRule[] = CORRELATION_RULES): string {
  const lines = rules
    .map(
      (rule) =>
        `${rule.id}@${rule.version}|${rule.severity}|${rule.groupBy}|${rule.minAlerts}|${rule.minDistinctRules}|${rule.windowMs}|${rule.cooldownMs}`,
    )
    .sort();
  // Short, derived, order-independent — the properties `rulebookVersion` has, for the same
  // reasons. Kept as a simple string here so this module needs no hash dependency.
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(lines.join("\n"))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
