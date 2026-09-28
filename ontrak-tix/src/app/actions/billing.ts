"use server";

/**
 * Billing-depth server actions (M4): tax rules, retainers and credit notes.
 *
 * Every one of these moves money, so none of them decides anything: the service
 * validates the rule, derives the retainer balance from the ledger, and refuses a
 * credit larger than the invoice still owes. The action's job is to marshal a
 * form and put the outcome in front of the person who submitted it.
 *
 * A credit note is the only way back from an invoice, so it is deliberately not
 * a form that "just works": it needs the reference, an amount and a reason, and
 * the refusal when the reason is missing says why rather than asking again.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireActor } from "../../lib/session";
import { timeServicesFor } from "../../lib/db";

function back(to: string, message: string, kind: "flash" | "error" = "flash"): never {
  revalidatePath(to.split("?")[0] || "/time");
  const joiner = to.includes("?") ? "&" : "?";
  redirect(`${to}${joiner}${kind}=${encodeURIComponent(message)}`);
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

/** An amount typed as money, stored as cents. `12.50` is 1250. */
function cents(value: string): number {
  if (value === "") return Number.NaN;
  return Math.round(Number(value) * 100);
}

/** Write a tax rule for a client, or the desk's default when none is named. */
export async function saveTaxRuleAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const carried = formData.get("clientId");

  const result = await timeServicesFor().saveTaxRule(actor, {
    clientId: carried === null ? null : text(formData, "clientId") || null,
    label: text(formData, "label"),
    rateBasisPoints: Math.round(Number(text(formData, "ratePercent") || "NaN") * 100),
  });
  if (!result.ok) back("/clients", result.error, "error");

  revalidatePath("/clients");
  back(
    "/clients",
    `${result.value.label} is in force at ${(result.value.rateBasisPoints / 100).toFixed(2)}%. Invoices not yet issued will carry it.`,
  );
}

export async function removeTaxRuleAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const ruleId = text(formData, "ruleId");
  if (!ruleId) back("/clients", "Choose a tax rule first.", "error");

  const result = await timeServicesFor().removeTaxRule(actor, ruleId);
  if (!result.ok) back("/clients", result.error, "error");
  revalidatePath("/clients");
  back("/clients", `${result.value.label} removed. Hours already charged keep their tax.`);
}

/** Record money a client has paid up front for a period. */
export async function saveRetainerAction(formData: FormData): Promise<void> {
  const actor = await requireActor();

  const result = await timeServicesFor().saveRetainer(actor, {
    clientId: text(formData, "clientId"),
    currency: text(formData, "currency"),
    fundedCents: cents(text(formData, "funded")),
    periodStart: text(formData, "periodStart"),
    periodEnd: text(formData, "periodEnd"),
    note: text(formData, "note"),
  });
  if (!result.ok) back("/clients", result.error, "error");

  revalidatePath("/clients");
  back(
    "/clients",
    `Retainer recorded: ${(result.value.fundedCents / 100).toFixed(2)} ${result.value.currency} for ${result.value.periodStart} → ${result.value.periodEnd}.`,
  );
}

/**
 * Credit an invoice. The amount may be part of it — a partial credit is the
 * normal case — and the ceiling is what the invoice still owes.
 */
export async function creditInvoiceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const invoiceRef = text(formData, "invoiceRef");
  if (!invoiceRef) back("/time", "Choose an invoice to credit.", "error");

  const result = await timeServicesFor().creditNote(actor, {
    invoiceRef,
    amountCents: cents(text(formData, "amount")),
    reason: text(formData, "reason"),
  });
  if (!result.ok) back(`/time?invoice=${encodeURIComponent(invoiceRef)}`, result.error, "error");

  revalidatePath("/time");
  back(
    "/time",
    `${result.value.ref} issued against ${invoiceRef}: ${(result.value.amountCents / 100).toFixed(2)} ${result.value.currency} credited.`,
  );
}
