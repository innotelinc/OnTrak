/**
 * Prisma adapter for the CSAT store (M1).
 *
 * Same structural approach as the ticket adapters: the generated client is
 * described by the one delegate this needs, so a real client, a fake in tests,
 * or a future repository all satisfy it. `score` is a plain `Int?` in the row
 * and a `1 | 5` union in the domain, so the conversion is validated on the way
 * in rather than trusted.
 */

import type { CsatScore } from "./csat-rules";
import type { CsatStore, SatisfactionRecord } from "./csat-service";

export interface SatisfactionRow {
  id: string;
  tenantId: string;
  ticketId: string;
  token: string;
  score: number | null;
  comment: string | null;
  requestedAt: Date;
  respondedAt: Date | null;
}

export interface CsatPrismaClient {
  satisfactionResponse: {
    findFirst(args: unknown): Promise<SatisfactionRow | null>;
    findMany(args: unknown): Promise<SatisfactionRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: { id: string }; data: unknown }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toScore(value: number | null): CsatScore | null {
  return value !== null && value >= 1 && value <= 5 ? (value as CsatScore) : null;
}

export function toSatisfactionRecord(row: SatisfactionRow): SatisfactionRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ticketId: row.ticketId,
    token: row.token,
    score: toScore(row.score),
    comment: row.comment,
    requestedAt: toIso(row.requestedAt),
    respondedAt: row.respondedAt === null ? null : toIso(row.respondedAt),
  };
}

export function toSatisfactionData(record: SatisfactionRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    ticketId: record.ticketId,
    token: record.token,
    score: record.score,
    comment: record.comment,
    requestedAt: new Date(record.requestedAt),
    respondedAt: record.respondedAt === null ? null : new Date(record.respondedAt),
  };
}

export class PrismaCsatStore implements CsatStore {
  constructor(private readonly db: CsatPrismaClient) {}

  async findByTicket(tenantId: string, ticketId: string): Promise<SatisfactionRecord | null> {
    const row = await this.db.satisfactionResponse.findFirst({ where: { tenantId, ticketId } });
    return row ? toSatisfactionRecord(row) : null;
  }

  async findByToken(token: string): Promise<SatisfactionRecord | null> {
    const row = await this.db.satisfactionResponse.findFirst({ where: { token } });
    return row ? toSatisfactionRecord(row) : null;
  }

  async listByTenant(tenantId: string): Promise<SatisfactionRecord[]> {
    const rows = await this.db.satisfactionResponse.findMany({ where: { tenantId }, orderBy: { requestedAt: "desc" } });
    return rows.map(toSatisfactionRecord);
  }

  async insert(record: SatisfactionRecord): Promise<void> {
    await this.db.satisfactionResponse.create({ data: toSatisfactionData(record) });
  }

  async update(record: SatisfactionRecord): Promise<void> {
    await this.db.satisfactionResponse.update({
      where: { id: record.id },
      data: { score: record.score, comment: record.comment, respondedAt: record.respondedAt === null ? null : new Date(record.respondedAt) },
    });
  }
}
