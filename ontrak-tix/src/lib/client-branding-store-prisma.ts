/**
 * Prisma adapter for client branding (M4).
 *
 * The port speaks domain records with ISO strings; this file owns the row shape
 * and the `Date` conversions, and decides nothing.
 */

import type { ClientBrandingRecord } from "./client-branding-rules";
import type { ClientBrandingStore } from "./client-branding-service";

export interface ClientBrandingRow {
  id: string;
  tenantId: string;
  clientId: string;
  displayName: string;
  accentColor: string;
  logoUrl: string | null;
  supportEmail: string | null;
  signature: string | null;
  updatedBy: string;
  updatedAt: Date;
  createdAt: Date;
}

export interface ClientBrandingPrismaClient {
  clientBranding: {
    findMany(args: unknown): Promise<ClientBrandingRow[]>;
    findFirst(args: unknown): Promise<ClientBrandingRow | null>;
    upsert(args: { where: unknown; create: unknown; update: unknown }): Promise<unknown>;
  };
}

export function toClientBrandingRecord(row: ClientBrandingRow): ClientBrandingRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    clientId: row.clientId,
    displayName: row.displayName,
    accentColor: row.accentColor,
    logoUrl: row.logoUrl,
    supportEmail: row.supportEmail,
    signature: row.signature,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function toData(record: ClientBrandingRecord) {
  return {
    tenantId: record.tenantId,
    clientId: record.clientId,
    displayName: record.displayName,
    accentColor: record.accentColor,
    logoUrl: record.logoUrl,
    supportEmail: record.supportEmail,
    signature: record.signature,
    updatedBy: record.updatedBy,
    createdAt: new Date(record.createdAt),
  };
}

export class PrismaClientBrandingStore implements ClientBrandingStore {
  constructor(private readonly db: ClientBrandingPrismaClient) {}

  async listForTenant(tenantId: string): Promise<ClientBrandingRecord[]> {
    const rows = await this.db.clientBranding.findMany({ where: { tenantId }, orderBy: { displayName: "asc" } });
    return rows.map(toClientBrandingRecord);
  }

  async findByClient(tenantId: string, clientId: string): Promise<ClientBrandingRecord | null> {
    const row = await this.db.clientBranding.findFirst({ where: { tenantId, clientId } });
    return row ? toClientBrandingRecord(row) : null;
  }

  async upsert(record: ClientBrandingRecord): Promise<void> {
    await this.db.clientBranding.upsert({
      where: { clientId: record.clientId },
      create: { id: record.id, ...toData(record) },
      update: toData(record),
    });
  }
}
