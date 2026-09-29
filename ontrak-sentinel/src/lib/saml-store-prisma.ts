/**
 * Prisma adapter for SAML service providers (S1).
 *
 * The same split as every other adapter in the project: the port speaks domain
 * records with ISO strings and a known NameID format, this file owns the row and
 * the `Date` conversion, and nothing here decides anything.
 *
 * One choice is worth naming. `nameIdFormat` is stored as free text in the
 * database — Prisma enums are a migration per format, and SAML's registry of
 * formats is not ours to freeze — but it is read back through
 * `asNameIdFormat`, which falls back to the email-address format for anything
 * unrecognised. Falling back rather than surfacing an unknown string keeps a
 * hand-edited row from producing an assertion in a format no SP asked for; the
 * alternative loses to a convenient `string`.
 */

import { DEFAULT_NAME_ID_FORMAT, isKnownNameIdFormat, type SamlNameIdFormat, type SamlServiceProviderRecord } from "./saml-rules";
import type { SamlStore } from "./saml-service";

export interface SamlServiceProviderRow {
  entityId: string;
  organizationId: string;
  name: string;
  acsUrls: string[] | null;
  nameIdFormat: string;
  createdBy: string;
  createdAt: Date;
}

export interface SamlPrismaClient {
  samlServiceProvider: {
    findFirst(args: unknown): Promise<SamlServiceProviderRow | null>;
    findMany(args: unknown): Promise<SamlServiceProviderRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asNameIdFormat(value: unknown): SamlNameIdFormat {
  return typeof value === "string" && isKnownNameIdFormat(value) ? value : DEFAULT_NAME_ID_FORMAT;
}

export function toServiceProviderRecord(row: SamlServiceProviderRow): SamlServiceProviderRecord {
  return {
    entityId: row.entityId,
    organizationId: row.organizationId,
    name: row.name,
    acsUrls: Array.isArray(row.acsUrls) ? [...row.acsUrls] : [],
    nameIdFormat: asNameIdFormat(row.nameIdFormat),
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
  };
}

export class PrismaSamlStore implements SamlStore {
  constructor(private readonly db: SamlPrismaClient) {}

  async insertServiceProvider(record: SamlServiceProviderRecord): Promise<void> {
    await this.db.samlServiceProvider.create({
      data: {
        entityId: record.entityId,
        organizationId: record.organizationId,
        name: record.name,
        acsUrls: [...record.acsUrls],
        nameIdFormat: record.nameIdFormat,
        createdBy: record.createdBy,
        createdAt: new Date(record.createdAt),
      },
    });
  }

  async findServiceProvider(organizationId: string, entityId: string): Promise<SamlServiceProviderRecord | null> {
    const row = await this.db.samlServiceProvider.findFirst({ where: { organizationId, entityId } });
    return row ? toServiceProviderRecord(row) : null;
  }

  /** Deliberately unscoped: an AuthnRequest carries no tenant hint. */
  async findServiceProviderByEntityId(entityId: string): Promise<SamlServiceProviderRecord | null> {
    const row = await this.db.samlServiceProvider.findFirst({ where: { entityId } });
    return row ? toServiceProviderRecord(row) : null;
  }

  async listServiceProviders(organizationId: string): Promise<SamlServiceProviderRecord[]> {
    const rows = await this.db.samlServiceProvider.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toServiceProviderRecord);
  }
}
