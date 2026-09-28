"use server";

/**
 * Client console server actions (M4).
 *
 * Each one marshals a form and reports the outcome; the access rule, the client
 * scope and the record-keeping all live in `client-service.ts`, so a page cannot
 * bypass them by posting a different id.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireActor } from "../../lib/session";
import { clientServicesFor } from "../../lib/db";

function ok(message: string): never {
  revalidatePath("/clients");
  redirect(`/clients?flash=${encodeURIComponent(message)}`);
}

function fail(message: string): never {
  redirect(`/clients?error=${encodeURIComponent(message)}`);
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

/** Create a client. */
export async function createClientAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const result = await clientServicesFor().create(actor, { name: text(formData, "name") });
  if (!result.ok) fail(result.error);
  ok(`${result.value.name} added.`);
}

/** Add a person at a client. */
export async function addContactAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const clientId = text(formData, "clientId");
  if (!clientId) fail("Choose a client first.");

  const result = await clientServicesFor().addContact(actor, clientId, {
    name: text(formData, "name"),
    email: text(formData, "email"),
  });
  if (!result.ok) fail(result.error);
  ok(`${result.value.name} added as a contact.`);
}

/** Put an agent on a client — the assignment that scopes their worklist. */
export async function assignClientAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const clientId = text(formData, "clientId");
  const userId = text(formData, "userId");
  if (!clientId || !userId) fail("Choose a client and a person.");

  const result = await clientServicesFor().assign(actor, clientId, userId);
  if (!result.ok) fail(result.error);
  ok("Assignment recorded.");
}

/** Take an agent off a client. */
export async function unassignClientAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const clientId = text(formData, "clientId");
  const userId = text(formData, "userId");
  if (!clientId || !userId) fail("Choose a client and a person.");

  const result = await clientServicesFor().unassign(actor, clientId, userId);
  if (!result.ok) fail(result.error);
  ok("Assignment removed.");
}

/**
 * Open (or close) an act-as window. Both are recorded: the window is a row the
 * console can show, and the start and the end are audit events with the reason.
 */
export async function startActAsAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const clientId = text(formData, "clientId");
  if (!clientId) fail("Choose a client first.");

  const result = await clientServicesFor().startActingAs(actor, clientId, text(formData, "reason"));
  if (!result.ok) fail(result.error);
  ok(`Acting as the client until ${result.value.expiresAt}.`);
}

export async function endActAsAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const sessionId = text(formData, "sessionId");
  if (!sessionId) fail("That act-as window is not open.");

  const result = await clientServicesFor().endActingAs(actor, sessionId, text(formData, "endReason"));
  if (!result.ok) fail(result.error);
  ok("No longer acting as the client.");
}
