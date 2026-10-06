"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { gradeAttempt } from "@/lib/sim/grade";
import { createInitialState } from "@/lib/sim/state";
import {
  coerceSubmittedState,
  createAttempt,
  effectiveTimeLimit,
  isExpired,
  SCENARIO_INCLUDE,
  toDefinition,
} from "@/lib/scenarios";
import { evaluateScenario, loadAvailabilityContext } from "@/lib/availability";
import { disposeSession, runSandboxCommand } from "@/lib/sim/sandbox";
import { recordAudit } from "@/lib/audit";
import { certificatePatchFor, readStoredCertificate } from "@/lib/certificates";
import { announceGraded, checksFor, storedCertificateOf } from "@/lib/graded-events";
import { clearLtiLaunch, readLtiLaunch } from "@/lib/lti-session";
import type { Prisma } from "@prisma/client";
import type { SandboxCommandResponse } from "@/lib/sim/drivers/proxy";
import type { EngineState } from "@/lib/sim/types";

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

/** Start (or resume) an attempt at a scenario. */
export async function startAttempt(formData: FormData): Promise<void> {
  const user = await requireSession();
  const scenarioId = String(formData.get("scenarioId") ?? "");
  if (!scenarioId) fail("/student", "Choose a scenario first.");

  const scenario = await prisma.scenario.findUnique({ where: { id: scenarioId }, include: SCENARIO_INCLUDE });
  if (!scenario) fail("/student", "That scenario no longer exists.");

  // An attempt already running? Resume it rather than burning a second clock.
  const running = await prisma.attempt.findFirst({
    where: { userId: user.id, scenarioId, status: "IN_PROGRESS" },
    orderBy: { startedAt: "desc" },
  });
  if (running && !isExpired(running)) {
    redirect(`/student/attempt/${running.id}`);
  }

  const context = await loadAvailabilityContext();
  const availability = evaluateScenario(
    { id: scenario.id, platform: scenario.platform, published: scenario.published, software: scenario.software },
    context,
  );
  if (!availability.available && user.role === "STUDENT") {
    fail("/student", availability.blockers[0]?.message ?? "That scenario is not available right now.");
  }

  // Assignment rules: attempt caps and per-student time overrides.
  //
  // Only the student's own classes count. Matching on `cohortId !== null` would
  // let a scenario handed to somebody else's cohort leak *its* due date, time
  // limit and attempt cap onto this student, so membership is resolved first.
  // A direct assignment to the student always wins over a class-wide one.
  const memberships = await prisma.cohortMember.findMany({
    where: { userId: user.id },
    select: { cohortId: true },
  });
  const myCohorts = new Set(memberships.map((membership) => membership.cohortId));
  const assignment =
    scenario.assignments.find((item) => item.studentId === user.id) ??
    scenario.assignments.find((item) => item.cohortId !== null && myCohorts.has(item.cohortId)) ??
    null;

  if (assignment?.maxAttempts && assignment.maxAttempts > 0) {
    const used = await prisma.attempt.count({
      where: { userId: user.id, scenarioId, status: { in: ["SUBMITTED", "GRADED", "EXPIRED"] } },
    });
    if (used >= assignment.maxAttempts) {
      fail("/student", `You have used all ${assignment.maxAttempts} attempts for this scenario.`);
    }
  }

  const attempt = await createAttempt(scenario, {
    userId: user.id,
    scenarioId,
    assignmentId: assignment?.id ?? null,
    timeLimitSec: effectiveTimeLimit(scenario, assignment?.timeLimitSec),
  });

  // A launch context belongs to exactly one attempt, so it is consumed here
  // whether or not it is used: a cookie left behind would attach somebody else's
  // gradebook line to whatever this browser ran next. The email check is the same
  // kind of guard in the other direction — a browser can still hold the launch of
  // the person who used it last.
  const launched = await readLtiLaunch();
  if (launched) {
    await clearLtiLaunch();
    if (launched.email === user.email.trim().toLowerCase()) {
      await prisma.attempt.update({
        where: { id: attempt.id },
        data: { ltiLaunch: launched as unknown as Prisma.InputJsonValue },
      });
    }
  }

  await recordAudit({
    actorId: user.id,
    action: "attempt.start",
    targetType: "attempt",
    targetId: attempt.id,
    detail: { scenarioId, title: scenario.title, ...(launched ? { launched: { platform: launched.issuer, lineItem: Boolean(launched.lineItem) } } : {}) },
  });

  redirect(`/student/attempt/${attempt.id}`);
}

/** Persist work in progress. Called by the console on a debounce. */
export async function autosaveAttempt(input: {
  attemptId: string;
  state: EngineState;
}): Promise<{ ok: boolean; error?: string; remaining?: number }> {
  const user = await requireSession();
  const attempt = await prisma.attempt.findUnique({
    where: { id: input.attemptId },
    include: { scenario: { select: { definition: true, timeLimitSec: true } } },
  });

  if (!attempt || (attempt.userId !== user.id && user.role === "STUDENT")) {
    return { ok: false, error: "That attempt is not yours." };
  }
  if (attempt.status !== "IN_PROGRESS") {
    return { ok: false, error: "This attempt has already been submitted." };
  }

  const definition = toDefinition(attempt.scenario);
  const mine = attempt.userId === user.id;
  const state = coerceSubmittedState(input.state, definition);
  const elapsed = Math.round((Date.now() - attempt.startedAt.getTime()) / 1000);

  await prisma.attempt.update({
    where: { id: attempt.id },
    data: {
      snapshot: state as unknown as Prisma.InputJsonValue,
      events: {
        history: state.machine.history.slice(-500).map((entry) => ({ input: entry.input, at: entry.at })),
        notes: state.machine.notes,
      } as unknown as Prisma.InputJsonValue,
      hintsUsed: state.meta.hintsUsed,
      timeSpentSec: elapsed,
    },
  });

  return {
    ok: true,
    remaining: mine ? Math.max(0, Math.floor((attempt.expiresAt.getTime() - Date.now()) / 1000)) : 0,
  };
}

/**
 * Run one console line in a sandboxed attempt's own sandbox (v1.2).
 *
 * The authorisation is the same check every other action makes — the attempt must be the
 * caller's and still running — and the work itself belongs to `sim/sandbox.ts`, which owns
 * the container. A refusal is not an error the student sees as a failure: the console falls
 * back to the simulated engine for the rest of the attempt and says so, which is why this
 * returns a reason rather than throwing.
 */
export async function sandboxCommand(input: {
  attemptId: string;
  input: string;
  state: EngineState;
}): Promise<SandboxCommandResponse> {
  const user = await requireSession();
  const attempt = await prisma.attempt.findUnique({
    where: { id: input.attemptId },
    include: { scenario: { select: { definition: true } } },
  });

  if (!attempt || (attempt.userId !== user.id && user.role === "STUDENT")) {
    return { ok: false, error: "That attempt is not yours." };
  }
  if (attempt.status !== "IN_PROGRESS") {
    return { ok: false, error: "This attempt has already been submitted." };
  }

  const definition = toDefinition(attempt.scenario);
  const state = coerceSubmittedState(input.state, definition);
  const outcome = runSandboxCommand(attempt.id, definition, input.input, state);

  return outcome.ok
    ? { ok: true, result: outcome.result, state: outcome.state }
    : { ok: false, error: outcome.error };
}

/**
 * Grade and close an attempt.
 *
 * Grading always runs server-side against the submitted snapshot, so a student
 * cannot hand-edit their score, and an instructor can re-grade later by calling
 * the same function.
 */
export async function submitAttempt(formData: FormData): Promise<void> {
  const user = await requireSession();
  const attemptId = String(formData.get("attemptId") ?? "");
  const reason = String(formData.get("reason") ?? "student");

  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: {
      scenario: true,
      user: { select: { id: true, email: true, name: true } },
      // The cohort is only ever read to name the class in the webhook payload and
      // the API feed; nothing about grading depends on it being set.
      assignment: { select: { cohort: { select: { id: true, name: true } } } },
    },
  });
  if (!attempt) fail("/student", "That attempt no longer exists.");
  if (attempt.userId !== user.id && user.role === "STUDENT") fail("/student", "That attempt is not yours.");

  if (attempt.status === "IN_PROGRESS" || attempt.status === "SUBMITTED") {
    const definition = toDefinition(attempt.scenario);
    const state = coerceSubmittedState(attempt.snapshot, definition);
    const report = gradeAttempt(definition, state, attempt.scenario.passScore);
    // The server owns the clock: whatever the client's timer believed, an
    // attempt closed after `expiresAt` is expired. `reason` only records how
    // it ended (audit + the report's wording), never whether it ran out of time.
    const expired = attempt.expiresAt.getTime() <= Date.now();
    const gradedAt = new Date();
    // A pass earns a certificate, stored here so the code the learner is handed
    // keeps verifying even if an instructor re-grades this attempt later.
    const certificate = certificatePatchFor(
      {
        learnerId: attempt.userId,
        learnerName: attempt.user.name,
        scenarioId: attempt.scenarioId,
        scenarioTitle: attempt.scenario.title,
        platform: attempt.scenario.platform,
        score: report.score,
        maxScore: report.maxScore,
        passScore: attempt.scenario.passScore,
        completedAt: gradedAt,
        skills: attempt.scenario.tags,
      },
      readStoredCertificate(attempt),
      gradedAt,
    );

    await prisma.$transaction([
      prisma.checkResult.deleteMany({ where: { attemptId } }),
      prisma.checkResult.createMany({
        data: report.results.map((result) => ({
          attemptId,
          checkId: result.checkId,
          label: result.label,
          passed: result.passed,
          points: result.points,
          maxPoints: result.maxPoints,
          detail: result.detail,
        })),
      }),
      prisma.attempt.update({
        where: { id: attemptId },
        data: {
          status: expired ? "EXPIRED" : "GRADED",
          submittedAt: gradedAt,
          gradedAt,
          score: report.score,
          maxScore: report.maxScore,
          timeSpentSec: Math.round((gradedAt.getTime() - attempt.startedAt.getTime()) / 1000),
          ...certificate,
        },
      }),
    ]);

    await recordAudit({
      actorId: user.id,
      action: "attempt.submit",
      targetType: "attempt",
      targetId: attemptId,
      detail: { score: report.score, maxScore: report.maxScore, reason, timedOut: expired },
    });

    await announceGraded({
      attempt: {
        id: attemptId,
        status: expired ? "EXPIRED" : "GRADED",
        score: report.score,
        maxScore: report.maxScore,
        startedAt: attempt.startedAt,
        submittedAt: gradedAt,
        gradedAt,
        timeSpentSec: Math.round((gradedAt.getTime() - attempt.startedAt.getTime()) / 1000),
      },
      learner: attempt.user,
      scenario: {
        id: attempt.scenarioId,
        title: attempt.scenario.title,
        platform: attempt.scenario.platform,
        passScore: attempt.scenario.passScore,
      },
      cohort: attempt.assignment?.cohort ?? null,
      checks: checksFor(report.results),
      // Read back after the transaction, so an issued record is published with the
      // code the learner was handed rather than with the patch that created it.
      certificate: await storedCertificateOf(attemptId),
    });
  }

  // The sandbox has done its job; leaving the container running would be a leak per attempt.
  disposeSession(attemptId);

  revalidatePath("/student/results");
  redirect(`/student/results/${attemptId}`);
}

/** Give up on an attempt without grading it. */
export async function abandonAttempt(formData: FormData): Promise<void> {
  const user = await requireSession();
  const attemptId = String(formData.get("attemptId") ?? "");
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.userId !== user.id) fail("/student", "That attempt is not yours.");
  if (attempt.status !== "IN_PROGRESS") redirect(`/student/results/${attemptId}`);

  await prisma.attempt.update({ where: { id: attemptId }, data: { status: "ABANDONED", submittedAt: new Date() } });
  disposeSession(attemptId);
  revalidatePath("/student");
  redirect("/student?flash=Attempt+discarded");
}

/** Reset an in-progress attempt back to the scenario's opening state. */
export async function restartAttempt(formData: FormData): Promise<void> {
  const user = await requireSession();
  const attemptId = String(formData.get("attemptId") ?? "");
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: { scenario: { select: { definition: true } } },
  });
  if (!attempt || attempt.userId !== user.id) fail("/student", "That attempt is not yours.");
  if (attempt.status !== "IN_PROGRESS") fail(`/student/results/${attemptId}`, "That attempt is already finished.");

  const fresh = createInitialState(toDefinition(attempt.scenario));
  // Restarting means the sandbox must be rebuilt too, or the student would open a machine
  // whose filesystem still had their first attempt's work in it.
  disposeSession(attemptId);
  await prisma.attempt.update({
    where: { id: attemptId },
    data: { snapshot: fresh as unknown as Prisma.InputJsonValue, hintsUsed: [] },
  });
  revalidatePath(`/student/attempt/${attemptId}`);
}
