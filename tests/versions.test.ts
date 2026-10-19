/**
 * Scenario versioning tests.
 *
 * A revision exists to answer one question after the fact — *what did that class
 * run?* — so the cases that matter are not "a row was written". They are the ones
 * where a naive version of this would lie: a copy-edit that buries the edit which
 * moved a score, an unchanged save that fills the list with timestamps, a diff that
 * says "definition changed" where an instructor needs "one check removed, pass mark
 * 70 → 80", and a rollback that takes an address out from under a link in a class
 * packet.
 *
 * The rules are pure, so this file needs no database: it reads shapes the way the
 * save action hands them over.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeDiff,
  diffSnapshots,
  rollbackSnapshot,
  sameGradingShape,
  shouldRevise,
  snapshotOf,
  type ScenarioSnapshot,
} from "../src/lib/versions-rules";
import type { ScenarioDefinition } from "../src/lib/sim/types";

function definition(overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return {
    version: 1,
    platform: "LINUX",
    engine: "bash",
    objective: "Fix the service",
    brief: "The web service will not start.",
    tasks: ["Start it"],
    machine: { hostname: "web1", user: "root", os: "Ubuntu", version: "24.04" },
    checks: [
      { id: "svc", kind: "file_exists", path: "/etc/x", label: "Config is present", points: 2 } as ScenarioDefinition["checks"][number],
      { id: "run", kind: "file_exists", path: "/run/x", label: "Service is running" } as ScenarioDefinition["checks"][number],
    ],
    ...overrides,
  } as ScenarioDefinition;
}

function snapshot(overrides: Partial<ScenarioSnapshot> = {}): ScenarioSnapshot {
  return {
    title: "Raise the wiki",
    summary: "brief",
    description: "details",
    platform: "LINUX",
    engine: "bash",
    difficulty: "INTERMEDIATE",
    timeLimitSec: 1800,
    passScore: 70,
    tags: ["linux"],
    definition: definition(),
    ...overrides,
  };
}

test("a copy-edit is not a revision, because it cannot move a score", () => {
  const before = snapshot();
  const after = snapshot({ title: "Raise the wiki (2026)", summary: "clearer brief", description: "more detail" });
  assert.equal(shouldRevise(before, after), false);
});

test("an unchanged save is not a revision either", () => {
  assert.equal(shouldRevise(snapshot(), snapshot()), false);
});

test("a check that is added, removed or reweighted is a revision", () => {
  const before = snapshot();
  const added = snapshot({
    definition: definition({
      checks: [...definition().checks, { id: "extra", kind: "file_exists", path: "/x", label: "Extra" } as ScenarioDefinition["checks"][number]],
    }),
  });
  const removed = snapshot({ definition: definition({ checks: [definition().checks[0]] }) });
  const reweighted = snapshot({
    definition: definition({ checks: [{ ...definition().checks[0], points: 5 } as ScenarioDefinition["checks"][number], definition().checks[1]] }),
  });
  assert.equal(shouldRevise(before, added), true);
  assert.equal(shouldRevise(before, removed), true);
  assert.equal(shouldRevise(before, reweighted), true);
});

test("the pass mark and the time limit are revisions on their own", () => {
  assert.equal(shouldRevise(snapshot(), snapshot({ passScore: 80 })), true);
  assert.equal(shouldRevise(snapshot(), snapshot({ timeLimitSec: 900 })), true);
});

test("a check's default weight is one, so making it explicit is not a reweight", () => {
  const before = snapshot();
  const explicit = snapshot({
    definition: definition({ checks: [definition().checks[0], { ...definition().checks[1], points: 1 } as ScenarioDefinition["checks"][number]] }),
  });
  assert.equal(shouldRevise(before, explicit), false);
  assert.equal(sameGradingShape(before, explicit), true);
});

test("a diff counts checks and states the marks, rather than saying 'changed'", () => {
  const before = snapshot();
  const after = snapshot({
    passScore: 80,
    timeLimitSec: 1200,
    definition: definition({
      checks: [
        { ...definition().checks[0], points: 4 } as ScenarioDefinition["checks"][number],
        { id: "extra", kind: "file_exists", path: "/x", label: "Log rotated" } as ScenarioDefinition["checks"][number],
      ],
    }),
  });
  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.checksAdded, ["Log rotated"]);
  assert.deepEqual(diff.checksRemoved, ["Service is running"]);
  assert.deepEqual(diff.checksReweighted, [{ id: "Config is present", from: 2, to: 4 }]);
  assert.deepEqual(diff.passScore, { from: 70, to: 80 });
  assert.deepEqual(diff.timeLimitSec, { from: 1800, to: 1200 });
  assert.equal(diff.gradingChanged, true);

  const line = describeDiff(diff);
  assert.match(line, /\+1 check/);
  assert.match(line, /−1 check/);
  assert.match(line, /1 reweighted/);
  assert.match(line, /pass 70% → 80%/);
  assert.match(line, /limit 30m → 20m/);
});

test("a copy-edit's diff says so, and does not claim a grading change", () => {
  const diff = diffSnapshots(snapshot(), snapshot({ summary: "clearer", tags: ["linux", "services"] }));
  assert.equal(diff.gradingChanged, false);
  assert.equal(diff.textChanged, true);
  assert.equal(describeDiff(diff), "wording only");
});

test("a rollback restores the old shape but never the slug", () => {
  const stored = { ...snapshot({ title: "Old title" }), slug: "taken-since" };
  const restored = rollbackSnapshot({ snapshot: stored });
  assert.equal(restored.title, "Old title");
  assert.equal((restored as unknown as Record<string, unknown>).slug, undefined);
});

test("a revision with no snapshot is refused rather than half-restored", () => {
  assert.throws(() => rollbackSnapshot({ snapshot: null }), /no snapshot/);
});

test("snapshotOf copies the tags instead of aliasing them", () => {
  const row = { ...snapshot(), slug: "x" };
  const copy = snapshotOf(row);
  copy.tags.push("mutated");
  assert.deepEqual(row.tags, ["linux"]);
});
