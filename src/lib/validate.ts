/**
 * Scenario validation.
 *
 * Instructors author scenarios as JSON (or with the guided builder, which
 * produces the same structure).  Two layers of checking happen here:
 *
 *   1. **Shape** — zod validates the envelope, then a hand-written pass walks
 *      the checks so the author gets a precise message naming the offending
 *      check id and field rather than a zod path soup.
 *   2. **Dry run** — the definition is booted into a fresh engine and every
 *      check is evaluated against the untouched starting state. A check that
 *      already passes before the student does anything is almost always a bug
 *      (a typo'd path, a wrong expected value), so those become warnings.
 */

import { z } from "zod";
import { createDriver } from "./sim/drivers";
import { gradeAttempt } from "./sim/grade";
import { createInitialState } from "./sim/state";
import {
  fidelityLabel,
  normalizeFidelity,
  sandboxAvailability,
  sandboxConfigFromEnv,
  satisfiesFidelity,
  type Fidelity,
  type SandboxAvailability,
} from "./sim/fidelity";
import { overlayCoverage } from "./scenario-i18n";
import type { EngineId, EngineState, Platform, ScenarioCheck, ScenarioDefinition } from "./sim/types";

export interface ValidationIssue {
  level: "error" | "warning";
  /** Check id when the problem belongs to one check. */
  field?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  definition?: ScenarioDefinition;
  issues: ValidationIssue[];
  /** Points available, surfaced in the editor so weighting mistakes stand out. */
  totalPoints: number;
  /** The machine the scenario declares it is authored for (v1.2). */
  fidelity: Fidelity;
  /** Whether this deployment could actually run it at that fidelity, and why not. */
  sandbox: SandboxAvailability;
}

const SEED_NODE = z.object({
  path: z.string().min(1),
  type: z.enum(["dir", "file", "link"]).optional(),
  content: z.string().optional(),
  target: z.string().optional(),
  mode: z.string().optional(),
  owner: z.string().optional(),
  group: z.string().optional(),
});

const HINT = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  penalty: z.number().int().min(0).optional(),
});

const DEFINITION_ENVELOPE = z.object({
  version: z.literal(1),
  platform: z.enum(["LINUX", "WINDOWS", "OFFICE"]),
  engine: z.enum(["bash", "powershell", "office"]),
  surface: z.enum(["console", "desktop"]).optional(),
  fidelity: z.enum(["simulated", "container"]).optional(),
  objective: z.string().min(3, "Give the scenario a one-line objective."),
  brief: z.string().min(10, "The briefing needs at least a sentence or two."),
  tasks: z.array(z.string().min(1)).min(1, "List at least one task the student must complete."),
  machine: z.object({
    hostname: z.string().min(1),
    user: z.string().min(1),
    os: z.string().min(1),
    version: z.string().min(1),
    kernel: z.string().optional(),
    build: z.string().optional(),
    arch: z.string().optional(),
    domain: z.string().optional(),
  }),
  files: z.array(SEED_NODE).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  docs: z.array(z.record(z.string(), z.unknown())).optional(),
  checks: z.array(z.record(z.string(), z.unknown())).min(1, "A scenario needs at least one graded check."),
  hints: z.array(HINT).optional(),
  allowHints: z.boolean().optional(),
  authorNotes: z.string().optional(),
  // Declared here even though the shape is checked by hand below: a key the envelope does not
  // name is *stripped* by zod, and a stripped overlay is a translation that silently vanishes.
  i18n: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

/** Every check kind the engine understands, used to catch typos early. */
export const CHECK_KINDS = [
  "file_exists",
  "file_absent",
  "file_contains",
  "file_not_contains",
  "file_mode",
  "file_owner",
  "dir_exists",
  "command_matched",
  "command_sequence",
  "service_state",
  "package_state",
  "user_exists",
  "user_in_group",
  "user_detail",
  "cron_matches",
  "firewall_rule",
  "registry_value",
  "share_exists",
  "hostname_equals",
  "note_matches",
  "cell_equals",
  "cell_formula_contains",
  "cell_style",
  "doc_contains",
  "doc_heading",
  "sheet_exists",
  "mail_sent",
  "mail_flagged",
] as const;

/** Required string fields per check kind — keeping authors honest. */
const REQUIRED_FIELDS: Record<string, string[]> = {
  file_exists: ["path"],
  file_absent: ["path"],
  file_contains: ["path", "pattern"],
  file_not_contains: ["path", "pattern"],
  file_mode: ["path", "mode"],
  file_owner: ["path"],
  dir_exists: ["path"],
  command_matched: ["pattern"],
  command_sequence: ["patterns"],
  service_state: ["name"],
  package_state: ["name"],
  user_exists: ["name"],
  user_in_group: ["name", "group"],
  user_detail: ["name", "field", "equals"],
  cron_matches: ["pattern"],
  firewall_rule: ["name"],
  registry_value: ["path", "name", "equals"],
  share_exists: ["name"],
  hostname_equals: ["value"],
  note_matches: ["pattern"],
  cell_equals: ["doc", "cell", "equals"],
  cell_formula_contains: ["doc", "cell", "pattern"],
  cell_style: ["doc", "cell"],
  doc_contains: ["doc", "pattern"],
  doc_heading: ["doc", "pattern"],
  sheet_exists: ["doc", "sheet"],
  mail_sent: ["to"],
  mail_flagged: ["subjectPattern"],
};

/**
 * Checks that need *at least one* of several fields rather than all of them.
 *
 * A `file_owner` check with neither `owner` nor `group` compares nothing, so it
 * passes for any file that happens to exist — never what the author meant. One
 * of the two must be present.
 */
const AT_LEAST_ONE_FIELDS: Record<string, string[]> = {
  file_owner: ["owner", "group"],
};

/** A field counts as missing when it is absent, null, blank or an empty list. */
function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

export function validateDefinition(raw: unknown, env: Record<string, string | undefined> = process.env): ValidationResult {
  const issues: ValidationIssue[] = [];
  const parsed = DEFINITION_ENVELOPE.safeParse(raw);
  const sandbox = sandboxAvailability(sandboxConfigFromEnv(env));

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        level: "error",
        field: issue.path.join(".") || undefined,
        message: issue.message,
      });
    }
    return { ok: false, issues, totalPoints: 0, fidelity: "simulated", sandbox };
  }

  const definition = parsed.data as unknown as ScenarioDefinition;
  // Walk the checks as loose records so a malformed field produces a helpful
  // message instead of a TypeScript error.
  const rawChecks = parsed.data.checks as Record<string, unknown>[];
  const seenIds = new Set<string>();

  // Boot the scenario once.  This powers both the platform-default awareness in
  // the checks below and the dry run at the end.
  let booted: EngineState | null = null;
  try {
    booted = createInitialState(definition);
  } catch (error) {
    issues.push({
      level: "error",
      field: "definition",
      message: `The scenario could not be booted: ${(error as Error).message}`,
    });
  }

  if (definition.engine !== expectedEngine(definition.platform)) {
    issues.push({
      level: "error",
      field: "engine",
      message: `The ${definition.platform} platform expects the "${expectedEngine(definition.platform)}" engine, but "${definition.engine}" was given.`,
    });
  }

  // Only the Windows scenarios have a graphical desktop to show. Catching this
  // here stops an author publishing a scenario that would silently fall back to
  // the console on a platform whose desktop does not exist.
  if (definition.surface === "desktop" && definition.platform !== "WINDOWS") {
    issues.push({
      level: "error",
      field: "surface",
      message: `The ${definition.platform} platform has no desktop surface — remove \`surface\` or set it to "console".`,
    });
  }

  // Fidelity (v1.2). Only bash has an honest sandbox in this release, and a deployment with
  // no sandbox at all cannot offer a container-fidelity scenario — which is a warning here
  // rather than an error, because the definition itself is perfectly valid: it is this
  // deployment, not the scenario, that cannot run it yet.
  const fidelity = normalizeFidelity(definition.fidelity);
  if (fidelity === "container") {
    if (definition.engine !== "bash") {
      issues.push({
        level: "error",
        field: "fidelity",
        message: `Container fidelity is only available for the "bash" engine in this release, and this scenario uses "${definition.engine}". Set fidelity to "simulated" or author it as a Linux scenario.`,
      });
    } else if (!satisfiesFidelity(fidelity, sandbox)) {
      issues.push({
        level: "warning",
        field: "fidelity",
        message: `${sandbox.reason} The scenario saves fine, but it will not be offered to students here.`,
      });
    }
  }

  // Scenario translations (v1.1). Nothing here is fatal — an overlay only ever replaces text,
  // so a wrong one can mislead a reader but cannot change what the grader grades. Each problem
  // therefore becomes a warning naming the locale, in the same voice the rest of this file uses.
  for (const coverage of overlayCoverage(definition)) {
    for (const problem of coverage.problems) {
      issues.push({ level: "warning", field: `i18n.${coverage.locale}`, message: problem });
    }
  }

  rawChecks.forEach((check, index) => {
    const id = typeof check.id === "string" && check.id.length > 0 ? check.id : undefined;
    if (!id) {
      issues.push({ level: "error", field: `checks[${index}]`, message: "Every check needs a unique `id`." });
    } else if (seenIds.has(id)) {
      issues.push({ level: "error", field: id, message: `Duplicate check id "${id}".` });
    } else {
      seenIds.add(id);
    }

    if (isBlank(check.label) || typeof check.label !== "string") {
      issues.push({ level: "error", field: id ?? `checks[${index}]`, message: "Every check needs a human-readable `label`." });
    }

    const kind = String(check.kind ?? "");
    if (!CHECK_KINDS.includes(kind as (typeof CHECK_KINDS)[number])) {
      issues.push({
        level: "error",
        field: id ?? `checks[${index}]`,
        message: `Unknown check kind "${kind}". See the scenario authoring guide for the full list.`,
      });
      return;
    }

    for (const field of REQUIRED_FIELDS[kind] ?? []) {
      if (isBlank(check[field])) {
        issues.push({ level: "error", field: id ?? `checks[${index}]`, message: `"${kind}" checks need the \`${field}\` field.` });
      }
    }

    const alternatives = AT_LEAST_ONE_FIELDS[kind];
    if (alternatives && alternatives.every((field) => isBlank(check[field]))) {
      issues.push({
        level: "error",
        field: id ?? `checks[${index}]`,
        message: `"${kind}" checks need at least one of ${alternatives
          .map((field) => `\`${field}\``)
          .join(" or ")} — otherwise the check passes for any file that exists.`,
      });
    }

    if (typeof check.points === "number" && (!Number.isInteger(check.points) || check.points < 0)) {
      issues.push({ level: "error", field: id ?? `checks[${index}]`, message: "`points` must be a whole number of 0 or more." });
    }

    for (const patternField of ["pattern", "subjectPattern", "bodyPattern", "flags"]) {
      const value = check[patternField];
      if (patternField === "flags" || typeof value !== "string") continue;
      try {
        new RegExp(value);
      } catch {
        issues.push({
          level: "error",
          field: id ?? `checks[${index}]`,
          message: `\`${patternField}\` is not a valid regular expression: ${value}`,
        });
      }
    }

    if (kind.startsWith("cell_") || kind.startsWith("doc_") || kind === "sheet_exists") {
      const docName = String(check.doc ?? "");
      const known = (definition.docs ?? []).some(
        (doc) => String((doc as { name?: string }).name ?? "").toLowerCase() === docName.toLowerCase(),
      );
      if (!known) {
        issues.push({
          level: "warning",
          field: id ?? `checks[${index}]`,
          message: `Check references document "${docName}", which is not defined in \`docs\`.`,
        });
      }
    }

    if (kind === "service_state") {
      const name = String(check.name ?? "");
      const declared = (definition.state?.services ?? []).some(
        (service) => service.name.toLowerCase() === name.toLowerCase(),
      );
      // A service that the platform ships with by default is perfectly fine to
      // check for; only a genuinely unknown unit is worth a warning.
      const fromDefaults = (booted?.machine.services ?? []).some(
        (service) => service.name.toLowerCase() === name.toLowerCase(),
      );
      if (!declared && !fromDefaults) {
        issues.push({
          level: "warning",
          field: id ?? `checks[${index}]`,
          message: `No service called "${name}" exists on this platform, so this check can never pass.`,
        });
      }
    }
  });

  const hintIds = new Set<string>();
  for (const hint of definition.hints ?? []) {
    if (hintIds.has(hint.id)) {
      issues.push({ level: "error", field: hint.id, message: `Duplicate hint id "${hint.id}".` });
    }
    hintIds.add(hint.id);
  }

  const totalPoints = definition.checks.reduce((sum, check) => sum + (typeof check.points === "number" ? check.points : 1), 0);

  // ---- Dry run ----------------------------------------------------------
  if (booted && !issues.some((issue) => issue.level === "error")) {
    try {
      const state = booted;
      // The dry run always uses the simulated driver. It is a shape check on the checks
      // themselves, not a rehearsal of the student's session: a warning that says "this check
      // already passes" means the same thing in either engine, and running it here would make
      // saving a scenario depend on a container being available.
      const driver = createDriver(definition.engine as EngineId, { user: definition.machine.user });
      driver.boot?.(state);
      const report = gradeAttempt(definition, state, 0);
      const alreadyPassing = report.results.filter((result) => result.passed);
      for (const result of alreadyPassing) {
        issues.push({
          level: "warning",
          field: result.checkId,
          message: `This check already passes before the student does anything: ${result.detail}`,
        });
      }
      if (report.maxScore === 0) {
        issues.push({ level: "warning", field: "checks", message: "The scenario is worth zero points." });
      }
    } catch (error) {
      issues.push({
        level: "error",
        field: "definition",
        message: `The scenario could not be dry-run against a fresh machine: ${(error as Error).message}`,
      });
    }
  }

  if (fidelity === "container" && definition.engine === "bash") {
    issues.push({
      level: "warning",
      field: "fidelity",
      message: `This scenario is authored for ${fidelityLabel(fidelity)} fidelity; the validation dry run above ran in the simulated engine.`,
    });
  }

  return {
    ok: !issues.some((issue) => issue.level === "error"),
    definition,
    issues,
    totalPoints,
    fidelity,
    sandbox,
  };
}

export function expectedEngine(platform: Platform): EngineId {
  if (platform === "WINDOWS") return "powershell";
  if (platform === "OFFICE") return "office";
  return "bash";
}

export function isCheckKind(value: string): value is ScenarioCheck["kind"] {
  return CHECK_KINDS.includes(value as (typeof CHECK_KINDS)[number]);
}
