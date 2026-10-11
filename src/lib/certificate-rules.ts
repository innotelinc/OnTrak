/**
 * Rules for issuing, keeping and revoking certificates, plus the guard on pasted
 * evidence — as pure functions.
 *
 * A certificate is issued once and then *kept*: the code a learner was handed
 * has to keep verifying, so a re-grade must not silently rewrite it. The one
 * thing a re-grade may do is revoke it, when the corrected grading drops the
 * attempt back below the pass mark. Deciding which of those applies is the whole
 * of `certificateAction`, and it lives here — away from the database and the
 * framework — so it can be tested directly.
 */

import type { CompletionRecord } from "./credentials";

/**
 * A completion record as it is stored on an attempt.
 *
 * The record itself is unchanged from the shared evidence model — the
 * `certificate` column holds exactly a `CompletionRecord`, so it can be exported
 * and pasted into `/verify` as it stands. The two dates around it are proper
 * columns rather than fields of the JSON, which is what keeps the record pure.
 */
export interface StoredCertificate {
  record: CompletionRecord;
  /** When the record was issued, ISO-8601 UTC. */
  issuedAt: string;
  /**
   * When a re-grade revoked the record, ISO-8601 UTC — `null` while it stands.
   * Cleared if a later re-grade re-issues the attempt a certificate.
   */
  revokedAt?: string | null;
}

/** The three `Attempt` columns a certificate lives in. */
export interface CertificateColumns {
  certificate: unknown;
  certificateIssuedAt: Date | string | null;
  certificateRevokedAt: Date | string | null;
}

/** What an attempt's grading should do to its certificate. */
export type CertificateAction = "issue" | "keep" | "revoke" | "none";

/**
 * Decide what to do with an attempt's certificate after grading it.
 *
 * - a pass with no live record → `issue` the first one
 * - a pass that already has one → `keep` it untouched, so the printed code stays
 *   valid whatever the re-grade changed
 * - a failure with a live record → `revoke` it: the corrected grading says the
 *   work did not pass, and a certificate cannot outlive its own result
 * - a failure with nothing to revoke → `none`
 */
export function certificateAction(
  passed: boolean,
  stored: StoredCertificate | null | undefined,
): CertificateAction {
  const live = Boolean(stored && !stored.revokedAt);
  if (!passed) return live ? "revoke" : "none";
  return live ? "keep" : "issue";
}

/**
 * Read a stored certificate back off an attempt row.
 *
 * The `certificate` column is `Json?`, so anything could be in it — a row from
 * an older deployment, a hand-edited value. Something that is not recognisably a
 * record is treated as no certificate at all, which fails closed: nothing is
 * displayed, and the next grading issues a fresh record rather than trusting
 * whatever is in there.
 */
export function readStoredCertificate(row: CertificateColumns): StoredCertificate | null {
  const record = row.certificate as Partial<CompletionRecord> | null | undefined;
  if (!record || typeof record !== "object") return null;
  if (typeof record.digest !== "string" || typeof record.learnerId !== "string") return null;
  // A record with no issue date cannot be attributed to a moment, and every
  // certificate claims one, so treat the row as having no certificate.
  if (!row.certificateIssuedAt) return null;

  return {
    record: record as CompletionRecord,
    issuedAt: isoString(row.certificateIssuedAt),
    revokedAt: row.certificateRevokedAt ? isoString(row.certificateRevokedAt) : null,
  };
}

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Largest pasted document we will hash, in characters. */
export const MAX_EVIDENCE_CHARS = 200_000;

/** Why this pasted evidence cannot be checked, or `null` when it can. */
export function verifyInputProblem(raw: string): string | null {
  if (!raw) return "Paste a certificate record or an assurance packet first.";
  if (raw.length > MAX_EVIDENCE_CHARS) {
    return `That is ${raw.length} characters — far larger than a completion record or packet should be.`;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  The printed certificate number                                            */
/* -------------------------------------------------------------------------- */

/**
 * The shape ``certificateCode`` prints: ``ONTRAK-XXXX-XXXX-XXXX``.
 *
 * Twelve hex characters of the record's own digest — the part a learner reads
 * off the certificate and types back in. It is an *identifier*, not a signature:
 * the digest it is cut from cannot be recovered from it, so a number is only ever
 * checked against the records this deployment issued (see `/verify`).
 */
export const CERTIFICATE_NUMBER_PATTERN = /^ONTRAK-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;

/** How many characters a typed number may have before it is clearly not one. */
export const MAX_CERTIFICATE_NUMBER_CHARS = 64;

/**
 * A typed certificate number folded to the printed spelling, or `null`.
 *
 * People retype these with the wrong case, with spaces where the dashes go, or
 * with the dashes dropped entirely, and none of that is a reason to tell them
 * their certificate is bad. All of it folds to ``ONTRAK-XXXX-XXXX-XXXX``; what
 * is left that still cannot be a number returns `null`, which the caller reports
 * as unusable *input* rather than as an unverified certificate.
 */
export function normaliseCertificateNumber(raw: string): string | null {
  const compact = raw.trim().toUpperCase().replace(/[\s\-–—]/g, "");
  if (!/^ONTRAK[0-9A-F]{12}$/.test(compact)) return null;
  const hex = compact.slice("ONTRAK".length);
  return `ONTRAK-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

/** Why this typed number cannot be checked, or `null` when it can. */
export function certificateNumberProblem(raw: string): string | null {
  const text = raw.trim();
  if (!text) return "Type the certificate number first.";
  if (text.length > MAX_CERTIFICATE_NUMBER_CHARS) {
    return `That is ${text.length} characters — a certificate number is 19.`;
  }
  if (!normaliseCertificateNumber(text)) {
    return "That is not a certificate number. They are printed as ONTRAK-XXXX-XXXX-XXXX, in A–F and 0–9.";
  }
  return null;
}

/** What `/verify` prints. Two words, and nothing else: whether the number stands. */
export type CertificateNumberStatus = "verified" | "unverified";

/**
 * Whether a number stands, given the record issued under it.
 *
 * Verified needs all three of: this deployment has a record printed under that
 * number, a later re-grade has not revoked it, and the stored content still
 * matches its own digest. A number nobody issued, a revoked one and an edited
 * record all print the same word — "unverified" — because to the person doing
 * the checking they are the same answer.
 *
 * `intact` is passed in rather than computed here so this stays pure, and so the
 * caller cannot report a verdict that no digest backs.
 */
export function certificateNumberVerdict(
  issued: StoredCertificate | null | undefined,
  intact: boolean,
): CertificateNumberStatus {
  if (!issued || issued.revokedAt) return "unverified";
  return intact ? "verified" : "unverified";
}
