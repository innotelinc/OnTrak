/**
 * Detection service (S3): telemetry in, one alert out, and the alert knows who it is about.
 *
 * The pipeline is deliberately short and in one direction:
 *
 * ```
 *   payloads ──▶ normalise ──▶ evaluate ──▶ correlate ──▶ dedupe ──▶ alert (+ evidence)
 *                    │                          │             │
 *              refused with a reason     identity, device,  one row per incident
 *                                        asset when known
 * ```
 *
 * Five things this file decides, and why they are here rather than in a rule:
 *
 *  - **Correlation happens once, after detection.** A rule says *what* fired; joining it
 *    to a person is the product's whole premise (identity-aware detection) and belongs in
 *    one place so every rule gets it — including a rule written next month.
 *  - **Dedupe is the store's job, not the rule's.** The alert row is keyed on the rule, the
 *    group and the window, so two sensors reporting one connection produce one alert and a
 *    restart does not resurrect a burst as a second incident. The store does it with a
 *    unique key rather than a read-then-write, because ingestion is concurrent.
 *  - **A repeat updates and does not duplicate.** Occurrences and the last-seen instant
 *    move, and the evidence grows to a documented ceiling — an alert that keeps every
 *    packet is a memory leak with a severity.
 *  - **Ingestion is not an actor.** A sensor authenticates as a deployment, so the reads
 *    it needs (which sessions came from this address) go to the store rather than through
 *    the spine's actor-gated methods. It cannot write identities, and it cannot read one
 *    beyond the address label an alert names.
 *  - **Refusals are counted, not dropped.** A payload the normalizer will not accept is
 *    reported with its reason; silently discarding telemetry is how a detection gap
 *    becomes a surprise.
 */

import { randomUUID } from "node:crypto";

import type { AuditTrail, IdentityActor, ServiceResult } from "./identity-service";
import type { IdentityStore } from "./identity-service";
import { canReadDirectory } from "./identity-rules";
import { sha256Hex } from "./hash";
import type { HashFn } from "./audit-chain";
import {
  DETECTION_RULES,
  evaluateRules,
  locationOf,
  type AlertDraft,
  type DetectionRule,
  type Severity,
} from "./detection-rules";
import {
  correlateIdentity,
  toObservedEvent,
  validateTelemetrySource,
  type ObservedEvent,
  type TelemetrySource,
} from "./telemetry-rules";
import {
  escalateSeverity,
  matchIndicators,
  type Indicator,
  type IndicatorMatch,
} from "./threat-intel-rules";

/* -------------------------------------------------------------------------- */
/*  Records                                                                   */
/* -------------------------------------------------------------------------- */

export const ALERT_STATES = ["NEW", "ACKNOWLEDGED", "CLOSED"] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export interface AlertRecord {
  id: string;
  organizationId: string;
  ruleId: string;
  ruleVersion: number;
  ruleName: string;
  severity: Severity;
  state: AlertState;
  /** What makes a repeat an update rather than a second incident. */
  dedupeKey: string;
  groupKey: string;
  /** The address the incident is about, which is also what correlation matched on. */
  sourceAddress: string | null;
  identityId: string | null;
  /** The identity's address, kept on the row so a closed alert still reads. */
  identityLabel: string | null;
  device: string | null;
  asset: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  evidence: ObservedEvent[];
  /**
   * The indicators of compromise this alert's evidence matched, with the feed and the
   * confidence each one came with.
   *
   * Carried on the row rather than looked up later for the same reason the evidence is: a
   * feed is edited, a list is pruned, and an alert read next month has to say what was
   * known when it was raised. This is also how a severity escalation stays reviewable —
   * the alert names what moved it.
   */
  threatIntel: IndicatorMatch[];
  /** An operator's note when they acknowledged or closed it. */
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The evidence ceiling. Enough to reconstruct an incident, not enough to be a log store. */
export const ALERT_EVIDENCE_MAX = 50;

export interface AlertStore {
  /**
   * Insert, or return the existing row for this key.
   *
   * A conditional/unique-key write rather than a read-then-write: two sensors can report
   * the same connection in the same millisecond, and the losing write must update the
   * winner rather than being lost or duplicated.
   */
  upsertAlert(record: AlertRecord): Promise<{ alert: AlertRecord; created: boolean }>;
  findAlert(organizationId: string, alertId: string): Promise<AlertRecord | null>;
  listAlerts(organizationId: string): Promise<AlertRecord[]>;
  updateAlert(record: AlertRecord): Promise<void>;
}

export interface DetectionIds {
  id(): string;
  now(): string;
  nowMs(): number;
}

/**
 * What detection needs of threat intelligence, and nothing more.
 *
 * A port rather than a concrete service, so the pipeline can be tested with a fixed list
 * of indicators and so a deployment that has no feed configured gets no enrichment at all
 * rather than an empty lookup on every batch.
 */
export interface IndicatorSource {
  activeIndicators(organizationId: string, at: number): Promise<readonly Indicator[]>;
}

export function systemDetectionIds(): DetectionIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString(), nowMs: () => Date.now() };
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

export interface IngestReport {
  accepted: number;
  rejected: { reason: string }[];
  alerts: { id: string; ruleId: string; severity: Severity; created: boolean; identityLabel: string | null }[];
}

export class DetectionService {
  constructor(
    private readonly store: AlertStore,
    /** Read-only access to sessions and identities, for correlation. Never written. */
    private readonly identities: Pick<IdentityStore, "listSessions" | "findIdentity">,
    private readonly audit: AuditTrail | null = null,
    private readonly rules: readonly DetectionRule[] = DETECTION_RULES,
    private readonly ids: DetectionIds = systemDetectionIds(),
    private readonly hash: HashFn = sha256Hex,
    /**
     * Threat intelligence, if this deployment has a feed configured.
     *
     * Last in the list on purpose: an optional collaborator appended to a constructor is
     * how every existing wiring and every test that builds this service keeps working
     * unchanged, with enrichment switched off until somebody names a feed.
     */
    private readonly intel: IndicatorSource | null = null,
  ) {}

  /** The rules, so a deployment can see what it is running and at which version. */
  rulebook(): readonly DetectionRule[] {
    return this.rules;
  }

  /**
   * Normalise a batch and raise whatever it proves.
   *
   * The batch is the unit on purpose: a behavioural rule needs several observations, and a
   * pipeline that evaluated one at a time could never see a pattern at all.
   */
  async ingest(
    organizationId: string,
    source: string,
    payloads: readonly unknown[],
    context: { sensor: string; at?: number },
  ): Promise<ServiceResult<IngestReport>> {
    const sourceIssues = validateTelemetrySource(source);
    if (sourceIssues.length > 0) return { ok: false, error: sourceIssues[0].message };

    const at = context.at ?? this.ids.nowMs();
    const events: ObservedEvent[] = [];
    const rejected: IngestReport["rejected"] = [];

    for (const payload of payloads) {
      const parsed = toObservedEvent(source as TelemetrySource, payload, { sensor: context.sensor, at });
      if (parsed.ok) events.push(parsed.event);
      else rejected.push({ reason: parsed.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ") });
    }

    const report = await this.record(organizationId, events);
    return {
      ok: true,
      value: {
        accepted: events.length,
        rejected: [...rejected, ...report.rejected],
        alerts: report.alerts,
      },
    };
  }

  /**
   * Evaluate observations and record the alerts they produce.
   *
   * Separated from `ingest` so a test — or a replay tool — can hand the detector events it
   * built itself and get the same answer.
   */
  async record(
    organizationId: string,
    events: readonly ObservedEvent[],
  ): Promise<{ alerts: IngestReport["alerts"]; rejected: IngestReport["rejected"] }> {
    const drafts = evaluateRules(events, this.rules);
    const sessions = await this.identities.listSessions(organizationId);
    // Asked once per batch, not once per draft or per event: the same list answers every
    // rule that fired, and a feed read per observation would turn one burst into a hundred
    // lookups against a table that did not change in between.
    const at = this.ids.nowMs();
    const indicators = this.intel ? await this.intel.activeIndicators(organizationId, at) : [];
    const alerts: IngestReport["alerts"] = [];

    for (const draft of drafts) {
      const identityId = correlateIdentity(draft.evidence[0], sessions);
      const identity = identityId ? await this.identities.findIdentity(organizationId, identityId) : null;
      const { device, asset } = locationOf(draft);

      // What the feeds know about this evidence, and what it does to how bad it is.
      const threatIntel = indicators.length === 0 ? [] : this.matches(draft.evidence, indicators, at);
      const severity = escalateSeverity(draft.severity, threatIntel);

      const now = this.ids.now();
      const record: AlertRecord = {
        id: this.ids.id(),
        organizationId,
        ruleId: draft.ruleId,
        ruleVersion: draft.ruleVersion,
        ruleName: draft.ruleName,
        severity,
        state: "NEW",
        dedupeKey: draft.dedupeKey,
        groupKey: draft.groupKey,
        sourceAddress: draft.evidence[0].sourceAddress,
        identityId: identity?.id ?? null,
        identityLabel: identity?.identifier ?? null,
        device,
        asset,
        firstSeenAt: new Date(draft.firstSeenAt).toISOString(),
        lastSeenAt: new Date(draft.lastSeenAt).toISOString(),
        occurrences: draft.occurrences,
        evidence: draft.evidence.slice(0, ALERT_EVIDENCE_MAX),
        threatIntel,
        note: null,
        createdAt: now,
        updatedAt: now,
      };

      const stored = await this.upsert(record);
      alerts.push({
        id: stored.alert.id,
        ruleId: stored.alert.ruleId,
        severity: stored.alert.severity,
        created: stored.created,
        identityLabel: stored.alert.identityLabel,
      });
      await this.append(organizationId, stored.created ? "guard.alert.raised" : "guard.alert.repeated", stored.alert.id, {
        ruleId: stored.alert.ruleId,
        ruleVersion: stored.alert.ruleVersion,
        severity: stored.alert.severity,
        // The escalation is on the record with its cause, so "why is this CRITICAL?" is
        // answered by the chain rather than by an operator's memory of a feed.
        ruleSeverity: draft.severity,
        escalated: stored.alert.severity !== draft.severity,
        threatIntel: stored.alert.threatIntel.map((match) => ({
          indicatorId: match.indicator.id,
          kind: match.indicator.kind,
          value: match.indicator.value,
          source: match.indicator.source,
          confidence: match.indicator.confidence,
          field: match.field,
        })),
        identityId: stored.alert.identityId,
        device: stored.alert.device,
        asset: stored.alert.asset,
        occurrences: stored.alert.occurrences,
        sourceAddress: stored.alert.sourceAddress,
      });
    }

    return { alerts, rejected: [] };
  }

  /* ------------------------------------------------------------- triage */

  async alerts(actor: IdentityActor): Promise<ServiceResult<AlertRecord[]>> {
    if (!canReadDirectory(actor.role)) return { ok: false, error: "You do not have access to Guard alerts." };
    return { ok: true, value: await this.store.listAlerts(actor.organizationId) };
  }

  /** Acknowledge: somebody has seen it. Not the same as done. */
  async acknowledge(actor: IdentityActor, alertId: string, note: string | null): Promise<ServiceResult<AlertRecord>> {
    if (!canReadDirectory(actor.role)) return { ok: false, error: "You do not have access to Guard alerts." };
    return this.transition(actor, alertId, "ACKNOWLEDGED", note);
  }

  /**
   * Close: somebody decided it is handled.
   *
   * A reason is required, for the same reason ending a session needs one — "why was this
   * closed?" is the question an incident review asks, and a blank answer is not one.
   */
  async close(actor: IdentityActor, alertId: string, note: string): Promise<ServiceResult<AlertRecord>> {
    if (!canReadDirectory(actor.role)) return { ok: false, error: "You do not have access to Guard alerts." };
    if (note.trim().length < 3) return { ok: false, error: "Closing an alert needs a reason on the record." };
    return this.transition(actor, alertId, "CLOSED", note);
  }

  private async transition(
    actor: IdentityActor,
    alertId: string,
    state: AlertState,
    note: string | null,
  ): Promise<ServiceResult<AlertRecord>> {
    const found = await this.store.findAlert(actor.organizationId, alertId);
    if (!found) return { ok: false, error: "That alert does not exist." };

    const next: AlertRecord = { ...found, state, note: note?.trim() || found.note, updatedAt: this.ids.now() };
    await this.store.updateAlert(next);
    await this.append(actor.organizationId, `guard.alert.${state.toLowerCase()}`, next.id, {
      by: actor.id,
      note: next.note,
      ruleId: next.ruleId,
    });
    return { ok: true, value: next };
  }

  /* ----------------------------------------------------------- internals */

  /**
   * Every indicator a draft's evidence matched, most confident first.
   *
   * Across all of the evidence rather than only the first observation: a sequence rule's
   * alert is built from five events and the interesting address is often not the one that
   * opened it.
   */
  private matches(
    evidence: readonly ObservedEvent[],
    indicators: readonly Indicator[],
    at: number,
  ): IndicatorMatch[] {
    const seen = new Set<string>();
    const out: IndicatorMatch[] = [];
    for (const event of evidence) {
      for (const match of matchIndicators(event, indicators, at)) {
        if (seen.has(match.indicator.id)) continue;
        seen.add(match.indicator.id);
        out.push(match);
      }
    }
    return out.sort((a, b) => b.indicator.confidence - a.indicator.confidence);
  }

  /** Merge a repeat into the row that already exists, rather than raising a second one. */
  private async upsert(record: AlertRecord): Promise<{ alert: AlertRecord; created: boolean }> {
    const existing = (await this.store.listAlerts(record.organizationId)).find((entry) => entry.dedupeKey === record.dedupeKey);
    if (!existing) {
      const stored = await this.store.upsertAlert(record);
      return stored;
    }

    // Severity rises and does not fall on a repeat: the first burst is still part of the
    // incident even after the feed that escalated it was withdrawn, and an alert that
    // quietly walked back from CRITICAL to LOW is one nobody can review.
    const severity = escalateSeverity(existing.severity, record.threatIntel);
    const known = new Set(existing.threatIntel.map((match) => match.indicator.id));
    const merged: AlertRecord = {
      ...existing,
      lastSeenAt: record.lastSeenAt,
      occurrences: existing.occurrences + record.occurrences,
      severity,
      // The identity is filled in if the first pass could not correlate (the session may
      // have been granted after the first packet arrived) and never blanked out.
      identityId: existing.identityId ?? record.identityId,
      identityLabel: existing.identityLabel ?? record.identityLabel,
      device: existing.device ?? record.device,
      asset: existing.asset ?? record.asset,
      evidence: [...existing.evidence, ...record.evidence].slice(0, ALERT_EVIDENCE_MAX),
      // Union, so a repeat that matches a *new* indicator keeps the old ones on the record.
      threatIntel: [
        ...existing.threatIntel,
        ...record.threatIntel.filter((match) => !known.has(match.indicator.id)),
      ],
      updatedAt: record.updatedAt,
    };
    await this.store.updateAlert(merged);
    return { alert: merged, created: false };
  }

  private async append(
    organizationId: string,
    action: string,
    targetId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) return;
    await this.audit.append({
      id: this.ids.id(),
      at: this.ids.now(),
      // A sensor is not an actor and is not given one: the chain says which rule fired and
      // what it saw, and the token that ingested it is the deployment's.
      actor: "sensor",
      action,
      targetType: "Alert",
      targetId,
      detail: { ...detail, organizationId },
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  An in-memory store, used by tests and the memory-mode server              */
/* -------------------------------------------------------------------------- */

export class MemoryAlertStore implements AlertStore {
  private readonly alerts = new Map<string, AlertRecord>();

  async upsertAlert(record: AlertRecord): Promise<{ alert: AlertRecord; created: boolean }> {
    const existing = [...this.alerts.values()].find(
      (entry) => entry.organizationId === record.organizationId && entry.dedupeKey === record.dedupeKey,
    );
    if (existing) return { alert: structuredClone(existing), created: false };
    this.alerts.set(record.id, structuredClone(record));
    return { alert: structuredClone(record), created: true };
  }

  async findAlert(organizationId: string, alertId: string): Promise<AlertRecord | null> {
    const found = this.alerts.get(alertId);
    return found && found.organizationId === organizationId ? structuredClone(found) : null;
  }

  async listAlerts(organizationId: string): Promise<AlertRecord[]> {
    return [...this.alerts.values()]
      .filter((entry) => entry.organizationId === organizationId)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map((entry) => structuredClone(entry));
  }

  async updateAlert(record: AlertRecord): Promise<void> {
    this.alerts.set(record.id, structuredClone(record));
  }
}
