/**
 * The lab's catalogue, written into a deployment — and the rule that keeps it honest.
 *
 * Two claims are worth checking, and they are different claims.
 *
 * The first is mechanical: the 14 real scenarios become 14 rows whose lab tag, slug,
 * engine and `labMeta` are the importer's output unchanged, so the lossless round trip
 * `tests/lab-scenario-import.test.ts` proves about the *mapping* is also true of what a
 * deployment would *hold*. That is the half Step 5 left as a caveat — "no imported
 * scenario has been written to a database" — and the reason `Scenario.labMeta` exists.
 *
 * The second is the one that would bite a deployment: a lab scenario is graded on a real
 * machine and carries no simulated checks, so a simulated attempt at it would grade
 * nothing while the evidence claimed the lab graded it, because the mode is read from the
 * same tag (`gradingModeForTags`). The refusal therefore has to be asked at *both* seams —
 * the card that decides which door to draw, and the action that creates the attempt —
 * because a rule only the page checks is a rule a POST walks past. That second claim is
 * why this file reads two source files: a pure rule with no caller is the failure this
 * repository has already met twice (a suite no job ran, a reader no page asked).
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { labScenarioUpdate, labScenarioWrite, planLabImport, type LabImportSource } from "../src/lib/lab-import";
import { LAB_SCENARIO_TAG, simulatedStartRefusal } from "../src/lib/lab-rules";
import type { LabScenario } from "../src/lib/lab-scenario-import";
import { expectedEngine } from "../src/lib/validate";

const DIR = path.join(process.cwd(), "tests", "fixtures", "lab-scenarios");
const AUTHOR = "author-under-test";

/** The real catalogue, as the script reads it. */
function sources(): LabImportSource[] {
  return readdirSync(DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      name: file,
      raw: JSON.parse(readFileSync(path.join(DIR, file), "utf8")) as LabScenario,
    }));
}

test("lab import: the whole catalogue plans, and every row is what the importer produced", () => {
  const plan = planLabImport(sources());

  assert.equal(plan.refused.length, 0, `refused: ${JSON.stringify(plan.refused, null, 2)}`);
  assert.ok(plan.rows.length >= 14, `the plan holds ${plan.rows.length} rows`);

  for (const row of plan.rows) {
    const original = sources().find((source) => (source.raw as LabScenario).id === row.slug)?.raw as LabScenario;
    assert.ok(original, `${row.slug} came from a fixture`);
    assert.ok(row.tags.includes(LAB_SCENARIO_TAG), `${row.slug} is tagged for the lab, which is what opens the door`);
    assert.equal(row.definition.engine, expectedEngine(row.platform), `${row.slug} boots the engine its platform implies`);
    assert.equal(row.definition.checks.length, 0, `${row.slug} has no simulated checks, by design`);
    assert.equal(row.labMeta.id, original.id, `${row.slug} keeps the lab's own id`);
    assert.equal(row.labMeta.category, (original.category ?? "").trim(), `${row.slug} keeps its category`);
  }
});

test("lab import: the row written is published, lab-tagged, and keeps the author's ownership on a re-import", () => {
  const [row] = planLabImport(sources()).rows;
  assert.ok(row, "the plan produced a row");

  const create = labScenarioWrite(row, AUTHOR);
  assert.equal(create.published, true, "a lab scenario a student cannot reach is a door drawn nowhere");
  assert.equal(create.authorId, AUTHOR);
  assert.equal(create.engine, row.definition.engine, "the column does not recompute what the definition already says");
  assert.deepEqual(create.tags, row.tags);
  // The JSON columns are the importer's output, unreshaped: the round trip is a claim
  // about these values, so a writer that rewrapped them would end it silently.
  assert.deepEqual(JSON.parse(JSON.stringify(create.labMeta)), JSON.parse(JSON.stringify(row.labMeta)));
  assert.deepEqual(JSON.parse(JSON.stringify(create.definition)), JSON.parse(JSON.stringify(row.definition)));

  const update = labScenarioUpdate(row);
  assert.equal("authorId" in update, false, "a re-import does not take a row away from a person who edited it");
  assert.equal(update.published, true);
  assert.equal(update.slug, undefined, "and it does not try to rename the row it found by slug");
});

test("lab import: a scenario the family cannot hold is refused by name, with every reason", () => {
  const good = sources()[0]!;
  const plan = planLabImport([
    { name: "broken.json", raw: { id: "no-objectives", title: "Nothing to show", briefing: "A briefing long enough to pass." } },
    { name: "alien.json", raw: { id: "beos", title: "BeOS", briefing: "A briefing long enough to pass.", platform: "beos", objectives: [{ id: "a", text: "Do it" }] } },
    good,
  ]);

  assert.equal(plan.refused.length, 2);
  const broken = plan.refused.find((entry) => entry.name === "broken.json");
  assert.ok(broken && broken.issues.some((issue) => issue.includes("no objectives")), `named the reason: ${JSON.stringify(plan.refused)}`);
  const alien = plan.refused.find((entry) => entry.name === "alien.json");
  assert.ok(alien && alien.issues.some((issue) => issue.includes("beos")), "and named the platform it does not have");
  assert.equal(plan.rows.length, 1, "a refusal does not stop the rest from mapping — it stops them from being written");
});

test("lab import: two sources claiming one id are refused rather than silently overwritten", () => {
  const [first] = sources();
  const plan = planLabImport([
    first!,
    { name: "second-copy.json", raw: (first!.raw as LabScenario) },
  ]);

  assert.equal(plan.rows.length, 1, "one slug, one row");
  assert.equal(plan.refused.length, 1);
  assert.match(plan.refused[0]!.issues[0]!, /already claimed by/, "and the refusal says which source won");
});

test("lab: both seams refuse a simulated start, not only the card that draws the door", () => {
  // The rule itself.
  assert.equal(simulatedStartRefusal(["linux", "basics"]), null, "a simulated scenario starts as it always did");
  assert.match(simulatedStartRefusal(["lab"]) ?? "", /real machine/, "a lab scenario says where it is graded");
  assert.match(simulatedStartRefusal(["Lab"]) ?? "", /real machine/, "and the tag is matched the way `isLabScenario` matches it");

  // Asked where it matters. The action is the one that can be reached without the page,
  // so it is the one that must not rely on the page having asked.
  const action = readFileSync(path.join(process.cwd(), "src", "app", "actions", "student.ts"), "utf8");
  assert.ok(/simulatedStartRefusal\(/.test(action), "startAttempt must ask the rule");
  assert.ok(/if \(labRefusal\) fail\(/.test(action), "and must refuse the start when it answers");

  const page = readFileSync(path.join(process.cwd(), "src", "app", "(app)", "student", "page.tsx"), "utf8");
  assert.ok(/simulatedStartRefusal\(/.test(page), "the card must ask the same rule to decide which door to draw");
  assert.ok(/labOnly \?/.test(page), "and must draw one door, not two");
});
