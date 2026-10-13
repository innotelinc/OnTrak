/**
 * A finished lab session, written into the family's one ledger.
 *
 * This is the body of `POST /api/v1/lab/completions`, lifted out of the route because
 * stage 3 gave the lab a second way to finish: a session run by *this* app, through the
 * ported control plane, grades itself here rather than reporting over HTTP. Both writers
 * have to produce the same rows — the attempt, its check results, its certificate, its
 * evidence, its audit entry, its graded announcement — or the family would have two
 * ledgers that disagree about what a lab result is. So the write lives here and the two
 * callers keep only what is theirs: the route its HTTP status codes, the action its
 * redirect.
 *
 * The contract it enforces is unchanged from the route's, and it is worth restating
 * because it is the reason the file exists:
 *
 * IDEMPOTENT BY `sessionId`. The lab may be interrupted between grading and reporting, so
 * it may send the same completion twice; the unique `labSessionId` makes a retry
 * recognised (the attempt it already has) rather than a second attempt. A concurrent
 * duplicate loses the unique race and is answered the same way, so the database — not a
 * read-then-write check — decides the winner.
 *
 * THE TASK HAS TO AGREE WITH THE EVIDENCE. The mode is `lab`, so the scenario filed
 * against must itself be tagged `lab`; anything else would record a live machine's grade
 * against a task that says it is simulated.
 */

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { submitCertificateToChain } from "@/lib/certificate-chain";
import { chainConfigFromEnv, describeChainOutcome, type ChainOutcome } from "@/lib/certificate-chain-rules";
import { certificateForAttempt, certificatePatchFor, type CertificateAttempt } from "@/lib/certificates";
import { certificateCode } from "@/lib/credentials";
import { announceGraded, storedCertificateOf } from "@/lib/graded-events";
import { gradingModeForTags } from "@/lib/grading-mode";
import { LAB_SCENARIO_TAG } from "@/lib/lab-rules";
import { labTimeSpentSec, type LabCompletion } from "@/lib/lab-completion-rules";

export type LabCompletionWrite =
  | { ok: true; attemptId: string; created: boolean }
  /** A refusal the caller turns into its own status code: 422 for data, 409 for no task. */
  | { ok: false; status: number; error: string };

export async function recordLabCompletion(completion: LabCompletion): Promise<LabCompletionWrite> {
  // Idempotency first, before anything is resolved: a retry must get the same
  // answer even if the learner or scenario has changed since the first delivery.
  const existing = await prisma.attempt.findUnique({
    where: { labSessionId: completion.sessionId },
    select: { id: true },
  });
  if (existing) {
    return { ok: true, attemptId: existing.id, created: false };
  }

  const learner = await prisma.user.findUnique({
    where: { email: completion.learnerEmail },
    select: { id: true, email: true, name: true },
  });
  if (!learner) {
    return { ok: false, status: 422, error: `No account uses ${completion.learnerEmail}.` };
  }

  const scenario = await prisma.scenario.findFirst({
    where: completion.scenarioId ? { id: completion.scenarioId } : { slug: completion.scenarioSlug ?? "" },
    select: { id: true, slug: true, title: true, platform: true, passScore: true, tags: true },
  });
  if (!scenario) {
    return { ok: false, status: 422, error: "No scenario matches that id or slug." };
  }

  // The task has to be the lab's own, or the evidence would disagree with the task
  // it is filed against (§6/C2). A completion on a simulated scenario is refused
  // rather than quietly recorded with a mode the scenario does not carry.
  if (gradingModeForTags(scenario.tags) !== "lab") {
    return {
      ok: false,
      status: 422,
      error:
        `"${scenario.slug}" is not a lab scenario — it is not tagged "${LAB_SCENARIO_TAG}" — ` +
        "so a lab completion does not belong on it.",
    };
  }

  const maxScore = completion.maxScore;
  const passScore = completion.passScore ?? scenario.passScore;
  const startedAt = completion.startedAt ?? completion.completedAt;
  const timeSpentSec = labTimeSpentSec(completion.startedAt, completion.completedAt);
  // The certificate rides on the same facts as the attempt, mode included, so the
  // pasted record can say it was a live machine that graded it.
  const certificateFacts: CertificateAttempt = {
    learnerId: learner.id,
    learnerName: learner.name,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    platform: scenario.platform,
    score: completion.score,
    maxScore,
    passScore,
    completedAt: completion.completedAt,
    skills: scenario.tags,
    mode: "lab",
  };
  const certificate = certificatePatchFor(certificateFacts, null, completion.completedAt);

  let attemptId: string;
  try {
    const attempt = await prisma.$transaction(async (tx) => {
      const row = await tx.attempt.create({
        data: {
          userId: learner.id,
          scenarioId: scenario.id,
          // The work was already finished when it arrived; there is no running clock
          // to expire, so the attempt is born graded.
          status: "GRADED",
          startedAt,
          expiresAt: completion.completedAt,
          submittedAt: completion.completedAt,
          gradedAt: completion.completedAt,
          timeSpentSec,
          score: completion.score,
          maxScore,
          // The session id is the seed too: an attempt replayed from the same session
          // gets the same deterministic opening state, as a retry should.
          seed: completion.sessionId,
          gradingMode: "lab",
          labSessionId: completion.sessionId,
          ...certificate,
        },
      });
      if (completion.checks.length > 0) {
        await tx.checkResult.createMany({
          data: completion.checks.map((check) => ({ attemptId: row.id, ...check })),
        });
      }
      return row;
    });
    attemptId = attempt.id;
  } catch (error) {
    // A concurrent delivery of the same session lost the unique race. The row it
    // collided with is the one this request means, so answer with it rather than
    // failing a duplicate that is not the lab's fault.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await prisma.attempt.findUnique({
        where: { labSessionId: completion.sessionId },
        select: { id: true },
      });
      if (raced) return { ok: true, attemptId: raced.id, created: false };
    }
    throw error;
  }

  await recordAudit({
    actorId: null,
    action: "attempt.lab_completion",
    targetType: "attempt",
    targetId: attemptId,
    detail: {
      scenarioId: scenario.id,
      sessionId: completion.sessionId,
      score: completion.score,
      maxScore,
      timedOut: false,
      mode: "lab",
    },
  });

  await announceGraded({
    attempt: {
      id: attemptId,
      status: "GRADED",
      mode: "lab",
      score: completion.score,
      maxScore,
      startedAt,
      submittedAt: completion.completedAt,
      gradedAt: completion.completedAt,
      timeSpentSec,
    },
    learner,
    scenario: { id: scenario.id, title: scenario.title, platform: scenario.platform, passScore },
    cohort: null,
    checks: completion.checks,
    certificate: await storedCertificateOf(attemptId),
  });

  // Only a pass is a certificate, and only a certificate goes down the chain: `certificatePatchFor`
  // returns a record exactly when the attempt cleared its pass mark.
  if (certificate.certificate !== undefined) {
    await sendCertificateDownChain(attemptId, certificateFacts);
  }

  return { ok: true, attemptId, created: true };
}

/**
 * The certificate's trip down the family's trust chain.
 *
 * A lab certificate is **issued by AthenIQ** — the learning platform whose enrolment
 * entitled the learner — **signed by Signara**, and **stored on ONYX**. The range drives
 * that itself (`src/lib/certificate-chain.ts`) because a lab session is this product's
 * grade of a live machine rather than a course completion AthenIQ ever saw.
 *
 * It runs *after* the row is written, and every outcome is a value rather than an
 * exception. That ordering is the point: a signing key that has expired is an operator's
 * morning, and a learner's attempt that was rolled back because Signara was unreachable
 * would be a result destroyed by somebody else's outage. The local record and its code
 * stand either way — the chain adds a signature to them, it does not hold them up.
 */
async function sendCertificateDownChain(attemptId: string, facts: CertificateAttempt): Promise<void> {
  const config = chainConfigFromEnv();
  const record = certificateForAttempt(facts);

  let outcome: ChainOutcome;
  try {
    outcome = await submitCertificateToChain(
      {
        learnerName: facts.learnerName,
        scenarioTitle: facts.scenarioTitle,
        platform: facts.platform,
        score: facts.score,
        maxScore: facts.maxScore,
        completedAt: facts.completedAt.toISOString(),
        code: certificateCode(record),
        issuer: config.issuer,
        verifyUrl: config.verifyUrl,
        skills: record.skills ?? [],
      },
      { config },
    );
  } catch (cause) {
    // The chain reports its own refusals; a throw is the transport falling over under it,
    // and it is recorded the same way so nothing about a certificate is silent.
    outcome = { kind: "refused", step: "upload", reason: cause instanceof Error ? cause.message : String(cause) } as const;
  }

  // A deployment that has not adopted the chain says nothing, on every completion.
  if (outcome.kind === "off") return;

  await recordAudit({
    actorId: null,
    action: "attempt.certificate_chain",
    targetType: "attempt",
    targetId: attemptId,
    detail: {
      outcome: outcome.kind,
      detail: describeChainOutcome(outcome),
      ...(outcome.kind === "signed"
        ? { requestId: outcome.requestId, documentId: outcome.documentId, objectKey: outcome.objectKey }
        : {}),
    },
  });

  if (outcome.kind !== "signed") {
    console.error(`certificate chain (attempt ${attemptId}): ${describeChainOutcome(outcome)}`);
  }
}

/**
 * The app scenario a ported lab scenario belongs to, or `null`.
 *
 * The two catalogues are separate rows on purpose (§6/C3): the lab's tree is authored in
 * the lab's Python and imported (`scripts/import-lab-scenarios.ts`), which keeps the lab's id as
 * the family's slug. So the lookup is by slug, and a deployment that has not imported the
 * catalogue has no task to file against — which is answered as `null` rather than as an
 * error, because the session itself was graded and stored either way.
 */
export async function familyScenarioFor(
  labScenarioId: string,
): Promise<{ id: string; slug: string } | null> {
  const row = await prisma.scenario.findFirst({
    where: { slug: labScenarioId, tags: { has: LAB_SCENARIO_TAG } },
    select: { id: true, slug: true },
  });
  return row;
}

