/**
 * A graded attempt as the payload a consumer receives.
 *
 * This is the one place that knows both worlds — the database row and the
 * published event — so the JSON the webhook posts and the JSON `/api/v1/results`
 * answers with cannot describe the same attempt differently. Everything here is
 * presentation: which dates are ISO strings, that a missing `gradedAt` falls back
 * to submission rather than becoming `null` in a field a consumer will parse.
 *
 * The rules that decide anything are in `webhook-rules.ts`; this only fits
 * columns to them, which is why the interesting tests are over there.
 */

import { certificateCode, type CompletionRecord } from "./credentials";
import { readStoredCertificate, type StoredCertificate } from "./certificate-rules";
import { prisma } from "./db";
import { gradedEventInput, type GradedEventInput, type WebhookCheck } from "./webhook-rules";
import { deliverGradedEvent } from "./webhook-delivery";
import { announceScore } from "./lti-grade";

export interface GradedAttemptFacts {
  attempt: {
    id: string;
    status: string;
    score: number;
    maxScore: number;
    startedAt: Date;
    submittedAt: Date | null;
    gradedAt: Date | null;
    timeSpentSec: number;
  };
  learner: { id: string; email: string; name: string };
  scenario: { id: string; title: string; platform: string; passScore: number };
  cohort: { id: string; name: string } | null;
  checks: readonly WebhookCheck[];
  certificate: StoredCertificate | null;
}

/**
 * The certificate on an attempt as it now stands, read back from the row.
 *
 * Read rather than assembled from the grading decision, because what grading
 * *decided* and what the attempt *holds* differ in the one case that matters: a
 * re-grade that keeps an issued record changes nothing in the database, and the
 * event still has to carry the code the learner was handed.
 */
export async function storedCertificateOf(attemptId: string): Promise<StoredCertificate | null> {
  const row = await prisma.attempt.findUnique({
    where: { id: attemptId },
    select: { certificate: true, certificateIssuedAt: true, certificateRevokedAt: true },
  });
  return row ? readStoredCertificate(row) : null;
}

export function gradedEventFor(facts: GradedAttemptFacts): GradedEventInput {
  const { attempt } = facts;
  return gradedEventInput({
    attemptId: attempt.id,
    status: attempt.status,
    learner: facts.learner,
    scenario: facts.scenario,
    cohort: facts.cohort,
    score: attempt.score,
    maxScore: attempt.maxScore,
    passScore: facts.scenario.passScore,
    startedAt: attempt.startedAt.toISOString(),
    submittedAt: attempt.submittedAt?.toISOString() ?? null,
    // Grading always sets a time; an attempt that somehow has none is dated by
    // when it was handed in or started, because a payload with no `gradedAt`
    // would leave a consumer unable to order the events it receives.
    gradedAt: (attempt.gradedAt ?? attempt.submittedAt ?? attempt.startedAt).toISOString(),
    timeSpentSec: attempt.timeSpentSec,
    certificate: facts.certificate ? certificateFact(facts.certificate) : null,
    checks: facts.checks,
  });
}

function certificateFact(stored: StoredCertificate): GradedEventInput["certificate"] {
  return {
    code: certificateCode(stored.record as CompletionRecord),
    digest: stored.record.digest,
    issuedAt: stored.issuedAt,
    revokedAt: stored.revokedAt ?? null,
  };
}

/**
 * Tell everybody outside this deployment about a grading, and never let that
 * break it.
 *
 * Two audiences, and they are told in one place because they are the same fact.
 * A **webhook consumer** is a deployment's own integration; a **learning platform**
 * is where the attempt started, when it started in one. Neither is allowed to fail
 * a submission: a graded attempt is a fact whether or not anybody outside hears
 * about it, so an unreachable consumer leaves a FAILED delivery row and a log line,
 * and a platform that refused a score leaves the grade exactly where it is.
 */
export async function announceGraded(facts: GradedAttemptFacts): Promise<void> {
  try {
    const result = await deliverGradedEvent(gradedEventFor(facts));
    if (result.status === "FAILED") {
      console.warn(`[webhook] ${result.eventId} was refused: ${result.error ?? "no reason given"}`);
    }
  } catch (error) {
    console.error("[webhook] could not deliver a graded attempt", error);
  }

  // The platform the attempt was launched from, if any. It reads the attempt row
  // itself, because the launch context is a property of the attempt rather than of
  // the grading decision, and an instructor re-grading is a different person from
  // the learner who launched it.
  await announceScore(facts.attempt.id);
}

/** The per-check list a payload carries, from grading's own report rows. */
export function checksFor(
  results: readonly { checkId: string; label: string; passed: boolean; points: number; maxPoints: number }[],
): WebhookCheck[] {
  return results.map((result) => ({
    checkId: result.checkId,
    label: result.label,
    passed: result.passed,
    points: result.points,
    maxPoints: result.maxPoints,
  }));
}
