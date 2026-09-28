/**
 * Prisma adapter for SLA policies (M1).
 *
 * A policy's `calendar` is JSON, so the mapper coerces it back to a
 * `BusinessCalendar` and falls back to a safe default rather than trusting a
 * hand-edited row — a malformed calendar must not crash a sweep.
 */

import { weekdayCalendar, type BusinessCalendar, type SlaPolicy } from "./sla-rules";
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
  };
}

/** A calendar is only usable if its weekly windows are well-formed. */
export function asBusinessCalendar(value: unknown): BusinessCalendar {
  const candidate = value as BusinessCalendar | null;
  if (
    candidate &&
    typeof candidate === "object" &&
    Array.isArray(candidate.week) &&
    candidate.week.length === 7 &&
    typeof candidate.utcOffsetMinutes === "number"
  ) {
    return candidate;
  }
  return weekdayCalendar("default");
}

export function toSlaPolicy(row: SlaPolicyRow): SlaPolicy {
  return {
    id: row.id,
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

export class PrismaSlaPolicyStore {
  constructor(private readonly db: SlaPolicyPrismaClient) {}

  async listForTenant(tenantId: string): Promise<SlaPolicy[]> {
    const rows = await this.db.slaPolicy.findMany({ where: { tenantId } });
    return rows.map(toSlaPolicy);
  }
}
