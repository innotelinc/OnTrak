/**
 * How a training task is graded — simulated in this app, or on a real machine in
 * the lab — and the one place that names the two.
 *
 * The family grades a `ScenarioDefinition` by reading its own simulated engine
 * state, in-process: fast, deterministic, and available on a phone. The lab
 * (OnTrak-dev) grades the *same kind of task* by running `check.ps1` against a
 * live guest. They are the same training done two ways, and the one thing that
 * cannot be shared is the meaning of a number: "8/10" from a simulator and "8/10"
 * from a live machine were produced by different graders, so a report that adds
 * them together is describing neither. This module exists so that fact has a name
 * and a single reader, rather than being re-guessed at every surface.
 *
 * Three decisions worth stating out loud.
 *
 * **The mode is a property of the task, and the task already says it.** A
 * scenario that runs on a real machine carries the `lab` tag (added by the
 * importer in `lab-scenario-import.ts`, and read by the student page in
 * `lab-rules.ts`), so `gradingModeForTags` is the same exact-match rule applied
 * once more rather than a second marker that could drift out of step with it. A
 * scenario without the tag is the simulator's, and no scenario is ever both.
 *
 * **Evidence records how it was graded, so the column is written, not derived.**
 * The `Attempt.gradingMode` column stores the mode at the moment of grading
 * (docs/consolidation-audit.md §7 Step 6). Re-deriving it later from the tags
 * would let a scenario retagged tomorrow silently rewrite what yesterday's
 * evidence says — the same reason a certificate is stored rather than recomputed.
 *
 * **An unknown or missing mode is `simulated`, never `lab`.** Every attempt
 * graded before this existed has no mode, and every one of those was graded by
 * the simulator; reading them as lab would overstate the lab's reach. The default
 * therefore points at the weaker claim, which is the honest direction for an
 * assurance record.
 *
 * Pure — no database, no environment — so both callers and tests read the same
 * rule.
 */

import { isLabScenario } from "./lab-rules";

/** Who graded an attempt: the in-browser simulator, or the lab's live machine. */
export type GradingMode = "simulated" | "lab";

/** Every mode, in the order the UI lists them (the default first). */
export const GRADING_MODES: readonly GradingMode[] = ["simulated", "lab"];

/** What an unmarked task, and an attempt predating modes, are graded in. */
export const DEFAULT_GRADING_MODE: GradingMode = "simulated";

/**
 * The mode a task asks to be graded in.
 *
 * `lab` only for a task tagged `lab` — the same exact, case-insensitive match the
 * rest of the family uses, so a scenario tagged `cyber-lab` is not quietly moved
 * onto a hypervisor it was never written for.
 */
export function gradingModeForTags(tags: readonly string[] | null | undefined): GradingMode {
  return isLabScenario(tags) ? "lab" : DEFAULT_GRADING_MODE;
}

export function isGradingMode(value: unknown): value is GradingMode {
  return value === "simulated" || value === "lab";
}

/** Any stored value, coerced to a mode. Unknown or absent is the default. */
export function normalizeGradingMode(value: unknown): GradingMode {
  return isGradingMode(value) ? value : DEFAULT_GRADING_MODE;
}

/** A short human label, for a badge or a CSV column. */
export function gradingModeLabel(mode: GradingMode): string {
  return mode === "lab" ? "Real machine (lab)" : "Simulated";
}

/** A sentence naming how a mode grades, for a tooltip or an audit note. */
export function gradingModeBlurb(mode: GradingMode): string {
  return mode === "lab"
    ? "Graded by the lab's own checks against a live machine."
    : "Graded by the simulator's checks against its in-browser engine state.";
}
