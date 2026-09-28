/**
 * Prisma adapter for the incident store (M3).
 *
 * `severity`/`phase` are Prisma enums and `impact`/`urgency` are plain strings;
 * all four are narrowed to the domain unions on the way out, so a value that
 * predates a vocabulary change degrades to a safe default instead of leaking
 * `string` into the rules. Structural, like the other adapters.
 */

import {
  INCIDENT_IMPACTS,
  INCIDENT_PHASES,
  INCIDENT_SEVERITIES,
  INCIDENT_URGENCIES,
  type IncidentImpact,
  type IncidentPhase,
  type IncidentSeverity,
  type IncidentUrgency,
} from "./incident-rules";
import { isIncidentEventKind, type IncidentEvent, type IncidentRecord, type IncidentStore } from "./incident-service";

export interface IncidentRow {
  id: string;
  tenantId: string;
  ref: string;
  title: string;
  summary: string;
  severity: string;
  phase: string;
  impact: string;
  urgency: string;
  ticketId: string | null;
  alertId: string | null;
  commanderId: string | null;
  commsLeadId: string | null;
  scribeId: string | null;
  liaisonId: string | null;
  detectedAt: Date;
  declaredAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  reviewedAt: Date | null;
}

export interface IncidentEventRow {
  id: string;
  tenantId: string;
  incidentId: string;
  at: Date;
  kind: string;
  actor: string;
  summary: string;
  detail: unknown;
}

export interface IncidentPrismaClient {
  incident: {
    count(args: unknown): Promise<number>;
    findFirst(args: unknown): Promise<IncidentRow | null>;
    findMany(args: unknown): Promise<IncidentRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
  incidentEvent: {
    findMany(args: unknown): Promise<IncidentEventRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function toSeverity(value: string): IncidentSeverity {
  return oneOf(value, INCIDENT_SEVERITIES, "SEV4");
}

export function toPhase(value: string): IncidentPhase {
  return oneOf(value, INCIDENT_PHASES, "DETECTED");
}

export function toImpact(value: string): IncidentImpact {
  return oneOf(value, INCIDENT_IMPACTS, "MINOR");
}

export function toUrgency(value: string): IncidentUrgency {
  return oneOf(value, INCIDENT_URGENCIES, "LOW");
}

export function toIncidentRecord(row: IncidentRow): IncidentRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ref: row.ref,
    title: row.title,
    summary: row.summary,
    severity: toSeverity(row.severity),
    phase: toPhase(row.phase),
    impact: toImpact(row.impact),
    urgency: toUrgency(row.urgency),
    ticketId: row.ticketId,
    alertId: row.alertId,
    commanderId: row.commanderId,
    commsLeadId: row.commsLeadId,
    scribeId: row.scribeId,
    liaisonId: row.liaisonId,
    detectedAt: toIso(row.detectedAt),
    declaredAt: toIso(row.declaredAt),
    updatedAt: toIso(row.updatedAt),
    resolvedAt: row.resolvedAt === null ? null : toIso(row.resolvedAt),
    reviewedAt: row.reviewedAt === null ? null : toIso(row.reviewedAt),
  };
}

export function toIncidentData(record: IncidentRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    ref: record.ref,
    title: record.title,
    summary: record.summary,
    severity: record.severity,
    phase: record.phase,
    impact: record.impact,
    urgency: record.urgency,
    ticketId: record.ticketId,
    alertId: record.alertId,
    commanderId: record.commanderId,
    commsLeadId: record.commsLeadId,
    scribeId: record.scribeId,
    liaisonId: record.liaisonId,
    detectedAt: new Date(record.detectedAt),
    declaredAt: new Date(record.declaredAt),
    resolvedAt: record.resolvedAt === null ? null : new Date(record.resolvedAt),
    reviewedAt: record.reviewedAt === null ? null : new Date(record.reviewedAt),
  };
}

export function toIncidentEventRecord(row: IncidentEventRow): IncidentEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    incidentId: row.incidentId,
    at: toIso(row.at),
    kind: isIncidentEventKind(row.kind) ? row.kind : "note",
    actor: row.actor,
    summary: row.summary,
    detail: (row.detail as Record<string, unknown> | null) ?? null,
  };
}

export function toIncidentEventData(event: IncidentEvent) {
  return {
    id: event.id,
    tenantId: event.tenantId,
    incidentId: event.incidentId,
    at: new Date(event.at),
    kind: event.kind,
    actor: event.actor,
    summary: event.summary,
    detail: event.detail ?? undefined,
  };
}

export class PrismaIncidentStore implements IncidentStore {
  constructor(private readonly db: IncidentPrismaClient) {}

  async nextIncidentSeq(tenantId: string): Promise<number> {
    return (await this.db.incident.count({ where: { tenantId } })) + 1;
  }

  async insertIncident(record: IncidentRecord): Promise<void> {
    await this.db.incident.create({ data: toIncidentData(record) });
  }

  async findIncident(tenantId: string, incidentId: string): Promise<IncidentRecord | null> {
    const row = await this.db.incident.findFirst({ where: { id: incidentId, tenantId } });
    return row ? toIncidentRecord(row) : null;
  }

  async listIncidents(tenantId: string): Promise<IncidentRecord[]> {
    const rows = await this.db.incident.findMany({ where: { tenantId }, orderBy: { declaredAt: "desc" } });
    return rows.map(toIncidentRecord);
  }

  async updateIncident(record: IncidentRecord): Promise<void> {
    await this.db.incident.update({ where: { id: record.id }, data: toIncidentData(record) });
  }

  async appendEvent(event: IncidentEvent): Promise<void> {
    await this.db.incidentEvent.create({ data: toIncidentEventData(event) });
  }

  async listEvents(tenantId: string, incidentId: string): Promise<IncidentEvent[]> {
    const rows = await this.db.incidentEvent.findMany({
      where: { tenantId, incidentId },
      orderBy: { at: "asc" },
    });
    return rows.map(toIncidentEventRecord);
  }

  /** Every listed incident's timeline in one query, grouped in memory. */
  async listEventPages(tenantId: string, incidentIds: readonly string[]): Promise<Map<string, IncidentEvent[]>> {
    const pages = new Map<string, IncidentEvent[]>(incidentIds.map((id) => [id, []]));
    if (incidentIds.length === 0) return pages;

    const rows = await this.db.incidentEvent.findMany({
      where: { tenantId, incidentId: { in: [...incidentIds] } },
      orderBy: { at: "asc" },
    });
    for (const row of rows) pages.get(row.incidentId)?.push(toIncidentEventRecord(row));
    return pages;
  }
}
