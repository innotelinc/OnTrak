/**
 * OnTrak Tix M4 tests: time, rates, and the invoice that cannot be billed twice.
 *
 * An MSP is paid for hours, so this covers the three things that must never be
 * wrong: the rate that applied (snapshotted, not re-read), the rounding the desk
 * agreed to (an increment is a contract term, not a display detail), and what has
 * already been billed (an invoiced entry is history — a correction is a credit
 * note).
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m4-time.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { type Actor } from "../src/lib/access-rules";
import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import { ClientService, MemoryClientStore } from "../src/lib/client-service";
import { buildInvoiceCsv } from "../src/lib/invoice-csv";
import { MemoryTimeStore, TimeService, type TimeStore } from "../src/lib/time-service";
import {
  billableSplit,
  billedMinutes,
  entryAmountCents,
  formatLoggedMinutes,
  formatMoney,
  invoiceLines,
  invoiceRefFor,
  invoiceTotals,
  isWorkDate,
  resolveRateCard,
  timeEntryDecision,
  validateRateCard,
  validateTimeEntry,
  type Invoice,
  type RateCardRecord,
  type TimeEntryRecord,
} from "../src/lib/time-rules";
import {
  PrismaTimeStore,
  toTimeEntryData,
  toTimeEntryRecord,
  toWorkDate,
  type TimePrismaClient,
} from "../src/lib/time-store-prisma";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const ADMIN = { id: "admin-1", tenantId: "tenant-a", role: "ADMIN" as const };
const DISPATCHER = { id: "dispatcher-1", tenantId: "tenant-a", role: "DISPATCHER" as const };
const AGENT = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };
const OTHER_AGENT = { id: "agent-2", tenantId: "tenant-a", role: "AGENT" as const };
const REQUESTER = { id: "req-1", tenantId: "tenant-a", role: "REQUESTER" as const };
const NOW = "2026-09-20T12:00:00.000Z";
const MONDAY = "2026-09-21";
const TUESDAY = "2026-09-22";

function card(overrides: Partial<RateCardRecord> = {}): RateCardRecord {
  return {
    id: "card-1",
    tenantId: "tenant-a",
    clientId: "client-1",
    name: "Northwind standard",
    currency: "USD",
    hourlyRateCents: 14_500,
    incrementMinutes: 15,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function entry(overrides: Partial<TimeEntryRecord> = {}): TimeEntryRecord {
  return {
    id: "entry-1",
    tenantId: "tenant-a",
    ticketId: null,
    ticketRef: null,
    clientId: null,
    userId: "agent-1",
    workDate: MONDAY,
    minutes: 60,
    billedMinutes: 60,
    billable: true,
    rateCardId: "card-1",
    rateCentsPerHour: 14_500,
    rateIncrementMinutes: 15,
    currency: "USD",
    note: null,
    invoicedAt: null,
    invoiceRef: null,
    taxCents: null,
    taxRateBasisPoints: null,
    retainerId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ the rules */

test("a rate card is refused before it can price anything, in words a person can act on", () => {
  assert.match(validateRateCard({ currency: "USD", hourlyRateCents: 1000, incrementMinutes: 15 })[0].message, /needs a name/);
  assert.match(
    validateRateCard({ name: "x".repeat(121), currency: "USD", hourlyRateCents: 1, incrementMinutes: 0 })[0].message,
    /at most 120 characters/,
  );
  assert.match(
    validateRateCard({ name: "Standard", currency: "usd", hourlyRateCents: 1, incrementMinutes: 0 })[0].message,
    /three upper-case letters/,
  );
  assert.match(
    validateRateCard({ name: "Standard", currency: "USD", hourlyRateCents: 12.5, incrementMinutes: 0 })[0].message,
    /whole number of cents/,
  );
  assert.match(
    validateRateCard({ name: "Standard", currency: "USD", hourlyRateCents: 1, incrementMinutes: 7 })[0].message,
    /Round to one of 0, 1, 5, 6, 10, 15, 30, 60 minutes/,
  );
  assert.deepEqual(validateRateCard({ name: "Standard", currency: "USD", hourlyRateCents: 0, incrementMinutes: 0 }), []);
});

test("time is refused on its shape: a day, a whole number of minutes, a bounded note", () => {
  assert.equal(isWorkDate(MONDAY), true);
  assert.equal(isWorkDate("2026-02-30"), false, "the 30th of February is not a day");
  assert.equal(isWorkDate("2026-9-1"), false);
  assert.equal(isWorkDate(NOW), false);

  assert.match(validateTimeEntry({ workDate: "yesterday", minutes: 30 })[0].message, /YYYY-MM-DD/);
  assert.match(validateTimeEntry({ workDate: MONDAY, minutes: 0 })[0].message, /whole number of minutes/);
  assert.match(validateTimeEntry({ workDate: MONDAY, minutes: 12.5 })[0].message, /whole number of minutes/);
  assert.match(validateTimeEntry({ workDate: MONDAY, minutes: 1_500 })[0].message, /at most 1440 minutes/);
  assert.match(validateTimeEntry({ workDate: MONDAY, minutes: 30, note: "x".repeat(501) })[0].message, /at most 500 characters/);
  assert.deepEqual(validateTimeEntry({ workDate: MONDAY, minutes: 1 }), []);
});

test("the client's own card outranks the desk's, and a card that is not theirs is not used", () => {
  const desk = card({ id: "desk-card", clientId: null, name: "Desk default", hourlyRateCents: 9_000 });
  const theirs = card({ id: "client-card", clientId: "client-2", name: "Contoso agreed" });

  const own = resolveRateCard({ cards: [desk, theirs], clientId: "client-2" });
  assert.equal(own.card?.id, "client-card");
  assert.equal(own.scope, "client");
  assert.equal(own.because, "the client's own rate card: Contoso agreed");

  // A client with no card of their own gets the desk's, and the reason says so.
  const fallback = resolveRateCard({ cards: [desk, theirs], clientId: "client-1" });
  assert.equal(fallback.card?.id, "desk-card");
  assert.equal(fallback.scope, "desk");

  // The desk's own work (no client) is priced by the desk's card.
  assert.equal(resolveRateCard({ cards: [desk, theirs], clientId: null }).card?.id, "desk-card");

  // Nothing at all is said to be "no rate", not "free".
  const nothing = resolveRateCard({ cards: [], clientId: "client-1" });
  assert.equal(nothing.card, null);
  assert.equal(nothing.scope, "none");
  assert.match(nothing.because, /no rate card covers this client/);

  // Two cards for one client should not exist (the service replaces), but if they
  // ever do, the newest wins rather than whichever the database returned first.
  const older = card({ id: "old", updatedAt: "2026-01-01T00:00:00.000Z" });
  const newer = card({ id: "new", updatedAt: "2026-08-01T00:00:00.000Z" });
  assert.equal(resolveRateCard({ cards: [older, newer], clientId: "client-1" }).card?.id, "new");
  assert.equal(resolveRateCard({ cards: [newer, older], clientId: "client-1" }).card?.id, "new");
});

test("the increment is a contract term: it rounds each entry, and the invoice sums the charges", () => {
  assert.equal(billedMinutes(20, 0), 20, "an exact card charges what was worked");
  assert.equal(billedMinutes(20, 15), 30);
  assert.equal(billedMinutes(45, 15), 45);
  assert.equal(billedMinutes(46, 15), 60);
  assert.equal(billedMinutes(20, 1), 20);

  // Three 20-minute visits on a 15-minute increment are three separate charges.
  const visits = [1, 2, 3].map((n) =>
    entry({ id: `v-${n}`, ticketId: "ticket-1", ticketRef: "TIX-000001", minutes: 20, billedMinutes: 30 }),
  );
  const lines = invoiceLines(visits);
  assert.equal(lines.length, 1, "one line per ticket, rate and currency");
  assert.equal(lines[0].billedMinutes, 90);
  assert.equal(lines[0].minutes, 60);
  assert.equal(lines[0].amountCents, Math.round((90 / 60) * 14_500));
  assert.equal(lines[0].entries, 3);
  assert.deepEqual(lines[0].userIds, ["agent-1"]);
  assert.equal(lines[0].description, "Support for TIX-000001");

  const totals = invoiceTotals(lines);
  assert.equal(totals.billedMinutes, 90);
  assert.equal(totals.amountCents, 21_750);
  assert.equal(totals.currency, "USD");
  assert.equal(totals.mixedCurrencies, false);
  assert.equal(formatMoney(totals.amountCents, totals.currency), "$217.50");
  assert.equal(formatLoggedMinutes(90), "1h 30m");
  assert.equal(formatLoggedMinutes(45), "45m");
});

test("a line is per ticket and per rate, and what charges nothing is left out", () => {
  const lines = invoiceLines([
    entry({ id: "a", ticketId: "t1", ticketRef: "TIX-000001", minutes: 60, billedMinutes: 60 }),
    entry({ id: "b", ticketId: "t1", ticketRef: "TIX-000001", minutes: 30, billedMinutes: 30, rateCentsPerHour: 20_000 }),
    entry({ id: "c", ticketId: "t2", ticketRef: "TIX-000002", minutes: 15, billedMinutes: 15 }),
    entry({ id: "d", minutes: 45, billedMinutes: null, billable: false, rateCentsPerHour: null }),
    entry({ id: "e", minutes: 20, billedMinutes: null, billable: true, rateCentsPerHour: null, currency: null }),
  ]);

  assert.deepEqual(
    lines.map((line) => [line.ticketRef, line.rateCentsPerHour, line.amountCents]),
    [
      ["TIX-000001", 20_000, 10_000],
      ["TIX-000001", 14_500, 14_500],
      ["TIX-000002", 14_500, 3_625],
    ],
  );

  // Non-billable time is not on the invoice, and neither is time nobody priced —
  // it is counted separately so an unpriced hour is a problem, not a discount.
  const split = billableSplit([
    entry({ id: "a", minutes: 60 }),
    entry({ id: "d", minutes: 45, billable: false, billedMinutes: null, rateCentsPerHour: null }),
    entry({ id: "e", minutes: 20, billedMinutes: null, rateCentsPerHour: null, currency: null }),
  ]);
  assert.equal(split.minutes, 125);
  assert.equal(split.billableMinutes, 80);
  assert.equal(split.nonBillableMinutes, 45);
  assert.equal(split.unpriced, 1);
  assert.equal(split.billablePercent, 64);
  assert.equal(split.currency, "USD", "the one currency anything was priced in");

  // A second currency makes the figure unstateable rather than wrong: there is no
  // such thing as a total of dollars and euros.
  const mixed = billableSplit([
    entry({ id: "a", minutes: 60 }),
    entry({ id: "f", minutes: 30, billedMinutes: 30, currency: "EUR" }),
  ]);
  assert.equal(mixed.currency, null);
  assert.equal(mixed.amountCents, 14_500 + 7_250);
});

test("what may still be done to a logged hour", () => {
  // On an invoice: history. The refusal names the invoice and the remedy.
  const billed = timeEntryDecision(entry({ invoicedAt: NOW, invoiceRef: "INV-20260920-ABC123" }), ADMIN);
  assert.equal(billed.allowed, false);
  assert.match(billed.reason, /on invoice INV-20260920-ABC123/);
  assert.match(billed.reason, /credit note/);

  // Somebody else's time is theirs to correct.
  const theirs = timeEntryDecision(entry({ userId: "agent-2" }), AGENT);
  assert.equal(theirs.allowed, false);
  assert.match(theirs.reason, /only change your own time/);

  // …unless you run the desk.
  assert.equal(timeEntryDecision(entry({ userId: "agent-2" }), DISPATCHER).allowed, true);

  // A requester does not log time at all, whatever the entry says.
  const requester = timeEntryDecision(entry({ userId: "req-1" }), REQUESTER);
  assert.equal(requester.allowed, false);
  assert.match(requester.reason, /do not log time/);

  assert.equal(timeEntryDecision(entry(), AGENT).allowed, true);
  assert.equal(entryAmountCents(entry({ billable: false })), null);
  assert.equal(entryAmountCents(entry({ rateCentsPerHour: null })), null);
  assert.equal(entryAmountCents(entry({ minutes: 7, billedMinutes: 15 })), Math.round((15 / 60) * 14_500));
});

test("an invoice reference is quoteable and cannot be guessed into another one", () => {
  const ref = invoiceRefFor("9c1f3a2b-4d5e-6f70-8192-a3b4c5d6e7f8", NOW);
  assert.equal(ref, "INV-20260920-9C1F3A");
  assert.notEqual(invoiceRefFor("other-id", NOW), ref);
  assert.equal(ref.startsWith("INV-20260920-"), true);
});

/* ----------------------------------------------------------------- the service */

async function harness() {
  const audit = new AuditLog(sha256);
  const store = new MemoryTimeStore();
  let clientN = 0;
  const clients = new ClientService(new MemoryClientStore(), audit, {
    id: () => `client-${++clientN}`,
    now: () => NOW,
  });
  let n = 0;
  const service = new TimeService(store, clients, audit, { id: () => `id-${++n}`, now: () => NOW });
  return { service, store, clients, audit };
}

/** A real client row, with `who` assigned to it — the scope a log is checked against. */
async function clientFor(h: Awaited<ReturnType<typeof harness>>, name: string, who: Actor = AGENT): Promise<string> {
  const created = await h.clients.create(ADMIN, { name });
  if (!created.ok) throw new Error(`could not create ${name}: ${created.error}`);
  await h.clients.assign(ADMIN, created.value.id, who.id);
  return created.value.id;
}

test("logging time snapshots the price, so a card changed later cannot restate it", async () => {
  const h = await harness();
  const northwind = await clientFor(h, "Northwind");
  h.store.addTicket("ticket-1", "TIX-000001", northwind);

  await h.service.saveRateCard(ADMIN, {
    clientId: northwind,
    name: "Northwind agreed",
    currency: "USD",
    hourlyRateCents: 14_500,
    incrementMinutes: 15,
  });
  await h.service.saveRateCard(ADMIN, { name: "Desk default", currency: "USD", hourlyRateCents: 9_000, incrementMinutes: 6 });

  const logged = await h.service.log(AGENT, {
    ticketId: "ticket-1",
    workDate: MONDAY,
    minutes: 20,
    billable: true,
    note: "  rebuilt the print queue  ",
  });
  assert.equal(logged.ok, true);
  if (!logged.ok) return;

  // The client and the reference come from the ticket, not from the form.
  assert.equal(logged.value.clientId, northwind);
  assert.equal(logged.value.ticketRef, "TIX-000001");
  // …and the price is written down: 20 minutes on a 15-minute increment is 30.
  assert.equal(logged.value.rateCentsPerHour, 14_500);
  assert.equal(logged.value.rateIncrementMinutes, 15);
  assert.equal(logged.value.billedMinutes, 30);
  assert.equal(logged.value.currency, "USD");
  assert.equal(logged.value.note, "rebuilt the print queue");
  assert.equal(entryAmountCents(logged.value), 7_250);

  // The rate doubles; the work already logged does not move.
  await h.service.saveRateCard(ADMIN, {
    clientId: northwind,
    name: "Northwind agreed",
    currency: "USD",
    hourlyRateCents: 29_000,
    incrementMinutes: 30,
  });
  const reread = await h.store.findEntry("tenant-a", logged.value.id);
  assert.equal(reread?.rateCentsPerHour, 14_500);
  assert.equal(reread?.billedMinutes, 30);
  assert.equal(entryAmountCents(reread as TimeEntryRecord), 7_250);

  // A correction re-derives the charge from the snapshot, not from today's card.
  const corrected = await h.service.correct(AGENT, logged.value.id, { minutes: 40 });
  assert.equal(corrected.ok, true);
  if (corrected.ok) {
    assert.equal(corrected.value.billedMinutes, 45, "the 15-minute increment it was logged at, not today's 30");
    assert.equal(corrected.value.rateCentsPerHour, 14_500);
    assert.equal(corrected.value.workDate, MONDAY);
  }

  // A correction moves minutes and the note, and nothing else the money depends on.
  const afterSecondRate = await h.service.correct(ADMIN, logged.value.id, { minutes: 60, note: "rebuilt it twice" });
  assert.equal(afterSecondRate.ok, true);
  if (afterSecondRate.ok) {
    assert.equal(afterSecondRate.value.billedMinutes, 60, "the entry's own 15-minute increment, not the new card's 30");
    assert.equal(afterSecondRate.value.rateCentsPerHour, 14_500);
    assert.equal(afterSecondRate.value.note, "rebuilt it twice");
  }

  // A second card for the same client replaces the first rather than accumulating.
  const cards = await h.service.rateCards(ADMIN);
  assert.equal(cards.ok && cards.value.filter((c) => c.clientId === northwind).length, 1);
  assert.equal(cards.ok && cards.value.length, 2, "the client's card and the desk's default");
});

test("time is logged against a day, a ticket and a client that are the actor's own", async () => {
  const h = await harness();
  const northwind = await clientFor(h, "Northwind");
  h.store.addTicket("ticket-1", "TIX-000001", northwind);
  await h.service.saveRateCard(ADMIN, {
    clientId: northwind,
    name: "Northwind agreed",
    currency: "USD",
    hourlyRateCents: 14_500,
    incrementMinutes: 15,
  });

  const unknownTicket = await h.service.log(AGENT, { ticketId: "made-up", workDate: MONDAY, minutes: 30, billable: true });
  assert.equal(unknownTicket.ok, false);
  if (!unknownTicket.ok) assert.match(unknownTicket.error, /not on this desk/);

  const badDay = await h.service.log(AGENT, { workDate: "2026-02-30", minutes: 30, billable: true });
  assert.equal(badDay.ok, false);
  if (!badDay.ok) assert.match(badDay.error, /YYYY-MM-DD/);

  const badMinutes = await h.service.log(AGENT, { workDate: MONDAY, minutes: 0, billable: true });
  assert.equal(badMinutes.ok, false);
  if (!badMinutes.ok) assert.match(badMinutes.error, /whole number of minutes/);

  // Time is scoped like the worklist: an agent cannot log hours against a client
  // they do not serve, whether they named it or reached it through a ticket id.
  const noScope = await h.service.log(OTHER_AGENT, { ticketId: "ticket-1", workDate: MONDAY, minutes: 30, billable: true });
  assert.equal(noScope.ok, false);
  if (!noScope.ok) assert.match(noScope.error, /not yours to log time against/);
  const named = await h.service.log(OTHER_AGENT, { clientId: northwind, workDate: MONDAY, minutes: 30, billable: true });
  assert.equal(named.ok, false);

  const requester = await h.service.log(REQUESTER, { workDate: MONDAY, minutes: 30, billable: true });
  assert.equal(requester.ok, false);
  if (!requester.ok) assert.match(requester.error, /do not log time/);

  // Billable work with no card still logs: the desk did the work. It is unpriced,
  // which the ledger counts rather than hiding.
  const unpriced = await h.service.log(AGENT, { workDate: TUESDAY, minutes: 45, billable: true });
  assert.equal(unpriced.ok, true);
  if (unpriced.ok) {
    assert.equal(unpriced.value.billable, true);
    assert.equal(unpriced.value.rateCentsPerHour, null);
    assert.equal(unpriced.value.billedMinutes, null);
    assert.equal(entryAmountCents(unpriced.value), null);
  }

  // The same log, for an agent who does serve the client, is allowed.
  const contoso = await h.clients.create(ADMIN, { name: "Contoso" });
  assert.equal(contoso.ok, true);
  if (contoso.ok) {
    await h.clients.assign(ADMIN, contoso.value.id, OTHER_AGENT.id);
    h.store.addTicket("ticket-2", "TIX-000002", contoso.value.id);
    const allowed = await h.service.log(OTHER_AGENT, { ticketId: "ticket-2", workDate: TUESDAY, minutes: 30, billable: true });
    assert.equal(allowed.ok, true);
  }
});

test("an agent's timesheet is scoped like their worklist, and what has no client belongs to the desk", async () => {
  const h = await harness();
  await h.service.saveRateCard(ADMIN, { name: "Desk default", currency: "USD", hourlyRateCents: 9_000, incrementMinutes: 6 });

  const northwind = await clientFor(h, "Northwind");
  const contoso = await clientFor(h, "Contoso", DISPATCHER);
  h.store.addTicket("t-n", "TIX-000001", northwind);
  h.store.addTicket("t-c", "TIX-000002", contoso);

  await h.service.log(AGENT, { ticketId: "t-n", workDate: MONDAY, minutes: 60, billable: true });
  await h.service.log(AGENT, { ticketId: "t-n", workDate: MONDAY, minutes: 30, billable: true });
  const deskWork = await h.service.log(AGENT, { workDate: TUESDAY, minutes: 45, billable: true });
  assert.equal(deskWork.ok, true);

  const mine = await h.service.entries(AGENT);
  assert.equal(mine.ok, true);
  if (mine.ok) assert.equal(mine.value.length, 3, "their client's time and the desk's own");

  // A dispatcher sees the whole desk; a requester sees nothing.
  const everything = await h.service.entries(DISPATCHER);
  assert.equal(everything.ok && everything.value.length, 3);
  assert.equal((await h.service.entries(REQUESTER)).ok, false);

  // Filtering by client, period and ticket, as the ledger and the ticket panel do.
  assert.equal((await h.service.entries(AGENT, { clientId: northwind })).ok && true, true);
  const forNorthwind = await h.service.entries(AGENT, { clientId: northwind });
  assert.equal(forNorthwind.ok && forNorthwind.value.length, 2);
  const forTicket = await h.service.entries(AGENT, { ticketId: "t-n" });
  assert.equal(forTicket.ok && forTicket.value.length, 2);
  const inPeriod = await h.service.entries(AGENT, { from: TUESDAY, to: TUESDAY });
  assert.equal(inPeriod.ok && inPeriod.value.length, 1);

  const split = await h.service.split(AGENT, { clientId: northwind });
  assert.equal(split.ok, true);
  if (split.ok) {
    assert.equal(split.value.minutes, 90);
    assert.equal(split.value.billablePercent, 100);
    // 60 + 30 minutes on a 6-minute increment is exactly 90.
    assert.equal(split.value.billedMinutes, 90);
    assert.equal(split.value.amountCents, Math.round((90 / 60) * 9_000));
  }
});

test("an invoice stamps what it covers, so the same hour cannot be billed twice", async () => {
  const h = await harness();
  const northwind = await clientFor(h, "Northwind");
  await h.service.saveRateCard(ADMIN, {
    clientId: northwind,
    name: "Northwind agreed",
    currency: "USD",
    hourlyRateCents: 14_500,
    incrementMinutes: 15,
  });
  h.store.addTicket("t1", "TIX-000001", northwind);
  h.store.addTicket("t2", "TIX-000002", northwind);
  h.store.addTicket("t3", "TIX-000003", null);

  await h.service.log(AGENT, { ticketId: "t1", workDate: MONDAY, minutes: 20, billable: true, note: "printer" });
  await h.service.log(AGENT, { ticketId: "t2", workDate: MONDAY, minutes: 60, billable: true });
  await h.service.log(AGENT, { ticketId: "t2", workDate: MONDAY, minutes: 30, billable: false, note: "waiting on the vendor" });
  const deskEntry = await h.service.log(AGENT, { ticketId: "t3", workDate: MONDAY, minutes: 45, billable: true });
  assert.equal(deskEntry.ok, true, "the desk's own work has no client and no rate, and still logs");

  const issued = await h.service.invoice(ADMIN, { clientId: northwind, from: MONDAY, to: MONDAY });
  assert.equal(issued.ok, true);
  if (!issued.ok) return;

  // One invoice per currency, so a single-currency period is one document.
  assert.equal(issued.value.length, 1);
  const one = issued.value[0];
  assert.match(one.ref, /^INV-20260920-ID\d+$/);
  assert.equal(one.lines.length, 2, "one line per ticket, both at the client's rate");
  assert.equal(one.totals.billedMinutes, 90);
  assert.equal(one.totals.amountCents, 21_750);
  assert.equal(one.skipped.nonBillable, 1);
  // The desk's own time is not in this period's *client* set at all, so it is not
  // reported as skipped — it stays logged and uninvoiced for its own invoice.
  assert.equal(one.skipped.unpriced, 0);
  const untouched = await h.service.entries(ADMIN, { ticketId: "t3" });
  assert.equal(untouched.ok && untouched.value[0].invoicedAt, null);

  // Every entry it covered is stamped, and stays readable.
  const stamped = await h.service.entries(ADMIN, { invoiceRef: one.ref });
  assert.equal(stamped.ok, true);
  if (stamped.ok) {
    assert.equal(stamped.value.length, 2);
    assert.equal(stamped.value.every((row) => row.invoicedAt === NOW), true);
  }

  // The stamped entries are frozen: not editable, not removable.
  const frozenId = stamped.ok ? stamped.value[0].id : "";
  const edited = await h.service.correct(ADMIN, frozenId, { minutes: 10 });
  assert.equal(edited.ok, false);
  if (!edited.ok) assert.match(edited.error, /credit note/);
  assert.equal((await h.service.remove(ADMIN, frozenId)).ok, false);

  // A second invoice over the same period has nothing left to bill, and says why.
  const again = await h.service.invoice(ADMIN, { clientId: northwind, from: MONDAY, to: MONDAY });
  assert.equal(again.ok, false);
  if (!again.ok) assert.match(again.error, /already on an invoice/);

  // Re-reading it by reference gives the same figures, and stamps nothing new.
  const reread = await h.service.issued(ADMIN, one.ref);
  assert.equal(reread.ok, true);
  if (reread.ok) {
    assert.equal(reread.value.invoice.totals.amountCents, 21_750);
    assert.equal(reread.value.invoice.totals.billedMinutes, 90);
    assert.equal(reread.value.invoice.totals.currency, "USD");
    assert.equal(reread.value.invoice.clientId, northwind);
    assert.equal(reread.value.invoice.from, MONDAY);
    // Nothing has been credited, so the whole thing is still owed.
    assert.equal(reread.value.creditedCents, 0);
    assert.equal(reread.value.outstandingCents, 21_750);
  }
  assert.equal((await h.service.issued(ADMIN, "INV-19700101-NOPE00")).ok, false);

  // The ledger lists what was issued.
  const ledger = await h.service.invoices(ADMIN);
  assert.equal(ledger.ok, true);
  if (ledger.ok) {
    assert.equal(ledger.value.length, 1);
    assert.equal(ledger.value[0].ref, one.ref);
    assert.equal(ledger.value[0].entries, 2);
    assert.equal(ledger.value[0].amountCents, 21_750);
  }

  // The whole exchange is on the chain, with the totals and what was skipped.
  const events = h.audit.snapshot().events;
  const exports = events.filter((event) => event.action === "time.invoice.export");
  assert.equal(exports.length, 1);
  assert.equal(exports[0].targetId, one.ref);
  assert.equal(exports[0].detail?.amountCents, 21_750);
  assert.equal(exports[0].detail?.entries, 2);
  assert.deepEqual(exports[0].detail?.skipped, { alreadyInvoiced: 0, unpriced: 0, nonBillable: 1 });
  assert.equal(events.filter((event) => event.action === "time.log").length, 4);
  assert.equal(events.filter((event) => event.action === "rate.card.save").length, 1);
});

test("issuing is a manager's act, removing a card keeps history, and the period must make sense", async () => {
  const h = await harness();
  const deskCard = await h.service.saveRateCard(ADMIN, {
    name: "Desk default",
    currency: "USD",
    hourlyRateCents: 9_000,
    incrementMinutes: 0,
  });
  assert.equal(deskCard.ok, true);

  // An agent may log but may not price, invoice, or write a card.
  const agentCard = await h.service.saveRateCard(AGENT, {
    clientId: "client-1",
    name: "Northwind agreed",
    currency: "USD",
    hourlyRateCents: 14_500,
    incrementMinutes: 15,
  });
  assert.equal(agentCard.ok, false);
  if (!agentCard.ok) assert.match(agentCard.error, /do not manage what the desk charges/);
  assert.equal((await h.service.invoice(AGENT, { clientId: null, from: MONDAY, to: MONDAY })).ok, false);

  await h.service.log(AGENT, { workDate: MONDAY, minutes: 60, billable: true });

  const backwards = await h.service.invoice(ADMIN, { clientId: null, from: TUESDAY, to: MONDAY });
  assert.equal(backwards.ok, false);
  if (!backwards.ok) assert.match(backwards.error, /two dates, from and to/);

  const nothing = await h.service.invoice(ADMIN, { clientId: null, from: "2026-01-01", to: "2026-01-02" });
  assert.equal(nothing.ok, false);
  if (!nothing.ok) assert.match(nothing.error, /Nothing billable was logged/);

  // The desk's own time is billable, and is invoiced with no client on it.
  const desk = await h.service.invoice(ADMIN, { clientId: null, from: MONDAY, to: MONDAY });
  assert.equal(desk.ok, true);
  if (desk.ok) {
    assert.equal(desk.value[0].clientId, null);
    assert.equal(desk.value[0].totals.amountCents, 9_000);
  }

  // Dropping the card does not touch what it already priced.
  assert.equal(deskCard.ok, true);
  if (deskCard.ok) {
    assert.equal((await h.service.removeRateCard(ADMIN, deskCard.value.id)).ok, true);
    const after = await h.service.rateCards(ADMIN);
    assert.equal(after.ok && after.value.length, 0);
    const priced = await h.service.entries(ADMIN);
    assert.equal(priced.ok && priced.value[0].rateCentsPerHour, 9_000);
    assert.equal((await h.service.removeRateCard(ADMIN, "made-up")).ok, false);
  }
});

/* ------------------------------------------------------------------- the CSV */

test("the CSV says who, what, how long and how much — and never a formatted number", async () => {
  const h = await harness();
  await h.service.saveRateCard(ADMIN, {
    name: "Desk default, standard",
    currency: "USD",
    hourlyRateCents: 12_000,
    incrementMinutes: 15,
  });
  h.store.addTicket("t1", "TIX-000001", null);
  await h.service.log(AGENT, { ticketId: "t1", workDate: MONDAY, minutes: 20, billable: true });
  const invoice = await h.service.invoice(ADMIN, { clientId: null, from: MONDAY, to: MONDAY });
  assert.equal(invoice.ok, true);
  if (!invoice.ok) return;

  const csv = buildInvoiceCsv(invoice.value[0], { generatedAt: NOW, clientName: 'Contoso "East", Ltd' });
  const rows = csv.trim().split("\r\n");
  assert.match(rows[0], /^OnTrak Tix invoice INV-20260920-/);
  // A comma and a quote in a client's name survive the trip.
  assert.equal(rows[1], 'Client,"Contoso ""East"", Ltd"');
  assert.ok(csv.includes("Rate per hour,Currency,Billed minutes,Billed hours,Amount,Entries,Worked by"));
  assert.ok(csv.includes("TIX-000001,Support for TIX-000001,120.00,USD,30,0.50,60.00,1,agent-1"));
  assert.ok(csv.includes("Subtotal,,,USD,30,0.50,60.00,1"));
  assert.ok(csv.includes("Amount due,,,USD,,,60.00"));
  // Nothing was left out, so there is nothing to explain…
  assert.ok(!csv.includes("Not billed"));
  assert.ok(!csv.includes("$"), "money is a decimal for the spreadsheet, not a formatted string");

  // …and when hours are unbillable, the invoice says so rather than just costing more.
  const partial: Invoice = { ...invoice.value[0], skipped: { alreadyInvoiced: 1, unpriced: 2, nonBillable: 3 } };
  const explained = buildInvoiceCsv(partial, { generatedAt: NOW });
  assert.ok(explained.includes("Not billed,2 unbillable (no rate),1 already invoiced,3 not chargeable"));
  assert.ok(explained.includes("Client,the desk"), "with no client named, the file says the desk rather than the id");
});

/* ------------------------------------------------------------------- the adapter */

test("the Prisma store keeps a work day a day, and carries the ticket's reference", async () => {
  const row = {
    id: "entry-1",
    tenantId: "tenant-a",
    ticketId: "ticket-1",
    clientId: "client-1",
    userId: "agent-1",
    workDate: new Date("2026-09-20T00:00:00.000Z"),
    minutes: 20,
    billedMinutes: 30,
    billable: true,
    rateCardId: "card-1",
    rateCentsPerHour: 14_500,
    rateIncrementMinutes: 15,
    currency: "USD",
    note: "printer",
    invoicedAt: null,
    invoiceRef: null,
    taxCents: null,
    taxRateBasisPoints: null,
    retainerId: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ticket: { ref: "TIX-000001" },
  };

  const calls: unknown[] = [];
  const db = {
    timeEntry: {
      findMany: async (args: unknown) => {
        calls.push(args);
        return [row];
      },
      findFirst: async () => row,
      create: async (args: unknown) => {
        calls.push(args);
        return row;
      },
      update: async (args: unknown) => {
        calls.push(args);
        return row;
      },
      deleteMany: async (args: unknown) => {
        calls.push(args);
        return { count: 1 };
      },
    },
    rateCard: {
      findMany: async () => [],
      create: async (args: unknown) => args,
      update: async (args: unknown) => args,
      deleteMany: async () => ({ count: 1 }),
    },
    ticket: { findFirst: async () => ({ ref: "TIX-000001", clientId: "client-1" }) },
  } as unknown as TimePrismaClient;

  const store: TimeStore = new PrismaTimeStore(db);
  const found = await store.listEntries("tenant-a", { clientId: "client-1", from: "2026-09-01", to: "2026-09-30" });
  assert.equal(found.length, 1);
  assert.equal(found[0].workDate, "2026-09-20", "a day stays a day");
  assert.equal(found[0].ticketRef, "TIX-000001");
  assert.equal(found[0].invoicedAt, null);

  const where = (calls[0] as { where: Record<string, unknown> }).where;
  assert.equal(where.clientId, "client-1");
  assert.deepEqual(where.workDate, { gte: new Date("2026-09-01T00:00:00.000Z"), lte: new Date("2026-09-30T00:00:00.000Z") });
  assert.deepEqual((calls[0] as { include: unknown }).include, { ticket: { select: { ref: true } } });

  // An unbounded filter must not accidentally ask for "clientId is null".
  await store.listEntries("tenant-a");
  const bare = (calls[1] as { where: Record<string, unknown> }).where;
  assert.equal("clientId" in bare, false);

  assert.equal(toWorkDate("2026-09-20T23:59:59.000Z"), "2026-09-20");
  const data = toTimeEntryData(toTimeEntryRecord(row));
  assert.equal((data.workDate as Date).toISOString(), "2026-09-20T00:00:00.000Z");
  assert.equal(data.invoicedAt, null);
  assert.equal(data.rateIncrementMinutes, 15);
});
