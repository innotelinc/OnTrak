/**
 * Prisma adapter for the `CredentialStore` port.
 *
 * The same structural-client trick as `identity-store-prisma.ts`: this file names the
 * three delegates it needs and nothing else, so it typechecks and can be exercised
 * against a fake without a generated client or a database.
 *
 * One deliberate choice: **reading is newest-first**. The schema does not forbid two
 * credential rows for one identity (the unique index is on the primary key, not on
 * `identityId`), and the honest reading of that is "the most recently written
 * verifier wins" — which is also what `replace` does. A login that picked an
 * arbitrary row would make a password reset occasionally not take effect, which is
 * indistinguishable from a bug in the reset.
 */

import type { CredentialRecord } from "./identity-rules";
import type { CredentialStore } from "./credential-store";

/** A `Credential` row as Prisma returns it. */
export interface CredentialRow {
  id: string;
  organizationId: string;
  identityId: string;
  hash: string;
  createdAt: Date;
}

/** Just the delegate this adapter needs. */
export interface CredentialPrismaClient {
  credential: {
    findFirst(args: unknown): Promise<CredentialRow | null>;
    create(args: { data: unknown }): Promise<unknown>;
    updateMany(args: { where: unknown; data: unknown }): Promise<{ count: number }>;
    deleteMany(args: { where: unknown }): Promise<{ count: number }>;
  };
}

export function toCredentialRecord(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    identityId: row.identityId,
    hash: row.hash,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PrismaCredentialStore implements CredentialStore {
  constructor(private readonly db: CredentialPrismaClient) {}

  async findForIdentity(organizationId: string, identityId: string): Promise<CredentialRecord | null> {
    const row = await this.db.credential.findFirst({
      where: { organizationId, identityId },
      orderBy: { createdAt: "desc" },
    });
    return row ? toCredentialRecord(row) : null;
  }

  async insert(record: CredentialRecord): Promise<void> {
    await this.db.credential.create({
      data: {
        id: record.id,
        organizationId: record.organizationId,
        identityId: record.identityId,
        hash: record.hash,
        createdAt: new Date(record.createdAt),
      },
    });
  }

  /**
   * Replace the verifier, and delete any siblings.
   *
   * The delete is not tidiness: leaving an older row behind would leave the previous
   * password in the table, verifiable, if the ordering ever changed. A password
   * change is supposed to end the old one.
   */
  async replace(organizationId: string, identityId: string, hash: string): Promise<void> {
    const result = await this.db.credential.updateMany({
      where: { organizationId, identityId },
      data: { hash },
    });
    if (result.count > 1) {
      // More than one row was rewritten to the same hash; the extras are the
      // duplicates the ordering above tolerates, and they go now.
      const rows = await this.db.credential.findFirst({ where: { organizationId, identityId } });
      if (rows) {
        await this.db.credential.deleteMany({
          where: { organizationId, identityId, NOT: { id: rows.id } },
        });
      }
    }
    if (result.count === 0) {
      await this.insert({
        id: `cred-${organizationId}-${identityId}`,
        organizationId,
        identityId,
        hash,
        createdAt: new Date().toISOString(),
      });
    }
  }
}
