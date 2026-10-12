/**
 * Security-telemetry service (M2): persist normalized alerts, once.
 *
 * The rules module decides what an alert *is*; this service decides what happens
 * to it. Two guarantees matter:
 *
 *  - **A repeat is not a second alert.** Every ingest is looked up by its
 *    `dedupeKey` first, so the same detection arriving from two feeds — or the
 *    same webhook retried — bumps `occurrences` instead of inserting a row. That
 *    is what makes "an IDS/IPS alert lands once (deduped)" true even when the
 *    transport is at-least-once.
 *  - **The first sighting is audited.** The initial ingest writes a
 *    `security.alert.ingest` event into the hash-chained log, so the record that
 *    the desk acted on is part of the tamper-evident history. Repeats do not;
 *    they are the same alert, not new activity.
 *
 * The store and the audit sink are injected, so the app can share the ticket
 * stack's audit chain and keep one per-tenant sequence.
 */

import { randomUUID } from "node:crypto";

import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  enrichAlert,
  normalizeAlert,
  type EnrichedSecurityAlert,
  type EnrichmentContext,
  type RawSecurityAlert,
} from "./security-alert-rules";

export interface SecurityAlertRecord extends EnrichedSecurityAlert {
  id: string;
  tenantId: string;
  /** When the desk first saw this alert. */
  firstSeenAt: string;
  /** The most recent occurrence folded into this row. */
  lastSeenAt: string;
  /** How many repeats have been folded in; 1 for a first sighting. */
  occurrences: number;
  /** The ticket this alert was promoted to, set by the promotion rules (M2). */
  ticketId: string | null;
  /**
   * Where this alert stands with Sentinel's prevention, if anywhere.
   *
   * On the alert rather than in a table of its own because it is one fact about one alert and
   * the queue has to show it: an operator looking at a row needs to know whether a block was
   * asked for, whether it is waiting for an approver in the other product, and whether a rail
   * refused it — three different sentences that a boolean could not tell apart.
   */
  containmentState: ContainmentState;
  /** Sentinel's action id, so the desk can point at the action it asked for. */
  containmentActionId: string | null;
}

/**
 * The states a containment request can be in, from the desk's side.
 *
 * `NONE` is a real state and not an absence: most alerts are never contained, and a queue that
 * rendered that as blank would make "nothing was asked" and "something was asked and lost"
 * look the same.
 */
export const CONTAINMENT_STATES = ["NONE", "REQUESTED", "PENDING", "APPLIED", "REFUSED", "FAILED"] as const;
export type ContainmentState = (typeof CONTAINMENT_STATES)[number];

export interface SecurityAlertStore {
  findById(tenantId: string, alertId: string): Promise<SecurityAlertRecord | null>;
  findByDedupeKey(tenantId: string, dedupeKey: string): Promise<SecurityAlertRecord | null>;
  insert(record: SecurityAlertRecord): Promise<void>;
  update(record: SecurityAlertRecord): Promise<void>;
  list(tenantId: string): Promise<SecurityAlertRecord[]>;
}

export interface SecurityAlertIds {
  id(): string;
}

export function systemSecurityAlertIds(): SecurityAlertIds {
  return { id: () => randomUUID() };
}

export interface IngestResult {
  alert: SecurityAlertRecord;
  /** True when this ingest folded into an alert already held. */
  duplicate: boolean;
}

export class SecurityAlertService {
  constructor(
    private readonly store: SecurityAlertStore,
    private readonly audit: AuditSink | null = null,
    private readonly ids: SecurityAlertIds = systemSecurityAlertIds(),
    /** What the desk knows about assets/identities, for enrichment. */
    private readonly enrichment: EnrichmentContext = {},
  ) {}

  /**
   * Ingest one raw vendor alert. Idempotent by `dedupeKey`: a repeat bumps the
   * occurrence count and advances `lastSeenAt` without creating a row.
   */
  async ingest(tenantId: string, raw: RawSecurityAlert): Promise<IngestResult> {
    const enriched = enrichAlert(normalizeAlert(raw), this.enrichment);
    const existing = await this.store.findByDedupeKey(tenantId, enriched.dedupeKey);

    if (existing) {
      const merged: SecurityAlertRecord = {
        ...existing,
        // Re-enrich from the latest context, but keep the row's identity and
        // first sighting — a repeat must not rewrite when the alert began.
        ...enriched,
        id: existing.id,
        tenantId: existing.tenantId,
        firstSeenAt: existing.firstSeenAt,
        lastSeenAt: enriched.occurredAt > existing.lastSeenAt ? enriched.occurredAt : existing.lastSeenAt,
        occurrences: existing.occurrences + 1,
        // A repeat must not forget that this alert already became a ticket.
        ticketId: existing.ticketId,
        // Nor that containment was asked for: a detector repeating its finding is not a reason
        // for the desk to lose track of the block standing against it.
        containmentState: existing.containmentState,
        containmentActionId: existing.containmentActionId,
      };
      await this.store.update(merged);
      return { alert: merged, duplicate: true };
    }

    const record: SecurityAlertRecord = {
      ...enriched,
      id: this.ids.id(),
      tenantId,
      firstSeenAt: enriched.occurredAt,
      lastSeenAt: enriched.occurredAt,
      occurrences: 1,
      ticketId: null,
      containmentState: "NONE",
      containmentActionId: null,
    };
    await this.store.insert(record);
    if (this.audit) await this.audit.append(ingestAudit(record));
    return { alert: record, duplicate: false };
  }

  /** Every alert a tenant holds — the feed a triage view reads. */
  async list(tenantId: string): Promise<SecurityAlertRecord[]> {
    return this.store.list(tenantId);
  }

  /** One alert, scoped to its tenant, or `null`. */
  async get(tenantId: string, alertId: string): Promise<SecurityAlertRecord | null> {
    return this.store.findById(tenantId, alertId);
  }

  /**
   * Record that an alert became a ticket. The first write wins: a second link
   * attempt returns the alert unchanged, so a retried promotion cannot silently
   * point the alert at a different ticket. Returns `null` for an unknown alert.
   */
  async linkTicket(tenantId: string, alertId: string, ticketId: string): Promise<SecurityAlertRecord | null> {
    const alert = await this.store.findById(tenantId, alertId);
    if (!alert) return null;
    if (alert.ticketId) return alert;
    const linked: SecurityAlertRecord = { ...alert, ticketId };
    await this.store.update(linked);
    return linked;
  }

  /**
   * Record where an alert stands with prevention.
   *
   * A later write always wins here, unlike the ticket link, and the asymmetry is the point:
   * an alert becomes one ticket and stays there, while containment genuinely *moves* — asked
   * for, then pending, then applied, then lifted — and each move is a fact the queue has to
   * show. Returns `null` for an unknown alert rather than creating one, so a containment
   * callback for an alert somebody deleted cannot resurrect a row.
   */
  async linkContainment(
    tenantId: string,
    alertId: string,
    input: { state: ContainmentState; actionId: string | null },
  ): Promise<SecurityAlertRecord | null> {
    const alert = await this.store.findById(tenantId, alertId);
    if (!alert) return null;
    const updated: SecurityAlertRecord = {
      ...alert,
      containmentState: input.state,
      containmentActionId: input.actionId,
    };
    await this.store.update(updated);
    return updated;
  }
}

/** The audit event a containment request emits, whether it was applied or refused. */
export function containmentAudit(
  record: SecurityAlertRecord,
  input: { action: string; outcome: string; actionId: string | null; reason: string | null; by: string },
): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId: record.tenantId,
    at: new Date().toISOString(),
    actor: `staff:${input.by}`,
    action: `security.containment.${input.outcome.toLowerCase()}`,
    targetType: "security-alert",
    targetId: record.id,
    detail: {
      signature: record.signature,
      source: record.source,
      request: input.action,
      outcome: input.outcome,
      // Sentinel's own id, so the desk's record and the other product's register point at each
      // other rather than being two stories about one block.
      sentinelActionId: input.actionId,
      reason: input.reason,
      by: input.by,
    },
  };
}

/** The audit event the first sighting of an alert emits. */
export function ingestAudit(record: SecurityAlertRecord): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId: record.tenantId,
    at: record.occurredAt,
    actor: "system:security-ingest",
    action: "security.alert.ingest",
    targetType: "security-alert",
    targetId: record.id,
    detail: {
      source: record.source,
      severity: record.severity,
      triageSeverity: record.triageSeverity,
      signature: record.signature,
      asset: record.asset,
      identity: record.identity,
      dedupeKey: record.dedupeKey,
    },
  };
}

/** An in-memory store, used by tests and local development. */
export class MemorySecurityAlertStore implements SecurityAlertStore {
  private readonly alerts = new Map<string, SecurityAlertRecord>();

  async findById(tenantId: string, alertId: string): Promise<SecurityAlertRecord | null> {
    const record = this.alerts.get(alertId);
    return record && record.tenantId === tenantId ? structuredClone(record) : null;
  }

  async findByDedupeKey(tenantId: string, dedupeKey: string): Promise<SecurityAlertRecord | null> {
    for (const record of this.alerts.values()) {
      if (record.tenantId === tenantId && record.dedupeKey === dedupeKey) return structuredClone(record);
    }
    return null;
  }

  async insert(record: SecurityAlertRecord): Promise<void> {
    this.alerts.set(record.id, structuredClone(record));
  }

  async update(record: SecurityAlertRecord): Promise<void> {
    this.alerts.set(record.id, structuredClone(record));
  }

  async list(tenantId: string): Promise<SecurityAlertRecord[]> {
    return [...this.alerts.values()]
      .filter((record) => record.tenantId === tenantId)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map((record) => structuredClone(record));
  }
}
