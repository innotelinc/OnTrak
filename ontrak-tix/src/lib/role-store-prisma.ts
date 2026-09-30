/**
 * Prisma adapter for granular roles (M6).
 *
 * The same split as every other adapter here: the port speaks domain records with ISO strings,
 * this file owns the rows, the `Date` conversions and the enum spelling, and nothing here
 * decides anything. The mappers are pure, so the narrowing is tested without a database.
 *
 * Two spellings are worth reading, and both are the safe side of a hand-edited row.
 * **A `baseRole` this release does not know reads as `REQUESTER`** — the least powerful role
 * there is — because a row that cannot be understood must never be the row that grants
 * something. And **a `permissions` entry that is not a permission is dropped rather than
 * carried**, so an unknown string cannot wait in the array for a later release to start
 * honouring it.
 */

import { isRole, type Permission, type Role } from "./access-rules";
import { isPermission, type RoleMember, type TenantRole } from "./role-rules";
import type { RoleStore } from "./role-service";

export interface TenantRoleRow {
  id: string;
  tenantId: string;
  key: string;
  name: string;
  description: string | null;
  baseRole: string;
  permissions: string[];
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoleMemberRow {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: string;
  active: boolean;
  tenantRoleId: string | null;
}

export interface RolePrismaClient {
  tenantRole: {
    findMany(args: unknown): Promise<TenantRoleRow[]>;
    findFirst(args: unknown): Promise<TenantRoleRow | null>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
  user: {
    findMany(args: unknown): Promise<RoleMemberRow[]>;
    findFirst(args: unknown): Promise<RoleMemberRow | null>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

/** A base role this release knows, or the least powerful one there is. */
function toRole(value: string): Role {
  return isRole(value) ? value : "REQUESTER";
}

/** Known permissions only, in the order the catalogue lists them. */
function toPermissions(values: readonly string[]): Permission[] {
  return values.filter(isPermission);
}

export function toTenantRole(row: TenantRoleRow): TenantRole {
  return {
    id: row.id,
    tenantId: row.tenantId,
    key: row.key,
    name: row.name,
    description: row.description,
    baseRole: toRole(row.baseRole),
    permissions: toPermissions(row.permissions ?? []),
    archivedAt: toIsoOrNull(row.archivedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toRoleMember(row: RoleMemberRow): RoleMember {
  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    displayName: row.displayName,
    role: toRole(row.role),
    active: row.active,
    tenantRoleId: row.tenantRoleId,
  };
}

/** The role columns, so a create and an update cannot disagree about the shape. */
export function roleData(role: TenantRole) {
  return {
    tenantId: role.tenantId,
    key: role.key,
    name: role.name,
    description: role.description,
    baseRole: role.baseRole,
    permissions: [...role.permissions],
    archivedAt: role.archivedAt ? new Date(role.archivedAt) : null,
  };
}

export class PrismaRoleStore implements RoleStore {
  constructor(private readonly client: RolePrismaClient) {}

  async list(tenantId: string): Promise<TenantRole[]> {
    const rows = await this.client.tenantRole.findMany({ where: { tenantId } });
    return rows.map(toTenantRole);
  }

  async find(tenantId: string, roleId: string): Promise<TenantRole | null> {
    const row = await this.client.tenantRole.findFirst({ where: { id: roleId, tenantId } });
    return row ? toTenantRole(row) : null;
  }

  async insert(role: TenantRole): Promise<void> {
    await this.client.tenantRole.create({ data: { id: role.id, ...roleData(role) } });
  }

  async update(role: TenantRole): Promise<void> {
    await this.client.tenantRole.update({ where: { id: role.id }, data: roleData(role) });
  }

  async members(tenantId: string): Promise<RoleMember[]> {
    const rows = await this.client.user.findMany({
      where: { tenantId },
      select: {
        id: true,
        tenantId: true,
        email: true,
        displayName: true,
        role: true,
        active: true,
        tenantRoleId: true,
      },
    });
    return rows.map(toRoleMember);
  }

  /**
   * The role one person has been handed.
   *
   * A single join rather than the member list, because this runs on the way into every request
   * that resolves an actor — the one place in this feature that is on a hot path.
   */
  async assignedRole(tenantId: string, userId: string): Promise<TenantRole | null> {
    const row = await this.client.user.findFirst({
      where: { id: userId, tenantId },
      select: { tenantRoleId: true },
    });
    if (!row?.tenantRoleId) return null;
    // Asked as two statements rather than one join so that both shapes stay flat and honest:
    // a row that has been archived still resolves (its `archivedAt` is what retires it), and
    // this is the one read on the way into every request that resolves an actor.
    return this.find(tenantId, row.tenantRoleId);
  }

  /**
   * Hand a role to somebody, or take it away.
   *
   * Scoped to the tenant in the same statement, so a user id from another desk cannot be
   * re-roled by passing it here — the tenant rule is not something the caller can forget.
   */
  async assign(tenantId: string, userId: string, roleId: string | null): Promise<void> {
    await this.client.user.update({ where: { id: userId, tenantId }, data: { tenantRoleId: roleId } });
  }
}
