"use server";

/**
 * Certificate verification.
 *
 * The public question is "does this certificate stand?", and the thing a person
 * actually has in their hand is the **number** printed on it — `ONTRAK-XXXX-XXXX-XXXX`
 * — not a JSON document. So this takes the number, finds the record this
 * deployment issued under it and answers `verified` or `unverified`. Nothing is
 * written.
 *
 * A number is an identifier rather than a signature: it is cut from the record's
 * own digest, and a digest cannot be recovered from twelve of its characters. So
 * this is the one verification path that *does* read our data — it is the only
 * way to answer the question — and the pure half (the shape of the number, and
 * what a found record means) lives in `certificate-rules.ts` so it can be tested
 * away from the framework.
 */

import { prisma } from "@/lib/db";
import { certificateNumberFor, certificateNumberVerdictFor, readStoredCertificate } from "@/lib/certificates";
import { certificateNumberProblem, normaliseCertificateNumber } from "@/lib/certificate-rules";

export interface VerifyState {
  /** `idle` before the first submission; `error` when the typed number is unusable. */
  status: "idle" | "verified" | "unverified" | "error";
  /** The number as it will be printed back, once the input parsed. */
  number?: string;
  /** Who and what the record names. Shown only when the number verifies. */
  summary?: string;
  error?: string;
}

/**
 * How many issued records are read while looking for a number.
 *
 * The number is derived from the record, so it is not a column to index and there
 * is nothing to look up by. Reading the records that carry one, newest first,
 * keeps that a bounded read on a deployment with a long history; the ceiling is
 * far above the number of certificates a class-size range issues, and a number
 * older than the cap still verifies against a copy of the record itself.
 */
const NUMBER_SCAN_LIMIT = 5000;

export async function verifyCertificateNumber(
  _previous: VerifyState,
  formData: FormData,
): Promise<VerifyState> {
  const raw = String(formData.get("number") ?? "");
  const problem = certificateNumberProblem(raw);
  if (problem) return { status: "error", error: problem };

  const number = normaliseCertificateNumber(raw);
  if (!number) return { status: "error", error: "That is not a certificate number." };

  const rows = await prisma.attempt.findMany({
    where: { certificateIssuedAt: { not: null } },
    select: { certificate: true, certificateIssuedAt: true, certificateRevokedAt: true },
    orderBy: { certificateIssuedAt: "desc" },
    take: NUMBER_SCAN_LIMIT,
  });

  const match = rows.find((row) => certificateNumberFor(row) === number);
  if (!match) return { status: "unverified", number };

  // A revoked record, and one whose stored content no longer matches its own
  // digest, are the same answer to the person checking: unverified.
  if (certificateNumberVerdictFor(match) !== "verified") {
    return { status: "unverified", number };
  }

  const stored = readStoredCertificate(match);
  return {
    status: "verified",
    number,
    summary: stored
      ? `${stored.record.learnerName ?? "A learner"} · ${stored.record.scenarioTitle ?? "a scenario"}`
      : undefined,
  };
}
