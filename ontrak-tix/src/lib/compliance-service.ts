/**
 * Incident compliance service (M3): the notification clocks an incident starts,
 * and the review that has to come out of it with work attached.
 *
 * The two live together because they are the same promise made to two
 * audiences. A regulator gets told inside a window; the desk gets told what to
 * change, with an owner and a date. Both are *tracked rows*, not prose: every
 * change writes the row, a line on the incident's append-only timeline, and a
 * hash-chained audit event — so "who decided this incident did not need a GDPR
 * notification" has an answer.
 *
 * Two refusals carry the design:
 *
 *  - a notification cannot be waived without a reason, and the waiver is stored
 *    rather than the row being deleted;
 *  - a review cannot be published before the incident is `REVIEWED`, or without
 *    at least one action that has an owner and a due date. A post-mortem that
 *    creates no work is a document.
 */

import { randomUUID } from "node:crypto";

import { actorHasPermission, type Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import { commsIssues, commsTemplateByKey } from "./comms-rules";
import { docsAudit } from "./incident-docs-service";
import type { IncidentEvent, IncidentRecord, IncidentStore } from "./incident-service";
import {
  buildObligation,
  canAcknowledge,
  canSend,
  canWaive,
  notificationState,
  notificationSummary,
  regimeByKey,
  suggestedRegimes,
  validateNotification,
  type NotificationObligation,
  type NotificationSummary,
  type RegimeSuggestion,
} from "./regulatory-rules";
import {
  actionState,
  canChangeAction,
  reviewSummary,
  validateReview,
  validateReviewAction,
  type ReviewActionInput,
  type ReviewActionRecord,
  type ReviewActionStatus,
  type ReviewInput,
  type ReviewRecord,
  type ReviewSummary,
} from "./review-rules";
import type { ServiceResult } from "./ticket-service";

/* -------------------------------------------------------------------------- */
/*  Store                                                                     */
/* -------------------------------------------------------------------------- */

export interface ComplianceStore {
  insertNotification(obligation: NotificationObligation): Promise<void>;
  findNotification(tenantId: string, notificationId: string): Promise<NotificationObligation | null>;
  findNotificationByRegime(tenantId: string, incidentId: string, regime: string): Promise<NotificationObligation | null>;
  updateNotification(obligation: NotificationObligation): Promise<void>;
  listNotifications(tenantId: string, incidentId: string): Promise<NotificationObligation[]>;

  insertReview(review: ReviewRecord): Promise<void>;
  findReview(tenantId: string, incidentId: string): Promise<ReviewRecord | null>;
  insertActions(actions: ReviewActionRecord[]): Promise<void>;
  insertAction(action: ReviewActionRecord): Promise<void>;
  findAction(tenantId: string, actionId: string): Promise<ReviewActionRecord | null>;
  listActions(tenantId: string, incidentId: string): Promise<ReviewActionRecord[]>;
  updateAction(action: ReviewActionRecord): Promise<void>;

  /** Several incidents' compliance rows in one pass. Optional, like the rest. */
  listPages?(tenantId: string, incidentIds: readonly string[]): Promise<Map<string, CompliancePage>>;
}

/** What the console needs about one incident's compliance, without the summary. */
export interface CompliancePage {
  notifications: NotificationObligation[];
  review: ReviewRecord | null;
  actions: ReviewActionRecord[];
}

export interface ComplianceIds {
  id(): string;
  now(): string;
}

export function systemComplianceIds(): ComplianceIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

/** A suggestion next to whether it has already been adopted. */
export interface SuggestedObligation {
  suggestion: RegimeSuggestion;
  tracked: boolean;
}

/**
 * The regimes an incident's facts suggest, marked with what is already tracked.
 * Pure, so a page that has the incident and its notifications in hand does not
 * need another round trip to render the suggestion list.
 */
export function suggestionsFrom(
  incident: Pick<IncidentRecord, "severity" | "impact">,
  tracked: readonly NotificationObligation[],
): SuggestedObligation[] {
  return suggestedRegimes({ severity: incident.severity, impact: incident.impact }).map((suggestion) => ({
    suggestion,
    tracked: tracked.some((obligation) => obligation.regime === suggestion.regime.key),
  }));
}

/** The whole compliance picture for one incident, for a page. */
export interface ComplianceOverview {
  notifications: NotificationObligation[];
  summary: NotificationSummary;
  review: ReviewRecord | null;
  actions: ReviewActionRecord[];
  reviewSummary: ReviewSummary;
}

export class IncidentComplianceService {
  constructor(
    private readonly store: ComplianceStore,
    private readonly incidents: IncidentStore,
    private readonly audit: AuditSink | null = null,
    private readonly ids: ComplianceIds = systemComplianceIds(),
  ) {}

  /* ---------------------------------------------------------------- reading */

  /** Which regimes this incident's facts suggest, and which are already tracked. */
  async suggestions(actor: Actor, incidentId: string): Promise<ServiceResult<SuggestedObligation[]>> {
    if (!actorHasPermission(actor, "ticket:read:any")) return { ok: false, error: "You do not have access to incidents." };
    const incident = await this.incidents.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };

    const tracked = await this.store.listNotifications(actor.tenantId, incidentId);
    return { ok: true, value: suggestionsFrom(incident, tracked) };
  }

  async listNotifications(tenantId: string, incidentId: string): Promise<NotificationObligation[]> {
    return this.store.listNotifications(tenantId, incidentId);
  }

  async review(tenantId: string, incidentId: string): Promise<{ review: ReviewRecord | null; actions: ReviewActionRecord[] }> {
    const [review, actions] = await Promise.all([
      this.store.findReview(tenantId, incidentId),
      this.store.listActions(tenantId, incidentId),
    ]);
    return { review, actions };
  }

  /** Everything the compliance panels render, in one read. */
  async overview(tenantId: string, incidentId: string): Promise<ComplianceOverview> {
    const now = this.ids.now();
    const page = await this.page(tenantId, incidentId);
    return this.toOverview(page, now);
  }

  /**
   * Every listed incident's compliance rows, in one pass where the store can
   * batch — the console renders a dozen incidents on one page.
   */
  async pages(tenantId: string, incidentIds: readonly string[]): Promise<Map<string, ComplianceOverview>> {
    const now = this.ids.now();
    const pages = new Map<string, ComplianceOverview>();
    if (incidentIds.length === 0) return pages;

    if (this.store.listPages) {
      for (const [incidentId, page] of await this.store.listPages(tenantId, incidentIds)) {
        pages.set(incidentId, this.toOverview(page, now));
      }
      return pages;
    }

    for (const incidentId of incidentIds) pages.set(incidentId, await this.overview(tenantId, incidentId));
    return pages;
  }

  private async page(tenantId: string, incidentId: string): Promise<CompliancePage> {
    const [notifications, { review, actions }] = await Promise.all([
      this.store.listNotifications(tenantId, incidentId),
      this.review(tenantId, incidentId),
    ]);
    return { notifications, review, actions };
  }

  private toOverview(page: CompliancePage, now: string): ComplianceOverview {
    return {
      notifications: page.notifications,
      summary: notificationSummary(page.notifications, now),
      review: page.review,
      actions: page.actions,
      reviewSummary: reviewSummary(page.actions, now),
    };
  }

  /* ------------------------------------------------------- notifications */

  /** Adopt a regime, which starts its clock and records the deadline. */
  async track(actor: Actor, incidentId: string, regimeKey: string, note?: string): Promise<ServiceResult<NotificationObligation>> {
    const denied = this.writable(actor);
    if (denied) return denied;

    const issues = validateNotification({ regime: regimeKey, note });
    if (issues.length > 0) return { ok: false, error: issues[0] };

    const incident = await this.incidents.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };

    const existing = await this.store.findNotificationByRegime(actor.tenantId, incidentId, regimeKey);
    if (existing) return { ok: false, error: `${existing.label} is already being tracked for this incident.` };

    const obligation = buildObligation({
      id: this.ids.id(),
      tenantId: actor.tenantId,
      incidentId,
      regime: regimeByKey(regimeKey)!,
      incident,
      note: note ?? null,
      now: this.ids.now(),
    });
    await this.store.insertNotification(obligation);

    await this.timeline(actor.id, incident, "notification", `Tracking ${obligation.label} (due ${obligation.dueAt})`, {
      regime: obligation.regime,
      dueAt: obligation.dueAt,
      authority: obligation.authority,
    });
    await this.appendAudit(incident, actor.id, "incident.notification.track", { regime: obligation.regime, dueAt: obligation.dueAt });
    return { ok: true, value: obligation };
  }

  /** Mark a duty notified, with the authority's reference where there is one. */
  async markSent(
    actor: Actor,
    incidentId: string,
    notificationId: string,
    input: { reference?: string | null; note?: string | null; message?: string | null; templateKey?: string | null } = {},
  ): Promise<ServiceResult<NotificationObligation>> {
    const denied = this.writable(actor);
    if (denied) return denied;

    const found = await this.load(actor.tenantId, incidentId, notificationId);
    if (!found.ok) return found;
    const { obligation, incident } = found.value;
    if (!canSend(obligation)) return { ok: false, error: `${obligation.label} is already ${obligation.status.toLowerCase()}.` };

    // The notice text is the record of what was said, so it is checked before it
    // is stored — an unresolved {{placeholder}} is unfinished, not a notice.
    const message = input.message?.trim() || null;
    if (message) {
      const issues = commsIssues(message);
      if (issues.length > 0) return { ok: false, error: issues[0] };
    }

    const now = this.ids.now();
    const next: NotificationObligation = {
      ...obligation,
      status: "SENT",
      sentAt: now,
      sentBy: actor.id,
      reference: input.reference?.trim() || null,
      note: input.note?.trim() || obligation.note,
      message,
    };
    await this.store.updateNotification(next);

    const late = next.sentAt! > next.dueAt;
    const template = input.templateKey ? commsTemplateByKey(input.templateKey) : null;
    await this.timeline(
      actor.id,
      incident,
      "notification",
      `Sent ${next.label} to ${next.authority}${template ? ` from the "${template.label}" draft` : ""}${late ? " (after its deadline)" : ""}`,
      {
        regime: next.regime,
        dueAt: next.dueAt,
        sentAt: next.sentAt,
        reference: next.reference,
        late,
        ...(template ? { template: template.key } : {}),
        noticeChars: next.message?.length ?? 0,
      },
    );
    await this.appendAudit(incident, actor.id, "incident.notification.sent", {
      regime: next.regime,
      dueAt: next.dueAt,
      reference: next.reference,
      late,
      template: input.templateKey ?? null,
      noticeChars: next.message?.length ?? 0,
    });
    return { ok: true, value: next };
  }

  /** Record that the authority came back. */
  async acknowledge(actor: Actor, incidentId: string, notificationId: string): Promise<ServiceResult<NotificationObligation>> {
    const denied = this.writable(actor);
    if (denied) return denied;

    const found = await this.load(actor.tenantId, incidentId, notificationId);
    if (!found.ok) return found;
    const { obligation, incident } = found.value;
    if (!canAcknowledge(obligation)) return { ok: false, error: `Nothing has been sent for ${obligation.label} yet.` };

    const next: NotificationObligation = {
      ...obligation,
      status: "ACKNOWLEDGED",
      acknowledgedAt: this.ids.now(),
      acknowledgedBy: actor.id,
    };
    await this.store.updateNotification(next);

    await this.timeline(actor.id, incident, "notification", `${next.label} acknowledged by ${next.authority}`, { regime: next.regime });
    await this.appendAudit(incident, actor.id, "incident.notification.ack", { regime: next.regime });
    return { ok: true, value: next };
  }

  /** Record a decision that a duty did not apply. The reason is the point. */
  async waive(actor: Actor, incidentId: string, notificationId: string, reason: string): Promise<ServiceResult<NotificationObligation>> {
    const denied = this.writable(actor);
    if (denied) return denied;

    const text = reason.trim();
    if (!text) return { ok: false, error: "Waiving a notification needs a reason." };

    const found = await this.load(actor.tenantId, incidentId, notificationId);
    if (!found.ok) return found;
    const { obligation, incident } = found.value;
    if (!canWaive(obligation)) return { ok: false, error: `${obligation.label} cannot be waived now.` };

    const next: NotificationObligation = {
      ...obligation,
      status: "WAIVED",
      waivedAt: this.ids.now(),
      waivedBy: actor.id,
      waiverReason: text,
    };
    await this.store.updateNotification(next);

    await this.timeline(actor.id, incident, "notification", `Waived ${next.label}: ${text}`, { regime: next.regime, reason: text });
    await this.appendAudit(incident, actor.id, "incident.notification.waive", { regime: next.regime, reason: text });
    return { ok: true, value: next };
  }

  /* -------------------------------------------------------------- review */

  /**
   * Publish the review. Refused until the incident is `REVIEWED` — you review a
   * finished response — and refused without at least one owned, dated action.
   */
  async publish(actor: Actor, incidentId: string, input: ReviewInput): Promise<ServiceResult<{ review: ReviewRecord; actions: ReviewActionRecord[] }>> {
    const denied = this.writable(actor);
    if (denied) return denied;

    const issues = validateReview(input);
    if (issues.length > 0) return { ok: false, error: issues[0] };

    const incident = await this.incidents.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };
    if (incident.phase !== "REVIEWED") {
      return { ok: false, error: "Move the incident to reviewed before publishing its post-incident review." };
    }
    if (await this.store.findReview(actor.tenantId, incidentId)) {
      return { ok: false, error: "This incident already has a published review." };
    }

    const now = this.ids.now();
    const reviewId = this.ids.id();
    const review: ReviewRecord = {
      id: reviewId,
      tenantId: actor.tenantId,
      incidentId,
      findings: input.findings.trim(),
      lessons: input.lessons?.trim() || null,
      publishedBy: actor.id,
      publishedAt: now,
    };
    const actions = input.actions.map((action) => this.buildAction(actor, incident, reviewId, action));
    await this.store.insertReview(review);
    await this.store.insertActions(actions);

    await this.timeline(actor.id, incident, "review", `Post-incident review published (${actions.length} action${actions.length === 1 ? "" : "s"})`, {
      reviewId,
      actions: actions.length,
    });
    for (const action of actions) {
      await this.timeline(actor.id, incident, "action", `Action: ${action.title} — ${action.ownerId} by ${action.dueAt}`, {
        actionId: action.id,
        ownerId: action.ownerId,
        dueAt: action.dueAt,
      });
    }
    await this.appendAudit(incident, actor.id, "incident.review.publish", { reviewId, actions: actions.length });
    return { ok: true, value: { review, actions } };
  }

  /** Add an action to a published review. */
  async addAction(actor: Actor, incidentId: string, input: ReviewActionInput): Promise<ServiceResult<ReviewActionRecord>> {
    const denied = this.writable(actor);
    if (denied) return denied;

    const issues = validateReviewAction(input);
    if (issues.length > 0) return { ok: false, error: issues[0] };

    const incident = await this.incidents.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };

    const review = await this.store.findReview(actor.tenantId, incidentId);
    if (!review) return { ok: false, error: "Publish the review before adding actions to it." };

    const action = this.buildAction(actor, incident, review.id, input);
    await this.store.insertAction(action);
    await this.timeline(actor.id, incident, "action", `Action added: ${action.title} — ${action.ownerId} by ${action.dueAt}`, {
      actionId: action.id,
      ownerId: action.ownerId,
      dueAt: action.dueAt,
    });
    await this.appendAudit(incident, actor.id, "incident.action.add", { actionId: action.id, ownerId: action.ownerId, dueAt: action.dueAt });
    return { ok: true, value: action };
  }

  /** Mark an action done, and say what was done. */
  async completeAction(actor: Actor, incidentId: string, actionId: string, note?: string): Promise<ServiceResult<ReviewActionRecord>> {
    return this.changeAction(actor, incidentId, actionId, "DONE", note);
  }

  /** Drop an action. A dropped action is a decision, so the reason is required. */
  async dropAction(actor: Actor, incidentId: string, actionId: string, reason: string): Promise<ServiceResult<ReviewActionRecord>> {
    const text = reason.trim();
    if (!text) return { ok: false, error: "Dropping an action needs a reason." };
    return this.changeAction(actor, incidentId, actionId, "DROPPED", text);
  }

  /** Start work on an action, so a long-running one is not silently assumed. */
  async startAction(actor: Actor, incidentId: string, actionId: string): Promise<ServiceResult<ReviewActionRecord>> {
    return this.changeAction(actor, incidentId, actionId, "IN_PROGRESS", undefined);
  }

  /* ------------------------------------------------------------- internals */

  private buildAction(actor: Actor, incident: IncidentRecord, reviewId: string, input: ReviewActionInput): ReviewActionRecord {
    return {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      incidentId: incident.id,
      reviewId,
      title: input.title.trim(),
      ownerId: input.ownerId.trim(),
      dueAt: new Date(input.dueAt).toISOString(),
      note: input.note?.trim() || null,
      status: "OPEN",
      completedAt: null,
      completedBy: null,
      createdAt: this.ids.now(),
    };
  }

  private async changeAction(
    actor: Actor,
    incidentId: string,
    actionId: string,
    to: ReviewActionStatus,
    note: string | undefined,
  ): Promise<ServiceResult<ReviewActionRecord>> {
    const denied = this.writable(actor);
    if (denied) return denied;

    const incident = await this.incidents.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };

    const action = await this.store.findAction(actor.tenantId, actionId);
    if (!action || action.incidentId !== incidentId) return { ok: false, error: "Action not found on this incident." };

    const allowed = canChangeAction(action, to);
    if (!allowed.ok) return { ok: false, error: allowed.reason };

    const terminal = to === "DONE" || to === "DROPPED";
    const next: ReviewActionRecord = {
      ...action,
      status: to,
      note: note?.trim() || action.note,
      completedAt: terminal ? this.ids.now() : null,
      completedBy: terminal ? actor.id : null,
    };
    await this.store.updateAction(next);

    const verb = to === "DONE" ? "completed" : to === "DROPPED" ? `dropped: ${note?.trim()}` : "started";
    await this.timeline(actor.id, incident, "action", `Action ${verb}: ${next.title}`, {
      actionId: next.id,
      status: to,
      // Whether it was late when it closed — the number the review is judged on.
      late: terminal ? this.ids.now() > action.dueAt : false,
    });
    await this.appendAudit(incident, actor.id, `incident.action.${to === "DONE" ? "complete" : to === "DROPPED" ? "drop" : "start"}`, {
      actionId: next.id,
      status: to,
    });
    return { ok: true, value: next };
  }

  /** Load one obligation, with the incident it belongs to. */
  private async load(
    tenantId: string,
    incidentId: string,
    notificationId: string,
  ): Promise<ServiceResult<{ obligation: NotificationObligation; incident: IncidentRecord }>> {
    const incident = await this.incidents.findIncident(tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };
    const obligation = await this.store.findNotification(tenantId, notificationId);
    if (!obligation || obligation.incidentId !== incidentId) return { ok: false, error: "Notification not found on this incident." };
    return { ok: true, value: { obligation, incident } };
  }

  private writable(actor: Actor): { ok: false; error: string } | null {
    if (!actorHasPermission(actor, "ticket:update")) return { ok: false, error: "You cannot update incidents." };
    return null;
  }

  private async timeline(
    actor: string,
    incident: IncidentRecord,
    kind: IncidentEvent["kind"],
    summary: string,
    detail: Record<string, unknown> | null,
  ): Promise<void> {
    await this.incidents.appendEvent({
      id: this.ids.id(),
      tenantId: incident.tenantId,
      incidentId: incident.id,
      at: this.ids.now(),
      kind,
      actor,
      summary,
      detail,
    });
  }

  private async appendAudit(incident: IncidentRecord, actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    if (this.audit) await this.audit.append(docsAudit(incident, actor, action, this.ids.now(), detail));
  }
}

/** The state a panel colours an obligation with, re-exported for the renderer. */
export { notificationState, actionState };

/* -------------------------------------------------------------------------- */
/*  In-memory store (tests and local work)                                    */
/* -------------------------------------------------------------------------- */

export class MemoryComplianceStore implements ComplianceStore {
  private readonly notifications = new Map<string, NotificationObligation>();
  private readonly reviews = new Map<string, ReviewRecord>();
  private readonly actions = new Map<string, ReviewActionRecord>();

  async listPages(tenantId: string, incidentIds: readonly string[]): Promise<Map<string, CompliancePage>> {
    const pages = new Map<string, CompliancePage>();
    for (const incidentId of incidentIds) {
      pages.set(incidentId, {
        notifications: await this.listNotifications(tenantId, incidentId),
        review: await this.findReview(tenantId, incidentId),
        actions: await this.listActions(tenantId, incidentId),
      });
    }
    return pages;
  }

  async insertNotification(obligation: NotificationObligation): Promise<void> {
    this.notifications.set(obligation.id, structuredClone(obligation));
  }

  async findNotification(tenantId: string, notificationId: string): Promise<NotificationObligation | null> {
    const found = this.notifications.get(notificationId);
    return found && found.tenantId === tenantId ? structuredClone(found) : null;
  }

  async findNotificationByRegime(tenantId: string, incidentId: string, regime: string): Promise<NotificationObligation | null> {
    const found = [...this.notifications.values()].find(
      (row) => row.tenantId === tenantId && row.incidentId === incidentId && row.regime === regime,
    );
    return found ? structuredClone(found) : null;
  }

  async updateNotification(obligation: NotificationObligation): Promise<void> {
    this.notifications.set(obligation.id, structuredClone(obligation));
  }

  async listNotifications(tenantId: string, incidentId: string): Promise<NotificationObligation[]> {
    return [...this.notifications.values()]
      .filter((row) => row.tenantId === tenantId && row.incidentId === incidentId)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
      .map((row) => structuredClone(row));
  }

  async insertReview(review: ReviewRecord): Promise<void> {
    this.reviews.set(`${review.tenantId}:${review.incidentId}`, structuredClone(review));
  }

  async findReview(tenantId: string, incidentId: string): Promise<ReviewRecord | null> {
    const found = this.reviews.get(`${tenantId}:${incidentId}`);
    return found ? structuredClone(found) : null;
  }

  async insertActions(actions: ReviewActionRecord[]): Promise<void> {
    for (const action of actions) this.actions.set(action.id, structuredClone(action));
  }

  async insertAction(action: ReviewActionRecord): Promise<void> {
    this.actions.set(action.id, structuredClone(action));
  }

  async findAction(tenantId: string, actionId: string): Promise<ReviewActionRecord | null> {
    const found = this.actions.get(actionId);
    return found && found.tenantId === tenantId ? structuredClone(found) : null;
  }

  async listActions(tenantId: string, incidentId: string): Promise<ReviewActionRecord[]> {
    return [...this.actions.values()]
      .filter((row) => row.tenantId === tenantId && row.incidentId === incidentId)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.title.localeCompare(b.title))
      .map((row) => structuredClone(row));
  }

  async updateAction(action: ReviewActionRecord): Promise<void> {
    this.actions.set(action.id, structuredClone(action));
  }
}

/* -------------------------------------------------------------------------- */
/*  Audit                                                                     */
/* -------------------------------------------------------------------------- */

/** The audit event a compliance change emits, shaped like every other one. */
export function complianceAudit(
  incident: IncidentRecord,
  actor: string,
  action: string,
  at: string,
  detail: Record<string, unknown>,
): AuditEventInput {
  return docsAudit(incident, actor, action, at, detail);
}
