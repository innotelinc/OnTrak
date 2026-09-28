/**
 * Playbook rules (M3): the checklist an incident runs to, and the state machine
 * for its steps.
 *
 * A playbook is not a workflow engine. It is the short list of things that must
 * happen for an incident to be handled properly — declare it, notify, assess the
 * blast radius, contain, preserve evidence, eradicate, restore, review — with
 * each step owned at a moment in the lifecycle.
 *
 * Two deliberate properties:
 *
 *  - **Steps are planned from severity, not from zero.** A `SEV1` gets the
 *    stakeholder-comms step; a `SEV4` does not need a war room. `planPlaybook`
 *    returns only the steps that apply.
 *  - **A step is `DONE`, `SKIPPED` or `PENDING`, and skipping is loud.** A
 *    skipped step is a decision somebody made, so it stays visible and can be
 *    reopened; finishing a step marks *when* and *who*, because the timeline is
 *    the evidence.
 *
 * Pure: no store, no clock. A service persists the plan and the transitions.
 */

import { atLeastAsSevere, type IncidentPhase, type IncidentSeverity } from "./incident-rules";

export interface PlaybookStepTemplate {
  /** Stable key, unique within a playbook; used for the idempotency of a step. */
  key: string;
  title: string;
  description: string;
  /** The lifecycle phase the step belongs to, so the plan reads in order. */
  phase: IncidentPhase;
  /** Only planned for incidents at least this severe. */
  minSeverity?: IncidentSeverity;
}

/**
 * The default incident playbook. `preserve` sits beside `contain` on purpose:
 * evidence decays fast, and the moment to collect it is during containment, not
 * after the review has started.
 */
export const DEFAULT_INCIDENT_PLAYBOOK: readonly PlaybookStepTemplate[] = [
  {
    key: "declare",
    title: "Declare and set the severity",
    description: "Record the incident with its impact and urgency, and confirm the severity the matrix gives it.",
    phase: "DETECTED",
  },
  {
    key: "notify",
    title: "Notify the commander and on-call",
    description: "Wake whoever owns the response, and tell the desk the incident exists.",
    phase: "DETECTED",
  },
  {
    key: "assess",
    title: "Assess the blast radius",
    description: "What is affected, who is affected, and what else could be reached from here.",
    phase: "TRIAGED",
  },
  {
    key: "comms",
    title: "Send the first stakeholder communication",
    description: "An initial holding statement, even before the cause is known.",
    phase: "TRIAGED",
    minSeverity: "SEV2",
  },
  {
    key: "contain",
    title: "Contain the impact",
    description: "Stop the spread: isolate, block, revoke, or take the affected service down.",
    phase: "CONTAINED",
  },
  {
    key: "preserve",
    title: "Preserve evidence",
    description: "Capture logs, snapshots and timelines before retention or reboots destroy them.",
    phase: "CONTAINED",
  },
  {
    key: "eradicate",
    title: "Remove the root cause",
    description: "Close the hole, patch, and rotate what was exposed.",
    phase: "ERADICATED",
  },
  {
    key: "restore",
    title: "Restore service and verify",
    description: "Bring the service back and confirm it is actually healthy, not merely up.",
    phase: "RECOVERED",
  },
  {
    key: "review",
    title: "Publish the post-incident review",
    description: "Timeline, decisions, what worked, and the tracked actions that follow.",
    phase: "REVIEWED",
  },
];

/** The steps that apply to an incident of this severity, in playbook order. */
export function planPlaybook(
  severity: IncidentSeverity,
  playbook: readonly PlaybookStepTemplate[] = DEFAULT_INCIDENT_PLAYBOOK,
): PlaybookStepTemplate[] {
  return playbook.filter((step) => (step.minSeverity ? atLeastAsSevere(severity, step.minSeverity) : true));
}

/* -------------------------------------------------------------------------- */
/*  Step status                                                               */
/* -------------------------------------------------------------------------- */

export type StepStatus = "PENDING" | "DONE" | "SKIPPED";
export const STEP_STATUSES: readonly StepStatus[] = ["PENDING", "DONE", "SKIPPED"];

export function isStepStatus(value: unknown): value is StepStatus {
  return typeof value === "string" && (STEP_STATUSES as readonly string[]).includes(value);
}

/**
 * Allowed transitions. A step can be finished, skipped, or reopened back to
 * pending — and only from pending can it change again, so a `DONE` step must be
 * deliberately reopened before it can be skipped or redone. That is what keeps
 * "who marked this done, and when" an answerable question.
 */
const STEP_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  PENDING: ["DONE", "SKIPPED"],
  DONE: ["PENDING"],
  SKIPPED: ["PENDING"],
};

export function canChangeStep(from: StepStatus, to: StepStatus): boolean {
  if (from === to) return false;
  return STEP_TRANSITIONS[from]?.includes(to) ?? false;
}

export type StepChangeResult = { ok: true; status: StepStatus } | { ok: false; reason: string };

export function changeStepStatus(from: StepStatus, to: StepStatus): StepChangeResult {
  if (from === to) return { ok: false, reason: `That step is already ${to.toLowerCase()}.` };
  if (!canChangeStep(from, to)) {
    return { ok: false, reason: `A ${from.toLowerCase()} step cannot move straight to ${to.toLowerCase()}; reopen it first.` };
  }
  return { ok: true, status: to };
}

/* -------------------------------------------------------------------------- */
/*  Progress                                                                  */
/* -------------------------------------------------------------------------- */

export interface PlaybookStepView {
  key: string;
  status: StepStatus;
}

export interface PlaybookProgress {
  total: number;
  done: number;
  skipped: number;
  pending: number;
  /** Done or skipped as a fraction of the plan (0–1). */
  percent: number;
  /** Whether every step has been dealt with, whichever way. */
  complete: boolean;
}

/** A roll-up for a page header or a progress bar. */
export function playbookProgress(steps: readonly PlaybookStepView[]): PlaybookProgress {
  const done = steps.filter((step) => step.status === "DONE").length;
  const skipped = steps.filter((step) => step.status === "SKIPPED").length;
  const pending = steps.length - done - skipped;
  return {
    total: steps.length,
    done,
    skipped,
    pending,
    percent: steps.length === 0 ? 1 : (done + skipped) / steps.length,
    complete: steps.length > 0 && pending === 0,
  };
}

/** The next step still to do, in plan order — what a responder should do next. */
export function nextStep<T extends PlaybookStepView>(steps: readonly T[]): T | null {
  return steps.find((step) => step.status === "PENDING") ?? null;
}
