/**
 * Certificates — the wiring that turns a graded attempt into the completion
 * record modelled in `credentials.ts`.
 *
 * A record is *built* from the attempt's own facts (who, what, when, outcome)
 * plus the deployment's issuer name, and then **stored on the attempt** the
 * first time it clears the pass mark. Storing it is what makes the code a
 * learner was handed durable: a re-grade recalculates the score but keeps the
 * issued record, so the printed code still verifies months later instead of
 * quietly re-pointing at a different record. The decision of whether to issue,
 * keep or revoke lives in `certificate-rules.ts`; this module applies it.
 *
 * `node:crypto` keeps this module server-only; `credentials.ts` stays pure and
 * hash-agnostic so the same model can run behind an HSM later.
 */

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  ASSURANCE_PACKET_FORMAT,
  buildCompletionRecord,
  certificateCode,
  COMPLETION_FORMAT,
  verifyAssurancePacket,
  verifyCompletionRecord,
  type AssurancePacket,
  type CompletionInput,
  type CompletionRecord,
  type HashFn,
} from "./credentials";
import {
  certificateAction,
  readStoredCertificate,
  verifyInputProblem,
  type StoredCertificate,
} from "./certificate-rules";
import { normalizeGradingMode, type GradingMode } from "./grading-mode";

export { readStoredCertificate, type StoredCertificate };

/** SHA-256 of a UTF-8 string, lower-case hex — the production signer. */
export const sha256Hex: HashFn = (input) => createHash("sha256").update(input, "utf8").digest("hex");

export const DEFAULT_ISSUER = "OnTrak IT Support Training";

/**
 * Who issues the records: this deployment, by name. A site that runs OnTrak for
 * a college or an employer sets `ONTRAK_ISSUER` so the certificates it hands
 * out are attributed to *it* rather than to the software.
 */
export function issuerName(): string {
  return process.env.ONTRAK_ISSUER?.trim() || DEFAULT_ISSUER;
}

/** How many competency tags a record carries before the list stops meaning anything. */
export const MAX_SKILLS = 8;

/** The attempt facts a certificate needs — a subset of the `Attempt` row. */
export interface CertificateAttempt {
  learnerId: string;
  learnerName: string;
  scenarioId: string;
  scenarioTitle: string;
  platform: string;
  score: number;
  maxScore: number;
  passScore: number;
  /** When grading happened; callers fall back to submission, then the start. */
  completedAt: Date;
  /** Scenario tags, read as the competencies the attempt demonstrated. */
  skills?: readonly string[];
  /**
   * Who graded the attempt (`Attempt.gradingMode`). Omitted for a caller that has
   * none — the record then carries no mode rather than a guessed one.
   */
  mode?: GradingMode | string | null;
}

/** Percentage of the maximum, safe when the scenario was worth zero points. */
export function attemptPercentOf(attempt: Pick<CertificateAttempt, "score" | "maxScore">): number {
  if (attempt.maxScore <= 0) return 0;
  return Math.round((attempt.score / attempt.maxScore) * 100);
}

/** Did this attempt clear the scenario's own pass mark? */
export function attemptPassed(
  attempt: Pick<CertificateAttempt, "score" | "maxScore" | "passScore">,
): boolean {
  return attemptPercentOf(attempt) >= attempt.passScore;
}

/** Trimmed, de-duplicated competency tags, in author order, capped. */
export function skillsFor(tags: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const tag of tags ?? []) {
    const skill = tag.trim();
    if (!skill || seen.has(skill.toLowerCase())) continue;
    seen.add(skill.toLowerCase());
    skills.push(skill);
    if (skills.length >= MAX_SKILLS) break;
  }
  return skills;
}

/** The unsigned statement behind a certificate. Pure — no hashing here. */
export function completionInputFor(
  attempt: CertificateAttempt,
  issuer: string = issuerName(),
): CompletionInput {
  return {
    learnerId: attempt.learnerId,
    learnerName: attempt.learnerName,
    scenarioId: attempt.scenarioId,
    scenarioTitle: attempt.scenarioTitle,
    platform: attempt.platform,
    passed: attemptPassed(attempt),
    score: attempt.score,
    maxScore: attempt.maxScore,
    percent: attemptPercentOf(attempt),
    skills: skillsFor(attempt.skills),
    completedAt: attempt.completedAt.toISOString(),
    issuer,
    // Only when the attempt says how it was graded. Spreading conditionally keeps
    // the key out of the record entirely for an attempt that has no mode, so a
    // record issued before modes existed hashes exactly as it did.
    ...(attempt.mode ? { mode: normalizeGradingMode(attempt.mode) } : {}),
  };
}

/** The signed record for a finished attempt. */
export function certificateForAttempt(attempt: CertificateAttempt): CompletionRecord {
  return buildCompletionRecord(completionInputFor(attempt), sha256Hex);
}

/** The short code printed on the certificate. */
export function certificateCodeForAttempt(attempt: CertificateAttempt): string {
  return certificateCode(certificateForAttempt(attempt));
}

/**
 * Is this record intact — that is, does its digest still match its own content?
 * A record that has been edited anywhere fails this.
 */
export function recordIntact(record: CompletionRecord): boolean {
  return verifyCompletionRecord(record, sha256Hex);
}

/* -------------------------------------------------------------------------- */
/*  Issuing, keeping and revoking                                             */
/* -------------------------------------------------------------------------- */

/**
 * A fragment for the certificate columns, for `create` or `update`.
 *
 * Empty for the common cases — a failing attempt that never had a certificate,
 * or a re-grade that leaves a live one alone — so the caller can spread it into
 * the same write that records the score. Typed against the *create* input, whose
 * fields are plain values rather than update operations: every value produced here
 * is a record or a date, so both an insert (`lab/completions`) and an update
 * (`regradeAttempt`, `submitAttempt`) accept it.
 */
export type CertificatePatch = Pick<
  Prisma.AttemptCreateInput,
  "certificate" | "certificateIssuedAt" | "certificateRevokedAt"
>;

/**
 * What the certificate columns should become now that this attempt has been
 * graded: issue the first record, keep an existing one exactly as issued, or
 * record that a re-grade revoked it.
 *
 * `now` is passed in so the caller can stamp the same instant it writes as
 * `gradedAt`, rather than reading the clock twice.
 */
export function certificatePatchFor(
  attempt: CertificateAttempt,
  stored: StoredCertificate | null | undefined,
  now: Date = new Date(),
): CertificatePatch {
  switch (certificateAction(attemptPassed(attempt), stored)) {
    case "issue":
      return {
        certificate: certificateForAttempt(attempt) as unknown as Prisma.InputJsonValue,
        certificateIssuedAt: now,
        certificateRevokedAt: null,
      };
    case "revoke":
      return { certificateRevokedAt: now };
    default:
      return {};
  }
}

/** The record to show on a report, and how it got there. */
export interface CertificateView {
  record: CompletionRecord;
  /**
   * `stored` — issued when the attempt was graded, and unchanged since.
   * `derived` — built now, for a pass graded before records were stored.
   */
  source: "stored" | "derived";
  /** When a re-grade revoked the stored record, if one did. */
  revokedAt: Date | null;
}

/**
 * What to display for an attempt.
 *
 * A stored record wins even if a later re-grade moved the score, because the
 * certificate attests the result *at issue time*. A revoked record is surfaced
 * as revoked rather than hidden. Attempts graded before records were stored fall
 * back to deriving one, so no pass loses its certificate.
 */
export function certificateViewFor(
  attempt: CertificateAttempt,
  stored: StoredCertificate | null,
): CertificateView | null {
  if (stored) {
    return {
      record: stored.record,
      source: "stored",
      revokedAt: stored.revokedAt ? new Date(stored.revokedAt) : null,
    };
  }
  if (!attemptPassed(attempt)) return null;
  return { record: certificateForAttempt(attempt), source: "derived", revokedAt: null };
}

/* -------------------------------------------------------------------------- */
/*  Checking pasted evidence                                                  */
/* -------------------------------------------------------------------------- */

export interface EvidenceVerdict {
  status: "valid" | "invalid" | "error";
  /** Which of the two shapes was checked. */
  kind?: "record" | "packet";
  /** The record's human-readable code, when there is one. */
  code?: string;
  /** Who/what was checked, for the verdict message. */
  summary?: string;
  error?: string;
}

function isRecord(value: unknown): value is CompletionRecord {
  const candidate = value as Partial<CompletionRecord>;
  return (
    typeof candidate?.digest === "string" &&
    typeof candidate?.learnerId === "string" &&
    typeof candidate?.scenarioId === "string"
  );
}

function isPacket(value: unknown): value is AssurancePacket {
  const candidate = value as Partial<AssurancePacket>;
  return typeof candidate?.digest === "string" && Array.isArray(candidate?.records);
}

/**
 * Check a pasted completion record or assurance packet.
 *
 * Everything needed is inside the document itself, so this reads nothing from
 * the database: an auditor's copy verifies on a fresh deployment, and a tampered
 * copy fails on the one that issued it.
 */
export function interpretEvidence(raw: string): EvidenceVerdict {
  // Whitespace-only input is empty input, not a JSON syntax error — the caller
  // should not have to remember to trim what it read out of a form.
  const text = raw.trim();
  const problem = verifyInputProblem(text);
  if (problem) return { status: "error", error: problem };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "error", error: "That is not valid JSON." };
  }

  if (isPacket(parsed) && parsed.format === ASSURANCE_PACKET_FORMAT) {
    return {
      status: verifyAssurancePacket(parsed, sha256Hex) ? "valid" : "invalid",
      kind: "packet",
      summary: `${parsed.records.length} completion record(s) from ${parsed.issuer ?? "an unnamed issuer"}`,
    };
  }

  if (isRecord(parsed) && parsed.format === COMPLETION_FORMAT) {
    return {
      status: verifyCompletionRecord(parsed, sha256Hex) ? "valid" : "invalid",
      kind: "record",
      code: certificateCode(parsed),
      summary: `${parsed.learnerName ?? "A learner"} · ${parsed.scenarioTitle ?? "a scenario"} · ${
        parsed.percent ?? "?"
      }%${parsed.mode ? ` · ${parsed.mode}` : ""}`,
    };
  }

  return {
    status: "error",
    error: "That JSON is neither a completion record nor an assurance packet.",
  };
}
