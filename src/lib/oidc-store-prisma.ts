/**
 * The Prisma side of single sign-on: three lookups and two writes.
 *
 * Kept apart from `oidc-service.ts` so the service — which is where all the
 * decisions are — is exercised against a fake, and so this file is the only place
 * that knows what an account row looks like. The client is described structurally
 * rather than as `PrismaClient`, so the adapter runs against the generated client,
 * a fake, or a repository layer without changing.
 *
 * `passwordHash` is deliberately absent from the projection: nothing in the SSO
 * path should ever read a credential, let alone write one.
 */

import { prisma } from "./db";
import type { SsoUserRecord, SsoUserStore } from "./oidc-service";

export interface SsoUserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  accent: string;
  externalId: string | null;
}

export interface SsoPrismaClient {
  user: {
    findUnique(args: { where: Record<string, unknown>; select?: Record<string, boolean> }): Promise<SsoUserRow | null>;
    findFirst(args: { where: Record<string, unknown> }): Promise<SsoUserRow | null>;
    create(args: { data: Record<string, unknown>; select?: Record<string, boolean> }): Promise<SsoUserRow>;
    update(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<SsoUserRow>;
    count(args: { where: Record<string, unknown> }): Promise<number>;
  };
}

const SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  active: true,
  accent: true,
  externalId: true,
} as const;

export function toSsoUser(row: SsoUserRow): SsoUserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as SsoUserRecord["role"],
    active: row.active,
    accent: row.accent,
    externalId: row.externalId,
  };
}

export function createPrismaSsoStore(client: SsoPrismaClient): SsoUserStore {
  return {
    async findBySubject(subject) {
      const row = await client.user.findFirst({ where: { externalId: subject } });
      return row ? toSsoUser(row) : null;
    },

    async findByEmail(email) {
      const row = await client.user.findUnique({ where: { email } });
      return row ? toSsoUser(row) : null;
    },

    async countOtherActiveAdmins(excludeId) {
      return client.user.count({ where: { role: "ADMIN", active: true, id: { not: excludeId } } });
    },

    async create(input) {
      const row = await client.user.create({
        data: {
          email: input.email,
          name: input.name,
          role: input.role,
          accent: input.accent,
          externalId: input.externalId,
          // No password at all: an account that only ever signs in through the
          // provider has no local credential to guess, leak or reset.
          passwordHash: null,
          lastLoginAt: new Date(),
        },
        select: SELECT,
      });
      return toSsoUser(row);
    },

    async update(id, patch) {
      const row = await client.user.update({
        where: { id },
        data: {
          email: patch.email,
          name: patch.name,
          role: patch.role,
          externalId: patch.externalId,
          lastLoginAt: new Date(),
        },
        select: SELECT,
      });
      return toSsoUser(row);
    },
  };
}

export const prismaSsoStore: SsoUserStore = createPrismaSsoStore(prisma as unknown as SsoPrismaClient);
