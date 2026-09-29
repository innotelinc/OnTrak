/**
 * Prisma adapters (S2): the concrete side of the directory `DirectoryStore` port.
 *
 * The same shape as every other adapter in the family, for the same reason: the Prisma
 * client is described **structurally** rather than imported from a generated one, so this
 * file typechecks and its tests run with no database and no generated client, and the
 * mappers are pure functions the tests can drive with real rows.
 *
 * Two things worth stating out loud:
 *
 *  - **The credential is never on the record.** `secret` is stored and read through its
 *    own two methods (`setSecret`, `findSecret`) and the mapper turns it into a boolean,
 *    so the object the console and the audit trail handle cannot carry a client secret.
 *    A column that rides along on every read ends up somewhere it should not.
 *  - **`settings` is JSON, and the mapper does not trust it.** A deployment that wrote a
 *    string where an object belongs gets an empty object rather than a crash mid-sync;
 *    the connection still appears in the console, which is where somebody can fix it.
 */

import type {
  DirectoryStore,
  DirectorySyncRunRecord,
} from "./directory-service";
import type {
  ConflictPolicy,
  DirectoryConnectionRecord,
  DirectoryPlan,
  DirectorySource,
} from "./directory-rules";
import type { IdentityRole } from "./identity-rules";

/* -------------------------------------------------------------------------- */
/*  Row shapes                                                                */
/* -------------------------------------------------------------------------- */

export interface DirectoryConnectionRow {
  id: string;
  organizationId: string;
  name: string;
  source: string;
  settings: unknown;
  secret: string | null;
  conflictPolicy: string;
  defaultRole: IdentityRole;
  lastSyncedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DirectorySyncRunRow {
  id: string;
  organizationId: string;
  connectionId: string;
  startedAt: Date;
  finishedAt: Date;
  status: string;
  counts: unknown;
  detail: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Mappers (pure)                                                            */
/* -------------------------------------------------------------------------- */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function settingsOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

const EMPTY_COUNTS: DirectoryPlan["counts"] = {
  created: 0,
  updated: 0,
  deactivated: 0,
  reactivated: 0,
  unchanged: 0,
  conflicts: 0,
};

function countsOf(value: unknown): DirectoryPlan["counts"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_COUNTS };
  const raw = value as Record<string, unknown>;
  const pick = (key: keyof DirectoryPlan["counts"]): number => (typeof raw[key] === "number" ? (raw[key] as number) : 0);
  return {
    created: pick("created"),
    updated: pick("updated"),
    deactivated: pick("deactivated"),
    reactivated: pick("reactivated"),
    unchanged: pick("unchanged"),
    conflicts: pick("conflicts"),
  };
}

export function toConnectionRecord(row: DirectoryConnectionRow): DirectoryConnectionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    source: row.source as DirectorySource,
    settings: settingsOf(row.settings),
    conflictPolicy: row.conflictPolicy as ConflictPolicy,
    defaultRole: row.defaultRole,
    lastSyncedAt: row.lastSyncedAt === null ? null : toIso(row.lastSyncedAt),
    hasSecret: row.secret !== null && row.secret.length > 0,
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toConnectionCreate(record: DirectoryConnectionRecord) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    name: record.name,
    source: record.source,
    settings: record.settings,
    conflictPolicy: record.conflictPolicy,
    defaultRole: record.defaultRole,
    lastSyncedAt: record.lastSyncedAt === null ? null : new Date(record.lastSyncedAt),
    createdBy: record.createdBy,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

/** The mutable half. An organization is never re-pointed, and neither is the creator. */
export function toConnectionUpdate(record: DirectoryConnectionRecord) {
  return {
    name: record.name,
    source: record.source,
    settings: record.settings,
    conflictPolicy: record.conflictPolicy,
    defaultRole: record.defaultRole,
    lastSyncedAt: record.lastSyncedAt === null ? null : new Date(record.lastSyncedAt),
    updatedAt: new Date(record.updatedAt),
  };
}

export function toRunRecord(row: DirectorySyncRunRow): DirectorySyncRunRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    connectionId: row.connectionId,
    startedAt: toIso(row.startedAt),
    finishedAt: toIso(row.finishedAt),
    status: row.status === "FAILED" ? "FAILED" : "COMPLETED",
    counts: countsOf(row.counts),
    detail: row.detail,
  };
}

export function toRunCreate(record: DirectorySyncRunRecord) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    connectionId: record.connectionId,
    startedAt: new Date(record.startedAt),
    finishedAt: new Date(record.finishedAt),
    status: record.status,
    counts: record.counts,
    detail: record.detail,
  };
}

/* -------------------------------------------------------------------------- */
/*  The structural Prisma surface                                             */
/* -------------------------------------------------------------------------- */

export interface DirectoryPrismaClient {
  directoryConnection: {
    findMany(args: unknown): Promise<DirectoryConnectionRow[]>;
    findFirst(args: unknown): Promise<DirectoryConnectionRow | null>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
    delete(args: { where: unknown }): Promise<unknown>;
  };
  directorySyncRun: {
    findMany(args: unknown): Promise<DirectorySyncRunRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
  };
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

export class PrismaDirectoryStore implements DirectoryStore {
  constructor(private readonly db: DirectoryPrismaClient) {}

  async listConnections(organizationId: string): Promise<DirectoryConnectionRecord[]> {
    const rows = await this.db.directoryConnection.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
    });
    return rows.map(toConnectionRecord);
  }

  /** A tenant-scoped read: another organization's connection is simply not there. */
  async findConnection(organizationId: string, connectionId: string): Promise<DirectoryConnectionRecord | null> {
    const row = await this.db.directoryConnection.findFirst({ where: { organizationId, id: connectionId } });
    return row ? toConnectionRecord(row) : null;
  }

  async insertConnection(record: DirectoryConnectionRecord): Promise<void> {
    await this.db.directoryConnection.create({ data: toConnectionCreate(record) });
  }

  async updateConnection(record: DirectoryConnectionRecord): Promise<void> {
    await this.db.directoryConnection.update({ where: { id: record.id }, data: toConnectionUpdate(record) });
  }

  async removeConnection(organizationId: string, connectionId: string): Promise<void> {
    // Scoped by organization as well as id, so a wrong id from another tenant is a
    // no-op rather than a delete.
    await this.db.directoryConnection.delete({ where: { id: connectionId, organizationId } });
  }

  async insertRun(record: DirectorySyncRunRecord): Promise<void> {
    await this.db.directorySyncRun.create({ data: toRunCreate(record) });
  }

  async listRuns(organizationId: string, connectionId?: string): Promise<DirectorySyncRunRecord[]> {
    const rows = await this.db.directorySyncRun.findMany({
      where: connectionId === undefined ? { organizationId } : { organizationId, connectionId },
      orderBy: { startedAt: "desc" },
    });
    return rows.map(toRunRecord);
  }

  /**
   * The credential, read on its own.
   *
   * `select` rather than a full row: the value is fetched for one call and should not be
   * sitting in a record that outlives it.
   */
  async findSecret(organizationId: string, connectionId: string): Promise<string | null> {
    const row = await this.db.directoryConnection.findFirst({
      where: { organizationId, id: connectionId },
      select: { secret: true },
    });
    return (row as { secret?: string | null } | null)?.secret ?? null;
  }

  async setSecret(organizationId: string, connectionId: string, secret: string | null): Promise<void> {
    await this.db.directoryConnection.update({ where: { id: connectionId, organizationId }, data: { secret } });
  }
}
