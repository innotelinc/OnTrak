/**
 * Incident documentation service (M3): the playbook an incident runs, the
 * evidence it collects, and the manifest that ties them together.
 *
 * These three belong together because they are one promise: *the record of what
 * happened is complete, contemporaneous and unedited*. So every operation here
 * writes two things — its own row, and a line on the incident's append-only
 * timeline (through the incident store) — plus a hash-chained audit event. The
 * manifest then digests the whole thing.
 *
 * Starting a playbook is idempotent: an incident that already has steps keeps
 * them. That matters because the plan is derived from the severity, and a
 * severity is arguable for the first ten minutes — re-running it must not wipe
 * work already done.
 */

import { randomUUID } from "node:crypto";

import { hasPermission, type Actor } from "./access-rules";
import type { AuditEventInput, AuditSink, HashFn } from "./audit-chain";
import { assignedRoles } from "./incident-rules";
import type { IncidentEvent, IncidentRecord, IncidentStore } from "./incident-service";
import {
  buildEvidenceManifest,
  custodyIntegrity,
  holdActive,
  isEvidenceKind,
  validateCustodyTransfer,
  validateEvidence,
  type CustodyEntry,
  type CustodyTransferInput,
  type EvidenceInput,
  type EvidenceItem,
  type EvidenceKind,
  type EvidenceManifest,
  type LegalHold,
} from "./evidence-rules";
import {
  EVIDENCE_ARTIFACT_MAX_BYTES,
  artifactKeyFor,
  objectLockFor,
  objectPutDecision,
  objectPurgeDecision,
  retentionModeFromEnv,
  type EvidenceObjectStore,
  type RetentionMode,
  type StorePutResult,
} from "./object-lock-rules";
import { sha256Bytes } from "./object-lock-file";
import {
  DEFAULT_INCIDENT_PLAYBOOK,
  changeStepStatus,
  planPlaybook,
  playbookProgress,
  type PlaybookStepTemplate,
  type StepStatus,
} from "./playbook-rules";
import { sha256Hex } from "./ticket-store-prisma";
import type { ServiceResult } from "./ticket-service";

export interface PlaybookStepRecord {
  id: string;
  tenantId: string;
  incidentId: string;
  key: string;
  title: string;
  description: string;
  phase: string;
  order: number;
  status: StepStatus;
  completedAt: string | null;
  completedBy: string | null;
  note: string | null;
}

/**
 * An artifact's bytes under object-lock retention (M3).
 *
 * The artifact is content-addressed, so it belongs to the incident rather than
 * to any one evidence item: two collections of the same bytes cite one object,
 * and the evidence items are the statements about it. `purgedAt` is the only
 * field that ever moves, and only when the retention rules allow it.
 */
export interface EvidenceArtifactRecord {
  id: string;
  tenantId: string;
  incidentId: string;
  /** `evidence/<tenant>/<incident>/<sha256>`. */
  key: string;
  sha256: string;
  bytes: number;
  contentType: string;
  mode: RetentionMode;
  retainUntil: string;
  lockedAt: string;
  createdBy: string;
  purgedAt: string | null;
}

/** Where artifact bytes go, and the retention this deployment applies to them. */
export interface ArtifactStorage {
  objects: EvidenceObjectStore;
  /** Defaults to `COMPLIANCE`: the strong mode, because evidence is the point. */
  mode?: RetentionMode;
  retentionDays?: number;
}

/** Everything the console shows about one incident's documentation. */
export interface IncidentDocsPage {
  steps: PlaybookStepRecord[];
  evidence: EvidenceItem[];
  custody: CustodyEntry[];
  holds: LegalHold[];
  artifacts: EvidenceArtifactRecord[];
}

export interface IncidentDocsStore {
  insertSteps(steps: PlaybookStepRecord[]): Promise<void>;
  findStep(tenantId: string, incidentId: string, key: string): Promise<PlaybookStepRecord | null>;
  listSteps(tenantId: string, incidentId: string): Promise<PlaybookStepRecord[]>;
  updateStep(step: PlaybookStepRecord): Promise<void>;
  insertEvidence(item: EvidenceItem): Promise<void>;
  findEvidence(tenantId: string, evidenceId: string): Promise<EvidenceItem | null>;
  listEvidence(tenantId: string, incidentId: string): Promise<EvidenceItem[]>;
  insertCustody(entry: CustodyEntry): Promise<void>;
  listCustody(tenantId: string, incidentId: string): Promise<CustodyEntry[]>;
  insertHold(hold: LegalHold): Promise<void>;
  updateHold(hold: LegalHold): Promise<void>;
  listHolds(tenantId: string, incidentId: string): Promise<LegalHold[]>;
  insertArtifact(artifact: EvidenceArtifactRecord): Promise<void>;
  findArtifact(tenantId: string, artifactId: string): Promise<EvidenceArtifactRecord | null>;
  findArtifactByKey(tenantId: string, key: string): Promise<EvidenceArtifactRecord | null>;
  listArtifacts(tenantId: string, incidentId: string): Promise<EvidenceArtifactRecord[]>;
  /** The only mutation an artifact row ever takes: its bytes are gone. */
  markArtifactPurged(tenantId: string, artifactId: string, at: string): Promise<void>;
  /**
   * Several incidents' documentation in one pass. Optional, like the incident
   * store's event pages: a store that cannot batch still works, it is just more
   * round trips on a page that lists every incident.
   */
  listPages?(tenantId: string, incidentIds: readonly string[]): Promise<Map<string, IncidentDocsPage>>;
}

export interface IncidentDocsIds {
  id(): string;
  now(): string;
}

export function systemIncidentDocsIds(): IncidentDocsIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

export class IncidentDocsService {
  constructor(
    private readonly store: IncidentDocsStore,
    private readonly incidents: IncidentStore,
    private readonly audit: AuditSink | null = null,
    private readonly ids: IncidentDocsIds = systemIncidentDocsIds(),
    /** Injected so the digest is the same everywhere it is computed. */
    private readonly hash: HashFn = sha256Hex,
    /** Absent when a deployment records evidence without storing its bytes. */
    private readonly storage: ArtifactStorage | null = null,
    private readonly templates: readonly PlaybookStepTemplate[] = DEFAULT_INCIDENT_PLAYBOOK,
  ) {}

  /**
   * Put the incident on a playbook. Idempotent: existing steps are returned
   * unchanged, so re-deriving the plan after a severity revision cannot erase
   * work already done.
   */
  async startPlaybook(actor: Actor, incidentId: string): Promise<ServiceResult<PlaybookStepRecord[]>> {
    if (!hasPermission(actor.role, "ticket:update")) return { ok: false, error: "You cannot update incidents." };
    const incident = await this.incidents.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };

    const existing = await this.store.listSteps(actor.tenantId, incidentId);
    if (existing.length > 0) return { ok: true, value: existing };

    const plan = planPlaybook(incident.severity, this.templates);
    const now = this.ids.now();
    const steps: PlaybookStepRecord[] = plan.map((step, index) => ({
      id: this.ids.id(),
      tenantId: incident.tenantId,
      incidentId,
      key: step.key,
      title: step.title,
      description: step.description,
      phase: step.phase,
      order: index + 1,
      status: "PENDING",
      completedAt: null,
      completedBy: null,
      note: null,
    }));
    await this.store.insertSteps(steps);
    await this.timeline(actor.id, incident, "playbook", `Playbook started (${steps.length} steps)`, {
      steps: steps.map((step) => step.key),
    });
    if (this.audit) {
      await this.audit.append(docsAudit(incident, actor.id, "incident.playbook.start", now, { steps: steps.length }));
    }
    return { ok: true, value: steps };
  }

  /** Finish a step, recording who and when. */
  async completeStep(actor: Actor, incidentId: string, key: string, note?: string): Promise<ServiceResult<PlaybookStepRecord>> {
    return this.changeStep(actor, incidentId, key, "DONE", note);
  }

  /** Skip a step. A skip is a decision, so the reason is required. */
  async skipStep(actor: Actor, incidentId: string, key: string, reason: string): Promise<ServiceResult<PlaybookStepRecord>> {
    const text = reason.trim();
    if (!text) return { ok: false, error: "Skipping a step needs a reason." };
    return this.changeStep(actor, incidentId, key, "SKIPPED", text);
  }

  /** Reopen a finished or skipped step, so it can be done properly. */
  async reopenStep(actor: Actor, incidentId: string, key: string): Promise<ServiceResult<PlaybookStepRecord>> {
    return this.changeStep(actor, incidentId, key, "PENDING", undefined);
  }

  /** Record a piece of evidence against the incident. */
  async recordEvidence(actor: Actor, incidentId: string, input: EvidenceInput): Promise<ServiceResult<EvidenceItem>> {
    if (!hasPermission(actor.role, "ticket:update")) return { ok: false, error: "You cannot update incidents." };
    const issues = validateEvidence(input);
    if (issues.length > 0) return { ok: false, error: issues[0] };

    const incident = await this.incidents.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };

    const now = this.ids.now();
    const item: EvidenceItem = {
      id: this.ids.id(),
      tenantId: incident.tenantId,
      incidentId,
      kind: input.kind,
      label: input.label.trim(),
      reference: input.reference.trim(),
      sha256: input.sha256?.trim().toLowerCase() ?? null,
      note: input.note?.trim() || null,
      collectedBy: actor.id,
      collectedAt: now,
    };
    await this.store.insertEvidence(item);

    // Collection is the first entry in the item's chain of custody, written with
    // the item rather than added later, so the trail can never start mid-way.
    await this.store.insertCustody({
      id: this.ids.id(),
      tenantId: incident.tenantId,
      incidentId,
      evidenceId: item.id,
      at: now,
      action: "COLLECTED",
      fromActor: actor.id,
      toActor: actor.id,
      reason: null,
    });

    await this.timeline(actor.id, incident, "evidence", `Evidence collected: ${item.label}`, {
      kind: item.kind,
      reference: item.reference,
      digest: item.sha256,
    });
    if (this.audit) await this.audit.append(docsAudit(incident, actor.id, "incident.evidence.record", now, { kind: item.kind, label: item.label }));
    return { ok: true, value: item };
  }

  /**
   * Store an artifact's bytes under object lock, and record it as evidence.
   *
   * One operation, because the two halves must not be able to drift: the evidence
   * item's `reference` *is* the object key and its `sha256` is the digest that key
   * was derived from, so an item and its artifact can never disagree about which
   * bytes they mean.
   *
   * Re-uploading identical bytes is not an error and does not create a second
   * object — it records another collection of the same artifact, which is what a
   * responder is actually saying when they upload it twice.
   */
  async recordArtifact(
    actor: Actor,
    incidentId: string,
    input: { kind: EvidenceKind; label: string; contentType?: string; bytes: Uint8Array; note?: string | null },
  ): Promise<ServiceResult<{ item: EvidenceItem; artifact: EvidenceArtifactRecord; stored: StorePutResult }>> {
    if (!hasPermission(actor.role, "ticket:update")) return { ok: false, error: "You cannot update incidents." };
    if (!this.storage) return { ok: false, error: "Evidence storage is not configured for this deployment." };
    if (!isEvidenceKind(input.kind)) return { ok: false, error: "Unknown evidence kind." };
    if (input.bytes.byteLength === 0) return { ok: false, error: "That file is empty." };
    if (input.bytes.byteLength > EVIDENCE_ARTIFACT_MAX_BYTES) {
      const mb = Math.floor(EVIDENCE_ARTIFACT_MAX_BYTES / (1024 * 1024));
      return { ok: false, error: `An evidence file may be at most ${mb} MB.` };
    }

    const incident = await this.incidents.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };

    const now = this.ids.now();
    const sha256 = sha256Bytes(input.bytes);
    const key = artifactKeyFor(incident.tenantId, incidentId, sha256);
    const existing = await this.store.findArtifactByKey(incident.tenantId, key);
    const decision = objectPutDecision(existing, sha256);
    // Content-addressed keys make this unreachable short of a hand-edited row,
    // but the rule is the rule: a locked object is never overwritten.
    if (decision.action === "conflict") return { ok: false, error: decision.reason };

    const contentType = input.contentType?.trim() || "application/octet-stream";
    // Validate before anything is written, so a label that cannot be recorded
    // does not leave bytes behind with nothing pointing at them.
    const issues = validateEvidence({ kind: input.kind, label: input.label, reference: key, sha256 });
    if (issues.length > 0) return { ok: false, error: issues[0] };

    const stored = await this.storage.objects.put(key, input.bytes, contentType);

    let artifact = existing;
    if (!artifact) {
      const lock = objectLockFor({
        collectedAt: now,
        now,
        mode: this.storage.mode ?? retentionModeFromEnv(),
        retentionDays: this.storage.retentionDays,
      });
      artifact = {
        id: this.ids.id(),
        tenantId: incident.tenantId,
        incidentId,
        key,
        sha256,
        bytes: input.bytes.byteLength,
        contentType,
        mode: lock.mode,
        retainUntil: lock.retainUntil,
        lockedAt: lock.lockedAt,
        createdBy: actor.id,
        purgedAt: null,
      };
      await this.store.insertArtifact(artifact);
    }

    const recorded = await this.recordEvidence(actor, incidentId, {
      kind: input.kind,
      label: input.label,
      reference: key,
      sha256,
      note: input.note ?? null,
    });
    if (!recorded.ok) return recorded;

    await this.timeline(actor.id, incident, "evidence", `Artifact locked: ${key}`, {
      mode: artifact.mode,
      retainUntil: artifact.retainUntil,
      bytes: artifact.bytes,
      sha256,
    });
    if (this.audit) {
      await this.audit.append(
        docsAudit(incident, actor.id, "incident.evidence.store", now, {
          key,
          sha256,
          bytes: artifact.bytes,
          mode: artifact.mode,
          retainUntil: artifact.retainUntil,
          stored,
        }),
      );
    }

    return { ok: true, value: { item: recorded.value, artifact, stored } };
  }

  /**
   * Remove an artifact's bytes, once the retention rules permit it.
   *
   * The rules are applied here rather than in the caller, and the refusal is a
   * returned reason rather than an exception, because "you cannot delete this
   * yet, and here is why" is the answer an operator needs.
   */
  async purgeArtifact(
    actor: Actor,
    incidentId: string,
    artifactId: string,
    input: { reason: string; bypassGovernance?: boolean },
  ): Promise<ServiceResult<EvidenceArtifactRecord>> {
    // Deliberately stronger than the write path: recording evidence is a normal
    // act, destroying it is not.
    if (!hasPermission(actor.role, "tenant:manage")) {
      return { ok: false, error: "Removing evidence under retention needs an administrator." };
    }
    if (!this.storage) return { ok: false, error: "Evidence storage is not configured for this deployment." };
    const reason = input.reason?.trim() ?? "";
    if (!reason) return { ok: false, error: "Removing evidence needs a reason on the record." };

    const incident = await this.incidents.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };
    const artifact = await this.store.findArtifact(actor.tenantId, artifactId);
    if (!artifact || artifact.incidentId !== incidentId) {
      return { ok: false, error: "That artifact is not on this incident." };
    }

    const now = this.ids.now();
    const hold = await this.activeHold(actor.tenantId, incidentId);
    const decision = objectPurgeDecision(
      {
        lock: { mode: artifact.mode, retainUntil: artifact.retainUntil, lockedAt: artifact.lockedAt },
        holdActive: hold !== null,
        purgedAt: artifact.purgedAt,
      },
      now,
      { bypassGovernance: input.bypassGovernance },
    );
    if (!decision.allowed) return { ok: false, error: decision.reason };

    await this.storage.objects.delete(artifact.key);
    await this.store.markArtifactPurged(artifact.tenantId, artifact.id, now);

    await this.timeline(actor.id, incident, "evidence", `Artifact purged: ${artifact.key}`, {
      reason,
      bypassed: decision.requiresBypass,
    });
    if (this.audit) {
      await this.audit.append(
        docsAudit(incident, actor.id, "incident.evidence.purge", now, {
          key: artifact.key,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
          reason,
          bypassedGovernance: decision.requiresBypass,
        }),
      );
    }

    return { ok: true, value: { ...artifact, purgedAt: now } };
  }

  /** The artifacts stored for an incident, newest last. */
  async listArtifacts(tenantId: string, incidentId: string): Promise<EvidenceArtifactRecord[]> {
    return this.store.listArtifacts(tenantId, incidentId);
  }

  /** Whether this deployment stores artifact bytes at all. */
  get artifactStorageEnabled(): boolean {
    return this.storage !== null;
  }

  /**
   * Hand an evidence item on. The trail must already be unbroken and the
   * transfer must start from its current holder — a hand-off from someone who
   * does not hold the item is refused rather than appended and glossed over.
   */
  async transferEvidence(
    actor: Actor,
    incidentId: string,
    evidenceId: string,
    input: CustodyTransferInput,
  ): Promise<ServiceResult<CustodyEntry>> {
    if (!hasPermission(actor.role, "ticket:update")) return { ok: false, error: "You cannot update incidents." };
    const issues = validateCustodyTransfer(input);
    if (issues.length > 0) return { ok: false, error: issues[0] };

    const incident = await this.incidents.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };

    const item = await this.store.findEvidence(actor.tenantId, evidenceId);
    if (!item || item.incidentId !== incidentId) return { ok: false, error: "Evidence not found on this incident." };

    const existing = await this.store.listCustody(actor.tenantId, incidentId);
    const trail = existing.filter((entry) => entry.evidenceId === evidenceId);
    const integrity = custodyIntegrity(trail, item.collectedBy);
    if (!integrity.ok) return { ok: false, error: integrity.reason };

    const now = this.ids.now();
    const entry: CustodyEntry = {
      id: this.ids.id(),
      tenantId: incident.tenantId,
      incidentId,
      evidenceId,
      at: now,
      action: "TRANSFERRED",
      fromActor: integrity.holder,
      toActor: input.toActor!.trim(),
      reason: input.reason!.trim(),
    };
    await this.store.insertCustody(entry);

    await this.timeline(actor.id, incident, "custody", `Custody of "${item.label}" moved to ${entry.toActor}`, {
      evidenceId,
      from: entry.fromActor,
      to: entry.toActor,
      reason: entry.reason,
    });
    if (this.audit) {
      await this.audit.append(
        docsAudit(incident, actor.id, "incident.custody.transfer", now, {
          evidenceId,
          from: entry.fromActor,
          to: entry.toActor,
        }),
      );
    }
    return { ok: true, value: entry };
  }

  /**
   * Place a legal hold. Routine retention stops while it is in force, so it is a
   * deliberate act with a reason and a name attached, and one active hold at a
   * time is enough information for a reader.
   */
  async placeLegalHold(actor: Actor, incidentId: string, reason: string): Promise<ServiceResult<LegalHold>> {
    if (!hasPermission(actor.role, "ticket:update")) return { ok: false, error: "You cannot update incidents." };
    const text = reason.trim();
    if (!text) return { ok: false, error: "A legal hold needs a reason." };

    const incident = await this.incidents.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };

    const current = await this.activeHold(actor.tenantId, incidentId);
    if (current) return { ok: false, error: "This incident is already under a legal hold." };

    const now = this.ids.now();
    const hold: LegalHold = {
      id: this.ids.id(),
      tenantId: incident.tenantId,
      incidentId,
      reason: text,
      placedBy: actor.id,
      placedAt: now,
      releasedBy: null,
      releasedAt: null,
    };
    await this.store.insertHold(hold);

    await this.timeline(actor.id, incident, "hold", "Legal hold placed", { reason: text });
    if (this.audit) await this.audit.append(docsAudit(incident, actor.id, "incident.hold.place", now, { reason: text }));
    return { ok: true, value: hold };
  }

  /** Release a legal hold, recording who released it and why. */
  async releaseLegalHold(actor: Actor, incidentId: string, reason: string): Promise<ServiceResult<LegalHold>> {
    if (!hasPermission(actor.role, "ticket:update")) return { ok: false, error: "You cannot update incidents." };
    const text = reason.trim();
    if (!text) return { ok: false, error: "Releasing a legal hold needs a reason." };

    const incident = await this.incidents.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };

    const current = await this.activeHold(actor.tenantId, incidentId);
    if (!current) return { ok: false, error: "This incident is not under a legal hold." };

    const now = this.ids.now();
    const released: LegalHold = { ...current, releasedBy: actor.id, releasedAt: now };
    await this.store.updateHold(released);

    await this.timeline(actor.id, incident, "hold", "Legal hold released", { reason: text, holdId: current.id });
    if (this.audit) {
      await this.audit.append(docsAudit(incident, actor.id, "incident.hold.release", now, { reason: text, holdId: current.id }));
    }
    return { ok: true, value: released };
  }

  /** The hold in force for an incident, if any. */
  async activeHold(tenantId: string, incidentId: string): Promise<LegalHold | null> {
    const holds = await this.store.listHolds(tenantId, incidentId);
    return holds.find((hold) => holdActive(hold)) ?? null;
  }

  /** The incident's whole custody trail, newest last. */
  async listCustody(tenantId: string, incidentId: string): Promise<CustodyEntry[]> {
    return this.store.listCustody(tenantId, incidentId);
  }

  /** Every hold ever placed, newest first — released ones included. */
  async listHolds(tenantId: string, incidentId: string): Promise<LegalHold[]> {
    return this.store.listHolds(tenantId, incidentId);
  }

  async listSteps(tenantId: string, incidentId: string): Promise<PlaybookStepRecord[]> {
    return this.store.listSteps(tenantId, incidentId);
  }

  async listEvidence(tenantId: string, incidentId: string): Promise<EvidenceItem[]> {
    return this.store.listEvidence(tenantId, incidentId);
  }

  /**
   * Every listed incident's playbook, evidence, custody and holds, in one pass.
   * The console renders all of them at once, so reading them incident by
   * incident multiplies the queries by the length of the list for no benefit.
   */
  async pages(tenantId: string, incidentIds: readonly string[]): Promise<Map<string, IncidentDocsPage>> {
    if (incidentIds.length === 0) return new Map();
    if (this.store.listPages) return this.store.listPages(tenantId, incidentIds);

    const pages = new Map<string, IncidentDocsPage>();
    for (const incidentId of incidentIds) {
      const [steps, evidence, custody, holds, artifacts] = await Promise.all([
        this.store.listSteps(tenantId, incidentId),
        this.store.listEvidence(tenantId, incidentId),
        this.store.listCustody(tenantId, incidentId),
        this.store.listHolds(tenantId, incidentId),
        this.store.listArtifacts(tenantId, incidentId),
      ]);
      pages.set(incidentId, { steps, evidence, custody, holds, artifacts });
    }
    return pages;
  }

  /**
   * Assemble (and digest) the incident's manifest. Generating one is itself
   * recorded — the audit event carries the digest, so "this manifest existed at
   * this moment" is evidence too.
   */
  async manifest(tenantId: string, incidentId: string): Promise<ServiceResult<EvidenceManifest>> {
    const incident = await this.incidents.findIncident(tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };

    const [steps, evidence, timeline, custody, hold, artifacts] = await Promise.all([
      this.store.listSteps(tenantId, incidentId),
      this.store.listEvidence(tenantId, incidentId),
      this.incidents.listEvents(tenantId, incidentId),
      this.store.listCustody(tenantId, incidentId),
      this.activeHold(tenantId, incidentId),
      this.store.listArtifacts(tenantId, incidentId),
    ]);

    const manifest = buildEvidenceManifest(
      {
        incident: {
          ref: incident.ref,
          title: incident.title,
          severity: incident.severity,
          phase: incident.phase,
          detectedAt: incident.detectedAt,
          declaredAt: incident.declaredAt,
          roles: assignedRoles(incident).map(({ role, userId }) => ({ role, userId })),
        },
        steps: steps.map((step) => ({
          key: step.key,
          title: step.title,
          status: step.status,
          completedAt: step.completedAt,
          completedBy: step.completedBy,
        })),
        evidence,
        custody,
        legalHold: hold,
        // The lock is part of the record an auditor reads, so the artifacts and
        // their retention go into the same digest as everything else.
        artifacts: artifacts.map(({ key, sha256, bytes, contentType, mode, retainUntil, lockedAt, purgedAt }) => ({
          key,
          sha256,
          bytes,
          contentType,
          mode,
          retainUntil,
          lockedAt,
          purgedAt,
        })),
        timeline: timeline.map((event) => ({ at: event.at, kind: event.kind, actor: event.actor, summary: event.summary })),
        generatedAt: this.ids.now(),
      },
      this.hash,
    );

    if (this.audit) {
      await this.audit.append(manifestAudit(incident, manifest.manifestHash, manifest.generatedAt));
    }
    return { ok: true, value: manifest };
  }

  /** A roll-up of the playbook for a page header. */
  async progress(tenantId: string, incidentId: string) {
    return playbookProgress(await this.store.listSteps(tenantId, incidentId));
  }

  private async changeStep(
    actor: Actor,
    incidentId: string,
    key: string,
    to: StepStatus,
    note: string | undefined,
  ): Promise<ServiceResult<PlaybookStepRecord>> {
    if (!hasPermission(actor.role, "ticket:update")) return { ok: false, error: "You cannot update incidents." };
    const incident = await this.incidents.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };

    const step = await this.store.findStep(actor.tenantId, incidentId, key);
    if (!step) return { ok: false, error: "That step is not on this incident's playbook." };

    const changed = changeStepStatus(step.status, to);
    if (!changed.ok) return { ok: false, error: changed.reason };

    const now = this.ids.now();
    const next: PlaybookStepRecord = {
      ...step,
      status: changed.status,
      completedAt: changed.status === "PENDING" ? null : now,
      completedBy: changed.status === "PENDING" ? null : actor.id,
      note: note?.trim() || step.note,
    };
    await this.store.updateStep(next);

    const verb = changed.status === "DONE" ? "Completed" : changed.status === "SKIPPED" ? "Skipped" : "Reopened";
    await this.timeline(actor.id, incident, "playbook", `${verb} step: ${step.title}`, {
      key: step.key,
      status: changed.status,
      note: next.note,
    });
    if (this.audit) {
      await this.audit.append(
        docsAudit(incident, actor.id, "incident.playbook.step", now, { key: step.key, from: step.status, to: changed.status }),
      );
    }
    return { ok: true, value: next };
  }

  private async timeline(
    actor: string,
    incident: IncidentRecord,
    kind: IncidentEvent["kind"],
    summary: string,
    detail: Record<string, unknown> | null,
  ): Promise<void> {
    const event: IncidentEvent = {
      id: this.ids.id(),
      tenantId: incident.tenantId,
      incidentId: incident.id,
      at: this.ids.now(),
      kind,
      actor,
      summary,
      detail,
    };
    await this.incidents.appendEvent(event);
  }
}

/* -------------------------------------------------------------------------- */
/*  Audit                                                                     */
/* -------------------------------------------------------------------------- */

export function docsAudit(
  incident: IncidentRecord,
  actor: string,
  action: string,
  at: string,
  detail: Record<string, unknown>,
): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId: incident.tenantId,
    at,
    actor,
    action,
    targetType: "incident",
    targetId: incident.id,
    detail: { ref: incident.ref, ...detail },
  };
}

export function manifestAudit(incident: IncidentRecord, manifestHash: string, at: string): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId: incident.tenantId,
    at,
    actor: "system:manifest",
    action: "incident.manifest",
    targetType: "incident",
    targetId: incident.id,
    detail: { ref: incident.ref, manifestHash },
  };
}

/* -------------------------------------------------------------------------- */
/*  In-memory store (tests and local work)                                    */
/* -------------------------------------------------------------------------- */

export class MemoryIncidentDocsStore implements IncidentDocsStore {
  private readonly steps = new Map<string, PlaybookStepRecord>();
  private readonly evidence = new Map<string, EvidenceItem>();
  private readonly custody = new Map<string, CustodyEntry>();
  private readonly holds = new Map<string, LegalHold>();
  private readonly artifacts = new Map<string, EvidenceArtifactRecord>();

  async listPages(tenantId: string, incidentIds: readonly string[]): Promise<Map<string, IncidentDocsPage>> {
    const pages = new Map<string, IncidentDocsPage>();
    for (const incidentId of incidentIds) {
      pages.set(incidentId, {
        steps: await this.listSteps(tenantId, incidentId),
        evidence: await this.listEvidence(tenantId, incidentId),
        custody: await this.listCustody(tenantId, incidentId),
        holds: await this.listHolds(tenantId, incidentId),
        artifacts: await this.listArtifacts(tenantId, incidentId),
      });
    }
    return pages;
  }

  async insertSteps(records: PlaybookStepRecord[]): Promise<void> {
    for (const step of records) this.steps.set(`${step.tenantId}:${step.incidentId}:${step.key}`, structuredClone(step));
  }

  async findStep(tenantId: string, incidentId: string, key: string): Promise<PlaybookStepRecord | null> {
    const found = this.steps.get(`${tenantId}:${incidentId}:${key}`);
    return found ? structuredClone(found) : null;
  }

  async listSteps(tenantId: string, incidentId: string): Promise<PlaybookStepRecord[]> {
    return [...this.steps.values()]
      .filter((step) => step.tenantId === tenantId && step.incidentId === incidentId)
      .sort((a, b) => a.order - b.order)
      .map((step) => structuredClone(step));
  }

  async updateStep(step: PlaybookStepRecord): Promise<void> {
    this.steps.set(`${step.tenantId}:${step.incidentId}:${step.key}`, structuredClone(step));
  }

  async insertEvidence(item: EvidenceItem): Promise<void> {
    this.evidence.set(item.id, structuredClone(item));
  }

  async findEvidence(tenantId: string, evidenceId: string): Promise<EvidenceItem | null> {
    const found = this.evidence.get(evidenceId);
    return found && found.tenantId === tenantId ? structuredClone(found) : null;
  }

  async listEvidence(tenantId: string, incidentId: string): Promise<EvidenceItem[]> {
    return [...this.evidence.values()]
      .filter((item) => item.tenantId === tenantId && item.incidentId === incidentId)
      .sort((a, b) => a.collectedAt.localeCompare(b.collectedAt))
      .map((item) => structuredClone(item));
  }

  async insertCustody(entry: CustodyEntry): Promise<void> {
    this.custody.set(entry.id, structuredClone(entry));
  }

  async listCustody(tenantId: string, incidentId: string): Promise<CustodyEntry[]> {
    return [...this.custody.values()]
      .filter((entry) => entry.tenantId === tenantId && entry.incidentId === incidentId)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
      .map((entry) => structuredClone(entry));
  }

  async insertHold(hold: LegalHold): Promise<void> {
    this.holds.set(hold.id, structuredClone(hold));
  }

  async updateHold(hold: LegalHold): Promise<void> {
    this.holds.set(hold.id, structuredClone(hold));
  }

  async listHolds(tenantId: string, incidentId: string): Promise<LegalHold[]> {
    return [...this.holds.values()]
      .filter((hold) => hold.tenantId === tenantId && hold.incidentId === incidentId)
      .sort((a, b) => b.placedAt.localeCompare(a.placedAt))
      .map((hold) => structuredClone(hold));
  }

  async insertArtifact(artifact: EvidenceArtifactRecord): Promise<void> {
    this.artifacts.set(artifact.id, structuredClone(artifact));
  }

  async findArtifact(tenantId: string, artifactId: string): Promise<EvidenceArtifactRecord | null> {
    const found = this.artifacts.get(artifactId);
    return found && found.tenantId === tenantId ? structuredClone(found) : null;
  }

  async findArtifactByKey(tenantId: string, key: string): Promise<EvidenceArtifactRecord | null> {
    const found = [...this.artifacts.values()].find(
      (artifact) => artifact.tenantId === tenantId && artifact.key === key,
    );
    return found ? structuredClone(found) : null;
  }

  async listArtifacts(tenantId: string, incidentId: string): Promise<EvidenceArtifactRecord[]> {
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.tenantId === tenantId && artifact.incidentId === incidentId)
      .sort((a, b) => a.lockedAt.localeCompare(b.lockedAt) || a.id.localeCompare(b.id))
      .map((artifact) => structuredClone(artifact));
  }

  async markArtifactPurged(tenantId: string, artifactId: string, at: string): Promise<void> {
    const found = this.artifacts.get(artifactId);
    if (!found || found.tenantId !== tenantId) return;
    this.artifacts.set(artifactId, { ...structuredClone(found), purgedAt: at });
  }
}
