/**
 * The lab's scenario catalogue: loading, the views the portal reads, and validation.
 *
 * The TypeScript half of OnTrak-dev's `ontrak/scenarios.py`. A lab scenario is a
 * ticket, a list of weighted objectives, hints and metadata, plus two scripts that
 * inject the fault and grade it against a live machine. The objectives are a
 * **contract**: the check script must report on exactly those ids, and
 * `validateRecords`/`validate` enforce that statically so a renamed id cannot
 * silently score zero forever.
 *
 * WHERE THE DATA COMES FROM — a decision already made, not one this module makes.
 * Python reads `scenarios/<id>/scenario.yaml` with PyYAML. This repository has no
 * YAML parser and does not want one, and it does not need one: the lab's 14
 * scenarios were already converted field-for-field to JSON, and the shape is
 * defined once in `src/lib/lab-scenario-import.ts` (`LabScenario`). That is the
 * shape loaded here, the real lab data is the `scenarios/` tree this repository ships —
 * each scenario's `scenario.json` beside the scripts a host runs (`src/lib/lab/dataset.ts`
 * is the module that reads it) — and `docs/lab-port.md` §3/C6 records the decision. A second definition
 * of the on-disk shape, or a second YAML dialect in one tree, is exactly the drift
 * this module refuses.
 *
 * TWO THINGS ARE DELIBERATELY INJECTED RATHER THAN ASSUMED, because a pure module
 * cannot read a disk and must not pretend it did:
 *
 * - **The files.** Python's validator reads `setup.ps1`/`check.ps1` and the
 *   scenario's `resources/`. That is a filesystem, so the caller supplies it
 *   (`ScenarioFiles`: the file names present, and the two scripts' text). The
 *   repository's own JSON data files carry no scripts, so the record rules and the
 *   script contract are separate entry points — see below — rather than one
 *   validator that quietly checks less than it claims.
 * - **The ticket rubric.** `tickets.ts` (the write-up form's loader, validator and
 *   grader) is a separate module, and `TicketRules` is the two-function seam it is
 *   injected through: this module loads scenarios and never marks a write-up, but it does
 *   need to know whether one *exists* for `has_ticket` and the public view, and it has to
 *   report a broken rubric before a student meets it. `DEFAULT_TICKET_RULES` is the real
 *   thing; the seam stays because a test (and stage 3's portal) can pass its own rules in.
 *
 * `validateRecords` checks everything that can be checked from the record alone.
 * `validate` checks that **and** the script contract, and it reports a scenario it
 * was given no files for as a problem rather than skipping it silently — a
 * validator that can be made to pass by withholding evidence is worse than none.
 *
 * The `JSON_BEGIN`/`JSON_END` marker pair the scripts print is **not** here: it is
 * the grader's contract and it lives in `models.ts`, where the module that parses
 * it owns it. Python declared it in `scenarios.py` and imported it into
 * `scoring.py`; this port inverts that, and `docs/lab-port.md` says why.
 */

import {
  loadForm,
  validateForm,
  type TicketForm,
} from "./tickets";
import type { LabScenario as ScenarioRecord } from "../lab-scenario-import";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  objectiveFromDict,
  objectiveIn,
  scenarioTotalWeight,
  type GradeableScenario,
  type Objective,
} from "./models";

/* -------------------------------------------------------------------------- */
/*  Vocabulary                                                                */
/* -------------------------------------------------------------------------- */

/** The marker a setup script prints once the fault is fully applied. */
export const SETUP_OK_MARKER = "ONTRAK-SETUP-OK";
/** The PowerShell helper that prints it. */
export const SETUP_OK_HELPER = "Write-OnTrakSetupOk";
/** The PowerShell entry point a check script must call. */
export const CHECK_ENTRYPOINT = "Write-OnTrakReport";
/** The PowerShell helper library a scenario's scripts may dot-source. */
export const COMMON_LIB = "OnTrak.Common.ps1";

/** Shell equivalents, for Linux guests (`scenarios/_lib/ontrak-common.sh`). */
export const SHELL_SETUP_OK_HELPER = "ontrak_setup_ok";
export const SHELL_CHECK_HELPER = "ontrak_check";
export const SHELL_CHECK_ENTRYPOINT = "ontrak_report";
export const SHELL_COMMON_LIB = "ontrak-common.sh";

/**
 * A scenario targets one platform. Windows guests are driven with PowerShell,
 * Linux guests with shell; the script contract is the same on both — apply the
 * fault, then report JSON between two markers — which is what lets the grader, the
 * portal and the scoring arithmetic stay platform-independent.
 */
export type Platform = "windows" | "linux";
export const WINDOWS: Platform = "windows";
export const LINUX: Platform = "linux";
export const PLATFORMS: readonly Platform[] = [WINDOWS, LINUX];

export const SETUP_NAMES: Record<Platform, string> = { windows: "setup.ps1", linux: "setup.sh" };
export const CHECK_NAMES: Record<Platform, string> = { windows: "check.ps1", linux: "check.sh" };

export const DEFAULT_PASS_SCORE = 80;
export const MAX_DIFFICULTY = 4;

/** Raised when a scenario is missing or invalid. */
export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

/**
 * The ways a manifest might spell a category, mapped onto the six the app has.
 *
 * Kept because it is authored content, not an implementation detail: a scenario
 * whose `category:` says `Drivers` is a hardware scenario, and refusing it would
 * make the catalogue stricter than the thing it replaced.
 */
const CATEGORY_ALIASES: Record<string, string> = {
  hardware: "hardware",
  hw: "hardware",
  driver: "hardware",
  drivers: "hardware",
  software: "software",
  apps: "software",
  app: "software",
  network: "network",
  net: "network",
  connectivity: "network",
  os: "os",
  boot: "os",
  performance: "os",
  perf: "os",
  security: "security",
  malware: "security",
  identity: "identity",
  identities: "identity",
  access: "identity",
  accounts: "identity",
  directory: "identity",
  ad: "identity",
  ldap: "identity",
};

const PLATFORM_ALIASES: Record<string, Platform> = {
  windows: WINDOWS,
  win: WINDOWS,
  ps: WINDOWS,
  powershell: WINDOWS,
  linux: LINUX,
  unix: LINUX,
  shell: LINUX,
  sh: LINUX,
};

export function normalisePlatform(value: string): Platform {
  const key = value.trim().toLowerCase().replace(/ /g, "");
  const found = PLATFORM_ALIASES[key];
  if (found) return found;
  throw new ScenarioError(`unknown platform ${JSON.stringify(value)}; use one of: ${PLATFORMS.join(", ")}`);
}

export function normaliseCategory(value: string): string {
  const key = value.trim().toLowerCase().replace(/ /g, "_");
  const alias = CATEGORY_ALIASES[key];
  if (alias) return alias;
  if ((CATEGORIES as readonly string[]).includes(key)) return key;
  throw new ScenarioError(
    `unknown category ${JSON.stringify(value)}; use one of: ${[...CATEGORIES].sort().join(", ")}`,
  );
}

/* -------------------------------------------------------------------------- */
/*  The loaded scenario                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One scenario, as the rest of the lab reads it.
 *
 * It satisfies `GradeableScenario`, so the grader takes it without a conversion —
 * the same object the catalogue lists is the object `evaluate` scores.
 */
export interface Scenario extends GradeableScenario {
  /**
   * The file this record was read from.
   *
   * Python's `Scenario` carries its `directory`, and the validator uses it to catch
   * a manifest whose `id:` disagrees with the folder someone renamed. In the flat
   * JSON layout the file name plays that part, so it is kept for the same rule.
   */
  readonly fileName: string;
  category: string;
  /** The human label, e.g. "Network & connectivity". */
  categoryLabel: string;
  briefing: string;
  difficulty: number;
  minutes: number;
  hints: string[];
  tags: string[];
  requiresInternet: boolean;
  /** The raw `ticket:` block, rubric and all — never send this to a student. */
  ticket: Record<string, unknown>;
  resetNotes: string;
  resources: string[];
  instanceDevices: Record<string, unknown>[];
  instanceConfig: Record<string, unknown>;
  /** Optional catalog entry id naming the platform this fault should be built on. */
  workload: string;
  /** The same fault on more than one platform, each of which gets its own template. */
  workloads: string[];
  platform: Platform;
  generatedFrom: string[];
  lessons: string[];
  /** The parsed write-up form, or `null` for machine-only grading. */
  ticketForm: unknown | null;
}

/**
 * Every catalog workload this scenario can be built for (may be empty).
 *
 * `workloads` wins when it is set, otherwise the single `workload`, and duplicates
 * are dropped in first-seen order so a template is not built twice.
 */
export function platformWorkloads(scenario: Scenario): string[] {
  const declared = scenario.workloads.length > 0 ? scenario.workloads : scenario.workload ? [scenario.workload] : [];
  return [...new Set(declared.filter((entry) => entry !== ""))];
}

export function scenarioIsLinux(scenario: Scenario): boolean {
  return scenario.platform === LINUX;
}

export function totalWeight(scenario: Scenario): number {
  return scenarioTotalWeight(scenario.objectives);
}

export function criticalObjectives(scenario: Scenario): Objective[] {
  return scenario.objectives.filter((objective) => objective.critical);
}

export function scenarioObjective(scenario: Scenario, objectiveId: string): Objective | null {
  return objectiveIn(scenario.objectives, objectiveId);
}

/** The first `level` hints, so a hint is revealed by asking for it and never by accident. */
export function hintsUpTo(scenario: Scenario, level: number): string[] {
  return scenario.hints.slice(0, Math.max(0, Math.min(level, scenario.hints.length)));
}

function titleCase(value: string): string {
  return value
    .split(" ")
    .map((word) => (word === "" ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * The ticket's own header — who reported it, on what, how urgent.
 *
 * `ticket:` also carries `form:`, the field list with its weights, hints and the
 * terms a competent answer has to contain. The session page used to render the
 * whole block as a key/value table, which printed that rubric beside the student —
 * the answers, in the page they were meant to answer from. Only scalars survive
 * here and `form` is excluded by name, so a new key in the block cannot leak by
 * default: an entry has to be a plain label/value to reach the page at all.
 */
export function ticketHeader(scenario: Scenario): Record<string, string> {
  const header: Record<string, string> = {};
  for (const [key, value] of Object.entries(scenario.ticket)) {
    if (key === "form") continue;
    const scalar = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    if (!scalar) continue;
    const text = String(value).trim();
    if (text !== "") header[titleCase(key.replace(/_/g, " "))] = text;
  }
  return header;
}

/**
 * Portal-facing view. Never includes script bodies or unrevealed hints.
 *
 * The keys are the wire format the Python portal emitted, so the two are
 * interchangeable at the boundary rather than merely similar.
 */
export function publicView(scenario: Scenario, hintLevel = 0): Record<string, unknown> {
  return {
    id: scenario.id,
    title: scenario.title,
    category: scenario.category,
    category_label: scenario.categoryLabel,
    difficulty: scenario.difficulty,
    minutes: scenario.minutes,
    briefing: scenario.briefing,
    // The header, never the raw block (see ticketHeader).
    ticket: ticketHeader(scenario),
    tags: scenario.tags,
    pass_score: scenario.passScore,
    requires_internet: scenario.requiresInternet,
    reset_notes: scenario.resetNotes,
    workload: scenario.workload,
    workloads: platformWorkloads(scenario),
    platform: scenario.platform,
    lessons: [...scenario.lessons],
    has_ticket: scenario.ticketForm !== null,
    hint_count: scenario.hints.length,
    hints_revealed: hintsUpTo(scenario, hintLevel),
    objectives: scenario.objectives.map((objective) => ({
      id: objective.id,
      text: objective.text,
      weight: objective.weight,
      critical: objective.critical,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/*  The ticket-rubric seam                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `tickets.ts`'s two entry points, injected.
 *
 * Kept a seam rather than imported inline so a caller can substitute its own rules — the
 * scenario suite does exactly that to prove the seam is used — and so this module stays
 * readable as "loads and validates a scenario" rather than "and also marks write-ups".
 */
export interface TicketRules {
  /** The parsed write-up form, or `null` when the scenario is graded on machine state alone. */
  loadForm(ticket: Record<string, unknown>): unknown | null;
  /** Human-readable problems with the form, or none. */
  validateForm(form: unknown, prefix: string): string[];
}

/**
 * The rules the lab actually runs: `loadForm` and `validateForm` from `tickets.ts`.
 *
 * `loadForm` parses the manifest's `ticket.form` into a `TicketForm` — which is then the
 * object `has_ticket`, the public view and the grader all read, so there is one parse and
 * no second shape to disagree with — and `validateForm` enforces the rubric's own rules
 * (field ids, kinds, weights totalling 100, the reserved control names) at load time.
 */
export const DEFAULT_TICKET_RULES: TicketRules = {
  loadForm(ticket) {
    return loadForm(ticket);
  },
  validateForm(form, prefix) {
    return validateForm(form as TicketForm | null, prefix);
  },
};

/* -------------------------------------------------------------------------- */
/*  Reading a record                                                          */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value === undefined || value === null ? fallback : String(value);
}

function numberFrom(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intFrom(value: unknown, fallback: number): number {
  return Math.trunc(numberFrom(value, fallback));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => text(entry)) : [];
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * Parse one scenario record.
 *
 * The analogue of `_load_one`'s YAML handling, with the file read lifted out: a
 * caller that has the text calls this, so the error a broken manifest produces is
 * the same one Python produced (`invalid YAML` becomes `invalid JSON`, and a
 * non-mapping top level is refused either way) and the caller owns the I/O.
 */
export function parseScenarioRecord(source: string, label: string): ScenarioRecord {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ScenarioError(`${label}: invalid JSON: ${detail}`);
  }
  if (!isRecord(data)) throw new ScenarioError(`${label}: top level must be an object`);
  return data as unknown as ScenarioRecord;
}

/**
 * Build the loaded view from a record.
 *
 * `fileName` plays the directory's part: the flat JSON layout puts the scenario in
 * `net-dns-failure.json` where Python had `net-dns-failure/scenario.yaml`, so the
 * file's basename is the name the id is checked against, and the fallback id when
 * the record does not carry one.
 */
export function buildScenario(record: ScenarioRecord, fileName: string, ticketRules: TicketRules = DEFAULT_TICKET_RULES): Scenario {
  const data = record as unknown as Record<string, unknown>;
  const directoryName = fileName.replace(/\.json$/i, "");
  const id = text(data.id, "") === "" ? directoryName : text(data.id);
  const platform = normalisePlatform(text(data.platform, WINDOWS) || WINDOWS);
  const category = normaliseCategory(text(data.category, "software") || "software");
  const ticket = isRecord(data.ticket) ? { ...data.ticket } : {};
  const objectives = records(data.objectives).map(objectiveFromDict);
  return {
    id,
    fileName,
    title: text(data.title, "") === "" ? id : text(data.title),
    category,
    categoryLabel: CATEGORY_LABELS[category] ?? titleCase(category),
    briefing: text(data.briefing).trim(),
    objectives,
    passScore: numberFrom(data.pass_score, DEFAULT_PASS_SCORE),
    difficulty: intFrom(data.difficulty, 2),
    minutes: intFrom(data.minutes, 25),
    hints: stringList(data.hints),
    tags: stringList(data.tags),
    requiresInternet: Boolean(data.requires_internet ?? false),
    ticket,
    resetNotes: text(data.reset_notes).trim(),
    resources: stringList(data.resources),
    instanceDevices: records(data.instance_devices),
    instanceConfig: isRecord(data.instance_config) ? { ...data.instance_config } : {},
    workload: text(data.workload),
    workloads: stringList(data.workloads),
    platform,
    generatedFrom: stringList(data.generated_from),
    lessons: stringList(data.lessons),
    ticketForm: ticketRules.loadForm(ticket),
  };
}

/* -------------------------------------------------------------------------- */
/*  The repository                                                            */
/* -------------------------------------------------------------------------- */

/** One record and the file it came from. */
export interface ScenarioEntry {
  readonly fileName: string;
  readonly record: ScenarioRecord;
}

export interface ScenarioRepositoryOptions {
  readonly ticketRules?: TicketRules;
}

/**
 * The catalogue.
 *
 * Python discovered a directory; this takes the records a caller has already read,
 * for the reason in the header: the module is pure. `load()` caches, `reload()`
 * does not, and a duplicate id is refused loudly at load time — Python's dict
 * assignment kept whichever file came last, which in a flat directory of files
 * whose ids live *inside* them is silent data loss rather than a policy.
 */
export class ScenarioRepository {
  private readonly entries: readonly ScenarioEntry[];
  private readonly ticketRules: TicketRules;
  private scenarios: Map<string, Scenario> | null = null;

  constructor(entries: readonly ScenarioEntry[], options: ScenarioRepositoryOptions = {}) {
    this.entries = entries;
    this.ticketRules = options.ticketRules ?? DEFAULT_TICKET_RULES;
  }

  load(force = false): Map<string, Scenario> {
    if (this.scenarios === null || force) this.scenarios = this.discover();
    return this.scenarios;
  }

  reload(): Map<string, Scenario> {
    return this.load(true);
  }

  private discover(): Map<string, Scenario> {
    const found = new Map<string, Scenario>();
    const sources = new Map<string, string>();
    for (const entry of this.entries) {
      const scenario = buildScenario(entry.record, entry.fileName, this.ticketRules);
      const previous = sources.get(scenario.id);
      if (previous !== undefined) {
        throw new ScenarioError(
          `two scenarios both claim the id ${JSON.stringify(scenario.id)}: ${previous} and ${entry.fileName}`,
        );
      }
      sources.set(scenario.id, entry.fileName);
      found.set(scenario.id, scenario);
    }
    return found;
  }

  get(scenarioId: string): Scenario {
    const scenarios = this.load();
    const found = scenarios.get(scenarioId);
    if (found === undefined) {
      const available = [...scenarios.keys()].sort().join(", ") || "none";
      throw new ScenarioError(`unknown scenario ${JSON.stringify(scenarioId)}; available: ${available}`);
    }
    return found;
  }

  /** Every scenario, in the lab's own reading order: category, then difficulty, then id. */
  list(): Scenario[] {
    const order = new Map<string, number>(CATEGORIES.map((category, index) => [category, index] as const));
    return [...this.load().values()].sort((left, right) => {
      const byCategory = (order.get(left.category) ?? 99) - (order.get(right.category) ?? 99);
      if (byCategory !== 0) return byCategory;
      if (left.difficulty !== right.difficulty) return left.difficulty - right.difficulty;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  }

  byCategory(): Map<string, Scenario[]> {
    const grouped = new Map<string, Scenario[]>();
    for (const scenario of this.list()) {
      const bucket = grouped.get(scenario.category);
      if (bucket === undefined) grouped.set(scenario.category, [scenario]);
      else bucket.push(scenario);
    }
    return grouped;
  }

  ids(): string[] {
    return this.list().map((scenario) => scenario.id);
  }

  /* ---------------------------------------------------------------------- */
  /*  Validation                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Everything checkable from the record alone.
   *
   * This is the half that runs against the JSON data files this repository ships,
   * which carry no scripts. The script contract is `validate`, and it is not
   * skipped here so much as held to a different door — see `validate`.
   */
  validateRecords(scenarioIds?: readonly string[] | null, options: ValidateOptions = {}): string[] {
    return this.runValidation(scenarioIds, options, { scripts: false });
  }

  /**
   * The record rules **and** the script contract.
   *
   * A scenario the caller supplied no `ScenarioFiles` for is reported as a problem
   * rather than passed: the thing this validator exists to prevent is a check
   * script that cannot report an objective, and a validator that returns "clean"
   * because it was handed no scripts would be the same silence in a new place. A
   * caller who genuinely has no scripts — a data-only checkout — uses
   * `validateRecords`, which says in its name what it did not check.
   */
  validate(scenarioIds?: readonly string[] | null, options: ValidateOptions = {}): string[] {
    return this.runValidation(scenarioIds, options, { scripts: true });
  }

  private runValidation(
    scenarioIds: readonly string[] | null | undefined,
    options: ValidateOptions,
    mode: { readonly scripts: boolean },
  ): string[] {
    const problems: string[] = [];
    const scenarios = this.list();
    const wanted = scenarioIds && scenarioIds.length > 0 ? new Set(scenarioIds) : null;
    const selected = wanted === null ? scenarios : scenarios.filter((scenario) => wanted.has(scenario.id));
    // The repository's own ticket rules unless the caller passes its own, so a
    // caller that has the real rubric does not also have to repeat the repository's
    // configuration to get it applied.
    const effective: ValidateOptions = {
      ...options,
      ticketRules: options.ticketRules ?? this.ticketRules,
    };
    const catalog = catalogEntries(effective.catalog);

    for (const scenario of selected) {
      const prefix = `[${scenario.id}]`;
      problems.push(...recordProblems(scenario, prefix, effective, catalog));

      const files = effective.files?.get(scenario.id);
      if (!mode.scripts) continue;
      if (files === undefined) {
        problems.push(
          `${prefix} no scenario files were supplied, so the setup/check contract was not checked ` +
            "(pass ScenarioFiles, or call validateRecords for a data-only checkout)",
        );
        continue;
      }
      problems.push(...scriptProblems(scenario, prefix, files));
    }
    return problems;
  }
}

/**
 * The files a caller has beside a scenario.
 *
 * `present` is the directory listing — needed only by the `resources` rule — and
 * is `null` when there is no directory to look in, in which case a declared
 * resource cannot be checked and is not reported as missing. `setupText`/
 * `checkText` are the scripts' contents, and `null` means the file is not there.
 */
export interface ScenarioFiles {
  readonly present: readonly string[] | null;
  readonly setupText: string | null;
  readonly checkText: string | null;
}

/** A catalog view, only for the "does this workload exist" rule. */
export interface CatalogFacts {
  readonly entries: Iterable<string>;
}

/** A lesson view, only for the "does this lesson exist" rule. */
export interface LessonFacts {
  find(lessonId: string): unknown | null;
}

export interface ValidateOptions {
  readonly files?: ReadonlyMap<string, ScenarioFiles>;
  readonly catalog?: CatalogFacts | null;
  readonly lessons?: LessonFacts | null;
  /** Overrides the repository's rules for this call. Absent means the repository's. */
  readonly ticketRules?: TicketRules;
}

function catalogEntries(catalog: CatalogFacts | null | undefined): Set<string> | null {
  return catalog === null || catalog === undefined ? null : new Set(catalog.entries);
}

const WORKLOAD_ID = /^[a-z0-9][a-z0-9.-]*$/;
const LESSON_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The id a record's label implies.
 *
 * Two layouts are in use because two are real: the lab's flat `net-dns-failure.json`, and
 * the shipped tree's `net-dns-failure/scenario.json`, where the *directory* is the scenario
 * and the file name is fixed by the loader (`src/lib/lab/dataset.ts`). Reading only a stem
 * would make the second layout's every record disagree with a file called `scenario`, which
 * is a rule about the data being renamed, not about the file being named `scenario.json`.
 */
export function idFromLabel(label: string): string {
  const parts = label.replace(/\\/g, "/").split("/");
  const stem = (parts[parts.length - 1] ?? "").replace(/\.json$/i, "");
  if (stem.toLowerCase() === "scenario" && parts.length >= 2) {
    return parts[parts.length - 2] ?? stem;
  }
  return stem;
}

/** The record rules, ported one for one from `ScenarioRepository.validate`. */
function recordProblems(
  scenario: Scenario,
  prefix: string,
  options: ValidateOptions,
  catalog: Set<string> | null,
): string[] {
  const problems: string[] = [];
  const ticketRules = options.ticketRules ?? DEFAULT_TICKET_RULES;

  // The id is checked against the file it came from, which is what a renamed manifest
  // breaks.
  const expectedName = idFromLabel(scenario.fileName);
  if (scenario.id !== expectedName) {
    problems.push(`${prefix} id does not match the file name ${JSON.stringify(scenario.fileName)}`);
  }

  if (!scenario.title || scenario.title === scenario.id) {
    problems.push(`${prefix} missing a human-readable title`);
  }
  if (!scenario.briefing) {
    problems.push(`${prefix} missing briefing text (the student's ticket)`);
  }
  if (!(scenario.difficulty >= 1 && scenario.difficulty <= MAX_DIFFICULTY)) {
    problems.push(`${prefix} difficulty must be 1..${MAX_DIFFICULTY}`);
  }
  if (scenario.minutes <= 0) problems.push(`${prefix} minutes must be positive`);
  // A scenario declaring a mark outside (0, 100] is refused here. This is the
  // *declared* mark being validated, not an attempt being judged — no score is on
  // this line, and the verdict on a student's work is `clearedPassMark`'s alone
  // (plan §3/C5), which is why the exemption marker is correct rather than a bug.
  if (!(scenario.passScore > 0 && scenario.passScore <= 100)) { // pass-rule-exempt: validates the scenario's declared mark, not a score against one
    problems.push(`${prefix} pass_score must be in (0, 100]`);
  }
  if (scenario.objectives.length === 0) problems.push(`${prefix} declares no objectives`);

  const critical = criticalObjectives(scenario);
  if (scenario.objectives.length > 3 && critical.length === scenario.objectives.length) {
    problems.push(
      `${prefix} every objective is critical; keep critical for the must-not-miss items so ` +
        "partial credit stays meaningful",
    );
  }

  const ids = scenario.objectives.map((objective) => objective.id);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) {
    problems.push(`${prefix} duplicate objective id(s): ${[...duplicates].sort().join(", ")}`);
  }

  for (const objective of scenario.objectives) {
    if (objective.weight <= 0) problems.push(`${prefix} objective ${objective.id} needs weight > 0`);
    if (!objective.text) problems.push(`${prefix} objective ${objective.id} has no text`);
  }

  // Weights total 100 so that a pass mark means the same thing in every scenario,
  // and so a student who has done 80% of the work is told so.
  if (scenario.objectives.length > 0 && Math.abs(totalWeight(scenario) - 100) > 0.01) {
    problems.push(`${prefix} objective weights total ${totalWeight(scenario)}, not 100`);
  }

  for (const workloadId of platformWorkloads(scenario)) {
    if (!WORKLOAD_ID.test(workloadId)) {
      problems.push(`${prefix} workload ${JSON.stringify(workloadId)} is not a catalog entry id (lowercase, dash-separated)`);
    } else if (catalog !== null && !catalog.has(workloadId)) {
      problems.push(`${prefix} names workload ${JSON.stringify(workloadId)}, which is not in the catalog`);
    }
  }

  // Teaching material: a scenario that hands a student a command-line fault without
  // a walkthrough to learn it from is an unfair ticket.
  if (scenarioIsLinux(scenario) && scenario.hints.length > 0 && scenario.lessons.length === 0) {
    problems.push(
      `${prefix} is a Linux scenario and offers hints but names no lessons; link the command ` +
        "walkthroughs a student needs (see docs/lessons.md)",
    );
  }
  const lessons = options.lessons ?? null;
  for (const lesson of scenario.lessons) {
    if (!LESSON_ID.test(lesson)) {
      problems.push(`${prefix} lesson id ${JSON.stringify(lesson)} must be lowercase and dash-separated`);
    } else if (lessons !== null && lessons.find(lesson) === null) {
      problems.push(`${prefix} lesson ${JSON.stringify(lesson)} does not exist under lessons/ (the student would follow a dead link)`);
    }
  }

  problems.push(...ticketRules.validateForm(scenario.ticketForm, prefix));

  const present = options.files?.get(scenario.id)?.present ?? null;
  if (present !== null) {
    const listing = new Set(present);
    for (const resource of scenario.resources) {
      if (!listing.has(resource)) problems.push(`${prefix} declared resource ${JSON.stringify(resource)} does not exist`);
    }
  }

  problems.push(...deviceProblems(scenario, prefix));
  return problems;
}

/**
 * Extra hardware.
 *
 * A NIC attaches either as a managed device (`network:`) or as an unmanaged one
 * (`nictype:`/`parent:`). The profile's eth0 already holds the lab network, and
 * Incus refuses two NICs on one managed network ("Instance DNS name conflict
 * between X and Y because both are connected to same network"), since each adapter
 * would claim the instance's own DNS record — so an extra NIC may never name `lab`,
 * the sentinel the builder resolves to that network, and may not name the same
 * concrete network twice.
 */
function deviceProblems(scenario: Scenario, prefix: string): string[] {
  const problems: string[] = [];
  const managed: string[] = [];
  for (const device of scenario.instanceDevices) {
    const name = device.name;
    const type = device.type;
    if (!name || !type) {
      problems.push(`${prefix} each entry in instance_devices needs a 'name' and a 'type'`);
      continue;
    }
    if (type !== "nic") continue;
    if (device.nictype || device.parent) continue;
    const network = text(device.network, "");
    if (network === "") {
      problems.push(
        `${prefix} nic device ${JSON.stringify(name)} needs either a 'network' or a 'nictype' ` +
          "(e.g. nictype: p2p) so the build knows how it attaches",
      );
      continue;
    }
    managed.push(network);
  }

  const offenders = new Set(
    managed.filter((network) => network === "lab" || managed.filter((entry) => entry === network).length > 1),
  );
  for (const network of [...offenders].sort()) {
    const shown = network === "lab" ? "the lab network" : `network ${JSON.stringify(network)}`;
    problems.push(
      `${prefix} an extra NIC cannot join ${shown}, which eth0 already holds; Incus rejects a ` +
        "second NIC on one managed network (duplicate DNS name). Attach it with 'nictype: p2p' instead",
    );
  }
  return problems;
}

/**
 * The setup/check contract, ported from `_script_problems`.
 *
 * Both platforms owe the same two things — a setup script that confirms the fault
 * was applied, and a check script that reports every objective — so the failure
 * modes are identical even though the languages are not. The scripts arrive as
 * text (see `ScenarioFiles`), which is what makes these rules testable without a
 * scenario checkout on disk.
 */
function scriptProblems(scenario: Scenario, prefix: string, files: ScenarioFiles): string[] {
  const problems: string[] = [];
  const setupName = SETUP_NAMES[scenario.platform];
  const checkName = CHECK_NAMES[scenario.platform];
  const windows = scenario.platform === WINDOWS;
  const setupTokens = windows ? [SETUP_OK_HELPER, SETUP_OK_MARKER] : [SHELL_SETUP_OK_HELPER, SETUP_OK_MARKER];
  const setupHint = windows
    ? `${SETUP_OK_HELPER} or the literal ${SETUP_OK_MARKER}`
    : `${SHELL_SETUP_OK_HELPER} or the literal ${SETUP_OK_MARKER}`;
  const entrypoint = windows ? CHECK_ENTRYPOINT : SHELL_CHECK_ENTRYPOINT;

  if (files.setupText === null || files.setupText.length === 0) {
    problems.push(`${prefix} ${setupName} is missing or empty`);
  } else if (!setupTokens.some((token) => files.setupText !== null && files.setupText.includes(token))) {
    problems.push(
      `${prefix} ${setupName} never confirms success (needs ${setupHint}); template build would ` +
        "reject a partially applied fault",
    );
  }

  const checkText = files.checkText;
  if (checkText === null || checkText.length === 0) {
    problems.push(`${prefix} ${checkName} is missing or empty`);
    return problems;
  }

  if (!checkText.includes(entrypoint)) problems.push(`${prefix} ${checkName} must call ${entrypoint}`);
  for (const objectiveId of scenario.objectives.map((objective) => objective.id)) {
    const quoted = new RegExp(`['"]${escapeRegExp(objectiveId)}['"]`);
    if (!quoted.test(checkText)) {
      problems.push(`${prefix} ${checkName} never reports objective ${JSON.stringify(objectiveId)} (it would always score as failed)`);
    }
  }
  if (!windows && !checkText.includes(SHELL_CHECK_HELPER)) {
    problems.push(
      `${prefix} ${checkName} must report through ${SHELL_CHECK_HELPER} so the objective ids and ` +
        "weights match the manifest",
    );
  }
  return problems;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
