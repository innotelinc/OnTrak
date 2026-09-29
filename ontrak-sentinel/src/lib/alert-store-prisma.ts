/**
 * Prisma adapters (S3): the concrete side of the `AlertStore` port.
 *
 * The same shape as every other adapter in the family. One thing here is different from the
 * others and worth reading before the code: **`upsertAlert` is a conditional write, not a
 * read-then-write.** Ingestion is concurrent by nature — two sensors can report the same
 * connection in the same millisecond — so the store lets the database's unique key decide
 * who wins and treats the loser as an update. A read-then-write would have both calls read
 * "no alert", both insert, and one would fail with a constraint error that the pipeline
 * would have to guess about; worse, a naive "insert if not found" that swallowed the error
 * would *lose* the second sensor's observation.
 *
 * The evidence is JSON and the mapper does not trust it: a row written by an older version
 * (or edited by hand) yields no evidence rather than a crash mid-triage.
 */

import type { AlertRecord, AlertState, AlertStore } from "./detection-service";
import type { Severity } from "./detection-rules";
import type { ObservedEvent } from "./telemetry-rules";

/* -------------------------------------------------------------------------- */
/*  Row shape                                                                 */
/* -------------------------------------------------------------------------- */

export interface AlertRow {
  id: string;
  organizationId: string;
  ruleId: string;
  ruleVersion: number;
  ruleName: string;
  severity: string;
  state: string;
  dedupeKey: string;
  groupKey: string;
  sourceAddress: string | null;
  identityId: string | null;
  identityLabel: string | null;
  device: string | null;
  asset: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  occurrences: number;
  evidence: unknown;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/* -------------------------------------------------------------------------- */
/*  Mappers (pure)                                                            */
/* -------------------------------------------------------------------------- */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Evidence that is not the shape we wrote is dropped, not coerced into it. */
function evidenceOf(value: unknown): ObservedEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ObservedEvent => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Partial<ObservedEvent>;
    return typeof candidate.at === "number" && typeof candidate.kind === "string" && typeof candidate.source === "string";
  });
}

const STATES: readonly string[] = ["NEW", "ACKNOWLEDGED", "CLOSED"];
const SEVERITIES: readonly string[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export function toAlertRecord(row: AlertRow): AlertRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    ruleId: row.ruleId,
    ruleVersion: row.ruleVersion,
    ruleName: row.ruleName,
    severity: (SEVERITIES.includes(row.severity) ? row.severity : "MEDIUM") as Severity,
    state: (STATES.includes(row.state) ? row.state : "NEW") as AlertState,
    dedupeKey: row.dedupeKey,
    groupKey: row.groupKey,
    sourceAddress: row.sourceAddress,
    identityId: row.identityId,
    identityLabel: row.identityLabel,
    device: row.device,
    asset: row.asset,
    firstSeenAt: toIso(row.firstSeenAt),
    lastSeenAt: toIso(row.lastSeenAt),
    occurrences: row.occurrences,
    evidence: evidenceOf(row.evidence),
    note: row.note,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toAlertCreate(record: AlertRecord) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    ruleId: record.ruleId,
    ruleVersion: record.ruleVersion,
    ruleName: record.ruleName,
    severity: record.severity,
    state: record.state,
    dedupeKey: record.dedupeKey,
    groupKey: record.groupKey,
    sourceAddress: record.sourceAddress,
    identityId: record.identityId,
    identityLabel: record.identityLabel,
    device: record.device,
    asset: record.asset,
    firstSeenAt: new Date(record.firstSeenAt),
    lastSeenAt: new Date(record.lastSeenAt),
    occurrences: record.occurrences,
    evidence: record.evidence,
    note: record.note,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

/** The mutable half. What fired, and about whom, is what the alert *is*. */
export function toAlertUpdate(record: AlertRecord) {
  return {
    state: record.state,
    lastSeenAt: new Date(record.lastSeenAt),
    occurrences: record.occurrences,
    identityId: record.identityId,
    identityLabel: record.identityLabel,
    device: record.device,
    asset: record.asset,
    evidence: record.evidence,
    note: record.note,
    updatedAt: new Date(record.updatedAt),
  };
}

/* -------------------------------------------------------------------------- */
/*  The structural Prisma surface                                             */
/* -------------------------------------------------------------------------- */

export interface AlertPrismaClient {
  alert: {
    findMany(args: unknown): Promise<AlertRow[]>;
    findFirst(args: unknown): Promise<AlertRow | null>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
}

/** Prisma's unique-constraint code, matched structurally so no client import is needed. */
function isUniqueViolation(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "P2002";
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

export class PrismaAlertStore implements AlertStore {
  constructor(private readonly db: AlertPrismaClient) {}

  /**
   * Insert, or report the row that already owns this key.
   *
   * The insert is attempted first and its unique violation is *expected*, not exceptional:
   * that is what makes two concurrent ingests produce one alert and one update instead of
   * one alert and one lost observation.
   */
  async upsertAlert(record: AlertRecord): Promise<{ alert: AlertRecord; created: boolean }> {
    try {
      await this.db.alert.create({ data: toAlertCreate(record) });
      return { alert: record, created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.db.alert.findFirst({
        where: { organizationId: record.organizationId, dedupeKey: record.dedupeKey },
      });
      if (!existing) throw error;
      return { alert: toAlertRecord(existing), created: false };
    }
  }

  async findAlert(organizationId: string, alertId: string): Promise<AlertRecord | null> {
    const row = await this.db.alert.findFirst({ where: { organizationId, id: alertId } });
    return row ? toAlertRecord(row) : null;
  }

  async listAlerts(organizationId: string): Promise<AlertRecord[]> {
    const rows = await this.db.alert.findMany({
      where: { organizationId },
      orderBy: { lastSeenAt: "desc" },
    });
    return rows.map(toAlertRecord);
  }

  async updateAlert(record: AlertRecord): Promise<void> {
    await this.db.alert.update({ where: { id: record.id, organizationId: record.organizationId }, data: toAlertUpdate(record) });
  }
}
