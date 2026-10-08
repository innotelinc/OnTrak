/**
 * `POST /api/v1/lab/completions` — a finished lab session, recorded as a graded attempt.
 *
 * The lab (OnTrak-dev) grades a task against a live machine. This is the door that
 * accepts the result and writes it into the family's one ledger
 * (docs/consolidation-audit.md §9/Q3): the attempt, its check results, its
 * certificate and its evidence all land here, with `gradingMode = 'lab'`, so the
 * instructor view and the results feed see it beside the simulated attempts.
 * The full contract is in [lab-completion.md](../../../../../../docs/lab-completion.md).
 *
 *   POST /api/v1/lab/completions
 *   Authorization: Bearer $ONTRAK_API_TOKEN
 *   { "format": "ontrak.lab.completion/v1", "sessionId": "sess-1",
 *     "learnerEmail": "ada@acme.test", "scenarioSlug": "broken-nic",
 *     "score": 8, "maxScore": 10, "completedAt": "2026-10-05T09:20:00.000Z" }
 *
 * IDEMPOTENT BY `sessionId`. The lab may be interrupted between grading and
 * reporting, so it may send the same completion twice; the unique `labSessionId`
 * makes a retry recognised (200 with the attempt it already has) rather than a
 * second attempt. A concurrent duplicate loses the unique race and is answered the
 * same way, so the database — not a read-then-write check — decides the winner.
 *
 * The token is the deployment's shared API token, the same one the read routes use:
 * this is a machine-to-machine call with no browser and no user. Unconfigured is a
 * 503 with a reason, not a 401.
 */

import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { apiAccess } from "../../_access";
import { recordAudit } from "@/lib/audit";
import { certificatePatchFor } from "@/lib/certificates";
import { announceGraded, storedCertificateOf } from "@/lib/graded-events";
import { gradingModeForTags } from "@/lib/grading-mode";
import { LAB_SCENARIO_TAG } from "@/lib/lab-rules";
import { labTimeSpentSec, readLabCompletion } from "@/lib/lab-completion-rules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = apiAccess(request);
  if (!access.ok) return access.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "The body was not JSON." }, { status: 400 });
  }

  const read = readLabCompletion(body);
  if (!read.ok) {
    return NextResponse.json({ error: "The lab completion is not usable.", issues: read.issues }, { status: 422 });
  }
  const completion = read.value;

  // Idempotency first, before anything is resolved: a retry must get the same
  // answer even if the learner or scenario has changed since the first delivery.
  const existing = await prisma.attempt.findUnique({
    where: { labSessionId: completion.sessionId },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json({ ok: true, attemptId: existing.id, created: false }, { status: 200 });
  }

  const learner = await prisma.user.findUnique({
    where: { email: completion.learnerEmail },
    select: { id: true, email: true, name: true },
  });
  if (!learner) {
    return NextResponse.json({ error: `No account uses ${completion.learnerEmail}.` }, { status: 422 });
  }

  const scenario = await prisma.scenario.findFirst({
    where: completion.scenarioId ? { id: completion.scenarioId } : { slug: completion.scenarioSlug ?? "" },
    select: { id: true, slug: true, title: true, platform: true, passScore: true, tags: true },
  });
  if (!scenario) {
    return NextResponse.json({ error: "No scenario matches that id or slug." }, { status: 422 });
  }

  // The task has to be the lab's own, or the evidence would disagree with the task
  // it is filed against (§6/C2). A completion on a simulated scenario is refused
  // rather than quietly recorded with a mode the scenario does not carry.
  if (gradingModeForTags(scenario.tags) !== "lab") {
    return NextResponse.json(
      {
        error:
          `"${scenario.slug}" is not a lab scenario — it is not tagged "${LAB_SCENARIO_TAG}" — ` +
          "so a lab completion does not belong on it.",
      },
      { status: 422 },
    );
  }

  const maxScore = completion.maxScore;
  const passScore = completion.passScore ?? scenario.passScore;
  const startedAt = completion.startedAt ?? completion.completedAt;
  const timeSpentSec = labTimeSpentSec(completion.startedAt, completion.completedAt);
  // The certificate rides on the same facts as the attempt, mode included, so the
  // pasted record can say it was a live machine that graded it.
  const certificate = certificatePatchFor(
    {
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
    },
    null,
    completion.completedAt,
  );

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
      if (raced) return NextResponse.json({ ok: true, attemptId: raced.id, created: false }, { status: 200 });
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

  return NextResponse.json({ ok: true, attemptId, created: true }, { status: 201 });
}
