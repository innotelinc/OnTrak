/**
 * Accepting a practice scenario drafted by the desk.
 *
 * When OnTrak Tix resolves a ticket it writes the knowledgebase article and hands
 * the same experience here as a *draft*: objectives and steps for a learner, which
 * an instructor turns into a graded scenario. This is the door that accepts it.
 *
 * WHY THE SHAPE IS RE-VALIDATED HERE
 * The desk already validated the draft it authored. This end does not trust that —
 * not because the desk is suspect, but because a request arriving over HTTP is only
 * as trustworthy as the token in front of it, and the two products are deployed and
 * upgraded independently. The rules are the same ones the desk applies (lengths,
 * three engines, at least one step), restated here so this end can refuse a body
 * that is wrong without needing the desk's code to be the same version.
 *
 * The token comparison is deliberately length-independent: a comparison that returns
 * early on the first wrong byte leaks the secret's prefix to anybody who can time
 * the response, and this endpoint is reachable from another container.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const ITS_SERVICE_TOKEN_ENV = "ONTRAK_ITS_SERVICE_TOKEN";

export const ITS_ENGINES = ["bash", "powershell", "office"] as const;
export const ITS_DIFFICULTIES = ["FOUNDATION", "INTERMEDIATE", "ADVANCED"] as const;
export type ItsEngine = (typeof ITS_ENGINES)[number];
export type ItsDifficulty = (typeof ITS_DIFFICULTIES)[number];

export const MAX_TITLE = 160;
export const MAX_SUMMARY = 240;
export const MAX_DESCRIPTION = 8_000;
export const MAX_OBJECTIVES = 12;
export const MAX_STEPS = 12;
export const MAX_ACTIONS = 12;
export const MAX_TAGS = 12;

export interface ItsStep {
  objective: string;
  actions: string[];
  check: string;
}

export interface ItsScenarioDraft {
  sourceRef: string;
  source: string;
  title: string;
  summary: string;
  description: string;
  engine: ItsEngine;
  difficulty: ItsDifficulty;
  objectives: string[];
  steps: ItsStep[];
  tags: string[];
}

export type ItsDraftResult = { ok: true; value: ItsScenarioDraft } | { ok: false; reason: string };

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function strList(value: unknown, max: number, each = 400): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim().slice(0, each))
    .slice(0, max);
}

/**
 * Read a draft off the wire, or say why it is not one.
 *
 * A draft with no steps is refused outright rather than stored: an instructor cannot
 * turn "no steps" into a scenario, so accepting it would only add a row that sits in
 * the queue forever looking like work.
 */
export function readScenarioDraft(body: unknown): ItsDraftResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "the body was not an object" };
  }
  const input = body as Record<string, unknown>;

  const sourceRef = str(input.ticketRef, 60) ?? str(input.sourceRef, 60);
  if (!sourceRef) return { ok: false, reason: "the draft did not name the ticket it came from" };

  const title = str(input.title, MAX_TITLE);
  const summary = str(input.summary, MAX_SUMMARY);
  if (!title || !summary) return { ok: false, reason: "the draft had no title or summary" };

  const engine = ITS_ENGINES.includes(input.engine as ItsEngine) ? (input.engine as ItsEngine) : null;
  if (!engine) return { ok: false, reason: `engine must be one of ${ITS_ENGINES.join(", ")}` };

  const steps: ItsStep[] = Array.isArray(input.steps)
    ? (input.steps as unknown[])
        .map((entry) => {
          if (entry === null || typeof entry !== "object") return null;
          const step = entry as Record<string, unknown>;
          const objective = str(step.objective, 400);
          const actions = strList(step.actions, MAX_ACTIONS);
          if (!objective || actions.length === 0) return null;
          return { objective, actions, check: str(step.check, 400) ?? "" };
        })
        .filter((step): step is ItsStep => step !== null)
        .slice(0, MAX_STEPS)
    : [];
  if (steps.length === 0) return { ok: false, reason: "the draft had no usable steps" };

  return {
    ok: true,
    value: {
      sourceRef: sourceRef.slice(0, 60),
      source: str(input.source, 20) ?? "tix",
      title,
      summary,
      description: str(input.description, MAX_DESCRIPTION) ?? summary,
      engine,
      difficulty: ITS_DIFFICULTIES.includes(input.difficulty as ItsDifficulty)
        ? (input.difficulty as ItsDifficulty)
        : "INTERMEDIATE",
      objectives: strList(input.objectives, MAX_OBJECTIVES),
      steps,
      tags: strList(input.tags, MAX_TAGS, 60),
    },
  };
}

/**
 * Whether a presented token is the configured one.
 *
 * Both sides are hashed first, so the comparison is over two fixed-length digests:
 * timing cannot reveal how much of the secret was right, and a shorter guess is not
 * a different-length buffer that `timingSafeEqual` would refuse.
 */
export function serviceTokenMatches(presented: string | null, expected: string | null): boolean {
  if (!presented || !expected) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The bearer token on a request, if there is one. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
