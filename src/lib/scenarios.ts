import "server-only";

import type { Attempt, Prisma, Scenario } from "@prisma/client";
import { prisma } from "./db";
import { createInitialState } from "./sim/state";
import type { AttemptStatus } from "@prisma/client";
import type { EngineState, ScenarioDefinition } from "./sim/types";
import { scorePercent } from "./score-rules";

/** The relations every scenario view needs. */
export const SCENARIO_INCLUDE = {
  software: { include: { softwarePackage: true } },
  author: { select: { id: true, name: true, email: true } },
  assignments: {
    include: {
      cohort: { select: { id: true, name: true } },
      student: { select: { id: true, name: true } },
    },
  },
  _count: { select: { attempts: true, assignments: true } },
} satisfies Prisma.ScenarioInclude;

export type ScenarioWithRelations = Prisma.ScenarioGetPayload<{ include: typeof SCENARIO_INCLUDE }>;

export function toDefinition(scenario: Pick<Scenario, "definition">): ScenarioDefinition {
  return scenario.definition as unknown as ScenarioDefinition;
}

/** Cache-busting seed so a replayed attempt is byte-identical. */
export function newSeed(): string {
  return Math.random().toString(36).slice(2, 12);
}

export interface StartAttemptOptions {
  userId: string;
  scenarioId: string;
  assignmentId?: string | null;
  timeLimitSec: number;
}

/**
 * Create an in-progress attempt and build its opening engine state on the
 * server, so a student who never sends a single command still submits a
 * valid, gradeable snapshot.
 */
export async function createAttempt(scenario: ScenarioWithRelations, options: StartAttemptOptions) {
  const definition = toDefinition(scenario);
  const state = createInitialState(definition);
  const expiresAt = new Date(Date.now() + options.timeLimitSec * 1000);

  return prisma.attempt.create({
    data: {
      userId: options.userId,
      scenarioId: scenario.id,
      assignmentId: options.assignmentId ?? null,
      expiresAt,
      seed: newSeed(),
      maxScore: definition.checks.reduce((sum, check) => sum + (check.points ?? 1), 0),
      status: "IN_PROGRESS",
      snapshot: state as unknown as Prisma.InputJsonValue,
      events: { history: [], notes: [] },
    },
  });
}

/** Seconds left before the attempt expires (never negative). */
export function secondsRemaining(attempt: Pick<Attempt, "expiresAt" | "status">): number {
  if (attempt.status !== "IN_PROGRESS") return 0;
  return Math.max(0, Math.floor((attempt.expiresAt.getTime() - Date.now()) / 1000));
}

export function isExpired(attempt: Pick<Attempt, "expiresAt" | "status">): boolean {
  return attempt.status === "IN_PROGRESS" && attempt.expiresAt.getTime() <= Date.now();
}

/** Effective time limit for a scenario given an optional assignment override. */
export function effectiveTimeLimit(scenario: { timeLimitSec: number }, assignmentTimeLimit?: number | null): number {
  return assignmentTimeLimit && assignmentTimeLimit > 0 ? assignmentTimeLimit : scenario.timeLimitSec;
}

export interface AttemptSnapshot {
  state: EngineState;
  events: { history: { input: string; at: number }[]; notes: string[] };
}

/** Read the stored snapshot, tolerating old or partial payloads. */
export function readSnapshot(attempt: Pick<Attempt, "snapshot">, definition: ScenarioDefinition): EngineState {
  const stored = attempt.snapshot as unknown as EngineState | null;
  if (stored && stored.vfs && stored.machine) return stored;
  return createInitialState(definition);
}

/**
 * Sanitise a client-submitted state before trusting it.
 *
 * The browser is where the simulation runs, so its payload is the record of
 * work — but the scenario's own boot state fills any hole, and unbounded
 * arrays are trimmed so a malformed payload cannot bloat the database.
 */
export function coerceSubmittedState(raw: unknown, definition: ScenarioDefinition): EngineState {
  const fallback = createInitialState(definition);
  const candidate = raw as Partial<EngineState> | null;
  if (!candidate || typeof candidate !== "object" || !candidate.vfs || !candidate.machine) {
    return fallback;
  }

  return {
    vfs: candidate.vfs,
    machine: {
      ...fallback.machine,
      ...candidate.machine,
      history: Array.isArray(candidate.machine.history) ? candidate.machine.history.slice(-2000) : [],
      notes: Array.isArray(candidate.machine.notes) ? candidate.machine.notes.slice(0, 500) : [],
      notices: [],
    },
    office: candidate.office ?? fallback.office,
    meta: {
      hintsUsed: Array.isArray(candidate.meta?.hintsUsed) ? candidate.meta.hintsUsed.slice(0, 50) : [],
      revision: Number(candidate.meta?.revision ?? 0),
    },
  };
}

export const ATTEMPT_STATUS_LABELS: Record<AttemptStatus, string> = {
  IN_PROGRESS: "In progress",
  SUBMITTED: "Submitted",
  GRADED: "Graded",
  EXPIRED: "Expired",
  ABANDONED: "Abandoned",
};

/**
 * Percentage of the maximum, safe when the scenario is worth zero.
 *
 * The rule itself is shared with the certificate, the webhook and the CSV
 * (`score-rules.ts`); this stays as the app's name for it, next to the rest of the
 * attempt helpers.
 */
export function attemptPercent(attempt: Pick<Attempt, "score" | "maxScore">): number {
  return scorePercent(attempt.score, attempt.maxScore);
}

/**
 * Mark any of this user's overdue attempts as expired.  Called from the
 * student dashboard so the UI reflects reality even if the tab was closed.
 */
export async function sweepExpiredAttempts(userId?: string): Promise<number> {
  const result = await prisma.attempt.updateMany({
    where: {
      status: "IN_PROGRESS",
      expiresAt: { lte: new Date() },
      ...(userId ? { userId } : {}),
    },
    data: { status: "EXPIRED", submittedAt: new Date() },
  });
  return result.count;
}
