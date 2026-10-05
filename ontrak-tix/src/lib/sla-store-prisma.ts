/**
 * Prisma adapter for SLA policies (M1, writable from M4).
 *
 * A policy's `calendar` is JSON, so the mapper coerces it back to a
 * `BusinessCalendar` and falls back to a safe default rather than trusting a
 * hand-edited row — a malformed calendar must not crash a sweep.
 *
 * The M4 writes are here too: a desk authors its own promises now, so the store
 * can insert, change and remove one, and it can say how many tickets are
 * measured against a policy before anybody deletes it.
 */

import { calendarWithHolidays, normalizeHolidays } from "./holiday-rules";
import { weekdayCalendar, type BusinessCalendar, type SlaPolicy } from "./sla-rules";
import type { SlaPolicyRecord, SlaPolicyStore } from "./sla-policy-service";
import type { TicketPriority } from "./ticket-rules";

export interface SlaPolicyRow {
  id: string;
  tenantId: string;
  name: string;
  priority: TicketPriority | null;
  responseMinutes: number;
  resolutionMinutes: number;
  calendar: unknown;
  warningFraction: number;
  queueId: string | null;
  /** M4: the client this policy belongs to, when it is a per-client promise. */
  clientId?: string | null;
}

export interface SlaPolicyPrismaClient {
  slaPolicy: {
    findMany(args: unknown): Promise<SlaPolicyRow[]>;
    findFirst(args: unknown): Promise<SlaPolicyRow | null>;
    create(args: unknown): Promise<SlaPolicyRow>;
    update(args: unknown): Promise<SlaPolicyRow>;
    delete(args: unknown): Promise<SlaPolicyRow>;
  };
  ticket: {
    count(args: unknown): Promise<number>;
  };
}

/**
 * A calendar is only usable if its weekly windows are well-formed.
 *
 * Its closures are re-read through the same rules that wrote them, because the
 * column is JSON: a date typed by hand into the database, or written by an older
 * build, must not put a closure the clock cannot interpret in front of a running
 * promise. A holiday that does not survive normalisation is dropped, which fails
 * towards the desk being open — the safe direction, since the alternative is a
 * promise that silently never falls due.
 */
export function asBusinessCalendar(value: unknown): BusinessCalendar {
  const candidate = value as BusinessCalendar | null;
  if (
    candidate &&
    typeof candidate === "object" &&
    Array.isArray(candidate.week) &&
    candidate.week.length === 7 &&
    typeof candidate.utcOffsetMinutes === "number"
  ) {
    return calendarWithHolidays(candidate, normalizeHolidays(candidate.holidays).dates);
  }
  return weekdayCalendar("default");
}

export function toSlaPolicy(row: SlaPolicyRow): SlaPolicyRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    priority: row.priority ?? undefined,
    responseMinutes: row.responseMinutes,
    resolutionMinutes: row.resolutionMinutes,
    calendar: asBusinessCalendar(row.calendar),
    warningFraction: row.warningFraction,
    // Kept apart rather than defaulted: `undefined` is what the resolver reads as
    // "any", so a row with no queue must not look like one scoped to "".
    queueId: row.queueId,
    clientId: row.clientId ?? null,
  };
}

/** The writable columns of a policy, so a create and an update agree. */
export function toSlaPolicyData(policy: SlaPolicyRecord): Record<string, unknown> {
  return {
    name: policy.name,
    priority: policy.priority ?? null,
    responseMinutes: policy.responseMinutes,
    resolutionMinutes: policy.resolutionMinutes,
    calendar: policy.calendar,
    warningFraction: policy.warningFraction,
    queueId: policy.queueId ?? null,
    clientId: policy.clientId ?? null,
  };
}

export class PrismaSlaPolicyStore implements SlaPolicyStore {
  constructor(private readonly db: SlaPolicyPrismaClient) {}

  async listForTenant(tenantId: string): Promise<SlaPolicyRecord[]> {
    const rows = await this.db.slaPolicy.findMany({ where: { tenantId } });
    return rows.map(toSlaPolicy);
  }

  async findById(tenantId: string, policyId: string): Promise<SlaPolicyRecord | null> {
    const row = await this.db.slaPolicy.findFirst({ where: { tenantId, id: policyId } });
    return row ? toSlaPolicy(row) : null;
  }

  /** Case-insensitive, because two promises differing in case are one argument. */
  async findByName(tenantId: string, name: string): Promise<SlaPolicyRecord | null> {
    const row = await this.db.slaPolicy.findFirst({ where: { tenantId, name: { equals: name, mode: "insensitive" } } });
    return row ? toSlaPolicy(row) : null;
  }

  async insert(record: SlaPolicyRecord): Promise<void> {
    await this.db.slaPolicy.create({ data: { id: record.id, tenantId: record.tenantId, ...toSlaPolicyData(record) } });
  }

  async update(record: SlaPolicyRecord): Promise<void> {
    await this.db.slaPolicy.update({ where: { id: record.id }, data: toSlaPolicyData(record) });
  }

  async remove(tenantId: string, policyId: string): Promise<void> {
    await this.db.slaPolicy.delete({ where: { id: policyId, tenantId } });
  }

  async countTickets(tenantId: string, policyId: string): Promise<number> {
    return this.db.ticket.count({ where: { tenantId, slaPolicyId: policyId } });
  }
}
