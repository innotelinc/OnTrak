/**
 * The scenario's own text, in more than one language (v1.1).
 *
 * The interface has been translated through `src/lib/locales/*` for a while. The text a
 * *scenario authors* — its objective, its task list, the labels its checks are read by and its
 * hints — is data rather than copy, so it has no dictionary to live in: it travels inside the
 * definition JSON. This module is the counterpart that dictionary never had, for one scenario
 * at a time.
 *
 * A definition may carry an optional `i18n` block mapping a locale to the strings that differ
 * from the authored ones. Four decisions carry it, and all four exist so that a translation
 * can change what a reader *sees* and nothing else:
 *
 *   1. **An overlay replaces text; it never changes structure.** Applying one cannot add or
 *      remove a task, a check, a hint or a penalty. A translation therefore cannot make a
 *      scenario easier, harder or differently gradeable, which is what lets this be trustworth
 *      — the grader reads only `checks`, `tasks` and `hints` as authored.
 *   2. **Fallback is per string, not per locale.** A missing translation keeps the authored
 *      string, so a half-finished locale reads as a mixture rather than as blank lines on a
 *      screen the student cannot interpret.
 *   3. **An over-long `tasks` array is clamped and reported, not obeyed.** A seventh task in a
 *      six-task scenario would invent a line the grader has no check for — and the console's
 *      progress bar counts the authored list, so the extra line could never be ticked off.
 *   4. **Checks and hints are keyed by `id`, not by position.** Ids are what the checks already
 *      carry into a stored evaluation, and the order of a `checks` array is a presentation
 *      detail an author may reasonably change later.
 *
 * Nothing here is server-aware, so it runs in the browser, on the server and in tests.
 */

import { LOCALES, isLocale } from "./i18n";
import type { ScenarioDefinition, ScenarioTextOverrides } from "./sim/types";

/** The overlay a definition carries for a locale, if any. */
export function scenarioOverlay(
  definition: Pick<ScenarioDefinition, "i18n">,
  locale: string,
): ScenarioTextOverrides | null {
  const overlay = definition.i18n?.[locale];
  return overlay && typeof overlay === "object" ? overlay : null;
}

/** Whether this deployment knows the locale at all, as opposed to whether a scenario speaks it. */
export function isSupportedLocale(locale: string): boolean {
  return isLocale(locale);
}

/** A translation only wins when it actually says something. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The definition as a reader of `locale` should see it.
 *
 * Returns the *same object* when the locale has nothing to say, so a caller may apply this
 * unconditionally on a hot path without defeating referential equality.
 */
export function localizeDefinition(
  definition: ScenarioDefinition,
  locale: string,
): ScenarioDefinition {
  const overlay = scenarioOverlay(definition, locale);
  if (!overlay) return definition;

  // Tasks: index-parallel, clamped to the authored list, each entry falling back on its own.
  const tasks = definition.tasks.map((task, index) => text(overlay.tasks?.[index]) ?? task);
  const tasksChanged = tasks.some((task, index) => task !== definition.tasks[index]);

  const checks = definition.checks.map((check) => {
    const translated = text(overlay.checks?.[check.id]);
    return translated ? { ...check, label: translated } : check;
  });
  const checksChanged = checks.some((check, index) => check !== definition.checks[index]);

  const hints = definition.hints?.map((hint) => {
    const translated = text(overlay.hints?.[hint.id]);
    return translated ? { ...hint, text: translated } : hint;
  });
  const hintsChanged = hints?.some((hint, index) => hint !== definition.hints?.[index]) ?? false;

  const objective = text(overlay.objective) ?? definition.objective;
  const objectiveChanged = objective !== definition.objective;

  if (!tasksChanged && !checksChanged && !hintsChanged && !objectiveChanged) return definition;

  return {
    ...definition,
    objective,
    tasks,
    checks,
    ...(hints ? { hints } : {}),
  };
}

/**
 * The one-line goal, translated if the scenario has a translation for it.
 *
 * The catalog's own `summary` column is staff-written metadata and takes precedence today;
 * the third argument lets the caller keep that behaviour while letting a translation of the
 * scenario's *objective* win when one exists — a translator who has written the goal should
 * be the one a student reads.
 */
export function localizedObjective(
  definition: ScenarioDefinition,
  locale: string,
  fallbackSummary?: string | null,
): string {
  const overlay = scenarioOverlay(definition, locale);
  return text(overlay?.objective) ?? text(fallbackSummary) ?? definition.objective;
}

/**
 * A check's label, translated by check `id`.
 *
 * A stored evaluation already carries the authored label, and that is the right record — the
 * attempt happened when it happened. This is what turns it back into the student's language
 * at the moment they read their own report, without touching the stored row.
 */
export function localizeCheckLabel(
  definition: Pick<ScenarioDefinition, "checks" | "i18n">,
  locale: string,
  checkId: string | null | undefined,
  authored: string,
): string {
  if (!checkId) return authored;
  return text(scenarioOverlay(definition, locale)?.checks?.[checkId]) ?? authored;
}

/** A hint's text, translated by hint `id`. */
export function localizeHintText(
  definition: Pick<ScenarioDefinition, "hints" | "i18n">,
  locale: string,
  hintId: string,
  authored: string,
): string {
  return text(scenarioOverlay(definition, locale)?.hints?.[hintId]) ?? authored;
}

export interface LocaleCoverage {
  locale: string;
  /** Whether this deployment actually offers the locale. */
  supported: boolean;
  objective: boolean;
  tasks: { translated: number; total: number };
  checks: { translated: number; total: number; unknown: string[] };
  hints: { translated: number; total: number; unknown: string[] };
  /** Human-readable problems, for the editor and the validator to show verbatim. */
  problems: string[];
}

/**
 * What each locale's overlay actually covers, and what is wrong with it.
 *
 * The editor and the validator both need the same judgement about an overlay, so it is made
 * once, here, and returned rather than thrown: an overlay that names a check that does not
 * exist is a mistake worth a message and not worth rejecting a scenario that otherwise runs.
 */
export function overlayCoverage(definition: ScenarioDefinition): LocaleCoverage[] {
  const hints = definition.hints ?? [];
  const hintIds = new Set(hints.map((hint) => hint.id));
  const checkIds = new Set(definition.checks.map((check) => check.id));

  return Object.entries(definition.i18n ?? {}).map(([locale, stored]) => {
    const problems: string[] = [];
    const supported = isSupportedLocale(locale);
    if (!supported) {
      problems.push(`"${locale}" is not a locale this deployment offers (${LOCALES.join(", ")}).`);
    }
    // The definition is JSON read back from a database, so an overlay that is not an object is
    // described rather than trusted.
    const overlay: ScenarioTextOverrides = stored && typeof stored === "object" ? stored : {};
    if (!stored || typeof stored !== "object") {
      problems.push(`The overlay for "${locale}" is not an object.`);
    }
    const countStrings = (values: string[] | undefined) =>
      (values ?? []).filter((value) => text(value) !== null).length;

    const translatedTasks = countStrings(overlay.tasks);
    const overLong = (overlay.tasks?.length ?? 0) > definition.tasks.length;
    if (overLong) {
      problems.push(
        `The overlay for "${locale}" lists ${overlay.tasks?.length} tasks but the scenario has ${definition.tasks.length} — the extra ones are ignored.`,
      );
    }

    const unknownChecks = Object.keys(overlay.checks ?? {}).filter((id) => !checkIds.has(id));
    if (unknownChecks.length > 0) {
      problems.push(`The overlay for "${locale}" translates unknown checks: ${unknownChecks.join(", ")}.`);
    }

    const unknownHints = Object.keys(overlay.hints ?? {}).filter((id) => !hintIds.has(id));
    if (unknownHints.length > 0) {
      problems.push(`The overlay for "${locale}" translates unknown hints: ${unknownHints.join(", ")}.`);
    }

    return {
      locale,
      supported,
      objective: text(overlay.objective) !== null,
      tasks: {
        translated: Math.min(translatedTasks, definition.tasks.length),
        total: definition.tasks.length,
      },
      checks: {
        translated: Math.max(0, countStrings(Object.values(overlay.checks ?? {})) - unknownChecks.length),
        total: definition.checks.length,
        unknown: unknownChecks,
      },
      hints: {
        translated: Math.max(0, countStrings(Object.values(overlay.hints ?? {})) - unknownHints.length),
        total: hints.length,
        unknown: unknownHints,
      },
      problems,
    };
  });
}

/** One line per locale, for a roadmap report or an editor's status strip. */
export function coverageSummary(coverage: LocaleCoverage[]): string {
  if (coverage.length === 0) return "No translations: this scenario reads as authored in every locale.";
  return coverage
    .map(
      (entry) =>
        `${entry.locale}: objective ${entry.objective ? "yes" : "no"}, ` +
        `tasks ${entry.tasks.translated}/${entry.tasks.total}, ` +
        `checks ${entry.checks.translated}/${entry.checks.total}, ` +
        `hints ${entry.hints.translated}/${entry.hints.total}`,
    )
    .join("; ");
}
