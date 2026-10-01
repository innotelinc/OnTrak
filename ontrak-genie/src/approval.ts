import fs from "node:fs";
import path from "node:path";

import { config, type ApprovalMode } from "./config.js";
import type { ToolPreview } from "./tools.js";
export type { ApprovalMode };

/**
 * Human-in-the-loop confirmation for the actions that can hurt.
 *
 * The agent has shell access and write access to the workspace, so a turn that
 * runs unattended can do real damage. When `AGENT_APPROVAL` is on, the agent
 * pauses mid-turn and someone has to answer before the tool runs.
 *
 * Two channels answer, deliberately: the browser card, which posts to
 * `POST /api/approvals/:id`, and a driver that is not watching a tab — a CLI or a
 * CI job — which lists with `GET /api/approvals` and answers the same route. Both
 * settle the same prompt and both are filed in `approvals.jsonl` with who
 * answered, so "unattended" means answered on purpose with a record, not answered
 * by nothing.
 *
 * The prompt is bound to the streaming request's AbortSignal, so closing the tab
 * or pressing Stop releases every pending prompt instead of leaving the turn
 * hanging until the timeout.
 */

export type ApprovalDecision = "approve" | "deny" | "timeout" | "aborted";

type Resolver = (decision: ApprovalDecision, actor: string) => void;

/**
 * A prompt waiting for an answer.
 *
 * The gate used to be a click and nothing else, so the only way to answer it was
 * to be watching the tab. A driver that is not watching — a CI job, a CLI — has
 * to be able to ask "what is waiting?" and answer it by id, deliberately and on
 * the record. This is that question's answer.
 */
export interface PendingApproval {
  id: string;
  /** The tool that is waiting, e.g. `run_command`. */
  name: string;
  /** The one-line description the browser card shows. */
  summary: string;
  /** When the prompt opened, ISO-8601. */
  requestedAt: string;
  /** When it answers itself if nobody does, ISO-8601. */
  expiresAt: string;
}

interface PendingEntry {
  info: PendingApproval;
  resolve: Resolver;
}

const pending = new Map<string, PendingEntry>();

/**
 * What a decision is, once it has been made.
 *
 * Enough to answer "who let this run?" later without the process that held the
 * prompt: the same fields as the prompt, plus the decision, who made it and when.
 */
export interface ApprovalRecord extends PendingApproval {
  decision: ApprovalDecision;
  /** Who answered: an OIDC identity, `shared-token`, `local`, or `system`. */
  actor: string;
  decidedAt: string;
}

/** The decision log, beside the sessions in the data directory. */
export const APPROVAL_LOG = "approvals.jsonl";

export function approvalLogPath(): string {
  return path.join(config.dataDir, APPROVAL_LOG);
}

/**
 * The policy, as a pure function so it can be exercised directly.
 *
 * "off"   never asks.
 * "risky" asks for every command, and for writes big enough to matter.
 * "all"   asks for anything that changes or executes.
 */
export function needsApproval(
  mode: ApprovalMode,
  name: string,
  preview: ToolPreview | null,
  maxLines: number,
): boolean {
  if (mode === "off") return false;
  // Reads are never worth interrupting for.
  if (preview === null && name !== "run_command") return false;
  if (mode === "all") return true;

  // "risky": every command, plus overwrites big enough to be worth a look.
  if (name === "run_command") return true;
  const diff = preview?.diff;
  if (!diff) return false;
  return diff.added + diff.removed > maxLines;
}

/** Does this call need a human click before it runs, given the current config? */
export function approvalRequired(name: string, preview: ToolPreview | null): boolean {
  return needsApproval(config.approval, name, preview, config.approvalMaxLines);
}

export function pendingApprovals(): number {
  return pending.size;
}

/** The prompts waiting now, oldest first — what a headless driver asks for. */
export function listPendingApprovals(): PendingApproval[] {
  return [...pending.values()]
    .map((entry) => entry.info)
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

/**
 * File one decision.
 *
 * Best-effort, like the ledger and the audit row: a decision that could not be
 * filed must never be the thing that stops the turn it was deciding. JSONL, so it
 * appends without reading and a person can `tail` or `grep` it without a tool.
 */
function recordApprovalDecision(
  info: PendingApproval,
  decision: ApprovalDecision,
  actor: string,
): void {
  const record: ApprovalRecord = { ...info, decision, actor, decidedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.appendFileSync(approvalLogPath(), `${JSON.stringify(record)}\n`);
  } catch {
    // Deliberately swallowed — see above.
  }
}

/** Wait for a decision. Resolves to "timeout" or "aborted" on its own. */
export function requestApproval(
  id: string,
  request: { name: string; summary: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<ApprovalDecision> {
  const timeoutMs = request.timeoutMs ?? config.approvalTimeoutMs;
  const openedAt = Date.now();
  const info: PendingApproval = {
    id,
    name: request.name,
    summary: request.summary,
    requestedAt: new Date(openedAt).toISOString(),
    expiresAt: new Date(openedAt + timeoutMs).toISOString(),
  };
  const signal = request.signal;

  return new Promise<ApprovalDecision>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (decision: ApprovalDecision, actor: string): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      pending.delete(id);
      recordApprovalDecision(info, decision, actor);
      resolve(decision);
    };

    function onAbort(): void {
      // Nobody decided; the caller went away. Recorded as such so the log does
      // not read as though a human said no.
      finish("aborted", "system");
    }

    if (signal?.aborted) {
      finish("aborted", "system");
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish("timeout", "system"), timeoutMs);
    pending.set(id, { info, resolve: finish });
  });
}

/**
 * Answer a prompt. Called by the HTTP layer, from the browser or a driver.
 *
 * `actor` names whoever answered, for the record: the browser passes the
 * signed-in identity, the CLI the bearer it holds. Defaulting it to "unknown"
 * rather than guessing keeps an unlabelled answer from looking like a person's.
 */
export function resolveApproval(
  id: string,
  decision: "approve" | "deny",
  actor = "unknown",
): boolean {
  const entry = pending.get(id);
  if (entry === undefined) return false;
  entry.resolve(decision, actor);
  return true;
}

/** Describe a non-approval so the model knows what happened and what not to do. */
export function denialReason(decision: ApprovalDecision): string {
  if (decision === "timeout") {
    return `Nobody answered the approval prompt within ${Math.round(config.approvalTimeoutMs / 1000)}s, so it was not run.`;
  }
  if (decision === "aborted") return "The request was cancelled before it was approved, so it was not run.";
  return "The user denied this action.";
}
