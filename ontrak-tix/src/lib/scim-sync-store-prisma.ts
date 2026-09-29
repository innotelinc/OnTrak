/**
 * The Prisma side of the outbound push: one query.
 *
 * Deliberately its own adapter rather than a method added to `IdentityStore`. That
 * port answers the identity *decisions* — who may sign in, what their claims mean —
 * and every fake in the suite implements it; a listing that exists for one feature
 * would make every one of them implement it too. This describes the one method it
 * needs, so the service is exercised against a list of people and nothing else.
 *
 * The row mapper is shared with the identity adapter rather than re-written, so a
 * row is interpreted one way whichever direction reads it.
 *
 * The source is built **when it is first asked for**, not when this module loads.
 * A module-level `createPrismaScimPeople(prisma)` would read `db.ts`'s client while
 * `db.ts` is still importing this file: a bundler happens to tolerate that ordering,
 * a plain `tsx` run does not, and the failure is `Cannot access 'prisma' before
 * initialization` from inside a script nobody thought was fragile. Memoised, so it
 * is still one object for the process.
 */

import { prisma } from "./db";
import { toIdentityUserRecord, type IdentityUserRow } from "./identity-store-prisma";
import type { IdentityUser } from "./identity-service";
import type { ScimPeopleSource } from "./scim-sync-service";

export interface ScimPeoplePrismaClient {
  user: {
    findMany(args: {
      where: { tenantId: string };
      orderBy?: Record<string, "asc" | "desc">;
    }): Promise<IdentityUserRow[]>;
  };
}

export function createPrismaScimPeople(client: ScimPeoplePrismaClient): ScimPeopleSource {
  return {
    async listUsers(tenantId: string): Promise<IdentityUser[]> {
      // Ordered, so a run's failures are reproducible and two runs of the same
      // desk write the same audit entries in the same order.
      const rows = await client.user.findMany({ where: { tenantId }, orderBy: { email: "asc" } });
      return rows.map(toIdentityUserRecord);
    },
  };
}

let prismaPeople: ScimPeopleSource | null = null;

export function prismaScimPeople(): ScimPeopleSource {
  if (!prismaPeople) {
    prismaPeople = createPrismaScimPeople(prisma as unknown as ScimPeoplePrismaClient);
  }
  return prismaPeople;
}
