/**
 * Prisma adapter (S4): the concrete side of the mute.
 *
 * The same shape as the other adapters in the family. One thing is worth reading before the
 * code: **the matcher is read defensively.** A row written by an older build, or edited by
 * hand, yields the dimensions it actually names rather than a crash in the middle of
 * ingestion — the pipeline asks this store a question on every batch, and a store that threw
 * on one damaged rule would take detection down with it. What it does *not* repair is a
 * matcher with no dimensions at all: `normalizeMatcher` returns it empty, and the rules module
 * refuses to match it, so a damaged mute goes quiet rather than silencing everything.
 */

import {
  normalizeMatcher,
  type SuppressionMatcher,
  type SuppressionRule,
} from "./alert-suppression-rules";
import { isUniqueViolation } from "./alert-store-prisma";
import type { SuppressionStore } from "./alert-suppression-service";

/* -------------------------------------------------------------------------- */
/*  Row shape                                                                 */
/* -------------------------------------------------------------------------- */

export interface AlertSuppressionRow {
  id: string;
  organizationId: string;
  name: string;
  matcher: unknown;
  startsAt: Date | string;
  endsAt: Date | string;
  createdById: string;
  createdByLabel: string;
  createdAt: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** The matcher a row carries, narrowed to the dimensions it names. */
export function matcherOf(value: unknown): SuppressionMatcher {
  const source = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const list = (key: string): string[] =>
    Array.isArray(source[key])
      ? (source[key] as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [];
  return normalizeMatcher({
    ruleIds: list("ruleIds"),
    sourceAddresses: list("sourceAddresses"),
    assets: list("assets"),
    devices: list("devices"),
    identityIds: list("identityIds"),
  });
}

export function toSuppressionRule(row: AlertSuppressionRow): SuppressionRule {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    matcher: matcherOf(row.matcher),
    startsAt: toIso(row.startsAt),
    endsAt: toIso(row.endsAt),
    createdById: row.createdById,
    createdByLabel: row.createdByLabel,
    createdAt: toIso(row.createdAt),
  };
}

export function toSuppressionRow(rule: SuppressionRule) {
  return {
    id: rule.id,
    organizationId: rule.organizationId,
    name: rule.name,
    matcher: rule.matcher,
    startsAt: new Date(rule.startsAt),
    endsAt: new Date(rule.endsAt),
    createdById: rule.createdById,
    createdByLabel: rule.createdByLabel,
  };
}

/* -------------------------------------------------------------------------- */
/*  The structural Prisma surface                                             */
/* -------------------------------------------------------------------------- */

/**
 * The delegate this store uses, declared structurally.
 *
 * The same choice every other adapter makes: this file needs four methods, not a generated
 * client, and a store that names only what it uses cannot be broken by a schema change
 * somewhere else.
 */
export interface AlertSuppressionPrismaClient {
  alertSuppression: {
    create(args: { data: unknown }): Promise<unknown>;
    findFirst(args: unknown): Promise<AlertSuppressionRow | null>;
    findMany(args: unknown): Promise<AlertSuppressionRow[]>;
    delete(args: { where: unknown }): Promise<unknown>;
  };
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

export class PrismaSuppressionStore implements SuppressionStore {
  constructor(private readonly db: AlertSuppressionPrismaClient) {}

  /**
   * Insert a mute. A re-insert of an id that exists is a no-op rather than an error: the id
   * is chosen by the service, so "this already exists" is a fact about a retried request and
   * not a fault.
   */
  async saveRule(rule: SuppressionRule): Promise<void> {
    try {
      await this.db.alertSuppression.create({ data: toSuppressionRow(rule) });
    } catch (error) {
      // The id is the service's, so the same rule arriving twice is a retried request rather
      // than a second mute — and a second honest write of an identical row would be harmless
      // anyway. Any other failure is the database's and is re-thrown.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  async listRules(organizationId: string): Promise<SuppressionRule[]> {
    const rows = await this.db.alertSuppression.findMany({
      where: { organizationId },
      orderBy: { startsAt: "asc" },
    });
    return rows.map(toSuppressionRule);
  }

  async findRule(organizationId: string, ruleId: string): Promise<SuppressionRule | null> {
    const row = await this.db.alertSuppression.findFirst({ where: { organizationId, id: ruleId } });
    return row ? toSuppressionRule(row) : null;
  }

  async removeRule(organizationId: string, ruleId: string): Promise<void> {
    await this.db.alertSuppression.delete({ where: { id: ruleId } });
  }
}
