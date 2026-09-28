/**
 * SLA escalation service (M1): the sweep that raises a rung on the ladder.
 *
 * Deliberately a plain function the caller schedules — a cron, a worker, a
 * server action — rather than a self-starting timer, so it is trivially
 * testable and safe to run repeatedly: every rung is recorded under a
 * `dedupeKey` (`ticket:kind:level`), and an already-raised rung is skipped.
 *
 * Raising an escalation writes two things: the `SlaEscalation` row (so the desk
 * can see and acknowledge it) and an audit event (so the notice is part of the
 * tamper-evident history). The audit sink is injected, so the app can share the
 * one used by the ticket service and keep a single per-tenant chain.
 */

import { randomUUID } from "node:crypto";

import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  candidatesFor,
  planEscalations,
  DEFAULT_ESCALATION_LADDER,
  type EscalationAudience,
  type EscalationThreshold,
} from "./escalation-rules";
import { resolveSlaPolicy, slaInstanceFor, slaSummary, type SlaPause, type SlaPolicy } from "./sla-rules";
import type { TicketPriority } from "./ticket-rules";

/** The secret a scheduler signs the sweep request with. */
export const ESCALATION_CRON_SECRET_ENV = "ONTRAK_TIX_CRON_SECRET";

export interface SlaEscalationRecord {
  id: string;
  tenantId: string;
  ticketId: string;
  ticketRef: string;
  kind: "response" | "resolution";
  level: number;
  audience: EscalationAudience;
  label: string;
  reason: string;
  dedupeKey: string;
  raisedAt: string;
  acknowledgedAt: string | null;
}

/** The minimum a ticket must expose to be swept. */
export interface EscalationTicket {
  id: string;
  ref: string;
  priority: TicketPriority;
  createdAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  /** Paused windows; a paused clock never advances to a new rung. */
  pauses?: readonly SlaPause[];
  /** The client the work is for, so their policy's clock is the one that runs (M4). */
  clientId?: string | null;
  queueId?: string | null;
  /** Only tickets that are still open are worth escalating. */
  status: string;
}

export interface EscalationStore {
  /** Every rung already raised for a tenant, keyed by `dedupeKey`. */
  raisedKeys(tenantId: string): Promise<Set<string>>;
  record(record: SlaEscalationRecord): Promise<void>;
  listForTenant(tenantId: string): Promise<SlaEscalationRecord[]>;
}

export interface EscalationIds {
  id(): string;
  now(): string;
}

export function systemEscalationIds(): EscalationIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

export interface SweepInput {
  tenantId: string;
  tickets: readonly EscalationTicket[];
  policies: readonly SlaPolicy[];
  now: string;
}

export class EscalationService {
  constructor(
    private readonly store: EscalationStore,
    private readonly audit: AuditSink | null = null,
    private readonly ids: EscalationIds = systemEscalationIds(),
    private readonly ladder: readonly EscalationThreshold[] = DEFAULT_ESCALATION_LADDER,
    /**
     * A hook called once per newly raised rung — the app wires it to the
     * notification service so an escalation reaches staff in-app and by email.
     * It runs after the escalation is stored, and a failure there must not undo
     * the rung, so callers keep it best-effort.
     */
    private readonly onRaised: ((record: SlaEscalationRecord) => Promise<void>) | null = null,
  ) {}

  /**
   * Raise every new rung for the tenant's open tickets. Returns the escalations
   * raised by this sweep; a second call with the same inputs raises nothing.
   */
  async sweep(input: SweepInput): Promise<SlaEscalationRecord[]> {
    const raised = await this.store.raisedKeys(input.tenantId);
    const records: SlaEscalationRecord[] = [];

    for (const ticket of input.tickets) {
      if (ticket.status === "RESOLVED" || ticket.status === "CLOSED") continue;

      // The client's own promise drives the ladder too (M4): a client who bought
      // a one-hour response is escalated by their clock, not the desk's default.
      const { policy } = resolveSlaPolicy({
        policies: input.policies,
        priority: ticket.priority,
        clientId: ticket.clientId,
        queueId: ticket.queueId,
      });
      if (!policy) continue;

      const summary = slaSummary(slaInstanceFor(ticket, policy.id), policy, input.now);
      const plans = planEscalations(candidatesFor(ticket.id, ticket.ref, summary), this.ladder);

      for (const plan of plans) {
        if (raised.has(plan.dedupeKey)) continue;

        const record: SlaEscalationRecord = {
          id: this.ids.id(),
          tenantId: input.tenantId,
          ticketId: plan.ticketId,
          ticketRef: plan.ticketRef,
          kind: plan.kind,
          level: plan.level,
          audience: plan.audience,
          label: plan.label,
          reason: plan.reason,
          dedupeKey: plan.dedupeKey,
          raisedAt: input.now,
          acknowledgedAt: null,
        };
        await this.store.record(record);
        if (this.audit) await this.audit.append(escalationAudit(record));
        if (this.onRaised) await this.onRaised(record).catch(() => undefined);
        raised.add(plan.dedupeKey);
        records.push(record);
      }
    }

    return records;
  }

  /** Every escalation a tenant has raised, newest first. */
  async list(tenantId: string): Promise<SlaEscalationRecord[]> {
    return this.store.listForTenant(tenantId);
  }
}

/** The audit event a raised rung emits. */
export function escalationAudit(record: SlaEscalationRecord): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId: record.tenantId,
    at: record.raisedAt,
    actor: "system:sla-sweep",
    action: "sla.escalate",
    targetType: "ticket",
    targetId: record.ticketId,
    detail: { ref: record.ticketRef, kind: record.kind, level: record.level, audience: record.audience },
  };
}

/** An in-memory store, used by tests and local development. */
export class MemoryEscalationStore implements EscalationStore {
  private readonly records = new Map<string, SlaEscalationRecord>();

  async raisedKeys(tenantId: string): Promise<Set<string>> {
    const keys = new Set<string>();
    for (const record of this.records.values()) {
      if (record.tenantId === tenantId) keys.add(record.dedupeKey);
    }
    return keys;
  }

  async record(record: SlaEscalationRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async listForTenant(tenantId: string): Promise<SlaEscalationRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.tenantId === tenantId)
      .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt))
      .map((record) => structuredClone(record));
  }
}
