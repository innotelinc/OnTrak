"use server";

/**
 * Assist server actions (M7).
 *
 * Two actions, and both keep the person in the loop. One records what an agent thought
 * of a suggestion; the other applies the one suggestion that is a change to the ticket —
 * the classification — and it does so by handing the values to the assistant service,
 * which passes them to the ticket service's own `reclassify`. Neither action sends a
 * draft, reassigns or resolves: those remain the ticket actions' jobs, with the ticket
 * service's permission checks in front of them. Keeping the send path out of the
 * assistant's own module is how "never auto-send" is enforced by shape rather than by
 * discipline.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireActor } from "../../lib/session";
import { assistServicesFor } from "../../lib/db";
import { ASSIST_KINDS, type AssistKind } from "../../lib/assist-service";
import { TICKET_PRIORITIES, TICKET_TYPES, type TicketPriority, type TicketType } from "../../lib/ticket-rules";

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

function homePath(role: string): string {
  return role === "REQUESTER" ? "/portal" : "/inbox";
}

/**
 * Record that an agent took — or left — one suggestion.
 *
 * The suggestion itself is not re-sent: only which of the four it was and where it came
 * from. That is deliberate, because the audit chain is not the place to copy a draft
 * reply into; what the desk needs afterwards is the *rate* and the *source*, and a
 * decision that carried the prose would put the requester's own words on the assurance
 * chain for no reason.
 */
export async function recordAssistDecisionAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const home = homePath(actor.role);
  const ticketId = text(formData, "ticketId");
  const rawKind = text(formData, "kind").toUpperCase();
  const kind = (ASSIST_KINDS as readonly string[]).includes(rawKind) ? (rawKind as AssistKind) : null;
  const accepted = formData.get("accepted") === "1";
  const source = text(formData, "source") === "model" ? "model" : "rules";

  if (!ticketId || !kind) {
    redirect(`${home}?error=${encodeURIComponent("Unknown suggestion.")}`);
  }

  const result = await assistServicesFor().decide(actor, ticketId, { kind, accepted, source });
  if (!result.ok) {
    redirect(`${home}/${ticketId}?assist=1&error=${encodeURIComponent(result.error)}`);
  }

  revalidatePath(`${home}/${ticketId}`);
  const note = accepted ? "Suggestion accepted" : "Suggestion dismissed";
  redirect(`${home}/${ticketId}?assist=1&flash=${encodeURIComponent(note)}`);
}

/**
 * Apply the accepted classification to the ticket.
 *
 * The form carries the type, priority and queue the panel showed; the assistant service
 * checks them against its closed sets and this desk's queues and then writes through the
 * ticket service, so a forged form can do no more than an agent editing the three fields
 * by hand. The queue is posted as an empty string when no queue was suggested, and turned
 * back into `null` here — the one piece of marshalling this layer owns.
 */
export async function applyAssistClassificationAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const home = homePath(actor.role);
  const ticketId = text(formData, "ticketId");
  const rawType = text(formData, "type").toUpperCase();
  const rawPriority = text(formData, "priority").toUpperCase();
  const queue = text(formData, "queueId");
  const source = text(formData, "source") === "model" ? "model" : "rules";

  const type = (TICKET_TYPES as readonly string[]).includes(rawType) ? (rawType as TicketType) : null;
  const priority = (TICKET_PRIORITIES as readonly string[]).includes(rawPriority) ? (rawPriority as TicketPriority) : null;
  if (!ticketId || !type || !priority) {
    redirect(`${home}?error=${encodeURIComponent("Unknown classification.")}`);
  }

  const result = await assistServicesFor().applyClassification(actor, ticketId, {
    type,
    priority,
    queueId: queue || null,
    source,
  });
  if (!result.ok) {
    redirect(`${home}/${ticketId}?assist=1&error=${encodeURIComponent(result.error)}`);
  }

  revalidatePath(`${home}/${ticketId}`);
  redirect(`${home}/${ticketId}?assist=1&flash=${encodeURIComponent("Classification applied")}`);
}
