/**
 * Prisma adapter for the incident documentation store (M3).
 *
 * `status` is a Prisma enum and `kind` a plain string; both are narrowed on the
 * way out so a value that predates a vocabulary change degrades instead of
 * leaking `string`. Structural, like the other adapters.
 */

import {
  isCustodyAction,
  isEvidenceKind,
  type CustodyEntry,
  type EvidenceItem,
  type EvidenceKind,
  type LegalHold,
} from "./evidence-rules";
import type {
  EvidenceArtifactRecord,
  IncidentDocsPage,
  IncidentDocsStore,
  PlaybookStepRecord,
} from "./incident-docs-service";
import { isRetentionMode, DEFAULT_RETENTION_MODE } from "./object-lock-rules";
import { isStepStatus, type StepStatus } from "./playbook-rules";

export interface PlaybookStepRow {
  id: string;
  tenantId: string;
  incidentId: string;
  key: string;
  title: string;
  description: string;
  phase: string;
  order: number;
  status: string;
  completedAt: Date | null;
  completedBy: string | null;
  note: string | null;
}

export interface EvidenceItemRow {
  id: string;
  tenantId: string;
  incidentId: string;
  kind: string;
  label: string;
  reference: string;
  sha256: string | null;
  note: string | null;
  collectedBy: string;
  collectedAt: Date;
}

export interface CustodyEntryRow {
  id: string;
  tenantId: string;
  incidentId: string;
  evidenceId: string;
  at: Date;
  action: string;
  fromActor: string;
  toActor: string;
  reason: string | null;
}

export interface LegalHoldRow {
  id: string;
  tenantId: string;
  incidentId: string;
  reason: string;
  placedBy: string;
  placedAt: Date;
  releasedBy: string | null;
  releasedAt: Date | null;
}

export interface EvidenceArtifactRow {
  id: string;
  tenantId: string;
  incidentId: string;
  key: string;
  sha256: string;
  bytes: number;
  contentType: string;
  mode: string;
  retainUntil: Date;
  lockedAt: Date;
  createdBy: string;
  purgedAt: Date | null;
}

export interface IncidentDocsPrismaClient {
  playbookStep: {
    findFirst(args: unknown): Promise<PlaybookStepRow | null>;
    findMany(args: unknown): Promise<PlaybookStepRow[]>;
    createMany(args: { data: unknown[] }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
  evidenceItem: {
    findFirst(args: unknown): Promise<EvidenceItemRow | null>;
    findMany(args: unknown): Promise<EvidenceItemRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
  };
  custodyEntry: {
    findMany(args: unknown): Promise<CustodyEntryRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
  };
  legalHold: {
    findMany(args: unknown): Promise<LegalHoldRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
  evidenceArtifact: {
    findFirst(args: unknown): Promise<EvidenceArtifactRow | null>;
    findMany(args: unknown): Promise<EvidenceArtifactRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
}

/**
 * A stored artifact. `mode` is narrowed on the way out like every other
 * vocabulary in these adapters: a row written by an older version degrades to
 * the cautious mode rather than being trusted.
 */
export function toArtifactRecord(row: EvidenceArtifactRow): EvidenceArtifactRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    incidentId: row.incidentId,
    key: row.key,
    sha256: row.sha256,
    bytes: row.bytes,
    contentType: row.contentType,
    mode: isRetentionMode(row.mode) ? row.mode : DEFAULT_RETENTION_MODE,
    retainUntil: toIso(row.retainUntil),
    lockedAt: toIso(row.lockedAt),
    createdBy: row.createdBy,
    purgedAt: row.purgedAt === null ? null : toIso(row.purgedAt),
  };
}

export function toArtifactData(artifact: EvidenceArtifactRecord) {
  return {
    id: artifact.id,
    tenantId: artifact.tenantId,
    incidentId: artifact.incidentId,
    key: artifact.key,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    contentType: artifact.contentType,
    mode: artifact.mode,
    retainUntil: new Date(artifact.retainUntil),
    lockedAt: new Date(artifact.lockedAt),
    createdBy: artifact.createdBy,
    purgedAt: artifact.purgedAt === null ? null : new Date(artifact.purgedAt),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toStepRecord(row: PlaybookStepRow): PlaybookStepRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    incidentId: row.incidentId,
    key: row.key,
    title: row.title,
    description: row.description,
    phase: row.phase,
    order: row.order,
    status: isStepStatus(row.status) ? row.status : "PENDING",
    completedAt: row.completedAt === null ? null : toIso(row.completedAt),
    completedBy: row.completedBy,
    note: row.note,
  };
}

export function toStepData(step: PlaybookStepRecord) {
  return {
    id: step.id,
    tenantId: step.tenantId,
    incidentId: step.incidentId,
    key: step.key,
    title: step.title,
    description: step.description,
    phase: step.phase,
    order: step.order,
    status: step.status,
    completedAt: step.completedAt === null ? null : new Date(step.completedAt),
    completedBy: step.completedBy,
    note: step.note,
  };
}

export function toEvidenceRecord(row: EvidenceItemRow): EvidenceItem {
  return {
    id: row.id,
    tenantId: row.tenantId,
    incidentId: row.incidentId,
    kind: isEvidenceKind(row.kind) ? (row.kind as EvidenceKind) : "NOTE",
    label: row.label,
    reference: row.reference,
    sha256: row.sha256,
    note: row.note,
    collectedBy: row.collectedBy,
    collectedAt: toIso(row.collectedAt),
  };
}

export function toEvidenceData(item: EvidenceItem) {
  return {
    id: item.id,
    tenantId: item.tenantId,
    incidentId: item.incidentId,
    kind: item.kind,
    label: item.label,
    reference: item.reference,
    sha256: item.sha256 ?? null,
    note: item.note ?? null,
    collectedBy: item.collectedBy,
    collectedAt: new Date(item.collectedAt),
  };
}

export function toCustodyRecord(row: CustodyEntryRow): CustodyEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    incidentId: row.incidentId,
    evidenceId: row.evidenceId,
    at: toIso(row.at),
    action: isCustodyAction(row.action) ? row.action : "TRANSFERRED",
    fromActor: row.fromActor,
    toActor: row.toActor,
    reason: row.reason,
  };
}

export function toCustodyData(entry: CustodyEntry) {
  return {
    id: entry.id,
    tenantId: entry.tenantId,
    incidentId: entry.incidentId,
    evidenceId: entry.evidenceId,
    at: new Date(entry.at),
    action: entry.action,
    fromActor: entry.fromActor,
    toActor: entry.toActor,
    reason: entry.reason ?? null,
  };
}

export function toHoldRecord(row: LegalHoldRow): LegalHold {
  return {
    id: row.id,
    tenantId: row.tenantId,
    incidentId: row.incidentId,
    reason: row.reason,
    placedBy: row.placedBy,
    placedAt: toIso(row.placedAt),
    releasedBy: row.releasedBy,
    releasedAt: row.releasedAt === null ? null : toIso(row.releasedAt),
  };
}

export function toHoldData(hold: LegalHold) {
  return {
    reason: hold.reason,
    releasedBy: hold.releasedBy,
    releasedAt: hold.releasedAt === null ? null : new Date(hold.releasedAt),
  };
}

export class PrismaIncidentDocsStore implements IncidentDocsStore {
  constructor(private readonly db: IncidentDocsPrismaClient) {}

  async insertSteps(records: PlaybookStepRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.db.playbookStep.createMany({ data: records.map(toStepData) });
  }

  async findStep(tenantId: string, incidentId: string, key: string): Promise<PlaybookStepRecord | null> {
    const row = await this.db.playbookStep.findFirst({ where: { tenantId, incidentId, key } });
    return row ? toStepRecord(row) : null;
  }

  async listSteps(tenantId: string, incidentId: string): Promise<PlaybookStepRecord[]> {
    const rows = await this.db.playbookStep.findMany({ where: { tenantId, incidentId }, orderBy: { order: "asc" } });
    return rows.map(toStepRecord);
  }

  async updateStep(step: PlaybookStepRecord): Promise<void> {
    await this.db.playbookStep.update({ where: { id: step.id }, data: toStepData(step) });
  }

  async insertEvidence(item: EvidenceItem): Promise<void> {
    await this.db.evidenceItem.create({ data: toEvidenceData(item) });
  }

  async findEvidence(tenantId: string, evidenceId: string): Promise<EvidenceItem | null> {
    const row = await this.db.evidenceItem.findFirst({ where: { tenantId, id: evidenceId } });
    return row ? toEvidenceRecord(row) : null;
  }

  async listEvidence(tenantId: string, incidentId: string): Promise<EvidenceItem[]> {
    const rows = await this.db.evidenceItem.findMany({
      where: { tenantId, incidentId },
      orderBy: { collectedAt: "asc" },
    });
    return rows.map(toEvidenceRecord);
  }

  async insertCustody(entry: CustodyEntry): Promise<void> {
    await this.db.custodyEntry.create({ data: toCustodyData(entry) });
  }

  async listCustody(tenantId: string, incidentId: string): Promise<CustodyEntry[]> {
    const rows = await this.db.custodyEntry.findMany({ where: { tenantId, incidentId }, orderBy: { at: "asc" } });
    return rows.map(toCustodyRecord);
  }

  async insertHold(hold: LegalHold): Promise<void> {
    await this.db.legalHold.create({
      data: {
        id: hold.id,
        tenantId: hold.tenantId,
        incidentId: hold.incidentId,
        reason: hold.reason,
        placedBy: hold.placedBy,
        placedAt: new Date(hold.placedAt),
        releasedBy: null,
        releasedAt: null,
      },
    });
  }

  async updateHold(hold: LegalHold): Promise<void> {
    await this.db.legalHold.update({ where: { id: hold.id }, data: toHoldData(hold) });
  }

  async listHolds(tenantId: string, incidentId: string): Promise<LegalHold[]> {
    const rows = await this.db.legalHold.findMany({ where: { tenantId, incidentId }, orderBy: { placedAt: "desc" } });
    return rows.map(toHoldRecord);
  }

  async insertArtifact(artifact: EvidenceArtifactRecord): Promise<void> {
    await this.db.evidenceArtifact.create({ data: toArtifactData(artifact) });
  }

  async findArtifact(tenantId: string, artifactId: string): Promise<EvidenceArtifactRecord | null> {
    const row = await this.db.evidenceArtifact.findFirst({ where: { tenantId, id: artifactId } });
    return row ? toArtifactRecord(row) : null;
  }

  async findArtifactByKey(tenantId: string, key: string): Promise<EvidenceArtifactRecord | null> {
    const row = await this.db.evidenceArtifact.findFirst({ where: { tenantId, key } });
    return row ? toArtifactRecord(row) : null;
  }

  async listArtifacts(tenantId: string, incidentId: string): Promise<EvidenceArtifactRecord[]> {
    const rows = await this.db.evidenceArtifact.findMany({
      where: { tenantId, incidentId },
      orderBy: { lockedAt: "asc" },
    });
    return rows.map(toArtifactRecord);
  }

  async markArtifactPurged(tenantId: string, artifactId: string, at: string): Promise<void> {
    await this.db.evidenceArtifact.update({
      where: { id: artifactId, tenantId },
      data: { purgedAt: new Date(at) },
    });
  }

  /**
   * Every listed incident's documentation in four queries rather than four per
   * incident. The ordering matches the single-incident methods exactly, so a
   * page renders identically either way.
   */
  async listPages(tenantId: string, incidentIds: readonly string[]): Promise<Map<string, IncidentDocsPage>> {
    const pages = new Map<string, IncidentDocsPage>();
    if (incidentIds.length === 0) return pages;
    const ids = [...incidentIds];

    const [steps, evidence, custody, holds, artifacts] = await Promise.all([
      this.db.playbookStep.findMany({ where: { tenantId, incidentId: { in: ids } }, orderBy: { order: "asc" } }),
      this.db.evidenceItem.findMany({ where: { tenantId, incidentId: { in: ids } }, orderBy: { collectedAt: "asc" } }),
      this.db.custodyEntry.findMany({ where: { tenantId, incidentId: { in: ids } }, orderBy: { at: "asc" } }),
      this.db.legalHold.findMany({ where: { tenantId, incidentId: { in: ids } }, orderBy: { placedAt: "desc" } }),
      this.db.evidenceArtifact.findMany({ where: { tenantId, incidentId: { in: ids } }, orderBy: { lockedAt: "asc" } }),
    ]);

    for (const id of ids) pages.set(id, { steps: [], evidence: [], custody: [], holds: [], artifacts: [] });
    for (const row of steps) pages.get(row.incidentId)?.steps.push(toStepRecord(row));
    for (const row of evidence) pages.get(row.incidentId)?.evidence.push(toEvidenceRecord(row));
    for (const row of custody) pages.get(row.incidentId)?.custody.push(toCustodyRecord(row));
    for (const row of holds) pages.get(row.incidentId)?.holds.push(toHoldRecord(row));
    for (const row of artifacts) pages.get(row.incidentId)?.artifacts.push(toArtifactRecord(row));
    return pages;
  }
}
