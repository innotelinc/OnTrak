/**
 * Prisma adapter for the identity store (M2).
 *
 * The connection's `roleMappings` is JSON and its `scopes`/`allowedDomains` are
 * string arrays; the mappers narrow all three back into the domain types, so a
 * hand-edited row cannot inject an unknown role. Structural, like the other
 * adapters — the tests use a fake.
 */

import { isRole, type Role } from "./access-rules";
import {
  IDENTITY_PROTOCOLS,
  type IdentityConnection,
  type IdentityProtocol,
  type RoleMapping,
} from "./identity-rules";
import type { IdentityStore, IdentityUser } from "./identity-service";

export interface IdentityConnectionRow {
  id: string;
  tenantId: string;
  protocol: string;
  issuer: string;
  clientId: string;
  scopes: string[];
  allowedDomains: string[];
  defaultRole: string;
  roleMappings: unknown;
  mfaRequired: boolean;
  scimEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IdentityUserRow {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: string;
  active: boolean;
  externalId: string | null;
}

export interface IdentityPrismaClient {
  identityConnection: {
    findUnique(args: unknown): Promise<IdentityConnectionRow | null>;
    upsert(args: unknown): Promise<unknown>;
  };
  user: {
    findFirst(args: unknown): Promise<IdentityUserRow | null>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toRole(value: string, fallback: Role = "REQUESTER"): Role {
  return isRole(value) ? value : fallback;
}

function toProtocol(value: string): IdentityProtocol {
  return (IDENTITY_PROTOCOLS as readonly string[]).includes(value) ? (value as IdentityProtocol) : "OIDC";
}

export function toRoleMappings(value: unknown): RoleMapping[] {
  if (!Array.isArray(value)) return [];
  const mappings: RoleMapping[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.value !== "string" || record.value.trim() === "" || !isRole(record.role)) continue;
    mappings.push({
      value: record.value,
      role: record.role,
      ...(typeof record.claim === "string" && record.claim.trim() !== "" ? { claim: record.claim } : {}),
    });
  }
  return mappings;
}

export function toConnectionRecord(row: IdentityConnectionRow): IdentityConnection {
  return {
    id: row.id,
    tenantId: row.tenantId,
    protocol: toProtocol(row.protocol),
    issuer: row.issuer,
    clientId: row.clientId,
    scopes: row.scopes ?? [],
    allowedDomains: row.allowedDomains ?? [],
    defaultRole: toRole(row.defaultRole),
    roleMappings: toRoleMappings(row.roleMappings),
    mfaRequired: row.mfaRequired,
    scimEnabled: row.scimEnabled,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toConnectionData(connection: IdentityConnection) {
  return {
    id: connection.id,
    tenantId: connection.tenantId,
    protocol: connection.protocol,
    issuer: connection.issuer,
    clientId: connection.clientId,
    scopes: [...connection.scopes],
    allowedDomains: [...connection.allowedDomains],
    defaultRole: connection.defaultRole,
    roleMappings: connection.roleMappings.map((mapping) => ({ ...mapping })),
    mfaRequired: connection.mfaRequired,
    scimEnabled: connection.scimEnabled,
    createdAt: new Date(connection.createdAt),
    updatedAt: new Date(connection.updatedAt),
  };
}

export function toIdentityUserRecord(row: IdentityUserRow): IdentityUser {
  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    displayName: row.displayName,
    role: toRole(row.role),
    active: row.active,
    externalId: row.externalId,
  };
}

export function toIdentityUserData(user: IdentityUser) {
  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    active: user.active,
    externalId: user.externalId,
  };
}

export class PrismaIdentityStore implements IdentityStore {
  constructor(private readonly db: IdentityPrismaClient) {}

  async findConnection(tenantId: string): Promise<IdentityConnection | null> {
    const row = await this.db.identityConnection.findUnique({ where: { tenantId } });
    return row ? toConnectionRecord(row) : null;
  }

  async saveConnection(connection: IdentityConnection): Promise<void> {
    const data = toConnectionData(connection);
    await this.db.identityConnection.upsert({
      where: { tenantId: connection.tenantId },
      create: data,
      update: data,
    });
  }

  async findUserByEmail(tenantId: string, email: string): Promise<IdentityUser | null> {
    const row = await this.db.user.findFirst({ where: { tenantId, email: email.trim().toLowerCase() } });
    return row ? toIdentityUserRecord(row) : null;
  }

  async findUserByExternalId(tenantId: string, externalId: string): Promise<IdentityUser | null> {
    const row = await this.db.user.findFirst({ where: { tenantId, externalId } });
    return row ? toIdentityUserRecord(row) : null;
  }

  async createUser(user: IdentityUser): Promise<void> {
    await this.db.user.create({ data: toIdentityUserData(user) });
  }

  async updateUser(user: IdentityUser): Promise<void> {
    await this.db.user.update({ where: { id: user.id }, data: toIdentityUserData(user) });
  }
}
