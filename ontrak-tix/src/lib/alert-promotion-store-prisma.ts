/**
 * Prisma adapter for the alert-promotion store (M2).
 *
 * Three small tables — verdicts, suppression rules and promotion decisions —
 * share one adapter because they are read together for every decision. The
 * `verdict`, `field` and `decision` columns are plain strings, narrowed to the
 * domain unions on the way out so a value that predates a vocabulary change
 * degrades instead of leaking `string` into the rules. Structural, like the
 * other adapters — the tests use a fake.
 */

import type {
  AlertVerdict,
  StoredSuppressionRule,
  SuppressionField,
  VerdictKind,
} from "./alert-promotion-rules";
import type { PromotionRecord, PromotionStore } from "./alert-promotion-service";

export interface AlertVerdictRow {
  id: string;
  tenantId: string;
  signature: string;
  verdict: string;
  note: string | null;
  by: string | null;
  at: Date;
}

export interface AlertSuppressionRow {
  id: string;
  tenantId: string;
  field: string;
  match: string;
  reason: string;
  until: Date | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface AlertPromotionRow {
  id: string;
  tenantId: string;
  alertId: string;
  decision: string;
  reason: string;
  ticketId: string | null;
  ticketRef: string | null;
  at: Date;
}

export interface AlertPromotionPrismaClient {
  alertVerdict: {
    findMany(args: unknown): Promise<AlertVerdictRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
  };
  alertSuppression: {
    findMany(args: unknown): Promise<AlertSuppressionRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
  };
  alertPromotion: {
    findMany(args: unknown): Promise<AlertPromotionRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toVerdict(value: string): VerdictKind {
  return value === "FALSE_POSITIVE" || value === "BENIGN" ? value : "TRUE_POSITIVE";
}

function toField(value: string): SuppressionField {
  return value === "asset" || value === "identity" || value === "source" ? value : "signature";
}

export function toVerdictRecord(row: AlertVerdictRow): AlertVerdict {
  return {
    id: row.id,
    tenantId: row.tenantId,
    signature: row.signature,
    verdict: toVerdict(row.verdict),
    note: row.note,
    by: row.by,
    at: toIso(row.at),
  };
}

export function toVerdictData(verdict: AlertVerdict) {
  return {
    id: verdict.id,
    tenantId: verdict.tenantId,
    signature: verdict.signature,
    verdict: verdict.verdict,
    note: verdict.note ?? null,
    by: verdict.by ?? null,
    at: new Date(verdict.at),
  };
}

export function toSuppressionRecord(row: AlertSuppressionRow): StoredSuppressionRule {
  return {
    id: row.id,
    tenantId: row.tenantId,
    field: toField(row.field),
    match: row.match,
    reason: row.reason,
    until: row.until === null ? null : toIso(row.until),
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
  };
}

export function toSuppressionData(rule: StoredSuppressionRule) {
  return {
    id: rule.id,
    tenantId: rule.tenantId,
    field: rule.field,
    match: rule.match,
    reason: rule.reason,
    until: rule.until ? new Date(rule.until) : null,
    createdBy: rule.createdBy ?? null,
    createdAt: new Date(rule.createdAt),
  };
}

export function toPromotionRecord(row: AlertPromotionRow): PromotionRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    alertId: row.alertId,
    decision: row.decision === "PROMOTE" ? "PROMOTE" : "SUPPRESS",
    reason: row.reason,
    ticketId: row.ticketId,
    ticketRef: row.ticketRef,
    at: toIso(row.at),
  };
}

export function toPromotionData(record: PromotionRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    alertId: record.alertId,
    decision: record.decision,
    reason: record.reason,
    ticketId: record.ticketId,
    ticketRef: record.ticketRef,
    at: new Date(record.at),
  };
}

export class PrismaPromotionStore implements PromotionStore {
  constructor(private readonly db: AlertPromotionPrismaClient) {}

  async listVerdicts(tenantId: string): Promise<AlertVerdict[]> {
    const rows = await this.db.alertVerdict.findMany({ where: { tenantId }, orderBy: { at: "desc" } });
    return rows.map(toVerdictRecord);
  }

  async recordVerdict(verdict: AlertVerdict): Promise<void> {
    await this.db.alertVerdict.create({ data: toVerdictData(verdict) });
  }

  async listSuppressions(tenantId: string): Promise<StoredSuppressionRule[]> {
    const rows = await this.db.alertSuppression.findMany({ where: { tenantId } });
    return rows.map(toSuppressionRecord);
  }

  async recordSuppression(rule: StoredSuppressionRule): Promise<void> {
    await this.db.alertSuppression.create({ data: toSuppressionData(rule) });
  }

  async recordPromotion(record: PromotionRecord): Promise<void> {
    await this.db.alertPromotion.create({ data: toPromotionData(record) });
  }

  async listPromotions(tenantId: string): Promise<PromotionRecord[]> {
    const rows = await this.db.alertPromotion.findMany({ where: { tenantId }, orderBy: { at: "desc" } });
    return rows.map(toPromotionRecord);
  }
}
