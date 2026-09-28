/**
 * OnTrak Tix M4 tests: what is added to a bill, what reverses one, and what was
 * paid before the work — plus the currency rule that makes a total a total.
 *
 * Three properties are worth stating, because each is the difference between a
 * ledger and a guess:
 *
 *  - **Tax is read back off the entries.** A rate changed in April must not
 *    restate what March was charged, so an issued invoice reports the rate that
 *    produced it rather than today's rule.
 *  - **A credit note can never exceed what is left.** Crediting the same money
 *    twice is the failure this is built to make impossible, not unlikely.
 *  - **One invoice per currency.** Adding dollars to euros produces a number
 *    nobody can pay, so a period that spans two currencies produces two
 *    documents with two references.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m4-billing-depth.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import {
  activeRetainer,
  creditNoteDecision,
  creditNoteRefFor,
  creditedTotal,
  formatRate,
  resolveTaxRule,
  retainerCovers,
  retainerDrawdown,
  retainerStanding,
  retainerSummary,
  taxCentsFor,
  taxForInvoice,
  validateCreditNote,
  validateRetainer,
  validateTaxRule,
  type CreditNoteRecord,
  type TaxRuleRecord,
} from "../src/lib/billing-rules";
import { ClientService, MemoryClientStore } from "../src/lib/client-service";
import { MemoryTimeStore, TimeService } from "../src/lib/time-service";
import { buildInvoiceCsv } from "../src/lib/invoice-csv";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const ADMIN = { id: "admin-1", tenantId: "tenant-a", role: "ADMIN" as const };
const AGENT = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };
/** A Monday, so a weekday calendar has the whole week in front of it. */
const MONDAY = "2026-09-21";
const NOW = "2026-09-21T12:00:00.000Z";

let sequential = 0;

async function harness() {
  const clients = new ClientService(new MemoryClientStore(), null, { id: () => `client-${++sequential}`, now: () => NOW });
  const audit = new AuditLog(sha256);
  const store = new MemoryTimeStore();
  const service = new TimeService(store, clients, audit, { id: () => `id-${++sequential}`, now: () => NOW });

  const northwind = await clients.create(ADMIN, { name: "Northwind" });
  const contoso = await clients.create(ADMIN, { name: "Contoso" });
  assert.equal(northwind.ok && contoso.ok, true);
  if (!northwind.ok || !contoso.ok) throw new Error("fixture");

  // The agent works Northwind. Logging time against a client is scoped like
  // everything else, so an unassigned agent cannot log this time at all.
  assert.equal((await clients.assign(ADMIN, northwind.value.id, AGENT.id)).ok, true);

  return { clients, audit, store, service, northwind: northwind.value.id, contoso: contoso.value.id };
}

function rule(overrides: Partial<TaxRuleRecord> = {}): TaxRuleRecord {
  return {
    id: "tax-1",
    tenantId: "tenant-a",
    clientId: null,
    label: "State sales tax",
    rateBasisPoints: 825,
    updatedAt: NOW,
    ...overrides,
  };
}

/* ------------------------------------------------------------------- the tax rule */

test("tax is basis points, resolved client-first, and refused when it is a typo", () => {
  assert.deepEqual(validateTaxRule({ label: "VAT", rateBasisPoints: 2000 }), []);
  assert.match(validateTaxRule({ label: "", rateBasisPoints: 825 })[0].message, /label/);
  assert.match(validateTaxRule({ label: "VAT", rateBasisPoints: 10_001 })[0].message, /typo/);
  assert.match(validateTaxRule({ label: "VAT", rateBasisPoints: 8.25 })[0].message, /whole basis points/);

  const rules = [rule(), rule({ id: "tax-2", clientId: "client-1", label: "Northwind exempt", rateBasisPoints: 0 })];
  assert.equal(resolveTaxRule({ rules, clientId: "client-1" }).rule?.id, "tax-2");
  assert.match(resolveTaxRule({ rules, clientId: "client-1" }).because, /written for this client/);
  assert.equal(resolveTaxRule({ rules, clientId: "client-2" }).rule?.id, "tax-1");
  assert.equal(resolveTaxRule({ rules: [], clientId: null }).scope, "none");

  // 8.25% of $120.00 is $9.90, and rounding goes to the cent.
  assert.equal(taxCentsFor(12_000, 825), 990);
  assert.equal(formatRate(825), "8.25%");
  assert.equal(formatRate(2000), "20%");
});

test("a tax block is labour plus tax, reported beside the subtotal and never folded into it", () => {
  const tax = taxForInvoice({ amountCents: 12_000, rule: rule() });
  assert.deepEqual(tax, { label: "State sales tax", rateBasisPoints: 825, baseCents: 12_000, taxCents: 990, totalCents: 12_990 });
  assert.equal(taxForInvoice({ amountCents: 12_000, rule: null }), null, "no rule is not a zero rate");
});

/* ------------------------------------------------------------------- credit notes */

test("a credit note cannot credit money the invoice never charged, or credit it twice", () => {
  assert.deepEqual(validateCreditNote({ amountCents: 5000, reason: "the visit was logged twice" }), []);
  assert.match(validateCreditNote({ amountCents: 0, reason: "the visit was logged twice" })[0].message, /more than zero/);
  assert.match(validateCreditNote({ amountCents: 100, reason: "oops" })[0].message, /reason/);

  const full = creditNoteDecision({ amountCents: 5_000, invoiceCents: 12_990, alreadyCreditedCents: 0, currency: "USD" });
  assert.equal(full.allowed, true);
  assert.equal(full.remainingCents, 7_990);

  // More than is left: refused, and the refusal says what is left.
  const tooMuch = creditNoteDecision({ amountCents: 9_000, invoiceCents: 12_990, alreadyCreditedCents: 5_000, currency: "USD" });
  assert.equal(tooMuch.allowed, false);
  assert.match(tooMuch.reason, /79\.90 USD/);

  // Already credited in full: there is nothing left to give back.
  const exhausted = creditNoteDecision({ amountCents: 1, invoiceCents: 12_990, alreadyCreditedCents: 12_990, currency: "USD" });
  assert.equal(exhausted.allowed, false);
  assert.match(exhausted.reason, /credited in full/);

  const notes: Pick<CreditNoteRecord, "invoiceRef" | "amountCents">[] = [
    { invoiceRef: "INV-1", amountCents: 1_000 },
    { invoiceRef: "INV-1", amountCents: 2_500 },
    { invoiceRef: "INV-2", amountCents: 900 },
  ];
  assert.equal(creditedTotal(notes, "INV-1"), 3_500);
  assert.match(creditNoteRefFor("abcdef12", NOW), /^CN-20260921-ABCDEF$/);
});

/* ------------------------------------------------------------------- retainers */

test("a retainer's balance is derived from the ledger, never stored", () => {
  assert.deepEqual(
    validateRetainer({ currency: "usd", fundedCents: 500_000, periodStart: "2026-10-01", periodEnd: "2026-12-31" }),
    [],
  );
  assert.match(validateRetainer({ currency: "US", fundedCents: 1, periodStart: "2026-10-01", periodEnd: "2026-12-31" })[0].message, /currency/);
  assert.match(validateRetainer({ currency: "USD", fundedCents: 0, periodStart: "2026-10-01", periodEnd: "2026-12-31" })[0].message, /more than zero/);
  assert.match(validateRetainer({ currency: "USD", fundedCents: 1, periodStart: "2026-12-31", periodEnd: "2026-10-01" })[0].message, /end on or after/);

  const standing = retainerStanding({ fundedCents: 500_000, drawnCents: 125_000 });
  assert.equal(standing.remainingCents, 375_000);
  assert.equal(standing.usedPercent, 25);
  assert.equal(standing.exhausted, false);
  assert.equal(retainerStanding({ fundedCents: 500_000, drawnCents: 900_000 }).remainingCents, 0, "an overdraw is not a negative balance");
  assert.equal(retainerStanding({ fundedCents: 500_000, drawnCents: 900_000 }).exhausted, true);

  // A drawdown is capped by the invoice and by what is left, in that order.
  assert.equal(retainerDrawdown({ invoiceCents: 12_990, remainingCents: 375_000 }), 12_990);
  assert.equal(retainerDrawdown({ invoiceCents: 12_990, remainingCents: 1_000 }), 1_000);
  assert.equal(retainerDrawdown({ invoiceCents: 12_990, remainingCents: 0 }), 0);
});

test("the retainer covering a day is the newest period that contains it", () => {
  const base = {
    id: "r1",
    tenantId: "tenant-a",
    clientId: "client-1",
    currency: "USD",
    fundedCents: 500_000,
    note: null,
    createdBy: "admin-1",
    createdAt: NOW,
  };
  const retainers = [
    { ...base, id: "r1", periodStart: "2026-01-01", periodEnd: "2026-12-31" },
    { ...base, id: "r2", periodStart: "2026-10-01", periodEnd: "2026-10-31" },
  ];

  assert.equal(retainerCovers(retainers[0], "2026-09-21"), true);
  assert.equal(activeRetainer(retainers, "client-1", "2026-10-15")?.id, "r2", "the period written for that month wins");
  assert.equal(activeRetainer(retainers, "client-1", "2026-09-21")?.id, "r1");
  assert.equal(activeRetainer(retainers, "client-2", "2026-09-21"), null);
  assert.match(retainerSummary(retainers[0], retainerStanding({ fundedCents: 500_000, drawnCents: 125_000 })), /3750\.00 USD left/);
});

/* ------------------------------------------------------------------- the service */

test("an invoice carries the tax rule in force, and reading it back does not re-derive it", async () => {
  const h = await harness();
  assert.equal(
    (await h.service.saveRateCard(ADMIN, { clientId: h.northwind, name: "Northwind standard", currency: "USD", hourlyRateCents: 12_000, incrementMinutes: 0 })).ok,
    true,
  );
  assert.equal((await h.service.saveTaxRule(ADMIN, { label: "State sales tax", rateBasisPoints: 825 })).ok, true);
  assert.equal((await h.service.saveTaxRule(ADMIN, { clientId: h.northwind, label: "Northwind exempt", rateBasisPoints: 0 })).ok, true);

  // The client's own rule wins, and a zero rate is a rate — not a missing rule.
  const resolved = await h.service.taxRuleFor(ADMIN, h.northwind);
  assert.equal(resolved.ok && resolved.value.scope, "client");
  assert.equal(resolved.ok && resolved.value.rule?.rateBasisPoints, 0);

  h.store.addTicket("t1", "TIX-000001", h.northwind);
  assert.equal((await h.service.log(AGENT, { ticketId: "t1", workDate: MONDAY, minutes: 120, billable: true })).ok, true);

  const issued = await h.service.invoice(ADMIN, { clientId: h.northwind, from: MONDAY, to: MONDAY });
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  assert.equal(issued.value.length, 1);
  assert.equal(issued.value[0].totals.amountCents, 24_000);
  assert.equal(issued.value[0].tax?.rateBasisPoints, 0, "an exempt client is charged nothing, on the record");
  assert.equal(issued.value[0].totalCents, 24_000);

  // Meanwhile the desk's own work is priced by the desk's own card and taxed at
  // the desk's default rule. The card has to exist *before* the hour is logged:
  // the price is snapshotted at the moment of logging, so a card written later
  // does not reach back into work already done.
  assert.equal(
    (await h.service.saveRateCard(ADMIN, { name: "Desk default", currency: "USD", hourlyRateCents: 12_000, incrementMinutes: 0 })).ok,
    true,
  );
  h.store.addTicket("t2", "TIX-000002", null);
  assert.equal((await h.service.log(AGENT, { ticketId: "t2", workDate: MONDAY, minutes: 60, billable: true })).ok, true);
  const deskIssued = await h.service.invoice(ADMIN, { clientId: h.northwind, from: MONDAY, to: MONDAY });
  // The Northwind ticket is already invoiced, so only the desk's own hour is left
  // — and it belongs to no client, so this call has nothing to bill.
  assert.equal(deskIssued.ok, false);

  // The desk's own hour is a different invoice, taxed by the desk's own rule
  // rather than the client's exempt one.
  const deskOnly = await h.service.invoice(ADMIN, { clientId: null, from: MONDAY, to: MONDAY });
  assert.equal(deskOnly.ok, true);
  if (!deskOnly.ok) return;
  assert.equal(deskOnly.value[0].totals.amountCents, 12_000);
  assert.equal(deskOnly.value[0].tax?.rateBasisPoints, 825, "the client's exempt rule does not reach the desk's own work");
  assert.equal(deskOnly.value[0].totalCents, 12_990);

  // Now change the default rule: a rate changed afterwards must not restate an
  // invoice that was already issued — on either client.
  assert.equal((await h.service.saveTaxRule(ADMIN, { label: "Sales tax", rateBasisPoints: 800 })).ok, true);
  const reread = await h.service.issued(ADMIN, issued.value[0].ref);
  assert.equal(reread.ok, true);
  if (reread.ok) {
    assert.equal(reread.value.invoice.tax?.rateBasisPoints, 0, "the client's own rule was snapshotted onto the entries");
    assert.equal(reread.value.outstandingCents, 24_000);
  }
  const deskReread = await h.service.issued(ADMIN, deskOnly.value[0].ref);
  assert.equal(deskReread.ok, true);
  if (deskReread.ok) {
    assert.equal(deskReread.value.invoice.tax?.rateBasisPoints, 825);
    assert.equal(deskReread.value.invoice.tax?.taxCents, 990);
  }

  const events = h.audit.snapshot().events.filter((event) => event.action.startsWith("tax.rule."));
  assert.deepEqual(events.map((event) => event.action), ["tax.rule.save", "tax.rule.save", "tax.rule.save"]);
  assert.equal(events[2].detail?.previousRateBasisPoints, 825, "the change says what it replaced");
});

test("a credit note needs a reason, is capped by what is left, and is the only way back from an invoice", async () => {
  const h = await harness();
  await h.service.saveRateCard(ADMIN, { clientId: h.northwind, name: "Northwind standard", currency: "USD", hourlyRateCents: 12_000, incrementMinutes: 0 });
  await h.service.saveTaxRule(ADMIN, { label: "Sales tax", rateBasisPoints: 1000 });
  h.store.addTicket("t1", "TIX-000001", h.northwind);
  await h.service.log(AGENT, { ticketId: "t1", workDate: MONDAY, minutes: 60, billable: true });

  const issued = await h.service.invoice(ADMIN, { clientId: h.northwind, from: MONDAY, to: MONDAY });
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  const invoice = issued.value[0];
  assert.equal(invoice.totals.amountCents, 12_000);
  assert.equal(invoice.tax?.taxCents, 1_200);
  assert.equal(invoice.totalCents, 13_200);

  // The reason is the point: a credit note is an explanation as much as an amount.
  const unexplained = await h.service.creditNote(ADMIN, { invoiceRef: invoice.ref, amountCents: 1_000, reason: "hm" });
  assert.equal(unexplained.ok, false);

  const partial = await h.service.creditNote(ADMIN, {
    invoiceRef: invoice.ref,
    amountCents: 3_200,
    reason: "The first visit was logged twice.",
  });
  assert.equal(partial.ok, true);
  if (!partial.ok) return;
  assert.match(partial.value.ref, /^CN-20260921-/);

  // The ledger reports what is still owed, not just what was charged.
  const standing = await h.service.issued(ADMIN, invoice.ref);
  assert.equal(standing.ok, true);
  if (standing.ok) {
    assert.equal(standing.value.creditedCents, 3_200);
    assert.equal(standing.value.outstandingCents, 10_000);
    assert.equal(standing.value.creditNotes.length, 1);
  }

  // Crediting more than is left is refused, and says how much is left.
  const over = await h.service.creditNote(ADMIN, { invoiceRef: invoice.ref, amountCents: 20_000, reason: "Everything, please." });
  assert.equal(over.ok, false);
  if (!over.ok) assert.match(over.error, /100\.00 USD is left/);

  // And the entries are untouched: the credit is new money moving, not an edit.
  const entries = await h.service.entries(ADMIN, { invoiceRef: invoice.ref });
  assert.equal(entries.ok && entries.value[0].minutes, 60, "history stays where it is");
  assert.equal((await h.service.correct(ADMIN, entries.ok ? entries.value[0].id : "", { minutes: 30 })).ok, false);

  const notes = await h.service.creditNotes(ADMIN, invoice.ref);
  assert.equal(notes.ok && notes.value.length, 1);

  const events = h.audit.snapshot().events.filter((event) => event.action === "time.credit_note.issue");
  assert.equal(events.length, 1);
  assert.equal(events[0].detail?.outstandingAfterCents, 10_000);
});

test("an invoice in a period draws down the retainer that covers it, and only in its own currency", async () => {
  const h = await harness();
  await h.service.saveRateCard(ADMIN, { clientId: h.northwind, name: "Northwind standard", currency: "USD", hourlyRateCents: 12_000, incrementMinutes: 0 });
  h.store.addTicket("t1", "TIX-000001", h.northwind);
  await h.service.log(AGENT, { ticketId: "t1", workDate: MONDAY, minutes: 300, billable: true });

  const funded = await h.service.saveRetainer(ADMIN, {
    clientId: h.northwind,
    currency: "USD",
    fundedCents: 100_000,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    note: "September block",
  });
  assert.equal(funded.ok, true);
  if (!funded.ok) return;

  // The same client, twice, for the same period: two retainers is two balances.
  const duplicate = await h.service.saveRetainer(ADMIN, {
    clientId: h.northwind,
    currency: "USD",
    fundedCents: 50_000,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.match(duplicate.error, /already has a retainer/);

  const issued = await h.service.invoice(ADMIN, { clientId: h.northwind, from: MONDAY, to: MONDAY });
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  // 300 minutes at $120/hour is $600, and the $1,000 retainer absorbs all of it.
  assert.equal(issued.value[0].totalCents, 60_000);
  assert.equal(issued.value[0].retainer?.drawnCents, 60_000);
  assert.equal(issued.value[0].retainer?.remainingCents, 40_000);

  const view = await h.service.retainers(ADMIN, h.northwind);
  assert.equal(view.ok, true);
  if (view.ok) {
    assert.equal(view.value[0].standing.drawnCents, 60_000);
    assert.equal(view.value[0].standing.remainingCents, 40_000);
    assert.equal(view.value[0].standing.usedPercent, 60);
  }

  // An agent who does not serve the client cannot read their money.
  const denied = await h.service.retainers(AGENT, h.contoso);
  assert.equal(denied.ok, false);

  const events = h.audit.snapshot().events.filter((event) => event.action === "retainer.create");
  assert.equal(events.length, 1);
  assert.equal(events[0].detail?.fundedCents, 100_000);
});

test("a period in two currencies issues two invoices rather than one impossible total", async () => {
  const h = await harness();
  await h.service.saveRateCard(ADMIN, { clientId: h.northwind, name: "Northwind USD", currency: "USD", hourlyRateCents: 12_000, incrementMinutes: 0 });
  h.store.addTicket("t1", "TIX-000001", h.northwind);
  h.store.addTicket("t2", "TIX-000002", h.northwind);
  await h.service.log(AGENT, { ticketId: "t1", workDate: MONDAY, minutes: 60, billable: true });

  // The second hour was priced in euros — a different card, a different desk.
  await h.service.saveRateCard(ADMIN, { clientId: h.contoso, name: "Contoso EUR", currency: "EUR", hourlyRateCents: 10_000, incrementMinutes: 0 });
  const euroEntry = await h.service.log(AGENT, { ticketId: "t2", workDate: MONDAY, minutes: 60, billable: false });
  assert.equal(euroEntry.ok, true);
  if (!euroEntry.ok) return;
  // Re-price it by hand: the point of the test is the currency, not the route in.
  h.store.updateEntry({ ...euroEntry.value, billable: true, currency: "EUR", rateCentsPerHour: 10_000, billedMinutes: 60, rateIncrementMinutes: 0 });

  const issued = await h.service.invoice(ADMIN, { clientId: h.northwind, from: MONDAY, to: MONDAY });
  assert.equal(issued.ok, true);
  if (!issued.ok) return;

  assert.equal(issued.value.length, 2, "one invoice per currency");
  const byCurrency = new Map(issued.value.map((invoice) => [invoice.totals.currency, invoice]));
  assert.equal(byCurrency.get("USD")?.totals.amountCents, 12_000);
  assert.equal(byCurrency.get("EUR")?.totals.amountCents, 10_000);
  assert.notEqual(byCurrency.get("USD")?.ref, byCurrency.get("EUR")?.ref);

  // Each document carries only its own currency's lines and its own total.
  for (const invoice of issued.value) {
    assert.equal(invoice.totals.mixedCurrencies, false);
    assert.ok(invoice.lines.every((line) => line.currency === invoice.totals.currency));
  }

  // And a currency filter issues one document for one currency.
  h.store.addTicket("t3", "TIX-000003", h.northwind);
  assert.equal((await h.service.log(AGENT, { ticketId: "t3", workDate: MONDAY, minutes: 30, billable: true })).ok, true);
  const eurOnly = await h.service.invoice(ADMIN, { clientId: h.northwind, from: MONDAY, to: MONDAY, currency: "USD" });
  assert.equal(eurOnly.ok && eurOnly.value.length, 1);

  const exports = h.audit.snapshot().events.filter((event) => event.action === "time.invoice.export");
  assert.equal(exports.length, 3);
  assert.equal(exports.filter((event) => event.detail?.currency === "EUR").length, 1);
});

test("the CSV states labour, tax and the amount due in that order, as decimals", async () => {
  const h = await harness();
  await h.service.saveRateCard(ADMIN, { clientId: h.northwind, name: "Northwind standard", currency: "USD", hourlyRateCents: 12_000, incrementMinutes: 0 });
  await h.service.saveTaxRule(ADMIN, { label: "Sales tax", rateBasisPoints: 825 });
  h.store.addTicket("t1", "TIX-000001", h.northwind);
  await h.service.log(AGENT, { ticketId: "t1", workDate: MONDAY, minutes: 60, billable: true });

  const issued = await h.service.invoice(ADMIN, { clientId: h.northwind, from: MONDAY, to: MONDAY });
  assert.equal(issued.ok, true);
  if (!issued.ok) return;

  const csv = buildInvoiceCsv(issued.value[0], { generatedAt: NOW, clientName: "Northwind" });
  assert.ok(csv.includes("Subtotal,,,USD,60,1.00,120.00,1"));
  assert.ok(csv.includes("Tax,Sales tax (8.25%),,,,,9.90"));
  assert.ok(csv.includes("Amount due,,,USD,,,129.90"));
  assert.ok(!csv.includes("$"), "money stays a decimal for the spreadsheet");
});
