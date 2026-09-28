"use server";

/**
 * Security-console server actions (M2).
 *
 * The triage actions a person takes on the alert stream: open an incident,
 * record a false-positive verdict, and configure a suppression. Each one first
 * checks the caller may triage, then delegates to the promotion service — so the
 * access rule and the decision both stay where they belong, and the action only
 * marshals a form and reports the outcome.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { hasPermission, type Actor } from "../../lib/access-rules";
import { requireActor } from "../../lib/session";
import { alertPromotionServicesFor, securityAlertServicesFor } from "../../lib/db";
import {
  SUPPRESSION_FIELDS,
  VERDICT_KINDS,
  type SuppressionField,
  type VerdictKind,
} from "../../lib/alert-promotion-rules";

function ok(message: string): never {
  revalidatePath("/security");
  redirect(`/security?flash=${encodeURIComponent(message)}`);
}

function fail(message: string): never {
  redirect(`/security?error=${encodeURIComponent(message)}`);
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

/** Triage is staff work: anyone who may update a ticket may judge an alert. */
function assertCanTriage(actor: Actor): void {
  if (!hasPermission(actor.role, "ticket:update")) fail("You cannot triage security alerts.");
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Open an incident from an alert. The acting staff member is the requester — an
 * alert has no end user — so the incident is owned by the desk from the start.
 */
export async function promoteAlertAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  assertCanTriage(actor);
  const alertId = text(formData, "alertId");
  if (!alertId) fail("Choose an alert first.");

  const result = await alertPromotionServicesFor().promote(actor, alertId, { requesterId: actor.id });
  if (!result.ok) fail(result.error);

  const { decision, ticket, alreadyPromoted } = result.value;
  if (alreadyPromoted) ok("That alert already had an incident.");
  if (decision.outcome === "PROMOTE" && ticket) ok(`Incident ${ticket.ref} opened.`);
  if (decision.outcome === "SUPPRESS") ok("That alert is suppressed; the reason is on the alert.");
  ok("That alert is below the promotion bar — it stays in the stream.");
}

/** Record a verdict on a detection, which feeds false-positive suppression. */
export async function recordAlertVerdictAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  assertCanTriage(actor);
  const alertId = text(formData, "alertId");
  if (!alertId) fail("Choose an alert first.");

  const alert = await securityAlertServicesFor().get(actor.tenantId, alertId);
  if (!alert) fail("Alert not found.");

  const verdict = pick<VerdictKind>(formData.get("verdict"), VERDICT_KINDS, "FALSE_POSITIVE");
  const note = text(formData, "note");
  await alertPromotionServicesFor().recordVerdict(actor, {
    signature: alert.signature,
    verdict,
    ...(note ? { note } : {}),
  });

  ok(`Recorded a ${verdict.replace("_", " ").toLowerCase()} verdict for "${alert.signature}".`);
}

/** Configure a suppression rule for the tenant. */
export async function addSuppressionAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  assertCanTriage(actor);

  const match = text(formData, "match");
  if (!match) fail("A suppression needs something to match.");

  const until = text(formData, "until");
  let untilIso: string | null = null;
  if (until) {
    const parsed = new Date(until);
    if (Number.isNaN(parsed.getTime())) fail("The suppression expiry was not a valid date.");
    untilIso = parsed.toISOString();
  }

  const reason = text(formData, "reason");
  await alertPromotionServicesFor().addSuppression(actor, {
    field: pick<SuppressionField>(formData.get("field"), SUPPRESSION_FIELDS, "signature"),
    match,
    reason: reason || "Configured from the security console.",
    until: untilIso,
  });

  ok("Suppression rule saved.");
}
