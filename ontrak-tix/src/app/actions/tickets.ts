"use server";

/**
 * Ticket server actions (M0): the app-facing entry points for the M0 inbox.
 *
 * Every action's first step is `requireActor()`, and every decision after that
 * belongs to the ticket service — the actions only marshal form data, translate
 * a `ServiceResult` into a redirect, and revalidate the inbox. That keeps the
 * trust boundary in one audited place instead of spread across handlers.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { hasPermission, type Actor } from "../../lib/access-rules";
import { requireActor } from "../../lib/session";
import { ticketServices } from "../../lib/ticket-server";
import {
  cannedServicesFor,
  clientServicesFor,
  csatServicesFor,
  attachmentServicesFor,
  linkServicesFor,
  notificationServicesFor,
  savedViewServicesFor,
  templateServicesFor,
} from "../../lib/db";
import { scopeRefusal } from "../../lib/client-rules";
import { parseFilterJson } from "../../lib/saved-view-rules";
import { inboxFilterQuery } from "../../lib/inbox-view";
import { LINK_KINDS, type TicketLinkKind } from "../../lib/link-rules";
import { bulkFlashMessage, normalizeBulkIds, summarizeBulk, type BulkOutcome } from "../../lib/bulk-rules";
import { clampMinLevel } from "../../lib/notification-rules";
import {
  MESSAGE_KINDS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  type MessageKind,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
} from "../../lib/ticket-rules";

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

/** Where a caller lands after acting: requesters use the portal, staff the desk. */
function homePath(actor: Actor): string {
  return actor.role === "REQUESTER" ? "/portal" : "/inbox";
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

/**
 * Which of these tickets the actor may act on, and why not for the rest.
 *
 * The inbox worklist already hides a client the reader does not serve, but an
 * action carries a ticket id in a form and a hidden field is not a permission:
 * without this, an agent assigned to one client could still reply on, assign or
 * close another's work by posting an id they were never shown. The client scope
 * is computed once per call so a bulk edit asks the same question the same way.
 */
async function blockedByClientScope(actor: Actor, ticketIds: readonly string[]): Promise<Map<string, string>> {
  const blocked = new Map<string, string>();
  if (ticketIds.length === 0) return blocked;
  // Client scope is a staff rule. A requester reaches their own ticket through
  // `canReadTicket`, and filing that ticket under a client must not lock its
  // requester out of the conversation they are in.
  if (!hasPermission(actor.role, "ticket:read:any")) return blocked;

  const scope = await clientServicesFor().scope(actor);
  if (scope.kind === "all") return blocked;

  for (const ticketId of ticketIds) {
    const ticket = await ticketServices().store.findTicket(actor.tenantId, ticketId);
    // A ticket that does not exist is the service's own refusal to give.
    if (!ticket) continue;
    const refusal = scopeRefusal(scope, ticket.clientId);
    if (refusal) blocked.set(ticketId, refusal);
  }
  return blocked;
}

/** Raise a ticket. A requester is always the requester; staff may raise one for someone else. */
export async function createTicketAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const home = homePath(actor);
  const requesterId = text(formData, "requesterId");
  const queueId = text(formData, "queueId");
  const clientId = text(formData, "clientId");

  // A ticket may only be raised for a client the raiser serves, so the client
  // picker cannot be turned into a way of filing work into somebody else's desk.
  if (clientId) {
    const scope = await clientServicesFor().scope(actor);
    const refusal = scopeRefusal(scope, clientId);
    if (refusal) fail(`${home}/new`, refusal);
  }

  const result = await ticketServices().service.createTicket(actor, {
    subject: String(formData.get("subject") ?? ""),
    description: String(formData.get("description") ?? ""),
    type: pick<TicketType>(formData.get("type"), TICKET_TYPES, "INCIDENT"),
    priority: pick<TicketPriority>(formData.get("priority"), TICKET_PRIORITIES, "NORMAL"),
    ...(requesterId ? { requesterId } : {}),
    ...(queueId ? { queueId } : {}),
    ...(clientId ? { clientId } : {}),
  });

  if (!result.ok) fail(`${home}/new`, result.error);
  revalidatePath(home);
  redirect(`${home}/${result.value.id}?flash=Ticket+created`);
}

/** Append a public reply or an internal note to a ticket's thread. */
export async function replyAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const home = homePath(actor);
  const ticketId = text(formData, "ticketId");
  if (!ticketId) fail(home, "Choose a ticket first.");

  const blocked = await blockedByClientScope(actor, [ticketId]);
  if (blocked.has(ticketId)) fail(`${home}/${ticketId}`, blocked.get(ticketId) as string);

  const kind = pick<MessageKind>(formData.get("kind"), MESSAGE_KINDS, "PUBLIC_REPLY");
  const result = await ticketServices().service.reply(actor, ticketId, String(formData.get("body") ?? ""), kind);

  if (!result.ok) fail(`${home}/${ticketId}`, result.error);
  revalidatePath(`${home}/${ticketId}`);
  revalidatePath(home);
  redirect(`${home}/${ticketId}?flash=Reply+added`);
}

/** Move a ticket along the lifecycle. */
export async function setStatusAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const home = homePath(actor);
  const ticketId = text(formData, "ticketId");
  if (!ticketId) fail(home, "Choose a ticket first.");

  const blocked = await blockedByClientScope(actor, [ticketId]);
  if (blocked.has(ticketId)) fail(`${home}/${ticketId}`, blocked.get(ticketId) as string);

  const status = pick<TicketStatus>(formData.get("status"), TICKET_STATUSES, "OPEN");
  const result = await ticketServices().service.setStatus(actor, ticketId, status);

  if (!result.ok) fail(`${home}/${ticketId}`, result.error);

  // Resolving a ticket is the moment a satisfaction survey is earned. The
  // request is idempotent, and a CSAT failure must never block the resolve.
  if (result.value.status === "RESOLVED") {
    await csatServicesFor().requestSurvey(actor, result.value).catch(() => undefined);
  }

  revalidatePath(`${home}/${ticketId}`);
  revalidatePath(home);
  redirect(`${home}/${ticketId}?flash=Status+updated`);
}

/** Answer a satisfaction survey by its token. */
export async function submitCsatAction(formData: FormData): Promise<void> {
  await requireActor();
  const token = text(formData, "token");
  const score = Number(formData.get("score"));
  const comment = String(formData.get("comment") ?? "").trim();

  const result = await csatServicesFor().submit(token, score, comment || undefined);
  if (!result.ok) {
    redirect(`/portal?error=${encodeURIComponent(result.error)}`);
  }
  redirect("/portal?flash=Thanks+for+the+feedback");
}

/** Attach one or more files to a ticket the caller may reply on. */
export async function attachAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const home = homePath(actor);
  const ticketId = text(formData, "ticketId");
  if (!ticketId) fail(home, "Choose a ticket first.");

  const ticket = await ticketServices().store.findTicket(actor.tenantId, ticketId);
  if (!ticket) fail(home, "Ticket not found.");

  const uploads: { filename: string; contentType: string; data: Uint8Array }[] = [];
  for (const entry of formData.getAll("attachments")) {
    if (typeof entry === "string" || entry.size === 0) continue;
    uploads.push({
      filename: entry.name,
      contentType: entry.type || "application/octet-stream",
      data: new Uint8Array(await entry.arrayBuffer()),
    });
  }
  if (uploads.length === 0) fail(`${home}/${ticketId}`, "Choose at least one file.");

  const result = await attachmentServicesFor().attach(actor, ticket, uploads);
  if (!result.ok) fail(`${home}/${ticketId}`, result.error);
  revalidatePath(`${home}/${ticketId}`);
  redirect(`${home}/${ticketId}?flash=Attachment+added`);
}

/** Relate this ticket to another. The link is written in both directions. */
export async function linkAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const home = homePath(actor);
  const ticketId = text(formData, "ticketId");
  const toTicketId = text(formData, "toTicketId");
  if (!ticketId) fail(home, "Choose a ticket first.");

  const kind = pick<TicketLinkKind>(formData.get("kind"), LINK_KINDS, "RELATED");
  const result = await linkServicesFor().link(actor, ticketId, toTicketId, kind);
  if (!result.ok) fail(`${home}/${ticketId}`, result.error);

  revalidatePath(`${home}/${ticketId}`);
  redirect(`${home}/${ticketId}?flash=Ticket+linked`);
}

/**
 * Merge a duplicate into the ticket shown. The duplicate is closed and linked
 * forward; its conversation is folded into this one.
 */
export async function mergeAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const home = homePath(actor);
  const ticketId = text(formData, "ticketId");
  const duplicateId = text(formData, "duplicateId");
  if (!ticketId || !duplicateId) fail(home, "Choose a ticket first.");

  const result = await linkServicesFor().merge(actor, ticketId, duplicateId);
  if (!result.ok) fail(`${home}/${ticketId}`, result.error);

  revalidatePath(`${home}/${ticketId}`);
  revalidatePath(home);
  redirect(`${home}/${ticketId}?flash=Tickets+merged`);
}

/**
 * Apply one change to every selected ticket. Each ticket still goes through the
 * same service rule it would as a single edit, and the flash reports what was
 * skipped rather than pretending every row succeeded.
 */
export async function bulkAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const home = homePath(actor);
  const ids = normalizeBulkIds(formData.getAll("ticketIds"));
  if (ids.length === 0) fail(home, "Select at least one ticket.");

  const op = text(formData, "op") === "assign" ? "assign" : "status";
  const outcomes: BulkOutcome[] = [];
  // The selection arrives as ids from a form, so the client scope is asked about
  // every one of them; a blocked row is skipped into the honest summary rather
  // than silently counted as applied.
  const blocked = await blockedByClientScope(actor, ids);
  const assigneeId = op === "assign" ? text(formData, "assigneeId") || null : null;
  const status = pick<TicketStatus>(formData.get("status"), TICKET_STATUSES, "OPEN");

  for (const id of ids) {
    const refusal = blocked.get(id);
    if (refusal) {
      outcomes.push({ ticketId: id, ok: false, error: refusal });
      continue;
    }
    const result =
      op === "assign"
        ? await ticketServices().service.assign(actor, id, assigneeId)
        : await ticketServices().service.setStatus(actor, id, status);
    outcomes.push(result.ok ? { ticketId: id, ok: true } : { ticketId: id, ok: false, error: result.error });
  }

  const summary = summarizeBulk(outcomes);
  revalidatePath(home);
  redirect(`${home}?flash=${encodeURIComponent(bulkFlashMessage(summary, op === "assign" ? "reassigned" : "updated"))}`);
}

/** Save the caller's in-app notification preference (minimum level, mute). */
export async function saveNotificationPreferenceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  await notificationServicesFor().savePreference(actor, {
    minLevel: clampMinLevel(formData.get("minLevel")),
    muted: formData.get("muted") !== null,
  });
  revalidatePath("/notifications");
  redirect("/notifications?flash=Preferences+saved");
}

/**
 * Save the filter currently on screen as a named view. The filter travels as
 * JSON in a hidden field and is re-sanitized server-side, so a crafted form
 * cannot store a filter the inbox does not understand.
 */
export async function saveViewAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const result = await savedViewServicesFor().create(actor, {
    name: String(formData.get("name") ?? ""),
    filter: parseFilterJson(formData.get("filter")),
    shared: formData.get("shared") !== null,
  });
  if (!result.ok) redirect(`/inbox?error=${encodeURIComponent(result.error)}`);

  const params = new URLSearchParams(inboxFilterQuery(result.value.filter));
  params.set("flash", "View saved");
  redirect(`/inbox?${params.toString()}`);
}

/** Remove a saved view (its owner, or an admin). */
export async function deleteViewAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = text(formData, "id");
  const result = id ? await savedViewServicesFor().remove(actor, id) : { ok: false as const, error: "View not found." };
  if (!result.ok) redirect(`/inbox?error=${encodeURIComponent(result.error)}`);
  redirect("/inbox?flash=View+removed");
}

/** Mark one notification read. */
export async function readNotificationAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = text(formData, "id");
  if (id) await notificationServicesFor().markRead(actor, id);
  revalidatePath("/notifications");
  redirect("/notifications");
}

/** Mark every notification visible to the caller read. */
export async function readAllNotificationsAction(): Promise<void> {
  const actor = await requireActor();
  await notificationServicesFor().markAllRead(actor);
  revalidatePath("/notifications");
  redirect("/notifications");
}

/** Add a canned response to the desk library. */
export async function createCannedAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const result = await cannedServicesFor().create(actor, {
    title: String(formData.get("title") ?? ""),
    body: String(formData.get("body") ?? ""),
    shortcut: text(formData, "shortcut") || null,
  });
  if (!result.ok) redirect(`/canned?error=${encodeURIComponent(result.error)}`);
  revalidatePath("/canned");
  redirect("/canned?flash=Canned+response+saved");
}

/** Remove a canned response from the desk library. */
export async function deleteCannedAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = text(formData, "id");
  if (!id) redirect("/canned");
  const result = await cannedServicesFor().remove(actor, id);
  if (!result.ok) redirect(`/canned?error=${encodeURIComponent(result.error)}`);
  revalidatePath("/canned");
  redirect("/canned?flash=Canned+response+removed");
}

/** Save a reusable ticket shape. */
export async function createTemplateAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const result = await templateServicesFor().create(actor, {
    name: String(formData.get("name") ?? ""),
    subject: String(formData.get("subject") ?? ""),
    description: String(formData.get("description") ?? ""),
    type: pick<TicketType>(formData.get("type"), TICKET_TYPES, "INCIDENT"),
    priority: pick<TicketPriority>(formData.get("priority"), TICKET_PRIORITIES, "NORMAL"),
    queueId: text(formData, "queueId") || null,
  });
  if (!result.ok) redirect(`/templates?error=${encodeURIComponent(result.error)}`);
  revalidatePath("/templates");
  revalidatePath("/inbox/new");
  redirect("/templates?flash=Template+saved");
}

/** Remove a ticket template. */
export async function deleteTemplateAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = text(formData, "id");
  if (!id) redirect("/templates");
  const result = await templateServicesFor().remove(actor, id);
  if (!result.ok) redirect(`/templates?error=${encodeURIComponent(result.error)}`);
  revalidatePath("/templates");
  revalidatePath("/inbox/new");
  redirect("/templates?flash=Template+removed");
}

/** Assign or unassign a ticket. An empty assignee unassigns it. */
export async function assignAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const home = homePath(actor);
  const ticketId = text(formData, "ticketId");
  if (!ticketId) fail(home, "Choose a ticket first.");

  const blocked = await blockedByClientScope(actor, [ticketId]);
  if (blocked.has(ticketId)) fail(`${home}/${ticketId}`, blocked.get(ticketId) as string);

  const assigneeId = text(formData, "assigneeId") || null;
  const result = await ticketServices().service.assign(actor, ticketId, assigneeId);

  if (!result.ok) fail(`${home}/${ticketId}`, result.error);
  revalidatePath(`${home}/${ticketId}`);
  revalidatePath(home);
  redirect(`${home}/${ticketId}?flash=Assignment+updated`);
}
