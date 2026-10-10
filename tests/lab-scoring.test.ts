/**
 * Grading is the only place a student's number is decided, so these tests are the
 * contract rather than a smoke test: the weighted score, the pass mark, and the two
 * ways a broken check must never look like a pass — a payload that never arrived,
 * and an objective the script stayed silent about.
 *
 * Every case here is ported from the Python control plane's `tests/test_scoring.py`,
 * so a score decided by the ported module is the score the lab already recorded.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-scoring.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JSON_BEGIN,
  JSON_END,
  scoreReportFailed,
  scoreReportFromDict,
  scoreReportPassedCount,
  scoreReportToDict,
  type GradeableScenario,
} from "../src/lib/lab/models";
import {
  GradingError,
  collectChecks,
  evaluate,
  extractPayload,
  feedbackText,
  renderFeedback,
} from "../src/lib/lab/scoring";

/**
 * The fixture scenario the Python tests build: one critical objective worth half the
 * grade, one ordinary one, one write-up, and a pass mark of 80.
 */
function makeScenario(passScore = 80): GradeableScenario {
  return {
    id: "unit-scenario",
    title: "Unit scenario",
    passScore,
    objectives: [
      {
        id: "must-fix",
        text: "The critical thing",
        weight: 50,
        critical: true,
        hint: "check the route",
      },
      { id: "nice-to-have", text: "The secondary thing", weight: 30, critical: false, hint: "check the service" },
      { id: "write-it-up", text: "Notes", weight: 20, critical: false, hint: "" },
    ],
  };
}

/** Guest output with the usual banners around the one payload that matters. */
function guestOutput(checks: unknown[], noise = "[noise] banner text\n"): string {
  return `${noise}${JSON_BEGIN}\n${JSON.stringify({ checks })}\n${JSON_END}\nnoise after\n`;
}

test("grading: all objectives pass, so the score is 100 and the attempt resolves", () => {
  const scenario = makeScenario();
  const output = guestOutput([
    { objective: "must-fix", passed: true, detail: "gateway answers" },
    { objective: "nice-to-have", passed: true },
    { objective: "write-it-up", passed: true },
  ]);

  const report = evaluate(scenario, 7, output);
  assert.equal(report.score, 100);
  assert.equal(report.resolved, true);
  assert.equal(scoreReportPassedCount(report), 3);
  assert.equal(report.sessionId, 7);
  assert.equal(report.machineScore, 100);
});

test("grading: partial credit is weighted, and 70 is short of an 80 pass mark", () => {
  const scenario = makeScenario();
  const output = guestOutput([
    { objective: "must-fix", passed: true },
    { objective: "nice-to-have", passed: false, detail: "still broken" },
    { objective: "write-it-up", passed: true },
  ]);

  const report = evaluate(scenario, 1, output);
  assert.equal(report.score, 70); // 50 + 20 of 100
  assert.equal(report.resolved, false);
  assert.deepEqual(
    scoreReportFailed(report).map((outcome) => outcome.objectiveId),
    ["nice-to-have"],
  );
});

test("grading: an objective the script did not report counts as failed and unreported", () => {
  const scenario = makeScenario();
  const report = evaluate(scenario, 1, guestOutput([{ objective: "must-fix", passed: true }]));

  const unreported = report.outcomes.filter((outcome) => !outcome.reported);
  assert.deepEqual(
    unreported.map((outcome) => outcome.objectiveId).sort(),
    ["nice-to-have", "write-it-up"],
  );
  assert.equal(
    unreported.every((outcome) => !outcome.passed),
    true,
  );
  assert.equal(report.score, 50);
});

test("grading: a critical objective failing blocks resolution even with a high score", () => {
  const scenario = makeScenario();
  const output = guestOutput([
    { objective: "must-fix", passed: false, detail: "no route" },
    { objective: "nice-to-have", passed: true },
    { objective: "write-it-up", passed: true },
  ]);

  const report = evaluate(scenario, 1, output);
  assert.equal(report.score, 50);
  assert.equal(report.resolved, false);
});

test("grading: the pass mark is per scenario", () => {
  const scenario = makeScenario(50);
  const output = guestOutput([
    { objective: "must-fix", passed: true },
    { objective: "nice-to-have", passed: false },
    { objective: "write-it-up", passed: false },
  ]);

  const report = evaluate(scenario, 1, output);
  assert.equal(report.score, 50);
  assert.equal(report.resolved, true);
});

test("grading: a payload that never arrived is an error, not a zero with credit", () => {
  const scenario = makeScenario();
  const report = evaluate(scenario, 1, "the script crashed before reporting\n");

  assert.ok(report.error);
  assert.equal(report.score, 0);
  assert.equal(report.resolved, false);
  assert.equal(
    report.outcomes.every((outcome) => !outcome.passed && !outcome.reported),
    true,
  );
  assert.equal(report.outcomes.length, scenario.objectives.length);
});

test("grading: malformed JSON is an error naming what went wrong", () => {
  const scenario = makeScenario();
  const report = evaluate(scenario, 1, `${JSON_BEGIN}\n{not json\n${JSON_END}`);

  assert.match(report.error, /not valid JSON/);
  assert.equal(report.score, 0);
});

test("grading: extractPayload rejects output with no markers at all", () => {
  assert.throws(() => extractPayload("nothing to see"), GradingError);
});

test("grading: the last payload between the markers wins, so a retry is graded on its final answer", () => {
  const scenario = makeScenario();
  const output =
    guestOutput([{ objective: "must-fix", passed: false }]) +
    guestOutput([
      { objective: "must-fix", passed: true },
      { objective: "nice-to-have", passed: true },
      { objective: "write-it-up", passed: true },
    ]);

  const report = evaluate(scenario, 1, output);
  assert.equal(report.score, 100);
  assert.equal(report.resolved, true);
});

test("grading: the {objective: bool} shorthand payload is accepted", () => {
  const scenario = makeScenario();
  const payload = { checks: { "must-fix": true, "nice-to-have": true, "write-it-up": false } };
  const report = evaluate(scenario, 1, `${JSON_BEGIN}${JSON.stringify(payload)}${JSON_END}`);

  assert.equal(report.score, 80);
  assert.equal(report.resolved, true); // the critical passed and the score met the mark
});

test("grading: a flapping probe cannot fake a pass", () => {
  const outcomes = collectChecks({
    checks: [
      { objective: "tcp", passed: true },
      { objective: "tcp", passed: false, detail: "second probe failed" },
    ],
  });

  const tcp = outcomes.get("tcp");
  assert.equal(tcp?.passed, false);
  assert.equal(tcp?.detail, "second probe failed");
});

test("grading: unknown objective ids are surfaced as a note, not swallowed", () => {
  const scenario = makeScenario();
  const report = evaluate(scenario, 1, guestOutput([{ objective: "renamed-id", passed: true }]));

  assert.ok(report.notes.length > 0);
  assert.match(report.notes[0] ?? "", /renamed-id/);
  assert.equal(report.score, 0);
});

test("grading: boolean coercion accepts the shapes a PowerShell script emits", () => {
  const scenario = makeScenario();
  const output = guestOutput([
    { objective: "must-fix", ok: "yes" },
    { objective: "nice-to-have", success: 1 },
    { objective: "write-it-up", pass: "PASSED" },
  ]);

  const report = evaluate(scenario, 1, output);
  assert.equal(report.score, 100);
});

test("grading: a scenario with no objectives is an error rather than a zero", () => {
  const scenario: GradeableScenario = {
    id: "empty",
    title: "Empty",
    passScore: 80,
    objectives: [],
  };
  const report = evaluate(scenario, 1, guestOutput([]));

  assert.match(report.error, /declares no objectives/);
  assert.equal(report.outcomes.length, 0);
});

test("grading: feedback rows carry the objective text and expose a hint only on failure", () => {
  const scenario = makeScenario();
  const output = guestOutput([
    { objective: "must-fix", passed: true, detail: "ok" },
    { objective: "nice-to-have", passed: false, detail: "still broken" },
    { objective: "write-it-up", passed: false },
  ]);
  const report = evaluate(scenario, 1, output);

  const rows = new Map(renderFeedback(scenario, report).map((row) => [row.objective_id, row]));
  assert.equal(rows.get("must-fix")?.passed, true);
  assert.equal(rows.get("must-fix")?.text, "The critical thing");
  assert.ok(rows.get("nice-to-have")?.hint); // a failed objective exposes its hint
  assert.equal(rows.get("must-fix")?.hint, "");
  assert.equal(rows.get("write-it-up")?.hint, "");

  // The instructor may ask for the rows without the answer key at all.
  const silent = new Map(
    renderFeedback(scenario, report, { showHints: false }).map((row) => [row.objective_id, row]),
  );
  assert.equal(silent.get("nice-to-have")?.hint, "");

  const text = feedbackText(scenario, report);
  assert.match(text, /Score:/);
  assert.match(text, /not yet resolved/);
  assert.match(text, /still broken/);
  assert.match(text, /\[critical\]/);
});

test("grading: a report round-trips through its stored JSON", () => {
  const scenario = makeScenario();
  const report = evaluate(scenario, 3, guestOutput([{ objective: "must-fix", passed: true }]));

  const stored = JSON.parse(JSON.stringify(scoreReportToDict(report))) as Record<string, unknown>;
  const restored = scoreReportFromDict(stored);

  assert.equal(restored.score, report.score);
  assert.equal(restored.resolved, report.resolved);
  assert.deepEqual(scoreReportToDict(restored), scoreReportToDict(report));
});
