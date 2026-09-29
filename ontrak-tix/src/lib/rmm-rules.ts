/**
 * RMM / monitoring rules (M6): a monitoring alert is a *condition*, not an event.
 *
 * The M2 security pipeline dedupes alerts by their own fingerprint and folds a
 * repeat into the row it already has. Monitoring systems ask a different question:
 * a check goes down, and later it comes back up. So this module is built around
 * one distinction the rest of the product does not have to make:
 *
 *  1. **The external id belongs to the event; the dedupe key belongs to the
 *     condition.** Vendors differ — some reuse one alert id for a check that fires
 *     again, some mint a fresh one every time — so the id is recorded for
 *     reconciliation and the *condition* is what a ticket is opened against. That
 *     is what makes "open once, close when it clears" true across the vendor's own
 *     bookkeeping.
 *  2. **A clear is only meaningful against something we opened.** A monitoring
 *     system that reports a recovery for a check we have never worked is telling us
 *     about somebody else's ticket, and the honest answer is to record nothing
 *     rather than to open work in order to close it.
 *  3. **A clear-then-fail is a new incident, not a reopened note.** A disk that
 *     filled, was cleared, and filled again is two outages; the second gets its own
 *     ticket so its own response clock, its own SLA and its own post-incident
 *     history are real. `reopenCount` on the link is what says the condition is
 *     recurring, which is the interesting thing about it.
 *  4. **Closing walks the ladder the desk defined.** `NEW` cannot become `CLOSED`
 *     directly — the lifecycle says so in `ticket-rules.ts` — and this module
 *     returns the path rather than a shortcut, so an auto-closed ticket travels the
 *     same edges a person's would and leaves the same audit trail.
 *
 * Pure: no clock, no `fetch`, no Prisma. The payload's aliases are read here and
 * the time is handed in, so the classification is tested without a webhook.
 */

import { SUBJECT_MAX, type TicketPriority, type TicketStatus, type TicketType } from "./ticket-rules";

/* -------------------------------------------------------------------------- */
/*  The vocabulary                                                            */
/* -------------------------------------------------------------------------- */

/** Whether the check is failing or has come back. Two states, deliberately. */
export type RmmAlertState = "OPEN" | "RESOLVED";

/**
 * What the alert is worth.
 *
 * Three rungs rather than the security pipeline's five: a monitoring check is
 * either informational, worth knowing about, or the thing that wakes somebody up.
 * More nuance than that is a conversation a person has, not a mapping we invent.
 */
export type RmmSeverity = "INFO" | "WARNING" | "CRITICAL";

export const RMM_STATES: readonly RmmAlertState[] = ["OPEN", "RESOLVED"];
export const RMM_SEVERITIES: readonly RmmSeverity[] = ["INFO", "WARNING", "CRITICAL"];

export const RMM_SOURCE_MAX = 80;
export const RMM_HOST_MAX = 200;
export const RMM_CHECK_MAX = 200;
export const RMM_EXTERNAL_ID_MAX = 200;
export const RMM_SUMMARY_MAX = 2_000;

/* -------------------------------------------------------------------------- */
/*  The event                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One monitoring alert, normalized.
 *
 * `externalId` is the vendor's own handle on *this firing*; `dedupeKey` is ours on
 * the *condition*. Both are kept, and only the second decides which ticket the
 * alert belongs to.
 */
export interface RmmAlertEvent {
  externalId: string;
  /** Which system said so: `datto`, `ninja`, `uptime-kuma`, `prometheus`, … */
  source: string;
  /** The device, host or service the check was made against. */
  host: string;
  /** The check itself, e.g. `disk /var`, `ping`, `backup completed`. */
  check: string;
  state: RmmAlertState;
  severity: RmmSeverity;
  summary: string;
  occurredAt: string;
  /** Stable identity of the condition: `source:host:check`, case-folded. */
  dedupeKey: string;
}

/**
 * The condition's key.
 *
 * Case-folded and whitespace-collapsed because a vendor's own casing is not a
 * different check, and a trailing space in a host name is a CSV import artifact
 * rather than a second server. It deliberately does **not** include the state: the
 * whole point is that the failure and the recovery are the same condition.
 */
export function rmmDedupeKey(parts: { source: string; host: string; check: string }): string {
  const fold = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  return `${fold(parts.source)}:${fold(parts.host)}:${fold(parts.check)}`;
}

/* -------------------------------------------------------------------------- */
/*  Reading a vendor's payload                                                */
/* -------------------------------------------------------------------------- */

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

function firstOf(...values: unknown[]): string | undefined {
  for (const value of values) {
    const found = text(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

const OPEN_WORDS = ["open", "opened", "new", "alert", "alerting", "firing", "triggered", "trigger", "down", "failed", "failure", "critical", "error", "bad", "1", "true"];
const RESOLVED_WORDS = ["resolved", "resolve", "closed", "close", "clear", "cleared", "ok", "up", "recovered", "recovery", "healthy", "normal", "passing", "success", "0", "false"];

/** Read a state word. Unknown words are `null` so the caller can reject the payload. */
export function rmmState(value: unknown): RmmAlertState | null {
  // A boolean `resolved: true` is the other spelling vendors use.
  if (value === true) return "RESOLVED";
  if (value === false) return "OPEN";
  const word = text(value)?.toLowerCase();
  if (!word) return null;
  if (OPEN_WORDS.includes(word)) return "OPEN";
  if (RESOLVED_WORDS.includes(word)) return "RESOLVED";
  return null;
}

/**
 * Read a severity word.
 *
 * Unknown or absent defaults to `WARNING`: a monitoring check that went down and
 * did not say how bad it is still went down, and a default of `INFO` would file
 * real outages as noise. The mapping is generous upward — `sev1`, `emergency` and
 * `page` all mean somebody is being woken up — because being wrong downward is the
 * mistake that costs an outage.
 */
export function rmmSeverity(value: unknown): RmmSeverity {
  const word = text(value)?.toLowerCase() ?? "";
  if (/(critical|sev ?1|severe|emergency|fatal|panic|page|high|major|urgent)/.test(word)) return "CRITICAL";
  if (/(warn|medium|moderate|minor|degraded|attention)/.test(word)) return "WARNING";
  if (/(info|low|notice|ok|none|debug|verbose)/.test(word)) return "INFO";
  return "WARNING";
}

/**
 * Truncate a value to a column's limit, on a word boundary where there is one.
 *
 * The ellipsis is counted against the limit rather than added on top of it — a
 * helper that returns `max + 1` characters is one that hands a 201-character
 * subject to a 200-character column and turns a monitoring alert into a failed
 * insert.
 */
export function clamp(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  const limit = Math.max(1, max - 1);
  const cut = trimmed.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Turn a vendor's webhook body into a normalized alert, or `null`.
 *
 * `at` is the instant of receipt and is used only when the payload carries no
 * usable time. Unlike the security pipeline — where an unplaceable alert is
 * rejected outright — a monitoring webhook with no timestamp is still an alert
 * about a condition that is either up or down *now*, and refusing it would mean an
 * outage nobody opened a ticket for because a vendor's field was named oddly.
 */
export function parseRmmAlert(body: unknown, at: string): RmmAlertEvent | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;

  const host = firstOf(raw.host, raw.hostname, raw.hostName, raw.device, raw.deviceName, raw.device_name, raw.machine, raw.node, raw.server, raw.target, raw.asset);
  const check = firstOf(raw.check, raw.checkName, raw.check_name, raw.monitor, raw.monitorName, raw.test, raw.metric, raw.service, raw.policy, raw.condition, raw.name, raw.title);
  if (!host || !check) return null;

  // A boolean `resolved` is the other field vendors use, and it has to be read
  // before `state` so an explicit `state: "firing"` beside `resolved: false` is
  // not mistaken for a recovery.
  const state =
    rmmState(raw.resolved) ??
    rmmState(firstOf(raw.state, raw.status, raw.alertState, raw.alert_state, raw.event, raw.condition_state));
  if (!state) return null;

  const source = firstOf(raw.source, raw.vendor, raw.product, raw.system, raw.platform, raw.integration, raw.rmm) ?? "monitoring";
  const occurredAt = firstOf(raw.occurredAt, raw.occurred_at, raw.timestamp, raw.time, raw.eventTime, raw.event_time, raw.ts, raw.date, raw.createdAt, raw.created_at) ?? at;
  const externalId =
    firstOf(raw.externalId, raw.external_id, raw.alertId, raw.alert_id, raw.eventId, raw.event_id, raw.incidentId, raw.incident_id, raw.uuid, raw.id) ??
    rmmDedupeKey({ source, host, check });
  const summary =
    firstOf(raw.summary, raw.message, raw.description, raw.detail, raw.text, raw.note) ??
    `${check} on ${host} is ${state === "OPEN" ? "failing" : "back up"}`;

  return {
    externalId: clamp(externalId, RMM_EXTERNAL_ID_MAX),
    source: clamp(source, RMM_SOURCE_MAX),
    host: clamp(host, RMM_HOST_MAX),
    check: clamp(check, RMM_CHECK_MAX),
    state,
    severity: rmmSeverity(raw.severity ?? raw.priority ?? raw.level),
    summary: clamp(summary, RMM_SUMMARY_MAX),
    occurredAt: normalizeOccurredAt(occurredAt, at),
    dedupeKey: rmmDedupeKey({ source, host, check }),
  };
}

/**
 * A timestamp the database can hold.
 *
 * ISO strings, epoch seconds and epoch milliseconds all arrive in practice, and a
 * vendor's "10:31" with no date is not a time we can place — so a value we cannot
 * read becomes the instant of receipt rather than a rejected alert.
 */
export function normalizeOccurredAt(value: string, at: string): string {
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && value.trim() !== "") {
    // Ten digits is seconds, thirteen is milliseconds; anything smaller is not a
    // time at all and falls through to the parse below.
    const ms = asNumber > 1e11 ? asNumber : asNumber > 1e8 ? asNumber * 1000 : Number.NaN;
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : at;
}

/* -------------------------------------------------------------------------- */
/*  The link                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One monitored condition, and the ticket it is (or was last) open against.
 *
 * `state` is the *condition's* state, which is why a link can be `RESOLVED` and
 * still point at a ticket: the pair is what lets the next failure be recognized as
 * a recurrence instead of a first sighting.
 */
export interface RmmLinkRecord {
  id: string;
  tenantId: string;
  dedupeKey: string;
  source: string;
  host: string;
  check: string;
  state: RmmAlertState;
  /** The worst severity seen while the condition was open. */
  severity: RmmSeverity;
  /** The vendor's id for the firing that opened it. */
  externalId: string;
  ticketId: string;
  ticketRef: string;
  lastSummary: string;
  openedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  occurrences: number;
  /** How many times the condition cleared and failed again. */
  reopenCount: number;
}

/* -------------------------------------------------------------------------- */
/*  The decision                                                              */
/* -------------------------------------------------------------------------- */

export type RmmAction = "OPEN" | "REOPEN" | "REPEAT" | "RESOLVE" | "IGNORE";

export interface RmmDecision {
  action: RmmAction;
  /** Why, in words a person reads in the log rather than a code they decode. */
  reason: string;
}

/**
 * What to do about an alert, given the condition's current link.
 *
 * The five outcomes are exhaustive and each one is a decision somebody would have
 * to make by hand otherwise:
 *
 *   - `OPEN`   — a failure with no ticket: raise one.
 *   - `REPEAT` — a failure we are already working: note it, do not open a second.
 *   - `REOPEN` — a failure after a recovery: the condition is back, and the last
 *                ticket is closed, so this is a new incident.
 *   - `RESOLVE`— a recovery with a ticket still open: close it.
 *   - `IGNORE` — a recovery for something we never worked, or a second recovery.
 */
export function decideRmmAction(event: RmmAlertEvent, link: RmmLinkRecord | null): RmmDecision {
  if (!link) {
    return event.state === "OPEN"
      ? { action: "OPEN", reason: "no ticket has been raised for this condition" }
      : { action: "IGNORE", reason: "a recovery for a condition this desk never opened" };
  }

  if (event.state === "OPEN") {
    return link.state === "OPEN"
      ? { action: "REPEAT", reason: `the condition is already being worked on ${link.ticketRef}` }
      : { action: "REOPEN", reason: `the condition failed again after clearing (recurrence ${link.reopenCount + 1})` };
  }

  return link.state === "RESOLVED"
    ? { action: "IGNORE", reason: "this condition already cleared" }
    : { action: "RESOLVE", reason: `the condition cleared, so ${link.ticketRef} is done` };
}

/**
 * Whether a state word means "the condition is failing". Used by the service to
 * decide if a ticket it is about to act on is still open.
 */
export function conditionIsOpen(state: RmmAlertState): boolean {
  return state === "OPEN";
}

/* -------------------------------------------------------------------------- */
/*  The ticket                                                                */
/* -------------------------------------------------------------------------- */

export interface RmmTicketDraft {
  subject: string;
  description: string;
  type: TicketType;
  priority: TicketPriority;
}

/** How a severity becomes a priority. A monitoring alert is work, never a request. */
export function rmmPriority(severity: RmmSeverity): TicketPriority {
  switch (severity) {
    case "CRITICAL":
      return "URGENT";
    case "WARNING":
      return "HIGH";
    case "INFO":
      return "NORMAL";
  }
}

/** The worst of two severities, so a repeat that escalates is reflected. */
export function worstSeverity(a: RmmSeverity, b: RmmSeverity): RmmSeverity {
  const rank: Record<RmmSeverity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * The ticket a failure becomes.
 *
 * The subject names the check and the host in that order, because the desk's
 * inbox sorts by subject and "disk /var is full on db-01" is scannable in a way
 * that a vendor's alert id is not. The description keeps the vendor's own words
 * verbatim — paraphrasing a monitoring message is how a root cause gets lost — and
 * states the condition key, which is what reconciles the ticket with the check.
 */
export function rmmTicketDraft(event: RmmAlertEvent): RmmTicketDraft {
  const subject = clamp(`[${event.source}] ${event.host}: ${event.check} is failing`, SUBJECT_MAX);
  const description = [
    `Monitoring reported that **${event.check}** on **${event.host}** is failing.`,
    "",
    `- Source: ${event.source}`,
    `- Severity: ${event.severity}`,
    `- Reported at: ${event.occurredAt}`,
    `- Vendor alert id: ${event.externalId}`,
    `- Condition: ${event.dedupeKey}`,
    "",
    "The monitoring system's own message:",
    "",
    `> ${event.summary.replace(/\n/g, "\n> ")}`,
    "",
    "_This ticket was opened from a monitoring alert and is closed automatically when the check reports that it has recovered._",
  ].join("\n");

  return { subject, description, type: "INCIDENT", priority: rmmPriority(event.severity) };
}

/** One line for the thread when a condition is seen again while it is still open. */
export function repeatNote(event: RmmAlertEvent, link: RmmLinkRecord): string {
  return [
    `Monitoring saw **${event.check}** on **${event.host}** fail again (${event.severity}, seen ${link.occurrences + 1} times).`,
    "",
    `> ${event.summary.replace(/\n/g, "\n> ")}`,
  ].join("\n");
}

/** The note the desk reads when the check recovers and the ticket closes itself. */
export function resolutionNote(event: RmmAlertEvent, link: RmmLinkRecord): string {
  const duration = Math.max(0, Date.parse(event.occurredAt) - Date.parse(link.openedAt));
  return [
    `**${event.check}** on **${event.host}** reported that it has recovered; ${link.ticketRef} was closed automatically.`,
    "",
    `- Down for: ${humanDuration(duration)}`,
    `- Vendor alert id: ${event.externalId}`,
    "",
    `> ${event.summary.replace(/\n/g, "\n> ")}`,
  ].join("\n");
}

/** A duration as "4h 12m", which is what somebody reading an incident wants. */
export function humanDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return remainder === 0 ? `${days}d` : `${days}d ${remainder}h`;
}

/**
 * The statuses an auto-resolve walks to close a ticket.
 *
 * Returned as a path rather than a target, because the ticket lifecycle forbids
 * `NEW → CLOSED` outright — and rightly: a ticket that was never opened was never
 * worked. Walking the edge the desk defined means an auto-closed ticket leaves the
 * same trail a person's would, and the chain says the monitoring system walked it.
 */
export function closePath(from: TicketStatus): TicketStatus[] {
  if (from === "CLOSED") return [];
  if (from === "NEW") return ["OPEN", "CLOSED"];
  return ["CLOSED"];
}

/**
 * Whether an auto-resolve still has a status to walk.
 *
 * Everything except `CLOSED` does — including `RESOLVED`, where the check coming
 * back up is exactly the confirmation the desk was waiting for. A ticket a person
 * already closed is left alone: the condition clearing afterwards is still recorded
 * on the link, because "when did the check come back?" is a different question from
 * "when did we finish?".
 */
export function needsClosing(ticket: { status: TicketStatus }): boolean {
  return ticket.status !== "CLOSED";
}

/* -------------------------------------------------------------------------- */
/*  The HTTP answer                                                           */
/* -------------------------------------------------------------------------- */

/** The shared secret a monitoring system signs its webhook with. */
export const RMM_SECRET_ENV = "ONTRAK_TIX_RMM_SECRET";

export interface RmmReply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Map an intake outcome onto a status code, as policy rather than as a route's
 * convenience:
 *
 *  - `202` when the desk took the alert and did something with it;
 *  - `200` for an answer that is already true and would be true again — a repeat,
 *    a recovery we never opened against, a second recovery. Monitoring systems
 *    retry aggressively, and answering `500` to those is how a webhook queue fills
 *    with work the desk correctly did nothing about;
 *  - `400` when the payload was never an alert (the sender should not retry);
 *  - `503` when the desk cannot respond at all (no requester to raise work for), so
 *    the sender *does* retry once somebody fixes the configuration.
 */
export function rmmReply(outcome: RmmIntakeOutcome): RmmReply {
  switch (outcome.kind) {
    case "opened":
      return { status: 202, body: { status: "opened", ticketRef: outcome.link.ticketRef, ticketId: outcome.link.ticketId } };
    case "reopened":
      return { status: 202, body: { status: "reopened", ticketRef: outcome.link.ticketRef, ticketId: outcome.link.ticketId, recurrence: outcome.link.reopenCount } };
    case "resolved":
      return { status: 202, body: { status: "resolved", ticketRef: outcome.link.ticketRef, ticketId: outcome.link.ticketId } };
    case "repeat":
      return { status: 200, body: { status: "repeat", ticketRef: outcome.link.ticketRef, occurrences: outcome.link.occurrences } };
    case "ignored":
      return { status: 200, body: { status: "ignored", reason: outcome.reason } };
    case "rejected":
      return { status: 400, body: { error: outcome.reason } };
    case "disabled":
      return { status: 503, body: { error: outcome.reason } };
    case "failed":
      return { status: 500, body: { error: outcome.error } };
  }
}

/**
 * What an intake produced. Declared here rather than in the service so the HTTP
 * mapping above is testable without constructing a connector.
 */
export type RmmIntakeOutcome =
  | { kind: "opened"; link: RmmLinkRecord; ticketId: string }
  | { kind: "reopened"; link: RmmLinkRecord; ticketId: string }
  | { kind: "resolved"; link: RmmLinkRecord; ticketId: string }
  | { kind: "repeat"; link: RmmLinkRecord; occurrences: number }
  | { kind: "ignored"; reason: string }
  | { kind: "rejected"; reason: string }
  | { kind: "disabled"; reason: string }
  | { kind: "failed"; error: string };
