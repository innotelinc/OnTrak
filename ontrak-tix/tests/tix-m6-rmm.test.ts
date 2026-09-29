/**
 * OnTrak Tix M6 tests: the RMM / monitoring connector.
 *
 * The milestone's exit criterion is one sentence — *a monitoring alert opens a
 * ticket and closes it when the alert clears* — and every way that sentence can be
 * quietly false is a test here:
 *
 *  1. a repeat that opens a second ticket, so one outage becomes sixty;
 *  2. a clear that closes the wrong ticket, because it matched on the vendor's
 *     alert id instead of on the condition;
 *  3. a clear for a check the desk never worked, which opens work in order to
 *     finish it;
 *  4. a condition that clears and fails again, filed as the same outage;
 *  5. a close that jumps `NEW → CLOSED`, which the ticket lifecycle forbids and
 *     which would leave an auto-closed ticket with a trail no person's has.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m6-rmm.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AuditLog } from "../src/lib/audit-chain";
import type { Actor } from "../src/lib/access-rules";
import { sha256Hex } from "../src/lib/ticket-store-prisma";
import { MemoryTicketStore, TicketService } from "../src/lib/ticket-service";
import {
  clamp,
  closePath,
  decideRmmAction,
  humanDuration,
  needsClosing,
  normalizeOccurredAt,
  parseRmmAlert,
  repeatNote,
  resolutionNote,
  rmmDedupeKey,
  rmmPriority,
  rmmReply,
  rmmSeverity,
  rmmState,
  rmmTicketDraft,
  worstSeverity,
  type RmmAlertEvent,
  type RmmLinkRecord,
} from "../src/lib/rmm-rules";
import { MemoryRmmStore, RmmConnectorService, SYSTEM_RMM_ACTOR, type RmmIds } from "../src/lib/rmm-service";

const AT = "2026-09-30T10:00:00.000Z";
const sha256 = sha256Hex;

const payload = (overrides: Record<string, unknown> = {}) => ({
  source: "uptime-kuma",
  host: "db-01",
  check: "disk /var",
  state: "OPEN",
  severity: "critical",
  summary: "/var is 98% full",
  occurredAt: AT,
  externalId: "alert-1",
  ...overrides,
});

/* -------------------------------------------------------------------------- */
/*  Reading a vendor's payload                                                */
/* -------------------------------------------------------------------------- */

test("a payload is normalized into a condition, aliases and all", () => {
  const event = parseRmmAlert(
    {
      vendor: "NinjaOne",
      device: "web-01",
      monitor: "Backup completed",
      status: "down",
      priority: "high",
      message: "Last backup 26 hours ago",
      timestamp: 1_790_000_000,
      alertId: "N-99",
    },
    AT,
  );
  assert.ok(event);
  assert.equal(event.source, "NinjaOne");
  assert.equal(event.host, "web-01");
  assert.equal(event.check, "Backup completed");
  assert.equal(event.state, "OPEN");
  assert.equal(event.severity, "CRITICAL");
  assert.equal(event.externalId, "N-99");
  assert.equal(event.occurredAt, new Date(1_790_000_000 * 1000).toISOString());
  assert.equal(event.dedupeKey, "ninjaone:web-01:backup completed");
});

test("a boolean `resolved` is read before the state word", () => {
  // Vendors that send both to disagree: the explicit boolean wins, because it is
  // the field the vendor documents as the answer.
  const resolved = parseRmmAlert(payload({ state: "firing", resolved: true }), AT);
  assert.ok(resolved);
  assert.equal(resolved.state, "RESOLVED");

  const open = parseRmmAlert(payload({ state: "recovered", resolved: false }), AT);
  assert.ok(open);
  assert.equal(open.state, "OPEN");
});

test("a payload that is not an alert is rejected rather than guessed at", () => {
  assert.equal(parseRmmAlert(null, AT), null);
  assert.equal(parseRmmAlert("lockdown", AT), null);
  // No check name: an alert about "something" is not work.
  assert.equal(parseRmmAlert({ host: "db-01", state: "OPEN" }, AT), null);
  // No host: a check that fired nowhere cannot be opened against anything.
  assert.equal(parseRmmAlert({ check: "disk", state: "OPEN" }, AT), null);
  // A state we cannot read: filing it as a failure would open a ticket for a
  // recovery, and the other way round would close work that is still failing.
  assert.equal(parseRmmAlert({ host: "db-01", check: "disk", state: "sideways" }, AT), null);
});

test("an unknown severity is a warning, never informational", () => {
  assert.equal(rmmSeverity("sev1"), "CRITICAL");
  assert.equal(rmmSeverity(2), "WARNING");
  assert.equal(rmmSeverity("notice"), "INFO");
  // The default is deliberate: a check that went down and did not say how bad it
  // is still went down, and `INFO` files real outages as noise.
  assert.equal(rmmSeverity(undefined), "WARNING");
  assert.equal(rmmSeverity("banana"), "WARNING");
});

test("state words cover the spellings vendors actually send", () => {
  for (const word of ["open", "Opened", "firing", "DOWN", "triggered", "true"]) {
    assert.equal(rmmState(word), "OPEN", word);
  }
  for (const word of ["resolved", "cleared", "UP", "ok", "recovery", "false"]) {
    assert.equal(rmmState(word), "RESOLVED", word);
  }
  assert.equal(rmmState("sideways"), null);
});

test("the condition key folds case and whitespace, and ignores the state", () => {
  const a = rmmDedupeKey({ source: "NinjaOne", host: " db-01 ", check: "Disk  /var" });
  const b = rmmDedupeKey({ source: "ninjaone", host: "db-01", check: "disk /var" });
  assert.equal(a, b);
  // The failure and the recovery are the same condition — that is the whole point.
  assert.equal(rmmDedupeKey({ source: "x", host: "h", check: "c" }), rmmDedupeKey({ source: "x", host: "h", check: "c" }));
});

test("a timestamp we cannot place becomes the instant of receipt", () => {
  assert.equal(normalizeOccurredAt("2026-09-30T10:00:00.000Z", AT), AT);
  assert.equal(normalizeOccurredAt(String(Date.parse(AT)), AT), AT);
  assert.equal(normalizeOccurredAt("10:31", AT), AT);
  assert.equal(normalizeOccurredAt("not a time", AT), AT);
});

test("clamp shortens on a word boundary and says it did", () => {
  assert.equal(clamp("short", 20), "short");
  const long = clamp("the quick brown fox jumps over the lazy dog", 20);
  assert.ok(long.length <= 20, `${long} (${long.length})`);
  assert.ok(long.endsWith("…"));
});

/* -------------------------------------------------------------------------- */
/*  The decision                                                              */
/* -------------------------------------------------------------------------- */

function link(overrides: Partial<RmmLinkRecord> = {}): RmmLinkRecord {
  return {
    id: "link-1",
    tenantId: "tenant-a",
    dedupeKey: "uptime-kuma:db-01:disk /var",
    source: "uptime-kuma",
    host: "db-01",
    check: "disk /var",
    state: "OPEN",
    severity: "CRITICAL",
    externalId: "alert-1",
    ticketId: "ticket-1",
    ticketRef: "TIX-1",
    lastSummary: "/var is 98% full",
    openedAt: AT,
    lastSeenAt: AT,
    resolvedAt: null,
    occurrences: 1,
    reopenCount: 0,
    ...overrides,
  };
}

const event = (state: "OPEN" | "RESOLVED"): RmmAlertEvent => {
  const parsed = parseRmmAlert(payload({ state }), AT);
  assert.ok(parsed);
  return parsed;
};

test("the five outcomes are exhaustive and each one is a decision", () => {
  assert.equal(decideRmmAction(event("OPEN"), null).action, "OPEN");
  assert.equal(decideRmmAction(event("RESOLVED"), null).action, "IGNORE");
  assert.equal(decideRmmAction(event("OPEN"), link()).action, "REPEAT");
  assert.equal(decideRmmAction(event("OPEN"), link({ state: "RESOLVED", resolvedAt: AT })).action, "REOPEN");
  assert.equal(decideRmmAction(event("RESOLVED"), link()).action, "RESOLVE");
  assert.equal(decideRmmAction(event("RESOLVED"), link({ state: "RESOLVED" })).action, "IGNORE");
});

test("a recovery for something we never opened is ignored, with the reason said", () => {
  const decision = decideRmmAction(event("RESOLVED"), null);
  assert.equal(decision.action, "IGNORE");
  assert.match(decision.reason, /never opened/);
});

test("closing walks the lifecycle's own edges, never a shortcut", () => {
  assert.deepEqual(closePath("NEW"), ["OPEN", "CLOSED"]);
  assert.deepEqual(closePath("OPEN"), ["CLOSED"]);
  assert.deepEqual(closePath("PENDING"), ["CLOSED"]);
  assert.deepEqual(closePath("RESOLVED"), ["CLOSED"]);
  assert.deepEqual(closePath("CLOSED"), []);

  // A resolved ticket is still closed by the clear: the check coming back up is
  // the confirmation the desk was waiting for.
  assert.equal(needsClosing({ status: "RESOLVED" }), true);
  assert.equal(needsClosing({ status: "CLOSED" }), false);
});

/* -------------------------------------------------------------------------- */
/*  The ticket                                                                */
/* -------------------------------------------------------------------------- */

test("the ticket names the check and the host, and keeps the vendor's words", () => {
  const draft = rmmTicketDraft(event("OPEN"));
  assert.equal(draft.subject, "[uptime-kuma] db-01: disk /var is failing");
  assert.equal(draft.type, "INCIDENT");
  assert.equal(draft.priority, "URGENT");
  // The vendor's message and the reconciliation key are both on the ticket: one is
  // the root cause, the other is what ties it back to the check.
  assert.match(draft.description, /\/var is 98% full/);
  assert.match(draft.description, /uptime-kuma:db-01:disk \/var/);
  assert.match(draft.description, /alert-1/);
  assert.match(draft.description, /closed automatically/);

  // A vendor's alert id is not a subject; the source, host and check are.
  const long = rmmTicketDraft({ ...event("OPEN"), source: "s".repeat(300), host: "h".repeat(300), check: "c".repeat(300) });
  assert.ok(long.subject.length <= 200, String(long.subject.length));
});

test("severity becomes priority without inventing nuance", () => {
  assert.equal(rmmPriority("CRITICAL"), "URGENT");
  assert.equal(rmmPriority("WARNING"), "HIGH");
  assert.equal(rmmPriority("INFO"), "NORMAL");
  assert.equal(worstSeverity("INFO", "WARNING"), "WARNING");
  assert.equal(worstSeverity("CRITICAL", "WARNING"), "CRITICAL");
});

test("the notes say what happened, in the desk's own reading", () => {
  const repeat = repeatNote(event("OPEN"), link({ occurrences: 3 }));
  assert.match(repeat, /fail again/);
  assert.match(repeat, /seen 4 times/);
  assert.match(repeat, /98% full/);

  const cleared = resolutionNote(event("RESOLVED"), link({ openedAt: "2026-09-30T06:00:00.000Z" }));
  assert.match(cleared, /has recovered/);
  assert.match(cleared, /TIX-1 was closed automatically/);
  assert.match(cleared, /Down for: 4h/);
});

test("a duration reads the way somebody describing an outage would say it", () => {
  assert.equal(humanDuration(30_000), "under a minute");
  assert.equal(humanDuration(20 * 60_000), "20m");
  assert.equal(humanDuration(4 * 3_600_000 + 12 * 60_000), "4h 12m");
  assert.equal(humanDuration(72 * 3_600_000), "3d");
  assert.equal(humanDuration(50 * 3_600_000), "2d 2h");
});

/* -------------------------------------------------------------------------- */
/*  The HTTP answer                                                           */
/* -------------------------------------------------------------------------- */

test("the status code is policy: what we acted on is 202, what is already true is 200", () => {
  const base = link();
  assert.equal(rmmReply({ kind: "opened", link: base, ticketId: base.ticketId }).status, 202);
  assert.equal(rmmReply({ kind: "reopened", link: base, ticketId: base.ticketId }).status, 202);
  assert.equal(rmmReply({ kind: "resolved", link: base, ticketId: base.ticketId }).status, 202);
  // A repeat and an ignored recovery are answers, not failures: monitoring systems
  // retry aggressively, and answering 500 to those fills a queue with non-work.
  assert.equal(rmmReply({ kind: "repeat", link: base, occurrences: 4 }).status, 200);
  assert.equal(rmmReply({ kind: "ignored", reason: "already cleared" }).status, 200);
  // A payload that was never an alert must not be retried…
  assert.equal(rmmReply({ kind: "rejected", reason: "not an alert" }).status, 400);
  // …and a desk that cannot respond at all should be retried.
  assert.equal(rmmReply({ kind: "disabled", reason: "nobody to raise it for" }).status, 503);
  assert.equal(rmmReply({ kind: "failed", error: "boom" }).status, 500);
});

/* -------------------------------------------------------------------------- */
/*  The connector                                                             */
/* -------------------------------------------------------------------------- */

function harness() {
  const audit = new AuditLog(sha256);
  const ticketStore = new MemoryTicketStore();
  const tickets = new TicketService(ticketStore, audit);
  const rmmStore = new MemoryRmmStore();
  let clock = Date.parse(AT);
  let n = 0;
  let requester: string | null = "requester-1";
  const ids: RmmIds = {
    id: () => `link-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };
  const service = new RmmConnectorService(
    rmmStore,
    {
      tickets: {
        createTicket: (actor, input) => tickets.createTicket(actor, input),
        setStatus: (actor, ticketId, to) => tickets.setStatus(actor, ticketId, to),
        reply: (actor, ticketId, body, kind) => tickets.reply(actor, ticketId, body, kind),
        findTicket: (tenantId, ticketId) => ticketStore.findTicket(tenantId, ticketId),
      },
      requesterFor: async () => requester,
    },
    audit,
    ids,
  );
  return {
    service,
    rmmStore,
    ticketStore,
    tickets,
    audit,
    setRequester: (value: string | null) => {
      requester = value;
    },
    actions: () => audit.snapshot().events.map((entry) => entry.action),
    at: (iso: string) => {
      clock = Date.parse(iso);
    },
  };
}

const TICKET_ACTOR: Actor = { id: SYSTEM_RMM_ACTOR, tenantId: "tenant-a", role: "ADMIN" };

test("a failure opens exactly one ticket, through the normal lifecycle", async () => {
  const h = harness();
  const outcome = await h.service.receive("tenant-a", payload());
  assert.equal(outcome.kind, "opened", JSON.stringify(outcome));
  if (outcome.kind !== "opened") return;

  const ticket = await h.ticketStore.findTicket("tenant-a", outcome.ticketId);
  assert.ok(ticket);
  assert.equal(ticket.status, "NEW");
  assert.equal(ticket.priority, "URGENT");
  assert.equal(ticket.type, "INCIDENT");
  assert.equal(ticket.requesterId, "requester-1");
  assert.match(ticket.subject, /db-01: disk \/var/);

  // The desk's own chain, with the system named as the actor.
  const created = h.audit.snapshot().events.find((entry) => entry.action === "ticket.create");
  assert.ok(created);
  assert.equal(created.actor, SYSTEM_RMM_ACTOR);
  assert.ok(h.actions().includes("rmm.alert.open"));
  assert.equal(h.audit.verify().ok, true);
});

test("a repeat is a note, not a second ticket", async () => {
  const h = harness();
  await h.service.receive("tenant-a", payload());
  h.at("2026-09-30T10:05:00.000Z");

  const repeat = await h.service.receive("tenant-a", payload({ externalId: "alert-2", summary: "still 98% full" }));
  assert.equal(repeat.kind, "repeat", JSON.stringify(repeat));
  if (repeat.kind !== "repeat") return;
  assert.equal(repeat.occurrences, 2);

  // One ticket, and the latest words are on its thread.
  assert.equal((await h.ticketStore.listTickets("tenant-a")).length, 1);
  const ticket = await h.ticketStore.findTicket("tenant-a", repeat.link.ticketId);
  assert.ok(ticket);
  assert.equal(ticket.messages.length, 1);
  assert.equal(ticket.messages[0].kind, "INTERNAL_NOTE");
  assert.match(ticket.messages[0].body, /still 98% full/);
  assert.equal(h.actions().filter((action) => action === "ticket.create").length, 1);
});

test("the clear closes the ticket the condition opened, walking NEW → OPEN → CLOSED", async () => {
  const h = harness();
  const opened = await h.service.receive("tenant-a", payload());
  assert.equal(opened.kind, "opened");
  h.at("2026-09-30T14:12:00.000Z");

  const cleared = await h.service.receive(
    "tenant-a",
    payload({ state: "RESOLVED", externalId: "alert-9", summary: "/var is 41% full", occurredAt: "2026-09-30T14:12:00.000Z" }),
  );
  assert.equal(cleared.kind, "resolved", JSON.stringify(cleared));
  if (cleared.kind !== "resolved") return;

  const ticket = await h.ticketStore.findTicket("tenant-a", cleared.ticketId);
  assert.ok(ticket);
  assert.equal(ticket.status, "CLOSED");
  // The ladder was walked, so the chain has both edges rather than a jump.
  const transitions = h.audit.snapshot().events.filter((entry) => entry.action === "ticket.status");
  assert.deepEqual(transitions.map((entry) => (entry.detail as { to: string }).to), ["OPEN", "CLOSED"]);

  // The desk can read why it closed itself, with the downtime on it.
  assert.ok(ticket.messages.some((message) => /has recovered/.test(message.body)));
  assert.ok(ticket.messages.some((message) => /Down for: 4h 12m/.test(message.body)));
  assert.equal(cleared.link.state, "RESOLVED");
  assert.equal(cleared.link.resolvedAt, "2026-09-30T14:12:00.000Z");
});

test("a condition that clears and fails again is a new incident, not a reopened note", async () => {
  const h = harness();
  const first = await h.service.receive("tenant-a", payload());
  assert.equal(first.kind, "opened");
  h.at("2026-09-30T11:00:00.000Z");
  await h.service.receive("tenant-a", payload({ state: "RESOLVED" }));

  h.at("2026-09-30T18:00:00.000Z");
  const again = await h.service.receive("tenant-a", payload({ externalId: "alert-3", summary: "/var is full again" }));
  assert.equal(again.kind, "reopened", JSON.stringify(again));
  if (again.kind !== "reopened" || first.kind !== "opened") return;

  // A second ticket, so its response clock and its post-incident record are real…
  assert.equal((await h.ticketStore.listTickets("tenant-a")).length, 2);
  assert.notEqual(again.ticketId, first.ticketId);
  const recurrence = await h.ticketStore.findTicket("tenant-a", again.ticketId);
  assert.ok(recurrence);
  assert.equal(recurrence.status, "NEW");
  // …and the condition says it is a recurring one.
  assert.equal(again.link.reopenCount, 1);
  assert.equal(again.link.occurrences, 1);
  assert.equal(h.actions().filter((action) => action === "ticket.create").length, 2);
});

test("a recovery for a check this desk never worked writes nothing at all", async () => {
  const h = harness();
  const outcome = await h.service.receive("tenant-a", payload({ state: "RESOLVED" }));
  assert.equal(outcome.kind, "ignored", JSON.stringify(outcome));
  assert.equal((await h.ticketStore.listTickets("tenant-a")).length, 0);
  assert.equal((await h.rmmStore.listLinks("tenant-a")).length, 0);
  // Not even on the chain: the desk had no relationship with that check, and a
  // monitoring system that reports every check's state would otherwise grow the
  // evidence log without saying anything.
  assert.deepEqual(h.audit.snapshot().events, []);
});

test("a second recovery for a condition we knew is recorded, because it is a vendor bug", async () => {
  const h = harness();
  await h.service.receive("tenant-a", payload());
  await h.service.receive("tenant-a", payload({ state: "RESOLVED" }));

  const twice = await h.service.receive("tenant-a", payload({ state: "RESOLVED" }));
  assert.equal(twice.kind, "ignored");
  assert.ok(h.actions().includes("rmm.alert.ignored"));
});

test("a desk with nobody to raise work for answers 503 rather than filing it against a ghost", async () => {
  const h = harness();
  h.setRequester(null);
  const outcome = await h.service.receive("tenant-a", payload());
  assert.equal(outcome.kind, "disabled");
  assert.equal((await h.ticketStore.listTickets("tenant-a")).length, 0);
  assert.equal((await h.rmmStore.listLinks("tenant-a")).length, 0);
});

test("a payload that was never an alert is rejected without side effects", async () => {
  const h = harness();
  const outcome = await h.service.receive("tenant-a", { hello: "world" });
  assert.equal(outcome.kind, "rejected");
  assert.deepEqual(h.audit.snapshot().events, []);
});

test("an alert cannot reach another tenant's condition", async () => {
  const h = harness();
  const first = await h.service.receive("tenant-a", payload());
  assert.equal(first.kind, "opened");

  // The same check, reported for a different tenant, is that tenant's own
  // condition — the link lookup is scoped, so it opens its own ticket.
  const other = await h.service.receive("tenant-b", payload());
  assert.equal(other.kind, "opened", JSON.stringify(other));
  if (first.kind !== "opened" || other.kind !== "opened") return;
  assert.notEqual(other.ticketId, first.ticketId);
  assert.equal((await h.rmmStore.listLinks("tenant-a")).length, 1);
  assert.equal((await h.rmmStore.listLinks("tenant-b")).length, 1);
});

test("a repeat can escalate the condition, and the link remembers the worst seen", async () => {
  const h = harness();
  await h.service.receive("tenant-a", payload({ severity: "info" }));
  const escalated = await h.service.receive("tenant-a", payload({ severity: "critical" }));
  assert.equal(escalated.kind, "repeat");
  if (escalated.kind !== "repeat") return;
  assert.equal(escalated.link.severity, "CRITICAL");
  // The ticket's own priority does not silently change underneath the desk; the
  // condition records what was seen and a person (or a rule) decides.
  const ticket = await h.ticketStore.findTicket("tenant-a", escalated.link.ticketId);
  assert.ok(ticket);
  assert.equal(ticket.priority, "NORMAL");
});

test("the condition a ticket came from is readable by ticket", async () => {
  const h = harness();
  const opened = await h.service.receive("tenant-a", payload());
  assert.equal(opened.kind, "opened");
  if (opened.kind !== "opened") return;

  const link = await h.service.linkFor("tenant-a", opened.ticketId);
  assert.ok(link);
  assert.equal(link.check, "disk /var");
  assert.equal(link.externalId, "alert-1");
  assert.equal(await h.service.linkFor("tenant-a", "not-a-ticket"), null);
});

test("a ticket a person already closed is not re-closed, but the clear is still recorded", async () => {
  const h = harness();
  const opened = await h.service.receive("tenant-a", payload());
  assert.equal(opened.kind, "opened");
  if (opened.kind !== "opened") return;

  // A person finishes it by hand before the check comes back.
  await h.tickets.setStatus(TICKET_ACTOR, opened.ticketId, "OPEN");
  await h.tickets.setStatus(TICKET_ACTOR, opened.ticketId, "CLOSED");

  const cleared = await h.service.receive("tenant-a", payload({ state: "RESOLVED" }));
  assert.equal(cleared.kind, "resolved", JSON.stringify(cleared));
  if (cleared.kind !== "resolved") return;
  assert.equal(cleared.link.state, "RESOLVED");
  assert.equal(cleared.link.resolvedAt, AT);
  // No second close, and no duplicate confirmation on the thread.
  const transitions = h.audit.snapshot().events.filter((entry) => entry.action === "ticket.status");
  assert.equal(transitions.length, 2);
});

test("every outcome is on the chain with the condition it belongs to", async () => {
  const h = harness();
  await h.service.receive("tenant-a", payload());
  await h.service.receive("tenant-a", payload());
  await h.service.receive("tenant-a", payload({ state: "RESOLVED" }));

  const events = h.audit.snapshot().events.filter((entry) => entry.action.startsWith("rmm."));
  assert.deepEqual(
    events.map((entry) => entry.action),
    ["rmm.alert.open", "rmm.alert.repeat", "rmm.alert.resolve"],
  );
  for (const entry of events) {
    assert.equal(entry.targetType, "rmm-condition");
    assert.equal(entry.targetId, "uptime-kuma:db-01:disk /var");
    assert.equal((entry.detail as { source: string }).source, "uptime-kuma");
    assert.equal((entry.detail as { ticketRef: string }).ticketRef, "TIX-000001");
  }
  assert.equal(h.audit.verify().ok, true);
});
