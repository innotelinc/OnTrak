"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { validateDefinition } from "@/lib/validate";
import { parseAssignmentForm } from "@/lib/assignment-rules";
import { canDeleteScenario, parseScenarioMeta, slugify } from "@/lib/scenario-rules";
import { gradeAttempt } from "@/lib/sim/grade";
import { ATTEMPT_STATUS_LABELS, coerceSubmittedState, toDefinition } from "@/lib/scenarios";
import { attemptScopeFor } from "@/lib/attempt-scope";
import { canRegrade, regradedStatus } from "@/lib/grading-rules";
import type { ScenarioDefinition } from "@/lib/sim/types";

async function requireStaff() {
  const user = await requireSession();
  if (user.role !== "ADMIN" && user.role !== "INSTRUCTOR") {
    redirect("/?error=" + encodeURIComponent("Instructor access is required for that."));
  }
  return user;
}

function backTo(path: string, message: string, ok = true): never {
  redirect(`${path}?${ok ? "flash" : "error"}=${encodeURIComponent(message)}`);
}

/* -------------------------------------------------------------------------- */
/*  Scenarios                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Create or update a scenario.
 *
 * The JSON definition is the single source of truth for platform, engine,
 * briefing and checks — the form fields only carry the catalog metadata.
 * That means an author cannot accidentally leave the two disagreeing.
 *
 * Scenarios are a shared staff catalog, so any instructor may edit any of them;
 * only deletion carries an extra guard (`canDeleteScenario`).
 */
export async function saveScenario(formData: FormData): Promise<void> {
  const author = await requireStaff();
  const id = String(formData.get("id") ?? "").trim() || null;
  const raw = String(formData.get("definition") ?? "").trim();

  if (!raw) backTo("/instructor/scenarios", "Paste a scenario definition first.", false);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    backTo(`/instructor/scenarios/${id ?? "new"}`, `That JSON is not valid: ${(error as Error).message}`, false);
  }

  const result = validateDefinition(parsedJson);
  if (!result.ok || !result.definition) {
    const first = result.issues.find((issue) => issue.level === "error");
    backTo(
      `/instructor/scenarios/${id ?? "new"}`,
      first ? `${first.field ? `${first.field}: ` : ""}${first.message}` : "The definition is not valid.",
      false,
    );
  }

  const definition: ScenarioDefinition = result.definition;
  const meta = parseScenarioMeta(formData, definition);

  // Keep the slug unique without surprising the author.
  let slug = meta.slugBase || slugify(meta.title) || "scenario";
  const clash = await prisma.scenario.findFirst({ where: { slug, NOT: id ? { id } : undefined } });
  if (clash) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;

  const data = {
    title: meta.title,
    slug,
    summary: meta.summary,
    description: meta.description,
    platform: definition.platform,
    engine: definition.engine,
    difficulty: meta.difficulty,
    timeLimitSec: meta.timeLimitSec,
    passScore: meta.passScore,
    published: meta.published,
    tags: meta.tags,
    definition: definition as unknown as object,
  };

  const saved = id
    ? await prisma.scenario.update({ where: { id }, data }).catch(() => null)
    : await prisma.scenario.create({ data: { ...data, authorId: author.id } });
  if (!saved) backTo(`/instructor/scenarios/${id}`, "That scenario no longer exists.", false);

  // Re-sync the software dependencies to match the form exactly.
  await prisma.scenarioSoftware.deleteMany({ where: { scenarioId: saved.id, softwarePackageId: { notIn: meta.softwareIds } } });
  for (const softwarePackageId of meta.softwareIds) {
    await prisma.scenarioSoftware
      .upsert({
        where: { scenarioId_softwarePackageId: { scenarioId: saved.id, softwarePackageId } },
        create: { scenarioId: saved.id, softwarePackageId, required: true },
        update: { required: true },
      })
      .catch(() => undefined);
  }

  await recordAudit({
    actorId: author.id,
    action: id ? "scenario.update" : "scenario.create",
    targetType: "scenario",
    targetId: saved.id,
    detail: { title: meta.title, platform: definition.platform, checks: definition.checks.length, published: meta.published },
  });

  revalidatePath("/instructor/scenarios");
  revalidatePath("/student");
  backTo(
    `/instructor/scenarios/${saved.id}`,
    `Saved "${meta.title}" — ${result.totalPoints} points across ${definition.checks.length} checks${
      result.issues.some((issue) => issue.level === "warning") ? " (with warnings)" : ""
    }.`,
  );
}

export async function setScenarioPublished(formData: FormData): Promise<void> {
  const author = await requireStaff();
  const id = String(formData.get("id") ?? "");
  const published = formData.get("published") === "true";

  const scenario = await prisma.scenario
    .update({ where: { id }, data: { published } })
    .catch(() => null);
  if (!scenario) backTo("/instructor/scenarios", "That scenario no longer exists.", false);

  await recordAudit({
    actorId: author.id,
    action: published ? "scenario.publish" : "scenario.unpublish",
    targetType: "scenario",
    targetId: id,
    detail: { title: scenario.title },
  });

  revalidatePath("/instructor/scenarios");
  revalidatePath("/student");
  backTo("/instructor/scenarios", `"${scenario.title}" is now ${published ? "published" : "a draft"}.`);
}

export async function duplicateScenario(formData: FormData): Promise<void> {
  const author = await requireStaff();
  const id = String(formData.get("id") ?? "");
  const original = await prisma.scenario.findUnique({ where: { id }, include: { software: true } });
  if (!original) backTo("/instructor/scenarios", "That scenario no longer exists.", false);

  const copy = await prisma.scenario.create({
    data: {
      title: `${original.title} (copy)`,
      slug: `${original.slug}-${Math.random().toString(36).slice(2, 6)}`,
      summary: original.summary,
      description: original.description,
      platform: original.platform,
      engine: original.engine,
      difficulty: original.difficulty,
      timeLimitSec: original.timeLimitSec,
      passScore: original.passScore,
      published: false,
      tags: original.tags,
      definition: original.definition as object,
      authorId: author.id,
      software: {
        create: original.software.map((link) => ({ softwarePackageId: link.softwarePackageId, required: link.required })),
      },
    },
  });

  await recordAudit({
    actorId: author.id,
    action: "scenario.duplicate",
    targetType: "scenario",
    targetId: copy.id,
    detail: { from: original.id },
  });

  revalidatePath("/instructor/scenarios");
  backTo(`/instructor/scenarios/${copy.id}`, "Copied. The duplicate starts as a draft.");
}

export async function deleteScenario(formData: FormData): Promise<void> {
  const author = await requireStaff();
  const id = String(formData.get("id") ?? "");
  const scenario = await prisma.scenario.findUnique({ where: { id }, include: { _count: { select: { attempts: true } } } });
  if (!scenario) backTo("/instructor/scenarios", "That scenario no longer exists.", false);

  if (!canDeleteScenario(author.role, scenario._count.attempts)) {
    backTo(
      "/instructor/scenarios",
      `"${scenario.title}" has ${scenario._count.attempts} recorded attempt(s). Ask an administrator to archive it instead.`,
      false,
    );
  }

  await prisma.scenario.delete({ where: { id } });
  await recordAudit({
    actorId: author.id,
    action: "scenario.delete",
    targetType: "scenario",
    targetId: id,
    detail: { title: scenario.title },
  });

  revalidatePath("/instructor/scenarios");
  revalidatePath("/student");
  backTo("/instructor/scenarios", `"${scenario.title}" was deleted.`);
}

/* -------------------------------------------------------------------------- */
/*  Classes                                                                   */
/* -------------------------------------------------------------------------- */

function joinCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

export async function createCohort(formData: FormData): Promise<void> {
  const instructor = await requireStaff();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  if (!name) backTo("/instructor/cohorts", "Give the class a name.", false);

  const cohort = await prisma.cohort.create({
    data: { name, description, joinCode: joinCode(), instructorId: instructor.id },
  });

  await recordAudit({
    actorId: instructor.id,
    action: "cohort.create",
    targetType: "cohort",
    targetId: cohort.id,
    detail: { name },
  });

  revalidatePath("/instructor/cohorts");
  backTo("/instructor/cohorts", `"${name}" created. Share the join code ${cohort.joinCode} with your students.`);
}

export async function updateCohort(formData: FormData): Promise<void> {
  const instructor = await requireStaff();
  const id = String(formData.get("id") ?? "");
  const cohort = await prisma.cohort.findUnique({ where: { id } });
  if (!cohort) backTo("/instructor/cohorts", "That class no longer exists.", false);
  if (cohort.instructorId !== instructor.id && instructor.role !== "ADMIN") {
    backTo("/instructor/cohorts", "That class belongs to another instructor.", false);
  }

  await prisma.cohort.update({
    where: { id },
    data: {
      name: String(formData.get("name") ?? "").trim() || cohort.name,
      description: String(formData.get("description") ?? "").trim() || null,
    },
  });

  revalidatePath("/instructor/cohorts");
  backTo("/instructor/cohorts", "Class updated.");
}

export async function deleteCohort(formData: FormData): Promise<void> {
  const instructor = await requireStaff();
  const id = String(formData.get("id") ?? "");
  const cohort = await prisma.cohort.findUnique({ where: { id } });
  if (!cohort) backTo("/instructor/cohorts", "That class no longer exists.", false);
  if (cohort.instructorId !== instructor.id && instructor.role !== "ADMIN") {
    backTo("/instructor/cohorts", "That class belongs to another instructor.", false);
  }

  await prisma.cohort.delete({ where: { id } });
  await recordAudit({
    actorId: instructor.id,
    action: "cohort.delete",
    targetType: "cohort",
    targetId: id,
    detail: { name: cohort.name },
  });

  revalidatePath("/instructor/cohorts");
  backTo("/instructor/cohorts", `"${cohort.name}" was deleted.`);
}

export async function addCohortMember(formData: FormData): Promise<void> {
  const instructor = await requireStaff();
  const cohortId = String(formData.get("cohortId") ?? "");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const isMentor = formData.get("isMentor") === "on";

  const cohort = await prisma.cohort.findUnique({ where: { id: cohortId } });
  if (!cohort) backTo("/instructor/cohorts", "That class no longer exists.", false);
  if (cohort.instructorId !== instructor.id && instructor.role !== "ADMIN") {
    backTo("/instructor/cohorts", "That class belongs to another instructor.", false);
  }

  const student = await prisma.user.findUnique({ where: { email } });
  if (!student) {
    backTo(
      "/instructor/cohorts",
      `No account uses ${email}. Ask an administrator to create it, or share the join code ${cohort.joinCode}.`,
      false,
    );
  }

  await prisma.cohortMember
    .upsert({
      where: { cohortId_userId: { cohortId, userId: student.id } },
      create: { cohortId, userId: student.id, isMentor },
      update: { isMentor },
    })
    .catch(() => undefined);

  revalidatePath("/instructor/cohorts");
  backTo("/instructor/cohorts", `${student.name} was added to ${cohort.name}.`);
}

export async function removeCohortMember(formData: FormData): Promise<void> {
  const instructor = await requireStaff();
  const cohortId = String(formData.get("cohortId") ?? "");
  const userId = String(formData.get("userId") ?? "");

  const cohort = await prisma.cohort.findUnique({ where: { id: cohortId } });
  if (!cohort) backTo("/instructor/cohorts", "That class no longer exists.", false);
  if (cohort.instructorId !== instructor.id && instructor.role !== "ADMIN") {
    backTo("/instructor/cohorts", "That class belongs to another instructor.", false);
  }

  // `deleteMany` reports how many rows went, so a stale member id is a message
  // rather than the P2025 a `delete` would throw.
  const removed = await prisma.cohortMember.deleteMany({ where: { cohortId, userId } });
  revalidatePath("/instructor/cohorts");
  backTo(
    "/instructor/cohorts",
    removed.count > 0 ? "Student removed from the class." : "That student is not a member of this class.",
    removed.count > 0,
  );
}

/* -------------------------------------------------------------------------- */
/*  Assignments                                                               */
/* -------------------------------------------------------------------------- */

export async function createAssignment(formData: FormData): Promise<void> {
  const instructor = await requireStaff();

  // Field parsing (units, required fields, the deadline) lives in a pure module
  // so it can be unit tested without a database.
  const parsed = parseAssignmentForm(formData);
  if (!parsed.ok) backTo("/instructor/scenarios", parsed.reason, false);
  const { scenarioId, cohortId, studentId, dueAt, timeLimitSec, maxAttempts, instructions } = parsed.draft;

  const scenario = await prisma.scenario.findUnique({ where: { id: scenarioId }, select: { id: true } });
  if (!scenario) backTo("/instructor/scenarios", "That scenario no longer exists.", false);

  // A stale class or student id would otherwise fail as a foreign-key error;
  // checking first turns it into an ordinary flash message. A class may only
  // be assigned to by its own instructor (or an administrator).
  if (cohortId) {
    const cohort = await prisma.cohort.findUnique({ where: { id: cohortId }, select: { id: true, instructorId: true } });
    if (!cohort) backTo("/instructor/scenarios", "That class no longer exists.", false);
    if (cohort.instructorId !== instructor.id && instructor.role !== "ADMIN") {
      backTo("/instructor/scenarios", "That class belongs to another instructor.", false);
    }
  }
  if (studentId) {
    const student = await prisma.user.findUnique({ where: { id: studentId }, select: { id: true } });
    if (!student) backTo("/instructor/scenarios", "That student no longer exists.", false);
  }

  const assignment = await prisma.assignment.create({
    data: {
      scenarioId,
      cohortId,
      studentId,
      dueAt,
      timeLimitSec,
      maxAttempts,
      instructions,
      createdById: instructor.id,
    },
  });

  await recordAudit({
    actorId: instructor.id,
    action: "assignment.create",
    targetType: "assignment",
    targetId: assignment.id,
    detail: { scenarioId, cohortId, studentId, dueAt: dueAt ? dueAt.toISOString() : null },
  });

  revalidatePath("/instructor/scenarios");
  revalidatePath("/student");
  backTo("/instructor/scenarios", "Assignment created.");
}

export async function deleteAssignment(formData: FormData): Promise<void> {
  const instructor = await requireStaff();
  const id = String(formData.get("id") ?? "");

  const assignment = await prisma.assignment.findUnique({
    where: { id },
    select: { createdById: true, cohort: { select: { instructorId: true } } },
  });
  if (!assignment) backTo("/instructor/scenarios", "That assignment no longer exists.", false);

  const owns = assignment.createdById === instructor.id || assignment.cohort?.instructorId === instructor.id;
  if (instructor.role !== "ADMIN" && !owns) {
    backTo("/instructor/scenarios", "That assignment belongs to another instructor.", false);
  }

  await prisma.assignment.delete({ where: { id } }).catch(() => undefined);
  revalidatePath("/instructor/scenarios");
  revalidatePath("/student");
  backTo("/instructor/scenarios", "Assignment removed.");
}

/* -------------------------------------------------------------------------- */
/*  Grading                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Re-grade a submission against the scenario's current checks.
 *
 * Useful after fixing a typo in a check: every stored attempt keeps its final
 * state, so the score can be recalculated without asking students to redo work.
 */
export async function regradeAttempt(formData: FormData): Promise<void> {
  const instructor = await requireStaff();
  const attemptId = String(formData.get("attemptId") ?? "");

  // Scoped, so an instructor cannot re-grade another instructor's cohort: the
  // page hides those attempts, and this closes the same hole server-side.
  const scope = await attemptScopeFor(instructor);
  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId, ...scope },
    include: { scenario: true },
  });
  if (!attempt) backTo("/instructor/attempts", "That attempt no longer exists.", false);

  // Only a finished attempt has a final state to score. Re-grading an
  // in-progress or abandoned attempt would flip it to GRADED and lock the
  // student out of work they never handed in.
  if (!canRegrade(attempt.status)) {
    backTo(
      `/instructor/attempts/${attemptId}`,
      `A ${ATTEMPT_STATUS_LABELS[attempt.status]} attempt cannot be re-graded — only submitted, graded or expired work can.`,
      false,
    );
  }

  const definition = toDefinition(attempt.scenario);
  const state = coerceSubmittedState(attempt.snapshot, definition);
  const report = gradeAttempt(definition, state, attempt.scenario.passScore);

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
        score: report.score,
        maxScore: report.maxScore,
        gradedAt: new Date(),
        status: regradedStatus(attempt.status),
      },
    }),
  ]);

  await recordAudit({
    actorId: instructor.id,
    action: "attempt.regrade",
    targetType: "attempt",
    targetId: attemptId,
    detail: { score: report.score, maxScore: report.maxScore },
  });

  revalidatePath(`/instructor/attempts/${attemptId}`);
  backTo(`/instructor/attempts/${attemptId}`, `Re-graded: ${report.score}/${report.maxScore}.`);
}

/** Detach a software dependency from a scenario. */
export async function detachSoftware(formData: FormData): Promise<void> {
  await requireStaff();
  const scenarioId = String(formData.get("scenarioId") ?? "");
  const softwarePackageId = String(formData.get("softwarePackageId") ?? "");
  await prisma.scenarioSoftware
    .delete({ where: { scenarioId_softwarePackageId: { scenarioId, softwarePackageId } } })
    .catch(() => undefined);
  revalidatePath(`/instructor/scenarios/${scenarioId}`);
  revalidatePath("/student");
  backTo(`/instructor/scenarios/${scenarioId}`, "Software requirement removed.");
}
