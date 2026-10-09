/**
 * The lab's data and scripts, read from this repository.
 *
 * `scenarios.ts`, `catalog.ts` and `lessons.ts` are deliberately pure: they take records a
 * caller has already parsed, and `ScenarioFiles` is *injected* rather than read because a
 * pure module cannot open a file and must not pretend it did. Something has to be the other
 * half of that, and this is it — the single place in `src/lib/lab/` that touches the tree,
 * so a route handler, a CLI script and a test do not each invent their own layout.
 *
 * THE LAYOUT is the lab's own, because a scenario's grading is a script that has to be
 * *in* the guest, not just a record about one:
 *
 *     scenarios/
 *       _lib/OnTrak.Common.ps1      the PowerShell library every scenario dots in
 *       _lib/ontrak-common.sh       its shell twin
 *       <id>/scenario.json          the ticket, objectives, hints and metadata
 *       <id>/setup.ps1 | setup.sh   injects the fault
 *       <id>/check.ps1 | check.sh   grades it against the live machine
 *       <id>/resources/**           anything those scripts need
 *
 * The scripts are the lab's, unchanged: a scenario's check decides whether a student's fix
 * works, and `setup.ps1`/`check.ps1` are not something a port should paraphrase (that is
 * also why the CLI keeps the lab's own `ontrak template build` advice in its errors). The
 * records are the lab's `scenario.yaml` converted once to JSON with the lab's own parser,
 * field for field, and they sit beside their scripts so that one scenario is one directory
 * — which is what makes the same tree work for a template build, a check run and a lesson.
 *
 * WHY THIS MODULE EXISTS AT ALL, as a gap rather than a design: the records were originally
 * shipped only under `tests/fixtures/lab-scenarios/`, in a flat directory with no scripts.
 * That is enough for a unit test and not enough for a deployment, so the tree here is the
 * one a host reads and the fixtures are gone; `tests/lab-dataset.test.ts` asserts the shipped
 * tree is complete — every scenario's record present, and the script its platform needs —
 * because a missing `check.sh` is otherwise discovered by a student whose grading fails.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { type Catalog, catalogFromManifests } from "./catalog";
import { type LessonManifests, LessonRepository } from "./lessons";
import {
  CHECK_NAMES,
  SETUP_NAMES,
  type Scenario,
  type ScenarioEntry,
  type ScenarioFiles,
  ScenarioRepository,
  parseScenarioRecord,
} from "./scenarios";

/** The library every PowerShell scenario dots in. */
export const WINDOWS_LIB = "OnTrak.Common.ps1";
/** Its shell twin. */
export const SHELL_LIB = "ontrak-common.sh";

/** Directories inside the tree that are not scenarios. */
const NOT_A_SCENARIO = new Set(["_lib"]);

/**
 * Where the tree is, unless a caller says otherwise.
 *
 * `process.cwd()` rather than anything relative to this file: the lab's own configuration
 * was a set of paths resolved against a root, and a deployment that mounts the tree
 * elsewhere sets it in one place (`settings.paths.scenarios`) instead of moving the code.
 */
export function scenarioRoot(root: string = process.cwd()): string {
  return join(root, "scenarios");
}

/** Where the ported catalogue and lesson JSON live. */
export function shippedDataDir(root: string = process.cwd()): string {
  return join(root, "src", "lib", "lab", "data");
}

/** A readable message rather than an `ENOENT` for the one mistake a caller can make. */
function requireDirectory(directory: string, what: string): string[] {
  let names: string[];
  try {
    names = readdirSync(directory).sort();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${what} is not readable at ${directory} (${detail})`);
  }
  return names;
}

/**
 * Every scenario record in the tree, ready for `ScenarioRepository`.
 *
 * Files are read in directory order and the *file name* recorded is the relative path
 * (`net-dns-failure/scenario.json`), because that is what an error message has to say for
 * an operator to find the file — the flat loader could get away with a bare name, a tree
 * cannot.
 *
 * An empty tree is an error and not an empty catalogue: a deployment whose data did not ship
 * would otherwise serve a portal with nothing in it and no reason why.
 */
export function scenarioEntriesFrom(directory: string = scenarioRoot()): ScenarioEntry[] {
  const entries: ScenarioEntry[] = [];
  const names = requireDirectory(directory, "the scenario tree");
  for (const name of names) {
    if (name.startsWith(".") || NOT_A_SCENARIO.has(name)) continue;
    const path = join(directory, name);
    if (!statSync(path).isDirectory()) continue;
    const record = join(path, "scenario.json");
    let source: string;
    try {
      source = readFileSync(record, "utf8");
    } catch {
      // A directory with no record is skipped rather than fatal: `_lib` is not the only
      // thing a host may put in there (a README, a scratch directory), and the alternative
      // is a deployment that refuses to start over a stray folder.
      continue;
    }
    const label = join(name, "scenario.json");
    entries.push({ fileName: label, record: parseScenarioRecord(source, label) });
  }
  if (entries.length === 0) {
    throw new Error(
      `no scenarios found under ${directory}: each scenario is a directory holding scenario.json`,
    );
  }
  return entries;
}

/** The scenario repository over the tree on this disk. */
export function loadScenarios(
  directory: string = scenarioRoot(),
  options: ConstructorParameters<typeof ScenarioRepository>[1] = {},
): ScenarioRepository {
  return new ScenarioRepository(scenarioEntriesFrom(directory), options);
}

/**
 * The files one scenario has, as the validator wants to see them.
 *
 * `present` is the directory listing (relative names, resources included) and the two texts
 * are the scripts for the scenario's **own** platform: a Linux scenario that ships
 * `check.ps1` has not shipped its check, and `present` is what lets the validator say so
 * rather than a null text being read as "no problem".
 */
export function scenarioFilesFor(scenario: Scenario, directory: string = scenarioRoot()): ScenarioFiles {
  const scenarioDir = join(directory, scenario.id);
  const present: string[] = [];
  const walk = (relative: string): void => {
    for (const name of requireDirectory(join(scenarioDir, relative), `scenario ${scenario.id}`)) {
      const child = relative === "" ? name : `${relative}/${name}`;
      if (statSync(join(scenarioDir, child)).isDirectory()) walk(child);
      else present.push(child);
    }
  };
  walk("");

  const read = (name: string): string | null => {
    try {
      return readFileSync(join(scenarioDir, name), "utf8");
    } catch {
      return null;
    }
  };
  return {
    present,
    setupText: read(SETUP_NAMES[scenario.platform]),
    checkText: read(CHECK_NAMES[scenario.platform]),
  };
}

/** Every scenario's files, keyed by scenario id — what `validate`'s `files` option wants. */
export function scenarioFiles(
  scenarios: readonly Scenario[],
  directory: string = scenarioRoot(),
): Map<string, ScenarioFiles> {
  return new Map(scenarios.map((scenario) => [scenario.id, scenarioFilesFor(scenario, directory)]));
}

/** The ported catalogue manifests (`src/lib/lab/data/catalog.json`). */
export function loadCatalog(dataDir: string = shippedDataDir()): Catalog {
  const raw: unknown = JSON.parse(readFileSync(join(dataDir, "catalog.json"), "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${join(dataDir, "catalog.json")}: top level must be a mapping of file name to manifest`);
  }
  return catalogFromManifests(raw as Record<string, unknown>);
}

/** The ported lesson library (`src/lib/lab/data/lessons.json`). */
export function loadLessons(dataDir: string = shippedDataDir()): LessonRepository {
  const raw: unknown = JSON.parse(readFileSync(join(dataDir, "lessons.json"), "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${join(dataDir, "lessons.json")}: top level must be a mapping of file name to lesson`);
  }
  return new LessonRepository(raw as LessonManifests);
}

/** The site's own settings JSON (`src/lib/lab/data/config.json`), as the loader's input. */
export function loadConfigData(dataDir: string = shippedDataDir()): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${join(dataDir, "config.json")}: top level must be a mapping`);
  }
  return raw as Record<string, unknown>;
}
