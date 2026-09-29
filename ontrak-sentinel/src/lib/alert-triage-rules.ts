/**
 * Alert triage rules (S3): what somebody working the Guard queue needs in order to decide.
 *
 * `detection-service.ts` answers *is this an incident* and *who is it about*; this module
 * answers the three questions an operator asks next, and answers them purely so they can be
 * tested without a database, a browser or a session:
 *
 *  - **What is still waiting on me?** The queue is filtered and ordered here rather than by
 *    the store, because "worth looking at first" is a judgement about severity and recency
 *    that a rule owns — and because a store query that sorted differently from the summary
 *    beside it would put a page's own header in doubt.
 *  - **What is this alert actually part of?** An alert is never alone: the same address,
 *    asset, device or identity raised the ones around it. `relatedAlerts` names the
 *    neighbours *and why they are neighbours*, which is the difference between an
 *    investigation and a filtered list.
 *  - **Why is it this loud?** The severity an alert carries is not always the severity its
 *    rule fires at — a feed can raise it — so `escalationSummary` says which indicator did
 *    it, in the operator's own words, from the record rather than from the feed that may
 *    since have been withdrawn.
 *
 * Two deliberate omissions. A closed alert is not a neighbour and never appears in
 * `relatedAlerts`: the investigation is about what is open, and a resolved printer ticket
 * next to a live intrusion is noise, not context. And nothing here mutates — acknowledging
 * and closing belong to `DetectionService`, which is where the audit entry is written, and a
 * second place that could change a state would be a second place that could change it
 * *without* one.
 */

import { ALERT_STATES, type AlertRecord, type AlertState } from "./detection-service";
import type { Severity } from "./detection-rules";

/* -------------------------------------------------------------------------- */
/*  Severity and state ordering                                               */
/* -------------------------------------------------------------------------- */

/** Quietest first, so a rank is an index. */
export const ALERT_SEVERITIES: readonly Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

/** 0 for LOW through 3 for CRITICAL. An unknown string ranks as the quietest. */
export function severityRank(severity: Severity): number {
  const rank = ALERT_SEVERITIES.indexOf(severity);
  return rank === -1 ? 0 : rank;
}

export function isAtLeast(severity: Severity, floor: Severity): boolean {
  return severityRank(severity) >= severityRank(floor);
}

/** The states an operator still has work in. `CLOSED` is deliberately not one of them. */
export const OPEN_ALERT_STATES: readonly AlertState[] = ["NEW", "ACKNOWLEDGED"];

export function isOpen(state: AlertState): boolean {
  return state !== "CLOSED";
}

/* -------------------------------------------------------------------------- */
/*  The queue                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the queue is narrowed to.
 *
 * Every field has an "off" value rather than being optional, so the page can round-trip its
 * own filters through the query string and back without a field that was present becoming
 * absent. `state: "OPEN"` is the default because the two states an operator works are the
 * two states one filter should mean.
 */
export interface TriageFilter {
  state: "ALL" | "OPEN" | AlertState;
  severity: "ALL" | Severity;
  /** Narrow to one identity, set by following the "about" link from an alert. */
  identityId: string | null;
  /** Narrow to one address, set the same way. */
  address: string | null;
  /** Free text across the fields a person would search by. */
  search: string;
}

export function noFilter(): TriageFilter {
  return { state: "OPEN", severity: "ALL", identityId: null, address: null, search: "" };
}

/** Every value the state filter will accept, so a query string cannot invent one. */
const FILTER_STATES: readonly TriageFilter["state"][] = ["ALL", "OPEN", ...ALERT_STATES];

/**
 * The filter a request asked for, read from its query string.
 *
 * Anything unrecognised is *the default* rather than an error, because this is a read:
 * a bookmarked `?state=OPEN` that outlives a deployment which renames a state should
 * show the queue rather than a page about a bad parameter. The one thing it will not do
 * is pass an arbitrary string through to the store — every value is checked against the
 * list it came from.
 */
export function filterFrom(params: { get(name: string): string | null }): TriageFilter {
  const filter = noFilter();

  const state = (params.get("state") ?? "").trim().toUpperCase();
  if (FILTER_STATES.includes(state as TriageFilter["state"])) filter.state = state as TriageFilter["state"];

  const severity = (params.get("severity") ?? "").trim().toUpperCase();
  if (ALERT_SEVERITIES.includes(severity as Severity)) filter.severity = severity as Severity;

  const identityId = (params.get("identityId") ?? "").trim();
  if (identityId) filter.identityId = identityId;

  const address = (params.get("address") ?? "").trim();
  if (address) filter.address = address;

  filter.search = params.get("search") ?? "";
  return filter;
}

/**
 * The filter as a query string, so a link into the queue carries its narrowing and the
 * page's filter form can be a plain `GET` rather than a state change.
 */
export function filterQuery(filter: TriageFilter): string {
  const params = new URLSearchParams();
  params.set("state", filter.state);
  params.set("severity", filter.severity);
  if (filter.identityId) params.set("identityId", filter.identityId);
  if (filter.address) params.set("address", filter.address);
  if (filter.search.trim()) params.set("search", filter.search);
  return params.toString();
}

/** Everything a free-text search looks at, lower-cased once. */
function haystack(alert: AlertRecord): string {
  return [
    alert.ruleName,
    alert.ruleId,
    alert.identityLabel ?? "",
    alert.sourceAddress ?? "",
    alert.asset ?? "",
    alert.device ?? "",
    alert.note ?? "",
    ...alert.threatIntel.map((match) => `${match.indicator.value} ${match.indicator.source}`),
  ]
    .join(" ")
    .toLowerCase();
}

export function matchesFilter(alert: AlertRecord, filter: TriageFilter): boolean {
  if (filter.state === "OPEN") {
    if (!isOpen(alert.state)) return false;
  } else if (filter.state !== "ALL" && alert.state !== filter.state) {
    return false;
  }

  if (filter.severity !== "ALL" && alert.severity !== filter.severity) return false;
  if (filter.identityId && alert.identityId !== filter.identityId) return false;
  if (filter.address && alert.sourceAddress !== filter.address) return false;

  const needle = filter.search.trim().toLowerCase();
  if (needle && !haystack(alert).includes(needle)) return false;

  return true;
}

/**
 * The order the queue is read in: loudest first, then most recent, then by rule so two
 * alerts that share an instant still come back in a stable order. A list that reshuffled
 * between two page loads would make an operator re-read rows they had already dismissed.
 */
export function sortForQueue(alerts: readonly AlertRecord[]): AlertRecord[] {
  return [...alerts].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      b.lastSeenAt.localeCompare(a.lastSeenAt) ||
      a.ruleName.localeCompare(b.ruleName) ||
      a.id.localeCompare(b.id),
  );
}

export function filterAlerts(alerts: readonly AlertRecord[], filter: TriageFilter): AlertRecord[] {
  return sortForQueue(alerts.filter((alert) => matchesFilter(alert, filter)));
}

/* -------------------------------------------------------------------------- */
/*  The summary above the queue                                               */
/* -------------------------------------------------------------------------- */

export interface TriageSummary {
  total: number;
  open: number;
  new: number;
  acknowledged: number;
  closed: number;
  bySeverity: Record<Severity, number>;
  /** Raised by a feed rather than by the rule that fired. */
  escalated: number;
  /** Open, and loudest — the number that should be zero at the end of a shift. */
  openHighOrCritical: number;
  /** ISO instants, or `null` when there is nothing in that bucket. */
  oldestOpenAt: string | null;
  lastSeenAt: string | null;
}

export function triageSummary(alerts: readonly AlertRecord[]): TriageSummary {
  const bySeverity: Record<Severity, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  let open = 0;
  let stated = 0;
  let acknowledged = 0;
  let closed = 0;
  let escalated = 0;
  let openHighOrCritical = 0;
  let oldestOpenAt: string | null = null;
  let lastSeenAt: string | null = null;

  for (const alert of alerts) {
    bySeverity[alert.severity] += 1;
    if (alert.threatIntel.length > 0) escalated += 1;
    if (alert.state === "NEW") stated += 1;
    if (alert.state === "ACKNOWLEDGED") acknowledged += 1;
    if (alert.state === "CLOSED") closed += 1;

    if (isOpen(alert.state)) {
      open += 1;
      if (isAtLeast(alert.severity, "HIGH")) openHighOrCritical += 1;
      // Oldest by when it was *last* seen, because that is the clock a repeat refreshes:
      // an incident still arriving is not stale, whatever its first packet's age.
      if (oldestOpenAt === null || alert.lastSeenAt < oldestOpenAt) oldestOpenAt = alert.lastSeenAt;
    }
    if (lastSeenAt === null || alert.lastSeenAt > lastSeenAt) lastSeenAt = alert.lastSeenAt;
  }

  return {
    total: alerts.length,
    open,
    new: stated,
    acknowledged,
    closed,
    bySeverity,
    escalated,
    openHighOrCritical,
    oldestOpenAt,
    lastSeenAt,
  };
}

/**
 * How long an open alert has gone untouched, in whole minutes, or `null` when it is closed
 * or the clock is behind it.
 *
 * From `lastSeenAt` rather than `createdAt` for the same reason the summary uses it: a
 * repeated burst is not an ignored alert, and a queue that aged it as though it were would
 * send an operator to yesterday's incident instead of today's.
 */
export function waitingMinutes(alert: AlertRecord, at: number): number | null {
  if (!isOpen(alert.state)) return null;
  const seen = Date.parse(alert.lastSeenAt);
  if (!Number.isFinite(seen) || seen > at) return null;
  return Math.floor((at - seen) / 60_000);
}

/* -------------------------------------------------------------------------- */
/*  Investigation: what else is this?                                         */
/* -------------------------------------------------------------------------- */

/** Why two alerts are neighbours. */
export type RelationKind = "identity" | "address" | "asset" | "device" | "group";

export interface RelatedAlert {
  id: string;
  ruleName: string;
  severity: Severity;
  state: AlertState;
  lastSeenAt: string;
  kind: RelationKind;
  /** The shared value, so the page can say *which* address rather than "an address". */
  shared: string;
  /** True when this neighbour is the one an operator would want to look at first. */
  closer: boolean;
}

/**
 * The neighbours of one alert, loudest first.
 *
 * Ordered by how tightly the relation binds — the same identity, then the same address,
 * then the same asset, then the same device, then merely the same dedupe group — because
 * "same person" is the product's whole premise and "same group key" is the weakest thing
 * that can still be worth a look. An alert that relates on several axes is reported once,
 * on its tightest one, so the list does not pad itself.
 */
export function relatedAlerts(alerts: readonly AlertRecord[], subject: AlertRecord, limit = 12): RelatedAlert[] {
  const out: RelatedAlert[] = [];
  for (const other of alerts) {
    if (other.id === subject.id) continue;
    if (!isOpen(other.state)) continue;

    let kind: RelationKind | null = null;
    let shared = "";
    if (subject.identityId && other.identityId === subject.identityId) {
      kind = "identity";
      shared = subject.identityLabel ?? subject.identityId;
    } else if (subject.sourceAddress && other.sourceAddress === subject.sourceAddress) {
      kind = "address";
      shared = subject.sourceAddress;
    } else if (subject.asset && other.asset === subject.asset) {
      kind = "asset";
      shared = subject.asset;
    } else if (subject.device && other.device === subject.device) {
      kind = "device";
      shared = subject.device;
    } else if (subject.groupKey && other.groupKey === subject.groupKey) {
      kind = "group";
      shared = subject.groupKey;
    }
    if (!kind) continue;

    out.push({
      id: other.id,
      ruleName: other.ruleName,
      severity: other.severity,
      state: other.state,
      lastSeenAt: other.lastSeenAt,
      kind,
      shared,
      closer: isAtLeast(other.severity, subject.severity) && other.severity !== "LOW",
    });
  }

  const order: Record<RelationKind, number> = { identity: 0, address: 1, asset: 2, device: 3, group: 4 };
  return out
    .sort(
      (a, b) =>
        order[a.kind] - order[b.kind] ||
        severityRank(b.severity) - severityRank(a.severity) ||
        b.lastSeenAt.localeCompare(a.lastSeenAt),
    )
    .slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/*  Why is it this loud?                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The escalation, in one sentence, or `null` when the rule's own severity stands.
 *
 * Read entirely from the alert's record. That is the point: the feed that raised this may
 * have been withdrawn a month ago, and an operator asking "why CRITICAL?" in review has to
 * get the answer the alert was judged on rather than a live lookup that now returns
 * nothing.
 */
export function escalationSummary(alert: AlertRecord): string | null {
  const escalators = alert.threatIntel.filter((match) => match.escalates);
  if (escalators.length === 0) return null;

  const named = escalators
    .slice(0, 3)
    .map(
      (match) =>
        `${match.indicator.value} (${match.indicator.kind.toLowerCase()} from ${match.indicator.source}, confidence ${match.indicator.confidence})`,
    )
    .join(", ");
  const rest = escalators.length > 3 ? `, and ${escalators.length - 3} more` : "";
  return `${alert.severity} because ${named}${rest} matched this evidence.`;
}

/** The indicators that only annotated, i.e. matched below the confidence floor. */
export function annotationSummary(alert: AlertRecord): string | null {
  const annotations = alert.threatIntel.filter((match) => !match.escalates);
  if (annotations.length === 0) return null;
  return `${annotations.length} indicator(s) matched below the confidence floor and annotate without raising the severity: ${annotations
    .slice(0, 3)
    .map((match) => match.indicator.value)
    .join(", ")}.`;
}

/* -------------------------------------------------------------------------- */
/*  The investigation timeline                                                */
/* -------------------------------------------------------------------------- */

export interface AlertTimelineEntry {
  at: string;
  kind: "evidence" | "indicator" | "note" | "observed";
  /** One line: what happened. */
  title: string;
  /** One line: which observation, which attribute, which feed. */
  detail: string;
}

/** `203.0.113.7:443 → 10.0.0.4:8080 tcp outbound`, or the parts that are known. */
function describeEvent(event: AlertRecord["evidence"][number]): string {
  const from = event.sourceAddress
    ? `${event.sourceAddress}${event.sourcePort === null ? "" : `:${event.sourcePort}`}`
    : "an unnamed source";
  const to = event.destinationAddress
    ? `${event.destinationAddress}${event.destinationPort === null ? "" : `:${event.destinationPort}`}`
    : "an unnamed destination";
  const extra = [event.protocol, event.direction].filter((part): part is string => Boolean(part)).join(" ");
  return extra ? `${from} → ${to} ${extra}` : `${from} → ${to}`;
}

/**
 * The alert's own history, oldest first, as one list.
 *
 * Evidence and indicator matches share a timeline on purpose. An operator reconstructing an
 * incident reads "this connection, then this connection, and both are on the same feed" as
 * one story; two tables side by side make them line up the timestamps by hand.
 */
export function alertTimeline(alert: AlertRecord): AlertTimelineEntry[] {
  const entries: AlertTimelineEntry[] = [];

  entries.push({
    at: alert.firstSeenAt,
    kind: "observed",
    title: `First seen by ${alert.ruleName}`,
    detail: `${alert.ruleId} v${alert.ruleVersion}${alert.sourceAddress ? ` · from ${alert.sourceAddress}` : ""}`,
  });

  const evidence = [...alert.evidence].sort((a, b) => a.at - b.at);
  for (const event of evidence) {
    const attributes = Object.keys(event.attributes);
    entries.push({
      at: new Date(event.at).toISOString(),
      kind: "evidence",
      title: `${event.kind} observed by ${event.sensor}`,
      detail:
        describeEvent(event) +
        (attributes.length ? ` · ${attributes.length} attribute(s): ${attributes.slice(0, 4).join(", ")}` : ""),
    });
  }

  if (alert.lastSeenAt !== alert.firstSeenAt) {
    entries.push({
      at: alert.lastSeenAt,
      kind: "observed",
      title: `Last seen · ${alert.occurrences} occurrence(s)`,
      detail: "A repeat refreshes this alert rather than raising a second one.",
    });
  }

  for (const match of alert.threatIntel) {
    entries.push({
      at: alert.lastSeenAt,
      kind: "indicator",
      title: `${match.escalates ? "Escalated" : "Annotated"} by ${match.indicator.value}`,
      detail:
        `${match.indicator.kind.toLowerCase()} from ${match.indicator.source} · confidence ${match.indicator.confidence}` +
        ` · matched ${match.field}${match.attribute ? ` (${match.attribute})` : ""} as ${match.observable}`,
    });
  }

  if (alert.note) {
    entries.push({
      at: alert.updatedAt,
      kind: "note",
      title: `Note on ${alert.state.toLowerCase()}`,
      detail: alert.note,
    });
  }

  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

/* -------------------------------------------------------------------------- */
/*  Handing the state change to the service                                   */
/* -------------------------------------------------------------------------- */

/**
 * Whether an alert can still be worked.
 *
 * `ObservationService` (the Guard service) will refuse a transition it should not make; this
 * exists so the *page* does not offer buttons that will fail. A closed alert shows its note
 * and no actions — offering "acknowledge" on something already closed is how a queue grows
 * a state nobody meant.
 */
export function triageActions(alert: AlertRecord): { canAcknowledge: boolean; canClose: boolean } {
  return {
    canAcknowledge: alert.state === "NEW",
    canClose: isOpen(alert.state),
  };
}
