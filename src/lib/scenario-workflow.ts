/**
 * Scenario authoring, headless (2.1).
 *
 * A scenario is a graded artifact that two people sign off on: an author writes
 * it, a second reader approves it, and only then may it be published. That
 * workflow used to live only inside the instructor server actions, which check a
 * session and throw `redirect` — fine for a form, useless for anything that wants
 * to prove the workflow end to end.
 *
 * So the writes and the decisions are here, and the actions are wrappers: they
 * read `FormData`, keep `requireStaff`/`redirect`/`revalidatePath`, and call these
 * functions. The database is a structural seam rather than the Prisma client, so
 * a test can drive two authors through a full review with an in-memory store, and
 * `scripts/verify-scenario-review.ts` can drive the same five functions against a
 * real PostgreSQL database.
 *
 * Three rules this file keeps from the rules modules, because the actions used to
 * keep them:
 *
 *  - **An approval covers the checks that were read.** A grading-shape edit drops
 *    an APPROVED scenario back to DRAFT (`statusAfterEdit`); a title or briefing
 *    edit does not.
 *  - **The reviewer is never the author** (`reviewBlocker`), and publishing needs
 *    an approval only when the deployment requires review.
 *  - **History is append-only.** A save writes the shape it replaces to
 *    `ScenarioRevision` when the edit can move a score; a rollback is a new save
 *    carrying the old shape, so the revision that was rolled back from stays in
 *    the list.
 */

import { validateDefinition } from "./validate";
import { slugify, type ScenarioMeta } from "./scenario-rules";
import {
  publishBlocker,
  reviewBlocker,
  reviewRequired,
  statusAfterEdit,
  submitBlocker,
  type ReviewStatus,
} from "./review-rules";
import {
  describeDiff,
  diffSnapshots,
  rollbackSnapshot,
  shouldRevise,
  snapshotOf,
  type ScenarioSnapshot,
  type SnapshotSource,
} from "./versions-rules";

/* -------------------------------------------------------------------------- */
/*  The seam                                                                  */
/* -------------------------------------------------------------------------- */

/** Who is making the change. The address is kept with a revision on purpose. */
export interface WorkflowActor {
  id: string;
  email: string;
}

/**
 * An audit entry, as this module needs it.
 *
 * Structurally a subset of `AuditInput` in `audit.ts`, so the action can pass
 * `recordAudit` unchanged while a test or a script passes its own sink.
 */
export interface WorkflowAuditEntry {
  actorId: string;
  action: string;
  targetType: "scenario";
  targetId: string;
  detail: Record<string, unknown>;
}

export type WorkflowAudit = (entry: WorkflowAuditEntry) => Promise<void>;

/** A scenario row as the workflow reads it. */
export interface WorkflowScenarioRow extends SnapshotSource {
  id: string;
  authorId: string;
  reviewStatus: ReviewStatus;
  /** The revision rows already stored; the next number is this plus one. */
  _count?: { revisions: number };
}

/** A stored revision, as a rollback reads it. */
export interface WorkflowRevision {
  id: string;
  scenarioId: string;
  revision: number;
  snapshot: unknown;
  summary: string;
}

/**
 * The Prisma surface these functions use, and nothing more.
 *
 * Deliberately narrow: adding a write means changing this interface, which is the
 * reminder that a new side effect needs a decision and a test rather than a line
 * at the bottom of a save.
 */
export interface ScenarioWorkflowDb {
  scenario: {
    findFirst(args: {
      where: { slug: string; NOT?: { id: string } };
    }): Promise<{ id: string } | null>;
    findUnique(args: {
      where: { id: string };
      select: Record<string, unknown>;
    }): Promise<WorkflowScenarioRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string } | null>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<{ id: string } | null>;
  };
  scenarioRevision: {
    findFirst(args: {
      where: { id: string; scenarioId: string };
    }): Promise<WorkflowRevision | null>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  scenarioSoftware: {
    deleteMany(args: {
      where: { scenarioId: string; softwarePackageId: { notIn: string[] } };
    }): Promise<unknown>;
    upsert(args: {
      where: { scenarioId_softwarePackageId: { scenarioId: string; softwarePackageId: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

/**
 * What a scenario lookup reads.
 *
 * The full snapshot plus the review state and the revision count: a save needs
 * every field it is about to replace, and the other four operations read the
 * status from the same row. One select keeps every lookup one shape.
 */
const SCENARIO_SELECT = {
  id: true,
  title: true,
  summary: true,
  description: true,
  platform: true,
  engine: true,
  difficulty: true,
  timeLimitSec: true,
  passScore: true,
  tags: true,
  definition: true,
  reviewStatus: true,
  authorId: true,
  _count: { select: { revisions: true } },
} as const;

/** A save, a review decision or a rollback: the same shape, so callers branch once. */
export type ScenarioWorkflowResult =
  | { ok: true; message: string; scenarioId: string; revision: number | null }
  | { ok: false; error: string; missing?: true };

function revisionCount(row: { _count?: { revisions: number } } | null): number {
  return row?._count?.revisions ?? 0;
}

/**
 * Write a revision, retrying past a number another save took first.
 *
 * `[scenarioId, revision]` is unique, so two saves that read the same count cannot
 * both write it. Losing that race used to drop the snapshot silently, which is
 * how history develops a hole exactly when two people were editing. The loser
 * moves to the next number instead; three tries is enough for a catalog where two
 * instructors are the normal case.
 */
async function recordRevision(
  db: ScenarioWorkflowDb,
  actor: WorkflowActor,
  scenarioId: string,
  snapshot: ScenarioSnapshot,
  summary: string,
  firstNumber: number,
): Promise<number | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const revision = firstNumber + attempt;
    try {
      await db.scenarioRevision.create({
        data: {
          scenarioId,
          revision,
          snapshot: snapshot as unknown as object,
          summary,
          authorId: actor.id,
          authorEmail: actor.email,
        },
      });
      return revision;
    } catch {
      // Taken by a concurrent save (or the scenario vanished, which the update
      // below reports with the right cause). Try the next number.
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Save                                                                      */
/* -------------------------------------------------------------------------- */

export interface ScenarioSaveInput {
  /** `null` creates a scenario. */
  id: string | null;
  /** The raw JSON an author pasted, before validation. */
  definition: unknown;
  meta: ScenarioMeta;
}

/**
 * Create or update a scenario, recording what the edit replaced.
 *
 * The definition is validated here rather than by the caller: the workflow is the
 * door, and a script must not be able to write a scenario the editor would have
 * refused.
 */
export async function applyScenarioSave(
  db: ScenarioWorkflowDb,
  audit: WorkflowAudit,
  actor: WorkflowActor,
  input: ScenarioSaveInput,
): Promise<ScenarioWorkflowResult> {
  const validated = validateDefinition(input.definition);
  if (!validated.ok || !validated.definition) {
    const first = validated.issues.find((issue) => issue.level === "error");
    return {
      ok: false,
      error: first
        ? `${first.field ? `${first.field}: ` : ""}${first.message}`
        : "The definition is not valid.",
    };
  }
  const definition = validated.definition;
  const { meta } = input;

  // Keep the slug unique without surprising the author. A slug is the catalog's
  // address, so a clash is renamed rather than refused — the save is the work.
  let slug = meta.slugBase || slugify(meta.title) || "scenario";
  const clash = await db.scenario.findFirst({
    where: { slug, ...(input.id ? { NOT: { id: input.id } } : {}) },
  });
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

  const previous = input.id
    ? await db.scenario.findUnique({ where: { id: input.id }, select: SCENARIO_SELECT })
    : null;

  let revisionNumber: number | null = null;
  let revisionNote = "";
  let gradingShapeChanged = false;
  if (previous) {
    const before = snapshotOf(previous);
    const after = snapshotOf({ ...data } as unknown as SnapshotSource);
    gradingShapeChanged = shouldRevise(before, after);
    if (gradingShapeChanged) {
      const summary = describeDiff(diffSnapshots(before, after));
      revisionNumber = await recordRevision(
        db,
        actor,
        previous.id,
        before,
        summary,
        revisionCount(previous) + 1,
      );
      if (revisionNumber !== null) revisionNote = ` Version ${revisionNumber}: ${summary}.`;
    }
  }

  // An approval covers the checks that were read: a grading-shape edit returns an
  // APPROVED scenario to DRAFT, so the new checks get a reader of their own.
  const saved = input.id
    ? await db.scenario
        .update({
          where: { id: input.id },
          data: {
            ...data,
            ...(previous
              ? { reviewStatus: statusAfterEdit(previous.reviewStatus, gradingShapeChanged) }
              : {}),
          },
        })
        .catch(() => null)
    : await db.scenario.create({
        data: { ...data, authorId: actor.id, reviewStatus: "DRAFT" },
      });
  if (!saved) return { ok: false, error: "That scenario no longer exists.", missing: true };

  // Re-sync the software dependencies to match the form exactly.
  await db.scenarioSoftware.deleteMany({
    where: { scenarioId: saved.id, softwarePackageId: { notIn: meta.softwareIds } },
  });
  for (const softwarePackageId of meta.softwareIds) {
    await db.scenarioSoftware
      .upsert({
        where: { scenarioId_softwarePackageId: { scenarioId: saved.id, softwarePackageId } },
        create: { scenarioId: saved.id, softwarePackageId, required: true },
        update: { required: true },
      })
      .catch(() => undefined);
  }

  // A half band is part of its parent's rubric rather than a question of its own,
  // so the summary counts the checks a student is actually graded on.
  const gradedChecks = definition.checks.filter((check) => check.halfOf === undefined).length;

  await audit({
    actorId: actor.id,
    action: input.id ? "scenario.update" : "scenario.create",
    targetType: "scenario",
    targetId: saved.id,
    detail: {
      title: meta.title,
      platform: definition.platform,
      checks: gradedChecks,
      published: meta.published,
    },
  });

  const warnings = validated.issues.some((issue) => issue.level === "warning");
  return {
    ok: true,
    scenarioId: saved.id,
    revision: revisionNumber,
    message: `Saved "${meta.title}" — ${validated.totalPoints} points across ${gradedChecks} checks${
      warnings ? " (with warnings)" : ""
    }.${revisionNote}`,
  };
}

/* -------------------------------------------------------------------------- */
/*  Review                                                                    */
/* -------------------------------------------------------------------------- */

export async function applyScenarioSubmit(
  db: ScenarioWorkflowDb,
  audit: WorkflowAudit,
  actor: WorkflowActor,
  id: string,
): Promise<ScenarioWorkflowResult> {
  const scenario = await db.scenario.findUnique({ where: { id }, select: SCENARIO_SELECT });
  if (!scenario) return { ok: false, error: "That scenario no longer exists.", missing: true };

  const blocker = submitBlocker(scenario.reviewStatus);
  if (blocker) return { ok: false, error: blocker };

  const updated = await db.scenario.update({
    where: { id },
    data: { reviewStatus: "IN_REVIEW", reviewedById: null, reviewedAt: null, reviewNote: null },
  });
  if (!updated) return { ok: false, error: "That scenario no longer exists.", missing: true };

  await audit({
    actorId: actor.id,
    action: "scenario.review.submit",
    targetType: "scenario",
    targetId: id,
    detail: { title: scenario.title },
  });

  return {
    ok: true,
    scenarioId: id,
    revision: null,
    message: `"${scenario.title}" is waiting for a second reader.`,
  };
}

export interface ScenarioReviewDecision {
  id: string;
  decision: string;
  note?: string;
}

export async function applyScenarioReviewDecision(
  db: ScenarioWorkflowDb,
  audit: WorkflowAudit,
  actor: WorkflowActor,
  input: ScenarioReviewDecision,
): Promise<ScenarioWorkflowResult> {
  if (input.decision !== "approve" && input.decision !== "changes") {
    return { ok: false, error: "That is not a review decision." };
  }

  const scenario = await db.scenario.findUnique({ where: { id: input.id }, select: SCENARIO_SELECT });
  if (!scenario) return { ok: false, error: "That scenario no longer exists.", missing: true };

  const blocker = reviewBlocker(scenario.reviewStatus, scenario.authorId, actor.id);
  if (blocker) return { ok: false, error: blocker };

  const note = (input.note ?? "").trim().slice(0, 2000);

  const updated = await db.scenario.update({
    where: { id: input.id },
    data: {
      reviewStatus: input.decision === "approve" ? "APPROVED" : "DRAFT",
      reviewNote: note || null,
      reviewedById: actor.id,
      reviewedAt: new Date(),
    },
  });
  if (!updated) return { ok: false, error: "That scenario no longer exists.", missing: true };

  await audit({
    actorId: actor.id,
    action: input.decision === "approve" ? "scenario.review.approve" : "scenario.review.changes",
    targetType: "scenario",
    targetId: input.id,
    detail: { title: scenario.title, note },
  });

  return {
    ok: true,
    scenarioId: input.id,
    revision: null,
    message:
      input.decision === "approve"
        ? `Approved "${scenario.title}". It can be published.`
        : `Sent "${scenario.title}" back for changes.`,
  };
}

export interface ScenarioPublishInput {
  id: string;
  published: boolean;
}

export async function applyScenarioPublish(
  db: ScenarioWorkflowDb,
  audit: WorkflowAudit,
  actor: WorkflowActor,
  input: ScenarioPublishInput,
  options: { reviewRequired?: boolean } = {},
): Promise<ScenarioWorkflowResult> {
  const scenario = await db.scenario.findUnique({ where: { id: input.id }, select: SCENARIO_SELECT });
  if (!scenario) return { ok: false, error: "That scenario no longer exists.", missing: true };

  if (input.published) {
    const blocker = publishBlocker(
      scenario.reviewStatus,
      options.reviewRequired ?? reviewRequired(),
    );
    if (blocker) return { ok: false, error: blocker };
  }

  const updated = await db.scenario.update({
    where: { id: input.id },
    data: { published: input.published },
  });
  if (!updated) return { ok: false, error: "That scenario no longer exists.", missing: true };

  await audit({
    actorId: actor.id,
    action: input.published ? "scenario.publish" : "scenario.unpublish",
    targetType: "scenario",
    targetId: input.id,
    detail: { title: scenario.title, reviewStatus: scenario.reviewStatus },
  });

  return {
    ok: true,
    scenarioId: input.id,
    revision: null,
    message: `"${scenario.title}" is now ${input.published ? "published" : "a draft"}.`,
  };
}

/* -------------------------------------------------------------------------- */
/*  Rollback                                                                  */
/* -------------------------------------------------------------------------- */

export interface ScenarioRollbackInput {
  scenarioId: string;
  revisionId: string;
}

/**
 * Restore a scenario to a shape it used to have.
 *
 * Not an undo of the history: a rollback is a *new* save carrying the old shape,
 * so the revision it replaces is recorded and the rollback itself becomes the
 * newest revision. The slug and the software links are left alone — both are
 * catalog facts, not scoring ones.
 */
export async function applyScenarioRollback(
  db: ScenarioWorkflowDb,
  audit: WorkflowAudit,
  actor: WorkflowActor,
  input: ScenarioRollbackInput,
): Promise<ScenarioWorkflowResult> {
  const revision = await db.scenarioRevision.findFirst({
    where: { id: input.revisionId, scenarioId: input.scenarioId },
  });
  if (!revision) return { ok: false, error: "That revision no longer exists." };

  let restored: ScenarioSnapshot;
  try {
    restored = rollbackSnapshot(revision);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const current = await db.scenario.findUnique({
    where: { id: input.scenarioId },
    select: SCENARIO_SELECT,
  });
  if (!current) return { ok: false, error: "That scenario no longer exists.", missing: true };

  // What the rollback replaces is history too: the shape being restored came from
  // somewhere, and the one it overwrites must stay readable.
  const before = snapshotOf(current);
  const revisionNumber = await recordRevision(
    db,
    actor,
    input.scenarioId,
    before,
    `rolled back to revision ${revision.revision}`,
    revisionCount(current) + 1,
  );

  const updated = await db.scenario.update({
    where: { id: input.scenarioId },
    data: {
      title: restored.title,
      summary: restored.summary,
      description: restored.description,
      platform: restored.platform,
      engine: restored.engine,
      difficulty: restored.difficulty,
      timeLimitSec: restored.timeLimitSec,
      passScore: restored.passScore,
      tags: restored.tags,
      definition: restored.definition as unknown as object,
    },
  });
  if (!updated) return { ok: false, error: "That scenario no longer exists.", missing: true };

  await audit({
    actorId: actor.id,
    action: "scenario.rollback",
    targetType: "scenario",
    targetId: input.scenarioId,
    detail: {
      revision: revision.revision,
      revisionId: revision.id,
      replaced: describeDiff(diffSnapshots(before, restored)),
    },
  });

  return {
    ok: true,
    scenarioId: input.scenarioId,
    revision: revisionNumber,
    message: `Restored revision ${revision.revision} (${revision.summary || "no summary"}). That rollback is now the newest revision, so nothing is lost.`,
  };
}
