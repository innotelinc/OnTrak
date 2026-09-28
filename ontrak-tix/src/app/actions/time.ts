"use server";

/**
 * Time and billing server actions (M4).
 *
 * Each one marshals a form and reports the outcome; the permission, the price
 * snapshot, the frozen-after-invoicing rule and the record-keeping all live in
 * `time-service.ts`, so a form cannot log an hour the service would refuse.
 *
 * Issuing an invoice is the one action that *returns* something the caller wants
 * to see: the journal redirects back to the ledger with the reference, which the
 * page turns into a download link, rather than answering with a file and losing
 * the fact that an invoice now exists.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireActor } from "../../lib/session";
import { timeServicesFor } from "../../lib/db";

function back(to: string, message: string, kind: "flash" | "error" = "flash"): never {
  revalidatePath("/time");
  redirect(`${to}?${kind}=${encodeURIComponent(message)}`);
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

/** Where a form says to go back to, narrowed to the two screens that post here. */
function safeHome(value: string): string {
  return /^\/(?:time|inbox\/[A-Za-z0-9_-]+)$/.test(value) ? value : "/time";
}

/** Log time against a ticket, or against the desk when there is no ticket. */
export async function logTimeAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const ticketId = text(formData, "ticketId");

  const result = await timeServicesFor().log(actor, {
    ticketId: ticketId || null,
    clientId: text(formData, "clientId") || null,
    workDate: text(formData, "workDate"),
    minutes: text(formData, "minutes"),
    billable: formData.get("billable") !== null,
    note: text(formData, "note"),
  });
  if (!result.ok) back("/time", result.error, "error");

  // Back to the ticket when the time was logged there, so the person sees it land.
  const home = ticketId ? `/inbox/${ticketId}` : "/time";
  const priced = result.value.rateCentsPerHour === null && result.value.billable;
  const suffix = priced ? " No rate card covers this client yet, so it is logged unpriced." : "";
  revalidatePath(home);
  back(home, `${result.value.minutes} minutes logged.${suffix}`);
}

/** Change an entry: what the desk got wrong, never what it agreed to charge. */
export async function correctTimeAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const entryId = text(formData, "entryId");
  if (!entryId) back("/time", "Choose an entry first.", "error");

  const result = await timeServicesFor().correct(actor, entryId, {
    minutes: text(formData, "minutes"),
    note: text(formData, "note"),
    billable: formData.get("billable") !== null,
  });
  if (!result.ok) back("/time", result.error, "error");
  back("/time", `${result.value.minutes} minutes recorded.`);
}

/** Remove an entry that has not been billed. */
export async function removeTimeAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const entryId = text(formData, "entryId");
  const home = safeHome(text(formData, "home"));
  if (!entryId) back(home, "Choose an entry first.", "error");

  const result = await timeServicesFor().remove(actor, entryId);
  if (!result.ok) back(home, result.error, "error");
  revalidatePath(home);
  back(home, "Time removed from the ledger.");
}

/** Write (or replace) a client's rate card, or the desk's default. */
export async function saveRateCardAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const carried = formData.get("clientId");

  const result = await timeServicesFor().saveRateCard(actor, {
    // Absent means the desk's own card, not a client named "".
    clientId: carried === null ? null : text(formData, "clientId") || null,
    name: text(formData, "name"),
    currency: text(formData, "currency"),
    hourlyRateCents: cents(text(formData, "hourlyRate")),
    incrementMinutes: text(formData, "incrementMinutes"),
  });
  if (!result.ok) back("/clients", result.error, "error");

  revalidatePath("/clients");
  back(
    "/clients",
    `${result.value.name}: ${(result.value.hourlyRateCents / 100).toFixed(2)} ${result.value.currency}/hour${
      result.value.incrementMinutes > 0 ? `, billed in ${result.value.incrementMinutes}-minute units` : ""
    }.`,
  );
}

/** Drop a rate card. Entries keep the price they were logged at. */
export async function removeRateCardAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const cardId = text(formData, "cardId");
  if (!cardId) back("/clients", "Choose a rate card first.", "error");

  const result = await timeServicesFor().removeRateCard(actor, cardId);
  if (!result.ok) back("/clients", result.error, "error");
  revalidatePath("/clients");
  back("/clients", `${result.value.name} removed. Time already logged keeps its price.`);
}

/** Issue an invoice for a period: the act that freezes what it covers. */
export async function issueInvoiceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const carried = formData.get("clientId");

  const result = await timeServicesFor().invoice(actor, {
    clientId: carried === null ? null : text(formData, "clientId") || null,
    from: text(formData, "from"),
    to: text(formData, "to"),
  });
  if (!result.ok) back("/time", result.error, "error");

  const { ref, totals } = result.value;
  revalidatePath("/time");
  redirect(
    `/time?flash=${encodeURIComponent(`Invoice ${ref} issued: ${(totals.amountCents / 100).toFixed(2)} ${totals.currency ?? ""} for ${totals.billedMinutes} billed minutes.`)}&invoice=${encodeURIComponent(ref)}`,
  );
}

/** An hourly rate typed as money, stored as cents. `12.50` is 1250. */
function cents(value: string): number {
  if (value === "") return Number.NaN;
  return Math.round(Number(value) * 100);
}
