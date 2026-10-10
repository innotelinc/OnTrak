/**
 * The lab's 14 scenarios, read into the family and read back again.
 *
 * The claim this file exists to check is the one §6/C3 of the audit makes: the two
 * scenario models are a mapping, not a merge, and the mapping is one-directional and
 * lossless *for the fields it claims to carry*. So the tests are:
 *
 *  - **Every one of the 14 imports.** The records are the real `scenario.yaml` files,
 *    converted once to JSON and shipped as `scenarios/<id>/scenario.json`, so this is
 *    the whole catalogue and not a sample that happens to be easy.
 *  - **Every one round-trips.** `exportLabScenario(importLabScenario(x))` equals the
 *    original for every field the import preserves — which is what turns "we did not
 *    lose anything" from a comment into a check.
 *  - **Every one is refused by the simulator, and says why.** A lab scenario's grading
 *    lives in its own check script against a live machine, so the imported definition
 *    carries no checks and `validateDefinition` must decline it. A version that
 *    silently passed validation would be the dangerous outcome: a student scored on
 *    invented checks nobody authored.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { scenarioEntriesFrom, scenarioRoot } from "../src/lib/lab/dataset";
import {
  exportLabScenario,
  importLabScenario,
  type LabScenario,
  type ImportedLabScenario,
} from "../src/lib/lab-scenario-import";
import { expectedEngine, validateDefinition } from "../src/lib/validate";

const DIR = scenarioRoot();

/** The 14 records, straight from the tree a host reads (`scenarios/<id>/scenario.json`). */
function fixtures(): { name: string; raw: LabScenario }[] {
  return scenarioEntriesFrom(DIR).map((entry) => ({
    name: entry.fileName,
    raw: entry.record as LabScenario,
  }));
}

/**
 * The original, narrowed to the fields the import claims to preserve.
 *
 * Strings are trimmed on this side too. A YAML block scalar (`briefing: |`) carries a
 * trailing newline that is an artifact of the file, not a fact about the scenario, and the
 * importer reads the text it means rather than the bytes it was written with — so the
 * comparison has to be between the two *values*, not between one value and a trailing `\n`.
 */
function normalizeOriginal(lab: LabScenario) {
  return {
    id: lab.id.trim(),
    title: lab.title.trim(),
    category: (lab.category ?? "").trim(),
    platform: (lab.platform ?? "windows").trim(),
    workloads: lab.workloads ?? (lab.workload ? [lab.workload] : []),
    difficulty: typeof lab.difficulty === "number" ? lab.difficulty : 2,
    minutes: typeof lab.minutes === "number" ? lab.minutes : 25,
    pass_score: typeof lab.pass_score === "number" ? lab.pass_score : 80,
    tags: (lab.tags ?? []).map((tag) => tag.trim()),
    requires_internet: lab.requires_internet === true,
    lessons: lab.lessons ?? [],
    briefing: (lab.briefing ?? "").trim(),
    objectives: (lab.objectives ?? []).map((objective) => ({
      id: objective.id.trim(),
      text: objective.text.trim(),
      weight: typeof objective.weight === "number" ? objective.weight : 0,
      critical: objective.critical === true,
    })),
    hints: (lab.hints ?? []).map((hint) => hint.trim()),
    reset_notes: (lab.reset_notes ?? "").trim(),
    generated_from: lab.generated_from ?? [],
  };
}

/** The same shape, from the exporter (whose empty lists are `undefined`). */
function normalizeExported(lab: LabScenario) {
  return { ...lab, workloads: lab.workloads ?? [], lessons: lab.lessons ?? [], generated_from: lab.generated_from ?? [] };
}

function imported(lab: LabScenario): ImportedLabScenario {
  const result = importLabScenario(lab);
  assert.ok(result.ok, result.ok ? "" : `refused: ${result.issues.join("; ")}`);
  return result.scenario;
}

test("lab import: the catalogue is all 14 scenarios", () => {
  assert.equal(fixtures().length, 14, "every lab scenario must be covered, not a sample");
});

test("lab import: each scenario round-trips, field for field", () => {
  for (const { name, raw } of fixtures()) {
    const back = normalizeExported(exportLabScenario(imported(raw)));
    assert.deepEqual(back, normalizeOriginal(raw), `${name} did not survive the round trip`);
  }
});

test("lab import: the family's columns are the lab's facts", () => {
  for (const { name, raw } of fixtures()) {
    const scenario = imported(raw);

    assert.equal(scenario.slug, raw.id, `${name}: the lab id is already slug-shaped`);
    assert.equal(scenario.title, raw.title);
    assert.equal(scenario.description, (raw.briefing ?? "").trim(), `${name}: the briefing is the description`);
    assert.equal(scenario.definition.brief, (raw.briefing ?? "").trim());
    assert.equal(scenario.definition.engine, expectedEngine(scenario.platform), `${name}: engine follows platform`);
    assert.equal(scenario.passScore, raw.pass_score ?? 80, `${name}: the pass mark is the lab's`);

    // The objectives become the family's task list — the same instruction, worded by the lab.
    assert.deepEqual(
      scenario.definition.tasks,
      (raw.objectives ?? []).map((objective) => objective.text),
      `${name}: tasks must be the objectives`,
    );
    assert.deepEqual(
      (scenario.definition.hints ?? []).map((hint) => hint.text),
      raw.hints ?? [],
      `${name}: hints are carried`,
    );

    // The `lab` tag is what makes the student page offer a real machine (Step 4), so the
    // import has to add it — a scenario that imported without it would be invisible there.
    assert.ok(scenario.tags.includes("lab"), `${name}: imported scenarios are lab scenarios`);
    for (const tag of raw.tags ?? []) {
      assert.ok(scenario.tags.includes(tag), `${name}: the lab's own tag "${tag}" is kept`);
    }

    // The provenance a columnless model would lose is carried explicitly and is JSON, so
    // it can be written to the nullable `labMeta` column as-is.
    assert.equal(scenario.labMeta.id, raw.id);
    assert.equal(scenario.labMeta.platform, raw.platform ?? "windows");
    assert.deepEqual(JSON.parse(JSON.stringify(scenario.labMeta)), scenario.labMeta);
  }
});

test("lab import: the simulator refuses every one, and for the right reason", () => {
  for (const { name, raw } of fixtures()) {
    const result = importLabScenario(raw);
    assert.ok(result.ok, `${name}: expected an import`);
    const scenario = result.scenario;

    // No checks, because nothing in the YAML says which live condition an objective tests.
    assert.deepEqual(scenario.definition.checks, [], `${name}: grading is not invented`);

    const validated = validateDefinition(scenario.definition, {});
    assert.equal(validated.ok, false, `${name}: a lab scenario must not validate as simulated`);
    assert.ok(
      validated.issues.some((issue) => issue.level === "error" && /check/i.test(issue.message)),
      `${name}: the refusal must name the missing checks, saw ${JSON.stringify(validated.issues)}`,
    );

    // And the caller is told, in words, rather than left to infer it from an empty array.
    assert.match(result.simulationRefused, /lab/i);
  }
});

test("lab import: a scenario the family cannot represent is refused", () => {
  assert.equal(importLabScenario(null).ok, false);
  assert.equal(importLabScenario("not an object").ok, false);
  assert.equal(importLabScenario({ title: "no id" }).ok, false);

  const noObjectives = importLabScenario({ id: "x", title: "x", briefing: "a briefing long enough to pass" });
  assert.equal(noObjectives.ok, false, "the family needs at least one task");
  if (!noObjectives.ok) assert.ok(noObjectives.issues.some((issue) => /objectives/i.test(issue)));

  const alienPlatform = importLabScenario({
    id: "x",
    title: "x",
    briefing: "a briefing long enough to pass",
    platform: "plan9",
    objectives: [{ id: "o", text: "do the thing" }],
  });
  assert.equal(alienPlatform.ok, false, "a platform the family does not have is refused, not guessed");
});
