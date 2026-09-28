/**
 * Prisma adapter for time entries and rate cards (M4).
 *
 * Same split as the other adapters: the port (`TimeStore`) speaks domain records
 * with ISO strings, this file owns the rows and the `Date` conversions, and
 * nothing here decides anything.
 *
 * Two conversions are worth naming. A `workDate` is a *day*, so it is stored as
 * midnight UTC and read back as `YYYY-MM-DD` — a timesheet must not move a day
 * because somebody's server is in another timezone. And an invoice reference is
 * text on the entry rather than a foreign key, because an invoice is a fact
 * about the past: it must survive the entry being regrouped or a client renamed.
 */

import type { TimeEntryRecord, RateCardRecord } from "./time-rules";
import type { TimeFilters, TimeStore } from "./time-service";

export interface TimeEntryRow {
  id: string;
  tenantId: string;
  ticketId: string | null;
  clientId: string | null;
  userId: string;
  workDate: Date;
  minutes: number;
  billedMinutes: number | null;
  billable: boolean;
  rateCardId: string | null;
  rateCentsPerHour: number | null;
  rateIncrementMinutes: number | null;
  currency: string | null;
  note: string | null;
  invoicedAt: Date | null;
  invoiceRef: string | null;
  createdAt: Date;
  updatedAt: Date;
  ticket?: { ref: string } | null;
}

export interface RateCardRow {
  id: string;
  tenantId: string;
  clientId: string | null;
  name: string;
  currency: string;
  hourlyRateCents: number;
  incrementMinutes: number;
  updatedAt: Date;
}

export interface TimePrismaClient {
  timeEntry: {
    findMany(args: unknown): Promise<TimeEntryRow[]>;
    findFirst(args: unknown): Promise<TimeEntryRow | null>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
    deleteMany(args: { where: unknown }): Promise<unknown>;
  };
  rateCard: {
    findMany(args: unknown): Promise<RateCardRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
    deleteMany(args: { where: unknown }): Promise<unknown>;
  };
  ticket: {
    findFirst(args: unknown): Promise<{ ref: string; clientId: string | null } | null>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

/** A day, not an instant: `2026-09-20`. */
export function toWorkDate(value: Date | string): string {
  return toIso(value).slice(0, 10);
}

export function fromWorkDate(workDate: string): Date {
  return new Date(`${workDate}T00:00:00.000Z`);
}

export function toTimeEntryRecord(row: TimeEntryRow): TimeEntryRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ticketId: row.ticketId,
    ticketRef: row.ticket?.ref ?? null,
    clientId: row.clientId,
    userId: row.userId,
    workDate: toWorkDate(row.workDate),
    minutes: row.minutes,
    billedMinutes: row.billedMinutes,
    billable: row.billable,
    rateCardId: row.rateCardId,
    rateCentsPerHour: row.rateCentsPerHour,
    rateIncrementMinutes: row.rateIncrementMinutes,
    currency: row.currency,
    note: row.note,
    invoicedAt: toIsoOrNull(row.invoicedAt),
    invoiceRef: row.invoiceRef,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toRateCardRecord(row: RateCardRow): RateCardRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    clientId: row.clientId,
    name: row.name,
    currency: row.currency,
    hourlyRateCents: row.hourlyRateCents,
    incrementMinutes: row.incrementMinutes,
    updatedAt: toIso(row.updatedAt),
  };
}

/** The writable columns of an entry, so a create and a change agree. */
export function toTimeEntryData(record: TimeEntryRecord): Record<string, unknown> {
  return {
    tenantId: record.tenantId,
    ticketId: record.ticketId,
    clientId: record.clientId,
    userId: record.userId,
    workDate: fromWorkDate(record.workDate),
    minutes: record.minutes,
    billedMinutes: record.billedMinutes,
    billable: record.billable,
    rateCardId: record.rateCardId,
    rateCentsPerHour: record.rateCentsPerHour,
    rateIncrementMinutes: record.rateIncrementMinutes,
    currency: record.currency,
    note: record.note,
    invoicedAt: record.invoicedAt === null ? null : new Date(record.invoicedAt),
    invoiceRef: record.invoiceRef,
  };
}

export class PrismaTimeStore implements TimeStore {
  constructor(private readonly db: TimePrismaClient) {}

  async findTicket(tenantId: string, ticketId: string): Promise<{ ref: string; clientId: string | null } | null> {
    return this.db.ticket.findFirst({ where: { tenantId, id: ticketId }, select: { ref: true, clientId: true } });
  }

  async listEntries(tenantId: string, filters: TimeFilters = {}): Promise<TimeEntryRecord[]> {
    const where: Record<string, unknown> = { tenantId };
    if (filters.clientId !== undefined) where.clientId = filters.clientId;
    if (filters.ticketId !== undefined) where.ticketId = filters.ticketId;
    if (filters.userId !== undefined) where.userId = filters.userId;
    if (filters.invoiceRef !== undefined) where.invoiceRef = filters.invoiceRef;
    if (filters.from !== undefined || filters.to !== undefined) {
      where.workDate = {
        ...(filters.from === undefined ? {} : { gte: fromWorkDate(filters.from) }),
        ...(filters.to === undefined ? {} : { lte: fromWorkDate(filters.to) }),
      };
    }

    const rows = await this.db.timeEntry.findMany({
      where,
      include: { ticket: { select: { ref: true } } },
      orderBy: [{ workDate: "asc" }, { createdAt: "asc" }],
    });
    return rows.map(toTimeEntryRecord);
  }

  async findEntry(tenantId: string, entryId: string): Promise<TimeEntryRecord | null> {
    const row = await this.db.timeEntry.findFirst({
      where: { tenantId, id: entryId },
      include: { ticket: { select: { ref: true } } },
    });
    return row ? toTimeEntryRecord(row) : null;
  }

  async insertEntry(record: TimeEntryRecord): Promise<void> {
    await this.db.timeEntry.create({ data: { id: record.id, ...toTimeEntryData(record) } });
  }

  async updateEntry(record: TimeEntryRecord): Promise<void> {
    await this.db.timeEntry.update({ where: { id: record.id }, data: toTimeEntryData(record) });
  }

  async removeEntry(tenantId: string, entryId: string): Promise<void> {
    await this.db.timeEntry.deleteMany({ where: { tenantId, id: entryId } });
  }

  async listRateCards(tenantId: string): Promise<RateCardRecord[]> {
    const rows = await this.db.rateCard.findMany({ where: { tenantId }, orderBy: { updatedAt: "desc" } });
    return rows.map(toRateCardRecord);
  }

  async insertRateCard(record: RateCardRecord): Promise<void> {
    await this.db.rateCard.create({ data: { id: record.id, ...rateCardData(record) } });
  }

  async updateRateCard(record: RateCardRecord): Promise<void> {
    await this.db.rateCard.update({ where: { id: record.id }, data: rateCardData(record) });
  }

  async removeRateCard(tenantId: string, cardId: string): Promise<void> {
    await this.db.rateCard.deleteMany({ where: { tenantId, id: cardId } });
  }
}

function rateCardData(record: RateCardRecord): Record<string, unknown> {
  return {
    tenantId: record.tenantId,
    clientId: record.clientId,
    name: record.name,
    currency: record.currency,
    hourlyRateCents: record.hourlyRateCents,
    incrementMinutes: record.incrementMinutes,
  };
}
