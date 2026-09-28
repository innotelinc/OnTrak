/**
 * The scenario catalog form, as pure functions.
 *
 * The JSON definition is the source of truth for the simulation (platform,
 * engine, briefing, checks); the surrounding form only carries catalog metadata.
 * Parsing that metadata here — the slug, the clamped time limit and pass mark,
 * the difficulty whitelist and the tags — keeps the clamps in one testable
 * place instead of buried in `saveScenario`.
 */

import type { Difficulty } from "@prisma/client";
import type { ScenarioDefinition } from "./sim/types";

export const DIFFICULTIES: readonly Difficulty[] = ["FOUNDATION", "INTERMEDIATE", "ADVANCED", "EXPERT"];

/** Bounds for a scenario's default time limit, in seconds (1 minute … 8 hours). */
export const MIN_TIME_LIMIT_SEC = 60;
export const MAX_TIME_LIMIT_SEC = 60 * 60 * 8;
export const DEFAULT_TIME_LIMIT_SEC = 1800;
export const DEFAULT_PASS_SCORE = 70;

/** Turn a title into a URL-safe slug: lower-case, dash-separated, max 60 chars. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Scenarios are a **shared staff catalog**: any instructor or administrator may
 * author, edit, publish and duplicate any scenario. Deletion is shared too,
 * with one guard: once students have attempted a scenario, only an
 * administrator may delete it, so recorded work is never thrown away by
 * accident.
 */
export function canDeleteScenario(role: string, attemptCount: number): boolean {
  if (role !== "ADMIN" && role !== "INSTRUCTOR") return false;
  return role === "ADMIN" || attemptCount === 0;
}

export interface ScenarioMeta {
  title: string;
  /** As typed, or derived from the title. The caller makes it unique. */
  slugBase: string;
  summary: string;
  description: string;
  difficulty: Difficulty;
  timeLimitSec: number;
  passScore: number;
  published: boolean;
  tags: string[];
  softwareIds: string[];
}

/**
 * Read the catalog fields of the scenario form, falling back to the definition
 * for the human-facing copy so an author never has to retype the objective.
 */
export function parseScenarioMeta(formData: FormData, definition: ScenarioDefinition): ScenarioMeta {
  const title =
    String(formData.get("title") ?? "").trim() || definition.objective.slice(0, 70) || "Untitled scenario";

  const difficulty = String(formData.get("difficulty") ?? "INTERMEDIATE") as Difficulty;

  const requestedLimit = Number(formData.get("timeLimitSec") ?? 0);
  const timeLimitSec = Math.min(
    MAX_TIME_LIMIT_SEC,
    Math.max(MIN_TIME_LIMIT_SEC, requestedLimit > 0 ? requestedLimit : DEFAULT_TIME_LIMIT_SEC),
  );

  const requestedPass = Number(formData.get("passScore") ?? DEFAULT_PASS_SCORE) || DEFAULT_PASS_SCORE;

  return {
    title,
    slugBase: String(formData.get("slug") ?? "").trim() || slugify(title),
    summary: String(formData.get("summary") ?? "").trim() || definition.objective.slice(0, 140),
    description: String(formData.get("description") ?? "").trim() || definition.brief,
    difficulty: DIFFICULTIES.includes(difficulty) ? difficulty : "INTERMEDIATE",
    timeLimitSec,
    passScore: Math.min(100, Math.max(0, requestedPass)),
    published: formData.get("published") === "on",
    tags: String(formData.get("tags") ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    softwareIds: formData.getAll("softwareIds").map(String).filter(Boolean),
  };
}
