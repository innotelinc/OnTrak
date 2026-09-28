/**
 * Incident rules (M3): the severity matrix, the lifecycle and incident roles.
 *
 * An incident is not a ticket with a scarier label. It is a *declared* event
 * with a severity someone chose, a phase it moves through, and named people who
 * own parts of the response. This module is the whole vocabulary of that, kept
 * pure so the declaration, the phase change and the role assignment are all one
 * auditable decision each:
 *
 *  - **Severity** comes from a matrix, not a mood: impact × urgency. The inputs
 *    are recorded with the outcome, so "why was this a SEV2?" has an answer six
 *    months later.
 *  - **Phases** are a short ladder (detected → triaged → contained → eradicated
 *    → recovered → reviewed). Illegal jumps are refused with a readable reason,
 *    and `REVIEWED` is the only end state.
 *  - **Roles** are who is accountable: commander, comms lead, scribe, liaison.
 *
 * Nothing here talks to a store or a clock; a service decides what to persist.
 */

export type IncidentSeverity = "SEV1" | "SEV2" | "SEV3" | "SEV4";
export const INCIDENT_SEVERITIES: readonly IncidentSeverity[] = ["SEV1", "SEV2", "SEV3", "SEV4"];

export type IncidentImpact = "EXTENSIVE" | "SIGNIFICANT" | "MODERATE" | "MINOR";
export type IncidentUrgency = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export const INCIDENT_IMPACTS: readonly IncidentImpact[] = ["EXTENSIVE", "SIGNIFICANT", "MODERATE", "MINOR"];
export const INCIDENT_URGENCIES: readonly IncidentUrgency[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

/**
 * The severity matrix: impact down, urgency across. It is a table rather than a
 * formula because a desk argues about the table, not about the arithmetic.
 */
export const SEVERITY_MATRIX: Record<IncidentImpact, Record<IncidentUrgency, IncidentSeverity>> = {
  EXTENSIVE: { CRITICAL: "SEV1", HIGH: "SEV1", MEDIUM: "SEV2", LOW: "SEV2" },
  SIGNIFICANT: { CRITICAL: "SEV1", HIGH: "SEV2", MEDIUM: "SEV2", LOW: "SEV3" },
  MODERATE: { CRITICAL: "SEV2", HIGH: "SEV2", MEDIUM: "SEV3", LOW: "SEV3" },
  MINOR: { CRITICAL: "SEV3", HIGH: "SEV3", MEDIUM: "SEV4", LOW: "SEV4" },
};

export function isIncidentSeverity(value: unknown): value is IncidentSeverity {
  return typeof value === "string" && (INCIDENT_SEVERITIES as readonly string[]).includes(value);
}

/** The severity the matrix gives a pair of inputs. */
export function severityFor(impact: IncidentImpact, urgency: IncidentUrgency): IncidentSeverity {
  return SEVERITY_MATRIX[impact][urgency];
}

/** Lower is more severe, so "at least as severe as" is a comparison. */
export function severityRank(severity: IncidentSeverity): number {
  return INCIDENT_SEVERITIES.indexOf(severity);
}

/** Whether `severity` is at least as severe as `threshold`. */
export function atLeastAsSevere(severity: IncidentSeverity, threshold: IncidentSeverity): boolean {
  return severityRank(severity) <= severityRank(threshold);
}

/**
 * The desk's response commitment per severity, in minutes. It is not an SLA — an
 * incident is not a promise to a customer — it is what the duty roster is
 * expected to hit, so `SEV1` is measured in minutes and `SEV4` in hours.
 */
export function targetAcknowledgeMinutes(severity: IncidentSeverity): number {
  switch (severity) {
    case "SEV1":
      return 15;
    case "SEV2":
      return 30;
    case "SEV3":
      return 120;
    default:
      return 480;
  }
}

/* -------------------------------------------------------------------------- */
/*  The lifecycle                                                             */
/* -------------------------------------------------------------------------- */

export type IncidentPhase = "DETECTED" | "TRIAGED" | "CONTAINED" | "ERADICATED" | "RECOVERED" | "REVIEWED";
export const INCIDENT_PHASES: readonly IncidentPhase[] = [
  "DETECTED",
  "TRIAGED",
  "CONTAINED",
  "ERADICATED",
  "RECOVERED",
  "REVIEWED",
];

/**
 * Allowed moves. The ladder is mostly forward, but a regression is real work —
 * something "eradicated" that comes back is *contained* again, not a new
 * incident — so backwards moves are allowed one rung and only to reopen.
 */
const PHASE_TRANSITIONS: Record<IncidentPhase, readonly IncidentPhase[]> = {
  DETECTED: ["TRIAGED", "CONTAINED"],
  TRIAGED: ["CONTAINED"],
  CONTAINED: ["ERADICATED", "TRIAGED"],
  ERADICATED: ["RECOVERED", "CONTAINED"],
  RECOVERED: ["REVIEWED", "CONTAINED"],
  REVIEWED: ["CONTAINED"],
};

export function canAdvance(from: IncidentPhase, to: IncidentPhase): boolean {
  if (from === to) return false;
  return PHASE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** The only end state: an incident whose review is written up. */
export function isIncidentClosed(phase: IncidentPhase): boolean {
  return phase === "REVIEWED";
}

/** Whether the response itself is over (contained through recovered). */
export function isResponseActive(phase: IncidentPhase): boolean {
  return phase === "DETECTED" || phase === "TRIAGED" || phase === "CONTAINED" || phase === "ERADICATED";
}

export type PhaseResult = { ok: true; phase: IncidentPhase } | { ok: false; reason: string };

/** Apply a phase change, refusing an illegal move with a readable reason. */
export function advancePhase(from: IncidentPhase, to: IncidentPhase): PhaseResult {
  if (from === to) return { ok: false, reason: `This incident is already ${to.toLowerCase()}.` };
  if (!canAdvance(from, to)) {
    return { ok: false, reason: `A ${from.toLowerCase()} incident cannot move straight to ${to.toLowerCase()}.` };
  }
  return { ok: true, phase: to };
}

/** How far along the ladder a phase is, as a fraction (for a progress strip). */
export function phaseProgress(phase: IncidentPhase): number {
  const index = INCIDENT_PHASES.indexOf(phase);
  return index < 0 ? 0 : index / (INCIDENT_PHASES.length - 1);
}

/* -------------------------------------------------------------------------- */
/*  Roles                                                                     */
/* -------------------------------------------------------------------------- */

export type IncidentRole = "COMMANDER" | "COMMS_LEAD" | "SCRIBE" | "LIAISON";
export const INCIDENT_ROLES: readonly IncidentRole[] = ["COMMANDER", "COMMS_LEAD", "SCRIBE", "LIAISON"];

export function isIncidentRole(value: unknown): value is IncidentRole {
  return typeof value === "string" && (INCIDENT_ROLES as readonly string[]).includes(value);
}

/** The field on an incident a role is stored in. */
export function roleField(role: IncidentRole): "commanderId" | "commsLeadId" | "scribeId" | "liaisonId" {
  switch (role) {
    case "COMMANDER":
      return "commanderId";
    case "COMMS_LEAD":
      return "commsLeadId";
    case "SCRIBE":
      return "scribeId";
    case "LIAISON":
      return "liaisonId";
  }
}

const ROLE_LABELS: Record<IncidentRole, string> = {
  COMMANDER: "Incident commander",
  COMMS_LEAD: "Communications lead",
  SCRIBE: "Scribe",
  LIAISON: "Liaison",
};

export function roleLabel(role: IncidentRole): string {
  return ROLE_LABELS[role];
}

/** The roles that must be filled before a `SEV1`/`SEV2` may be triaged. */
export function requiredRolesFor(severity: IncidentSeverity): readonly IncidentRole[] {
  return atLeastAsSevere(severity, "SEV2") ? ["COMMANDER", "SCRIBE"] : ["COMMANDER"];
}

/** The roles named on an incident, as a list a page or a check can walk. */
export function assignedRoles(incident: {
  commanderId: string | null;
  commsLeadId: string | null;
  scribeId: string | null;
  liaisonId: string | null;
}): { role: IncidentRole; userId: string | null }[] {
  return INCIDENT_ROLES.map((role) => ({ role, userId: incident[roleField(role)] }));
}

/** Which required roles are still unassigned, so a declaration can say so. */
export function unfilledRequiredRoles(
  severity: IncidentSeverity,
  incident: {
    commanderId: string | null;
    commsLeadId: string | null;
    scribeId: string | null;
    liaisonId: string | null;
  },
): IncidentRole[] {
  return requiredRolesFor(severity).filter((role) => incident[roleField(role)] === null);
}

/* -------------------------------------------------------------------------- */
/*  Input validation & references                                             */
/* -------------------------------------------------------------------------- */

export const INCIDENT_TITLE_MAX = 200;
export const INCIDENT_SUMMARY_MAX = 20_000;

export interface IncidentInput {
  title: string;
  summary: string;
  impact: IncidentImpact;
  urgency: IncidentUrgency;
  /** Optional override; absent means the matrix decides. */
  severity?: IncidentSeverity;
  ticketId?: string | null;
  alertId?: string | null;
  detectedAt?: string;
  commanderId?: string | null;
}

/** Validate an incident declaration. Returns every problem, not the first. */
export function validateIncident(input: Partial<IncidentInput>): string[] {
  const issues: string[] = [];

  const title = input.title?.trim() ?? "";
  if (!title) issues.push("A title is required.");
  else if (title.length > INCIDENT_TITLE_MAX) issues.push(`The title may be at most ${INCIDENT_TITLE_MAX} characters.`);

  const summary = input.summary?.trim() ?? "";
  if (!summary) issues.push("A summary is required.");
  else if (summary.length > INCIDENT_SUMMARY_MAX) issues.push(`The summary may be at most ${INCIDENT_SUMMARY_MAX} characters.`);

  if (input.impact && !INCIDENT_IMPACTS.includes(input.impact)) issues.push(`Unknown impact "${input.impact}".`);
  if (input.urgency && !INCIDENT_URGENCIES.includes(input.urgency)) issues.push(`Unknown urgency "${input.urgency}".`);
  if (input.severity !== undefined && !isIncidentSeverity(input.severity)) {
    issues.push(`Unknown severity "${input.severity}".`);
  }
  if (input.detectedAt !== undefined && Number.isNaN(new Date(input.detectedAt).getTime())) {
    issues.push("The detection time is not a valid date.");
  }

  return issues;
}

/** A human-facing incident reference, e.g. `INC-000007`. */
export function incidentRef(seq: number, prefix = "INC"): string {
  return `${prefix}-${String(Math.max(1, Math.trunc(seq))).padStart(6, "0")}`;
}
