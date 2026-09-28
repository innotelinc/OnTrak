/**
 * Evidence rules (M3): what a piece of evidence is, and how the manifest that
 * stands behind an incident is assembled.
 *
 * The credibility of an incident record rests on two things: that the evidence
 * was collected *contemporaneously*, and that the collection can be shown not to
 * have been edited afterwards. So:
 *
 *  - every item records what it is, where it lives (`reference` — a storage key
 *    or a URL, never the payload itself), who collected it and when;
 *  - a collected file carries the `sha256` of its bytes, so a later copy can be
 *    shown to be the same bytes;
 *  - the **manifest** is a deterministic document — the incident's facts, its
 *    playbook steps, its evidence and its timeline — digested with a hash. The
 *    same content always produces the same digest, so any edit to the record
 *    changes it, and the digest can be kept outside the database (in an email, a
 *    signed audit log) as a cheap integrity anchor.
 *
 * Pure: the hash function is injected, exactly as the audit chain does it, so
 * this is testable and reusable outside a request.
 */

import { stableStringify, type HashFn } from "./audit-chain";
import type { StepStatus } from "./playbook-rules";

export type EvidenceKind = "LOG" | "SNAPSHOT" | "SCREENSHOT" | "FILE" | "NOTE" | "LINK";
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ["LOG", "SNAPSHOT", "SCREENSHOT", "FILE", "NOTE", "LINK"];

export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return typeof value === "string" && (EVIDENCE_KINDS as readonly string[]).includes(value);
}

export interface EvidenceInput {
  kind: EvidenceKind;
  /** What this is, in the responder's words. */
  label: string;
  /** Where it lives: a storage key, an object URL, a ticket ref. Never the bytes. */
  reference: string;
  /** The digest of the collected bytes, when there are bytes. */
  sha256?: string | null;
  note?: string | null;
}

export interface EvidenceItem extends EvidenceInput {
  id: string;
  tenantId: string;
  incidentId: string;
  collectedBy: string;
  collectedAt: string;
}

export const EVIDENCE_LABEL_MAX = 200;
export const EVIDENCE_REFERENCE_MAX = 500;

/** Validate a piece of evidence before it is recorded. */
export function validateEvidence(input: Partial<EvidenceInput>): string[] {
  const issues: string[] = [];
  const label = input.label?.trim() ?? "";
  if (!label) issues.push("A label is required.");
  else if (label.length > EVIDENCE_LABEL_MAX) issues.push(`The label may be at most ${EVIDENCE_LABEL_MAX} characters.`);

  const reference = input.reference?.trim() ?? "";
  if (!reference) issues.push("A reference is required.");
  else if (reference.length > EVIDENCE_REFERENCE_MAX) issues.push(`The reference may be at most ${EVIDENCE_REFERENCE_MAX} characters.`);

  if (input.kind !== undefined && !isEvidenceKind(input.kind)) issues.push(`Unknown evidence kind "${input.kind}".`);
  if (input.sha256 != null && !/^[a-f0-9]{64}$/i.test(input.sha256.trim())) {
    issues.push("A checksum must be a SHA-256 hex digest.");
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/*  Chain of custody                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Custody is a *trail*, not a field. An item is collected by someone, and every
 * later hand-off is another entry, so "who held this, when, and why did it
 * move?" is answered by walking entries rather than by trusting one column.
 */
export type CustodyAction = "COLLECTED" | "TRANSFERRED";
export const CUSTODY_ACTIONS: readonly CustodyAction[] = ["COLLECTED", "TRANSFERRED"];

export function isCustodyAction(value: unknown): value is CustodyAction {
  return typeof value === "string" && (CUSTODY_ACTIONS as readonly string[]).includes(value);
}

export interface CustodyEntry {
  id: string;
  tenantId: string;
  incidentId: string;
  evidenceId: string;
  at: string;
  action: CustodyAction;
  /** Who held it before the hand-off. */
  fromActor: string;
  /** Who holds it after. */
  toActor: string;
  reason: string | null;
}

export const CUSTODY_REASON_MAX = 500;

export interface CustodyTransferInput {
  toActor?: string;
  reason?: string;
}

/**
 * Validate a hand-off. A transfer needs a recipient and a reason: "the disk was
 * handed to the security team" is the entry that makes the trail meaningful, and
 * one without a reason is exactly what an auditor asks about.
 */
export function validateCustodyTransfer(input: CustodyTransferInput): string[] {
  const issues: string[] = [];
  const to = (input.toActor ?? "").trim();
  if (!to) issues.push("Name who is taking custody.");

  const reason = (input.reason ?? "").trim();
  if (!reason) issues.push("A hand-off needs a reason.");
  else if (reason.length > CUSTODY_REASON_MAX) issues.push(`The reason may be at most ${CUSTODY_REASON_MAX} characters.`);

  return issues;
}

/** The trail in the order it happened; ties broken by id so it is deterministic. */
export function custodyTrail(entries: readonly CustodyEntry[]): CustodyEntry[] {
  return [...entries].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

export type CustodyIntegrity =
  | { ok: true; holder: string; entries: number }
  | { ok: false; reason: string };

/**
 * Walk a trail and report whether it is unbroken: every hand-off must start from
 * the holder the previous one left, beginning with the collector. A gap means an
 * entry is missing (or was removed), which is the thing the trail exists to
 * detect.
 */
export function custodyIntegrity(entries: readonly CustodyEntry[], collectedBy: string): CustodyIntegrity {
  const trail = custodyTrail(entries);
  if (trail.length === 0) return { ok: false, reason: "There is no custody entry for this item." };

  const evidenceId = trail[0].evidenceId;
  let holder = collectedBy;
  for (const entry of trail) {
    if (entry.evidenceId !== evidenceId) {
      return { ok: false, reason: "The trail mixes entries for more than one item." };
    }
    if (entry.action === "COLLECTED") {
      if (entry.fromActor !== collectedBy || entry.toActor !== collectedBy) {
        return { ok: false, reason: "The collection entry does not match the collector." };
      }
      holder = entry.toActor;
      continue;
    }
    if (entry.fromActor !== holder) {
      return { ok: false, reason: `Custody jumps from "${holder}" to "${entry.fromActor}" before "${entry.toActor}".` };
    }
    holder = entry.toActor;
  }
  return { ok: true, holder, entries: trail.length };
}

/* -------------------------------------------------------------------------- */
/*  Legal hold & retention                                                    */
/* -------------------------------------------------------------------------- */

export interface LegalHold {
  id: string;
  tenantId: string;
  incidentId: string;
  reason: string;
  placedBy: string;
  placedAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
}

/** A hold is in force until it is explicitly released. */
export function holdActive(hold: LegalHold | null | undefined): boolean {
  return Boolean(hold && hold.releasedAt === null);
}

/** The routine retention window for incident evidence, in days (ten years). */
export const EVIDENCE_RETENTION_DAYS = 3650;

export type RetentionAction = "blocked" | "retain" | "eligible";

export interface RetentionDecision {
  action: RetentionAction;
  /** When the window closes and the item could be purged, absent a hold. */
  eligibleAt: string;
  reason: string;
}

/**
 * Whether evidence may be aged out. A legal hold outranks the retention clock —
 * the point of a hold is that routine deletion stops — so the decision says
 * `blocked` for as long as one is in force, whatever the dates say.
 */
export function retentionDecision(input: {
  hold: LegalHold | null;
  collectedAt: string;
  now: string;
  retentionDays?: number;
}): RetentionDecision {
  const days = input.retentionDays ?? EVIDENCE_RETENTION_DAYS;
  const collected = new Date(input.collectedAt).getTime();
  const eligibleAt = new Date(collected + days * 24 * 60 * 60 * 1000).toISOString();

  if (holdActive(input.hold)) {
    return { action: "blocked", eligibleAt, reason: "A legal hold is in place, so routine retention cannot purge this item." };
  }
  if (new Date(input.now).getTime() < new Date(eligibleAt).getTime()) {
    return { action: "retain", eligibleAt, reason: `Retained for ${days} days from collection.` };
  }
  return { action: "eligible", eligibleAt, reason: `The ${days}-day retention window has closed.` };
}

/* -------------------------------------------------------------------------- */
/*  The manifest                                                              */
/* -------------------------------------------------------------------------- */

/** The canonical content of one evidence item, which its digest commits to. */
export function evidencePayload(item: {
  kind: string;
  label: string;
  reference: string;
  sha256?: string | null;
  collectedBy: string;
  collectedAt: string;
}): string {
  return stableStringify({
    kind: item.kind,
    label: item.label,
    reference: item.reference,
    sha256: item.sha256 ?? null,
    collectedBy: item.collectedBy,
    collectedAt: item.collectedAt,
  });
}

/** The digest of one evidence item, so a later copy can be shown to match. */
export function evidenceDigest(
  item: { kind: string; label: string; reference: string; sha256?: string | null; collectedBy: string; collectedAt: string },
  hash: HashFn,
): string {
  return hash(evidencePayload(item));
}

export interface ManifestInput {
  incident: {
    ref: string;
    title: string;
    severity: string;
    phase: string;
    detectedAt: string;
    declaredAt: string;
    roles: { role: string; userId: string | null }[];
  };
  steps: { key: string; title: string; status: StepStatus; completedAt: string | null; completedBy: string | null }[];
  evidence: {
    id: string;
    kind: string;
    label: string;
    reference: string;
    sha256?: string | null;
    collectedBy: string;
    collectedAt: string;
  }[];
  timeline: { at: string; kind: string; actor: string; summary: string }[];
  /**
   * The custody trail. Part of the record, so it is digested with everything
   * else — a quietly removed hand-off changes the hash.
   */
  custody?: CustodyEntry[];
  /** The legal hold in force, when there is one. */
  legalHold?: LegalHold | null;
  /**
   * The stored artifacts behind some of the evidence, and the object-lock
   * retention each one carries (`object-lock-rules.ts`). Part of the record
   * because an auditor wants to know not only that evidence exists but that its
   * bytes are locked, until when, and whether they were ever removed — and a
   * purge has to be visible, not invisible.
   */
  artifacts?: ArtifactManifestEntry[];
  generatedAt: string;
}

/** One stored artifact, as the manifest and the packet report it. */
export interface ArtifactManifestEntry {
  /** Content-addressed storage key: `evidence/<tenant>/<incident>/<sha256>`. */
  key: string;
  sha256: string;
  bytes: number;
  contentType: string;
  /** The object-lock retention mode applied when it was stored. */
  mode: string;
  retainUntil: string;
  lockedAt: string;
  /** Set once the retention policy permitted the bytes to be removed. */
  purgedAt?: string | null;
}

export interface EvidenceManifest {
  incident: ManifestInput["incident"];
  generatedAt: string;
  steps: ManifestInput["steps"];
  evidence: (Omit<ManifestInput["evidence"][number], "id"> & { digest: string })[];
  custody: CustodyEntry[];
  legalHold: LegalHold | null;
  artifacts: ArtifactManifestEntry[];
  timeline: ManifestInput["timeline"];
  /**
   * The digest of the record above — its content, *not* when the manifest was
   * produced. That is deliberate: the digest is a stable fingerprint of what
   * happened, so a manifest generated today can be compared against one archived
   * last month to show the record has not changed.
   */
  manifestHash: string;
}

/**
 * Assemble the manifest and digest it.
 *
 * The digest covers the incident's facts, the playbook plan *and* its step
 * outcomes, every evidence item's own digest, and the timeline — so a rewritten
 * timeline, a swapped evidence file or a step quietly marked done all change the
 * hash.
 */
export function buildEvidenceManifest(input: ManifestInput, hash: HashFn): EvidenceManifest {
  const evidence = input.evidence.map(({ id, ...item }) => ({ ...item, digest: evidenceDigest(item, hash) }));
  const custody = custodyTrail(input.custody ?? []);
  const legalHold = input.legalHold ?? null;
  const artifacts = input.artifacts ?? [];

  const manifestHash = hash(
    stableStringify({
      incident: input.incident,
      steps: input.steps,
      evidence,
      custody,
      legalHold,
      artifacts,
      timeline: input.timeline,
    }),
  );

  return {
    incident: input.incident,
    generatedAt: input.generatedAt,
    steps: input.steps,
    evidence,
    custody,
    legalHold,
    artifacts,
    timeline: input.timeline,
    manifestHash,
  };
}
