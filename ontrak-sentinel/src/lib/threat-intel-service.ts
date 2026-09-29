/**
 * Threat intelligence service (S3): the feed's side of the pipeline.
 *
 * The rules module decides what a match means; this file decides what an indicator *is* —
 * who may add one, what a feed's re-send does, how a wrong entry is withdrawn, and what
 * the detector is handed on every batch.
 *
 * Five decisions worth stating out loud:
 *
 *  - **A feed is data with a provenance, and provenance is required.** Every indicator
 *    names the feed it came from. An indicator whose provenance is unknown cannot be
 *    withdrawn when the feed turns out to be wrong, and "which feed told us this?" is the
 *    first question asked about a false positive.
 *  - **Re-ingesting a feed updates rather than duplicates.** The id is derived from the
 *    kind and the canonical value, so a feed polled hourly for a year is a table that
 *    reflects the feed rather than a table that grew by its size every hour — and two feeds
 *    naming one address is one row whose provenance is the feed that spoke last, the trade
 *    documented on `indicatorId`.
 *  - **Ingestion is all-or-nothing per row, and the refusals are reported.** A feed that
 *    ships one bad line should not be rejected whole, and it should not have that line
 *    silently dropped either: a row that will never match anything is worse than no row,
 *    because it reads as protection.
 *  - **Withdrawing an indicator is an audited decision.** Removing an entry is how a
 *    deployment stops a false positive, so it belongs on the chain next to every other
 *    decision — and the read path never mutates, so a feed cannot quietly un-list itself.
 *  - **The detector is handed active indicators only.** Expiry is applied where the list is
 *    read, in one place, so there is no window in which a sweep has not run yet.
 */

import { randomUUID } from "node:crypto";

import type { AuditTrail, IdentityActor, ServiceResult } from "./identity-service";
import { canManagePolicies, canReadDirectory } from "./identity-rules";
import { sha256Hex } from "./hash";
import type { HashFn } from "./audit-chain";
import {
  isActive,
  parseIndicator,
  type Indicator,
} from "./threat-intel-rules";

/** An indicator as this deployment holds it: the value, and whose tenant it belongs to. */
export interface StoredIndicator extends Indicator {
  organizationId: string;
}

/**
 * The port the detector reads through.
 *
 * Implemented by `ThreatIntelService`, and deliberately narrow: detection needs the active
 * list and nothing else, so it cannot accidentally become a second writer of feeds.
 */
export interface IndicatorStore {
  upsertIndicator(record: StoredIndicator): Promise<{ indicator: StoredIndicator; created: boolean }>;
  listIndicators(organizationId: string): Promise<StoredIndicator[]>;
  findIndicator(organizationId: string, indicatorId: string): Promise<StoredIndicator | null>;
  deleteIndicator(organizationId: string, indicatorId: string): Promise<void>;
}

export interface ThreatIntelIds {
  id(): string;
  now(): string;
  nowMs(): number;
}

export function systemThreatIntelIds(): ThreatIntelIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString(), nowMs: () => Date.now() };
}

/* -------------------------------------------------------------------------- */
/*  Reports                                                                   */
/* -------------------------------------------------------------------------- */

export interface FeedIngestReport {
  accepted: number;
  /** Rows that were already known and had their confidence, labels or expiry refreshed. */
  updated: number;
  rejected: { value: string; reason: string }[];
  /** How many rows this batch contributed, per feed — the number a feed is judged by. */
  byFeed: Record<string, number>;
}

export interface FeedStats {
  total: number;
  active: number;
  expired: number;
  /** Active indicators per feed, so a noisy feed can be found without reading every row. */
  byFeed: Record<string, number>;
  byKind: Record<string, number>;
  /** Whether any expiry date is set at all. A feed with none is a feed nobody pruned. */
  withExpiry: number;
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

export class ThreatIntelService {
  constructor(
    private readonly store: IndicatorStore,
    private readonly audit: AuditTrail | null = null,
    private readonly ids: ThreatIntelIds = systemThreatIntelIds(),
    private readonly hash: HashFn = sha256Hex,
  ) {}

  /**
   * The list the detector matches against.
   *
   * No actor: ingestion is a sensor-side read, the same shape as the session lookup the
   * detector already does, and it exposes nothing about a person — only what somebody has
   * published as an indicator.
   */
  async activeIndicators(organizationId: string, at: number): Promise<readonly Indicator[]> {
    const all = await this.store.listIndicators(organizationId);
    return all.filter((indicator) => isActive(indicator, at));
  }

  async list(actor: IdentityActor): Promise<ServiceResult<StoredIndicator[]>> {
    if (!canReadDirectory(actor.role)) return { ok: false, error: "You do not have access to threat intelligence." };
    const rows = await this.store.listIndicators(actor.organizationId);
    return { ok: true, value: rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value)) };
  }

  /**
   * Take a batch of feed rows.
   *
   * `at` is the decision time for the whole batch, so a feed that stamps its rows does not
   * have half of them expire mid-parse.
   */
  async ingest(
    actor: IdentityActor,
    rows: readonly unknown[],
  ): Promise<ServiceResult<FeedIngestReport>> {
    if (!canManagePolicies(actor.role)) {
      return { ok: false, error: "Managing threat intelligence feeds needs a policy administrator." };
    }
    if (rows.length === 0) return { ok: true, value: { accepted: 0, updated: 0, rejected: [], byFeed: {} } };

    const at = this.ids.nowMs();
    let accepted = 0;
    let updated = 0;
    const rejected: FeedIngestReport["rejected"] = [];
    const byFeed: Record<string, number> = {};

    for (const row of rows) {
      const parsed = parseIndicator((row ?? {}) as Record<string, unknown>, { at });
      if (!parsed.ok) {
        const value = typeof (row as { value?: unknown })?.value === "string" ? String((row as { value: string }).value) : "";
        rejected.push({ value, reason: parsed.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ") });
        continue;
      }
      const record: StoredIndicator = { ...parsed.indicator, organizationId: actor.organizationId };
      const stored = await this.store.upsertIndicator(record);
      if (stored.created) accepted += 1;
      else updated += 1;
      byFeed[record.source] = (byFeed[record.source] ?? 0) + 1;
    }

    await this.append(actor, "guard.intel.ingested", "Indicator", {
      accepted,
      updated,
      rejected: rejected.length,
      feeds: Object.keys(byFeed),
    });

    return { ok: true, value: { accepted, updated, rejected, byFeed } };
  }

  /**
   * Withdraw an indicator.
   *
   * Audited with what was withdrawn, not merely that something was: an auditor asking "was
   * this address ever watched, and when did we stop?" needs the value on the chain.
   */
  async withdraw(actor: IdentityActor, indicatorId: string): Promise<ServiceResult<StoredIndicator>> {
    if (!canManagePolicies(actor.role)) {
      return { ok: false, error: "Managing threat intelligence feeds needs a policy administrator." };
    }
    const found = await this.store.findIndicator(actor.organizationId, indicatorId);
    if (!found) return { ok: false, error: "That indicator is not in this deployment's feeds." };
    await this.store.deleteIndicator(actor.organizationId, indicatorId);
    await this.append(actor, "guard.intel.withdrawn", "Indicator", {
      indicatorId,
      kind: found.kind,
      value: found.value,
      source: found.source,
    }, found.id);
    return { ok: true, value: found };
  }

  /** Counts for the console: what is watched, by whom, and how much of it has no expiry. */
  async stats(actor: IdentityActor): Promise<ServiceResult<FeedStats>> {
    if (!canReadDirectory(actor.role)) return { ok: false, error: "You do not have access to threat intelligence." };
    const at = this.ids.nowMs();
    const rows = await this.store.listIndicators(actor.organizationId);

    const byFeed: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    let active = 0;
    let withExpiry = 0;
    for (const row of rows) {
      if (isActive(row, at)) {
        active += 1;
        byFeed[row.source] = (byFeed[row.source] ?? 0) + 1;
        byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
      }
      if (row.expiresAt !== null) withExpiry += 1;
    }

    return {
      ok: true,
      value: {
        total: rows.length,
        active,
        expired: rows.length - active,
        byFeed,
        byKind,
        withExpiry,
      },
    };
  }

  /* ----------------------------------------------------------- internals */

  private async append(
    actor: IdentityActor,
    action: string,
    targetType: string,
    detail: Record<string, unknown>,
    targetId?: string,
  ): Promise<void> {
    if (!this.audit) return;
    const id = targetId ?? this.ids.id();
    await this.audit.append({
      id: this.ids.id(),
      at: this.ids.now(),
      actor: actor.id,
      action,
      targetType,
      targetId: id,
      // The actor is a person here, unlike the sensor that ingests telemetry: changing
      // what the deployment watches is somebody's decision.
      detail: { ...detail, organizationId: actor.organizationId, by: actor.id },
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  An in-memory store, used by tests and the memory-mode server              */
/* -------------------------------------------------------------------------- */

export class MemoryIndicatorStore implements IndicatorStore {
  private readonly indicators = new Map<string, StoredIndicator>();

  private key(organizationId: string, id: string): string {
    return `${organizationId}|${id}`;
  }

  async upsertIndicator(record: StoredIndicator): Promise<{ indicator: StoredIndicator; created: boolean }> {
    const key = this.key(record.organizationId, record.id);
    const existing = this.indicators.get(key);
    if (existing) {
      // A re-send refreshes what a feed is entitled to change and keeps `firstSeenAt`, so
      // "how long have we been watching this?" survives the hourly poll.
      const merged: StoredIndicator = { ...record, firstSeenAt: existing.firstSeenAt };
      this.indicators.set(key, structuredClone(merged));
      return { indicator: structuredClone(merged), created: false };
    }
    this.indicators.set(key, structuredClone(record));
    return { indicator: structuredClone(record), created: true };
  }

  async listIndicators(organizationId: string): Promise<StoredIndicator[]> {
    return [...this.indicators.values()]
      .filter((entry) => entry.organizationId === organizationId)
      .map((entry) => structuredClone(entry));
  }

  async findIndicator(organizationId: string, indicatorId: string): Promise<StoredIndicator | null> {
    const found = this.indicators.get(this.key(organizationId, indicatorId));
    return found ? structuredClone(found) : null;
  }

  async deleteIndicator(organizationId: string, indicatorId: string): Promise<void> {
    this.indicators.delete(this.key(organizationId, indicatorId));
  }
}
