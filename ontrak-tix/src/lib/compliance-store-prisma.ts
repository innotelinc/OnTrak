/**
 * Prisma adapter for the compliance store (M3).
 *
 * The two enums (`NotificationStatus`, `ReviewActionStatus`) and the two
 * narrowed string columns (`clock`, `regime`) are all narrowed on the way out,
 * so a value that predates a vocabulary change degrades to a safe default
 * instead of leaking `string` into the rules. Structural, like the other
 * adapters: the service never sees a generated Prisma type.
 */

import type { CompliancePage, ComplianceStore } from "./compliance-service";
import {
  NOTIFICATION_STATUSES,
  type NotificationClock,
  type NotificationObligation,
  type NotificationStatus,
} from "./regulatory-rules";
import {
  REVIEW_ACTION_STATUSES,
  type ReviewActionRecord,
  type ReviewActionStatus,
  type ReviewRecord,
} from "./review-rules";

export interface NotificationRow {
  id: string;
  tenantId: string;
  incidentId: string;
  regime: string;
  label: string;
  authority: string;
  requirement: string;
  clock: string;
  dueAt: Date;
  status: string;
  sentAt: Date | null;
  sentBy: string | null;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  reference: string | null;
  note: string | null;
  message: string | null;
  waivedAt: Date | null;
  waivedBy: string | null;
  waiverReason: string | null;
  createdAt: Date;
}

export interface ReviewRow {
  id: string;
  tenantId: string;
  incidentId: string;
  findings: string;
  lessons: string | null;
  publishedBy: string;
  publishedAt: Date;
}

export interface ReviewActionRow {
  id: string;
  tenantId: string;
  incidentId: string;
  reviewId: string;
  title: string;
  ownerId: string;
  dueAt: Date;
  status: string;
  note: string | null;
  completedAt: Date | null;
  completedBy: string | null;
  createdAt: Date;
}

export interface CompliancePrismaClient {
  incidentNotification: {
    findFirst(args: unknown): Promise<NotificationRow | null>;
    findMany(args: unknown): Promise<NotificationRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
  incidentReview: {
    findFirst(args: unknown): Promise<ReviewRow | null>;
    findMany(args: unknown): Promise<ReviewRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
  };
  incidentReviewAction: {
    findFirst(args: unknown): Promise<ReviewActionRow | null>;
    findMany(args: unknown): Promise<ReviewActionRow[]>;
    createMany(args: { data: unknown[] }): Promise<unknown>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function toNotificationStatus(value: string): NotificationStatus {
  return oneOf(value, NOTIFICATION_STATUSES, "PENDING");
}

export function toClock(value: string): NotificationClock {
  return value === "detected" ? "detected" : "declared";
}

export function toActionStatus(value: string): ReviewActionStatus {
  return oneOf(value, REVIEW_ACTION_STATUSES, "OPEN");
}

export function toNotificationObligation(row: NotificationRow): NotificationObligation {
  return {
    id: row.id,
    tenantId: row.tenantId,
    incidentId: row.incidentId,
    regime: row.regime,
    label: row.label,
    authority: row.authority,
    requirement: row.requirement,
    clock: toClock(row.clock),
    dueAt: toIso(row.dueAt),
    status: toNotificationStatus(row.status),
    sentAt: toIsoOrNull(row.sentAt),
    sentBy: row.sentBy,
    acknowledgedAt: toIsoOrNull(row.acknowledgedAt),
    acknowledgedBy: row.acknowledgedBy,
    reference: row.reference,
    note: row.note,
    message: row.message,
    waivedAt: toIsoOrNull(row.waivedAt),
    waivedBy: row.waivedBy,
    waiverReason: row.waiverReason,
    createdAt: toIso(row.createdAt),
  };
}

export function toNotificationData(obligation: NotificationObligation) {
  return {
    id: obligation.id,
    tenantId: obligation.tenantId,
    incidentId: obligation.incidentId,
    regime: obligation.regime,
    label: obligation.label,
    authority: obligation.authority,
    requirement: obligation.requirement,
    clock: obligation.clock,
    dueAt: new Date(obligation.dueAt),
    status: obligation.status,
    sentAt: obligation.sentAt === null ? null : new Date(obligation.sentAt),
    sentBy: obligation.sentBy,
    acknowledgedAt: obligation.acknowledgedAt === null ? null : new Date(obligation.acknowledgedAt),
    acknowledgedBy: obligation.acknowledgedBy,
    reference: obligation.reference,
    note: obligation.note,
    message: obligation.message,
    waivedAt: obligation.waivedAt === null ? null : new Date(obligation.waivedAt),
    waivedBy: obligation.waivedBy,
    waiverReason: obligation.waiverReason,
    createdAt: new Date(obligation.createdAt),
  };
}

export function toReviewRecord(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    incidentId: row.incidentId,
    findings: row.findings,
    lessons: row.lessons,
    publishedBy: row.publishedBy,
    publishedAt: toIso(row.publishedAt),
  };
}

export function toReviewData(review: ReviewRecord) {
  return {
    id: review.id,
    tenantId: review.tenantId,
    incidentId: review.incidentId,
    findings: review.findings,
    lessons: review.lessons,
    publishedBy: review.publishedBy,
    publishedAt: new Date(review.publishedAt),
  };
}

export function toReviewActionRecord(row: ReviewActionRow): ReviewActionRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    incidentId: row.incidentId,
    reviewId: row.reviewId,
    title: row.title,
    ownerId: row.ownerId,
    dueAt: toIso(row.dueAt),
    status: toActionStatus(row.status),
    note: row.note,
    completedAt: toIsoOrNull(row.completedAt),
    completedBy: row.completedBy,
    createdAt: toIso(row.createdAt),
  };
}

export function toReviewActionData(action: ReviewActionRecord) {
  return {
    id: action.id,
    tenantId: action.tenantId,
    incidentId: action.incidentId,
    reviewId: action.reviewId,
    title: action.title,
    ownerId: action.ownerId,
    dueAt: new Date(action.dueAt),
    status: action.status,
    note: action.note,
    completedAt: action.completedAt === null ? null : new Date(action.completedAt),
    completedBy: action.completedBy,
    createdAt: new Date(action.createdAt),
  };
}

export class PrismaComplianceStore implements ComplianceStore {
  constructor(private readonly db: CompliancePrismaClient) {}

  async insertNotification(obligation: NotificationObligation): Promise<void> {
    await this.db.incidentNotification.create({ data: toNotificationData(obligation) });
  }

  async findNotification(tenantId: string, notificationId: string): Promise<NotificationObligation | null> {
    const row = await this.db.incidentNotification.findFirst({ where: { id: notificationId, tenantId } });
    return row ? toNotificationObligation(row) : null;
  }

  async findNotificationByRegime(tenantId: string, incidentId: string, regime: string): Promise<NotificationObligation | null> {
    const row = await this.db.incidentNotification.findFirst({ where: { tenantId, incidentId, regime } });
    return row ? toNotificationObligation(row) : null;
  }

  async updateNotification(obligation: NotificationObligation): Promise<void> {
    await this.db.incidentNotification.update({ where: { id: obligation.id }, data: toNotificationData(obligation) });
  }

  async listNotifications(tenantId: string, incidentId: string): Promise<NotificationObligation[]> {
    const rows = await this.db.incidentNotification.findMany({ where: { tenantId, incidentId }, orderBy: { dueAt: "asc" } });
    return rows.map(toNotificationObligation);
  }

  async insertReview(review: ReviewRecord): Promise<void> {
    await this.db.incidentReview.create({ data: toReviewData(review) });
  }

  async findReview(tenantId: string, incidentId: string): Promise<ReviewRecord | null> {
    const row = await this.db.incidentReview.findFirst({ where: { tenantId, incidentId } });
    return row ? toReviewRecord(row) : null;
  }

  async insertActions(actions: ReviewActionRecord[]): Promise<void> {
    if (actions.length === 0) return;
    await this.db.incidentReviewAction.createMany({ data: actions.map(toReviewActionData) });
  }

  async insertAction(action: ReviewActionRecord): Promise<void> {
    await this.db.incidentReviewAction.create({ data: toReviewActionData(action) });
  }

  async findAction(tenantId: string, actionId: string): Promise<ReviewActionRecord | null> {
    const row = await this.db.incidentReviewAction.findFirst({ where: { id: actionId, tenantId } });
    return row ? toReviewActionRecord(row) : null;
  }

  async listActions(tenantId: string, incidentId: string): Promise<ReviewActionRecord[]> {
    const rows = await this.db.incidentReviewAction.findMany({
      where: { tenantId, incidentId },
      orderBy: [{ dueAt: "asc" }, { title: "asc" }],
    });
    return rows.map(toReviewActionRecord);
  }

  async updateAction(action: ReviewActionRecord): Promise<void> {
    await this.db.incidentReviewAction.update({ where: { id: action.id }, data: toReviewActionData(action) });
  }

  /** Every listed incident's duties, review and actions in three queries. */
  async listPages(tenantId: string, incidentIds: readonly string[]): Promise<Map<string, CompliancePage>> {
    const pages = new Map<string, CompliancePage>();
    if (incidentIds.length === 0) return pages;
    const ids = [...incidentIds];

    const [notifications, reviews, actions] = await Promise.all([
      this.db.incidentNotification.findMany({ where: { tenantId, incidentId: { in: ids } }, orderBy: { dueAt: "asc" } }),
      this.db.incidentReview.findMany({ where: { tenantId, incidentId: { in: ids } } }),
      this.db.incidentReviewAction.findMany({
        where: { tenantId, incidentId: { in: ids } },
        orderBy: [{ dueAt: "asc" }, { title: "asc" }],
      }),
    ]);

    const reviewByIncident = new Map(reviews.map((row) => [row.incidentId, toReviewRecord(row)]));
    for (const id of ids) pages.set(id, { notifications: [], review: reviewByIncident.get(id) ?? null, actions: [] });
    for (const row of notifications) pages.get(row.incidentId)?.notifications.push(toNotificationObligation(row));
    for (const row of actions) pages.get(row.incidentId)?.actions.push(toReviewActionRecord(row));
    return pages;
  }
}
