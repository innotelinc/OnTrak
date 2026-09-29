/**
 * Prisma adapter for the RMM alert links (M6).
 *
 * The same split as every other adapter here: the port speaks domain records with
 * ISO strings, this file owns the row and the `Date` conversion, and nothing here
 * decides anything. `state` and `severity` are plain strings in the database,
 * narrowed to the domain unions on the way out, so a row written before a
 * vocabulary change degrades into a known value instead of leaking `string` into
 * the rules.
 *
 * The narrowing direction matters and is deliberate in both cases:
 *
 *  - an unreadable `state` becomes `RESOLVED`, *not* `OPEN`. Mistaking a condition
 *    for closed means a later failure opens a second ticket for work already in
 *    hand, which a person notices; mistaking it for open means a recovery closes a
 *    ticket nobody opened, which nobody notices.
 *  - an unreadable `severity` becomes `WARNING`, the same default the payload
 *    parser uses, for the same reason: being wrong downward is how an outage is
 *    filed as noise.
 */

import type { RmmAlertState, RmmLinkRecord, RmmSeverity } from "./rmm-rules";
import type { RmmStore } from "./rmm-service";

export interface RmmAlertLinkRow {
  id: string;
  tenantId: string;
  dedupeKey: string;
  source: string;
  host: string;
  check: string;
  state: string;
  severity: string;
  externalId: string;
  ticketId: string;
  ticketRef: string;
  lastSummary: string;
  openedAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  occurrences: number;
  reopenCount: number;
}

export interface RmmPrismaClient {
  rmmAlertLink: {
    create(args: { data: unknown }): Promise<unknown>;
    findUnique(args: { where: unknown }): Promise<RmmAlertLinkRow | null>;
    findMany(args: unknown): Promise<RmmAlertLinkRow[]>;
    update(args: { where: { id: string }; data: unknown }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function asRmmState(value: unknown): RmmAlertState {
  return value === "OPEN" ? "OPEN" : "RESOLVED";
}

export function asRmmSeverity(value: unknown): RmmSeverity {
  return value === "CRITICAL" || value === "INFO" ? value : "WARNING";
}

export function toRmmLinkRecord(row: RmmAlertLinkRow): RmmLinkRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    dedupeKey: row.dedupeKey,
    source: row.source,
    host: row.host,
    check: row.check,
    state: asRmmState(row.state),
    severity: asRmmSeverity(row.severity),
    externalId: row.externalId,
    ticketId: row.ticketId,
    ticketRef: row.ticketRef,
    lastSummary: row.lastSummary,
    openedAt: toIso(row.openedAt),
    lastSeenAt: toIso(row.lastSeenAt),
    resolvedAt: row.resolvedAt === null ? null : toIso(row.resolvedAt),
    occurrences: row.occurrences,
    reopenCount: row.reopenCount,
  };
}

/** The columns a create needs. Pure, so it is testable on its own. */
export function toRmmLinkCreate(record: RmmLinkRecord): Record<string, unknown> {
  return {
    id: record.id,
    tenantId: record.tenantId,
    dedupeKey: record.dedupeKey,
    source: record.source,
    host: record.host,
    check: record.check,
    state: record.state,
    severity: record.severity,
    externalId: record.externalId,
    ticketId: record.ticketId,
    ticketRef: record.ticketRef,
    lastSummary: record.lastSummary,
    openedAt: new Date(record.openedAt),
    lastSeenAt: new Date(record.lastSeenAt),
    resolvedAt: record.resolvedAt === null ? null : new Date(record.resolvedAt),
    occurrences: record.occurrences,
    reopenCount: record.reopenCount,
  };
}

/**
 * The columns a change may touch.
 *
 * `dedupeKey`, `source`, `host` and `check` are absent on purpose: they are the
 * condition's identity, and a condition does not become a different condition by
 * being updated. Everything else — including which ticket it points at — moves.
 */
export function toRmmLinkUpdate(record: RmmLinkRecord): Record<string, unknown> {
  return {
    state: record.state,
    severity: record.severity,
    externalId: record.externalId,
    ticketId: record.ticketId,
    ticketRef: record.ticketRef,
    lastSummary: record.lastSummary,
    openedAt: new Date(record.openedAt),
    lastSeenAt: new Date(record.lastSeenAt),
    resolvedAt: record.resolvedAt === null ? null : new Date(record.resolvedAt),
    occurrences: record.occurrences,
    reopenCount: record.reopenCount,
  };
}

export class PrismaRmmStore implements RmmStore {
  constructor(private readonly db: RmmPrismaClient) {}

  async findLink(tenantId: string, dedupeKey: string): Promise<RmmLinkRecord | null> {
    const row = await this.db.rmmAlertLink.findUnique({
      // The unique index is on the pair, which is also the scoping: a link in
      // another tenant is not "forbidden", it is absent.
      where: { tenantId_dedupeKey: { tenantId, dedupeKey } },
    });
    return row ? toRmmLinkRecord(row) : null;
  }

  async findLinkByTicket(tenantId: string, ticketId: string): Promise<RmmLinkRecord | null> {
    const rows = await this.db.rmmAlertLink.findMany({
      where: { tenantId, ticketId },
      orderBy: { lastSeenAt: "desc" },
      take: 1,
    });
    return rows[0] ? toRmmLinkRecord(rows[0]) : null;
  }

  async listLinks(tenantId: string): Promise<RmmLinkRecord[]> {
    const rows = await this.db.rmmAlertLink.findMany({ where: { tenantId }, orderBy: { lastSeenAt: "desc" } });
    return rows.map(toRmmLinkRecord);
  }

  async insertLink(record: RmmLinkRecord): Promise<void> {
    await this.db.rmmAlertLink.create({ data: toRmmLinkCreate(record) });
  }

  async updateLink(record: RmmLinkRecord): Promise<void> {
    await this.db.rmmAlertLink.update({ where: { id: record.id }, data: toRmmLinkUpdate(record) });
  }
}
