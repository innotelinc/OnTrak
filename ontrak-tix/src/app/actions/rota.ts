"use server";

/**
 * Rota server actions (M4): publishing cover and recording the handover.
 *
 * The service decides who may publish, refuses a shift that double-books
 * somebody, and resolves who is actually on duty before accepting a handoff — so
 * a form here cannot invent cover that does not exist or a handoff from somebody
 * who was not on.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireActor } from "../../lib/session";
import { rotaServicesFor } from "../../lib/db";

function back(to: string, message: string, kind: "flash" | "error" = "flash"): never {
  revalidatePath(to.split("?")[0] || "/handoff");
  const joiner = to.includes("?") ? "&" : "?";
  redirect(`${to}${joiner}${kind}=${encodeURIComponent(message)}`);
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

/** Read a form timestamp as an instant. A local `datetime-local` is UTC here. */
function instant(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/** Publish a shift, or an on-call window, onto the rota. */
export async function addShiftAction(formData: FormData): Promise<void> {
  const actor = await requireActor();

  const result = await rotaServicesFor().addShift(actor, {
    userId: text(formData, "userId"),
    queueId: text(formData, "queueId") || null,
    kind: text(formData, "kind") === "ON_CALL" ? "ON_CALL" : "SHIFT",
    startsAt: instant(text(formData, "startsAt")),
    endsAt: instant(text(formData, "endsAt")),
    note: text(formData, "note"),
  });
  if (!result.ok) back("/handoff", result.error, "error");

  revalidatePath("/handoff");
  back(
    "/handoff",
    `${result.value.userId} is on ${result.value.kind === "ON_CALL" ? "call" : "shift"} from ${result.value.startsAt} to ${result.value.endsAt}.`,
  );
}

export async function removeShiftAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const shiftId = text(formData, "shiftId");
  if (!shiftId) back("/handoff", "Choose a shift first.", "error");

  const result = await rotaServicesFor().removeShift(actor, shiftId);
  if (!result.ok) back("/handoff", result.error, "error");
  revalidatePath("/handoff");
  back("/handoff", `${result.value.userId}'s ${result.value.kind === "ON_CALL" ? "on-call window" : "shift"} removed.`);
}

/**
 * Record a handover. The tickets being handed over arrive as newline-separated
 * references — the thing a person can paste from a worklist — and are named on
 * the record rather than counted, because "three open tickets" tells the next
 * shift nothing it can act on.
 */
export async function recordHandoffAction(formData: FormData): Promise<void> {
  const actor = await requireActor();

  const result = await rotaServicesFor().recordHandoff(actor, {
    queueId: text(formData, "queueId") || null,
    toUserId: text(formData, "toUserId") || null,
    note: text(formData, "note"),
    openTicketRefs: text(formData, "openTicketRefs")
      .split(/[\s,]+/)
      .map((ref) => ref.trim())
      .filter(Boolean),
  });
  if (!result.ok) back("/handoff", result.error, "error");

  revalidatePath("/handoff");
  back(
    "/handoff",
    `Handed over${result.value.toUserId ? ` to ${result.value.toUserId}` : ""} with ${result.value.openTicketRefs.length} ticket${result.value.openTicketRefs.length === 1 ? "" : "s"} named.`,
  );
}
