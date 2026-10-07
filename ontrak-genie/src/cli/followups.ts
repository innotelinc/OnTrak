/**
 * What to offer next.
 *
 * A coding agent's turn usually ends with a question hanging in the air: the
 * file is changed, so do you want it tested, reviewed, or committed? The
 * console leaves that to you; the CLI names the three things that follow from
 * what just happened, so the common next step is a keystroke rather than a
 * sentence.
 *
 * The suggestions are **derived from the turn itself** — which tools ran, which
 * files moved, whether anything failed — and not from a second model call. That
 * is a deliberate trade: a model could offer a smarter sentence, but it would
 * also cost a request, delay the prompt, and be able to invent work that the
 * turn did not do. The reducer below only ever suggests something the events
 * prove happened.
 */

import type { AgentEvent } from "../agent.js";

export interface TurnSummary {
  /** Paths a tool changed, in the order they were touched, deduplicated. */
  filesChanged: string[];
  /** Commands the agent ran (the interpreted argument, not the raw JSON). */
  commands: string[];
  /** One-line failures, so a follow-up can point at one. */
  errors: string[];
  steps: number;
  approved: number;
  denied: number;
  /** Whether the assistant produced prose at all. */
  spoke: boolean;
  /** Paths the agent only read, which hints that a review is the next step. */
  filesRead: string[];
}

export function emptyTurnSummary(): TurnSummary {
  return {
    filesChanged: [],
    commands: [],
    errors: [],
    steps: 0,
    approved: 0,
    denied: 0,
    spoke: false,
    filesRead: [],
  };
}

function stringArg(args: unknown, ...keys: string[]): string | null {
  if (typeof args !== "object" || args === null) return null;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function pushUnique(list: string[], value: string): void {
  if (value !== "" && !list.includes(value)) list.push(value);
}

/** Fold one event into the running summary. */
export function reduceTurn(summary: TurnSummary, event: AgentEvent): TurnSummary {
  switch (event.type) {
    case "text":
      if (event.text.trim() !== "") summary.spoke = true;
      return summary;
    case "step":
      summary.steps = Math.max(summary.steps, event.index);
      return summary;
    case "tool_call": {
      const target = stringArg(event.args, "path");
      // The read-only tools are the ones `tools.ts` names; anything else that
      // takes a path is about to write it.
      const readOnly = event.name === "read_file" || event.name === "list_dir" || event.name === "search_code";
      if (target !== null) {
        if (readOnly) pushUnique(summary.filesRead, target);
        else pushUnique(summary.filesChanged, target);
      }
      const command = stringArg(event.args, "command");
      if (command !== null) pushUnique(summary.commands, command);
      return summary;
    }
    case "tool_result":
      // A result *with* a diff proves a write landed, whatever the tool was
      // called and however the arguments were shaped.
      if (event.diff) pushUnique(summary.filesChanged, event.diff.path);
      if (!event.ok) {
        const line = event.content.split("\n").find((part) => part.trim() !== "")?.trim() ?? "failed";
        pushUnique(summary.errors, line.length > 160 ? `${line.slice(0, 157)}…` : line);
      }
      return summary;
    case "approval_result":
      if (event.decision === "approve") summary.approved += 1;
      else if (event.decision === "deny") summary.denied += 1;
      return summary;
    default:
      return summary;
  }
}

export function summarizeEvents(events: AgentEvent[]): TurnSummary {
  const summary = emptyTurnSummary();
  for (const event of events) reduceTurn(summary, event);
  return summary;
}

const MAX_SUGGESTIONS = 3;

/**
 * Up to three next steps, most specific first.
 *
 * Ordered by what is most likely to be wanted: a failure outranks a review,
 * because an unfixed failure makes everything after it moot, and a change made
 * is the thing most worth building on when nothing is broken.
 */
export function suggestFollowups(summary: TurnSummary): string[] {
  const out: string[] = [];
  const add = (value: string): void => {
    if (out.length < MAX_SUGGESTIONS && !out.includes(value)) out.push(value);
  };

  if (summary.errors.length > 0) {
    add(`Fix the failure: ${summary.errors[0]}`);
    add("Show me the full output of the last command");
  }

  const changed = summary.filesChanged;
  if (changed.length > 0) {
    add(changed.length === 1 ? `Review the change to ${changed[0]}` : `Review the ${changed.length} changed files`);
    add("Run the test suite for this workspace");
    add("Commit this change with a descriptive message");
  }

  if (summary.denied > 0) {
    add("Propose an alternative that does not need the denied action");
  }

  if (summary.commands.length > 0 && changed.length === 0 && summary.errors.length === 0) {
    add("Explain what the last command showed");
  }

  if (!summary.spoke && out.length === 0) {
    add("Summarize what you did in this turn");
  }

  if (out.length === 0) {
    add("Explain the approach and what you would do next");
    add("Keep going with the next logical step");
  }

  return out.slice(0, MAX_SUGGESTIONS);
}
