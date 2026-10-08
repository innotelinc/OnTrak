/**
 * Who graded an attempt, and what an unstated mode means.
 *
 * The whole point of the mode is that a number cannot be read without it: the
 * simulator's "8/10" and the lab's "8/10" came from different graders, so a
 * report that lumps them together is describing neither. These tests pin the
 * three rules that make the field trustworthy — the task's tag decides the mode,
 * an unknown value is never promoted to the stronger claim, and the two values
 * are the only ones the rest of the app has to handle.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/grading-mode.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_GRADING_MODE,
  GRADING_MODES,
  gradingModeBlurb,
  gradingModeForTags,
  gradingModeLabel,
  isGradingMode,
  normalizeGradingMode,
} from "../src/lib/grading-mode";

test("grading mode: a task is the lab's only when it says so, exactly", () => {
  assert.equal(gradingModeForTags(["lab"]), "lab");
  assert.equal(gradingModeForTags([" Linux ", "LAB"]), "lab", "the tag match is trimmed and case-insensitive");
  assert.equal(gradingModeForTags(["cyber-lab"]), "simulated", "a lookalike tag is not the lab's");
  assert.equal(gradingModeForTags(["laboratory"]), "simulated");
  assert.equal(gradingModeForTags([]), "simulated");
  assert.equal(gradingModeForTags(null), "simulated");
  assert.equal(gradingModeForTags(undefined), "simulated");
});

test("grading mode: an unstated or unknown mode is the weaker claim, never the lab", () => {
  assert.equal(DEFAULT_GRADING_MODE, "simulated");
  assert.equal(normalizeGradingMode(undefined), "simulated");
  assert.equal(normalizeGradingMode(null), "simulated");
  assert.equal(normalizeGradingMode(""), "simulated");
  assert.equal(normalizeGradingMode("Lab"), "simulated", "case is not how the stored value is spelled");
  assert.equal(normalizeGradingMode("real-vm"), "simulated");
  assert.equal(normalizeGradingMode("simulated"), "simulated");
  assert.equal(normalizeGradingMode("lab"), "lab");
});

test("grading mode: the type guard accepts exactly the two spellings", () => {
  assert.equal(isGradingMode("simulated"), true);
  assert.equal(isGradingMode("lab"), true);
  assert.equal(isGradingMode("Simulated"), false);
  assert.equal(isGradingMode("container"), false);
  assert.equal(isGradingMode(1), false);
  assert.equal(isGradingMode(null), false);
});

test("grading mode: every mode has a label and a sentence, and they differ", () => {
  assert.deepEqual([...GRADING_MODES], ["simulated", "lab"]);
  const labels = GRADING_MODES.map(gradingModeLabel);
  const blurbs = GRADING_MODES.map(gradingModeBlurb);
  assert.equal(new Set(labels).size, GRADING_MODES.length);
  assert.equal(new Set(blurbs).size, GRADING_MODES.length);
  assert.match(gradingModeLabel("lab"), /lab/i);
  assert.match(gradingModeBlurb("lab"), /live machine/);
  assert.match(gradingModeBlurb("simulated"), /simulator/);
});
