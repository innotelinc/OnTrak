/**
 * Prisma adapter for the security-alert store (M2).
 *
 * The source/severity columns are Prisma enums, but the domain unions stay the
 * source of truth: rows are narrowed on the way out, so a value that predates a
 * vocabulary change degrades to a safe default instead of leaking `string` into
 * the service. Structural, like the other adapters — the tests use a fake.
 */

import {
  SECURITY_SEVERITIES,
  SECURITY_SOURCES,
  type AssetCriticality,
  type SecuritySeverity,
  type SecuritySource,
} from "./security-alert-rules";
import type { SecurityAlertRecord, SecurityAlertStore } from "./security-alert-service";

export interface SecurityAlertRow {
  id: string;
  tenantId: string;
  source: string;
  severity: string;
  triageSeverity: string;
  signature: string;
  description: string;
  externalId: string | null;
  asset: string | null;
  assetKnown: boolean;
  assetOwner: string | null;
  assetCriticality: string | null;
  clientId: string | null;
  identity: string | null;
  identityKnown: boolean;
  identityName: string | null;
  identityPrivileged: boolean;
  sourceIp: string | null;
  rawRef: string | null;
  dedupeKey: string;
  occurredAt: Date;
  firstSeenAt: Date;
  lastSeenAt: Date;
  occurrences: number;
  ticketId: string | null;
}

export interface SecurityAlertPrismaClient {
  securityAlert: {
    findFirst(args: unknown): Promise<SecurityAlertRow | null>;
    findMany(args: unknown): Promise<SecurityAlertRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toSource(value: string): SecuritySource {
  return (SECURITY_SOURCES as readonly string[]).includes(value) ? (value as SecuritySource) : "SIEM";
}

function toSeverity(value: string): SecuritySeverity {
  return (SECURITY_SEVERITIES as readonly string[]).includes(value) ? (value as SecuritySeverity) : "MEDIUM";
}

function toCriticality(value: string | null): AssetCriticality | null {
  return value === "LOW" || value === "NORMAL" || value === "HIGH" || value === "CRITICAL" ? value : null;
}

export function toSecurityAlertRecord(row: SecurityAlertRow): SecurityAlertRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    source: toSource(row.source),
    severity: toSeverity(row.severity),
    triageSeverity: toSeverity(row.triageSeverity),
    signature: row.signature,
    description: row.description,
    externalId: row.externalId,
    asset: row.asset,
    assetKnown: row.assetKnown,
    assetOwner: row.assetOwner,
    assetCriticality: toCriticality(row.assetCriticality),
    clientId: row.clientId,
    identity: row.identity,
    identityKnown: row.identityKnown,
    identityName: row.identityName,
    identityPrivileged: row.identityPrivileged,
    sourceIp: row.sourceIp,
    rawRef: row.rawRef,
    dedupeKey: row.dedupeKey,
    occurredAt: toIso(row.occurredAt),
    firstSeenAt: toIso(row.firstSeenAt),
    lastSeenAt: toIso(row.lastSeenAt),
    occurrences: row.occurrences,
    ticketId: row.ticketId,
  };
}

export function toSecurityAlertData(record: SecurityAlertRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    source: record.source,
    severity: record.severity,
    triageSeverity: record.triageSeverity,
    signature: record.signature,
    description: record.description,
    externalId: record.externalId,
    asset: record.asset,
    assetKnown: record.assetKnown,
    assetOwner: record.assetOwner,
    assetCriticality: record.assetCriticality,
    clientId: record.clientId,
    identity: record.identity,
    identityKnown: record.identityKnown,
    identityName: record.identityName,
    identityPrivileged: record.identityPrivileged,
    sourceIp: record.sourceIp,
    rawRef: record.rawRef,
    dedupeKey: record.dedupeKey,
    occurredAt: new Date(record.occurredAt),
    firstSeenAt: new Date(record.firstSeenAt),
    lastSeenAt: new Date(record.lastSeenAt),
    occurrences: record.occurrences,
    ticketId: record.ticketId,
  };
}

export class PrismaSecurityAlertStore implements SecurityAlertStore {
  constructor(private readonly db: SecurityAlertPrismaClient) {}

  async findById(tenantId: string, alertId: string): Promise<SecurityAlertRecord | null> {
    const row = await this.db.securityAlert.findFirst({ where: { tenantId, id: alertId } });
    return row ? toSecurityAlertRecord(row) : null;
  }

  async findByDedupeKey(tenantId: string, dedupeKey: string): Promise<SecurityAlertRecord | null> {
    const row = await this.db.securityAlert.findFirst({ where: { tenantId, dedupeKey } });
    return row ? toSecurityAlertRecord(row) : null;
  }

  async insert(record: SecurityAlertRecord): Promise<void> {
    await this.db.securityAlert.create({ data: toSecurityAlertData(record) });
  }

  async update(record: SecurityAlertRecord): Promise<void> {
    await this.db.securityAlert.update({ where: { id: record.id }, data: toSecurityAlertData(record) });
  }

  async list(tenantId: string): Promise<SecurityAlertRecord[]> {
    const rows = await this.db.securityAlert.findMany({
      where: { tenantId },
      orderBy: { lastSeenAt: "desc" },
    });
    return rows.map(toSecurityAlertRecord);
  }
}
