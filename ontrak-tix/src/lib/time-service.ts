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

  /* -------------------------------------------------------------- invoicing */

  /**
   * Issue an invoice for a client's uninvoiced time in a period, and mark every
   * entry it covers. Refuses when there is nothing to bill, so a stray click
   * cannot issue an empty invoice with a reference on the record.
   */
  async invoice(
    actor: Actor,
    input: { clientId?: string | null; from: string; to: string },
  ): Promise<ServiceResult<Invoice>> {
    const denied = this.billableBy(actor);
    if (denied) return denied;

    if (!input.from || !input.to || input.from > input.to) {
      return { ok: false, error: "Give the period as two dates, from and to." };
    }

    const clientId = input.clientId ?? null;
    const all = await this.store.listEntries(actor.tenantId, { clientId, from: input.from, to: input.to });
    const alreadyInvoiced = all.filter((entry) => entry.invoicedAt !== null).length;
    const nonBillable = all.filter((entry) => !entry.billable).length;
    const billable = all.filter((entry) => entry.billable && entry.invoicedAt === null);
    const unpriced = billable.filter((entry) => entryAmountCents(entry) === null).length;

    const lines = invoiceLines(billable);
    if (lines.length === 0) {
      const why = alreadyInvoiced > 0 ? "All of it is already on an invoice." : "Nothing billable was logged in that period.";
      return { ok: false, error: `${why} Nothing was issued.` };
    }

    const now = this.ids.now();
    const ref = invoiceRefFor(this.ids.id(), now);
    const included = billable.filter((entry) => entryAmountCents(entry) !== null);

    for (const entry of included) {
      await this.store.updateEntry({ ...entry, invoicedAt: now, invoiceRef: ref, updatedAt: now });
    }

    const totals = invoiceTotals(lines);
    await this.append(actor, "time.invoice.export", "invoice", ref, {
      clientId,
      from: input.from,
      to: input.to,
      currency: totals.currency,
      amountCents: totals.amountCents,
      billedMinutes: totals.billedMinutes,
      entries: included.length,
      skipped: { alreadyInvoiced, unpriced, nonBillable },
    });

    return {
      ok: true,
      value: {
        ref,
        clientId,
        from: input.from,
        to: input.to,
        issuedAt: now,
        issuedBy: actor.id,
        lines,
        totals,
        skipped: { alreadyInvoiced, unpriced, nonBillable },
      },
    };
  }

  /** Read an invoice that was already issued, by its reference. */
  async issued(actor: Actor, ref: string): Promise<ServiceResult<Invoice>> {
    if (!hasPermission(actor.role, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to the desk's invoices." };
    }

    const entries = await this.store.listEntries(actor.tenantId, { invoiceRef: ref });
    if (entries.length === 0) return { ok: false, error: "No invoice carries that reference." };

    const lines = invoiceLines(entries);
    const clientIds = [...new Set(entries.map((entry) => entry.clientId))];
    return {
      ok: true,
      value: {
        ref,
        clientId: clientIds.length === 1 ? clientIds[0] : null,
        from: entries.map((entry) => entry.workDate).sort()[0] ?? null,
        to: entries.map((entry) => entry.workDate).sort().at(-1) ?? null,
        issuedAt: entries.map((entry) => entry.invoicedAt).sort()[0] ?? this.ids.now(),
        lines,
        totals: invoiceTotals(lines),
        skipped: { alreadyInvoiced: 0, unpriced: 0, nonBillable: 0 },
      },
    };
  }

  /** Every invoice reference the tenant has issued, newest first. */
  async invoices(actor: Actor): Promise<ServiceResult<{ ref: string; entries: number; amountCents: number; currency: string | null; issuedAt: string }[]>> {
    const entries = await this.entries(actor);
    if (!entries.ok) return entries;

    const grouped = new Map<string, { ref: string; entries: number; amountCents: number; currency: string | null; issuedAt: string }>();
    for (const entry of entries.value) {
      if (entry.invoiceRef === null) continue;
      const current = grouped.get(entry.invoiceRef) ?? {
        ref: entry.invoiceRef,
        entries: 0,
        amountCents: 0,
        currency: entry.currency,
        issuedAt: entry.invoicedAt ?? entry.updatedAt,
      };
      current.entries += 1;
      current.amountCents += entryAmountCents(entry) ?? 0;
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
}
