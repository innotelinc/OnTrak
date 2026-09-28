/**
 * Prisma adapter for saved views (M0/M1). The filter is a JSON column and is
 * re-sanitized on the way out, so a hand-edited row can never widen what the
 * inbox will do with it.
 */

import { sanitizeInboxFilter, type SavedView } from "./saved-view-rules";
import type { SavedViewStore } from "./saved-view-service";

export interface SavedViewRow {
  id: string;
  tenantId: string;
  ownerId: string;
  name: string;
  filter: unknown;
  shared: boolean;
  createdAt: Date;
}

export interface SavedViewPrismaClient {
  savedView: {
    findMany(args: unknown): Promise<SavedViewRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    deleteMany(args: unknown): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toSavedViewRecord(row: SavedViewRow): SavedView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ownerId: row.ownerId,
    name: row.name,
    filter: sanitizeInboxFilter(row.filter),
    shared: row.shared,
    createdAt: toIso(row.createdAt),
  };
}

export function toSavedViewData(view: SavedView) {
  return {
    id: view.id,
    tenantId: view.tenantId,
    ownerId: view.ownerId,
    name: view.name,
    filter: view.filter as unknown as object,
    shared: view.shared,
    createdAt: new Date(view.createdAt),
  };
}

export class PrismaSavedViewStore implements SavedViewStore {
  constructor(private readonly db: SavedViewPrismaClient) {}

  async listForTenant(tenantId: string): Promise<SavedView[]> {
    const rows = await this.db.savedView.findMany({ where: { tenantId } });
    return rows.map(toSavedViewRecord);
  }

  async insert(view: SavedView): Promise<void> {
    await this.db.savedView.create({ data: toSavedViewData(view) });
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.db.savedView.deleteMany({ where: { tenantId, id } });
  }
}
