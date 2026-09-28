/**
 * Prisma adapter for per-user notification preferences (M1). One row per user,
 * upserted on `(tenantId, userId)`, so reading a preference is a point lookup
 * and saving one never races into duplicates.
 */

import type { NotificationPreference } from "./notification-rules";
import type { NotificationPreferenceStore } from "./notification-service";

export interface NotificationPreferenceRow {
  tenantId: string;
  userId: string;
  minLevel: number;
  muted: boolean;
  updatedAt: Date;
}

export interface NotificationPreferencePrismaClient {
  notificationPreference: {
    findFirst(args: unknown): Promise<NotificationPreferenceRow | null>;
    upsert(args: unknown): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toPreferenceRecord(row: NotificationPreferenceRow): NotificationPreference {
  return {
    tenantId: row.tenantId,
    userId: row.userId,
    minLevel: row.minLevel,
    muted: row.muted,
    updatedAt: toIso(row.updatedAt),
  };
}

export class PrismaNotificationPreferenceStore implements NotificationPreferenceStore {
  constructor(private readonly db: NotificationPreferencePrismaClient) {}

  async get(tenantId: string, userId: string): Promise<NotificationPreference | null> {
    const row = await this.db.notificationPreference.findFirst({ where: { tenantId, userId } });
    return row ? toPreferenceRecord(row) : null;
  }

  async save(preference: NotificationPreference): Promise<void> {
    const data = {
      minLevel: preference.minLevel,
      muted: preference.muted,
      updatedAt: new Date(preference.updatedAt),
    };
    await this.db.notificationPreference.upsert({
      where: { tenantId_userId: { tenantId: preference.tenantId, userId: preference.userId } },
      update: data,
      create: { tenantId: preference.tenantId, userId: preference.userId, ...data },
    });
  }
}
