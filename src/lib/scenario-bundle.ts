/**
 * Scenario bundles: one scenario as a file, with the grading contract intact.
 *
 * A catalog is a team's work, and a team that cannot move a scenario between
 * deployments keeps re-authoring the same exercise. A bundle is that unit: the
 * catalog metadata, the definition and nothing about the row it came from — no
 * slug, no author, no attempt counts, no publish flag. Those are facts about one
 * deployment, and importing them would either collide with a local address or
 * silently republish somebody's draft.
 *
 * Two rules keep the file honest:
 *
 *   * **The definition is the contract.** A bundle without a valid definition
 *     (and at least one check) is refused rather than imported as an empty
 *     exercise. `parseScenarioBundle` checks the shape; the caller still runs the
 *     full `validateDefinition` so the dry-run warnings are the same as an
 *     authored scenario's.
 *   * **A newer bundle is not guessed at.** `version` is an integer and this build
 *     understands version 1. A file from a later build is refused with the number
 *     it carried, because half-reading a format is how a scenario imports with
 *     checks missing.
 *
 * The module is pure: no Prisma, no filesystem, no Next imports. The action and
 * the export route use it, and the tests exercise it without either.
 */

import { slugify } from "./scenario-rules";

/** The envelope's discriminator, so a random JSON file is not mistaken for one. */
export const SCENARIO_BUNDLE_FORMAT = "ontrak.scenario-bundle";

/** The only format version this build writes or reads. */
export const SCENARIO_BUNDLE_VERSION = 1;

/** A bundle bigger than this is not a scenario; refuse before parsing it. */
export const MAX_BUNDLE_BYTES = 1_000_000;

const PLATFORMS = ["LINUX", "WINDOWS", "OFFICE"] as const;
const ENGINES = ["bash", "powershell", "office"] as const;
const DIFFICULTIES = ["FOUNDATION", "INTERMEDIATE", "ADVANCED", "EXPERT"] as const;

export interface ScenarioBundleScenario {
  title: string;
  summary: string;
  description: string;
  platform: string;
  engine: string;
  difficulty: string;
  timeLimitSec: number;
  passScore: number;
  tags: string[];
  definition: Record<string, unknown>;
}

export interface ScenarioBundle {
  format: typeof SCENARIO_BUNDLE_FORMAT;
  version: number;
  exportedAt: string;
  scenario: ScenarioBundleScenario;
}

/** The row fields a bundle reads. Deliberately no id, slug, author or published flag. */
export interface BundleSource {
  title: string;
  summary: string;
  description: string;
  platform: string;
  engine: string;
  difficulty: string;
  timeLimitSec: number;
  passScore: number;
  tags: string[];
  definition: unknown;
}

export type BundleParse =
  | { ok: true; bundle: ScenarioBundle }
  | { ok: false; error: string };

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integerInRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  field: string,
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, value: fallback };
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    return { ok: false, error: `${field} must be a whole number from ${min} to ${max}.` };
  }
  return { ok: true, value: number };
}

/** What this deployment would write for a scenario, as a plain object. */
export function exportScenarioBundle(row: BundleSource, now = new Date()): ScenarioBundle {
  return {
    format: SCENARIO_BUNDLE_FORMAT,
    version: SCENARIO_BUNDLE_VERSION,
    exportedAt: now.toISOString(),
    scenario: {
      title: row.title,
      summary: row.summary,
      description: row.description,
      platform: row.platform,
      engine: row.engine,
      difficulty: row.difficulty,
      timeLimitSec: row.timeLimitSec,
      passScore: row.passScore,
      tags: [...row.tags],
      definition: copy(row.definition) as Record<string, unknown>,
    },
  };
}

/**
 * Read and normalise a bundle.
 *
 * `raw` is either parsed JSON or the file's text. Every refusal names the field
 * that is wrong, because the person holding the file is usually not the person
 * who wrote it.
 */
export function parseScenarioBundle(raw: unknown): BundleParse {
  let value = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_BUNDLE_BYTES) {
      return { ok: false, error: `That file is larger than ${MAX_BUNDLE_BYTES} bytes.` };
    }
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return { ok: false, error: `That file is not valid JSON: ${(error as Error).message}` };
    }
  }

  const outer = asRecord(value);
  if (!outer) return { ok: false, error: "A bundle is a JSON object." };
  if (outer.format !== SCENARIO_BUNDLE_FORMAT) {
    return { ok: false, error: "That file is not an OnTrak scenario bundle." };
  }

  const version = typeof outer.version === "number" ? outer.version : Number(outer.version);
  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, error: "The bundle has no usable version." };
  }
  if (version > SCENARIO_BUNDLE_VERSION) {
    return {
      ok: false,
      error: `This bundle was written by a newer OnTrak (bundle version ${version}; this build reads ${SCENARIO_BUNDLE_VERSION}).`,
    };
  }

  const inner = asRecord(outer.scenario);
  if (!inner) return { ok: false, error: "The bundle has no scenario." };

  const title = text(inner.title);
  if (!title) return { ok: false, error: "The scenario has no title." };
  if (title.length > 160) return { ok: false, error: "The scenario title is longer than 160 characters." };

  const definition = asRecord(inner.definition);
  if (!definition) return { ok: false, error: "The scenario has no definition object." };
  const checks = definition.checks;
  if (!Array.isArray(checks) || checks.length === 0) {
    return { ok: false, error: "The definition has no checks, so it cannot grade anybody." };
  }

  const platform = text(inner.platform).toUpperCase();
  const engine = text(inner.engine).toLowerCase();
  if (!PLATFORMS.includes(platform as (typeof PLATFORMS)[number])) {
    return { ok: false, error: `The platform must be one of ${PLATFORMS.join(", ")}.` };
  }
  if (!ENGINES.includes(engine as (typeof ENGINES)[number])) {
    return { ok: false, error: `The engine must be one of ${ENGINES.join(", ")}.` };
  }
  const definitionPlatform = text(definition.platform).toUpperCase();
  const definitionEngine = text(definition.engine).toLowerCase();
  if (definitionPlatform && definitionPlatform !== platform) {
    return { ok: false, error: `The envelope says ${platform} but the definition says ${definitionPlatform}.` };
  }
  if (definitionEngine && definitionEngine !== engine) {
    return { ok: false, error: `The envelope says ${engine} but the definition says ${definitionEngine}.` };
  }

  const difficulty = text(inner.difficulty).toUpperCase() || "INTERMEDIATE";
  if (!DIFFICULTIES.includes(difficulty as (typeof DIFFICULTIES)[number])) {
    return { ok: false, error: `The difficulty must be one of ${DIFFICULTIES.join(", ")}.` };
  }

  const time = integerInRange(inner.timeLimitSec, 1800, 60, 60 * 60 * 8, "The time limit");
  if (!time.ok) return time;
  const pass = integerInRange(inner.passScore, 70, 1, 100, "The pass mark");
  if (!pass.ok) return pass;

  const tags: string[] = [];
  if (inner.tags !== undefined && inner.tags !== null) {
    if (!Array.isArray(inner.tags) || inner.tags.some((tag) => typeof tag !== "string")) {
      return { ok: false, error: "Tags must be a list of strings." };
    }
    if (inner.tags.length > 20) return { ok: false, error: "A scenario carries at most 20 tags." };
    for (const tag of inner.tags) {
      const clean = (tag as string).trim();
      if (clean && !tags.includes(clean)) tags.push(clean);
    }
  }

  return {
    ok: true,
    bundle: {
      format: SCENARIO_BUNDLE_FORMAT,
      version,
      exportedAt: typeof outer.exportedAt === "string" ? outer.exportedAt : "",
      scenario: {
        title,
        summary: text(inner.summary),
        description: text(inner.description),
        platform,
        engine,
        difficulty,
        timeLimitSec: time.value,
        passScore: pass.value,
        tags,
        definition: copy(definition),
      },
    },
  };
}

/** A download name that survives every filesystem, derived from the title. */
export function bundleFilename(title: string): string {
  return `${slugify(title) || "scenario"}.ontrak-scenario.json`;
}
