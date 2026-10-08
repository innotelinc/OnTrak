/**
 * Writing the lab's scenarios into a deployment — the half Step 5 left open.
 *
 * `lab-scenario-import.ts` is the mapping, and it is pure and complete: given a parsed
 * `scenario.yaml` it produces the family's columns. What it deliberately does not do is
 * touch a database, and the audit recorded the consequence honestly (§8): *"no imported
 * scenario has been written to a database"*, so the lab was a catalogue entry, a tile and
 * a gated link whose gate could never open — the student page draws the lab door for a
 * scenario tagged `lab`, and no row carried that tag.
 *
 * So this module is the plan an operator's script applies, and it is pure for the same
 * reason the importer is: the decisions worth checking are decisions, and a decision that
 * needs a database to test is a decision nobody tests. `planLabImport` turns parsed
 * sources into the rows to write and the sources it refuses, naming every refusal; the
 * caller writes them. `scripts/import-lab-scenarios.ts` is that caller.
 *
 * Three decisions worth stating out loud.
 *
 * **Published, because a lab scenario is a scenario.** The door to a real machine is
 * drawn on the catalogue card, so a row that is not published is a scenario no student
 * can reach and no instructor can assign. What makes publishing safe is *not* that the
 * simulator can grade it — it cannot, and the importer says so — but that the simulated
 * start is refused for a scenario carrying this tag (`simulatedStartRefusal` in
 * `lab-rules.ts`, enforced in `startAttempt`). Without that rule this module would be
 * writing a free pass.
 *
 * **A plan is whole or it is not applied.** One unrepresentable scenario does not stop the
 * others from mapping; it stops them from being *written*, because a deployment holding 13
 * of the lab's 14 scenarios is a state nobody can reason about — and the refusal names
 * every problem, so the operator fixes them in one pass rather than one run per mistake.
 *
 * **A duplicate is refused, not overwritten.** `Scenario.slug` is unique, so two sources
 * claiming one id would have the second silently win, and which of two different
 * definitions a student got would depend on file order. That is a lab catalogue mistake
 * worth hearing about.
 */

import type { Prisma } from "@prisma/client";

import { importLabScenario, type ImportedLabScenario } from "./lab-scenario-import";

/** A parsed lab scenario and where it came from, for the refusal to name. */
export interface LabImportSource {
  /** A file name or scenario id — whatever lets an operator find the culprit. */
  name: string;
  raw: unknown;
}

export interface LabImportPlan {
  /** The rows to write, in a stable order, one per lab scenario. */
  rows: ImportedLabScenario[];
  /** Sources that could not be represented, each with every reason it could not. */
  refused: { name: string; issues: string[] }[];
}

/**
 * Read every source into a row, refusing the ones the family's model cannot hold.
 *
 * Order is the caller's, and the output is sorted by slug so a diff of two runs is a diff
 * of the catalogue rather than of the filesystem.
 */
export function planLabImport(sources: readonly LabImportSource[]): LabImportPlan {
  const rows: ImportedLabScenario[] = [];
  const refused: { name: string; issues: string[] }[] = [];
  const seen = new Map<string, string>();

  for (const source of sources) {
    const result = importLabScenario(source.raw);
    if (!result.ok) {
      refused.push({ name: source.name, issues: result.issues });
      continue;
    }

    const slug = result.scenario.slug;
    const first = seen.get(slug);
    if (first) {
      refused.push({
        name: source.name,
        issues: [`The lab scenario id "${slug}" is already claimed by ${first}; two definitions for one slug would be one row.`],
      });
      continue;
    }

    seen.set(slug, source.name);
    rows.push(result.scenario);
  }

  rows.sort((a, b) => a.slug.localeCompare(b.slug));
  return { rows, refused };
}

/**
 * The row to write for one imported scenario.
 *
 * `engine` is read from the definition rather than derived again: the definition is what
 * the console and the grader boot, and a column that computed it a second way could
 * disagree with the thing it describes. `labMeta` and `definition` are JSON columns, and
 * they are the importer's output unchanged — the round trip in
 * `tests/lab-scenario-import.test.ts` is a claim about exactly these values, so a writer
 * that reshaped them would quietly end it.
 *
 * `authorId` is required because the family's scenario has an author. On a re-import the
 * caller keeps the existing row's author: a scenario somebody has edited in the app is
 * theirs, and an import is not an ownership transfer.
 */
export function labScenarioWrite(
  scenario: ImportedLabScenario,
  authorId: string,
): Prisma.ScenarioUncheckedCreateInput {
  return {
    slug: scenario.slug,
    title: scenario.title,
    summary: scenario.summary,
    description: scenario.description,
    platform: scenario.platform,
    difficulty: scenario.difficulty,
    engine: scenario.definition.engine,
    timeLimitSec: scenario.timeLimitSec,
    passScore: scenario.passScore,
    published: true,
    tags: scenario.tags,
    definition: scenario.definition as unknown as Prisma.InputJsonValue,
    labMeta: scenario.labMeta as unknown as Prisma.InputJsonValue,
    authorId,
  };
}

/**
 * The half of the row a re-import refreshes, for a scenario that already exists.
 *
 * Everything the lab owns, and nothing the app owns: `authorId` stays with whoever
 * created the row, and `published` is set rather than toggled because the lab's
 * catalogue is published by definition — an operator who wants one hidden unpublishes it
 * in the app, and the next import is a decision they can see coming.
 */
export function labScenarioUpdate(scenario: ImportedLabScenario): Prisma.ScenarioUncheckedUpdateInput {
  const { slug: _slug, authorId: _authorId, ...rest } = labScenarioWrite(scenario, "unused");
  return rest;
}
