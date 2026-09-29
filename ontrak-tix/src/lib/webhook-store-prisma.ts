/**
 * Prisma adapter for webhooks (M6).
 *
 * The port speaks domain records with epoch-millisecond clocks and a closed event
 * list; this file owns the rows, the `Date` conversions and the enum spelling, and
 * nothing here decides anything. The mappers are pure so the conversions are
 * tested without a database — a delivery whose `nextAttemptAt` came back a
 * thousand times too small would retry instantly, forever, which is the kind of
 * bug that only shows up as a bill.
 *
 * `listDueDeliveries` is the one query with a shape worth reading: it selects what
 * is *owed an attempt now*, which is a `PENDING` row (never tried) or a
 * `RETRYING` one whose `nextAttemptAt` has passed. A `DELIVERED` or `EXHAUSTED`
 * row is never in the worklist, so running the sweep twice delivers once.
 */

import {
  isWebhookEvent,
  type DeliveryStatus,
  type WebhookDeliveryRecord,
  type WebhookEndpointRecord,
  type WebhookEvent,
} from "./webhook-rules";
import type { WebhookStore } from "./webhook-service";

/* -------------------------------------------------------------------------- */
/*  Row shapes                                                                */
/* -------------------------------------------------------------------------- */

export interface WebhookEndpointRow {
  id: string;
  tenantId: string;
  name: string;
  url: string;
  events: string[] | null;
  secret: string;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  disabledAt: Date | null;
}

export interface WebhookDeliveryRow {
  id: string;
  tenantId: string;
  endpointId: string;
  event: string;
  payload: string;
  status: string;
  attemptCount: number;
  firstAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

export interface WebhookPrismaClient {
  apiWebhookEndpoint: {
    findFirst(args: unknown): Promise<WebhookEndpointRow | null>;
    findMany(args: unknown): Promise<WebhookEndpointRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
    deleteMany(args: { where: unknown }): Promise<{ count: number }>;
  };
  apiWebhookDelivery: {
    findFirst(args: unknown): Promise<WebhookDeliveryRow | null>;
    findMany(args: unknown): Promise<WebhookDeliveryRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
}

/* -------------------------------------------------------------------------- */
/*  Mappers (pure)                                                            */
/* -------------------------------------------------------------------------- */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function toMs(value: Date | string | number): number {
  if (typeof value === "number") return value;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function toMsOrNull(value: Date | string | number | null | undefined): number | null {
  return value === null || value === undefined ? null : toMs(value);
}

function asEvents(values: readonly string[] | null): WebhookEvent[] {
  return (values ?? []).filter(isWebhookEvent);
}

/** An unrecognised status is read as `EXHAUSTED`: never retried is the safe side. */
function asStatus(value: string): DeliveryStatus {
  return value === "PENDING" || value === "DELIVERED" || value === "RETRYING" ? value : "EXHAUSTED";
}

export function toEndpointRecord(row: WebhookEndpointRow): WebhookEndpointRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    url: row.url,
    events: asEvents(row.events),
    secret: row.secret,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
    disabledAt: toIsoOrNull(row.disabledAt),
  };
}

export function toDeliveryRecord(row: WebhookDeliveryRow): WebhookDeliveryRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    endpointId: row.endpointId,
    // A row whose event is no longer in our catalogue cannot be re-sent, and
    // reading it as the first event keeps the log renderable rather than throwing
    // in a list view; the status will show it as exhausted if it never landed.
    event: isWebhookEvent(row.event) ? row.event : "ticket.updated",
    payload: row.payload,
    status: asStatus(row.status),
    attemptCount: row.attemptCount,
    firstAttemptAt: toMsOrNull(row.firstAttemptAt),
    lastAttemptAt: toMsOrNull(row.lastAttemptAt),
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    nextAttemptAt: toMsOrNull(row.nextAttemptAt),
    deliveredAt: toMsOrNull(row.deliveredAt),
    createdAt: toMs(row.createdAt),
  };
}

export function toEndpointCreate(record: WebhookEndpointRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    name: record.name,
    url: record.url,
    events: [...record.events],
    secret: record.secret,
    enabled: record.enabled,
    createdBy: record.createdBy,
    createdAt: new Date(record.createdAt),
    disabledAt: record.disabledAt === null ? null : new Date(record.disabledAt),
  };
}

export function toEndpointUpdate(record: WebhookEndpointRecord) {
  return {
    name: record.name,
    url: record.url,
    events: [...record.events],
    secret: record.secret,
    enabled: record.enabled,
    disabledAt: record.disabledAt === null ? null : new Date(record.disabledAt),
  };
}

export function toDeliveryCreate(record: WebhookDeliveryRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    endpointId: record.endpointId,
    event: record.event,
    payload: record.payload,
    status: record.status,
    attemptCount: record.attemptCount,
    firstAttemptAt: record.firstAttemptAt === null ? null : new Date(record.firstAttemptAt),
    lastAttemptAt: record.lastAttemptAt === null ? null : new Date(record.lastAttemptAt),
    lastStatusCode: record.lastStatusCode,
    lastError: record.lastError,
    nextAttemptAt: record.nextAttemptAt === null ? null : new Date(record.nextAttemptAt),
    deliveredAt: record.deliveredAt === null ? null : new Date(record.deliveredAt),
    createdAt: new Date(record.createdAt),
  };
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

export class PrismaWebhookStore implements WebhookStore {
  constructor(private readonly db: WebhookPrismaClient) {}

  async insertEndpoint(record: WebhookEndpointRecord): Promise<void> {
    await this.db.apiWebhookEndpoint.create({ data: toEndpointCreate(record) });
  }

  async findEndpoint(tenantId: string, endpointId: string): Promise<WebhookEndpointRecord | null> {
    const row = await this.db.apiWebhookEndpoint.findFirst({ where: { tenantId, id: endpointId } });
    return row ? toEndpointRecord(row) : null;
  }

  async findEndpointByName(tenantId: string, name: string): Promise<WebhookEndpointRecord | null> {
    const row = await this.db.apiWebhookEndpoint.findFirst({
      where: { tenantId, name: { equals: name.trim(), mode: "insensitive" } },
    });
    return row ? toEndpointRecord(row) : null;
  }

  async listEndpoints(tenantId: string): Promise<WebhookEndpointRecord[]> {
    const rows = await this.db.apiWebhookEndpoint.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
    return rows.map(toEndpointRecord);
  }

  async updateEndpoint(record: WebhookEndpointRecord): Promise<void> {
    await this.db.apiWebhookEndpoint.update({ where: { id: record.id }, data: toEndpointUpdate(record) });
  }

  async removeEndpoint(tenantId: string, endpointId: string): Promise<void> {
    // Tenant-scoped, so a cross-tenant id deletes nothing.
    await this.db.apiWebhookEndpoint.deleteMany({ where: { tenantId, id: endpointId } });
  }

  async insertDelivery(record: WebhookDeliveryRecord): Promise<void> {
    await this.db.apiWebhookDelivery.create({ data: toDeliveryCreate(record) });
  }

  async updateDelivery(record: WebhookDeliveryRecord): Promise<void> {
    await this.db.apiWebhookDelivery.update({ where: { id: record.id }, data: toDeliveryCreate(record) });
  }

  async findDelivery(tenantId: string, deliveryId: string): Promise<WebhookDeliveryRecord | null> {
    const row = await this.db.apiWebhookDelivery.findFirst({ where: { tenantId, id: deliveryId } });
    return row ? toDeliveryRecord(row) : null;
  }

  async listDeliveries(
    tenantId: string,
    filter: { endpointId?: string; status?: DeliveryStatus; limit?: number } = {},
  ): Promise<WebhookDeliveryRecord[]> {
    const rows = await this.db.apiWebhookDelivery.findMany({
      where: {
        tenantId,
        ...(filter.endpointId === undefined ? {} : { endpointId: filter.endpointId }),
        ...(filter.status === undefined ? {} : { status: filter.status }),
      },
      orderBy: { createdAt: "desc" },
      take: filter.limit ?? 50,
    });
    return rows.map(toDeliveryRecord);
  }

  /**
   * What is owed an attempt now: never tried, or tried and waiting on a clock
   * that has passed. `tenantId` is `null` for the sweep across every tenant.
   */
  async listDueDeliveries(tenantId: string | null, nowMs: number, limit: number): Promise<WebhookDeliveryRecord[]> {
    const rows = await this.db.apiWebhookDelivery.findMany({
      where: {
        ...(tenantId === null ? {} : { tenantId }),
        status: { in: ["PENDING", "RETRYING"] },
        OR: [{ status: "PENDING" }, { nextAttemptAt: { lte: new Date(nowMs) } }],
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    return rows.map(toDeliveryRecord);
  }
}
