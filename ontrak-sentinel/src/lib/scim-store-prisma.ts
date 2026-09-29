/**
 * Prisma adapter for provisioning (S2).
 *
 * The same split as every other adapter here: the port speaks domain records with ISO
 * strings, this file owns the rows and the `Date` conversion, and nothing here
 * decides anything.
 *
 * Two choices worth naming:
 *
 *  - **The Prisma client is described structurally** (`ScimPrismaClient`), exactly as
 *    the S0 and S1 adapters describe theirs, so this typechecks and its tests run
 *    without a generated client or a database.
 *  - **Membership writes are delete-then-insert, never upsert with a flag.** Adding a
 *    member who is already in the group is a no-op and removing one who is not is a
 *    no-op, whatever the two rows happened to be before — which is the behaviour a
 *    connector's retry needs, and it does not depend on a provider-specific
 *    `skipDuplicates`.
 */

import { sha256Hex } from "./hash";
import type { ScimGroupMemberRecord, ScimGroupRecord, ScimStore, ScimTokenRecord } from "./scim-service";

/* -------------------------------------------------------------------------- */
/*  Row shapes                                                                */
/* -------------------------------------------------------------------------- */

export interface ScimTokenRow {
  id: string;
  organizationId: string;
  label: string | null;
  tokenHash: string;
  createdBy: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface ScimGroupRow {
  id: string;
  organizationId: string;
  displayName: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScimGroupMemberRow {
  groupId: string;
  identityId: string;
}

/**
 * The subset of a generated Prisma client these adapters use.
 *
 * Method syntax, so a real client is assignable and a fake is trivial — the same
 * convention `IdentityPrismaClient` and `MfaPrismaClient` use.
 */
export interface ScimPrismaClient {
  scimToken: {
    create(args: { data: unknown }): Promise<unknown>;
    findFirst(args: unknown): Promise<ScimTokenRow | null>;
    findMany(args: unknown): Promise<ScimTokenRow[]>;
    update(args: { where: { id: string }; data: unknown }): Promise<unknown>;
  };
  group: {
    create(args: { data: unknown }): Promise<unknown>;
    findFirst(args: unknown): Promise<ScimGroupRow | null>;
    findMany(args: unknown): Promise<ScimGroupRow[]>;
    update(args: { where: { id: string }; data: unknown }): Promise<unknown>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
  groupMember: {
    findMany(args: unknown): Promise<ScimGroupMemberRow[]>;
    createMany(args: { data: unknown[] }): Promise<{ count: number }>;
    deleteMany(args: { where: unknown }): Promise<{ count: number }>;
  };
}

/* -------------------------------------------------------------------------- */
/*  Mappers (pure)                                                            */
/* -------------------------------------------------------------------------- */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function fromIso(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

export function toScimTokenRecord(row: ScimTokenRow): ScimTokenRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    label: row.label,
    tokenHash: row.tokenHash,
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
    lastUsedAt: toIsoOrNull(row.lastUsedAt),
    revokedAt: toIsoOrNull(row.revokedAt),
  };
}

export function toScimTokenCreate(record: ScimTokenRecord): Record<string, unknown> {
  return {
    id: record.id,
    organizationId: record.organizationId,
    label: record.label,
    tokenHash: record.tokenHash,
    createdBy: record.createdBy,
    createdAt: new Date(record.createdAt),
  };
}

/** Only the fields that move after a mint: use, and revocation. The hash never changes. */
export function toScimTokenUpdate(record: ScimTokenRecord): Record<string, unknown> {
  return {
    label: record.label,
    lastUsedAt: fromIso(record.lastUsedAt),
    revokedAt: fromIso(record.revokedAt),
  };
}

export function toScimGroupRecord(row: ScimGroupRow): ScimGroupRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    displayName: row.displayName,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toScimGroupCreate(record: ScimGroupRecord): Record<string, unknown> {
  return {
    id: record.id,
    organizationId: record.organizationId,
    displayName: record.displayName,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

export function toScimGroupUpdate(record: ScimGroupRecord): Record<string, unknown> {
  return { displayName: record.displayName, updatedAt: new Date(record.updatedAt) };
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

export class PrismaScimStore implements ScimStore {
  constructor(
    private readonly db: ScimPrismaClient,
    /**
     * The same SHA-256 the spine's evidence chain and the OIDC store use, injected so
     * a test can drive the whole store with a hash it can predict.
     */
    private readonly hash = sha256Hex,
  ) {}

  async insertToken(record: ScimTokenRecord): Promise<void> {
    await this.db.scimToken.create({ data: toScimTokenCreate(record) });
  }

  /** A token is looked up by its hash, so the plaintext never reaches the database. */
  async findTokenByHash(tokenHash: string): Promise<ScimTokenRecord | null> {
    const row = await this.db.scimToken.findFirst({ where: { tokenHash } });
    return row ? toScimTokenRecord(row) : null;
  }

  async listTokens(organizationId: string): Promise<ScimTokenRecord[]> {
    const rows = await this.db.scimToken.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toScimTokenRecord);
  }

  async updateToken(record: ScimTokenRecord): Promise<void> {
    await this.db.scimToken.update({ where: { id: record.id }, data: toScimTokenUpdate(record) });
  }

  async listGroups(organizationId: string): Promise<ScimGroupRecord[]> {
    const rows = await this.db.group.findMany({ where: { organizationId }, orderBy: { displayName: "asc" } });
    return rows.map(toScimGroupRecord);
  }

  async findGroup(organizationId: string, groupId: string): Promise<ScimGroupRecord | null> {
    const row = await this.db.group.findFirst({ where: { organizationId, id: groupId } });
    return row ? toScimGroupRecord(row) : null;
  }

  async findGroupByName(organizationId: string, displayName: string): Promise<ScimGroupRecord | null> {
    const row = await this.db.group.findFirst({ where: { organizationId, displayName } });
    return row ? toScimGroupRecord(row) : null;
  }

  async insertGroup(record: ScimGroupRecord): Promise<void> {
    await this.db.group.create({ data: toScimGroupCreate(record) });
  }

  async updateGroup(record: ScimGroupRecord): Promise<void> {
    await this.db.group.update({ where: { id: record.id }, data: toScimGroupUpdate(record) });
  }

  /** Membership rows go with the group: a member of a group that does not exist is a
   *  row nothing can read, and the foreign key cascades rather than being swept. */
  async removeGroup(organizationId: string, groupId: string): Promise<void> {
    const found = await this.findGroup(organizationId, groupId);
    if (!found) return;
    await this.db.group.delete({ where: { id: groupId } });
  }

  async listMembers(organizationId: string, groupId: string): Promise<ScimGroupMemberRecord[]> {
    const found = await this.findGroup(organizationId, groupId);
    if (!found) return [];
    const rows = await this.db.groupMember.findMany({ where: { groupId }, orderBy: { identityId: "asc" } });
    return rows.map((row) => ({ groupId: row.groupId, identityId: row.identityId }));
  }

  /** Idempotent by construction: the pair is deleted first, so adding twice is one row. */
  async addMembers(organizationId: string, groupId: string, identityIds: string[]): Promise<void> {
    if (identityIds.length === 0) return;
    const found = await this.findGroup(organizationId, groupId);
    if (!found) return;
    await this.db.groupMember.deleteMany({ where: { groupId, identityId: { in: identityIds } } });
    await this.db.groupMember.createMany({ data: identityIds.map((identityId) => ({ groupId, identityId })) });
  }

  async removeMembers(organizationId: string, groupId: string, identityIds: string[]): Promise<void> {
    if (identityIds.length === 0) return;
    const found = await this.findGroup(organizationId, groupId);
    if (!found) return;
    await this.db.groupMember.deleteMany({ where: { groupId, identityId: { in: identityIds } } });
  }

  /**
   * Every group this identity belongs to, inside one organization.
   *
   * The organization is part of the query rather than a check afterwards — the same
   * rule as every other read in the product, so a membership row cannot be read
   * across the isolation boundary even if an id arrived from somewhere else.
   */
  async listMembershipsForIdentity(organizationId: string, identityId: string): Promise<ScimGroupMemberRecord[]> {
    const groups = await this.db.group.findMany({ where: { organizationId }, select: { id: true } });
    const groupIds = groups.map((group) => group.id);
    if (groupIds.length === 0) return [];
    const rows = await this.db.groupMember.findMany({ where: { identityId, groupId: { in: groupIds } } });
    return rows.map((row) => ({ groupId: row.groupId, identityId: row.identityId }));
  }
}
