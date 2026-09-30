/**
 * War-room timeline service (M3): the incident's story told by every system that
 * witnessed it.
 *
 * The incident log holds what the responders wrote. This service adds what the
 * systems recorded — the tenant's hash-chained audit log (sign-ins, role
 * changes, alert ingests, packet exports), the alerts that belong to this
 * incident, and the decisions taken about them (promotions, suppressions,
 * triage verdicts) — and merges the lot into one ordered, de-duplicated timeline.
 *
 * Three things it deliberately does not do:
 *
 *  - it does not modify anything. Assembling the timeline is a *read*; it writes
 *    no timeline event of its own, because a record that logs being read grows
 *    without telling anyone anything;
 *  - it does not invent events. Everything on the line is a row that already
 *    existed, with the source named on it;
 *  - it does not silently drop the audit log's own events. A packet export or a
 *    manifest generation has no incident-log twin, so it appears as an
 *    audit-only line — which is exactly the kind of fact a reviewer wants and an
 *    operator would never have written down.
 */

import { actorHasPermission, type Actor } from "./access-rules";
import type { AuditChain } from "./audit-chain";
import type { AlertVerdict } from "./alert-promotion-rules";
import type { IncidentRecord, IncidentStore } from "./incident-service";
import type { ServiceResult } from "./ticket-service";
import {
  auditRecordToWarRoom,
  clipWarRoom,
  incidentEventToWarRoom,
  mergeWarRoomEvents,
  promotionToWarRoom,
  relevantAlerts,
  securityAlertToWarRoom,
  verdictToWarRoom,
  warRoomSummary,
  warRoomWindow,
  type WarRoomEntry,
  type WarRoomSummary,
  type WarRoomWindow,
} from "./war-room-rules";

/** The alerts this tenant holds (the security-telemetry service satisfies this). */
export interface WarRoomAlertReader {
  list(tenantId: string): Promise<
    {
      id: string;
      source: string;
      signature: string;
      severity: string;
      description: string;
      occurredAt: string;
      ticketId: string | null;
      asset: string | null;
      identity: string | null;
    }[]
  >;
}

/** The decisions taken about those alerts. */
export interface WarRoomDecisionReader {
  listPromotions(tenantId: string): Promise<
    { id: string; alertId: string; decision: string; reason: string; ticketRef: string | null; at: string }[]
  >;
  listVerdicts(tenantId: string): Promise<AlertVerdict[]>;
}

export interface WarRoomDeps {
  incidents: IncidentStore;
  auditReader: { read(tenantId: string): Promise<AuditChain> };
  alerts: WarRoomAlertReader;
  decisions: WarRoomDecisionReader;
  now?: () => string;
  /** How far before detection the timeline opens. Sign-ins are the run-up. */
  leadInMinutes?: number;
}

export interface WarRoomTimeline {
  window: WarRoomWindow;
  entries: WarRoomEntry[];
  summary: WarRoomSummary;
}

/** The tenant-wide reads every incident's timeline is assembled from. */
type Alerts = Awaited<ReturnType<WarRoomAlertReader["list"]>>;
type Promotions = Awaited<ReturnType<WarRoomDecisionReader["listPromotions"]>>;
type Verdicts = Awaited<ReturnType<WarRoomDecisionReader["listVerdicts"]>>;

interface WarRoomContext {
  chain: AuditChain;
  alerts: Alerts;
  promotions: Promotions;
  verdicts: Verdicts;
}

export class WarRoomService {
  private readonly now: () => string;
  private readonly leadInMinutes: number;

  constructor(private readonly deps: WarRoomDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.leadInMinutes = deps.leadInMinutes ?? 60;
  }

  /** Assemble the timeline for one incident. Staff-only, like every read here. */
  async timeline(actor: Actor, incidentId: string): Promise<ServiceResult<WarRoomTimeline>> {
    if (!actorHasPermission(actor, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to incidents." };
    }

    const incident = await this.deps.incidents.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };

    const context = await this.read(actor.tenantId);
    return { ok: true, value: await this.assemble(actor.tenantId, incident, context) };
  }

  /**
   * Assemble the timeline for every incident on a page, from **one** set of
   * tenant-wide reads.
   *
   * The audit chain, the alert stream and the decision log are per tenant, not
   * per incident, so reading them inside a loop would read the same chain once
   * per incident — which is not a rounding error when a console lists a dozen
   * incidents and the chain holds thousands of records. The single-incident
   * method above is the same code path with a `Map` of one.
   */
  async timelines(actor: Actor, incidents: readonly IncidentRecord[]): Promise<ServiceResult<Map<string, WarRoomTimeline>>> {
    if (!actorHasPermission(actor, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to incidents." };
    }
    if (incidents.length === 0) return { ok: true, value: new Map() };

    const context = await this.read(actor.tenantId);
    const timelines = new Map<string, WarRoomTimeline>();
    for (const incident of incidents) {
      timelines.set(incident.id, await this.assemble(actor.tenantId, incident, context));
    }
    return { ok: true, value: timelines };
  }

  /** Every tenant-wide read the assembly needs, done once. */
  private async read(tenantId: string): Promise<WarRoomContext> {
    const [chain, alerts, promotions, verdicts] = await Promise.all([
      this.deps.auditReader.read(tenantId),
      this.deps.alerts.list(tenantId),
      this.deps.decisions.listPromotions(tenantId),
      this.deps.decisions.listVerdicts(tenantId),
    ]);
    return { chain, alerts, promotions, verdicts };
  }

  /** One incident's story, from the already-read tenant context. */
  private async assemble(tenantId: string, incident: IncidentRecord, context: WarRoomContext): Promise<WarRoomTimeline> {
    const window = warRoomWindow(incident, this.now(), this.leadInMinutes);
    const events = await this.deps.incidents.listEvents(tenantId, incident.id);

    const relevant = relevantAlerts(incident, context.alerts, window);
    const relevantIds = new Set(relevant.map(({ alert }) => alert.id));
    const signatures = new Set(relevant.map(({ alert }) => alert.signature));

    const merged = mergeWarRoomEvents([
      ...events.map(incidentEventToWarRoom),
      ...context.chain.events
        .map((record) => auditRecordToWarRoom(record, { incidentId: incident.id, alertIds: relevantIds }))
        .filter((entry) => entry !== null),
      ...relevant.map(({ alert, because }) => securityAlertToWarRoom(alert, because)),
      // Only decisions about alerts that belong to this incident, so the
      // timeline does not quietly absorb the rest of the desk's triage queue.
      ...context.promotions.filter((record) => relevantIds.has(record.alertId)).map(promotionToWarRoom),
      ...context.verdicts.filter((verdict) => signatures.has(verdict.signature)).map(verdictToWarRoom),
    ]);

    const entries = clipWarRoom(merged, window);
    return { window, entries, summary: warRoomSummary(entries) };
  }
}
