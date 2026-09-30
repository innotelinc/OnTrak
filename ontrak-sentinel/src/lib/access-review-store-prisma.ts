/**
 * Prisma adapters (S2): the concrete side of the `AccessReviewStore` port.
 *
 * The same shape as every other adapter in the family, for the same reason: the Prisma
 * client is described **structurally** rather than imported from a generated one, so this
 * file typechecks and its tests run with no database and no generated client, and the
 * mappers are pure functions a test can drive with real rows.
 *
 * Three things worth stating out loud:
 *
 *  - **Every read is tenant-scoped in the `where`, not filtered afterwards.** A review
 *    belonging to another organization is simply not there, which is the same posture the
 *    rest of the schema takes and the reason every table carries `organizationId`.
 *  - **`decision` and `status` are narrowed on read, with an unknown value falling back to
 *    the cautious one.** An unrecognised decision becomes `PENDING` and an unrecognised
 *    status becomes `OPEN` — never `KEPT` and never `COMPLETED`. A row this code does not
 *    understand must never read as somebody having approved something.
 *  - **`dueSchedules` is deliberately not tenant-scoped.** It is the one query the
 *    scheduler makes, and the scheduler answers to no organization: it asks what is due
 *    everywhere. It is also the only read here that filters on `enabled`, because a paused
 *    schedule returning from a query is how a pause quietly stops working.
 */

import type {
  AccessReviewGroupRecord,
  AccessReviewItemRecord,
  AccessReviewRecord,
  AccessReviewScheduleRecord,
  AccessReviewStore,
} from "./access-review-service";
import type { AccessReviewDecision, AccessReviewScope, AccessReviewStatus } from "./access-review-rules";

/* -------------------------------------------------------------------------- */
/*  Row shapes                                                                */
/* -------------------------------------------------------------------------- */

export interface AccessReviewRow {
  id: string;
  organizationId: string;
  name: string;
  scopeKind: string;
  scopeValue: string;
  reviewerId: string;
  dueAt: Date | string;
  status: string;
  scheduleId: string | null;
  createdBy: string;
  createdAt: Date | string;
  completedAt: Date | string | null;
}

export interface AccessReviewItemRow {
  id: string;
  organizationId: string;
  reviewId: string;
  identityId: string;
  decision: string;
  decidedBy: string | null;
  decidedAt: Date | string | null;
  note: string | null;
}

export interface AccessReviewScheduleRow {
  id: string;
  organizationId: string;
  name: string;
  scopeKind: string;
  scopeValue: string;
  reviewerId: string;
  intervalDays: number;
  nextRunAt: Date | string;
  lastRunAt: Date | string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface GroupMemberRow {
  identityId: string;
}

export interface GroupRow {
  id: string;
  displayName: string;
}

/* -------------------------------------------------------------------------- */
/*  Mappers (pure)                                                            */
/* -------------------------------------------------------------------------- */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toOptionalIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

/** Unknown scope kinds read as the narrower one, so a bad row cannot widen a review. */
function scopeOf(value: string): AccessReviewScope {
  return value === "GROUP" ? "GROUP" : "ORGANIZATION";
}

function statusOf(value: string): AccessReviewStatus {
  if (value === "COMPLETED") return "COMPLETED";
  if (value === "CANCELLED") return "CANCELLED";
  return "OPEN";
}

/**
 * Anything unrecognised is `PENDING`. This is the one direction the fallback must go: a
 * value this code does not know must not be reported as an approval.
 */
function decisionOf(value: string): AccessReviewDecision {
  if (value === "KEPT") return "KEPT";
  if (value === "REVOKED") return "REVOKED";
  return "PENDING";
}

export function toReviewRecord(row: AccessReviewRow): AccessReviewRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    scopeKind: scopeOf(row.scopeKind),
    scopeValue: row.scopeValue,
    reviewerId: row.reviewerId,
    dueAt: toIso(row.dueAt),
    status: statusOf(row.status),
    scheduleId: row.scheduleId,
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
    completedAt: toOptionalIso(row.completedAt),
  };
}

export function toReviewCreate(record: AccessReviewRecord) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    name: record.name,
    scopeKind: record.scopeKind,
    scopeValue: record.scopeValue,
    reviewerId: record.reviewerId,
    dueAt: new Date(record.dueAt),
    status: record.status,
    scheduleId: record.scheduleId,
    createdBy: record.createdBy,
    createdAt: new Date(record.createdAt),
    completedAt: record.completedAt === null ? null : new Date(record.completedAt),
  };
}

/**
 * The mutable half. Identity and scope are *not* here: changing either after the list was
 * snapshotted would leave items that no longer correspond to the review they are on, and
 * the review is the record of what was asked.
 */
export function toReviewUpdate(record: AccessReviewRecord) {
  return {
    name: record.name,
    dueAt: new Date(record.dueAt),
    status: record.status,
    completedAt: record.completedAt === null ? null : new Date(record.completedAt),
  };
}

export function toItemRecord(row: AccessReviewItemRow): AccessReviewItemRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    reviewId: row.reviewId,
    identityId: row.identityId,
    decision: decisionOf(row.decision),
    decidedBy: row.decidedBy,
    decidedAt: toOptionalIso(row.decidedAt),
    note: row.note,
  };
}

export function toItemCreate(record: AccessReviewItemRecord) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    reviewId: record.reviewId,
    identityId: record.identityId,
    decision: record.decision,
    decidedBy: record.decidedBy,
    decidedAt: record.decidedAt === null ? null : new Date(record.decidedAt),
    note: record.note,
  };
}

/** Only the decision moves on an item: who it is about is what the review fixed. */
export function toItemUpdate(record: AccessReviewItemRecord) {
  return {
    decision: record.decision,
    decidedBy: record.decidedBy,
    decidedAt: record.decidedAt === null ? null : new Date(record.decidedAt),
    note: record.note,
  };
}

export function toScheduleRecord(row: AccessReviewScheduleRow): AccessReviewScheduleRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    scopeKind: scopeOf(row.scopeKind),
    scopeValue: row.scopeValue,
    reviewerId: row.reviewerId,
    intervalDays: row.intervalDays,
    nextRunAt: toIso(row.nextRunAt),
    lastRunAt: toOptionalIso(row.lastRunAt),
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toScheduleCreate(record: AccessReviewScheduleRecord) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    name: record.name,
    scopeKind: record.scopeKind,
    scopeValue: record.scopeValue,
    reviewerId: record.reviewerId,
    intervalDays: record.intervalDays,
    nextRunAt: new Date(record.nextRunAt),
    lastRunAt: record.lastRunAt === null ? null : new Date(record.lastRunAt),
    enabled: record.enabled,
    createdBy: record.createdBy,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

export function toScheduleUpdate(record: AccessReviewScheduleRecord) {
  return {
    name: record.name,
    scopeKind: record.scopeKind,
    scopeValue: record.scopeValue,
    reviewerId: record.reviewerId,
    intervalDays: record.intervalDays,
    nextRunAt: new Date(record.nextRunAt),
    lastRunAt: record.lastRunAt === null ? null : new Date(record.lastRunAt),
    enabled: record.enabled,
    updatedAt: new Date(record.updatedAt),
  };
}

/* -------------------------------------------------------------------------- */
/*  The structural Prisma surface                                             */
/* -------------------------------------------------------------------------- */

export interface AccessReviewPrismaClient {
  accessReview: {
    findMany(args: unknown): Promise<AccessReviewRow[]>;
    findFirst(args: unknown): Promise<AccessReviewRow | null>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
  accessReviewItem: {
    findMany(args: unknown): Promise<AccessReviewItemRow[]>;
    findFirst(args: unknown): Promise<AccessReviewItemRow | null>;
    createMany(args: { data: unknown[] }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
  accessReviewSchedule: {
    findMany(args: unknown): Promise<AccessReviewScheduleRow[]>;
    findFirst(args: unknown): Promise<AccessReviewScheduleRow | null>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
    deleteMany(args: { where: unknown }): Promise<unknown>;
  };
  groupMember: {
    findMany(args: unknown): Promise<GroupMemberRow[]>;
  };
  group: {
    findMany(args: unknown): Promise<GroupRow[]>;
  };
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

export class PrismaAccessReviewStore implements AccessReviewStore {
  constructor(private readonly db: AccessReviewPrismaClient) {}

  async listReviews(organizationId: string): Promise<AccessReviewRecord[]> {
    const rows = await this.db.accessReview.findMany({
      where: { organizationId },
      orderBy: { dueAt: "asc" },
    });
    return rows.map(toReviewRecord);
  }

  async findReview(organizationId: string, reviewId: string): Promise<AccessReviewRecord | null> {
    const row = await this.db.accessReview.findFirst({ where: { organizationId, id: reviewId } });
    return row ? toReviewRecord(row) : null;
  }

  async insertReview(record: AccessReviewRecord): Promise<void> {
    await this.db.accessReview.create({ data: toReviewCreate(record) });
  }

  async updateReview(record: AccessReviewRecord): Promise<void> {
    await this.db.accessReview.update({ where: { id: record.id }, data: toReviewUpdate(record) });
  }

  async listItems(organizationId: string, reviewId: string): Promise<AccessReviewItemRecord[]> {
    const rows = await this.db.accessReviewItem.findMany({ where: { organizationId, reviewId } });
    return rows.map(toItemRecord);
  }

  /**
   * The whole organization's items at once. The console's list page needs a count per
   * review, and asking per review would be one query per row on a page that can hold
   * every review an organization has ever opened.
   */
  async listItemsForOrganization(organizationId: string): Promise<AccessReviewItemRecord[]> {
    const rows = await this.db.accessReviewItem.findMany({ where: { organizationId } });
    return rows.map(toItemRecord);
  }

  async findItem(organizationId: string, reviewId: string, identityId: string): Promise<AccessReviewItemRecord | null> {
    const row = await this.db.accessReviewItem.findFirst({ where: { organizationId, reviewId, identityId } });
    return row ? toItemRecord(row) : null;
  }

  /** One insert for the whole snapshot: a review's list is written or not written. */
  async insertItems(records: readonly AccessReviewItemRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.db.accessReviewItem.createMany({ data: records.map(toItemCreate) });
  }

  async updateItem(record: AccessReviewItemRecord): Promise<void> {
    await this.db.accessReviewItem.update({
      where: { reviewId_identityId: { reviewId: record.reviewId, identityId: record.identityId } },
      data: toItemUpdate(record),
    });
  }

  async listSchedules(organizationId: string): Promise<AccessReviewScheduleRecord[]> {
    const rows = await this.db.accessReviewSchedule.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
    });
    return rows.map(toScheduleRecord);
  }

  async findSchedule(organizationId: string, scheduleId: string): Promise<AccessReviewScheduleRecord | null> {
    const row = await this.db.accessReviewSchedule.findFirst({ where: { organizationId, id: scheduleId } });
    return row ? toScheduleRecord(row) : null;
  }

  async insertSchedule(record: AccessReviewScheduleRecord): Promise<void> {
    await this.db.accessReviewSchedule.create({ data: toScheduleCreate(record) });
  }

  async updateSchedule(record: AccessReviewScheduleRecord): Promise<void> {
    await this.db.accessReviewSchedule.update({ where: { id: record.id }, data: toScheduleUpdate(record) });
  }

  /**
   * A real delete, unlike an identity's. A schedule holds no decisions — the reviews it
   * already opened are the evidence, and their `scheduleId` is set to null rather than
   * cascading, so removing a schedule cannot take a review with it.
   */
  async removeSchedule(organizationId: string, scheduleId: string): Promise<void> {
    // `deleteMany` with the tenant in the `where`, rather than `delete` by primary key: the
    // row is named by an id a caller supplied, and a delete that trusted it would let one
    // organization's id remove another's schedule. `delete` cannot express this, because the
    // schema's compound unique is `(organizationId, name)` and not `(organizationId, id)`.
    await this.db.accessReviewSchedule.deleteMany({ where: { organizationId, id: scheduleId } });
  }

  async dueSchedules(nowIso: string): Promise<AccessReviewScheduleRecord[]> {
    const rows = await this.db.accessReviewSchedule.findMany({
      where: { enabled: true, nextRunAt: { lte: new Date(nowIso) } },
      orderBy: { nextRunAt: "asc" },
    });
    return rows.map(toScheduleRecord);
  }

  async listGroupMemberIds(_organizationId: string, groupId: string): Promise<string[]> {
    const rows = await this.db.groupMember.findMany({ where: { groupId } });
    return rows.map((row) => row.identityId);
  }

  /** Tenant-scoped like every other read here: one organization's groups, by name. */
  async listGroups(organizationId: string): Promise<AccessReviewGroupRecord[]> {
    const rows = await this.db.group.findMany({
      where: { organizationId },
      orderBy: { displayName: "asc" },
    });
    return rows.map((row) => ({ id: row.id, name: row.displayName }));
  }
}
