"use server";

/**
 * Assist server actions (M7).
 *
 * There is exactly one action here, and that is the point: the assistant *proposes*, and
 * the only thing the desk can do through this module is say what it thought of a
 * proposal. There is no action that sends a draft, changes a priority or moves a queue —
 * those remain the ticket actions' jobs, with the ticket service's own permission checks
 * in front of them. Keeping the send path out of the assistant's own module is how
 * "never auto-send" is enforced by shape rather than by discipline.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireActor } from "../../lib/session";
import { assistServicesFor } from "../../lib/db";
import { ASSIST_KINDS, type AssistKind } from "../../lib/assist-service";

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
