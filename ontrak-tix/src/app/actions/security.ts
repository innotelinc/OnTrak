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

import { actorHasPermission, type Actor } from "../../lib/access-rules";
import { requireActor } from "../../lib/session";
import { alertPromotionServicesFor, securityAlertServicesFor, sentinelContainmentServicesFor } from "../../lib/db";
import { sentinelTargetGaps } from "../../lib/sentinel-containment";
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
  if (!actorHasPermission(actor, "ticket:update")) fail("You cannot triage security alerts.");
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

  /*
   * The answer follows the *decision*, not the fact that a decision was already on file.
   * Reading "already had an incident" back to somebody who has just clicked on a suppressed
   * alert is how this used to read — the suppression is the thing they need told, and it is
   * the reason this action exists at all for a re-clicked alert.
   */
  const { decision, ticket, alreadyPromoted } = result.value;
  if (decision.outcome === "SUPPRESS") ok("That alert is suppressed; the reason is on the alert.");
  if (ticket) {
    ok(alreadyPromoted ? `Incident ${ticket.ref} was already open for that alert.` : `Incident ${ticket.ref} opened.`);
  }
  if (alreadyPromoted) ok("That alert was already decided — there is nothing new to do.");
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

/**
 * Ask OnTrak Sentinel to contain what an alert names.
 *
 * Triaging permission, not administrator permission, and the asymmetry is deliberate: this
 * action **asks**. Sentinel's safe-list, blast-radius cap, hourly limit and second-approver
 * rule all still run there, a desk request always needs a Sentinel administrator to approve it,
 * and every outcome — applied, pending, refused — is written back onto the alert and onto the
 * tenant's hash chain. So the worst an over-eager triager can do here is create a proposal
 * somebody else has to say yes to, which is exactly the blast radius this should have.
 */
export async function requestContainmentAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  assertCanTriage(actor);

  const alertId = text(formData, "alertId");
  if (!alertId) fail("Choose an alert first.");

  const service = sentinelContainmentServicesFor();
  if (!service) {
    // Name the variables rather than saying "not configured": a deployment that meant to wire
    // this up is one environment variable away, and one that did not is told so plainly.
    const missing = sentinelTargetGaps();
    fail(`This desk is not configured to contain anything in Sentinel (missing ${missing.join(", ")}).`);
  }

  const reason = text(formData, "reason");
  if (!reason) fail("Say why; the reason is what Sentinel's audit row and this one record.");

  // The label is carried in the form rather than looked up: it is what Sentinel's audit row
  // shows as the person who asked, and an id alone reads as a machine having decided.
  const label = text(formData, "requestedByLabel") || actor.id;

  const result = await service.request({
    tenantId: actor.tenantId,
    alertId,
    reason,
    requestedBy: { id: actor.id, label, role: actor.role },
  });
  if (!result.ok) fail(result.error);

  ok(result.value.message);
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
