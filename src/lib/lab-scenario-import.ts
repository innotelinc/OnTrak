/**
 * The lab's scenarios, read one way into the family's — a mapping, not a merge.
 *
 * OnTrak-dev authors a scenario as a directory: `scenario.yaml` for the ticket, the
 * objectives and the metadata the student reads, plus a `setup.ps1`/`check.sh` that
 * injects the fault and grades it against the live machine. This app authors a
 * `ScenarioDefinition`: a machine the simulator boots and a list of checks it
 * evaluates in-process. The two are the same *idea* and cannot be the same *row*
 * (audit §6/C3) — a single table holding both would be half nulls and no reader
 * could tell which kind it had.
 *
 * So this module is one direction and one shape: take a parsed `scenario.yaml` and
 * produce the family's columns as they would be written, plus the lab's own
 * provenance kept aside for a lossless return trip. It is pure — no file reads, no
 * database — because the interesting questions are all decisions, and a decision
 * that needs a database to test is a decision nobody tests.
 *
 * Three decisions worth stating out loud.
 *
 * **The grading is not imported, and saying so is the point.** A lab objective is
 * prose graded by the lab's `check.sh` against a live guest; the simulator's checks
 * read its own engine state, and nothing in the YAML says which live condition an
 * objective is really testing. Inventing a `file_exists` that merely looks plausible
 * would score a student on something nobody authored. So `checks` comes back empty
 * and the result carries `simulationRefused` with the reason: `validateDefinition`
 * then refuses the definition, which is exactly the honest outcome — it is a lab
 * scenario and it may not be published as a simulated one.
 *
 * **The family's `lab` tag is added, so Step 4 already works.** A scenario imported
 * here is tagged `lab`, which is what makes the student page offer it as a real
 * machine (see `lab-rules.ts`). The importer does not need to touch that path.
 *
 * **What the definition cannot hold is kept in `labMeta`.** Objective ids, weights
 * and critical flags, the category, the workloads and lessons — none has a column in
 * the family's model, and `validateDefinition` strips an unknown key rather than
 * persisting it. So they are carried in one explicit nullable column and
 * `exportLabScenario` rebuilds the lab's own view from it, which is what makes the
 * round trip a test rather than a hope.
 */

import type { Difficulty } from "@prisma/client";

import { LAB_SCENARIO_TAG } from "./lab-rules";
import { DEFAULT_PASS_SCORE as FAMILY_DEFAULT_PASS_SCORE, MAX_TIME_LIMIT_SEC, MIN_TIME_LIMIT_SEC } from "./scenario-rules";
import type { Platform, ScenarioDefinition, ScenarioHint } from "./sim/types";
import { expectedEngine } from "./validate";

/* -------------------------------------------------------------------------- */
/*  The lab's own shape (as `scenario.yaml` parses)                           */
/* -------------------------------------------------------------------------- */

export interface LabObjective {
  id: string;
  text: string;
  weight?: number;
  critical?: boolean;
  hint?: string;
}

/** A parsed `scenario.yaml`. Everything optional except the two a scenario needs. */
export interface LabScenario {
  id: string;
  title: string;
  category?: string;
  /** `linux` or `windows`; the lab defaults to windows when it is absent. */
  platform?: string;
  workload?: string;
  workloads?: string[];
  /** 1 … 4. */
  difficulty?: number;
  minutes?: number;
  pass_score?: number;
  tags?: string[];
  requires_internet?: boolean;
  lessons?: string[];
  briefing?: string;
  objectives?: LabObjective[];
  hints?: string[];
  reset_notes?: string;
  generated_from?: string[];
}

/* -------------------------------------------------------------------------- */
/*  What the family keeps beside the row                                      */
/* -------------------------------------------------------------------------- */

/**
 * The lab's own facts, kept so the import is reversible.
 *
 * Every field here is one the family's `Scenario` has no column for *and*
 * `ScenarioDefinition` would strip. Keeping them together, rather than spread across
 * tags and prose, is what lets `exportLabScenario` rebuild the original exactly.
 */
export interface LabScenarioMeta {
  /** The lab's scenario id, kept even though it is usually the slug too. */
  id: string;
  category: string;
  /** `linux` | `windows`, the lab's own spelling. */
  platform: string;
  workloads: string[];
  /** The lab's `pass_score` as authored, so a re-export does not read back a clamp. */
  passScore: number;
  requiresInternet: boolean;
  lessons: string[];
  generatedFrom: string[];
  objectives: { id: string; text: string; weight: number; critical: boolean }[];
  resetNotes: string;
}

/** A family `Scenario` as this importer would write it (the row, not yet saved). */
export interface ImportedLabScenario {
  /** The lab id is already slug-shaped; uniqueness is the caller's business. */
  slug: string;
  title: string;
  summary: string;
  description: string;
  platform: Platform;
  difficulty: Difficulty;
  timeLimitSec: number;
  passScore: number;
  tags: string[];
  definition: ScenarioDefinition;
  labMeta: LabScenarioMeta;
}

export type LabScenarioImportResult =
  | {
      ok: true;
      scenario: ImportedLabScenario;
      /** Why the simulator cannot grade this: always set, because it never can. */
      simulationRefused: string;
    }
  | { ok: false; issues: string[] };

/* -------------------------------------------------------------------------- */
/*  Reading it                                                                */
/* -------------------------------------------------------------------------- */

const DIFFICULTY_BY_LEVEL: Record<number, Difficulty> = {
  1: "FOUNDATION",
  2: "INTERMEDIATE",
  3: "ADVANCED",
  4: "EXPERT",
};
const LEVEL_BY_DIFFICULTY: Record<Difficulty, number> = {
  FOUNDATION: 1,
  INTERMEDIATE: 2,
  ADVANCED: 3,
  EXPERT: 4,
};

const LAB_DEFAULT_MINUTES = 25;
const LAB_DEFAULT_PASS_SCORE = 80;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter(Boolean) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The platform, and the engine the family's definition must name for it.
 *
 * The lab defaults to windows when a scenario omits it (`scenarios.py`), so that is
 * mirrored rather than guessed: a scenario with no `platform` is a Windows one, which
 * is what its own runner would have built.
 */
function platformOf(raw: string): Platform | null {
  const value = raw.toLowerCase();
  if (value === "" || value === "windows") return "WINDOWS";
  if (value === "linux") return "LINUX";
  return null;
}

/**
 * The machine block the family's definition requires, read from the workload id.
 *
 * A lab scenario names the platform it is built on as a catalog id (`ubuntu-24.04`,
 * `win11-24h2`), which is the same fact the family's `machine` block states in its own
 * words. It is derived here rather than defaulted to one hard-coded OS so a
 * Debian-flavoured check is not labelled Ubuntu; where the id does not parse, the
 * family's own default for the platform is used and the caller is told in `notes`.
 */
function machineFor(platform: Platform, workload: string): { machine: ScenarioDefinition["machine"]; parsed: boolean } {
  const match = /^([a-z]+)[-_ ]?(\d[0-9.]*)?/i.exec(workload);
  if (platform === "WINDOWS") {
    if (match) {
      const family = match[1]!.toLowerCase();
      const version = (match[2] ?? "").replace("-", ".");
      const os = family.startsWith("win") ? `Windows ${family.replace(/^win/, "")}`.trim() : family;
      return { machine: { hostname: "workstation", user: "Administrator", os, version: version || "11" }, parsed: true };
    }
    return { machine: { hostname: "workstation", user: "Administrator", os: "Windows 11", version: "23H2" }, parsed: false };
  }
  if (match) {
    const distro = match[1]!;
    const version = match[2] ?? "";
    const os = distro.charAt(0).toUpperCase() + distro.slice(1);
    return { machine: { hostname: "workstation", user: "student", os, version: version || "24.04" }, parsed: true };
  }
  return { machine: { hostname: "workstation", user: "student", os: "Ubuntu", version: "24.04" }, parsed: false };
}

/** The first sentence of the briefing, for the catalog's one-line summary. */
function summaryOf(title: string, briefing: string): string {
  const firstLine = briefing.split(/\n/, 1)[0]?.trim() ?? "";
  const source = firstLine || title;
  return source.length > 140 ? `${source.slice(0, 137)}…` : source;
}

/**
 * Import one parsed lab scenario.
 *
 * `ok: false` is reserved for a scenario that cannot be represented at all — no id, no
 * title, no objectives (the family's definition needs at least one task). Everything
 * else maps, and the *grading* gap is reported rather than turned into an error: the
 * scenario is real, it is simply the lab's to grade.
 */
export function importLabScenario(raw: unknown): LabScenarioImportResult {
  if (!isRecord(raw)) return { ok: false, issues: ["The lab scenario is not an object."] };

  const issues: string[] = [];
  const id = text(raw.id);
  const title = text(raw.title);
  if (!id) issues.push("The lab scenario has no `id`.");
  if (!title) issues.push("The lab scenario has no `title`.");

  const briefing = text(raw.briefing);
  if (briefing.length < 10) issues.push("The lab scenario has no `briefing` (or it is too short to brief a student).");

  const platform = platformOf(text(raw.platform));
  if (platform === null) issues.push(`The lab scenario names a platform this app does not have: "${text(raw.platform)}".`);

  const objectives = Array.isArray(raw.objectives) ? raw.objectives : [];
  const parsedObjectives: LabScenarioMeta["objectives"] = [];
  for (const [index, entry] of objectives.entries()) {
    if (!isRecord(entry)) {
      issues.push(`Objective ${index} is not an object.`);
      continue;
    }
    const objectiveId = text(entry.id);
    const objectiveText = text(entry.text);
    if (!objectiveId || !objectiveText) {
      issues.push(`Objective ${index} needs both an \`id\` and \`text\`.`);
      continue;
    }
    parsedObjectives.push({
      id: objectiveId,
      text: objectiveText,
      weight: typeof entry.weight === "number" ? entry.weight : 0,
      critical: entry.critical === true,
    });
  }
  if (parsedObjectives.length === 0) {
    issues.push("The lab scenario declares no objectives, so the family has no task to show a student.");
  }

  if (issues.length > 0 || platform === null) return { ok: false, issues };

  const workloads = stringList(raw.workloads);
  if (workloads.length === 0 && text(raw.workload)) workloads.push(text(raw.workload));
  const workload = workloads[0] ?? "";

  const minutes = typeof raw.minutes === "number" && raw.minutes > 0 ? raw.minutes : LAB_DEFAULT_MINUTES;
  const timeLimitSec = Math.min(MAX_TIME_LIMIT_SEC, Math.max(MIN_TIME_LIMIT_SEC, Math.round(minutes * 60)));
  const labPassScore = typeof raw.pass_score === "number" ? raw.pass_score : LAB_DEFAULT_PASS_SCORE;
  const passScore = Math.min(100, Math.max(0, labPassScore));
  const difficulty = DIFFICULTY_BY_LEVEL[typeof raw.difficulty === "number" ? raw.difficulty : 2] ?? "INTERMEDIATE";

  const { machine, parsed: machineParsed } = machineFor(platform, workload);
  const hints: ScenarioHint[] = stringList(raw.hints).map((hint, index) => ({ id: `lab-hint-${index + 1}`, text: hint }));

  const definition: ScenarioDefinition = {
    version: 1,
    platform,
    engine: expectedEngine(platform),
    objective: title.slice(0, 70),
    brief: briefing,
    // The objectives are the family's task list: the same thing, worded by the lab.
    tasks: parsedObjectives.map((objective) => objective.text),
    machine,
    // Empty on purpose — see the module comment. `validateDefinition` refuses this, which
    // is what stops a lab scenario being published as if the simulator could grade it.
    checks: [],
    hints,
    authorNotes:
      `Imported from OnTrak-dev scenario "${id}"` +
      `${text(raw.category) ? ` (category ${text(raw.category)})` : ""}` +
      `${workloads.length > 0 ? `; built on ${workloads.join(", ")}` : ""}.` +
      " Objectives are graded by the lab's own setup/check scripts against a live machine, not here.",
  };

  const tags = [...new Set([...stringList(raw.tags), LAB_SCENARIO_TAG])];

  const scenario: ImportedLabScenario = {
    slug: id,
    title,
    summary: summaryOf(title, briefing),
    description: briefing,
    platform,
    difficulty,
    timeLimitSec,
    passScore,
    tags,
    definition,
    labMeta: {
      id,
      category: text(raw.category),
      platform: platform === "WINDOWS" ? "windows" : "linux",
      workloads,
      passScore: labPassScore,
      requiresInternet: raw.requires_internet === true,
      lessons: stringList(raw.lessons),
      generatedFrom: stringList(raw.generated_from),
      objectives: parsedObjectives,
      resetNotes: text(raw.reset_notes),
    },
  };

  const notes = machineParsed
    ? `The machine block was read from the workload "${workload}".`
    : `No workload parsed, so the machine block uses the family's default for ${platform}.`;

  return {
    ok: true,
    scenario,
    simulationRefused:
      "The lab grades its objectives against a live machine, and none of them is expressible as a " +
      "simulated check, so the definition carries no checks and is refused for the simulation. " +
      `Publish it as a lab scenario (it is tagged "${LAB_SCENARIO_TAG}"); ${notes}`,
  };
}

/* -------------------------------------------------------------------------- */
/*  Back again (for the round-trip test)                                      */
/* -------------------------------------------------------------------------- */

/**
 * The lab's view of an imported scenario, rebuilt from the family's row.
 *
 * Exists so the round trip is a checkable claim rather than a comment: whatever this
 * returns must equal the original for every field the import claims to preserve. It is
 * not a second import path — nothing saves its output — and it is deliberately strict:
 * it takes the row the importer produced, not a database record, so a test does not
 * need a database to hold the two halves to one another.
 */
export function exportLabScenario(scenario: ImportedLabScenario): LabScenario {
  const meta = scenario.labMeta;
  return {
    id: meta.id,
    title: scenario.title,
    category: meta.category,
    platform: meta.platform,
    workloads: meta.workloads.length > 0 ? meta.workloads : undefined,
    difficulty: LEVEL_BY_DIFFICULTY[scenario.difficulty],
    minutes: Math.round(scenario.timeLimitSec / 60),
    pass_score: meta.passScore,
    // The importer's own tag is dropped: it is the family's annotation, not the lab's.
    tags: scenario.tags.filter((tag) => tag !== LAB_SCENARIO_TAG),
    requires_internet: meta.requiresInternet,
    lessons: meta.lessons.length > 0 ? meta.lessons : undefined,
    briefing: scenario.description,
    objectives: meta.objectives.map((objective) => ({
      id: objective.id,
      text: objective.text,
      weight: objective.weight,
      critical: objective.critical,
    })),
    hints: (scenario.definition.hints ?? []).map((hint) => hint.text),
    reset_notes: meta.resetNotes,
    generated_from: meta.generatedFrom.length > 0 ? meta.generatedFrom : undefined,
  };
}

/** The family's default pass mark, re-exported so callers need not import two modules. */
export { FAMILY_DEFAULT_PASS_SCORE };
