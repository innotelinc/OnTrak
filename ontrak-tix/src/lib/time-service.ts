/**
 * Time and billing service (M4): logging hours, pricing them, and issuing an
 * invoice-ready export that cannot be billed twice.
 *
 * The rules live in `time-rules.ts`; this layer is the one that decides who may
 * do what, snapshots the price onto the entry, and writes the audit events. Two
 * design points are worth stating because they are the difference between a
 * timesheet and a bill:
 *
 *  - **Logging snapshots the rate.** The card in force at the moment of logging
 *    is resolved once and written onto the entry (minutes charged, rate,
 *    currency), so a change to a rate card never restates past work.
 *  - **Issuing an invoice stamps what it included.** `invoice()` refuses to
 *    re-bill an entry that is already on one, marks every entry it includes with
 *    the reference, and records the totals on the audit chain. The CSV at
 *    `/time/export?ref=…` is then a *read* of an issued invoice, not a second
 *    chance to issue it.
 */

import { randomUUID } from "node:crypto";

import { hasPermission, type Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  activeRetainer,
  creditNoteDecision,
  creditNoteRefFor,
  creditedTotal,
  resolveTaxRule,
  retainerDrawdown,
  retainerStanding,
  taxCentsFor,
  taxForInvoice,
  validateCreditNote,
  validateRetainer,
  validateTaxRule,
  type CreditNoteRecord,
  type RetainerRecord,
  type RetainerStanding,
  type TaxRuleRecord,
} from "./billing-rules";
import type { ClientService } from "./client-service";
import { scopeByClient } from "./client-rules";
import type { ServiceResult } from "./ticket-service";
import {
  billableSplit,
  billedMinutes,
  entryAmountCents,
  invoiceLines,
  invoiceRefFor,
  invoiceTotals,
  resolveRateCard,
  timeEntryDecision,
  validateRateCard,
  validateTimeEntry,
  type BillableSplit,
  type Invoice,
  type InvoiceLine,
  type InvoiceTotals,
  type RateCardRecord,
  type TimeEntryRecord,
} from "./time-rules";

/** `undefined` means "no filter"; `null` means "the work with no client on it". */
export interface TimeFilters {
  clientId?: string | null;
  ticketId?: string;
  userId?: string;
  /** Inclusive `YYYY-MM-DD` bounds on the day the work happened. */
  from?: string;
  to?: string;
  invoiceRef?: string;
  /** Entries an invoice drew from one retainer. */
  retainerId?: string;
}

export interface TimeStore {
  /** Enough of a ticket to price its time: its reference and its client. */
  findTicket(tenantId: string, ticketId: string): Promise<{ ref: string; clientId: string | null } | null>;
  listEntries(tenantId: string, filters?: TimeFilters): Promise<TimeEntryRecord[]>;
  findEntry(tenantId: string, entryId: string): Promise<TimeEntryRecord | null>;
  insertEntry(record: TimeEntryRecord): Promise<void>;
  updateEntry(record: TimeEntryRecord): Promise<void>;
  removeEntry(tenantId: string, entryId: string): Promise<void>;

  listRateCards(tenantId: string): Promise<RateCardRecord[]>;
  insertRateCard(record: RateCardRecord): Promise<void>;
  updateRateCard(record: RateCardRecord): Promise<void>;
  removeRateCard(tenantId: string, cardId: string): Promise<void>;

  listTaxRules(tenantId: string): Promise<TaxRuleRecord[]>;
  insertTaxRule(record: TaxRuleRecord): Promise<void>;
  updateTaxRule(record: TaxRuleRecord): Promise<void>;
  removeTaxRule(tenantId: string, ruleId: string): Promise<void>;

  listCreditNotes(tenantId: string, invoiceRef?: string): Promise<CreditNoteRecord[]>;
  insertCreditNote(record: CreditNoteRecord): Promise<void>;

  listRetainers(tenantId: string, clientId?: string): Promise<RetainerRecord[]>;
  insertRetainer(record: RetainerRecord): Promise<void>;
  removeRetainer(tenantId: string, retainerId: string): Promise<void>;
}

export interface TimeIds {
  id(): string;
  now(): string;
}

export function systemTimeIds(): TimeIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

/** What a person logs. `clientId` is derived from the ticket when it is not given. */
export interface TimeEntryInput {
  ticketId?: string | null;
  clientId?: string | null;
  workDate: string;
  minutes: number | string;
  billable: boolean;
  note?: string | null;
}

export interface RateCardInput {
  clientId?: string | null;
  name: string;
  currency: string;
  hourlyRateCents: number | string;
  incrementMinutes: number | string;
}

export interface TaxRuleInput {
  clientId?: string | null;
  label: string;
  /** Basis points, so 8.25% arrives as `825`. */
  rateBasisPoints: number | string;
}

export interface RetainerInput {
  clientId: string;
  currency: string;
  fundedCents: number | string;
  periodStart: string;
  periodEnd: string;
  note?: string | null;
}

/** A client's retainer with its balance derived from the ledger. */
export interface RetainerView {
  retainer: RetainerRecord;
  standing: RetainerStanding;
}

/** An issued invoice with what has been credited against it since. */
export interface InvoiceStanding {
  invoice: Invoice;
  creditNotes: CreditNoteRecord[];
  creditedCents: number;
  /** What the invoice still owes after its credit notes. */
  outstandingCents: number;
}

export class TimeService {
  constructor(
    private readonly store: TimeStore,
    private readonly clients: ClientService,
    private readonly audit: AuditSink | null = null,
    private readonly ids: TimeIds = systemTimeIds(),
  ) {}

  /* ------------------------------------------------------------ rate cards */

  /** Every card in the tenant: the desk's default and each client's own. */
  async rateCards(actor: Actor): Promise<ServiceResult<RateCardRecord[]>> {
    if (!hasPermission(actor.role, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to the desk's rates." };
    }
    return { ok: true, value: await this.store.listRateCards(actor.tenantId) };
  }

  /** Which card applies to a client, and why — the same answer the invoice uses. */
  async rateCardFor(actor: Actor, clientId: string | null): Promise<ServiceResult<ReturnType<typeof resolveRateCard>>> {
    const cards = await this.rateCards(actor);
    if (!cards.ok) return cards;
    return { ok: true, value: resolveRateCard({ cards: cards.value, clientId }) };
  }

  /**
   * Write a client's card (or the desk's default). One card per client, so
   * saving replaces rather than accumulating: the service decides that, because
   * a nullable column cannot carry a uniqueness constraint.
   */
  async saveRateCard(actor: Actor, input: RateCardInput): Promise<ServiceResult<RateCardRecord>> {
    const denied = this.billableBy(actor);
    if (denied) return denied;

    // The client id comes from a form. A card for a client that does not exist
    // would price nothing and be shown nowhere, so it is refused here rather
    // than discovered later as a row nobody can explain.
    if (input.clientId) {
      const known = await this.clients.list(actor);
      if (!known.ok) return known;
      if (!known.value.some((entry) => entry.client.id === input.clientId)) {
        return { ok: false, error: "Client not found." };
      }
    }

    const card: RateCardRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      clientId: input.clientId ?? null,
      name: (input.name ?? "").trim(),
      currency: (input.currency ?? "").trim().toUpperCase(),
      hourlyRateCents: toNumber(input.hourlyRateCents),
      incrementMinutes: toNumber(input.incrementMinutes),
      updatedAt: this.ids.now(),
    };

    const issues = validateRateCard(card);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const existing = await this.store.listRateCards(actor.tenantId);
    const sameClient = existing.find((other) => other.clientId === card.clientId);
    const saved: RateCardRecord = sameClient ? { ...card, id: sameClient.id } : card;

    if (sameClient) await this.store.updateRateCard(saved);
    else await this.store.insertRateCard(saved);

    await this.append(actor, "rate.card.save", "rate-card", saved.id, {
      clientId: saved.clientId,
      name: saved.name,
      currency: saved.currency,
      hourlyRateCents: saved.hourlyRateCents,
      incrementMinutes: saved.incrementMinutes,
    });
    return { ok: true, value: saved };
  }

  /** A card may go: entries keep their own snapshot of the price. */
  async removeRateCard(actor: Actor, cardId: string): Promise<ServiceResult<RateCardRecord>> {
    const denied = this.billableBy(actor);
    if (denied) return denied;

    const cards = await this.store.listRateCards(actor.tenantId);
    const card = cards.find((candidate) => candidate.id === cardId);
    if (!card) return { ok: false, error: "That rate card is not on this desk." };

    await this.store.removeRateCard(actor.tenantId, cardId);
    await this.append(actor, "rate.card.delete", "rate-card", cardId, {
      clientId: card.clientId,
      name: card.name,
    });
    return { ok: true, value: card };
  }

  /* ---------------------------------------------------------------- the log */

  /** Log time against a ticket, or against the desk when there is no ticket. */
  async log(actor: Actor, input: TimeEntryInput): Promise<ServiceResult<TimeEntryRecord>> {
    if (!hasPermission(actor.role, "ticket:update")) {
      return { ok: false, error: "You do not log time." };
    }

    const ticketId = input.ticketId?.trim() ? input.ticketId.trim() : null;
    let ticketRef: string | null = null;
    let clientId = input.clientId ?? null;

    if (ticketId) {
      const ticket = await this.store.findTicket(actor.tenantId, ticketId);
      if (!ticket) return { ok: false, error: "That ticket is not on this desk." };
      ticketRef = ticket.ref;
      // The ticket's client wins over a hand-passed one: the work is for whoever
      // the ticket is for, and a form cannot reassign the bill by mistake.
      clientId = ticket.clientId ?? clientId;
    }

    // Time is scoped like everything else: an agent cannot log hours against a
    // client they do not serve, whether they named it or reached it through a
    // ticket id they guessed.
    if (clientId && !(await this.clients.canSee(actor, clientId))) {
      return { ok: false, error: "That client's work is not yours to log time against." };
    }

    const minutes = toNumber(input.minutes);
    const issues = validateTimeEntry({ workDate: input.workDate, minutes, note: input.note ?? null });
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    // Resolve the price once, here, and write it down. This is the whole point of
    // the snapshot: the invoice is a record of what was agreed, not of what the
    // rate card says today.
    const cards = await this.store.listRateCards(actor.tenantId);
    const resolution = resolveRateCard({ cards, clientId });
    const card = resolution.card;
    const now = this.ids.now();

    const entry: TimeEntryRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      ticketId,
      ticketRef,
      clientId,
      userId: actor.id,
      workDate: input.workDate,
      minutes,
      billedMinutes: input.billable && card ? billedMinutes(minutes, card.incrementMinutes) : null,
      billable: input.billable,
      rateCardId: card?.id ?? null,
      rateCentsPerHour: card?.hourlyRateCents ?? null,
      rateIncrementMinutes: card?.incrementMinutes ?? null,
      currency: card?.currency ?? null,
      note: input.note?.trim() ? input.note.trim() : null,
      invoicedAt: null,
      invoiceRef: null,
      taxCents: null,
      taxRateBasisPoints: null,
      retainerId: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.insertEntry(entry);
    await this.append(actor, "time.log", "time-entry", entry.id, {
      ticketRef,
      clientId,
      minutes: entry.minutes,
      billedMinutes: entry.billedMinutes,
      billable: entry.billable,
      rateCardId: entry.rateCardId,
      because: resolution.because,
    });

    // Billable work with no card still logs — the desk did the work whether or
    // not it has agreed a price. It carries no rate, so the invoice skips it and
    // `billableSplit().unpriced` counts it: an unpriced hour is a problem to fix,
    // not a free hour nobody mentioned.
    return { ok: true, value: entry };
  }

  /** The desk's time, scoped by the client scope the actor already works under. */
  async entries(actor: Actor, filters: TimeFilters = {}): Promise<ServiceResult<TimeEntryRecord[]>> {
    if (!hasPermission(actor.role, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to the desk's time." };
    }
    const scope = await this.clients.scope(actor);
    const rows = await this.store.listEntries(actor.tenantId, filters);
    return { ok: true, value: scopeByClient(scope, rows) };
  }

  /** Utilisation over the entries an actor may see. */
  async split(actor: Actor, filters: TimeFilters = {}): Promise<ServiceResult<BillableSplit>> {
    const entries = await this.entries(actor, filters);
    if (!entries.ok) return entries;
    return { ok: true, value: billableSplit(entries.value) };
  }

  async correct(
    actor: Actor,
    entryId: string,
    change: { minutes?: number | string; note?: string | null; billable?: boolean },
  ): Promise<ServiceResult<TimeEntryRecord>> {
    const entry = await this.own(actor, entryId);
    if (!entry.ok) return entry;

    const minutes = change.minutes === undefined ? entry.value.minutes : toNumber(change.minutes);
    const note = change.note === undefined ? entry.value.note : (change.note?.trim() ? change.note.trim() : null);

    const issues = validateTimeEntry({ workDate: entry.value.workDate, minutes, note });
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    // A correction moves what the desk got wrong (the minutes, the note, whether
    // it was chargeable) and nothing else. The rate and the rounding were
    // snapshotted when the work was logged, so re-deriving the charge from the
    // snapshot — rather than from today's card — is what keeps an invoice and a
    // timesheet telling the same story. Re-pricing is not a correction: an entry
    // logged before its card existed should be removed and logged again.
    const billable = (change.billable ?? entry.value.billable) && entry.value.rateCentsPerHour !== null;
    const next: TimeEntryRecord = {
      ...entry.value,
      minutes,
      note,
      billable,
      billedMinutes:
        billable && entry.value.rateCentsPerHour !== null
          ? billedMinutes(minutes, entry.value.rateIncrementMinutes ?? 0)
          : null,
      updatedAt: this.ids.now(),
    };

    await this.store.updateEntry(next);
    await this.append(actor, "time.correct", "time-entry", next.id, {
      minutes: next.minutes,
      billedMinutes: next.billedMinutes,
      billable: next.billable,
    });
    return { ok: true, value: next };
  }

  async remove(actor: Actor, entryId: string): Promise<ServiceResult<TimeEntryRecord>> {
    const entry = await this.own(actor, entryId);
    if (!entry.ok) return entry;

    await this.store.removeEntry(actor.tenantId, entryId);
    await this.append(actor, "time.delete", "time-entry", entryId, {
      ticketRef: entry.value.ticketRef ?? null,
      minutes: entry.value.minutes,
    });
    return { ok: true, value: entry.value };
  }

  /* ------------------------------------------------------------ tax rules */

  async taxRules(actor: Actor): Promise<ServiceResult<TaxRuleRecord[]>> {
    if (!hasPermission(actor.role, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to the desk's tax rules." };
    }
    return { ok: true, value: await this.store.listTaxRules(actor.tenantId) };
  }

  /** Which rule applies to a client, and why — the same answer the invoice uses. */
  async taxRuleFor(actor: Actor, clientId: string | null): Promise<ServiceResult<ReturnType<typeof resolveTaxRule>>> {
    const rules = await this.taxRules(actor);
    if (!rules.ok) return rules;
    return { ok: true, value: resolveTaxRule({ rules: rules.value, clientId }) };
  }

  /** Write a client's rule, or the desk's default. One per owner, like a rate card. */
  async saveTaxRule(actor: Actor, input: TaxRuleInput): Promise<ServiceResult<TaxRuleRecord>> {
    const denied = this.billableBy(actor);
    if (denied) return denied;

    if (input.clientId) {
      const known = await this.clients.list(actor);
      if (!known.ok) return known;
      if (!known.value.some((entry) => entry.client.id === input.clientId)) {
        return { ok: false, error: "Client not found." };
      }
    }

    const candidate: TaxRuleRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      clientId: input.clientId ?? null,
      label: (input.label ?? "").trim(),
      rateBasisPoints: toNumber(input.rateBasisPoints),
      updatedAt: this.ids.now(),
    };

    const issues = validateTaxRule(candidate);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const existing = (await this.store.listTaxRules(actor.tenantId)).find(
      (rule) => rule.clientId === candidate.clientId,
    );
    const saved: TaxRuleRecord = existing ? { ...candidate, id: existing.id } : candidate;

    if (existing) await this.store.updateTaxRule(saved);
    else await this.store.insertTaxRule(saved);

    await this.append(actor, "tax.rule.save", "tax-rule", saved.id, {
      clientId: saved.clientId,
      label: saved.label,
      rateBasisPoints: saved.rateBasisPoints,
      previousRateBasisPoints: existing?.rateBasisPoints ?? null,
    });
    return { ok: true, value: saved };
  }

  /**
   * Remove a rule. Entries keep the rate they were charged at, so nothing needs
   * re-pricing — the only effect is on invoices not yet issued.
   */
  async removeTaxRule(actor: Actor, ruleId: string): Promise<ServiceResult<TaxRuleRecord>> {
    const denied = this.billableBy(actor);
    if (denied) return denied;

    const rule = (await this.store.listTaxRules(actor.tenantId)).find((candidate) => candidate.id === ruleId);
    if (!rule) return { ok: false, error: "That tax rule is not on this desk." };

    await this.store.removeTaxRule(actor.tenantId, ruleId);
    await this.append(actor, "tax.rule.delete", "tax-rule", ruleId, {
      clientId: rule.clientId,
      label: rule.label,
      rateBasisPoints: rule.rateBasisPoints,
    });
    return { ok: true, value: rule };
  }

  /* -------------------------------------------------------------- retainers */

  /** A client's retainers, each with its balance derived from the entries drawn. */
  async retainers(actor: Actor, clientId: string): Promise<ServiceResult<RetainerView[]>> {
    if (!hasPermission(actor.role, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to the desk's retainers." };
    }
    if (!(await this.clients.canSee(actor, clientId))) {
      return { ok: false, error: "That client's accounts are not yours to read." };
    }

    const [rows, entries] = await Promise.all([
      this.store.listRetainers(actor.tenantId, clientId),
      this.store.listEntries(actor.tenantId, { clientId }),
    ]);

    return {
      ok: true,
      value: rows.map((retainer) => ({
        retainer,
        standing: retainerStanding({
          fundedCents: retainer.fundedCents,
          drawnCents: entries
            .filter((entry) => entry.retainerId === retainer.id)
            .reduce((sum, entry) => sum + (entryAmountCents(entry) ?? 0) + (entry.taxCents ?? 0), 0),
        }),
      })),
    };
  }

  /** Record money a client paid up front. */
  async saveRetainer(actor: Actor, input: RetainerInput): Promise<ServiceResult<RetainerRecord>> {
    const denied = this.billableBy(actor);
    if (denied) return denied;
    if (!input.clientId) return { ok: false, error: "Choose the client the retainer is for." };

    const known = await this.clients.list(actor);
    if (!known.ok) return known;
    if (!known.value.some((entry) => entry.client.id === input.clientId)) {
      return { ok: false, error: "Client not found." };
    }

    const candidate: RetainerRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      clientId: input.clientId,
      currency: (input.currency ?? "").trim().toUpperCase(),
      fundedCents: toNumber(input.fundedCents),
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      note: input.note?.trim() ? input.note.trim() : null,
      createdBy: actor.id,
      createdAt: this.ids.now(),
    };

    const issues = validateRetainer(candidate);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const existing = (await this.store.listRetainers(actor.tenantId, candidate.clientId)).find(
      (retainer) => retainer.periodStart === candidate.periodStart && retainer.periodEnd === candidate.periodEnd,
    );
    if (existing) {
      return { ok: false, error: `That client already has a retainer for ${candidate.periodStart} → ${candidate.periodEnd}.` };
    }

    await this.store.insertRetainer(candidate);
    await this.append(actor, "retainer.create", "retainer", candidate.id, {
      clientId: candidate.clientId,
      currency: candidate.currency,
      fundedCents: candidate.fundedCents,
      periodStart: candidate.periodStart,
      periodEnd: candidate.periodEnd,
    });
    return { ok: true, value: candidate };
  }

  /* -------------------------------------------------------------- invoicing */

  /**
   * Issue an invoice for a client's uninvoiced time in a period, and mark every
   * entry it covers. Refuses when there is nothing to bill, so a stray click
   * cannot issue an empty invoice with a reference on the record.
   *
   * **One invoice per currency.** A total that adds dollars to euros is not a
   * total, so entries are grouped by the currency they were priced in and each
   * group is issued its own reference — the same period can produce two invoices
   * for one client, and the record says why rather than printing a number that
   * cannot be paid.
   */
  async invoice(
    actor: Actor,
    input: { clientId?: string | null; from: string; to: string; currency?: string | null },
  ): Promise<ServiceResult<Invoice[]>> {
    const denied = this.billableBy(actor);
    if (denied) return denied;

    if (!input.from || !input.to || input.from > input.to) {
      return { ok: false, error: "Give the period as two dates, from and to." };
    }

    const clientId = input.clientId ?? null;
    const all = await this.store.listEntries(actor.tenantId, { clientId, from: input.from, to: input.to });
    const alreadyInvoiced = all.filter((entry) => entry.invoicedAt !== null).length;
    const nonBillable = all.filter((entry) => !entry.billable).length;
    const billable = all
      .filter((entry) => entry.billable && entry.invoicedAt === null && entryAmountCents(entry) !== null)
      .filter((entry) => !input.currency || entry.currency === input.currency);
    const unpriced = all.filter(
      (entry) => entry.billable && entry.invoicedAt === null && entryAmountCents(entry) === null,
    ).length;

    if (billable.length === 0) {
      const why = alreadyInvoiced > 0 ? "All of it is already on an invoice." : "Nothing billable was logged in that period.";
      return { ok: false, error: `${why} Nothing was issued.` };
    }

    const now = this.ids.now();
    const taxRule = resolveTaxRule({ rules: await this.store.listTaxRules(actor.tenantId), clientId }).rule;

    // The retainer that covers the period, and what is left of it. Resolved once,
    // before anything is written, so two invoices in the same call cannot both
    // draw down a balance only one of them can see.
    const retainer = clientId ? activeRetainer(await this.store.listRetainers(actor.tenantId, clientId), clientId, input.from) : null;
    let retainerRemaining = 0;
    if (retainer) {
      const drawn = (await this.store.listEntries(actor.tenantId, { clientId, retainerId: retainer.id })).reduce(
        (sum, entry) => sum + (entryAmountCents(entry) ?? 0) + (entry.taxCents ?? 0),
        0,
      );
      retainerRemaining = retainerStanding({ fundedCents: retainer.fundedCents, drawnCents: drawn }).remainingCents;
    }

    const currencies = [...new Set(billable.map((entry) => entry.currency))].sort((a, b) => (a ?? "").localeCompare(b ?? ""));
    const issued: Invoice[] = [];

    for (const currency of currencies) {
      const group = billable.filter((entry) => entry.currency === currency);
      const lines = invoiceLines(group);
      if (lines.length === 0) continue;

      const ref = invoiceRefFor(this.ids.id(), now);
      const totals = invoiceTotals(lines);
      const tax = taxForInvoice({ amountCents: totals.amountCents, rule: taxRule });
      const totalCents = tax ? tax.totalCents : totals.amountCents;

      // A retainer is money in one currency, so it only ever draws down the
      // invoice denominated in it.
      const drawn =
        retainer && retainer.currency === currency
          ? retainerDrawdown({ invoiceCents: totalCents, remainingCents: retainerRemaining })
          : 0;
      if (drawn > 0) retainerRemaining -= drawn;

      for (const entry of group) {
        const amount = entryAmountCents(entry) ?? 0;
        await this.store.updateEntry({
          ...entry,
          invoicedAt: now,
          invoiceRef: ref,
          taxCents: tax ? taxCentsFor(amount, tax.rateBasisPoints) : null,
          taxRateBasisPoints: tax ? tax.rateBasisPoints : null,
          retainerId: drawn > 0 && retainer ? retainer.id : null,
          updatedAt: now,
        });
      }

      const invoice: Invoice = {
        ref,
        clientId,
        from: input.from,
        to: input.to,
        issuedAt: now,
        issuedBy: actor.id,
        lines,
        totals,
        tax,
        totalCents,
        retainer:
          drawn > 0 && retainer
            ? { id: retainer.id, currency: retainer.currency, drawnCents: drawn, remainingCents: retainerRemaining }
            : null,
        skipped: { alreadyInvoiced, unpriced, nonBillable },
      };
      issued.push(invoice);

      await this.append(actor, "time.invoice.export", "invoice", ref, {
        clientId,
        from: input.from,
        to: input.to,
        currency,
        amountCents: totals.amountCents,
        taxCents: tax?.taxCents ?? 0,
        taxLabel: tax?.label ?? null,
        taxRateBasisPoints: tax?.rateBasisPoints ?? null,
        totalCents,
        retainerId: invoice.retainer?.id ?? null,
        retainerDrawnCents: invoice.retainer?.drawnCents ?? 0,
        billedMinutes: totals.billedMinutes,
        entries: group.length,
        skipped: { alreadyInvoiced, unpriced, nonBillable },
      });
    }

    if (issued.length === 0) return { ok: false, error: "Nothing billable was logged in that period. Nothing was issued." };
    return { ok: true, value: issued };
  }

  /** Read an invoice that was already issued, by its reference. */
  async issued(actor: Actor, ref: string): Promise<ServiceResult<InvoiceStanding>> {
    if (!hasPermission(actor.role, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to the desk's invoices." };
    }

    const entries = await this.store.listEntries(actor.tenantId, { invoiceRef: ref });
    if (entries.length === 0) return { ok: false, error: "No invoice carries that reference." };

    const lines = invoiceLines(entries);
    const clientIds = [...new Set(entries.map((entry) => entry.clientId))];
    const totals = invoiceTotals(lines);

    // Tax is read back off the entries, not recomputed: the rate that applied is
    // the one that was charged, whatever today's rule says.
    const taxCents = entries.reduce((sum, entry) => sum + (entry.taxCents ?? 0), 0);
    const rate = entries.find((entry) => entry.taxRateBasisPoints !== null)?.taxRateBasisPoints ?? null;
    const tax =
      rate === null
        ? null
        : {
            label: (await this.store.listTaxRules(actor.tenantId)).find((rule) => rule.rateBasisPoints === rate)?.label ?? "Tax",
            rateBasisPoints: rate,
            baseCents: totals.amountCents,
            taxCents,
            totalCents: totals.amountCents + taxCents,
          };

    const retainerId = entries.find((entry) => entry.retainerId !== null)?.retainerId ?? null;
    const retainer = retainerId
      ? {
          id: retainerId,
          currency: entries[0].currency ?? "",
          drawnCents: totals.amountCents + taxCents,
          remainingCents: 0,
        }
      : null;

    const invoice: Invoice = {
      ref,
      clientId: clientIds.length === 1 ? clientIds[0] : null,
      from: entries.map((entry) => entry.workDate).sort()[0] ?? null,
      to: entries.map((entry) => entry.workDate).sort().at(-1) ?? null,
      issuedAt: entries.map((entry) => entry.invoicedAt).sort()[0] ?? this.ids.now(),
      lines,
      totals,
      tax,
      totalCents: totals.amountCents + taxCents,
      retainer,
      skipped: { alreadyInvoiced: 0, unpriced: 0, nonBillable: 0 },
    };

    const creditNotes = await this.store.listCreditNotes(actor.tenantId, ref);
    const creditedCents = creditedTotal(creditNotes, ref);
    return {
      ok: true,
      value: { invoice, creditNotes, creditedCents, outstandingCents: invoice.totalCents! - creditedCents },
    };
  }

  /* ---------------------------------------------------------- credit notes */

  /**
   * Credit an issued invoice. The only remedy there is: the entries stay where
   * they are, and money moves back with a reason on the record.
   */
  async creditNote(
    actor: Actor,
    input: { invoiceRef: string; amountCents: number | string; reason: string },
  ): Promise<ServiceResult<CreditNoteRecord>> {
    const denied = this.billableBy(actor);
    if (denied) return denied;

    const invoiceRef = (input.invoiceRef ?? "").trim();
    const read = await this.issued(actor, invoiceRef);
    if (!read.ok) return read;

    const amountCents = toNumber(input.amountCents);
    const issues = validateCreditNote({ amountCents, reason: input.reason });
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const invoiceCents = read.value.invoice.totalCents ?? read.value.invoice.totals.amountCents;
    const decision = creditNoteDecision({
      amountCents,
      invoiceCents,
      alreadyCreditedCents: read.value.creditedCents,
      currency: read.value.invoice.totals.currency ?? "",
    });
    if (!decision.allowed) return { ok: false, error: decision.reason };

    const now = this.ids.now();
    const record: CreditNoteRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      ref: creditNoteRefFor(this.ids.id(), now),
      invoiceRef,
      clientId: read.value.invoice.clientId,
      currency: read.value.invoice.totals.currency ?? "",
      amountCents,
      reason: input.reason.trim(),
      issuedBy: actor.id,
      issuedAt: now,
    };

    await this.store.insertCreditNote(record);
    await this.append(actor, "time.credit_note.issue", "credit-note", record.id, {
      ref: record.ref,
      invoiceRef,
      amountCents,
      currency: record.currency,
      reason: record.reason,
      outstandingAfterCents: decision.remainingCents,
    });
    return { ok: true, value: record };
  }

  /** Credit notes against an invoice, or every note the desk has issued. */
  async creditNotes(actor: Actor, invoiceRef?: string): Promise<ServiceResult<CreditNoteRecord[]>> {
    if (!hasPermission(actor.role, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to the desk's credit notes." };
    }
    return { ok: true, value: await this.store.listCreditNotes(actor.tenantId, invoiceRef) };
  }

  /** Every invoice reference the tenant has issued, newest first. */
  async invoices(
    actor: Actor,
  ): Promise<
    ServiceResult<
      { ref: string; entries: number; amountCents: number; taxCents: number; totalCents: number; currency: string | null; issuedAt: string; creditedCents: number }[]
    >
  > {
    const entries = await this.entries(actor);
    if (!entries.ok) return entries;

    const notes = await this.store.listCreditNotes(actor.tenantId);
    const grouped = new Map<
      string,
      { ref: string; entries: number; amountCents: number; taxCents: number; totalCents: number; currency: string | null; issuedAt: string; creditedCents: number }
    >();
    for (const entry of entries.value) {
      if (entry.invoiceRef === null) continue;
      const current = grouped.get(entry.invoiceRef) ?? {
        ref: entry.invoiceRef,
        entries: 0,
        amountCents: 0,
        taxCents: 0,
        totalCents: 0,
        currency: entry.currency,
        issuedAt: entry.invoicedAt ?? entry.updatedAt,
        creditedCents: creditedTotal(notes, entry.invoiceRef),
      };
      current.entries += 1;
      current.amountCents += entryAmountCents(entry) ?? 0;
      current.taxCents += entry.taxCents ?? 0;
      current.totalCents = current.amountCents + current.taxCents;
      grouped.set(entry.invoiceRef, current);
    }

    return { ok: true, value: [...grouped.values()].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)) };
  }

  /* ------------------------------------------------------------- internals */

  /** Fetch an entry and decide whether this actor may change it. */
  private async own(actor: Actor, entryId: string): Promise<ServiceResult<TimeEntryRecord>> {
    const entry = await this.store.findEntry(actor.tenantId, entryId);
    if (!entry) return { ok: false, error: "That time entry is not on this desk." };

    const decision = timeEntryDecision(entry, actor);
    return decision.allowed ? { ok: true, value: entry } : { ok: false, error: decision.reason };
  }

  private billableBy(actor: Actor): { ok: false; error: string } | null {
    if (!hasPermission(actor.role, "queue:manage")) return { ok: false, error: "You do not manage what the desk charges." };
    return null;
  }

  private async append(
    actor: Actor,
    action: string,
    targetType: string,
    targetId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) return;
    const event: AuditEventInput = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      at: this.ids.now(),
      actor: actor.id,
      action,
      targetType,
      targetId,
      detail,
    };
    await this.audit.append(event);
  }
}

/** Form text arrives as a string; a blank must not read as a zero. */
function toNumber(value: number | string | undefined): number {
  if (typeof value === "number") return value;
  if (value === undefined) return Number.NaN;
  const trimmed = value.trim();
  return trimmed === "" ? Number.NaN : Number(trimmed);
}

/** An in-memory store, used by tests and local development. */
export class MemoryTimeStore implements TimeStore {
  private readonly entries = new Map<string, TimeEntryRecord>();
  private readonly cards = new Map<string, RateCardRecord>();
  private readonly tickets = new Map<string, { ref: string; clientId: string | null }>();
  private readonly taxRules = new Map<string, TaxRuleRecord>();
  private readonly creditNotes = new Map<string, CreditNoteRecord>();
  private readonly retainers = new Map<string, RetainerRecord>();

  /** Stand in for the tickets table. */
  addTicket(ticketId: string, ref: string, clientId: string | null = null): void {
    this.tickets.set(ticketId, { ref, clientId });
  }

  async findTicket(_tenantId: string, ticketId: string): Promise<{ ref: string; clientId: string | null } | null> {
    return this.tickets.get(ticketId) ?? null;
  }

  async listEntries(tenantId: string, filters: TimeFilters = {}): Promise<TimeEntryRecord[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.tenantId === tenantId)
      .filter((entry) => filters.clientId === undefined || entry.clientId === filters.clientId)
      .filter((entry) => filters.ticketId === undefined || entry.ticketId === filters.ticketId)
      .filter((entry) => filters.userId === undefined || entry.userId === filters.userId)
      .filter((entry) => filters.from === undefined || entry.workDate >= filters.from)
      .filter((entry) => filters.to === undefined || entry.workDate <= filters.to)
      .filter((entry) => filters.invoiceRef === undefined || entry.invoiceRef === filters.invoiceRef)
      .filter((entry) => filters.retainerId === undefined || entry.retainerId === filters.retainerId)
      .sort((a, b) => a.workDate.localeCompare(b.workDate) || a.createdAt.localeCompare(b.createdAt))
      .map((entry) => structuredClone(entry));
  }

  async findEntry(tenantId: string, entryId: string): Promise<TimeEntryRecord | null> {
    const found = this.entries.get(entryId);
    return found && found.tenantId === tenantId ? structuredClone(found) : null;
  }

  async insertEntry(record: TimeEntryRecord): Promise<void> {
    this.entries.set(record.id, structuredClone(record));
  }

  async updateEntry(record: TimeEntryRecord): Promise<void> {
    this.entries.set(record.id, structuredClone(record));
  }

  async removeEntry(tenantId: string, entryId: string): Promise<void> {
    const found = this.entries.get(entryId);
    if (found && found.tenantId === tenantId) this.entries.delete(entryId);
  }

  async listRateCards(tenantId: string): Promise<RateCardRecord[]> {
    return [...this.cards.values()].filter((card) => card.tenantId === tenantId).map((card) => structuredClone(card));
  }

  async insertRateCard(record: RateCardRecord): Promise<void> {
    this.cards.set(record.id, structuredClone(record));
  }

  async updateRateCard(record: RateCardRecord): Promise<void> {
    this.cards.set(record.id, structuredClone(record));
  }

  async removeRateCard(tenantId: string, cardId: string): Promise<void> {
    const found = this.cards.get(cardId);
    if (found && found.tenantId === tenantId) this.cards.delete(cardId);
  }

  async listTaxRules(tenantId: string): Promise<TaxRuleRecord[]> {
    return [...this.taxRules.values()].filter((rule) => rule.tenantId === tenantId).map((rule) => structuredClone(rule));
  }

  async insertTaxRule(record: TaxRuleRecord): Promise<void> {
    this.taxRules.set(record.id, structuredClone(record));
  }

  async updateTaxRule(record: TaxRuleRecord): Promise<void> {
    this.taxRules.set(record.id, structuredClone(record));
  }

  async removeTaxRule(tenantId: string, ruleId: string): Promise<void> {
    const found = this.taxRules.get(ruleId);
    if (found && found.tenantId === tenantId) this.taxRules.delete(ruleId);
  }

  async listCreditNotes(tenantId: string, invoiceRef?: string): Promise<CreditNoteRecord[]> {
    return [...this.creditNotes.values()]
      .filter((note) => note.tenantId === tenantId && (invoiceRef === undefined || note.invoiceRef === invoiceRef))
      .map((note) => structuredClone(note));
  }

  async insertCreditNote(record: CreditNoteRecord): Promise<void> {
    this.creditNotes.set(record.id, structuredClone(record));
  }

  async listRetainers(tenantId: string, clientId?: string): Promise<RetainerRecord[]> {
    return [...this.retainers.values()]
      .filter((retainer) => retainer.tenantId === tenantId && (clientId === undefined || retainer.clientId === clientId))
      .map((retainer) => structuredClone(retainer));
  }

  async insertRetainer(record: RetainerRecord): Promise<void> {
    this.retainers.set(record.id, structuredClone(record));
  }

  async removeRetainer(tenantId: string, retainerId: string): Promise<void> {
    const found = this.retainers.get(retainerId);
    if (found && found.tenantId === tenantId) this.retainers.delete(retainerId);
  }
}
