/**
 * Prisma adapter for connector installations (M6).
 *
 * The same split as every other adapter here: the port speaks domain records with
 * ISO strings and a `Record<string, string>` config, this file owns the row and the
 * `Date` conversion, and nothing here decides anything.
 *
 * The one deliberate narrowing is `asConfig`. Config is a `Json` column because the
 * set of keys belongs to a manifest that can change, so a row written before a
 * connector declared a new field must still read back. It is narrowed to strings on
 * the way out — a value that is not text is dropped rather than leaked into the
 * rules as an object — because the rules treat a missing key as "not set", which is
 * the safe reading of anything this adapter cannot make sense of.
 */

import type { ConnectorInstallationRecord } from "./connector-rules";
import type { ConnectorStore } from "./connector-service";

export interface ConnectorInstallationRow {
  id: string;
  tenantId: string;
  connectorId: string;
  config: unknown;
  enabled: boolean;
  installedBy: string;
  installedAt: Date;
  updatedAt: Date;
  disabledAt: Date | null;
}

export interface ConnectorPrismaClient {
  connectorInstallation: {
    create(args: { data: unknown }): Promise<unknown>;
    findUnique(args: { where: unknown }): Promise<ConnectorInstallationRow | null>;
    findMany(args: unknown): Promise<ConnectorInstallationRow[]>;
    update(args: { where: { id: string }; data: unknown }): Promise<unknown>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** The config as the rules see it: declared-looking keys with text values, or nothing. */
export function asConfig(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") out[key] = raw;
    else if (typeof raw === "number" || typeof raw === "boolean") out[key] = String(raw);
  }
  return out;
}

export function toConnectorRecord(row: ConnectorInstallationRow): ConnectorInstallationRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    connectorId: row.connectorId,
    config: asConfig(row.config),
    enabled: row.enabled,
    installedBy: row.installedBy,
    installedAt: toIso(row.installedAt),
    updatedAt: toIso(row.updatedAt),
    disabledAt: row.disabledAt === null ? null : toIso(row.disabledAt),
  };
}

/** The columns a create needs. Pure, so it is testable on its own. */
export function toConnectorCreate(record: ConnectorInstallationRecord): Record<string, unknown> {
  return {
    id: record.id,
    tenantId: record.tenantId,
    connectorId: record.connectorId,
    config: record.config,
    enabled: record.enabled,
    installedBy: record.installedBy,
    installedAt: new Date(record.installedAt),
    disabledAt: record.disabledAt === null ? null : new Date(record.disabledAt),
  };
}

/**
 * The columns a change may touch.
 *
 * `connectorId` is absent on purpose: an installation is this desk's use of *that*
 * connector, and re-pointing one at another connector is a new installation, not an
 * edit — the config belongs to the connector it was written for.
 */
export function toConnectorUpdate(record: ConnectorInstallationRecord): Record<string, unknown> {
  return {
    config: record.config,
    enabled: record.enabled,
    disabledAt: record.disabledAt === null ? null : new Date(record.disabledAt),
  };
}

export class PrismaConnectorStore implements ConnectorStore {
  constructor(private readonly db: ConnectorPrismaClient) {}

  async find(tenantId: string, connectorId: string): Promise<ConnectorInstallationRecord | null> {
    const row = await this.db.connectorInstallation.findUnique({
      // The unique index is on the pair, which is also the scoping: an installation
      // in another tenant is not "forbidden", it is absent.
      where: { tenantId_connectorId: { tenantId, connectorId } },
    });
    return row ? toConnectorRecord(row) : null;
  }

  async findById(tenantId: string, id: string): Promise<ConnectorInstallationRecord | null> {
    const rows = await this.db.connectorInstallation.findMany({ where: { tenantId, id }, take: 1 });
    return rows[0] ? toConnectorRecord(rows[0]) : null;
  }

  async list(tenantId: string): Promise<ConnectorInstallationRecord[]> {
    const rows = await this.db.connectorInstallation.findMany({
      where: { tenantId },
      orderBy: { installedAt: "desc" },
    });
    return rows.map(toConnectorRecord);
  }

  async insert(record: ConnectorInstallationRecord): Promise<void> {
    await this.db.connectorInstallation.create({ data: toConnectorCreate(record) });
  }

  async update(record: ConnectorInstallationRecord): Promise<void> {
    await this.db.connectorInstallation.update({ where: { id: record.id }, data: toConnectorUpdate(record) });
  }

  async remove(tenantId: string, id: string): Promise<void> {
    // Scoped by tenant even though the id is unique: a delete that only trusts an id
    // is one a cross-tenant request could aim at a row it cannot read.
    const existing = await this.findById(tenantId, id);
    if (!existing) return;
    await this.db.connectorInstallation.delete({ where: { id } });
  }
}
