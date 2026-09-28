/**
 * Prisma adapter for the notification store (M1). The unique
 * `(tenantId, dedupeKey, audience)` key makes a repeated emission a no-op even
 * without the service's dedupe check.
 */

import type { EscalationAudience } from "./escalation-rules";
import type { NotificationRecord } from "./notification-rules";
import type { NotificationStore } from "./notification-service";

export interface NotificationRow {
  id: string;
  tenantId: string;
  audience: string;
  kind: string;
  title: string;
  body: string;
  ticketId: string | null;
  ticketRef: string | null;
  dedupeKey: string;
  level: number | null;
  createdAt: Date;
  readAt: Date | null;
}

export interface NotificationPrismaClient {
  notification: {
    findMany(args: unknown): Promise<NotificationRow[]>;
    /** `skipDuplicates` makes the unique dedupe key a no-op rather than a throw. */
    createMany(args: { data: unknown[]; skipDuplicates?: boolean }): Promise<{ count: number }>;
    updateMany(args: unknown): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toAudience(value: string): EscalationAudience {
  return value === "MANAGER" || value === "DISPATCHER" ? value : "AGENT";
}

export function toNotificationRecord(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    audience: toAudience(row.audience),
    kind: row.kind,
    title: row.title,
    body: row.body,
    ticketId: row.ticketId,
    ticketRef: row.ticketRef,
    dedupeKey: row.dedupeKey,
    level: row.level,
    createdAt: toIso(row.createdAt),
    readAt: row.readAt === null ? null : toIso(row.readAt),
  };
}

export function toNotificationData(record: NotificationRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    audience: record.audience,
    kind: record.kind,
    title: record.title,
    body: record.body,
    ticketId: record.ticketId,
    ticketRef: record.ticketRef,
    dedupeKey: record.dedupeKey,
    level: record.level,
    createdAt: new Date(record.createdAt),
    readAt: record.readAt === null ? null : new Date(record.readAt),
  };
}

export class PrismaNotificationStore implements NotificationStore {
  constructor(private readonly db: NotificationPrismaClient) {}

  async listForTenant(tenantId: string): Promise<NotificationRecord[]> {
    const rows = await this.db.notification.findMany({ where: { tenantId } });
    return rows.map(toNotificationRecord);
  }

  async insert(record: NotificationRecord): Promise<boolean> {
    const result = await this.db.notification.createMany({ data: [toNotificationData(record)], skipDuplicates: true });
    return result.count > 0;
  }

  async markRead(tenantId: string, id: string, at: string): Promise<void> {
    await this.db.notification.updateMany({ where: { tenantId, id }, data: { readAt: new Date(at) } });
  }

  async markAllRead(tenantId: string, audiences: readonly EscalationAudience[], at: string): Promise<void> {
    await this.db.notification.updateMany({
      where: { tenantId, audience: { in: [...audiences] }, readAt: null },
      data: { readAt: new Date(at) },
    });
  }
}
