/**
 * Incident service (M3): declare an incident, move it along, staff it — and keep
 * a timeline nobody can quietly rewrite.
 *
 * Every operation that changes an incident also appends an `IncidentEvent`.
 * That is the point of the module: the war-room timeline is built from events
 * written *as things happened*, never reconstructed from memory afterwards. The
 * events are append-only, and the same operations emit hash-chained audit
 * events, so the incident's story is both readable and tamper-evident.
 *
 * The store and audit sink are injected, so the app shares the ticket stack's
 * per-tenant chain and the tests use fakes.
 */

import { randomUUID } from "node:crypto";

import { hasPermission, type Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  advancePhase,
  incidentRef,
  isIncidentClosed,
  isIncidentRole,
  roleField,
  roleLabel,
  severityFor,
  unfilledRequiredRoles,
  validateIncident,
  type IncidentImpact,
  type IncidentInput,
  type IncidentPhase,
  type IncidentRole,
  type IncidentSeverity,
  type IncidentUrgency,
} from "./incident-rules";
import type { ServiceResult } from "./ticket-service";

export interface IncidentRecord {
  id: string;
  tenantId: string;
  ref: string;
  title: string;
  summary: string;
  severity: IncidentSeverity;
  phase: IncidentPhase;
  /** The matrix inputs, kept as the evidence for the severity call. */
  impact: IncidentImpact;
  urgency: IncidentUrgency;
  /** The ticket this incident was declared from, when there was one. */
  ticketId: string | null;
  /** The security alert, when the incident came from the alert stream. */
  alertId: string | null;
  commanderId: string | null;
  commsLeadId: string | null;
  scribeId: string | null;
  liaisonId: string | null;
  /** When the incident actually began, which is not when it was noticed. */
  detectedAt: string;
  declaredAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  reviewedAt: string | null;
}

export type IncidentEventKind =
  | "declared"
  | "phase"
  | "role"
  | "note"
  | "playbook"
  | "evidence"
  | "custody"
  | "hold"
  /** A regulatory/contractual notification duty (M3, `regulatory-rules.ts`). */
  | "notification"
  /** The post-incident review being published (M3, `review-rules.ts`). */
  | "review"
  /** One trackable action from that review. */
  | "action";

export const INCIDENT_EVENT_KINDS: readonly IncidentEventKind[] = [
  "declared",
  "phase",
  "role",
  "note",
  "playbook",
  "evidence",
  "custody",
  "hold",
  "notification",
  "review",
  "action",
];

/** Narrow a persisted timeline kind, so a value that predates a change degrades. */
export function isIncidentEventKind(value: unknown): value is IncidentEventKind {
  return typeof value === "string" && (INCIDENT_EVENT_KINDS as readonly string[]).includes(value);
}

/** One line of the incident timeline. Append-only; corrections are new events. */
export interface IncidentEvent {
  id: string;
  tenantId: string;
  incidentId: string;
  at: string;
  kind: IncidentEventKind;
  actor: string;
  summary: string;
  detail: Record<string, unknown> | null;
}

export interface IncidentStore {
  nextIncidentSeq(tenantId: string): Promise<number>;
  insertIncident(record: IncidentRecord): Promise<void>;
  findIncident(tenantId: string, incidentId: string): Promise<IncidentRecord | null>;
  listIncidents(tenantId: string): Promise<IncidentRecord[]>;
  updateIncident(record: IncidentRecord): Promise<void>;
  appendEvent(event: IncidentEvent): Promise<void>;
  listEvents(tenantId: string, incidentId: string): Promise<IncidentEvent[]>;
  /**
   * Every incident's timeline in one read. Optional: a console that lists a
   * dozen incidents should not run a dozen queries for data it is going to
   * render side by side, but a store that cannot batch simply falls back to the
   * per-incident method.
   */
  listEventPages?(tenantId: string, incidentIds: readonly string[]): Promise<Map<string, IncidentEvent[]>>;
}

export interface IncidentIds {
  id(): string;
  now(): string;
}

export function systemIncidentIds(): IncidentIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

export class IncidentService {
  constructor(
    private readonly store: IncidentStore,
    private readonly audit: AuditSink | null = null,
    private readonly ids: IncidentIds = systemIncidentIds(),
  ) {}

  /** Declare an incident. The severity comes from the matrix unless overridden. */
  async declare(actor: Actor, input: IncidentInput): Promise<ServiceResult<IncidentRecord>> {
    if (!hasPermission(actor.role, "ticket:update")) {
      return { ok: false, error: "You cannot declare incidents." };
    }
    const issues = validateIncident(input);
    if (issues.length > 0) return { ok: false, error: issues[0] };

    const now = this.ids.now();
    const record: IncidentRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      ref: incidentRef(await this.store.nextIncidentSeq(actor.tenantId)),
      title: input.title.trim(),
      summary: input.summary.trim(),
      severity: input.severity ?? severityFor(input.impact, input.urgency),
      phase: "DETECTED",
      impact: input.impact,
      urgency: input.urgency,
      ticketId: input.ticketId ?? null,
      alertId: input.alertId ?? null,
      commanderId: input.commanderId ?? null,
      commsLeadId: null,
      scribeId: null,
      liaisonId: null,
      detectedAt: input.detectedAt ?? now,
      declaredAt: now,
      updatedAt: now,
      resolvedAt: null,
      reviewedAt: null,
    };
    await this.store.insertIncident(record);
    await this.record(actor.id, record, "declared", `Declared ${record.severity}: ${record.title}`, {
      severity: record.severity,
      impact: record.impact,
      urgency: record.urgency,
      requiredRoles: unfilledRequiredRoles(record.severity, record),
    });
    if (this.audit) await this.audit.append(incidentAudit(record, actor.id, "incident.declare", now));

    return { ok: true, value: record };
  }

  /**
   * Move the incident along the ladder. A `SEV1`/`SEV2` may not be triaged
   * without its required roles — the point of declaring it is that someone owns
   * it, and an incident with no commander is how a response stalls silently.
   */
  async advance(actor: Actor, incidentId: string, to: IncidentPhase): Promise<ServiceResult<IncidentRecord>> {
    if (!hasPermission(actor.role, "ticket:update")) return { ok: false, error: "You cannot update incidents." };

    const incident = await this.store.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };

    const moved = advancePhase(incident.phase, to);
    if (!moved.ok) return { ok: false, error: moved.reason };

    if (moved.phase === "TRIAGED") {
      const missing = unfilledRequiredRoles(incident.severity, incident);
      if (missing.length > 0) {
        return { ok: false, error: `Assign ${missing.map((role) => roleLabel(role).toLowerCase()).join(" and ")} before triaging.` };
      }
    }

    const now = this.ids.now();
    const next: IncidentRecord = {
      ...incident,
      phase: moved.phase,
      updatedAt: now,
      resolvedAt: moved.phase === "RECOVERED" ? now : incident.resolvedAt,
      reviewedAt: moved.phase === "REVIEWED" ? now : incident.reviewedAt,
    };
    await this.store.updateIncident(next);
    await this.record(actor.id, next, "phase", `Moved to ${moved.phase.toLowerCase()}`, {
      from: incident.phase,
      to: moved.phase,
    });
    if (this.audit) await this.audit.append(incidentAudit(next, actor.id, "incident.phase", now, { from: incident.phase, to: moved.phase }));

    return { ok: true, value: next };
  }

  /** Put someone in (or out of) an incident role. */
  async assignRole(
    actor: Actor,
    incidentId: string,
    role: IncidentRole,
    userId: string | null,
  ): Promise<ServiceResult<IncidentRecord>> {
    if (!hasPermission(actor.role, "ticket:update")) return { ok: false, error: "You cannot staff incidents." };
    if (!isIncidentRole(role)) return { ok: false, error: `Unknown incident role "${role}".` };

    const incident = await this.store.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };

    const now = this.ids.now();
    const next: IncidentRecord = { ...incident, [roleField(role)]: userId, updatedAt: now };
    await this.store.updateIncident(next);

    const label = roleLabel(role);
    await this.record(actor.id, next, "role", userId ? `${label} assigned` : `${label} cleared`, { role, userId });
    if (this.audit) await this.audit.append(incidentAudit(next, actor.id, "incident.role", now, { role, userId }));

    return { ok: true, value: next };
  }

  /** Add a free-text timeline note (a decision, a containment step, a call). */
  async addNote(actor: Actor, incidentId: string, summary: string): Promise<ServiceResult<IncidentRecord>> {
    if (!hasPermission(actor.role, "ticket:update")) return { ok: false, error: "You cannot update incidents." };
    const incident = await this.store.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };

    const text = summary.trim();
    if (!text) return { ok: false, error: "A note cannot be empty." };
    await this.record(actor.id, incident, "note", text, null);
    return { ok: true, value: incident };
  }

  async get(tenantId: string, incidentId: string): Promise<IncidentRecord | null> {
    return this.store.findIncident(tenantId, incidentId);
  }

  async list(tenantId: string): Promise<IncidentRecord[]> {
    return this.store.listIncidents(tenantId);
  }

  async timeline(tenantId: string, incidentId: string): Promise<IncidentEvent[]> {
    return this.store.listEvents(tenantId, incidentId);
  }

  /** Several incidents' timelines, in one read where the store can batch. */
  async timelinesFor(tenantId: string, incidents: readonly IncidentRecord[]): Promise<Map<string, IncidentEvent[]>> {
    if (incidents.length === 0) return new Map();
    if (this.store.listEventPages) return this.store.listEventPages(tenantId, incidents.map((incident) => incident.id));

    const pages = new Map<string, IncidentEvent[]>();
    for (const incident of incidents) pages.set(incident.id, await this.store.listEvents(tenantId, incident.id));
    return pages;
  }

  /** Append one timeline event. The only writer, so the shape stays consistent. */
  private async record(
    actor: string,
    incident: IncidentRecord,
    kind: IncidentEventKind,
    summary: string,
    detail: Record<string, unknown> | null,
  ): Promise<void> {
    const event: IncidentEvent = {
      id: this.ids.id(),
      tenantId: incident.tenantId,
      incidentId: incident.id,
      at: this.ids.now(),
      kind,
      actor,
      summary,
      detail,
    };
    await this.store.appendEvent(event);
  }
}

/** The audit event an incident mutation emits. */
export function incidentAudit(
  incident: IncidentRecord,
  actor: string,
  action: string,
  at: string,
  detail: Record<string, unknown> = {},
): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId: incident.tenantId,
    at,
    actor,
    action,
    targetType: "incident",
    targetId: incident.id,
    detail: { ref: incident.ref, severity: incident.severity, phase: incident.phase, ...detail },
  };
}

/** Whether an incident is still someone's job (for a worklist badge). */
export function incidentIsOpen(incident: IncidentRecord): boolean {
  return !isIncidentClosed(incident.phase);
}

/** An in-memory store, used by tests and local development. */
export class MemoryIncidentStore implements IncidentStore {
  private readonly incidents = new Map<string, IncidentRecord>();
  private readonly events = new Map<string, IncidentEvent[]>();
  private readonly seq = new Map<string, number>();

  async nextIncidentSeq(tenantId: string): Promise<number> {
    const next = (this.seq.get(tenantId) ?? 0) + 1;
    this.seq.set(tenantId, next);
    return next;
  }

  async insertIncident(record: IncidentRecord): Promise<void> {
    this.incidents.set(`${record.tenantId}:${record.id}`, structuredClone(record));
  }

  async findIncident(tenantId: string, incidentId: string): Promise<IncidentRecord | null> {
    const found = this.incidents.get(`${tenantId}:${incidentId}`);
    return found ? structuredClone(found) : null;
  }

  async listIncidents(tenantId: string): Promise<IncidentRecord[]> {
    return [...this.incidents.values()]
      .filter((record) => record.tenantId === tenantId)
      .sort((a, b) => b.declaredAt.localeCompare(a.declaredAt))
      .map((record) => structuredClone(record));
  }

  async updateIncident(record: IncidentRecord): Promise<void> {
    this.incidents.set(`${record.tenantId}:${record.id}`, structuredClone(record));
  }

  async appendEvent(event: IncidentEvent): Promise<void> {
    const key = `${event.tenantId}:${event.incidentId}`;
    this.events.set(key, [...(this.events.get(key) ?? []), structuredClone(event)]);
  }

  async listEvents(tenantId: string, incidentId: string): Promise<IncidentEvent[]> {
    return (this.events.get(`${tenantId}:${incidentId}`) ?? []).map((event) => structuredClone(event));
  }

  async listEventPages(tenantId: string, incidentIds: readonly string[]): Promise<Map<string, IncidentEvent[]>> {
    const pages = new Map<string, IncidentEvent[]>();
    for (const incidentId of incidentIds) pages.set(incidentId, await this.listEvents(tenantId, incidentId));
    return pages;
  }
}
