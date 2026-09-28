/**
 * Object-lock rules (M3): write-once retention for evidence artifacts.
 *
 * The incident record says *where* an artifact lives and what it hashes to; this
 * decides whether the bytes behind it can still be written or removed. Two ideas
 * do the work:
 *
 *  - **Content-addressed keys.** A key is derived from the SHA-256 of the bytes
 *    (`evidence/<tenant>/<incident>/<sha256>`), so "put different bytes under an
 *    existing key" is not something a caller can even ask for. Re-uploading the
 *    same bytes is a no-op, which is what makes a retried or duplicate upload
 *    safe rather than a corruption risk.
 *  - **A retention clock that a legal hold outranks.** `COMPLIANCE` cannot be
 *    removed early by anyone, including an administrator — that is the point of
 *    it. `GOVERNANCE` can be removed early by a caller who says so explicitly,
 *    and the record shows that they did and why. A legal hold blocks both until
 *    it is released.
 *
 * Pure, so every one of those decisions is testable without a database, a
 * filesystem or an object store. The bytes live behind `EvidenceObjectStore`;
 * the lock itself is an `EvidenceArtifact` row.
 */

import { EVIDENCE_RETENTION_DAYS } from "./evidence-rules";

/* -------------------------------------------------------------------------- */
/*  Retention modes                                                           */
/* -------------------------------------------------------------------------- */

export type RetentionMode = "COMPLIANCE" | "GOVERNANCE";
export const RETENTION_MODES: readonly RetentionMode[] = ["COMPLIANCE", "GOVERNANCE"];

export function isRetentionMode(value: unknown): value is RetentionMode {
  return typeof value === "string" && (RETENTION_MODES as readonly string[]).includes(value);
}

/**
 * What each mode actually means, in the words the console and the docs use. The
 * difference is who can shorten it, and that difference is the whole feature.
 */
export const RETENTION_MODE_NOTES: Record<RetentionMode, string> = {
  COMPLIANCE: "Cannot be deleted or shortened by anyone before the retention date — not even an administrator.",
  GOVERNANCE: "Locked for the same window, but a privileged caller may remove it early, and the record says they did.",
};

/** The default for incident evidence: the strong one, because evidence is the point. */
export const DEFAULT_RETENTION_MODE: RetentionMode = "COMPLIANCE";

/** The deployment's chosen default, from `ONTRAK_TIX_EVIDENCE_LOCK_MODE`. */
export function retentionModeFromEnv(env: Record<string, string | undefined> = process.env): RetentionMode {
  const value = env.ONTRAK_TIX_EVIDENCE_LOCK_MODE?.trim().toUpperCase();
  return isRetentionMode(value) ? value : DEFAULT_RETENTION_MODE;
}

/** Largest artifact we will take, in bytes. A log bundle or a screenshot, not a disk image. */
export const EVIDENCE_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/*  The lock                                                                  */
/* -------------------------------------------------------------------------- */

export interface ObjectLock {
  mode: RetentionMode;
  /** When the retention window closes. ISO-8601 UTC. */
  retainUntil: string;
  /** When the lock was applied — that is, when the bytes were stored. */
  lockedAt: string;
}

/**
 * The lock to apply to an artifact collected at `collectedAt`.
 *
 * The same ten-year window evidence already has (`EVIDENCE_RETENTION_DAYS`),
 * stated as a date so it can be written down and read by a third party without
 * knowing our default.
 */
export function objectLockFor(input: {
  collectedAt: string;
  now: string;
  mode?: RetentionMode;
  retentionDays?: number;
}): ObjectLock {
  const days = input.retentionDays ?? EVIDENCE_RETENTION_DAYS;
  const until = new Date(input.collectedAt).getTime() + days * 24 * 60 * 60 * 1000;
  return {
    mode: input.mode ?? DEFAULT_RETENTION_MODE,
    retainUntil: new Date(until).toISOString(),
    lockedAt: input.now,
  };
}

/** The storage key for a set of bytes: content-addressed, so it cannot drift from its content. */
export function artifactKeyFor(tenantId: string, incidentId: string, sha256: string): string {
  return `evidence/${tenantId}/${incidentId}/${sha256.toLowerCase()}`;
}

/** A one-line description of a lock, for the console and the packet. */
export function describeLock(lock: ObjectLock): string {
  return `${lock.mode} until ${lock.retainUntil}`;
}

/* -------------------------------------------------------------------------- */
/*  Writing                                                                   */
/* -------------------------------------------------------------------------- */

export type PutAction = "create" | "unchanged" | "conflict";

export interface PutDecision {
  action: PutAction;
  reason: string;
}

/**
 * Whether bytes may be stored under a key that may already hold something.
 *
 * `unchanged` is the interesting one: because keys are content-addressed, a
 * second upload of the same bytes is the *same object*, so it is accepted as a
 * no-op rather than treated as a collision. An artifact whose bytes were purged
 * is refused too, and that is deliberate — a purge is a recorded act, and
 * re-storing under the same key would quietly undo it.
 */
export function objectPutDecision(
  existing: { sha256: string; purgedAt?: string | null } | null | undefined,
  candidateSha256: string,
): PutDecision {
  if (!existing) return { action: "create", reason: "Nothing is stored under this key yet." };

  const candidate = candidateSha256.trim().toLowerCase();
  if (existing.sha256.trim().toLowerCase() !== candidate) {
    return {
      action: "conflict",
      reason: "A locked object is never overwritten, and this key already holds different bytes.",
    };
  }
  if (existing.purgedAt) {
    return {
      action: "conflict",
      reason: "These bytes were purged under the retention policy; collecting them again needs a new collection, not a re-upload.",
    };
  }
  return { action: "unchanged", reason: "The same bytes are already stored under this key." };
}

/* -------------------------------------------------------------------------- */
/*  Removing                                                                  */
/* -------------------------------------------------------------------------- */

export interface PurgeDecision {
  allowed: boolean;
  /** This caller could remove it with `bypassGovernance`; COMPLIANCE never yields. */
  requiresBypass: boolean;
  reason: string;
}

/**
 * Whether an artifact's bytes may be removed now.
 *
 * Order matters: a legal hold is checked first, because it outranks the clock in
 * both directions — it blocks a locked artifact and it blocks one whose window
 * has already closed, until somebody releases it on the record.
 */
export function objectPurgeDecision(
  input: {
    lock: ObjectLock;
    /** Is a legal hold in force on the incident this artifact belongs to? */
    holdActive: boolean;
    purgedAt?: string | null;
  },
  now: string,
  options: { bypassGovernance?: boolean } = {},
): PurgeDecision {
  if (input.purgedAt) {
    return { allowed: false, requiresBypass: false, reason: "These bytes have already been purged." };
  }

  if (input.holdActive) {
    return {
      allowed: false,
      requiresBypass: false,
      reason: "A legal hold is in force on this incident, so nothing may be removed until it is released.",
    };
  }

  const until = new Date(input.lock.retainUntil).getTime();
  const at = new Date(now).getTime();

  if (at < until) {
    if (input.lock.mode === "COMPLIANCE") {
      return {
        allowed: false,
        requiresBypass: false,
        reason: `Retained in COMPLIANCE mode until ${input.lock.retainUntil}. No one can shorten that, including an administrator.`,
      };
    }
    if (options.bypassGovernance) {
      return {
        allowed: true,
        requiresBypass: true,
        reason: `GOVERNANCE retention until ${input.lock.retainUntil} removed early, on the record.`,
      };
    }
    return {
      allowed: false,
      requiresBypass: true,
      reason: `GOVERNANCE retention until ${input.lock.retainUntil}. Removing it early is possible, but has to be asked for explicitly and is recorded.`,
    };
  }

  return { allowed: true, requiresBypass: false, reason: "The retention window has closed." };
}

/* -------------------------------------------------------------------------- */
/*  The retention sweep                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What a sweep decided about one artifact.
 *
 * `RETAIN` and `HELD` are both "not now", and they are kept apart because they
 * mean different things to a reader: one is the clock still running (or a mode
 * that will not yield), the other is somebody having said "preserve this".
 */
export type RetentionSweepOutcome = "PURGE" | "RETAIN" | "HELD" | "ALREADY_GONE";

export interface RetentionSweepCandidate {
  artifactId: string;
  incidentId: string;
  key: string;
  bytes: number;
  lock: ObjectLock;
  /** Is a legal hold in force on the incident this artifact belongs to? */
  holdActive: boolean;
  purgedAt: string | null;
}

export interface RetentionSweepDecision {
  candidate: RetentionSweepCandidate;
  outcome: RetentionSweepOutcome;
  /** Why, in words a report can print. */
  reason: string;
  /** Removing it now would need an explicit governance bypass, on the record. */
  requiresBypass: boolean;
}

export interface RetentionSweepPlan {
  decisions: RetentionSweepDecision[];
  /** The artifacts the sweep may carry out, bytes and all. */
  purge: RetentionSweepDecision[];
  summary: {
    considered: number;
    purge: number;
    /** Still inside the window, or in a mode that will not shorten. */
    retained: number;
    held: number;
    alreadyGone: number;
    /** Bytes the purge list would free. */
    bytesFreed: number;
  };
}

/**
 * Decide what the clock allows a sweep to remove, using the *same* rule the
 * manual purge uses.
 *
 * That is the whole point of putting it here: a scheduled sweep and an
 * administrator pressing the button must not be able to disagree about whether a
 * COMPLIANCE artifact is removable, so both call `objectPurgeDecision` and this
 * function only classifies the answer. A sweep never bypasses GOVERNANCE unless
 * it is explicitly told to (`options.bypassGovernance`), and a legal hold stops
 * it in both directions.
 */
export function planRetentionSweep(
  candidates: readonly RetentionSweepCandidate[],
  now: string,
  options: { bypassGovernance?: boolean } = {},
): RetentionSweepPlan {
  const decisions: RetentionSweepDecision[] = candidates.map((candidate) => {
    const decision = objectPurgeDecision(
      { lock: candidate.lock, holdActive: candidate.holdActive, purgedAt: candidate.purgedAt },
      now,
      { bypassGovernance: options.bypassGovernance },
    );

    if (decision.allowed) {
      return { candidate, outcome: "PURGE", reason: decision.reason, requiresBypass: decision.requiresBypass };
    }

    const outcome: RetentionSweepOutcome = candidate.purgedAt
      ? "ALREADY_GONE"
      : candidate.holdActive
        ? "HELD"
        : "RETAIN";
    return { candidate, outcome, reason: decision.reason, requiresBypass: decision.requiresBypass };
  });

  const purge = decisions.filter((entry) => entry.outcome === "PURGE");
  return {
    decisions,
    purge,
    summary: {
      considered: decisions.length,
      purge: purge.length,
      retained: decisions.filter((entry) => entry.outcome === "RETAIN").length,
      held: decisions.filter((entry) => entry.outcome === "HELD").length,
      alreadyGone: decisions.filter((entry) => entry.outcome === "ALREADY_GONE").length,
      bytesFreed: purge.reduce((total, entry) => total + entry.candidate.bytes, 0),
    },
  };
}

/** The reason a sweep records when it removes something, sentence-shaped. */
export function retentionSweepReason(lock: ObjectLock): string {
  return `Retention window closed at ${lock.retainUntil}; purged by the scheduled retention sweep.`;
}

/* -------------------------------------------------------------------------- */
/*  Handing the lock to an object store                                       */
/* -------------------------------------------------------------------------- */

/**
 * The headers an S3-compatible backend needs to create an object under lock:
 * `PutObject` with `x-amz-object-lock-mode` and `x-amz-object-lock-retain-until-date`
 * on a bucket created with object lock enabled.
 *
 * On a filesystem nobody enforces a date, so the honest split is: this deployment
 * enforces the rules in `objectPutDecision`/`objectPurgeDecision` on every write
 * and removal, and a real object store enforces them against every writer. The
 * headers are here so adopting one is a matter of handing them over, not
 * rediscovering the semantics.
 */
export function objectLockHeaders(lock: ObjectLock): Record<string, string> {
  return {
    "x-amz-object-lock-mode": lock.mode,
    "x-amz-object-lock-retain-until-date": lock.retainUntil,
  };
}

/** Whether a stored artifact's bytes are still there. */
export function artifactHeld(artifact: { purgedAt?: string | null }): boolean {
  return !artifact.purgedAt;
}

/* -------------------------------------------------------------------------- */
/*  The bytes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Where artifact bytes live.
 *
 * Write-once by contract — `put` either creates the object or confirms the same
 * bytes are already there, and never replaces different bytes. Implementations
 * that can ask the storage layer to enforce that (a filesystem `wx` open, S3
 * object lock) should, because a service-level check is only as good as every
 * writer going through it.
 */
/** What a store reports back: it either created the object or found the same bytes already there. */
export type StorePutResult = "created" | "unchanged";

export interface EvidenceObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<StorePutResult>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

/** An in-memory store, for tests and single-process local development. */
export class MemoryEvidenceObjectStore implements EvidenceObjectStore {
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<StorePutResult> {
    const existing = this.objects.get(key);
    if (existing) {
      if (!sameBytes(existing.bytes, bytes)) {
        throw new Error(`Refusing to overwrite the locked object at ${key}.`);
      }
      return "unchanged";
    }
    this.objects.set(key, { bytes: bytes.slice(), contentType });
    return "created";
  }

  async get(key: string): Promise<Uint8Array | null> {
    const found = this.objects.get(key);
    return found ? found.bytes.slice() : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

/** Byte-for-byte comparison, without assuming the arrays are the same length. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}
