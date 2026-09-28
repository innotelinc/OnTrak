/**
 * Prisma adapter for a tenant's own incident notification drafts (M3).
 *
 * The port it implements (`CommsTemplateStore`, in `comms-template-service.ts`)
 * speaks the domain record, not rows — the same split the other adapters use, so
 * the service is testable against a memory store and never sees a `Date`, a
 * nullable column or a `string` where a vocabulary belongs.
 *
 * `audience` is narrowed on the way out: a row written by a newer version says
 * something a reader can still act on (`STAFF`, the internal audience, which is
 * wrong-but-safe) rather than leaking a `string` into a notice. A retired draft
 * is kept rather than deleted, because a notice that cited it stays explainable.
 */

import { COMMS_AUDIENCES, type CommsAudience } from "./comms-rules";
import type { CommsTemplateRecord } from "./comms-template-service";

export interface CommsTemplateRow {
  id: string;
  tenantId: string;
  label: string;
  audience: string;
  regimes: string[];
  subject: string;
  body: string;
  guidance: string | null;
  retiredAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CommsTemplatePrismaClient {
  incidentCommsTemplate: {
    findFirst(args: unknown): Promise<CommsTemplateRow | null>;
    findMany(args: unknown): Promise<CommsTemplateRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

export function toCommsAudience(value: string): CommsAudience {
  return (COMMS_AUDIENCES as readonly string[]).includes(value) ? (value as CommsAudience) : "STAFF";
}

export function toCommsTemplateRecord(row: CommsTemplateRow): CommsTemplateRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    label: row.label,
    audience: toCommsAudience(row.audience),
    regimes: [...row.regimes],
    subject: row.subject,
    body: row.body,
    guidance: row.guidance,
    retiredAt: toIsoOrNull(row.retiredAt),
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toCommsTemplateData(record: CommsTemplateRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    label: record.label,
    audience: record.audience,
    regimes: [...record.regimes],
    subject: record.subject,
    body: record.body,
    guidance: record.guidance,
    retiredAt: record.retiredAt === null ? null : new Date(record.retiredAt),
    createdBy: record.createdBy,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

export class PrismaCommsTemplateStore {
  constructor(private readonly db: CommsTemplatePrismaClient) {}

  async listForTenant(tenantId: string, options: { includeRetired?: boolean } = {}): Promise<CommsTemplateRecord[]> {
    const rows = await this.db.incidentCommsTemplate.findMany({
      where: options.includeRetired ? { tenantId } : { tenantId, retiredAt: null },
      orderBy: { label: "asc" },
    });
    return rows.map(toCommsTemplateRecord);
  }

  async find(tenantId: string, id: string): Promise<CommsTemplateRecord | null> {
    const row = await this.db.incidentCommsTemplate.findFirst({ where: { tenantId, id } });
    return row ? toCommsTemplateRecord(row) : null;
  }

  async findByLabel(tenantId: string, label: string): Promise<CommsTemplateRecord | null> {
    const row = await this.db.incidentCommsTemplate.findFirst({ where: { tenantId, label } });
    return row ? toCommsTemplateRecord(row) : null;
  }

  async insert(record: CommsTemplateRecord): Promise<void> {
    await this.db.incidentCommsTemplate.create({ data: toCommsTemplateData(record) });
  }

  async update(record: CommsTemplateRecord): Promise<void> {
    await this.db.incidentCommsTemplate.update({
      where: { id: record.id, tenantId: record.tenantId },
      data: toCommsTemplateData(record),
    });
  }
}
