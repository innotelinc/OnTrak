#!/usr/bin/env node
/**
 * The scenario authoring workflow against a real database (2.1).
 *
 * `tests/scenario-workflow.test.ts` proves the workflow's decisions over a fake
 * store. This proves the other half: that the same five functions write what they
 * claim to a real PostgreSQL database — the revision snapshots, the review state,
 * the publish flag, and a rollback that restores an earlier shape without erasing
 * the history it replaced.
 *
 * It is the exit sentence, executed: two authors, review, publish, full history,
 * one-click rollback.
 *
 *   DATABASE_URL=postgresql://…/ontrak_its \
 *     npx tsx --tsconfig tests/tsconfig.json scripts/verify-scenario-review.ts
 *
 * It writes: two temporary instructors (`verify-scenario-review+…@local.test`), one
 * scenario, its revisions and their audit rows. All of it is deleted before the
 * script exits, including on failure — a verification run that leaves a mess in a
 * shared database is not one anybody will run twice.
 *
 * Deliberately not part of `npm test`: the suite has no database, by design.
 * Exit codes: 0 the workflow behaved, 1 it did not (the failing step is named),
 * 2 no database was configured.
 */

import assert from "node:assert/strict";

import { PrismaClient } from "@prisma/client";

import {
  applyScenarioPublish,
  applyScenarioReviewDecision,
  applyScenarioRollback,
  applyScenarioSave,
  applyScenarioSubmit,
  type ScenarioWorkflowDb,
  type WorkflowAudit,
  type WorkflowAuditEntry,
} from "../src/lib/scenario-workflow";
import type { ScenarioMeta } from "../src/lib/scenario-rules";
import { LINUX_TEMPLATE } from "../src/lib/templates";
import type { ScenarioDefinition } from "../src/lib/sim/types";

const prisma = new PrismaClient();
const db = prisma as unknown as ScenarioWorkflowDb;

const audit: WorkflowAudit = async (entry: WorkflowAuditEntry) => {
  // `detail` is JSON to Prisma; the same cast `recordAudit` makes for the same reason.
  await prisma.auditLog.create({ data: { ...entry, detail: entry.detail as object } });
};

function meta(title: string): ScenarioMeta {
  return {
    title,
    slugBase: "",
    summary: "Bring the wiki back",
    description: "The wiki is down.",
    difficulty: "INTERMEDIATE",
    timeLimitSec: 1800,
    passScore: 70,
    published: false,
    tags: ["linux"],
    softwareIds: [],
  };
}

function definition(): ScenarioDefinition {
  return structuredClone(LINUX_TEMPLATE);
}

function withPoints(points: number): ScenarioDefinition {
  const next = definition();
  next.checks[0] = { ...next.checks[0], points } as ScenarioDefinition["checks"][number];
  return next;
}

function step(label: string): void {
  console.log(`· ${label}`);
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Point it at a database with the migrations applied.");
    return 2;
  }

  const stamp = Date.now().toString(36);
  const emails = [
    `verify-scenario-review+author-${stamp}@local.test`,
    `verify-scenario-review+reviewer-${stamp}@local.test`,
  ];
  let scenarioId: string | null = null;

  try {
    const author = await prisma.user.create({
      data: { email: emails[0]!, name: "Verify Author", role: "INSTRUCTOR" },
    });
    const reviewer = await prisma.user.create({
      data: { email: emails[1]!, name: "Verify Reviewer", role: "INSTRUCTOR" },
    });
    const authorActor = { id: author.id, email: author.email };
    const reviewerActor = { id: reviewer.id, email: reviewer.email };

    step("author A creates a draft");
    const created = await applyScenarioSave(db, audit, authorActor, {
      id: null,
      definition: definition(),
      meta: meta("Verify the wiki"),
    });
    assert.equal(created.ok, true, created.ok ? "" : created.error);
    if (!created.ok) return 1;
    scenarioId = created.scenarioId;

    const fresh = await prisma.scenario.findUniqueOrThrow({ where: { id: scenarioId } });
    assert.equal(fresh.reviewStatus, "DRAFT");
    assert.equal(fresh.published, false);
    assert.equal(await prisma.scenarioRevision.count({ where: { scenarioId } }), 0);

    step("A submits it; B cannot approve before that");
    const premature = await applyScenarioReviewDecision(db, audit, reviewerActor, {
      id: scenarioId,
      decision: "approve",
    });
    assert.equal(premature.ok, false);
    if (premature.ok) return 1;
    assert.match(premature.error, /has not been submitted for review/);

    assert.equal((await applyScenarioSubmit(db, audit, authorActor, scenarioId)).ok, true);
    assert.equal(
      (await prisma.scenario.findUniqueOrThrow({ where: { id: scenarioId } })).reviewStatus,
      "IN_REVIEW",
    );

    step("the author cannot approve their own scenario");
    const selfReview = await applyScenarioReviewDecision(db, audit, authorActor, {
      id: scenarioId,
      decision: "approve",
    });
    assert.equal(selfReview.ok, false);
    if (selfReview.ok) return 1;
    assert.match(selfReview.error, /cannot be approved by the person who wrote it/);

    step("B approves, and it publishes");
    const approved = await applyScenarioReviewDecision(db, audit, reviewerActor, {
      id: scenarioId,
      decision: "approve",
      note: "Checks match the ticket.",
    });
    assert.equal(approved.ok, true, approved.ok ? "" : approved.error);
    const approvedRow = await prisma.scenario.findUniqueOrThrow({ where: { id: scenarioId } });
    assert.equal(approvedRow.reviewStatus, "APPROVED");
    assert.equal(approvedRow.reviewedById, reviewer.id);

    const published = await applyScenarioPublish(
      db,
      audit,
      authorActor,
      { id: scenarioId, published: true },
      { reviewRequired: true },
    );
    assert.equal(published.ok, true, published.ok ? "" : published.error);
    assert.equal(
      (await prisma.scenario.findUniqueOrThrow({ where: { id: scenarioId } })).published,
      true,
    );

    step("a grading-shape edit drops the approval and writes revision 1");
    const edited = await applyScenarioSave(db, audit, authorActor, {
      id: scenarioId,
      definition: withPoints(5),
      meta: meta("Verify the wiki"),
    });
    assert.equal(edited.ok, true, edited.ok ? "" : edited.error);
    if (!edited.ok) return 1;
    assert.equal(edited.revision, 1);

    const afterEdit = await prisma.scenario.findUniqueOrThrow({ where: { id: scenarioId } });
    assert.equal(afterEdit.reviewStatus, "DRAFT");
    assert.equal((afterEdit.definition as unknown as ScenarioDefinition).checks[0]?.points, 5);

    const revisions = await prisma.scenarioRevision.findMany({
      where: { scenarioId },
      orderBy: { revision: "asc" },
    });
    assert.equal(revisions.length, 1);
    assert.equal(
      (revisions[0]!.snapshot as unknown as { definition: ScenarioDefinition }).definition.checks[0]?.points,
      2,
      "the revision holds the shape before the edit",
    );
    assert.equal(revisions[0]!.authorEmail, author.email);

    step("publishing is refused until the new checks are reviewed");
    const refused = await applyScenarioPublish(
      db,
      audit,
      authorActor,
      { id: scenarioId, published: true },
      { reviewRequired: true },
    );
    assert.equal(refused.ok, false);
    if (refused.ok) return 1;
    assert.match(refused.error, /Submit it for review/);

    step("submit → approve → publish again");
    assert.equal((await applyScenarioSubmit(db, audit, authorActor, scenarioId)).ok, true);
    assert.equal(
      (await applyScenarioReviewDecision(db, audit, reviewerActor, { id: scenarioId, decision: "approve" }))
        .ok,
      true,
    );
    assert.equal(
      (
        await applyScenarioPublish(
          db,
          audit,
          authorActor,
          { id: scenarioId, published: true },
          { reviewRequired: true },
        )
      ).ok,
      true,
    );

    step("a second edit writes revision 2");
    const second = await applyScenarioSave(db, audit, authorActor, {
      id: scenarioId,
      definition: withPoints(9),
      meta: meta("Verify the wiki"),
    });
    assert.equal(second.ok, true, second.ok ? "" : second.error);
    if (!second.ok) return 1;
    assert.equal(second.revision, 2);

    step("one click restores revision 1, and the rollback becomes revision 3");
    const rolled = await applyScenarioRollback(db, audit, authorActor, {
      scenarioId,
      revisionId: revisions[0]!.id,
    });
    assert.equal(rolled.ok, true, rolled.ok ? "" : rolled.error);
    if (!rolled.ok) return 1;
    assert.match(rolled.message, /Restored revision 1/);

    const restored = await prisma.scenario.findUniqueOrThrow({ where: { id: scenarioId } });
    assert.equal((restored.definition as unknown as ScenarioDefinition).checks[0]?.points, 2);
    // The shape comes back; the approval does not. The rollback followed an edit, and
    // that edit's approval was for the *newer* shape, so the scenario stays a draft and
    // stays unpublished until somebody reviews what is now in front of them.
    assert.equal(restored.published, false, "a rollback does not republish a shape nobody re-approved");
    assert.equal(restored.reviewStatus, "DRAFT", "a rollback is a new save, so it needs its own review");

    const history = await prisma.scenarioRevision.findMany({
      where: { scenarioId },
      orderBy: { revision: "asc" },
    });
    assert.deepEqual(
      history.map((revision) => revision.revision),
      [1, 2, 3],
    );
    assert.match(history[2]!.summary, /rolled back to revision 1/);
    assert.equal(
      (history[2]!.snapshot as unknown as { definition: ScenarioDefinition }).definition.checks[0]?.points,
      9,
      "the shape the rollback replaced is history too",
    );

    step("the audit trail names every move");
    const actions = (
      await prisma.auditLog.findMany({ where: { targetId: scenarioId }, orderBy: { createdAt: "asc" } })
    ).map((entry) => entry.action);
    for (const action of [
      "scenario.create",
      "scenario.review.submit",
      "scenario.review.approve",
      "scenario.publish",
      "scenario.update",
      "scenario.rollback",
    ]) {
      assert.ok(actions.includes(action), `audit trail has ${action}`);
    }

    console.log(
      "\n2.1 exit verified: two authors, review, publish, revisions 1–3, and a rollback that kept the history.",
    );
    return 0;
  } catch (error) {
    console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (scenarioId) {
      await prisma.scenario.delete({ where: { id: scenarioId } }).catch(() => null);
      await prisma.scenarioRevision.deleteMany({ where: { scenarioId } }).catch(() => null);
      await prisma.auditLog.deleteMany({ where: { targetId: scenarioId } }).catch(() => null);
    }
    await prisma.user.deleteMany({ where: { email: { in: emails } } }).catch(() => null);
    await prisma.$disconnect();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
