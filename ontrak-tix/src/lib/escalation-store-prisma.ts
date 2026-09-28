/**
 * Prisma adapter for the SLA escalation store (M1).
 *
 * `kind` and `audience` are plain strings in the row (a Prisma enum each would
 * buy little) and are narrowed to the domain unions on the way out. Structural,
 * like the other adapters.
 */

import type { EscalationAudience } from "./escalation-rules";
import type { EscalationStore, SlaEscalationRecord } from "./escalation-service";

export interface SlaEscalationRow {
  id: string;
  tenantId: string;
  ticketId: string;
  ticketRef: string;
  kind: string;
  level: number;
  audience: string;
  label: string;
  reason: string;
  dedupeKey: string;
  raisedAt: Date;
  acknowledgedAt: Date | null;
}

export interface EscalationPrismaClient {
  slaEscalation: {
    findMany(args: unknown): Promise<SlaEscalationRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toAudience(value: string): EscalationAudience {
  return value === "MANAGER" || value === "DISPATCHER" ? value : "AGENT";
}

export function toEscalationRecord(row: SlaEscalationRow): SlaEscalationRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ticketId: row.ticketId,
    ticketRef: row.ticketRef,
    kind: row.kind === "resolution" ? "resolution" : "response",
    level: row.level,
    audience: toAudience(row.audience),
    label: row.label,
    reason: row.reason,
    dedupeKey: row.dedupeKey,
    raisedAt: toIso(row.raisedAt),
    acknowledgedAt: row.acknowledgedAt === null ? null : toIso(row.acknowledgedAt),
  };
}

export function toEscalationData(record: SlaEscalationRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    ticketId: record.ticketId,
    ticketRef: record.ticketRef,
    kind: record.kind,
    level: record.level,
    audience: record.audience,
    label: record.label,
    reason: record.reason,
    dedupeKey: record.dedupeKey,
    raisedAt: new Date(record.raisedAt),
    acknowledgedAt: record.acknowledgedAt === null ? null : new Date(record.acknowledgedAt),
  };
}

export class PrismaEscalationStore implements EscalationStore {
  constructor(private readonly db: EscalationPrismaClient) {}

  async raisedKeys(tenantId: string): Promise<Set<string>> {
    const rows = await this.db.slaEscalation.findMany({ where: { tenantId }, select: { dedupeKey: true } });
    return new Set(rows.map((row) => row.dedupeKey));
  }

  async record(record: SlaEscalationRecord): Promise<void> {
    await this.db.slaEscalation.create({ data: toEscalationData(record) });
  }

  async listForTenant(tenantId: string): Promise<SlaEscalationRecord[]> {
    const rows = await this.db.slaEscalation.findMany({
      where: { tenantId },
      orderBy: { raisedAt: "desc" },
    });
    return rows.map(toEscalationRecord);
  }
}
