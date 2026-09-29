import { config, type ApprovalMode } from "./config.js";
import type { ToolPreview } from "./tools.js";
export type { ApprovalMode };

/**
 * Human-in-the-loop confirmation for the actions that can hurt.
 *
 * The agent has shell access and write access to the workspace, so a turn that
 * runs unattended can do real damage. When `AGENT_APPROVAL` is on, the agent
 * pauses mid-turn and the browser shows an approve/deny card; the decision comes
 * back through `POST /api/approvals/:id`, which is the only way to release it.
 *
 * The prompt is bound to the streaming request's AbortSignal, so closing the tab
 * or pressing Stop releases every pending prompt instead of leaving the turn
 * hanging until the timeout.
 */

export type ApprovalDecision = "approve" | "deny" | "timeout" | "aborted";

type Resolver = (decision: ApprovalDecision) => void;

const pending = new Map<string, Resolver>();

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

/** Wait for a decision. Resolves to "timeout" or "aborted" on its own. */
export function requestApproval(
  id: string,
  signal?: AbortSignal,
  timeoutMs: number = config.approvalTimeoutMs,
): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (decision: ApprovalDecision): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      pending.delete(id);
      resolve(decision);
    };

    function onAbort(): void {
      finish("aborted");
    }

    if (signal?.aborted) {
      finish("aborted");
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    pending.set(id, finish);
  });
}

/** Called by the HTTP layer when the browser answers a prompt. */
export function resolveApproval(id: string, decision: "approve" | "deny"): boolean {
  const finish = pending.get(id);
  if (finish === undefined) return false;
  finish(decision);
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
