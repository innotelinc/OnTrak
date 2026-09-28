"use server";

/**
 * Incident console server actions (M3).
 *
 * Declaring, advancing, staffing, running a playbook step and collecting
 * evidence — each delegates to the incident services, which enforce the access
 * rule and write both the timeline entry and the audit event. The actions only
 * marshal a form and report the outcome.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireActor } from "../../lib/session";
import { complianceServicesFor, incidentDocsServicesFor, incidentServicesFor } from "../../lib/db";
import {
  INCIDENT_IMPACTS,
  INCIDENT_PHASES,
  INCIDENT_ROLES,
  INCIDENT_SEVERITIES,
  INCIDENT_URGENCIES,
  type IncidentImpact,
  type IncidentPhase,
  type IncidentRole,
  type IncidentSeverity,
  type IncidentUrgency,
} from "../../lib/incident-rules";
import { EVIDENCE_KINDS, type EvidenceKind } from "../../lib/evidence-rules";

function ok(message: string): never {
  revalidatePath("/incidents");
  redirect(`/incidents?flash=${encodeURIComponent(message)}`);
}

function fail(message: string): never {
  redirect(`/incidents?error=${encodeURIComponent(message)}`);
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Declare an incident. The matrix decides the severity unless one is supplied. */
export async function declareIncidentAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const severityText = text(formData, "severity");
  const detectedAt = text(formData, "detectedAt");

  const result = await incidentServicesFor().declare(actor, {
    title: String(formData.get("title") ?? ""),
    summary: String(formData.get("summary") ?? ""),
    impact: pick<IncidentImpact>(formData.get("impact"), INCIDENT_IMPACTS, "MODERATE"),
    urgency: pick<IncidentUrgency>(formData.get("urgency"), INCIDENT_URGENCIES, "MEDIUM"),
    ...(severityText ? { severity: pick<IncidentSeverity>(severityText, INCIDENT_SEVERITIES, "SEV3") } : {}),
    ...(detectedAt ? { detectedAt: new Date(detectedAt).toISOString() } : {}),
    ticketId: text(formData, "ticketId") || null,
    ...(text(formData, "alertId") ? { alertId: text(formData, "alertId") } : {}),
  });
  if (!result.ok) fail(result.error);

  // Put the incident on its playbook straight away: a declared incident with no
  // plan is how the first ten minutes get lost.
  await incidentDocsServicesFor().startPlaybook(actor, result.value.id);
  ok(`Incident ${result.value.ref} declared (${result.value.severity}).`);
}

/** Move an incident to another phase. */
export async function advanceIncidentAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  if (!incidentId) fail("Choose an incident first.");

  const to = pick<IncidentPhase>(formData.get("to"), INCIDENT_PHASES, "TRIAGED");
  const result = await incidentServicesFor().advance(actor, incidentId, to);
  if (!result.ok) fail(result.error);
  ok(`Incident moved to ${to.toLowerCase()}.`);
}

/** Assign or clear an incident role. */
export async function assignIncidentRoleAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  if (!incidentId) fail("Choose an incident first.");

  const role = pick<IncidentRole>(formData.get("role"), INCIDENT_ROLES, "COMMANDER");
  const userId = text(formData, "userId") || null;
  const result = await incidentServicesFor().assignRole(actor, incidentId, role, userId);
  if (!result.ok) fail(result.error);
  ok(userId ? "Role assigned." : "Role cleared.");
}

/** Append a free-text timeline note. */
export async function addIncidentNoteAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  if (!incidentId) fail("Choose an incident first.");

  const result = await incidentServicesFor().addNote(actor, incidentId, String(formData.get("summary") ?? ""));
  if (!result.ok) fail(result.error);
  ok("Note added to the timeline.");
}

/** Start the playbook for an incident that has none. */
export async function startPlaybookAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  if (!incidentId) fail("Choose an incident first.");

  const result = await incidentDocsServicesFor().startPlaybook(actor, incidentId);
  if (!result.ok) fail(result.error);
  ok(`Playbook started (${result.value.length} steps).`);
}

/** Complete, skip or reopen one playbook step. */
export async function playbookStepAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  const key = text(formData, "key");
  if (!incidentId || !key) fail("Choose an incident and a step first.");

  const op = text(formData, "op");
  const docs = incidentDocsServicesFor();
  const result =
    op === "skip"
      ? await docs.skipStep(actor, incidentId, key, text(formData, "note"))
      : op === "reopen"
        ? await docs.reopenStep(actor, incidentId, key)
        : await docs.completeStep(actor, incidentId, key, text(formData, "note") || undefined);

  if (!result.ok) fail(result.error);
  ok(op === "skip" ? "Step skipped." : op === "reopen" ? "Step reopened." : "Step completed.");
}

/** Record a piece of evidence for an incident. */
export async function recordEvidenceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  if (!incidentId) fail("Choose an incident first.");

  const result = await incidentDocsServicesFor().recordEvidence(actor, incidentId, {
    kind: pick<EvidenceKind>(formData.get("kind"), EVIDENCE_KINDS, "NOTE"),
    label: String(formData.get("label") ?? ""),
    reference: String(formData.get("reference") ?? ""),
    sha256: text(formData, "sha256") || null,
    note: text(formData, "note") || null,
  });
  if (!result.ok) fail(result.error);
  ok("Evidence recorded.");
}

/**
 * Upload an artifact: store its bytes under object lock, and record it as
 * evidence.
 *
 * The digest and the storage key are computed from the bytes that actually
 * arrived, never from anything the browser said about the file, so a renamed or
 * misdescribed upload cannot put one artifact's label on another's content.
 */
export async function uploadArtifactAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  if (!incidentId) fail("Choose an incident first.");

  const upload = formData.get("file");
  if (!(upload instanceof File) || upload.size === 0) fail("Choose a file to store.");

  const bytes = new Uint8Array(await upload.arrayBuffer());
  const result = await incidentDocsServicesFor().recordArtifact(actor, incidentId, {
    kind: pick<EvidenceKind>(formData.get("kind"), EVIDENCE_KINDS, "FILE"),
    label: String(formData.get("label") ?? "") || upload.name,
    contentType: upload.type || "application/octet-stream",
    bytes,
    note: text(formData, "note") || null,
  });
  if (!result.ok) fail(result.error);

  const { artifact, stored } = result.value;
  ok(
    stored === "unchanged"
      ? `Those bytes were already stored; recorded another collection under ${artifact.mode} retention.`
      : `Artifact stored under ${artifact.mode} retention until ${artifact.retainUntil.slice(0, 10)}.`,
  );
}

/**
 * Remove an artifact's bytes, if the retention rules allow it now.
 *
 * A refusal is reported as a failure with the rule's own words, because "you
 * cannot remove this yet, and here is why" is the answer the operator needs.
 */
export async function purgeArtifactAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  const artifactId = text(formData, "artifactId");
  if (!incidentId || !artifactId) fail("Choose an incident and an artifact first.");

  const result = await incidentDocsServicesFor().purgeArtifact(actor, incidentId, artifactId, {
    reason: text(formData, "reason"),
    bypassGovernance: formData.get("bypass") === "on",
  });
  if (!result.ok) fail(result.error);
  ok("Artifact purged, and the removal is on the record.");
}

/** Hand an evidence item to a new custodian. */
export async function transferEvidenceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  const evidenceId = text(formData, "evidenceId");
  if (!incidentId || !evidenceId) fail("Choose an incident and a piece of evidence first.");

  const result = await incidentDocsServicesFor().transferEvidence(actor, incidentId, evidenceId, {
    toActor: text(formData, "toActor"),
    reason: text(formData, "reason"),
  });
  if (!result.ok) fail(result.error);
  ok(`Custody moved to ${result.value.toActor}.`);
}

/** Place a legal hold, which stops routine retention. */
export async function placeLegalHoldAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  if (!incidentId) fail("Choose an incident first.");

  const result = await incidentDocsServicesFor().placeLegalHold(actor, incidentId, text(formData, "reason"));
  if (!result.ok) fail(result.error);
  ok("Legal hold placed.");
}

/** Release a legal hold, recording why. */
export async function releaseLegalHoldAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  if (!incidentId) fail("Choose an incident first.");

  const result = await incidentDocsServicesFor().releaseLegalHold(actor, incidentId, text(formData, "reason"));
  if (!result.ok) fail(result.error);
  ok("Legal hold released.");
}

/* ------------------------------------------------- regulatory notifications */

/** Adopt a notification regime, which starts its clock. */
export async function trackNotificationAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  if (!incidentId) fail("Choose an incident first.");

  const result = await complianceServicesFor().track(actor, incidentId, text(formData, "regime"), text(formData, "note"));
  if (!result.ok) fail(result.error);
  ok(`${result.value.label} is now tracked (due ${result.value.dueAt}).`);
}

/** Mark a tracked notification sent. */
export async function sendNotificationAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  const notificationId = text(formData, "notificationId");
  if (!incidentId || !notificationId) fail("Choose an incident and a notification first.");

  const result = await complianceServicesFor().markSent(actor, incidentId, notificationId, {
    reference: text(formData, "reference"),
    note: text(formData, "note"),
  });
  if (!result.ok) fail(result.error);
  ok(`${result.value.label} marked sent.`);
}

/** Record that the authority acknowledged a notification. */
export async function acknowledgeNotificationAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  const notificationId = text(formData, "notificationId");
  if (!incidentId || !notificationId) fail("Choose an incident and a notification first.");

  const result = await complianceServicesFor().acknowledge(actor, incidentId, notificationId);
  if (!result.ok) fail(result.error);
  ok("Notification acknowledged.");
}

/** Record a decision that a notification did not apply. */
export async function waiveNotificationAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  const notificationId = text(formData, "notificationId");
  if (!incidentId || !notificationId) fail("Choose an incident and a notification first.");

  const result = await complianceServicesFor().waive(actor, incidentId, notificationId, text(formData, "reason"));
  if (!result.ok) fail(result.error);
  ok("Notification waived.");
}

/* ------------------------------------------------------ post-incident review */

/** Publish the review, with the actions it creates. */
export async function publishReviewAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  if (!incidentId) fail("Choose an incident first.");

  // The form offers two action rows: one required, one optional. A row with no
  // title is simply not an action, so the second can be left blank.
  const actions = [0, 1]
    .map((index) => ({
      title: text(formData, `actionTitle-${index}`),
      ownerId: text(formData, `actionOwner-${index}`),
      dueAt: text(formData, `actionDue-${index}`),
      note: text(formData, `actionNote-${index}`) || null,
    }))
    .filter((action) => action.title !== "");

  const result = await complianceServicesFor().publish(actor, incidentId, {
    findings: String(formData.get("findings") ?? ""),
    lessons: String(formData.get("lessons") ?? ""),
    actions,
  });
  if (!result.ok) fail(result.error);
  ok(`Review published with ${result.value.actions.length} action(s).`);
}

/** Add an action to a published review. */
export async function addReviewActionAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  if (!incidentId) fail("Choose an incident first.");

  const result = await complianceServicesFor().addAction(actor, incidentId, {
    title: String(formData.get("title") ?? ""),
    ownerId: text(formData, "ownerId"),
    dueAt: text(formData, "dueAt"),
    note: text(formData, "note") || null,
  });
  if (!result.ok) fail(result.error);
  ok("Action added to the review.");
}

/** Mark a review action done, started, or dropped. */
export async function reviewActionStateAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const incidentId = text(formData, "incidentId");
  const actionId = text(formData, "actionId");
  if (!incidentId || !actionId) fail("Choose an incident and an action first.");

  const op = text(formData, "op");
  const compliance = complianceServicesFor();
  const result =
    op === "start"
      ? await compliance.startAction(actor, incidentId, actionId)
      : op === "drop"
        ? await compliance.dropAction(actor, incidentId, actionId, text(formData, "reason"))
        : await compliance.completeAction(actor, incidentId, actionId, text(formData, "note") || undefined);

  if (!result.ok) fail(result.error);
  ok(op === "start" ? "Action started." : op === "drop" ? "Action dropped." : "Action completed.");
}
