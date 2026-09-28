"use server";

/**
 * SLA policy server actions (M4): the desk writes its own promises.
 *
 * Each one marshals a form and reports the outcome; the permission (queue:manage),
 * the validation and the record-keeping live in `sla-policy-service.ts`, so the
 * form cannot write a promise the service would refuse.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireActor } from "../../lib/session";
import { slaPolicyServicesFor } from "../../lib/db";
import type { TicketPriority } from "../../lib/ticket-rules";
import type { SlaHours } from "../../lib/sla-policy-service";

function ok(message: string): never {
  // A promise changes clocks on every surface that measures one.
  revalidatePath("/clients");
  revalidatePath("/inbox");
  revalidatePath("/reports");
  redirect(`/clients?flash=${encodeURIComponent(message)}`);
}

function fail(message: string): never {
  redirect(`/clients?error=${encodeURIComponent(message)}`);
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

/** Create or change a promise. A `policyId` in the form means "change this one". */
export async function saveSlaPolicyAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const priority = text(formData, "priority");
  const hours = text(formData, "hours");

  // A form that does not carry a client is the desk's own form: absent must mean
  // "the desk", not "move this promise to the client named ''".
  const carried = formData.get("clientId");
  // The queue scope is only offered at desk level (a client's card already says
  // who the promise is for), so absent means "leave the scope alone" and the
  // service keeps whatever the promise already had.
  const carriedQueue = formData.get("queueId");

  const input = {
    name: text(formData, "name"),
    priority: priority === "" ? null : (priority as TicketPriority),
    responseMinutes: text(formData, "responseMinutes"),
    resolutionMinutes: text(formData, "resolutionMinutes"),
    clientId: carried === null ? undefined : text(formData, "clientId") || null,
    queueId: carriedQueue === null || carried !== null ? undefined : text(formData, "queueId") || null,
    hours: (hours === "always" ? "always" : "business") as SlaHours,
    warningFraction: text(formData, "warningFraction"),
  };

  const service = slaPolicyServicesFor();
  const policyId = text(formData, "policyId");
  const result = policyId ? await service.update(actor, policyId, input) : await service.create(actor, input);
  if (!result.ok) fail(result.error);

  ok(policyId ? `${result.value.name} updated.` : `${result.value.name} is now in force.`);
}

/** Remove a promise no ticket is measured against. */
export async function deleteSlaPolicyAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const policyId = text(formData, "policyId");
  if (!policyId) fail("Choose a promise first.");

  const result = await slaPolicyServicesFor().remove(actor, policyId);
  if (!result.ok) fail(result.error);
  revalidatePath("/clients");
  redirect(`/clients?flash=${encodeURIComponent(`${result.value.name} removed.`)}`);
}
