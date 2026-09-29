/**
 * War-room timeline rules (M3): assemble *one* story out of several systems.
 *
 * The incident timeline an operator writes is only part of what happened. The
 * rest is already recorded somewhere else — who signed in, which alerts landed,
 * which promotions and suppressions were decided, what the audit chain saw — and
 * a response that has to reconcile those by hand afterwards is a response that
 * reconstructs its history from memory.
 *
 * So this module does the reconciling, purely: it normalizes each source into a
 * `WarRoomEvent`, and `mergeWarRoomEvents` folds events that describe the *same
 * fact* into one entry carrying every source that corroborates it. That last
 * part is the interesting bit. An incident-log event and the audit record
 * written by the same call are the same fact seen twice, so they merge and the
 * entry is marked as attested by both — which is the difference between "the
 * scribe wrote it down" and "the system recorded it".
 *
 * Nothing here reads a database, so the merge can be exercised in a test.
 */

import type { AuditRecord } from "./audit-chain";
import type { IncidentEvent } from "./incident-service";

/* -------------------------------------------------------------------------- */
/*  Shape                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where an entry came from. The console labels every line with one of these.
 *
 * `log` and `audit` are deliberately separate sources even though the same call
 * usually writes both: they are different kinds of attestation — somebody wrote
 * it down, and the hash-chained log recorded it — so an entry that carries both
 * is the one thing this feature exists to show.
 */
export const WAR_ROOM_SOURCES = ["log", "alert", "decision", "login", "audit"] as const;
export type WarRoomSource = (typeof WAR_ROOM_SOURCES)[number];

export function isWarRoomSource(value: unknown): value is WarRoomSource {
  return typeof value === "string" && (WAR_ROOM_SOURCES as readonly string[]).includes(value);
}

export const WAR_ROOM_SOURCE_LABELS: Record<WarRoomSource, string> = {
  log: "incident log",
  alert: "alert",
  decision: "decision",
  login: "sign-in",
  audit: "audit chain",
};

/** One fact, as one source reported it. */
export interface WarRoomEvent {
  id: string;
  at: string;
  source: WarRoomSource;
  /** A short machine kind, e.g. `signin`, `phase`, `promotion`. */
  kind: string;
  actor: string;
  summary: string;
  detail: Record<string, unknown> | null;
  /**
   * Set when the same fact can arrive from more than one source. Two events with
   * the same correlation are one entry with two sources.
   */
  correlation: string | null;
}

/** One line of the assembled timeline, with everything that attests to it. */
export interface WarRoomEntry {
  /** The representative event's id (the incident log's, when there is one). */
  id: string;
  at: string;
  kind: string;
  actor: string;
  summary: string;
  detail: Record<string, unknown> | null;
  /** Every source that reported this fact, in a stable order. */
  sources: WarRoomSource[];
  /** Every underlying event id that was folded in. */
  ids: string[];
}

/* -------------------------------------------------------------------------- */
/*  Correlation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The family an incident-log event belongs to: what an audit record written by
 * the same call is matched on. The two records share an instant and an actor but
 * not a name (`playbook` vs `incident.playbook.step`), so the family is the join
 * key.
 */
const KIND_FAMILIES: Record<string, string> = {
  declared: "declared",
  phase: "phase",
  role: "role",
  note: "note",
  playbook: "playbook",
  evidence: "evidence",
  custody: "custody",
  hold: "hold",
  notification: "notification",
  review: "review",
  action: "action",
};

/** Audit actions that mirror an incident-log event, and their family. */
const AUDIT_FAMILIES: Record<string, string> = {
  "incident.declare": "declared",
  "incident.phase": "phase",
  "incident.role": "role",
  "incident.note": "note",
  "incident.playbook.start": "playbook",
  "incident.playbook.step": "playbook",
  "incident.evidence.record": "evidence",
  "incident.custody.transfer": "custody",
  "incident.hold.place": "hold",
  "incident.hold.release": "hold",
  "incident.notification.track": "notification",
  "incident.notification.sent": "notification",
  "incident.notification.ack": "notification",
  "incident.notification.waive": "notification",
  "incident.review.publish": "review",
  "incident.action.add": "action",
  "incident.action.start": "action",
  "incident.action.complete": "action",
  "incident.action.drop": "action",
};

/**
 * `same fact, two systems`: a family, the actor and the second it happened in.
 *
 * The **second**, not the millisecond, because the two records are written by
 * two clock reads a few milliseconds apart — the log entry and its audit twin
 * are the same act, and a correlation that demanded an identical timestamp would
 * never match in the running system (it would only match in a hand-built test,
 * which is worse than useless). The actor is part of the key so that two
 * different people acting at the same moment stay two entries.
 */
export function incidentCorrelation(family: string, actor: string, at: string): string {
  return `incident:${family}:${actor}:${at.slice(0, 19)}`;
}

/* -------------------------------------------------------------------------- */
/*  Normalizers                                                               */
/* -------------------------------------------------------------------------- */

/** An incident-log event, as a war-room event. Correlates with its audit twin. */
export function incidentEventToWarRoom(event: IncidentEvent): WarRoomEvent {
  const family = KIND_FAMILIES[event.kind] ?? event.kind;
  return {
    id: `incident:${event.id}`,
    at: event.at,
    source: "log",
    kind: event.kind,
    actor: event.actor,
    summary: event.summary,
    detail: event.detail,
    correlation: incidentCorrelation(family, event.actor, event.at),
  };
}

/** Readable summaries for the audit actions the war-room cares about. */
const AUDIT_SUMMARIES: Record<string, string> = {
  "identity.signin": "Signed in",
  "identity.signin.denied": "Sign-in refused",
  "identity.role.change": "Role changed",
  "identity.scim.provision": "Provisioned by directory sync",
  "identity.scim.deprovision": "Deprovisioned by directory sync",
  "identity.scim.push": "Pushed to the identity provider",
  "identity.connection.configure": "Identity provider configured",
  "security.alert.ingest": "Alert ingested",
  "incident.declare": "Declared the incident",
  "incident.phase": "Moved the incident on",
  "incident.role": "Changed an incident role",
  "incident.note": "Added a note",
  "incident.playbook.start": "Started the playbook",
  "incident.playbook.step": "Updated a playbook step",
  "incident.evidence.record": "Recorded evidence",
  "incident.custody.transfer": "Transferred custody",
  "incident.hold.place": "Placed a legal hold",
  "incident.hold.release": "Released a legal hold",
  "incident.manifest": "Generated the evidence manifest",
  "incident.packet.export": "Exported the assurance packet",
  "incident.notification.track": "Started tracking a notification",
  "incident.notification.sent": "Sent a regulatory notification",
  "incident.notification.ack": "Acknowledged a regulatory notification",
  "incident.notification.waive": "Waived a regulatory notification",
  "incident.review.publish": "Published the post-incident review",
  "incident.action.add": "Added a review action",
  "incident.action.start": "Started a review action",
  "incident.action.complete": "Completed a review action",
  "incident.action.drop": "Dropped a review action",
};

/** Which war-room source an audit action belongs to, or null to leave it out. */
export function auditSource(action: string): WarRoomSource | null {
  if (action.startsWith("identity.signin") || action === "identity.role.change") return "login";
  if (action.startsWith("identity.scim") || action.startsWith("identity.connection")) return "decision";
  if (action.startsWith("security.alert")) return "alert";
  return AUDIT_SUMMARIES[action] ? "audit" : null;
}

/** What an audit record has to be *about* to belong on an incident's line. */
export interface AuditWarRoomFilter {
  /** The incident itself. An `incident.*` event about another one is dropped. */
  incidentId: string | null;
  /** The alerts that belong to this incident; an unrelated ingest is dropped. */
  alertIds: ReadonlySet<string>;
}

/**
 * One audit record, as a war-room event — or `null` when it is not part of this
 * incident's story.
 *
 * The tenant's chain is one chain, so the filter matters: `ticket.update` is not
 * war-room material at all, an `incident.*` event about a different incident
 * would put somebody else's night on this line, and an alert ingest for an alert
 * that has nothing to do with this incident is noise. Sign-ins are the
 * deliberate exception — they are tenant-wide, and "who was at their desk when
 * this started" is exactly the question the timeline is answering.
 */
export function auditRecordToWarRoom(record: AuditRecord, filter: AuditWarRoomFilter): WarRoomEvent | null {
  const source = auditSource(record.action);
  if (!source) return null;

  if (source === "audit" && (filter.incidentId === null || record.targetId !== filter.incidentId)) return null;
  if (source === "alert" && !(record.targetId && filter.alertIds.has(record.targetId))) return null;

  const family = AUDIT_FAMILIES[record.action] ?? null;
  // The alert an ingest event is about; matches `securityAlertToWarRoom`.
  const alertId = record.action === "security.alert.ingest" ? (record.targetId ?? null) : null;

  return {
    id: `audit:${record.id}`,
    at: record.at,
    source,
    kind: record.action.split(".").slice(-1)[0] ?? record.action,
    actor: record.actor,
    summary: AUDIT_SUMMARIES[record.action] ?? record.action,
    detail: { action: record.action, ...(record.detail ?? {}) },
    correlation: alertId ? `alert:${alertId}` : family ? incidentCorrelation(family, record.actor, record.at) : null,
  };
}

/** An alert, as a war-room event — with why it belongs on this incident. */
export function securityAlertToWarRoom(
  alert: { id: string; source: string; occurredAt: string; signature: string; severity: string; description: string },
  because: string,
): WarRoomEvent {
  return {
    id: `alert:${alert.id}`,
    at: alert.occurredAt,
    source: "alert",
    kind: "alert",
    actor: `system:${alert.source.toLowerCase()}`,
    summary: `${alert.severity} ${alert.signature}: ${alert.description}`,
    detail: { alertId: alert.id, severity: alert.severity, because },
    correlation: `alert:${alert.id}`,
  };
}

/** A promotion or suppression decision: the approvals half of the timeline. */
export function promotionToWarRoom(record: {
  id: string;
  alertId: string;
  decision: string;
  reason: string;
  ticketRef: string | null;
  at: string;
}): WarRoomEvent {
  return {
    id: `decision:${record.id}`,
    at: record.at,
    source: "decision",
    kind: record.decision === "SUPPRESS" ? "suppression" : "promotion",
    actor: "system:alert-promotion",
    summary:
      record.decision === "SUPPRESS"
        ? `Decided not to work the alert: ${record.reason}`
        : `Promoted the alert to ${record.ticketRef ?? "a ticket"}: ${record.reason}`,
    detail: { alertId: record.alertId, decision: record.decision, ticketRef: record.ticketRef },
    correlation: `decision:${record.id}`,
  };
}

/** A triage verdict: someone's recorded judgement about a detection. */
export function verdictToWarRoom(verdict: {
  id: string;
  signature: string;
  verdict: string;
  note?: string | null;
  by?: string | null;
  at: string;
}): WarRoomEvent {
  return {
    id: `verdict:${verdict.id}`,
    at: verdict.at,
    source: "decision",
    kind: "verdict",
    actor: verdict.by ?? "system:alert-promotion",
    summary: `Recorded a ${verdict.verdict.toLowerCase()} verdict on ${verdict.signature}${verdict.note ? `: ${verdict.note}` : ""}`,
    detail: { signature: verdict.signature, verdict: verdict.verdict },
    correlation: `verdict:${verdict.id}`,
  };
}

/* -------------------------------------------------------------------------- */
/*  Relevance                                                                 */
/* -------------------------------------------------------------------------- */

export interface WarRoomWindow {
  from: string;
  to: string;
}

/**
 * The window a war-room timeline covers. It opens *before* the incident was
 * detected — sign-ins and alerts in the hour before are frequently the run-up —
 * and closes when it was recovered, or at `now` while it is still running.
 */
export function warRoomWindow(
  incident: { detectedAt: string; resolvedAt: string | null },
  now: string,
  leadInMinutes = 60,
): WarRoomWindow {
  return {
    from: new Date(new Date(incident.detectedAt).getTime() - leadInMinutes * 60_000).toISOString(),
    to: incident.resolvedAt ?? now,
  };
}

function inWindow(at: string, window: WarRoomWindow): boolean {
  return at >= window.from && at <= window.to;
}

/** Whether an alert belongs to this incident's story, and why. */
export interface RelevantAlert<T> {
  alert: T;
  because: string;
}

/**
 * Which alerts belong on this incident. Three reasons, each checkable: the alert
 * the incident was declared from, an alert promoted to the incident's ticket,
 * and an alert inside the window that shares an asset or an identity with the
 * source alert. Anything else is somebody else's incident.
 */
export function relevantAlerts<
  T extends { id: string; ticketId?: string | null; asset?: string | null; identity?: string | null; occurredAt: string },
>(incident: { alertId: string | null; ticketId: string | null }, alerts: readonly T[], window: WarRoomWindow): RelevantAlert<T>[] {
  const source = incident.alertId ? alerts.find((alert) => alert.id === incident.alertId) : undefined;
  const relevant: RelevantAlert<T>[] = [];

  for (const alert of alerts) {
    if (!inWindow(alert.occurredAt, window)) continue;

    if (incident.alertId && alert.id === incident.alertId) {
      relevant.push({ alert, because: "the alert this incident was declared from" });
      continue;
    }
    if (incident.ticketId && alert.ticketId === incident.ticketId) {
      relevant.push({ alert, because: "promoted to the incident's ticket" });
      continue;
    }
    if (source?.asset && alert.asset && alert.asset === source.asset) {
      relevant.push({ alert, because: `same asset as the source alert (${alert.asset})` });
      continue;
    }
    if (source?.identity && alert.identity && alert.identity === source.identity) {
      relevant.push({ alert, because: `same identity as the source alert (${alert.identity})` });
    }
  }

  return relevant;
}

/* -------------------------------------------------------------------------- */
/*  Merge                                                                     */
/* -------------------------------------------------------------------------- */

/** The source that speaks for a merged entry: the operator's log, if present. */
const SOURCE_PRIORITY: Record<WarRoomSource, number> = { log: 0, alert: 1, decision: 2, login: 3, audit: 4 };

function mergeGroup(group: readonly WarRoomEvent[]): WarRoomEntry {
  const representative = [...group].sort(
    (a, b) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source] || a.at.localeCompare(b.at) || a.id.localeCompare(b.id),
  )[0];

  const sources = [...new Set(group.map((event) => event.source))].sort(
    (a, b) => WAR_ROOM_SOURCES.indexOf(a) - WAR_ROOM_SOURCES.indexOf(b),
  );

  return {
    id: representative.id,
    at: representative.at,
    kind: representative.kind,
    actor: representative.actor,
    summary: representative.summary,
    detail: group.find((event) => event.detail !== null)?.detail ?? null,
    sources,
    ids: group.map((event) => event.id),
  };
}

/**
 * Fold events that describe the same fact into one entry, and order the result
 * by time. Events with no correlation are their own entry, so a note the scribe
 * typed stays a single-source line rather than being pinned to whatever else
 * happened that second.
 */
export function mergeWarRoomEvents(events: readonly WarRoomEvent[]): WarRoomEntry[] {
  const groups = new Map<string, WarRoomEvent[]>();
  const order: string[] = [];

  events.forEach((event, index) => {
    const key = event.correlation ? `c:${event.correlation}` : `e:${index}:${event.id}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(event);
  });

  return order
    .map((key) => mergeGroup(groups.get(key)!))
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** The assembled timeline, clipped to the window. */
export function clipWarRoom(entries: readonly WarRoomEntry[], window: WarRoomWindow): WarRoomEntry[] {
  return entries.filter((entry) => inWindow(entry.at, window));
}

/** How many lines each source contributed, for a page header. */
export interface WarRoomSummary {
  total: number;
  bySource: Record<WarRoomSource, number>;
  /** Entries more than one source attests to. */
  corroborated: number;
}

export function warRoomSummary(entries: readonly WarRoomEntry[]): WarRoomSummary {
  const bySource = Object.fromEntries(WAR_ROOM_SOURCES.map((source) => [source, 0])) as Record<WarRoomSource, number>;
  let corroborated = 0;
  for (const entry of entries) {
    for (const source of entry.sources) bySource[source] += 1;
    if (entry.sources.length > 1) corroborated += 1;
  }
  return { total: entries.length, bySource, corroborated };
}
