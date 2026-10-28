/**
 * Scenario authoring, end to end over a fake database (2.1).
 *
 * The exit this file exists for is a sentence: *two authors co-edit a scenario
 * through review to publish, with full history and one-click rollback*. The rules
 * under it are already tested one at a time (`versions.test.ts`,
 * `scenario-review.test.ts`); what was never tested is that anything *asks* them —
 * the workflow lived inside server actions that check a session and throw a
 * redirect.
 *
 * So this drives the five workflow functions the actions now call, with an
 * in-memory store in place of Prisma: author A writes, reviewer B approves,
 * A edits and loses the approval, B approves again, the scenario publishes, A
 * edits once more, and A rolls back — checking at each step the row, the revision
 * history and the audit trail.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyScenarioPublish,
  applyScenarioReviewDecision,
  applyScenarioRollback,
  applyScenarioSave,
  applyScenarioSubmit,
  type ScenarioWorkflowDb,
  type WorkflowActor,
  type WorkflowAudit,
  type WorkflowAuditEntry,
  type WorkflowRevision,
  type WorkflowScenarioRow,
} from "../src/lib/scenario-workflow";
import type { ScenarioMeta } from "../src/lib/scenario-rules";
import type { ReviewStatus } from "../src/lib/review-rules";
import { LINUX_TEMPLATE } from "../src/lib/templates";
import type { ScenarioDefinition } from "../src/lib/sim/types";

/* -------------------------------------------------------------------------- */
/*  The fake                                                                  */
/* -------------------------------------------------------------------------- */

interface ScenarioRecord {
  id: string;
  slug: string;
  title: string;
  summary: string;
  description: string;
  platform: string;
  engine: string;
  difficulty: string;
  timeLimitSec: number;
  passScore: number;
  tags: string[];
  definition: ScenarioDefinition;
  reviewStatus: ReviewStatus;
  authorId: string;
  published: boolean;
}

class FakeDb implements ScenarioWorkflowDb {
  scenarios = new Map<string, ScenarioRecord>();
  revisions: WorkflowRevision[] = [];
  /** One-shot: the next revision write fails as if another save took the number. */
  collideOnce = false;
  private nextScenario = 1;
  private nextRevision = 1;

  private row(id: string): WorkflowScenarioRow | null {
    const record = this.scenarios.get(id);
    if (!record) return null;
    return {
      ...record,
      _count: { revisions: this.revisions.filter((revision) => revision.scenarioId === id).length },
    };
  }

  scenario = {
    findFirst: async ({ where }: { where: { slug: string; NOT?: { id: string } } }) => {
      for (const record of this.scenarios.values()) {
        if (record.slug === where.slug && record.id !== where.NOT?.id) return { id: record.id };
      }
      return null;
    },
    findUnique: async ({ where }: { where: { id: string } }) => this.row(where.id),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const id = `scenario-${this.nextScenario++}`;
      this.scenarios.set(id, {
        id,
        slug: String(data.slug),
        title: String(data.title),
        summary: String(data.summary),
        description: String(data.description),
        platform: String(data.platform),
        engine: String(data.engine),
        difficulty: String(data.difficulty),
        timeLimitSec: Number(data.timeLimitSec),
        passScore: Number(data.passScore),
        tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
        definition: data.definition as ScenarioDefinition,
        reviewStatus: (data.reviewStatus as ReviewStatus) ?? "DRAFT",
        authorId: String(data.authorId),
        published: Boolean(data.published),
      });
      return { id };
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const record = this.scenarios.get(where.id);
      if (!record) return null;
      if (data.definition !== undefined) record.definition = data.definition as ScenarioDefinition;
      if (data.reviewStatus !== undefined) record.reviewStatus = data.reviewStatus as ReviewStatus;
      if (data.published !== undefined) record.published = Boolean(data.published);
      if (data.tags !== undefined) record.tags = data.tags as string[];
      for (const key of [
        "title",
        "slug",
        "summary",
        "description",
        "platform",
        "engine",
        "difficulty",
        "timeLimitSec",
        "passScore",
      ] as const) {
        if (data[key] !== undefined) {
          // Every one of these fields is a string or a number on the record.
          (record as unknown as Record<string, unknown>)[key] = data[key];
        }
      }
      return { id: where.id };
    },
  };

  scenarioRevision = {
    findFirst: async ({ where }: { where: { id: string; scenarioId: string } }) =>
      this.revisions.find((revision) => revision.id === where.id && revision.scenarioId === where.scenarioId) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (this.collideOnce) {
        this.collideOnce = false;
        throw new Error("Unique constraint failed on the fields: (`scenarioId`,`revision`)");
      }
      const scenarioId = String(data.scenarioId);
      const revision = Number(data.revision);
      if (this.revisions.some((row) => row.scenarioId === scenarioId && row.revision === revision)) {
        throw new Error("Unique constraint failed on the fields: (`scenarioId`,`revision`)");
      }
      this.revisions.push({
        id: `revision-${this.nextRevision++}`,
        scenarioId,
        revision,
        snapshot: data.snapshot,
        summary: String(data.summary ?? ""),
      });
      return { id: `revision-${this.nextRevision}` };
    },
  };

  scenarioSoftware = {
    deleteMany: async () => ({}),
    upsert: async () => ({}),
  };
}

class FakeAudit {
  entries: WorkflowAuditEntry[] = [];

  record: WorkflowAudit = async (entry) => {
    this.entries.push(entry);
  };
}

/* -------------------------------------------------------------------------- */
/*  Inputs                                                                    */
/* -------------------------------------------------------------------------- */

/** A definition the validator accepts, in the shape the editor posts. */
function definition(): ScenarioDefinition {
  return structuredClone(LINUX_TEMPLATE);
}

function meta(title = "Raise the wiki"): ScenarioMeta {
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

const author: WorkflowActor = { id: "author-a", email: "author-a@example.test" };
const reviewer: WorkflowActor = { id: "reviewer-b", email: "reviewer-b@example.test" };

function row(db: FakeDb, id: string): ScenarioRecord {
  const record = db.scenarios.get(id);
  assert.ok(record, `scenario ${id} exists`);
  return record;
}

/* -------------------------------------------------------------------------- */
/*  The exit                                                                  */
/* -------------------------------------------------------------------------- */

test("two authors take a scenario through review, publish it, and roll it back", async () => {
  const db = new FakeDb();
  const audit = new FakeAudit();

  // 1. Author A writes version one. It is a draft with no history yet.
  const created = await applyScenarioSave(db, audit.record, author, {
    id: null,
    definition: definition(),
    meta: meta(),
  });
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) return;
  const id = created.scenarioId;
  assert.equal(row(db, id).reviewStatus, "DRAFT");
  assert.equal(row(db, id).published, false);
  assert.equal(db.revisions.length, 0);
  assert.equal(audit.entries.at(-1)?.action, "scenario.create");

  // 2. Approval before submission is refused: there is nothing in review.
  const premature = await applyScenarioReviewDecision(db, audit.record, reviewer, {
    id,
    decision: "approve",
  });
  assert.equal(premature.ok, false);
  if (premature.ok) return;
  assert.match(premature.error, /has not been submitted for review/);

  // 3. A submits it for a second reader.
  const submitted = await applyScenarioSubmit(db, audit.record, author, id);
  assert.equal(submitted.ok, true, submitted.ok ? "" : submitted.error);
  assert.equal(row(db, id).reviewStatus, "IN_REVIEW");

  // 4. The author cannot approve their own work.
  const selfReview = await applyScenarioReviewDecision(db, audit.record, author, {
    id,
    decision: "approve",
  });
  assert.equal(selfReview.ok, false);
  if (selfReview.ok) return;
  assert.match(selfReview.error, /cannot be approved by the person who wrote it/);

  // 5. B approves.
  const approved = await applyScenarioReviewDecision(db, audit.record, reviewer, {
    id,
    decision: "approve",
    note: "Reads well; the checks match the ticket.",
  });
  assert.equal(approved.ok, true, approved.ok ? "" : approved.error);
  assert.equal(row(db, id).reviewStatus, "APPROVED");

  // 6. With review required, an approved scenario publishes.
  const published = await applyScenarioPublish(
    db,
    audit.record,
    author,
    { id, published: true },
    { reviewRequired: true },
  );
  assert.equal(published.ok, true, published.ok ? "" : published.error);
  assert.equal(row(db, id).published, true);

  // 7. A changes a check's weight. The approval was for the checks that were
  //    read, so the scenario returns to DRAFT and the old shape is revision 1.
  const heavier = definition();
  heavier.checks[0] = { ...heavier.checks[0], points: 5 } as ScenarioDefinition["checks"][number];
  const edited = await applyScenarioSave(db, audit.record, author, {
    id,
    definition: heavier,
    meta: meta(),
  });
  assert.equal(edited.ok, true, edited.ok ? "" : edited.error);
  if (!edited.ok) return;
  assert.equal(edited.revision, 1);
  assert.equal(row(db, id).reviewStatus, "DRAFT");
  assert.equal(db.revisions.length, 1);
  const first = db.revisions[0]!;
  const firstSnapshot = first.snapshot as { definition: ScenarioDefinition };
  assert.equal(firstSnapshot.definition.checks[0]?.points, 2, "the revision is the shape before the edit");

  // 8. A published row cannot be re-published without passing review again.
  const refused = await applyScenarioPublish(
    db,
    audit.record,
    author,
    { id, published: true },
    { reviewRequired: true },
  );
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.match(refused.error, /Submit it for review/);

  // 9. A second round: submit, approve, publish.
  assert.equal((await applyScenarioSubmit(db, audit.record, author, id)).ok, true);
  assert.equal(
    (await applyScenarioReviewDecision(db, audit.record, reviewer, { id, decision: "approve" })).ok,
    true,
  );
  assert.equal(
    (await applyScenarioPublish(db, audit.record, author, { id, published: true }, { reviewRequired: true })).ok,
    true,
  );

  // 10. Another grading edit produces revision 2, and the rollback is the point.
  const heaviest = definition();
  heaviest.checks[0] = { ...heaviest.checks[0], points: 9 } as ScenarioDefinition["checks"][number];
  const second = await applyScenarioSave(db, audit.record, author, {
    id,
    definition: heaviest,
    meta: meta(),
  });
  assert.equal(second.ok, true, second.ok ? "" : second.error);
  if (!second.ok) return;
  assert.equal(second.revision, 2);
  assert.equal(row(db, id).definition.checks[0]?.points, 9);

  const rolled = await applyScenarioRollback(db, audit.record, author, {
    scenarioId: id,
    revisionId: first.id,
  });
  assert.equal(rolled.ok, true, rolled.ok ? "" : rolled.error);
  if (!rolled.ok) return;
  // "One click" restores the shape, records what it replaced, and says so.
  assert.match(rolled.message, /Restored revision 1/);
  assert.equal(row(db, id).definition.checks[0]?.points, 2);
  assert.equal(db.revisions.length, 3);
  assert.equal(db.revisions[2]?.revision, 3);
  assert.match(db.revisions[2]?.summary ?? "", /rolled back to revision 1/);
  const thirdSnapshot = db.revisions[2]?.snapshot as { definition: ScenarioDefinition };
  assert.equal(thirdSnapshot.definition.checks[0]?.points, 9, "the shape the rollback replaced is history too");

  // The rollback restored the shape, not the approval: a rollback is a new save.
  assert.equal(row(db, id).reviewStatus, "DRAFT");
  assert.equal(audit.entries.at(-1)?.action, "scenario.rollback");
});

/* -------------------------------------------------------------------------- */
/*  The edges                                                                 */
/* -------------------------------------------------------------------------- */

test("a copy-edit is a save, not a revision", async () => {
  const db = new FakeDb();
  const audit = new FakeAudit();
  const created = await applyScenarioSave(db, audit.record, author, {
    id: null,
    definition: definition(),
    meta: meta(),
  });
  if (!created.ok) return assert.fail(created.error);

  const retitled = await applyScenarioSave(db, audit.record, author, {
    id: created.scenarioId,
    definition: definition(),
    meta: meta("Raise the wiki (2026)"),
  });
  assert.equal(retitled.ok, true, retitled.ok ? "" : retitled.error);
  if (!retitled.ok) return;
  assert.equal(retitled.revision, null);
  assert.equal(db.revisions.length, 0, "a title change cannot move a score, so it is not history");
});

test("two saves racing for the same revision number do not lose the snapshot", async () => {
  const db = new FakeDb();
  const audit = new FakeAudit();
  const created = await applyScenarioSave(db, audit.record, author, {
    id: null,
    definition: definition(),
    meta: meta(),
  });
  if (!created.ok) return assert.fail(created.error);

  const heavier = definition();
  heavier.checks[0] = { ...heavier.checks[0], points: 5 } as ScenarioDefinition["checks"][number];
  db.collideOnce = true;

  const saved = await applyScenarioSave(db, audit.record, author, {
    id: created.scenarioId,
    definition: heavier,
    meta: meta(),
  });
  assert.equal(saved.ok, true, saved.ok ? "" : saved.error);
  if (!saved.ok) return;
  // The loser of the race moves to the next number rather than dropping the row.
  assert.equal(saved.revision, 2);
  assert.equal(db.revisions.length, 1);
  assert.equal(db.revisions[0]?.revision, 2);
});

test("a rollback to a revision that is gone is refused without writing", async () => {
  const db = new FakeDb();
  const audit = new FakeAudit();
  const created = await applyScenarioSave(db, audit.record, author, {
    id: null,
    definition: definition(),
    meta: meta(),
  });
  if (!created.ok) return assert.fail(created.error);

  const before = db.revisions.length;
  const outcome = await applyScenarioRollback(db, audit.record, author, {
    scenarioId: created.scenarioId,
    revisionId: "revision-that-never-existed",
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /no longer exists/);
  assert.equal(db.revisions.length, before);
});

test("with review off, a solo deployment can publish a draft", async () => {
  const db = new FakeDb();
  const audit = new FakeAudit();
  const created = await applyScenarioSave(db, audit.record, author, {
    id: null,
    definition: definition(),
    meta: meta(),
  });
  if (!created.ok) return assert.fail(created.error);
  assert.equal(row(db, created.scenarioId).reviewStatus, "DRAFT");

  const published = await applyScenarioPublish(
    db,
    audit.record,
    author,
    { id: created.scenarioId, published: true },
    { reviewRequired: false },
  );
  assert.equal(published.ok, true, published.ok ? "" : published.error);
  assert.equal(row(db, created.scenarioId).published, true);
});

test("a vanished scenario is reported as missing, not as a refusal", async () => {
  const db = new FakeDb();
  const audit = new FakeAudit();
  const outcome = await applyScenarioSubmit(db, audit.record, author, "scenario-gone");
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /no longer exists/);
  assert.equal(outcome.missing, true);
  assert.deepEqual(db.revisions, []);
  assert.deepEqual(audit.entries, []);
});

test("a review decision that is neither approve nor changes is refused", async () => {
  const db = new FakeDb();
  const audit = new FakeAudit();
  const outcome = await applyScenarioReviewDecision(db, audit.record, reviewer, {
    id: "whatever",
    decision: "maybe",
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /not a review decision/);
});
