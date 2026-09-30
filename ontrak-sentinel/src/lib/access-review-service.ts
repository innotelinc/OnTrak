/**
 * Access reviews (S2): opening one, answering it, and the schedule that opens the next.
 *
 * The rules are in `access-review-rules.ts` and have no clock; this is the part that
 * reads the roster, writes the decisions down and puts them on the evidence chain.
 *
 * Four things here are decisions rather than plumbing:
 *
 *  - **A review's list is a snapshot, and it is fixed when the review opens.** Resolving
 *    the scope on every read would mean the list grows when somebody is hired, so a
 *    review could never be finished — “review the service desk” would include whoever
 *    joined this morning and exclude whoever left, and neither of them was on the list
 *    when the reviewer started. The snapshot is taken once; a later joiner is the next
 *    review's problem, which is what a *periodic* attestation means.
 *  - **A scope that resolves to nobody is refused**, rather than opening a review with an
 *    empty list. An empty review and a review that passed look identical in a list, and
 *    the first is how an organization ends up attesting to nothing every quarter.
 *  - **`REVOKED` is carried out, and refuses to be recorded if it cannot be.** The
 *    decision goes through `deprovisionForActor` — the same path a SCIM `active:false`
 *    takes, so the identity is switched off and its sessions and tokens end together —
 *    and where this deployment has no way to deprovision, the attestation is refused
 *    instead of recorded. An operator must never be told a revocation happened when the
 *    person is still signing in.
 *  - **The scheduler opens one review per schedule per tick, and reports what it
 *    missed.** See `scheduleTick`: a deployment that was down for a month should not come
 *    back to thirty identical reviews.
 *
 * What is deliberately *not* here: a rule that a role policy must be at least as strict
 * as the baseline, and a rule that an administrator cannot be revoked by a review. The
 * second is enforced one layer down — the spine refuses to deactivate the last
 * administrator, and that refusal is what a review gets too, because it is the only
 * place that knows how many administrators are left.
 */

import { randomUUID } from "node:crypto";

import {
  ACCESS_REVIEW_DECISIONS,
  canClose,
  defaultDueAt,
  isAccessReviewDecision,
  nextRunAfter,
  reviewProgress,
  reviewState,
  scheduleTick,
  validateReview,
  validateSchedule,
  type AccessReviewDecision,
  type AccessReviewScope,
  type AccessReviewState,
  type AccessReviewStatus,
  type ReviewInput,
  type ReviewProgress,
  type ScheduleInput,
} from "./access-review-rules";
import { canAttestAccessReview, canManageAccessReviews, type IdentityRecord } from "./identity-rules";
import type { AuditTrail, IdentityActor, IdentityStore, ServiceResult } from "./identity-service";
import type { ScimService } from "./scim-service";

/* -------------------------------------------------------------------------- */
/*  The stored records                                                        */
/* -------------------------------------------------------------------------- */

export interface AccessReviewRecord {
  id: string;
  organizationId: string;
  name: string;
  scopeKind: AccessReviewScope;
  scopeValue: string;
  reviewerId: string;
  /** ISO. Compared against the clock to derive lateness — never stored as a flag. */
  dueAt: string;
  status: AccessReviewStatus;
  scheduleId: string | null;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
}

export interface AccessReviewItemRecord {
  id: string;
  organizationId: string;
  reviewId: string;
  identityId: string;
  decision: AccessReviewDecision;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
}

export interface AccessReviewScheduleRecord {
  id: string;
  organizationId: string;
  name: string;
  scopeKind: AccessReviewScope;
  scopeValue: string;
  reviewerId: string;
  intervalDays: number;
  nextRunAt: string;
  lastRunAt: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** An item with the person it is about, so a console does not have to join anything. */
export interface AccessReviewItemView extends AccessReviewItemRecord {
  identity: Pick<IdentityRecord, "id" | "identifier" | "displayName" | "role" | "active"> | null;
}

export interface AccessReviewView {
  review: AccessReviewRecord;
  state: AccessReviewState;
  progress: ReviewProgress;
  items: AccessReviewItemView[];
}

/** A group a `GROUP` scope can name, as a picker needs it: an id and a label. */
export interface AccessReviewGroupRecord {
  id: string;
  name: string;
}

/** What the scheduler did on one tick. */
export interface AccessReviewTickReport {
  opened: { scheduleId: string; reviewId: string; missed: number }[];
}

/* -------------------------------------------------------------------------- */
/*  The store port                                                            */
/* -------------------------------------------------------------------------- */

export interface AccessReviewStore {
  listReviews(organizationId: string): Promise<AccessReviewRecord[]>;
  findReview(organizationId: string, reviewId: string): Promise<AccessReviewRecord | null>;
  insertReview(record: AccessReviewRecord): Promise<void>;
  updateReview(record: AccessReviewRecord): Promise<void>;

  listItems(organizationId: string, reviewId: string): Promise<AccessReviewItemRecord[]>;
  /**
   * Every review's items in one call, for the list view. A per-review read would be a
   * query per row, and a console that lists twenty reviews is not an unusual page.
   */
  listItemsForOrganization(organizationId: string): Promise<AccessReviewItemRecord[]>;
  findItem(organizationId: string, reviewId: string, identityId: string): Promise<AccessReviewItemRecord | null>;
  insertItems(records: readonly AccessReviewItemRecord[]): Promise<void>;
  updateItem(record: AccessReviewItemRecord): Promise<void>;

  listSchedules(organizationId: string): Promise<AccessReviewScheduleRecord[]>;
  findSchedule(organizationId: string, scheduleId: string): Promise<AccessReviewScheduleRecord | null>;
  insertSchedule(record: AccessReviewScheduleRecord): Promise<void>;
  updateSchedule(record: AccessReviewScheduleRecord): Promise<void>;
  removeSchedule(organizationId: string, scheduleId: string): Promise<void>;
  /** Every organization's schedules that are due, for the one global scheduler. */
  dueSchedules(nowIso: string): Promise<AccessReviewScheduleRecord[]>;

  /**
   * The identities that are members of a group. A `GROUP` scope resolves through this
   * rather than through the SCIM surface, because reading a group is not a provisioning
   * act and the review should not depend on the connector being configured.
   */
  listGroupMemberIds(organizationId: string, groupId: string): Promise<string[]>;

  /**
   * The groups this organization has, for a picker. A `GROUP` scope is named by an id,
   * and asking an operator to type one is asking them to get it wrong silently — the
   * review would then open empty, which `open` refuses with no hint about the cause.
   */
  listGroups(organizationId: string): Promise<AccessReviewGroupRecord[]>;
}

export interface AccessReviewIds {
  id(): string;
  now(): string;
  nowMs(): number;
}

export function systemAccessReviewIds(): AccessReviewIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString(), nowMs: () => Date.now() };
}

/* -------------------------------------------------------------------------- */
/*  Inputs                                                                    */
/* -------------------------------------------------------------------------- */

export interface OpenReviewInput {
  name?: string;
  scopeKind?: string;
  scopeValue?: string;
  reviewerId?: string;
  /** Defaults to `DEFAULT_REVIEW_WINDOW_DAYS` from now. */
  dueAtMs?: number;
  windowDays?: number;
}

export interface CreateScheduleInput {
  name?: string;
  scopeKind?: string;
  scopeValue?: string;
  reviewerId?: string;
  intervalDays?: number;
  /** Defaults to a full interval from now, so a new schedule does not fire immediately. */
  firstRunAtMs?: number;
}

/**
 * Who the scheduler logs as. It is not a person and must not look like one: an
 * attestation nobody signed is exactly what this feature exists to prevent, so the
 * system actor is named as the system and says which schedule it was acting for.
 */
const SYSTEM_ACTOR = "system:access-review-scheduler";

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

export class AccessReviewService {
  constructor(
    private readonly store: AccessReviewStore,
    /** The roster: which identities a scope resolves to, and their current state. */
    private readonly identities: IdentityStore,
    /**
     * How a `REVOKED` decision is carried out — the same path a SCIM `active:false`
     * takes. `null` on a deployment that cannot deprovision, in which case a revocation
     * is refused rather than recorded as if it had happened.
     */
    private readonly scim: Pick<ScimService, "deprovisionForActor"> | null,
    private readonly audit: AuditTrail | null = null,
    private readonly ids: AccessReviewIds = systemAccessReviewIds(),
  ) {}

  /* --------------------------------------------------------------- reading */

  async reviews(actor: IdentityActor): Promise<ServiceResult<AccessReviewView[]>> {
    if (!canManageAccessReviews(actor.role)) return { ok: false, error: "You do not administer access reviews." };

    const reviews = await this.store.listReviews(actor.organizationId);
    const items = await this.store.listItemsForOrganization(actor.organizationId);
    const byReview = new Map<string, AccessReviewItemRecord[]>();
    for (const item of items) {
      const list = byReview.get(item.reviewId);
      if (list) list.push(item);
      else byReview.set(item.reviewId, [item]);
    }

    const nowMs = this.ids.nowMs();
    const views = await Promise.all(
      reviews.map(async (review) =>
        this.compose(review, byReview.get(review.id) ?? [], nowMs),
      ),
    );
    // Most pressing first: an overdue review is the one somebody came here to find.
    views.sort((a, b) => rank(a.state) - rank(b.state) || a.review.dueAt.localeCompare(b.review.dueAt));
    return { ok: true, value: views };
  }

  async view(actor: IdentityActor, reviewId: string): Promise<ServiceResult<AccessReviewView>> {
    if (!canManageAccessReviews(actor.role) && !(await this.isReviewer(actor, reviewId))) {
      return { ok: false, error: "You do not administer access reviews." };
    }
    const review = await this.store.findReview(actor.organizationId, reviewId);
    if (!review) return { ok: false, error: "That review does not exist." };
    const items = await this.store.listItems(actor.organizationId, reviewId);
    return { ok: true, value: await this.compose(review, items, this.ids.nowMs()) };
  }

  /* ---------------------------------------------------------------- opening */

  async open(actor: IdentityActor, input: OpenReviewInput): Promise<ServiceResult<AccessReviewView>> {
    if (!canManageAccessReviews(actor.role)) return { ok: false, error: "You do not administer access reviews." };

    const nowMs = this.ids.nowMs();
    const windowDays = input.windowDays;
    const dueAtMs = input.dueAtMs ?? defaultDueAt(nowMs, windowDays);
    const draft: ReviewInput = {
      name: input.name ?? "",
      scopeKind: input.scopeKind ?? "",
      scopeValue: input.scopeValue ?? "",
      reviewerId: input.reviewerId ?? "",
      dueAtMs,
    };
    const refused = validateReview(draft, nowMs);
    if (refused.length > 0) return { ok: false, error: refused[0] };

    // The reviewer has to exist and be active: a review assigned to a leaver, or to an
    // id that was typed wrong, is one nobody can answer and nothing would say so.
    const reviewer = await this.identities.findIdentity(actor.organizationId, draft.reviewerId);
    if (!reviewer) return { ok: false, error: "That reviewer is not an identity in this organization." };
    if (!reviewer.active) return { ok: false, error: "That reviewer is deactivated, so nobody would be able to answer this review." };

    const scope = await this.resolveScope(actor.organizationId, draft.scopeKind as AccessReviewScope, draft.scopeValue);
    if (scope.length === 0) {
      return {
        ok: false,
        error:
          "That scope resolves to nobody, so the review would attest to nothing. " +
          "An empty review and one that passed look the same in a list.",
      };
    }

    const now = this.ids.now();
    const review: AccessReviewRecord = {
      id: this.ids.id(),
      organizationId: actor.organizationId,
      name: draft.name.trim(),
      scopeKind: draft.scopeKind as AccessReviewScope,
      scopeValue: draft.scopeValue,
      reviewerId: draft.reviewerId,
      dueAt: new Date(dueAtMs).toISOString(),
      status: "OPEN",
      scheduleId: null,
      createdBy: actor.id,
      createdAt: now,
      completedAt: null,
    };
    await this.store.insertReview(review);

    // The snapshot, written once: every item starts `PENDING`, and PENDING is not an
    // approval. This is the line that makes the difference between “reviewed” and
    // “nobody got to it” survive to the report.
    const items: AccessReviewItemRecord[] = scope.map((identityId) => ({
      id: this.ids.id(),
      organizationId: actor.organizationId,
      reviewId: review.id,
      identityId,
      decision: "PENDING" as AccessReviewDecision,
      decidedBy: null,
      decidedAt: null,
      note: null,
    }));
    await this.store.insertItems(items);

    await this.append(actor.id, actor.organizationId, "access.review.open", review.id, {
      name: review.name,
      scopeKind: review.scopeKind,
      scopeValue: review.scopeValue,
      reviewerId: review.reviewerId,
      dueAt: review.dueAt,
      identities: items.length,
    });

    return { ok: true, value: await this.compose(review, items, nowMs) };
  }

  /**
   * The identities a scope covers: the organization's active people, or a group's.
   *
   * Active only. A deactivated identity has no access to attest to, and including them
   * would make every review permanently larger than the roster — which is how a review
   * gets abandoned. Somebody who is reactivated appears on the next one, and a leaver
   * who was *never* deactivated is still active, so they are on this one. That is the
   * case a review exists for.
   */
  private async resolveScope(
    organizationId: string,
    scopeKind: AccessReviewScope,
    scopeValue: string,
  ): Promise<string[]> {
    const all = await this.identities.listIdentities(organizationId);
    const active = all.filter((identity) => identity.active);
    if (scopeKind === "ORGANIZATION") return active.map((identity) => identity.id);

    const members = new Set(await this.store.listGroupMemberIds(organizationId, scopeValue));
    return active.filter((identity) => members.has(identity.id)).map((identity) => identity.id);
  }

  /* -------------------------------------------------------------- answering */

  /**
   * Record what the reviewer decided about one identity.
   *
   * `REVOKED` is the only decision with a side effect, and it is carried out *before*
   * the decision is written: if the deprovisioning is refused — the last administrator,
   * or a deployment with no way to do it — nothing is recorded, so the record never
   * claims a revocation that did not happen.
   */
  async attest(
    actor: IdentityActor,
    reviewId: string,
    identityId: string,
    decision: string,
    note?: string,
  ): Promise<ServiceResult<AccessReviewView>> {
    const review = await this.store.findReview(actor.organizationId, reviewId);
    if (!review) return { ok: false, error: "That review does not exist." };
    if (!canAttestAccessReview(actor.role, actor.id, review.reviewerId)) {
      return { ok: false, error: "You are not the reviewer on this review." };
    }
    if (review.status !== "OPEN") {
      return { ok: false, error: "That review is closed, so its decisions are evidence now rather than work." };
    }
    if (!isAccessReviewDecision(decision)) {
      return { ok: false, error: `An unknown decision “${decision}”. Use ${ACCESS_REVIEW_DECISIONS.join(", ")}.` };
    }
    if (decision === "PENDING") {
      // Nothing to do, and letting it through would let somebody clear a decision by
      // re-sending the initial value — the record has to say who decided what.
      return { ok: false, error: "Pending is what an item is before anybody answers it, not something to set." };
    }

    const item = await this.store.findItem(actor.organizationId, reviewId, identityId);
    if (!item) return { ok: false, error: "That identity is not on this review's list." };

    if (decision === "REVOKED") {
      if (!this.scim) {
        return {
          ok: false,
          error:
            "This deployment cannot deprovision identities, so a revocation cannot be carried out. " +
            "Recording it would say a person lost their access when they still have it.",
        };
      }
      const down = await this.scim.deprovisionForActor(actor, identityId, `an access review attested that this access is no longer warranted: ${review.name}`);
      if (!down.ok) return { ok: false, error: down.error };
    }

    const updated: AccessReviewItemRecord = {
      ...item,
      decision,
      decidedBy: actor.id,
      decidedAt: this.ids.now(),
      note: note?.trim() ? note.trim() : null,
    };
    await this.store.updateItem(updated);

    await this.append(actor.id, actor.organizationId, "access.review.attest", reviewId, {
      identityId,
      decision,
      note: updated.note,
    });

    const items = await this.store.listItems(actor.organizationId, reviewId);
    return { ok: true, value: await this.compose(review, items, this.ids.nowMs()) };
  }

  /**
   * Close a review.
   *
   * Allowed with items still pending — see `canClose` for why refusing would be worse —
   * and the closing entry says how many were never looked at, so the register holds the
   * difference between a review that passed and a review that ran out of time.
   */
  async close(actor: IdentityActor, reviewId: string): Promise<ServiceResult<AccessReviewView>> {
    if (!canManageAccessReviews(actor.role)) return { ok: false, error: "You do not administer access reviews." };

    const review = await this.store.findReview(actor.organizationId, reviewId);
    if (!review) return { ok: false, error: "That review does not exist." };
    const allowed = canClose(review.status);
    if (!allowed.ok) return { ok: false, error: allowed.reason };

    const items = await this.store.listItems(actor.organizationId, reviewId);
    const progress = reviewProgress(items);
    const closed: AccessReviewRecord = { ...review, status: "COMPLETED", completedAt: this.ids.now() };
    await this.store.updateReview(closed);

    await this.append(actor.id, actor.organizationId, "access.review.close", reviewId, {
      total: progress.total,
      kept: progress.kept,
      revoked: progress.revoked,
      // Named `unattested` rather than `pending`, because it is the number an auditor
      // wants and the word they would use for it.
      unattested: progress.pending,
    });

    return { ok: true, value: await this.compose(closed, items, this.ids.nowMs()) };
  }

  async cancel(actor: IdentityActor, reviewId: string): Promise<ServiceResult<AccessReviewView>> {
    if (!canManageAccessReviews(actor.role)) return { ok: false, error: "You do not administer access reviews." };

    const review = await this.store.findReview(actor.organizationId, reviewId);
    if (!review) return { ok: false, error: "That review does not exist." };
    const allowed = canClose(review.status);
    if (!allowed.ok) return { ok: false, error: allowed.reason };

    // Cancelled, not deleted. The items are a record of what was asked, and a review
    // that was opened and abandoned is exactly the kind of thing a register is for.
    const cancelled: AccessReviewRecord = { ...review, status: "CANCELLED", completedAt: this.ids.now() };
    await this.store.updateReview(cancelled);
    await this.append(actor.id, actor.organizationId, "access.review.cancel", reviewId, { name: review.name });

    const items = await this.store.listItems(actor.organizationId, reviewId);
    return { ok: true, value: await this.compose(cancelled, items, this.ids.nowMs()) };
  }

  /* ------------------------------------------------------------- schedules */

  async schedules(actor: IdentityActor): Promise<ServiceResult<AccessReviewScheduleRecord[]>> {
    if (!canManageAccessReviews(actor.role)) return { ok: false, error: "You do not administer access reviews." };
    return { ok: true, value: await this.store.listSchedules(actor.organizationId) };
  }

  /**
   * The groups a `GROUP` scope may name.
   *
   * Administering only, the same as opening a review: this is the picker for the form that
   * opens one, and a reviewer who never opens reviews has no use for it. Reading a group
   * through here rather than through the SCIM surface is deliberate — the SCIM reader
   * wants a connector's caller, and a browser session is not one.
   */
  async groups(actor: IdentityActor): Promise<ServiceResult<AccessReviewGroupRecord[]>> {
    if (!canManageAccessReviews(actor.role)) return { ok: false, error: "You do not administer access reviews." };
    return { ok: true, value: await this.store.listGroups(actor.organizationId) };
  }

  async createSchedule(actor: IdentityActor, input: CreateScheduleInput): Promise<ServiceResult<AccessReviewScheduleRecord>> {
    if (!canManageAccessReviews(actor.role)) return { ok: false, error: "You do not administer access reviews." };

    const nowMs = this.ids.nowMs();
    const intervalDays = input.intervalDays ?? 90;
    const draft: ScheduleInput = {
      name: input.name ?? "",
      scopeKind: input.scopeKind ?? "",
      scopeValue: input.scopeValue ?? "",
      reviewerId: input.reviewerId ?? "",
      intervalDays,
      firstRunAtMs: input.firstRunAtMs ?? nextRunAfter(nowMs, intervalDays),
    };
    const refused = validateSchedule(draft, nowMs);
    if (refused.length > 0) return { ok: false, error: refused[0] };

    const reviewer = await this.identities.findIdentity(actor.organizationId, draft.reviewerId);
    if (!reviewer) return { ok: false, error: "That reviewer is not an identity in this organization." };

    // A duplicate name is refused here rather than by the unique index, so the caller
    // gets a sentence instead of a database error.
    const existing = await this.store.listSchedules(actor.organizationId);
    if (existing.some((schedule) => schedule.name === draft.name.trim())) {
      return { ok: false, error: "A schedule with that name already exists." };
    }

    const now = this.ids.now();
    const record: AccessReviewScheduleRecord = {
      id: this.ids.id(),
      organizationId: actor.organizationId,
      name: draft.name.trim(),
      scopeKind: draft.scopeKind as AccessReviewScope,
      scopeValue: draft.scopeValue,
      reviewerId: draft.reviewerId,
      intervalDays,
      nextRunAt: new Date(draft.firstRunAtMs).toISOString(),
      lastRunAt: null,
      enabled: true,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.insertSchedule(record);
    await this.append(actor.id, actor.organizationId, "access.review.schedule.create", record.id, {
      name: record.name,
      intervalDays: record.intervalDays,
      nextRunAt: record.nextRunAt,
      reviewerId: record.reviewerId,
    });
    return { ok: true, value: record };
  }

  async setScheduleEnabled(actor: IdentityActor, scheduleId: string, enabled: boolean): Promise<ServiceResult<AccessReviewScheduleRecord>> {
    if (!canManageAccessReviews(actor.role)) return { ok: false, error: "You do not administer access reviews." };

    const schedule = await this.store.findSchedule(actor.organizationId, scheduleId);
    if (!schedule) return { ok: false, error: "That schedule does not exist." };

    // Pausing does not move `nextRunAt`: resuming should not silently skip a period, and
    // the tick that finds it due after a long pause opens one review and says it missed
    // the rest, which is the behaviour `scheduleTick` exists to provide.
    const updated: AccessReviewScheduleRecord = { ...schedule, enabled, updatedAt: this.ids.now() };
    await this.store.updateSchedule(updated);
    await this.append(actor.id, actor.organizationId, "access.review.schedule.enabled", scheduleId, { enabled });
    return { ok: true, value: updated };
  }

  async removeSchedule(actor: IdentityActor, scheduleId: string): Promise<ServiceResult<{ removed: true }>> {
    if (!canManageAccessReviews(actor.role)) return { ok: false, error: "You do not administer access reviews." };

    const schedule = await this.store.findSchedule(actor.organizationId, scheduleId);
    if (!schedule) return { ok: false, error: "That schedule does not exist." };

    await this.store.removeSchedule(actor.organizationId, scheduleId);
    await this.append(actor.id, actor.organizationId, "access.review.schedule.remove", scheduleId, { name: schedule.name });
    // The reviews it already opened stay: they are evidence, and the foreign key is
    // `ON DELETE SET NULL` for exactly this reason.
    return { ok: true, value: { removed: true } };
  }

  /* ------------------------------------------------------------ the ticker */

  /**
   * Open every review that is due, across every organization.
   *
   * No actor, because nobody asked: the schedule is the instruction, and the entry this
   * writes names the system rather than a person. A schedule whose scope has emptied —
   * everybody in the group left — is *skipped* rather than opening an empty review, and
   * `nextRunAt` still advances, so an empty group does not turn into a review every tick
   * for the rest of the deployment's life.
   */
  async tick(nowMs: number = this.ids.nowMs()): Promise<AccessReviewTickReport> {
    const due = await this.store.dueSchedules(new Date(nowMs).toISOString());
    const report: AccessReviewTickReport = { opened: [] };

    for (const schedule of due) {
      const tick = scheduleTick(
        { enabled: schedule.enabled, nextRunAtMs: Date.parse(schedule.nextRunAt), intervalDays: schedule.intervalDays },
        nowMs,
      );
      if (!tick.open) continue;

      const scope = await this.resolveScope(schedule.organizationId, schedule.scopeKind, schedule.scopeValue);
      // Advance the schedule whether or not a review was opened — see above.
      const advanced: AccessReviewScheduleRecord = {
        ...schedule,
        lastRunAt: new Date(nowMs).toISOString(),
        nextRunAt: new Date(tick.nextRunAtMs).toISOString(),
        updatedAt: this.ids.now(),
      };
      await this.store.updateSchedule(advanced);

      if (scope.length === 0) {
        await this.append(SYSTEM_ACTOR, schedule.organizationId, "access.review.schedule.empty", schedule.id, {
          name: schedule.name,
          missed: tick.missed,
        });
        continue;
      }

      const now = this.ids.now();
      const review: AccessReviewRecord = {
        id: this.ids.id(),
        organizationId: schedule.organizationId,
        name: `${schedule.name} — ${new Date(nowMs).toISOString().slice(0, 10)}`,
        scopeKind: schedule.scopeKind,
        scopeValue: schedule.scopeValue,
        reviewerId: schedule.reviewerId,
        dueAt: new Date(defaultDueAt(nowMs)).toISOString(),
        status: "OPEN",
        scheduleId: schedule.id,
        createdBy: SYSTEM_ACTOR,
        createdAt: now,
        completedAt: null,
      };
      await this.store.insertReview(review);
      await this.store.insertItems(
        scope.map((identityId) => ({
          id: this.ids.id(),
          organizationId: schedule.organizationId,
          reviewId: review.id,
          identityId,
          decision: "PENDING" as AccessReviewDecision,
          decidedBy: null,
          decidedAt: null,
          note: null,
        })),
      );

      await this.append(SYSTEM_ACTOR, schedule.organizationId, "access.review.open", review.id, {
        name: review.name,
        scopeKind: review.scopeKind,
        scopeValue: review.scopeValue,
        reviewerId: review.reviewerId,
        dueAt: review.dueAt,
        identities: scope.length,
        scheduleId: schedule.id,
        // Reported, never multiplied into reviews: a month of downtime is one review,
        // and the number of intervals it swallowed is still worth recording.
        missed: tick.missed,
      });
      report.opened.push({ scheduleId: schedule.id, reviewId: review.id, missed: tick.missed });
    }

    return report;
  }

  /* ------------------------------------------------------------- internals */

  private async isReviewer(actor: IdentityActor, reviewId: string): Promise<boolean> {
    const review = await this.store.findReview(actor.organizationId, reviewId);
    return review !== null && review.reviewerId === actor.id;
  }

  /** A review, its items with the people they name, and what they add up to. */
  private async compose(
    review: AccessReviewRecord,
    items: AccessReviewItemRecord[],
    nowMs: number,
  ): Promise<AccessReviewView> {
    const roster = await this.identities.listIdentities(review.organizationId);
    const byId = new Map(roster.map((identity) => [identity.id, identity]));
    const enriched: AccessReviewItemView[] = items.map((item) => {
      const identity = byId.get(item.identityId);
      return {
        ...item,
        identity: identity
          ? {
              id: identity.id,
              identifier: identity.identifier,
              displayName: identity.displayName,
              role: identity.role,
              // Read through, not snapshotted: “is this person active *now*” is the
              // question a reader has, and the decision beside it says what was decided.
              active: identity.active,
            }
          : null,
      };
    });
    // Undecided first, then by who they are, so the work is at the top of the page.
    enriched.sort((a, b) => {
      const pending = (item: AccessReviewItemView) => (item.decision === "PENDING" ? 0 : 1);
      return (
        pending(a) - pending(b) ||
        (a.identity?.displayName ?? a.identityId).localeCompare(b.identity?.displayName ?? b.identityId)
      );
    });

    return {
      review,
      state: reviewState(review.status, Date.parse(review.dueAt), nowMs),
      progress: reviewProgress(items),
      items: enriched,
    };
  }

  private async append(
    actorId: string,
    organizationId: string,
    action: string,
    targetId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) return;
    await this.audit.append({
      id: this.ids.id(),
      at: this.ids.now(),
      actor: actorId,
      action,
      targetType: "AccessReview",
      targetId,
      detail: { ...detail, organizationId },
    });
  }
}

/** Overdue first, then open, then the rest — the order somebody came to the page for. */
function rank(state: AccessReviewState): number {
  if (state === "OVERDUE") return 0;
  if (state === "OPEN") return 1;
  return 2;
}

/* -------------------------------------------------------------------------- */
/*  An in-memory store                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The same shape as the database adapter, so the tests exercise the real service —
 * including the snapshot, the refusals and the audit entries — rather than a stub that
 * agrees with whatever they assert.
 *
 * `groupMembers` is seeded rather than derived, because the group tables belong to the
 * provisioning surface: a test that wants a `GROUP` scope says who is in the group
 * instead of building a SCIM store to say it for them.
 */
export class MemoryAccessReviewStore implements AccessReviewStore {
  private readonly reviews = new Map<string, AccessReviewRecord>();
  private readonly items = new Map<string, AccessReviewItemRecord>();
  private readonly schedules = new Map<string, AccessReviewScheduleRecord>();

  constructor(
    private readonly groupMembers: Record<string, string[]> = {},
    /** The groups a picker can offer. Defaults to the keys of `groupMembers`. */
    private readonly groups: AccessReviewGroupRecord[] = Object.keys(groupMembers).map((id) => ({ id, name: id })),
  ) {}

  async listReviews(organizationId: string): Promise<AccessReviewRecord[]> {
    return [...this.reviews.values()].filter((review) => review.organizationId === organizationId);
  }

  async findReview(organizationId: string, reviewId: string): Promise<AccessReviewRecord | null> {
    const review = this.reviews.get(reviewId);
    return review && review.organizationId === organizationId ? review : null;
  }

  async insertReview(record: AccessReviewRecord): Promise<void> {
    this.reviews.set(record.id, record);
  }

  async updateReview(record: AccessReviewRecord): Promise<void> {
    this.reviews.set(record.id, record);
  }

  async listItems(organizationId: string, reviewId: string): Promise<AccessReviewItemRecord[]> {
    return [...this.items.values()].filter(
      (item) => item.organizationId === organizationId && item.reviewId === reviewId,
    );
  }

  async listItemsForOrganization(organizationId: string): Promise<AccessReviewItemRecord[]> {
    return [...this.items.values()].filter((item) => item.organizationId === organizationId);
  }

  async findItem(organizationId: string, reviewId: string, identityId: string): Promise<AccessReviewItemRecord | null> {
    return this.items.get(`${reviewId}:${identityId}`) ?? null;
  }

  async insertItems(records: readonly AccessReviewItemRecord[]): Promise<void> {
    for (const record of records) this.items.set(`${record.reviewId}:${record.identityId}`, record);
  }

  async updateItem(record: AccessReviewItemRecord): Promise<void> {
    this.items.set(`${record.reviewId}:${record.identityId}`, record);
  }

  async listSchedules(organizationId: string): Promise<AccessReviewScheduleRecord[]> {
    return [...this.schedules.values()].filter((schedule) => schedule.organizationId === organizationId);
  }

  async findSchedule(organizationId: string, scheduleId: string): Promise<AccessReviewScheduleRecord | null> {
    const schedule = this.schedules.get(scheduleId);
    return schedule && schedule.organizationId === organizationId ? schedule : null;
  }

  async insertSchedule(record: AccessReviewScheduleRecord): Promise<void> {
    this.schedules.set(record.id, record);
  }

  async updateSchedule(record: AccessReviewScheduleRecord): Promise<void> {
    this.schedules.set(record.id, record);
  }

  async removeSchedule(organizationId: string, scheduleId: string): Promise<void> {
    const schedule = await this.findSchedule(organizationId, scheduleId);
    if (schedule) this.schedules.delete(scheduleId);
  }

  async dueSchedules(nowIso: string): Promise<AccessReviewScheduleRecord[]> {
    return [...this.schedules.values()].filter((schedule) => schedule.enabled && schedule.nextRunAt <= nowIso);
  }

  async listGroupMemberIds(_organizationId: string, groupId: string): Promise<string[]> {
    return [...(this.groupMembers[groupId] ?? [])];
  }

  async listGroups(_organizationId: string): Promise<AccessReviewGroupRecord[]> {
    return [...this.groups];
  }
}
