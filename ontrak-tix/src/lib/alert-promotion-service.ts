/**
 * Alert → ticket promotion service (M2): turns a decided alert into work, once.
 *
 * `alert-promotion-rules.ts` decides *what the alert is worth*; this service
 * decides what happens next and writes the three things that must outlive the
 * request:
 *
 *  - the alert's link to the ticket it became (`SecurityAlert.ticketId`),
 *  - the promotion decision itself (promote or suppress), so a reader can see
 *    *why* an alert was or was not worked,
 *  - a hash-chained audit event, so the decision is tamper-evident.
 *
 * Promotion is idempotent by construction: an alert that already carries a
 * `ticketId` is never re-promoted, and `SecurityAlertService.linkTicket` is
 * first-write-wins, so a retried or concurrent promotion returns the ticket that
 * already exists instead of opening a second one.
 *
 * The ticket stack is injected whole (`TicketService` + its store), so promotion
 * writes through the same lifecycle, access rules and audit sink as every other
 * ticket — there is no privileged back door.
 */

import { randomUUID } from "node:crypto";

import type { Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  DEFAULT_PROMOTION_POLICY,
  decidePromotion,
  promotionDraft,
  type AlertVerdict,
  type AlertVerdictInput,
  type PromotionContext,
  type PromotionDecision,
  type PromotionPolicy,
  type StoredSuppressionRule,
  type SuppressionRule,
} from "./alert-promotion-rules";
import type { SecurityAlertRecord, SecurityAlertService } from "./security-alert-service";
import type { ServiceResult, TicketRecord, TicketService } from "./ticket-service";

/** The system actor a promotion writes as. It is a normal ADMIN, on purpose. */
export const SYSTEM_PROMOTION_ACTOR = "system:alert-promotion";

/** The actor a promotion runs as, scoped to the tenant it is acting for. */
export function promotionActor(tenantId: string): Actor {
  return { id: SYSTEM_PROMOTION_ACTOR, tenantId, role: "ADMIN" };
}

/** One recorded promotion decision. Only PROMOTE and SUPPRESS are persisted. */
export interface PromotionRecord {
  id: string;
  tenantId: string;
  alertId: string;
  decision: "PROMOTE" | "SUPPRESS";
  reason: string;
  ticketId: string | null;
  ticketRef: string | null;
  at: string;
}

export interface PromotionStore {
  listVerdicts(tenantId: string): Promise<AlertVerdict[]>;
  recordVerdict(verdict: AlertVerdict): Promise<void>;
  listSuppressions(tenantId: string): Promise<StoredSuppressionRule[]>;
  recordSuppression(rule: StoredSuppressionRule): Promise<void>;
  recordPromotion(record: PromotionRecord): Promise<void>;
  listPromotions(tenantId: string): Promise<PromotionRecord[]>;
}

export interface PromotionIds {
  id(): string;
  now(): string;
}

export function systemPromotionIds(): PromotionIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

export interface PromotionResult {
  decision: PromotionDecision;
  alert: SecurityAlertRecord;
  /** The ticket the alert became, or the one it already had. */
  ticket: TicketRecord | null;
  promotion: PromotionRecord | null;
  /** True when this call found the alert already promoted and did nothing. */
  alreadyPromoted: boolean;
}

export interface PromotionInput {
  /** Who the incident is raised for; the caller resolves a real user. */
  requesterId: string;
  queueId?: string | null;
}

/** The alerts/store/ids this service needs to promote; injected as one bundle. */
export interface AlertPromotionDeps {
  alerts: Pick<SecurityAlertService, "get" | "linkTicket">;
  tickets: Pick<TicketService, "createTicket"> & { findTicket(tenantId: string, ticketId: string): Promise<TicketRecord | null> };
}

export class AlertPromotionService {
  constructor(
    private readonly deps: AlertPromotionDeps,
    private readonly store: PromotionStore,
    private readonly audit: AuditSink | null = null,
    private readonly ids: PromotionIds = systemPromotionIds(),
    private readonly policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
  ) {}

  /**
   * Decide what an alert is worth without writing anything — the read the triage
   * view uses to explain the stream.
   */
  async evaluate(tenantId: string, alertId: string): Promise<ServiceResult<{ decision: PromotionDecision; alert: SecurityAlertRecord }>> {
    const alert = await this.deps.alerts.get(tenantId, alertId);
    if (!alert) return { ok: false, error: "Alert not found." };
    const decision = decidePromotion(alert, this.policy, await this.contextFor(tenantId));
    return { ok: true, value: { decision, alert } };
  }

  /**
   * Promote an alert if the rules say to. Idempotent: an already-promoted alert
   * returns its existing ticket and writes nothing new.
   */
  async promote(actor: Actor, alertId: string, input: PromotionInput): Promise<ServiceResult<PromotionResult>> {
    const alert = await this.deps.alerts.get(actor.tenantId, alertId);
    if (!alert) return { ok: false, error: "Alert not found." };

    if (alert.ticketId) {
      const ticket = await this.deps.tickets.findTicket(actor.tenantId, alert.ticketId);
      return {
        ok: true,
        value: {
          decision: decidePromotion(alert, this.policy, await this.contextFor(actor.tenantId)),
          alert,
          ticket,
          promotion: null,
          alreadyPromoted: true,
        },
      };
    }

    const decision = decidePromotion(alert, this.policy, await this.contextFor(actor.tenantId));
    if (decision.outcome === "OBSERVE") {
      return { ok: true, value: { decision, alert, ticket: null, promotion: null, alreadyPromoted: false } };
    }

    const at = this.ids.now();
    const record: PromotionRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      alertId: alert.id,
      decision: decision.outcome === "PROMOTE" ? "PROMOTE" : "SUPPRESS",
      reason: decision.reason,
      ticketId: null,
      ticketRef: null,
      at,
    };

    if (decision.outcome === "SUPPRESS") {
      await this.store.recordPromotion(record);
      if (this.audit) await this.audit.append(promotionAudit(record));
      return { ok: true, value: { decision, alert, ticket: null, promotion: record, alreadyPromoted: false } };
    }

    // PROMOTE: open the incident through the normal ticket lifecycle. The
    // requester is a real user supplied by the caller; the actor is the system.
    const draft = promotionDraft(alert, this.policy);
    const created = await this.deps.tickets.createTicket(promotionActor(actor.tenantId), {
      subject: draft.subject,
      description: draft.description,
      type: draft.type,
      priority: draft.priority,
      requesterId: input.requesterId,
      queueId: input.queueId ?? null,
    });
    if (!created.ok) return created;

    const ticket = created.value;
    const linked = await this.deps.alerts.linkTicket(actor.tenantId, alert.id, ticket.id);
    const promotion: PromotionRecord = { ...record, ticketId: ticket.id, ticketRef: ticket.ref };
    await this.store.recordPromotion(promotion);
    if (this.audit) await this.audit.append(promotionAudit(promotion));

    return {
      ok: true,
      value: { decision, alert: linked ?? alert, ticket, promotion, alreadyPromoted: false },
    };
  }

  /** Record a staff verdict on a detection, feeding false-positive suppression. */
  async recordVerdict(actor: Actor, input: { signature: string; verdict: AlertVerdictInput["verdict"]; note?: string | null }): Promise<AlertVerdict> {
    const verdict: AlertVerdict = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      signature: input.signature.trim(),
      verdict: input.verdict,
      at: this.ids.now(),
      by: actor.id,
      note: input.note?.trim() || null,
    };
    await this.store.recordVerdict(verdict);
    if (this.audit) await this.audit.append(verdictAudit(verdict));
    return verdict;
  }

  /** Configure a suppression rule for the tenant. */
  async addSuppression(actor: Actor, rule: SuppressionRule): Promise<StoredSuppressionRule> {
    const stored: StoredSuppressionRule = {
      ...rule,
      id: this.ids.id(),
      tenantId: actor.tenantId,
      createdBy: actor.id,
      createdAt: this.ids.now(),
    };
    await this.store.recordSuppression(stored);
    if (this.audit) await this.audit.append(suppressionAudit(stored));
    return stored;
  }

  async listVerdicts(tenantId: string): Promise<AlertVerdict[]> {
    return this.store.listVerdicts(tenantId);
  }

  async listSuppressions(tenantId: string): Promise<StoredSuppressionRule[]> {
    return this.store.listSuppressions(tenantId);
  }

  async listPromotions(tenantId: string): Promise<PromotionRecord[]> {
    return this.store.listPromotions(tenantId);
  }

  /** The verdicts and rules the decision reads, as one context. */
  private async contextFor(tenantId: string): Promise<PromotionContext> {
    const [verdicts, suppressions] = await Promise.all([
      this.store.listVerdicts(tenantId),
      this.store.listSuppressions(tenantId),
    ]);
    return { verdicts, rules: suppressions, now: this.ids.now() };
  }
}

/** The audit event a promotion decision emits. */
export function promotionAudit(record: PromotionRecord): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId: record.tenantId,
    at: record.at,
    actor: SYSTEM_PROMOTION_ACTOR,
    action: record.decision === "PROMOTE" ? "security.alert.promote" : "security.alert.suppress",
    targetType: "security-alert",
    targetId: record.alertId,
    detail: { decision: record.decision, reason: record.reason, ticketId: record.ticketId, ticketRef: record.ticketRef },
  };
}

/** The audit event a recorded verdict emits. */
export function verdictAudit(verdict: AlertVerdict): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId: verdict.tenantId,
    at: verdict.at,
    actor: verdict.by ?? SYSTEM_PROMOTION_ACTOR,
    action: "security.alert.verdict",
    targetType: "security-detection",
    targetId: verdict.signature,
    detail: { verdict: verdict.verdict, note: verdict.note },
  };
}

/** The audit event a configured suppression emits. */
export function suppressionAudit(rule: StoredSuppressionRule): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId: rule.tenantId,
    at: rule.createdAt,
    actor: rule.createdBy ?? SYSTEM_PROMOTION_ACTOR,
    action: "security.alert.suppression",
    targetType: "security-suppression",
    targetId: rule.id,
    detail: { field: rule.field, match: rule.match, reason: rule.reason, until: rule.until ?? null },
  };
}

/** An in-memory store, used by tests and local development. */
export class MemoryPromotionStore implements PromotionStore {
  private readonly verdicts = new Map<string, AlertVerdict>();
  private readonly suppressions = new Map<string, StoredSuppressionRule>();
  private readonly promotions = new Map<string, PromotionRecord>();

  async listVerdicts(tenantId: string): Promise<AlertVerdict[]> {
    return [...this.verdicts.values()]
      .filter((verdict) => verdict.tenantId === tenantId)
      .map((verdict) => structuredClone(verdict));
  }

  async recordVerdict(verdict: AlertVerdict): Promise<void> {
    this.verdicts.set(verdict.id, structuredClone(verdict));
  }

  async listSuppressions(tenantId: string): Promise<StoredSuppressionRule[]> {
    return [...this.suppressions.values()]
      .filter((rule) => rule.tenantId === tenantId)
      .map((rule) => structuredClone(rule));
  }

  async recordSuppression(rule: StoredSuppressionRule): Promise<void> {
    this.suppressions.set(rule.id, structuredClone(rule));
  }

  async recordPromotion(record: PromotionRecord): Promise<void> {
    // One record per (alert, decision): a retried decision does not duplicate.
    this.promotions.set(`${record.tenantId}:${record.alertId}:${record.decision}`, structuredClone(record));
  }

  async listPromotions(tenantId: string): Promise<PromotionRecord[]> {
    return [...this.promotions.values()]
      .filter((record) => record.tenantId === tenantId)
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((record) => structuredClone(record));
  }
}
