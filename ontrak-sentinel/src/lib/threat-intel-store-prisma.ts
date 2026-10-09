/**
 * Prisma adapter (S3): the concrete side of the `IndicatorStore` port.
 *
 * The same shape as every other adapter in the family — a structural client naming only the
 * delegates it needs, so it typechecks and runs against a fake — with one difference worth
 * reading before the code: **`upsertIndicator` is a conditional write whose losing branch is
 * an UPDATE, and the update keeps `firstSeenAt`.** The id is derived from the kind and the
 * canonical value rather than generated, so a feed polled hourly is a table that reflects the
 * feed instead of one that grows by the feed's size every hour. What a re-send is *entitled*
 * to change is the confidence, the labels and the expiry — that is the feed revising its own
 * opinion — while "how long have we been watching this?" survives the poll, because an
 * enrichment whose age resets every hour is one nobody can reason about afterwards.
 *
 * The row mapper does not trust the row. A `kind` this build cannot express is not repaired
 * into the nearest one it knows: a mis-typed indicator would match nothing at best and the
 * wrong observable at worst, so the row is left out of the list the matcher walks rather than
 * guessed at. `value` and `wildcard` come from the columns the matcher reads, so a row whose
 * text no longer parses under its own kind is still compared as the bytes the database holds
 * — which is what makes the stored indicator the one that was stored.
 */

import type { Severity } from "./detection-rules";
import { isUniqueViolation } from "./alert-store-prisma";
import { INDICATOR_KINDS, type IndicatorKind } from "./threat-intel-rules";
import type { IndicatorStore, StoredIndicator } from "./threat-intel-service";

/* -------------------------------------------------------------------------- */
/*  Row shape                                                                 */
/* -------------------------------------------------------------------------- */

export interface IndicatorRow {
  id: string;
  organizationId: string;
  kind: string;
  value: string;
  wildcard: boolean;
  source: string;
  confidence: number;
  severity: string | null;
  /**
   * Prisma returns `[]` for a scalar list column, but the column itself is nullable —
   * Postgres lists are — so a row written by something other than this adapter can read
   * back as `null`. Typed to admit it rather than assumed away at the boundary.
   */
  labels: string[] | null;
  firstSeenAt: Date;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/* -------------------------------------------------------------------------- */
/*  Mappers (pure)                                                            */
/* -------------------------------------------------------------------------- */

const SEVERITIES: readonly string[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

/**
 * A row → an indicator, or `null` when this build cannot express it.
 *
 * `null` rather than a coerced kind, and rather than a throw: one unreadable row must not
 * take out the whole list an alert is enriched from, and the matcher must not be handed an
 * indicator it will compare wrongly.
 */
export function toStoredIndicator(row: IndicatorRow): StoredIndicator | null {
  if (!(INDICATOR_KINDS as readonly string[]).includes(row.kind)) return null;
  const severity =
    typeof row.severity === "string" && SEVERITIES.includes(row.severity) ? (row.severity as Severity) : null;

  return {
    id: row.id,
    organizationId: row.organizationId,
    kind: row.kind as IndicatorKind,
    value: row.value,
    wildcard: row.wildcard === true,
    source: row.source,
    confidence: row.confidence,
    severity,
    labels: row.labels ?? [],
    // Epoch milliseconds, as the domain record holds them. `DateTime` is the database's
    // spelling of an instant, not the pipeline's.
    firstSeenAt: row.firstSeenAt.getTime(),
    expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
  };
}

export function toIndicatorData(record: StoredIndicator) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    kind: record.kind,
    value: record.value,
    wildcard: record.wildcard,
    source: record.source,
    confidence: record.confidence,
    severity: record.severity,
    labels: [...record.labels],
    firstSeenAt: new Date(record.firstSeenAt),
    expiresAt: record.expiresAt === null ? null : new Date(record.expiresAt),
    updatedAt: new Date(),
  };
}

/* -------------------------------------------------------------------------- */
/*  The structural Prisma surface                                             */
/* -------------------------------------------------------------------------- */

export interface IndicatorPrismaClient {
  indicator: {
    create(args: { data: unknown }): Promise<unknown>;
    findFirst(args: unknown): Promise<IndicatorRow | null>;
    findMany(args: unknown): Promise<IndicatorRow[]>;
    /**
     * `updateMany` / `deleteMany` rather than `update` / `delete`.
     *
     * The primary key is composite, and Prisma spells a compound key
     * `organizationId_id` — a name generated from the schema rather than declared in it.
     * Reaching for it would make this adapter depend on a client detail, so the write names
     * the two columns it means instead, which is the same `where` either way.
     */
    updateMany(args: { where: unknown; data: unknown }): Promise<{ count: number }>;
    deleteMany(args: { where: unknown }): Promise<{ count: number }>;
  };
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

export class PrismaIndicatorStore implements IndicatorStore {
  constructor(private readonly db: IndicatorPrismaClient) {}

  /**
   * Insert, or report the row that already owns this key — and refresh it.
   *
   * The insert is attempted first and its unique violation is expected: that is what makes
   * two workers ingesting overlapping feeds produce one row rather than a lost write or a
   * constraint error the caller has to interpret. The losing branch must *write*, unlike the
   * alert store's read-only one, because a feed's whole point is that it revises its rows.
   */
  async upsertIndicator(record: StoredIndicator): Promise<{ indicator: StoredIndicator; created: boolean }> {
    try {
      await this.db.indicator.create({ data: toIndicatorData(record) });
      return { indicator: record, created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.db.indicator.findFirst({
        where: { organizationId: record.organizationId, id: record.id },
      });
      if (!existing) throw error;
      // `firstSeenAt` comes from the row, everything else from the feed's new opinion.
      const merged: StoredIndicator = {
        ...record,
        firstSeenAt: toStoredIndicator(existing)?.firstSeenAt ?? record.firstSeenAt,
      };
      await this.db.indicator.updateMany({
        where: { organizationId: record.organizationId, id: record.id },
        data: toIndicatorData(merged),
      });
      return { indicator: merged, created: false };
    }
  }

  async listIndicators(organizationId: string): Promise<StoredIndicator[]> {
    const rows = await this.db.indicator.findMany({
      where: { organizationId },
      orderBy: [{ kind: "asc" }, { value: "asc" }],
    });
    return rows
      .map(toStoredIndicator)
      .filter((indicator): indicator is StoredIndicator => indicator !== null);
  }

  async findIndicator(organizationId: string, indicatorId: string): Promise<StoredIndicator | null> {
    const row = await this.db.indicator.findFirst({ where: { organizationId, id: indicatorId } });
    return row ? toStoredIndicator(row) : null;
  }

  /**
   * The sweep's query: expired, still present, in every organization.
   *
   * Narrowed in the database rather than by reading every indicator back and filtering in
   * the service, for the reason the enforcement store gives about its own sweep: this runs
   * on a timer and reads across tenants, so it must not be a query that grows with the size
   * of the feeds. An indicator with no expiry has a `null` deadline and the `lte`
   * comparison never matches it.
   */
  async expiredBefore(atMs: number): Promise<StoredIndicator[]> {
    const rows = await this.db.indicator.findMany({
      where: { expiresAt: { not: null, lte: new Date(atMs) } },
    });
    return rows
      .map(toStoredIndicator)
      .filter((indicator): indicator is StoredIndicator => indicator !== null);
  }

  async deleteIndicator(organizationId: string, indicatorId: string): Promise<void> {
    await this.db.indicator.deleteMany({ where: { organizationId, id: indicatorId } });
  }
}