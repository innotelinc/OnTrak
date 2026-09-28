/**
 * Billing depth rules (M4): what is added to a bill, what reverses one, and what
 * was paid before the work happened.
 *
 * Three things an MSP does the moment it bills a real client, and none of which
 * can be bolted on later without changing what an invoice *is*:
 *
 *  - **Tax.** A rate that depends on the client, applied to the invoice total at
 *    the moment it is issued and stored on the entries it priced, for the same
 *    reason the labour rate is: a rule changed in April must not restate what
 *    March was charged.
 *  - **Credit notes.** The only remedy for an invoice that was wrong. An issued
 *    invoice is history — entries on it are frozen — so a correction is new
 *    money moving, with a reason, a reference and an actor. The module refuses a
 *    credit larger than what the invoice actually charged, and refuses one that
 *    would credit the same money twice.
 *  - **Retainers.** Money paid up front for a period. The balance is derived
 *    from the invoices that drew on it, never from a stored counter, so it
 *    cannot drift from the ledger it is supposed to describe.
 *
 * Money is integer cents throughout, because a float that is wrong by a cent on
 * an invoice is a phone call.
 */

export const TAX_LABEL_MAX = 120;
export const CREDIT_REASON_MIN = 8;
export const CREDIT_REASON_MAX = 1000;
export const RETAINER_NOTE_MAX = 500;
/** 100% in basis points. A "tax" above that is a typo, not a jurisdiction. */
export const MAX_TAX_BASIS_POINTS = 10_000;

export interface BillingIssue {
  field: string;
  message: string;
}

/* -------------------------------------------------------------------------- */
/*  Tax                                                                       */
/* -------------------------------------------------------------------------- */

export interface TaxRuleRecord {
  id: string;
  tenantId: string;
  /** `null` is the desk's default rule, used for a client without one. */
  clientId: string | null;
  label: string;
  /** Basis points: 8.25% is 825. */
  rateBasisPoints: number;
  updatedAt: string;
}

export interface InvoiceTax {
  label: string;
  rateBasisPoints: number;
  /** The labour total the tax was charged on. */
  baseCents: number;
  taxCents: number;
  /** Base plus tax: what the client is actually asked for. */
  totalCents: number;
}

export function validateTaxRule(input: {
  label?: string;
  rateBasisPoints?: number;
}): BillingIssue[] {
  const issues: BillingIssue[] = [];

  const label = (input.label ?? "").trim();
  if (!label) issues.push({ field: "label", message: "A tax rule needs a label — it is what the client reads on the invoice." });
  else if (label.length > TAX_LABEL_MAX) {
    issues.push({ field: "label", message: `The label may be at most ${TAX_LABEL_MAX} characters.` });
  }

  const rate = input.rateBasisPoints;
  if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 0) {
    issues.push({ field: "rateBasisPoints", message: "Give the rate as whole basis points (825 is 8.25%), zero or more." });
  } else if (rate > MAX_TAX_BASIS_POINTS) {
    issues.push({ field: "rateBasisPoints", message: `A rate above ${MAX_TAX_BASIS_POINTS / 100}% is a typo, not a tax.` });
  }

  return issues;
}

export type TaxRuleScope = "client" | "desk" | "none";

export interface TaxResolution {
  rule: TaxRuleRecord | null;
  scope: TaxRuleScope;
  because: string;
}

/**
 * The tax rule that applies to a client. Two rungs, like the rate card: a
 * client's own rule, then the desk's default. A rate with more rungs than that
 * is a rate nobody can predict from the invoice.
 */
export function resolveTaxRule(input: { rules: readonly TaxRuleRecord[]; clientId?: string | null }): TaxResolution {
  const newest = (rules: readonly TaxRuleRecord[]) =>
    [...rules].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;

  if (input.clientId) {
    const own = newest(input.rules.filter((rule) => rule.clientId === input.clientId));
    if (own) return { rule: own, scope: "client", because: `the rule written for this client: ${own.label}` };
  }
  const desk = newest(input.rules.filter((rule) => !rule.clientId));
  if (desk) return { rule: desk, scope: "desk", because: `the desk's default rule: ${desk.label}` };
  return { rule: null, scope: "none", because: "no tax rule covers this client" };
}

/** Tax on an amount, rounded to the cent the way a tax authority expects. */
export function taxCentsFor(amountCents: number, rateBasisPoints: number): number {
  return Math.round((amountCents * rateBasisPoints) / 10_000);
}

/**
 * The tax block of an invoice, or `null` when no rule applies. Tax is charged on
 * the labour subtotal, not line by line, so the invoice's tax equals the rate
 * applied once — and the arithmetic a client checks on the page is the
 * arithmetic that produced it.
 */
export function taxForInvoice(input: { amountCents: number; rule: TaxRuleRecord | null }): InvoiceTax | null {
  if (!input.rule) return null;
  const taxCents = taxCentsFor(input.amountCents, input.rule.rateBasisPoints);
  return {
    label: input.rule.label,
    rateBasisPoints: input.rule.rateBasisPoints,
    baseCents: input.amountCents,
    taxCents,
    totalCents: input.amountCents + taxCents,
  };
}

/** `8.25%`, for a page that shows the rate as a person writes it. */
export function formatRate(rateBasisPoints: number): string {
  return `${(rateBasisPoints / 100).toFixed(2).replace(/\.00$/, "")}%`;
}

/* -------------------------------------------------------------------------- */
/*  Credit notes                                                              */
/* -------------------------------------------------------------------------- */

export interface CreditNoteRecord {
  id: string;
  tenantId: string;
  ref: string;
  invoiceRef: string;
  clientId: string | null;
  currency: string;
  amountCents: number;
  reason: string;
  issuedBy: string;
  issuedAt: string;
}

export function validateCreditNote(input: { amountCents?: number; reason?: string }): BillingIssue[] {
  const issues: BillingIssue[] = [];

  const amount = input.amountCents;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    issues.push({ field: "amountCents", message: "Credit a whole number of cents, more than zero." });
  }

  const reason = (input.reason ?? "").trim();
  if (reason.length < CREDIT_REASON_MIN) {
    issues.push({
      field: "reason",
      message: `A credit note needs a reason somebody can read back (at least ${CREDIT_REASON_MIN} characters).`,
    });
  } else if (reason.length > CREDIT_REASON_MAX) {
    issues.push({ field: "reason", message: `The reason may be at most ${CREDIT_REASON_MAX} characters.` });
  }

  return issues;
}

/** `CN-20260401-AB12CD`, the mirror of `invoiceRefFor`. */
export function creditNoteRefFor(id: string, now: string): string {
  const day = now.slice(0, 10).replace(/-/g, "");
  const tag = id.replace(/[^a-z0-9]/gi, "").slice(0, 6).toUpperCase();
  return `CN-${day}-${tag}`;
}

export interface CreditDecision {
  allowed: boolean;
  reason: string;
  /** What would be left of the invoice if this note were issued. */
  remainingCents: number;
}

/**
 * Whether an invoice may be credited by this much.
 *
 * Refuses money the invoice never charged, and refuses a second credit for the
 * same cents — the check that makes "credit it twice" impossible rather than
 * merely unlikely. Partial credits are the normal case, so the ceiling is what
 * is *left*, not the whole invoice.
 */
export function creditNoteDecision(input: {
  amountCents: number;
  invoiceCents: number;
  alreadyCreditedCents: number;
  currency: string;
}): CreditDecision {
  const remaining = input.invoiceCents - input.alreadyCreditedCents;
  if (remaining <= 0) {
    return {
      allowed: false,
      reason: "That invoice is already credited in full — there is nothing left of it to credit.",
      remainingCents: 0,
    };
  }
  if (input.amountCents > remaining) {
    return {
      allowed: false,
      reason: `That credits more than the invoice still owes: ${(remaining / 100).toFixed(2)} ${input.currency} is left of it.`,
      remainingCents: remaining,
    };
  }
  return { allowed: true, reason: "Within what the invoice charged.", remainingCents: remaining - input.amountCents };
}

/** What the tenant has already credited against one invoice. */
export function creditedTotal(notes: readonly Pick<CreditNoteRecord, "invoiceRef" | "amountCents">[], invoiceRef: string): number {
  return notes.filter((note) => note.invoiceRef === invoiceRef).reduce((sum, note) => sum + note.amountCents, 0);
}

/* -------------------------------------------------------------------------- */
/*  Retainers                                                                 */
/* -------------------------------------------------------------------------- */

export interface RetainerRecord {
  id: string;
  tenantId: string;
  clientId: string;
  currency: string;
  fundedCents: number;
  /** Inclusive first day, held at midnight UTC. */
  periodStart: string;
  periodEnd: string;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export function validateRetainer(input: {
  currency?: string;
  fundedCents?: number;
  periodStart?: string;
  periodEnd?: string;
  note?: string | null;
}): BillingIssue[] {
  const issues: BillingIssue[] = [];

  const currency = (input.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    issues.push({ field: "currency", message: "Give the currency as three upper-case letters, e.g. USD." });
  }

  const funded = input.fundedCents;
  if (typeof funded !== "number" || !Number.isInteger(funded) || funded <= 0) {
    issues.push({ field: "fundedCents", message: "Fund the retainer with a whole number of cents, more than zero." });
  }

  if (!isDate(input.periodStart) || !isDate(input.periodEnd)) {
    issues.push({ field: "periodStart", message: "Give the retainer a period, as two dates." });
  } else if (input.periodStart! > input.periodEnd!) {
    issues.push({ field: "periodEnd", message: "A retainer's period has to end on or after it starts." });
  }

  const note = (input.note ?? "").trim();
  if (note.length > RETAINER_NOTE_MAX) {
    issues.push({ field: "note", message: `The note may be at most ${RETAINER_NOTE_MAX} characters.` });
  }

  return issues;
}

function isDate(value: string | undefined): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Whether a `YYYY-MM-DD` day falls inside the retainer's period. */
export function retainerCovers(retainer: Pick<RetainerRecord, "periodStart" | "periodEnd">, day: string): boolean {
  return retainer.periodStart <= day && day <= retainer.periodEnd;
}

export interface RetainerStanding {
  fundedCents: number;
  drawnCents: number;
  remainingCents: number;
  /** Percentage of the retainer already drawn, to one decimal place. */
  usedPercent: number;
  exhausted: boolean;
}

/**
 * The balance of a retainer. Derived, always: what was funded minus what the
 * invoices carrying its id have drawn. A stored balance would be a second copy
 * of the ledger, and a second copy is the one that goes stale.
 */
export function retainerStanding(input: { fundedCents: number; drawnCents: number }): RetainerStanding {
  const drawn = Math.max(0, input.drawnCents);
  const remaining = Math.max(0, input.fundedCents - drawn);
  return {
    fundedCents: input.fundedCents,
    drawnCents: drawn,
    remainingCents: remaining,
    usedPercent: input.fundedCents === 0 ? 0 : Math.round((drawn / input.fundedCents) * 1000) / 10,
    exhausted: remaining === 0,
  };
}

/**
 * How much of an invoice a retainer absorbs. Never more than what is left: a
 * retainer that has run out leaves the rest of the invoice payable, which is a
 * thing the invoice has to say rather than a thing the client discovers.
 */
export function retainerDrawdown(input: { invoiceCents: number; remainingCents: number }): number {
  return Math.max(0, Math.min(input.invoiceCents, input.remainingCents));
}

/** The retainer covering a day for a client, newest period first. */
export function activeRetainer(
  retainers: readonly RetainerRecord[],
  clientId: string,
  day: string,
): RetainerRecord | null {
  return (
    [...retainers]
      .filter((retainer) => retainer.clientId === clientId && retainerCovers(retainer, day))
      .sort((a, b) => b.periodStart.localeCompare(a.periodStart) || b.createdAt.localeCompare(a.createdAt))[0] ?? null
  );
}

/** What an invoice drew from a retainer, as the invoice reports it. */
export interface RetainerDraw {
  id: string;
  currency: string;
  /** What this invoice took from the retainer. */
  drawnCents: number;
  /** What was left of it afterwards. */
  remainingCents: number;
}

/** One line for the console: where a client's retainer stands. */
export function retainerSummary(retainer: RetainerRecord, standing: RetainerStanding): string {
  return `${(standing.remainingCents / 100).toFixed(2)} ${retainer.currency} left of ${(standing.fundedCents / 100).toFixed(2)} (${standing.usedPercent}% drawn, period ${retainer.periodStart} → ${retainer.periodEnd}).`;
}
