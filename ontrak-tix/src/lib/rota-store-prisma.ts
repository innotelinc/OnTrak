/**
 * Prisma adapter for rota shifts and handoffs (M4).
 *
 * The port speaks domain records with ISO strings; this file owns the rows and
 * the `Date` conversions. The one thing it does decide is the shape of the
 * window filter, because a shift that *straddles* the window is inside it —
 * `endsAt > from && startsAt < to` — and getting that wrong would hide the
 * overnight shift, which is the shift the rota exists for.
 */

import type { HandoffRecord, RotaShiftRecord, ShiftKind } from "./rota-rules";
import type { RotaStore } from "./rota-service";

export interface RotaShiftRow {
  id: string;
  tenantId: string;
  queueId: string | null;
  userId: string;
  kind: ShiftKind;
  startsAt: Date;
  endsAt: Date;
  note: string | null;
  createdBy: string;
  createdAt: Date;
}

export interface HandoffRow {
  id: string;
  tenantId: string;
  queueId: string | null;
  fromUserId: string;
  toUserId: string | null;
  note: string;
  openTicketRefs: string[];
  at: Date;
}

export interface RotaPrismaClient {
  rotaShift: {
    findMany(args: unknown): Promise<RotaShiftRow[]>;
    findFirst(args: unknown): Promise<RotaShiftRow | null>;
    create(args: { data: unknown }): Promise<unknown>;
    deleteMany(args: { where: unknown }): Promise<unknown>;
  };
  handoff: {
    findMany(args: unknown): Promise<HandoffRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
  };
}

export function toRotaShiftRecord(row: RotaShiftRow): RotaShiftRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    queueId: row.queueId,
    userId: row.userId,
    kind: row.kind,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toHandoffRecord(row: HandoffRow): HandoffRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    queueId: row.queueId,
    fromUserId: row.fromUserId,
    toUserId: row.toUserId,
    note: row.note,
    openTicketRefs: row.openTicketRefs,
    at: row.at.toISOString(),
  };
}

export class PrismaRotaStore implements RotaStore {
  constructor(private readonly db: RotaPrismaClient) {}

  async listShifts(
    tenantId: string,
    filters: { from?: string; to?: string; userId?: string; queueId?: string | null } = {},
  ): Promise<RotaShiftRecord[]> {
    const where: Record<string, unknown> = { tenantId };
    if (filters.userId !== undefined) where.userId = filters.userId;
    if (filters.queueId !== undefined) where.queueId = filters.queueId;
    if (filters.from !== undefined || filters.to !== undefined) {
      where.AND = [
        ...(filters.to === undefined ? [] : [{ startsAt: { lt: new Date(filters.to) } }]),
        ...(filters.from === undefined ? [] : [{ endsAt: { gt: new Date(filters.from) } }]),
      ];
    }
    const rows = await this.db.rotaShift.findMany({ where, orderBy: { startsAt: "asc" } });
    return rows.map(toRotaShiftRecord);
  }

  async findShift(tenantId: string, shiftId: string): Promise<RotaShiftRecord | null> {
    const row = await this.db.rotaShift.findFirst({ where: { tenantId, id: shiftId } });
    return row ? toRotaShiftRecord(row) : null;
  }

  async insertShift(record: RotaShiftRecord): Promise<void> {
    await this.db.rotaShift.create({
      data: {
        id: record.id,
        tenantId: record.tenantId,
        queueId: record.queueId,
        userId: record.userId,
        kind: record.kind,
        startsAt: new Date(record.startsAt),
        endsAt: new Date(record.endsAt),
        note: record.note,
        createdBy: record.createdBy,
        createdAt: new Date(record.createdAt),
      },
    });
  }

  async removeShift(tenantId: string, shiftId: string): Promise<void> {
    await this.db.rotaShift.deleteMany({ where: { tenantId, id: shiftId } });
  }

  async listHandoffs(tenantId: string, filters: { queueId?: string | null; limit?: number } = {}): Promise<HandoffRecord[]> {
    const where: Record<string, unknown> = { tenantId };
    if (filters.queueId !== undefined) where.queueId = filters.queueId;
    const rows = await this.db.handoff.findMany({
      where,
      orderBy: { at: "desc" },
      ...(filters.limit === undefined ? {} : { take: filters.limit }),
    });
    return rows.map(toHandoffRecord);
  }

  async insertHandoff(record: HandoffRecord): Promise<void> {
    await this.db.handoff.create({
      data: {
        id: record.id,
        tenantId: record.tenantId,
        queueId: record.queueId,
        fromUserId: record.fromUserId,
        toUserId: record.toUserId,
        note: record.note,
        openTicketRefs: record.openTicketRefs,
        at: new Date(record.at),
      },
    });
  }
}
