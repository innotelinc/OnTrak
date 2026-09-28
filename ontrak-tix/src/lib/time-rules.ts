/**
 * Time and billing rules (M4): what an hour of the desk's work is worth, and
 * what may be done to a record of it afterwards.
 *
 * An MSP is paid for time, so the two things that must never be wrong are the
 * *rate that applied* and *what was already billed*. Both are decided here, in
 * pure functions, with one rule standing above the rest:
 *
 *  - **The price is snapshotted onto the entry, not read from the card.** A rate
 *    card that changes in March must not restate what February's work cost, and
 *    a card that is deleted must not turn last quarter's invoice into a guess.
 *    So an entry carries the minutes worked, the minutes *charged* (the card's
 *    rounding applied once, at the moment of logging), the rate and the currency.
 *  - **An invoiced entry is frozen.** `timeEntryDecision` refuses to change or
 *    remove one; a correction is a credit note, not an edit. That is what makes
 *    "export it twice and bill it twice" impossible rather than merely unlikely.
 */

import { hasPermission, type Actor, type Role } from "./access-rules";

export const TIME_NOTE_MAX = 500;
export const RATE_CARD_NAME_MAX = 120;
/** Nobody works a 25-hour day; a wrong entry is a typo, not a shift. */
export const MAX_MINUTES_PER_ENTRY = 24 * 60;

/** The rounding choices, in minutes. `0` means "charge exactly what was worked". */
export const RATE_INCREMENTS: readonly number[] = [0, 1, 5, 6, 10, 15, 30, 60];

export interface TimeIssue {
  field: string;
  message: string;
}

export interface RateCardRecord {
  id: string;
  tenantId: string;
  /** `null` is the desk's default card, used for a client without one of their own. */
  clientId: string | null;
  name: string;
  /** ISO-4217, upper case. A rate without a currency is not a price. */
  currency: string;
  /** Cents per hour, so money never sits in a float. */
  hourlyRateCents: number;
  /** Bill in whole multiples of this many minutes, rounded up. */
  incrementMinutes: number;
  updatedAt: string;
}

export interface TimeEntryRecord {
  id: string;
  tenantId: string;
  ticketId: string | null;
  /** The reference of the ticket, carried so an invoice line can name it. */
  ticketRef?: string | null;
  clientId: string | null;
  userId: string;
  /** The day the work happened (`YYYY-MM-DD`), not the day it was typed in. */
  workDate: string;
  /** Minutes actually worked. */
  minutes: number;
  /** Minutes charged, after the card's rounding, snapshotted at logging time. */
  billedMinutes: number | null;
  billable: boolean;
  rateCardId: string | null;
  rateCentsPerHour: number | null;
  /**
   * The rounding the card in force applied. Snapshotted with the rate so an
   * entry can be re-priced after a correction without asking today's card how
   * February was billed.
   */
  rateIncrementMinutes: number | null;
  currency: string | null;
  note: string | null;
  /** Set when the entry went onto an issued invoice. */
  invoicedAt: string | null;
  invoiceRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

export function validateRateCard(input: {
  name?: string;
  currency?: string;
  hourlyRateCents?: number;
  incrementMinutes?: number;
}): TimeIssue[] {
  const issues: TimeIssue[] = [];

  const name = input.name?.trim() ?? "";
  if (!name) issues.push({ field: "name", message: "A rate card needs a name, so a client can recognise it." });
  else if (name.length > RATE_CARD_NAME_MAX) {
    issues.push({ field: "name", message: `A rate card's name may be at most ${RATE_CARD_NAME_MAX} characters.` });
  }

  const currency = input.currency?.trim() ?? "";
  if (!/^[A-Z]{3}$/.test(currency)) {
    issues.push({ field: "currency", message: "Give the currency as three upper-case letters, e.g. USD." });
  }

  const rate = input.hourlyRateCents;
  if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 0) {
    issues.push({ field: "hourlyRateCents", message: "The hourly rate must be a whole number of cents, zero or more." });
  }

  const increment = input.incrementMinutes;
  if (typeof increment !== "number" || !RATE_INCREMENTS.includes(increment)) {
    issues.push({ field: "incrementMinutes", message: `Round to one of ${RATE_INCREMENTS.join(", ")} minutes.` });
  }

  return issues;
}

/** A calendar date, not a timestamp: time is logged against the day it happened. */
export function isWorkDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateTimeEntry(input: { workDate?: string; minutes?: number; note?: string | null }): TimeIssue[] {
  const issues: TimeIssue[] = [];

  if (!isWorkDate(input.workDate)) {
    issues.push({ field: "workDate", message: "Give the date as YYYY-MM-DD — the day the work happened." });
  }

  const minutes = input.minutes;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes <= 0) {
    issues.push({ field: "minutes", message: "Log a whole number of minutes." });
  } else if (minutes > MAX_MINUTES_PER_ENTRY) {
    issues.push({ field: "minutes", message: `A single entry may be at most ${MAX_MINUTES_PER_ENTRY} minutes. Split the day.` });
  }

  const note = input.note ?? "";
  if (note.length > TIME_NOTE_MAX) {
    issues.push({ field: "note", message: `A note may be at most ${TIME_NOTE_MAX} characters.` });
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/*  Which rate applies                                                        */
/* -------------------------------------------------------------------------- */

export type RateCardScope = "client" | "desk" | "none";

export interface RateCardResolution {
  card: RateCardRecord | null;
  scope: RateCardScope;
  /** Why this card won, in a sentence a person reading an invoice can follow. */
  because: string;
}

/**
 * The card that applies, client first. Two rungs only — a client's own card, or
 * the desk's default — because a rate is a price, and a price with four rungs of
 * precedence is a price nobody can predict.
 *
 * Ties are broken by `updatedAt` (newest wins) so the answer is deterministic
 * even if two cards for the same client ever exist; the service writes one card
 * per client, so this is a safety net rather than the design.
 */
export function resolveRateCard(input: {
  cards: readonly RateCardRecord[];
  clientId?: string | null;
}): RateCardResolution {
  const newest = (cards: readonly RateCardRecord[]) =>
    [...cards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;

  if (input.clientId) {
    const own = newest(input.cards.filter((card) => card.clientId === input.clientId));
    if (own) return { card: own, scope: "client", because: `the client's own rate card: ${own.name}` };
  }

  const desk = newest(input.cards.filter((card) => !card.clientId));
  if (desk) return { card: desk, scope: "desk", because: `the desk's default rate card: ${desk.name}` };

  return { card: null, scope: "none", because: "no rate card covers this client" };
}

/** The minutes charged for a piece of work, rounded up to the card's increment. */
export function billedMinutes(minutes: number, incrementMinutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  if (!Number.isFinite(incrementMinutes) || incrementMinutes <= 0) return Math.round(minutes);
  return Math.ceil(minutes / incrementMinutes) * incrementMinutes;
}

/** What one entry charges, or `null` when it charges nothing (non-billable, or unpriced). */
export function entryAmountCents(entry: Pick<TimeEntryRecord, "billable" | "billedMinutes" | "rateCentsPerHour">): number | null {
  if (!entry.billable) return null;
  if (entry.billedMinutes === null || entry.rateCentsPerHour === null) return null;
  return Math.round((entry.billedMinutes / 60) * entry.rateCentsPerHour);
}

/** Money as a person writes it. A currency the runtime does not know falls back to plain cents. */
export function formatMoney(cents: number, currency: string | null): string {
  const amount = cents / 100;
  if (currency) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
    } catch {
      /* an unknown ISO code is still a price: show it plainly rather than throwing */
    }
  }
  return `${amount.toFixed(2)}${currency ? ` ${currency}` : ""}`;
}

/**
 * A reference a client can quote back: the issue date, then a short tag.
 * Deliberately not a sequential number — two desks issuing in the same second
 * must not be able to collide, and the reference is an audit target, not a
 * document number the product has to allocate.
 */
export function invoiceRefFor(id: string, now: string): string {
  const day = now.slice(0, 10).replace(/-/g, "");
  const tag = id.replace(/[^a-z0-9]/gi, "").slice(0, 6).toUpperCase();
  return `INV-${day}-${tag}`;
}

/** Minutes as `3h 15m`, matching every other duration in the product. */
export function formatLoggedMinutes(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes));
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}

/* -------------------------------------------------------------------------- */
/*  The invoice                                                               */
/* -------------------------------------------------------------------------- */

export interface InvoiceLine {
  /** The ticket the work was on, or `null` for desk time. */
  ticketRef: string | null;
  description: string;
  rateCentsPerHour: number | null;
  currency: string | null;
  /** Worked minutes, and minutes charged after rounding. */
  minutes: number;
  billedMinutes: number;
  /** The sum of what each entry on this line charges. */
  amountCents: number;
  entries: number;
  /** Who worked, deduped — an invoice line that names the labour is a defensible one. */
  userIds: string[];
}

/**
 * Group entries into invoice lines: one per (ticket, rate, currency).
 *
 * Each entry is charged at the rounding the desk agreed to, once, and the line
 * total is the **sum of those charges** — never a rate applied to a summed pile
 * of minutes. That is deliberate, and it is why the increment is a contract term
 * rather than a display detail: three 20-minute visits on a 15-minute increment
 * bill 90 minutes, because each visit is a separate charge the client can see,
 * and the total on the invoice must equal the ledger it came from.
 *
 * Entries that charge nothing are left out; the caller reports them separately
 * so an unpriced hour is visible rather than silently free.
 */
export function invoiceLines(entries: readonly TimeEntryRecord[]): InvoiceLine[] {
  const lines = new Map<string, InvoiceLine>();

  for (const entry of entries) {
    const amount = entryAmountCents(entry);
    if (amount === null) continue;

    const ref = entry.ticketRef ?? null;
    const key = `${ref ?? "-"}|${entry.rateCentsPerHour}|${entry.currency}`;
    const line = lines.get(key) ?? {
      ticketRef: ref,
      description: ref ? `Support for ${ref}` : "Desk time (no ticket)",
      rateCentsPerHour: entry.rateCentsPerHour,
      currency: entry.currency,
      minutes: 0,
      billedMinutes: 0,
      amountCents: 0,
      entries: 0,
      userIds: [],
    };
    line.minutes += entry.minutes;
    line.billedMinutes += entry.billedMinutes ?? 0;
    line.amountCents += amount;
    line.entries += 1;
    if (!line.userIds.includes(entry.userId)) line.userIds.push(entry.userId);
    lines.set(key, line);
  }

  return [...lines.values()].sort(
    (a, b) =>
      (a.ticketRef ?? "").localeCompare(b.ticketRef ?? "") ||
      (b.rateCentsPerHour ?? 0) - (a.rateCentsPerHour ?? 0) ||
      (a.currency ?? "").localeCompare(b.currency ?? ""),
  );
}

export interface InvoiceTotals {
  lines: number;
  entries: number;
  minutes: number;
  billedMinutes: number;
  amountCents: number;
  /** The single currency of the invoice, or `null` when it mixes several. */
  currency: string | null;
  mixedCurrencies: boolean;
}

export function invoiceTotals(lines: readonly InvoiceLine[]): InvoiceTotals {
  const currencies = [...new Set(lines.map((line) => line.currency).filter((value): value is string => value !== null))];
  return {
    lines: lines.length,
    entries: lines.reduce((sum, line) => sum + line.entries, 0),
    minutes: lines.reduce((sum, line) => sum + line.minutes, 0),
    billedMinutes: lines.reduce((sum, line) => sum + line.billedMinutes, 0),
    amountCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
    currency: currencies.length === 1 ? currencies[0] : null,
    mixedCurrencies: currencies.length > 1,
  };
}

/**
 * An invoice as issued: the reference, what it covers and what it came to. Held
 * in the rules module because it is a *value* — the CSV, the page and the service
 * all hand the same shape around.
 */
export interface Invoice {
  ref: string;
  clientId: string | null;
  from: string | null;
  to: string | null;
  issuedAt: string;
  /** Who issued it, on the event that issued it. A re-read cannot know, and says so. */
  issuedBy?: string;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  /** What was left out, so an unbilled hour is visible rather than silently free. */
  skipped: { alreadyInvoiced: number; unpriced: number; nonBillable: number };
}

export interface BillableSplit {
  entries: number;
  minutes: number;
  billableMinutes: number;
  nonBillableMinutes: number;
  billedMinutes: number;
  amountCents: number;
  currency: string | null;
  /** Entries that charge nothing because no rate card covered them. */
  unpriced: number;
  /** The share of worked minutes that were billable, to one decimal place. */
  billablePercent: number | null;
}

/**
 * Utilisation: how much of the desk's time is chargeable. Unpriced billable time
 * is counted apart from non-billable time, because "we forgot the rate card" and
 * "we chose not to charge" are different problems.
 */
export function billableSplit(entries: readonly TimeEntryRecord[]): BillableSplit {
  const worked = entries.reduce((sum, entry) => sum + entry.minutes, 0);
  const billable = entries.filter((entry) => entry.billable);
  const billableMinutes = billable.reduce((sum, entry) => sum + entry.minutes, 0);
  const currencies = [...new Set(entries.map((entry) => entry.currency).filter((value): value is string => value !== null))];
  const amountCents = entries.reduce((sum, entry) => sum + (entryAmountCents(entry) ?? 0), 0);

  return {
    entries: entries.length,
    minutes: worked,
    billableMinutes,
    nonBillableMinutes: worked - billableMinutes,
    billedMinutes: entries.reduce((sum, entry) => sum + (entry.billedMinutes ?? 0), 0),
    amountCents,
    currency: currencies.length === 1 ? currencies[0] : null,
    unpriced: billable.filter((entry) => entryAmountCents(entry) === null).length,
    billablePercent: worked === 0 ? null : Math.round((billableMinutes / worked) * 1000) / 10,
  };
}

/* -------------------------------------------------------------------------- */
/*  What may still be done to an entry                                        */
/* -------------------------------------------------------------------------- */

export interface TimeEntryDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Whether an actor may change or remove a logged entry.
 *
 * Three refusals, each for a reason an auditor would otherwise have to
 * reconstruct: an entry on an issued invoice is history (credit it, do not edit
 * it), somebody else's time is theirs to correct unless you run the desk, and
 * nothing at all without `ticket:update`.
 */
export function timeEntryDecision(
  entry: Pick<TimeEntryRecord, "userId" | "invoicedAt" | "invoiceRef">,
  actor: Actor,
): TimeEntryDecision {
  const role = actor.role as Role;
  if (entry.invoicedAt !== null) {
    return {
      allowed: false,
      reason: `That time is on invoice ${entry.invoiceRef ?? "(unnamed)"}. Issue a credit note instead of changing it.`,
    };
  }
  if (!hasPermission(role, "ticket:update")) {
    return { allowed: false, reason: "You do not log time." };
  }
  if (entry.userId !== actor.id && !hasPermission(role, "queue:manage")) {
    return { allowed: false, reason: "You may only change your own time." };
  }
  return { allowed: true, reason: "Yours to correct." };
}
