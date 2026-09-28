/**
 * Prisma adapter for the canned-response store (M1). Structural, like the other
 * adapters, so the service is testable against a fake.
 */

import type { CannedResponse } from "./canned-rules";
import type { CannedStore } from "./canned-service";

export interface CannedResponseRow {
  id: string;
  tenantId: string;
  title: string;
  body: string;
  shortcut: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CannedPrismaClient {
  cannedResponse: {
    findMany(args: unknown): Promise<CannedResponseRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    deleteMany(args: unknown): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toCannedRecord(row: CannedResponseRow): CannedResponse {
  return {
    id: row.id,
    tenantId: row.tenantId,
    title: row.title,
    body: row.body,
    shortcut: row.shortcut,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toCannedData(response: CannedResponse) {
  return {
    id: response.id,
    tenantId: response.tenantId,
    title: response.title,
    body: response.body,
    shortcut: response.shortcut,
    createdAt: new Date(response.createdAt),
    updatedAt: new Date(response.updatedAt),
  };
}

export class PrismaCannedStore implements CannedStore {
  constructor(private readonly db: CannedPrismaClient) {}

  async listForTenant(tenantId: string): Promise<CannedResponse[]> {
    const rows = await this.db.cannedResponse.findMany({ where: { tenantId } });
    return rows.map(toCannedRecord);
  }

  async insert(response: CannedResponse): Promise<void> {
    await this.db.cannedResponse.create({ data: toCannedData(response) });
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.db.cannedResponse.deleteMany({ where: { tenantId, id } });
  }
}
