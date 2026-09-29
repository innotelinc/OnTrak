/**
 * Prisma adapter for chat notifications (M6).
 *
 * The same split as every other adapter here: the port speaks domain records with
 * ISO strings and epoch-millisecond clocks, this file owns the rows, the `Date`
 * conversions and the enum spelling, and nothing here decides anything. The mappers
 * are pure, so the conversions are tested without a database.
 *
 * Two spellings are worth reading. A `provider` this deployment does not implement
 * maps to `null` and the row is *not returned*: handing the service a provider it
 * cannot render for is a worse failure than "that channel is not one we post to".
 * And an unrecognised delivery status reads as `EXHAUSTED` — never retried is the
 * safe side, for the same reason the webhook adapter reads it that way.
 */

import { isChatProvider, type ChatChannelRecord, type ChatDeliveryEvent, type ChatDeliveryRecord } from "./chat-notify-rules";
import type { ChatStore } from "./chat-notify-service";
import { isWebhookEvent, type DeliveryStatus } from "./webhook-rules";

/* -------------------------------------------------------------------------- */
/*  Row shapes                                                                */
/* -------------------------------------------------------------------------- */

export interface ChatChannelRow {
  id: string;
  tenantId: string;
  provider: string;
  name: string;
  url: string;
  events: string[] | null;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  disabledAt: Date | null;
}

export interface ChatDeliveryRow {
  id: string;
  tenantId: string;
  channelId: string;
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

export interface ChatPrismaClient {
  chatChannel: {
    findFirst(args: unknown): Promise<ChatChannelRow | null>;
    findMany(args: unknown): Promise<ChatChannelRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
    deleteMany(args: { where: unknown }): Promise<{ count: number }>;
  };
  chatDelivery: {
    findFirst(args: unknown): Promise<ChatDeliveryRow | null>;
    findMany(args: unknown): Promise<ChatDeliveryRow[]>;
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

function asEvents(values: readonly string[] | null) {
  return (values ?? []).filter(isWebhookEvent);
}

/** An unrecognised status is read as `EXHAUSTED`: never retried is the safe side. */
function asStatus(value: string): DeliveryStatus {
  return value === "PENDING" || value === "DELIVERED" || value === "RETRYING" ? value : "EXHAUSTED";
}

/** A delivery event is a subscribable event or the console's test message. */
function asDeliveryEvent(value: string): ChatDeliveryEvent {
  return isWebhookEvent(value) ? value : "test";
}

export function toChannelRecord(row: ChatChannelRow): ChatChannelRecord | null {
  if (!isChatProvider(row.provider)) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    provider: row.provider,
    name: row.name,
    url: row.url,
    events: asEvents(row.events),
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
    disabledAt: toIsoOrNull(row.disabledAt),
  };
}

export function toDeliveryRecord(row: ChatDeliveryRow): ChatDeliveryRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    channelId: row.channelId,
    event: asDeliveryEvent(row.event),
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

export function toChannelCreate(record: ChatChannelRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    provider: record.provider,
    name: record.name,
    url: record.url,
    events: [...record.events],
    enabled: record.enabled,
    createdBy: record.createdBy,
    createdAt: new Date(record.createdAt),
    disabledAt: record.disabledAt === null ? null : new Date(record.disabledAt),
  };
}

/** Only the fields a change may touch. A channel's provider is decided once. */
export function toChannelUpdate(record: ChatChannelRecord) {
  return {
    name: record.name,
    url: record.url,
    events: [...record.events],
    enabled: record.enabled,
    disabledAt: record.disabledAt === null ? null : new Date(record.disabledAt),
  };
}

export function toDeliveryCreate(record: ChatDeliveryRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    channelId: record.channelId,
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

export class PrismaChatStore implements ChatStore {
  constructor(private readonly db: ChatPrismaClient) {}

  async insertChannel(record: ChatChannelRecord): Promise<void> {
    await this.db.chatChannel.create({ data: toChannelCreate(record) });
  }

  async findChannel(tenantId: string, channelId: string): Promise<ChatChannelRecord | null> {
    const row = await this.db.chatChannel.findFirst({ where: { tenantId, id: channelId } });
    return row ? toChannelRecord(row) : null;
  }

  async findChannelByName(tenantId: string, name: string): Promise<ChatChannelRecord | null> {
    const row = await this.db.chatChannel.findFirst({
      where: { tenantId, name: { equals: name.trim(), mode: "insensitive" } },
    });
    return row ? toChannelRecord(row) : null;
  }

  async listChannels(tenantId: string): Promise<ChatChannelRecord[]> {
    const rows = await this.db.chatChannel.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
    return rows.map(toChannelRecord).filter((record): record is ChatChannelRecord => record !== null);
  }

  async updateChannel(record: ChatChannelRecord): Promise<void> {
    await this.db.chatChannel.update({ where: { id: record.id }, data: toChannelUpdate(record) });
  }

  async removeChannel(tenantId: string, channelId: string): Promise<void> {
    // Tenant-scoped, so a cross-tenant id deletes nothing.
    await this.db.chatChannel.deleteMany({ where: { tenantId, id: channelId } });
  }

  async insertDelivery(record: ChatDeliveryRecord): Promise<void> {
    await this.db.chatDelivery.create({ data: toDeliveryCreate(record) });
  }

  async updateDelivery(record: ChatDeliveryRecord): Promise<void> {
    await this.db.chatDelivery.update({ where: { id: record.id }, data: toDeliveryCreate(record) });
  }

  async findDelivery(tenantId: string, deliveryId: string): Promise<ChatDeliveryRecord | null> {
    const row = await this.db.chatDelivery.findFirst({ where: { tenantId, id: deliveryId } });
    return row ? toDeliveryRecord(row) : null;
  }

  async listDeliveries(
    tenantId: string,
    filter: { channelId?: string; status?: DeliveryStatus; limit?: number } = {},
  ): Promise<ChatDeliveryRecord[]> {
    const rows = await this.db.chatDelivery.findMany({
      where: {
        tenantId,
        ...(filter.channelId === undefined ? {} : { channelId: filter.channelId }),
        ...(filter.status === undefined ? {} : { status: filter.status }),
      },
      orderBy: { createdAt: "desc" },
      take: filter.limit ?? 50,
    });
    return rows.map(toDeliveryRecord);
  }

  /** What is owed an attempt now: never tried, or tried and waiting on a passed clock. */
  async listDueDeliveries(tenantId: string | null, nowMs: number, limit: number): Promise<ChatDeliveryRecord[]> {
    const rows = await this.db.chatDelivery.findMany({
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
