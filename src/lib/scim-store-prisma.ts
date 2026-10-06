/**
 * The Prisma side of directory sync: the queries a SCIM push runs.
 *
 * Kept apart from `scim-service.ts` so the service — where every decision lives — is
 * exercised against `MemoryScimStore`, and so this file is the only place that knows
 * what an account row looks like. The client is described structurally rather than as
 * `PrismaClient`, so the adapter runs against the generated client, a fake, or a
 * repository layer without changing.
 *
 * `passwordHash` is deliberately absent from every projection: nothing on this path
 * should ever read a credential, let alone write one. An account created here is
 * `passwordHash: null` — exactly like one provisioned by the identity provider.
 */

import { pickAccent } from "./auth-hash";
import { prisma } from "./db";
import type { ScimCohortRecord, ScimMemberRecord, ScimStore, ScimUserRecord } from "./scim-service";
import type { Role } from "@prisma/client";

export interface ScimUserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScimCohortRow {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScimPrismaClient {
  user: {
    findMany(args?: Record<string, unknown>): Promise<ScimUserRow[]>;
    findUnique(args: Record<string, unknown>): Promise<ScimUserRow | null>;
    create(args: Record<string, unknown>): Promise<ScimUserRow>;
    update(args: Record<string, unknown>): Promise<ScimUserRow>;
  };
  cohort: {
    findMany(args?: Record<string, unknown>): Promise<ScimCohortRow[]>;
    findUnique(args: Record<string, unknown>): Promise<ScimCohortRow | null>;
  };
  cohortMember: {
    findMany(args: Record<string, unknown>): Promise<{ userId: string; user: { email: string } }[]>;
    deleteMany(args: Record<string, unknown>): Promise<{ count: number }>;
    createMany(args: Record<string, unknown>): Promise<{ count: number }>;
  };
}

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  active: true,
  externalId: true,
  createdAt: true,
  updatedAt: true,
} as const;

const COHORT_SELECT = { id: true, name: true, createdAt: true, updatedAt: true } as const;

export function toScimUserRecord(row: ScimUserRow): ScimUserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    active: row.active,
    externalId: row.externalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toScimCohortRecord(row: ScimCohortRow): ScimCohortRecord {
  return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/**
 * The write side, named field by field.
 *
 * An update touches only the attributes a PATCH or PUT actually named — a rename
 * cannot demote a role, and a deactivation cannot clear the directory id — which is
 * why the patch is projected onto a change object here rather than spread.
 */
export function createPrismaScimStore(client: ScimPrismaClient): ScimStore {
  return {
    async listUsers() {
      const rows = await client.user.findMany({ orderBy: { email: "asc" }, select: USER_SELECT });
      return rows.map(toScimUserRecord);
    },

    async findUserById(id) {
      const row = await client.user.findUnique({ where: { id }, select: USER_SELECT });
      return row ? toScimUserRecord(row) : null;
    },

    async findUserByEmail(email) {
      const row = await client.user.findUnique({ where: { email: email.toLowerCase() }, select: USER_SELECT });
      return row ? toScimUserRecord(row) : null;
    },

    async findUserByExternalId(externalId) {
      const row = await client.user.findUnique({ where: { externalId }, select: USER_SELECT });
      return row ? toScimUserRecord(row) : null;
    },

    async createUser(input) {
      const row = await client.user.create({
        data: {
          email: input.email,
          name: input.name,
          role: input.role,
          active: input.active,
          externalId: input.externalId,
          // No password at all: an account the directory made has no local
          // credential to guess, leak or reset.
          passwordHash: null,
          accent: pickAccent(input.email),
        },
        select: USER_SELECT,
      });
      return toScimUserRecord(row);
    },

    async updateUser(id, patch) {
      const data: Record<string, unknown> = {};
      if (patch.email !== undefined) data.email = patch.email.toLowerCase();
      if (patch.name !== undefined) data.name = patch.name;
      if (patch.role !== undefined) data.role = patch.role;
      if (patch.active !== undefined) data.active = patch.active;
      if (patch.externalId !== undefined) data.externalId = patch.externalId;
      const row = await client.user.update({ where: { id }, data, select: USER_SELECT });
      return toScimUserRecord(row);
    },

    async listCohorts() {
      const rows = await client.cohort.findMany({ orderBy: { name: "asc" }, select: COHORT_SELECT });
      return rows.map(toScimCohortRecord);
    },

    async findCohortById(id) {
      const row = await client.cohort.findUnique({ where: { id }, select: COHORT_SELECT });
      return row ? toScimCohortRecord(row) : null;
    },

    async cohortMembers(cohortId): Promise<ScimMemberRecord[]> {
      const rows = await client.cohortMember.findMany({
        where: { cohortId },
        select: { userId: true, user: { select: { email: true } } },
      });
      return rows.map((row) => ({ userId: row.userId, email: row.user.email }));
    },

    /**
     * Membership is *replaced*, so the retained members keep their row.
     *
     * A delete-all-then-create-all would reset `joinedAt` and drop the `isMentor`
     * flag on somebody who was already in the class — the difference between a sync
     * that updates a membership and one that quietly re-enrols everybody.
     */
    async setCohortMembers(cohortId, userIds) {
      const existing = await client.cohortMember.findMany({
        where: { cohortId },
        select: { userId: true, user: { select: { email: true } } },
      });
      const held = new Set(existing.map((row) => row.userId));
      const wanted = new Set(userIds);

      const remove = [...held].filter((id) => !wanted.has(id));
      if (remove.length) await client.cohortMember.deleteMany({ where: { cohortId, userId: { in: remove } } });

      const add = [...wanted].filter((id) => !held.has(id));
      if (add.length) await client.cohortMember.createMany({ data: add.map((userId) => ({ cohortId, userId })) });

      const row = await client.cohort.findUnique({ where: { id: cohortId }, select: COHORT_SELECT });
      if (!row) throw new Error(`no such cohort: ${cohortId}`);
      return toScimCohortRecord(row);
    },
  };
}

export const prismaScimStore: ScimStore = createPrismaScimStore(prisma as unknown as ScimPrismaClient);
