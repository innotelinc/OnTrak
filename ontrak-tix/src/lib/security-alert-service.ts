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
}

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
