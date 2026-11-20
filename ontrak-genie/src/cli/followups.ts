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
 * files moved, whether anything failed, and the question the reply ended on —
 * and not from a second model call. That is a deliberate trade: a model could
 * offer a smarter sentence, but it would also cost a request, delay the prompt,
 * and be able to invent work that the turn did not do. The reducer below only
 * ever suggests something the events prove happened.
 *
 * **The reply's own question comes first.** A turn that ends with "should this be
 * one board, or stacked boards?" has left the person one sentence to write, and
 * that sentence is one of the two choices — so the chips are the choices. A menu
 * that answers an either/or with "keep going" is asking the person to retype the
 * question back at the agent.
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
  /** The assistant's prose, kept to its tail — the closing question lives there. */
  said: string;
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
    said: "",
  };
}

/** Enough for the last few sentences of a turn, small enough to keep on every event. */
const SAID_LIMIT = 4000;

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
      if (event.text.trim() !== "") {
        summary.spoke = true;
        // Prose arrives as deltas, so a fragment on its own is not a sentence:
        // the tail of everything said is, and the closing question is at its end.
        summary.said = (summary.said + event.text).slice(-SAID_LIMIT);
      }
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
const MAX_CHIP = 120;

const TOOL_PREFIX = /^(?:read_file|list_dir|search_code|write_file|edit_file|run_command)\s*:\s*/i;
const LEADING_FRAME = /^(?:so|then|okay|ok|and|but|also|now|quick question|one more thing)[,:]\s+/i;
/**
 * The frame a question puts its choices in: "Should X mean A or B?", "Would you
 * rather have A or B?", "Do we use A or B?". Only the frame is stripped — what is
 * left is the two answers, which is what the person is being asked to pick from.
 * The subject is matched rather than enumerated because it is usually a name or a
 * quoted phrase ("Should “3D” mean …"), not a noun this file could list.
 */
const CHOICE_FRAME = new RegExp(
  "^(?:should|shall|would|could|can|do|does|is|are|will)\\s+" +
    "(?:(?:we|i|you|it|this|that|these|those|they)\\s+)?" +
    "(?:.{1,60}?\\s+)?" +
    "(?:mean|be|use|go with|choose|pick|prefer|treat|model|build|render|show|make|have|want|expect|do|call|name|label|read|say|word|phrase|count as|stand for|refer to)\\s+",
  "i",
);
/** A verb left over from the frame: "Should the file be called A or B?" → "called A". */
const LEFTOVER_VERB = /^(?:called|named|used|shown|rendered|modelled|modeled|treated|built|made|read|written|set|phrased|worded|labelled|labeled)\s+/i;
/** A frame that names the choice but wraps it: "Do you want the board to be 7×7 or 9×9?". */
const CHOICE_INFINITIVE = /^.{0,50}?\bto\s+(?:be|use|have|read|show|render|build|do|go with|look like)\s+/i;

function shorten(text: string, max = MAX_CHIP): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** One alternative, phrased as something a person would type back. */
function choice(text: string): string | null {
  const value = text
    .replace(/\s+/g, " ")
    .replace(/^[-–—*•]\s*/, "")
    .replace(/[.?!;,:\s]+$/, "")
    .trim();
  // A leftover question word means the frame was not stripped, and a chip that
  // still asks the question is the thing these chips exist instead of.
  if (value === "" || /^(?:should|whether|which|what|how|does|do|can)\b/i.test(value)) return null;
  return shorten(value.charAt(0).toUpperCase() + value.slice(1));
}

/**
 * The two answers to the question the turn ended on, when it was an either/or.
 *
 * "Should “3D” mean a single 7×7 board shown in perspective, or stacked 7×7 boards
 * where four cards can also connect across layers?" is a person being asked to
 * choose; the next thing they type is one of those two clauses. A yes/no question
 * returns null instead: the answer to it is the person's, and writing one on their
 * behalf would be inventing a decision the turn never made.
 */
export function questionChoices(said: string): [string, string] | null {
  const tail = said.replace(/\s+/g, " ").trim();
  const end = tail.lastIndexOf("?");
  if (end < 0) return null;
  // The sentence before the question, not the whole turn: a `-1` here means "no
  // previous sentence", which is the start of the string rather than index 1.
  const after = (needle: string): number => {
    const at = tail.lastIndexOf(needle, end);
    return at < 0 ? 0 : at + needle.length;
  };
  const start = Math.max(after(". "), after("? "), after("! "));
  const question = tail.slice(start, end).replace(LEADING_FRAME, "").trim();
  let framed = question.replace(CHOICE_FRAME, "");
  if (framed === question) return null;
  framed = framed.replace(LEFTOVER_VERB, "");

  // Two readings: with an infinitive frame in front of the choices removed
  // ("the board to be 7×7 or 9×9") first, because that is the reading that leaves
  // the two things being chosen between, then the frame as it stands.
  for (const candidate of [framed.replace(CHOICE_INFINITIVE, ""), framed]) {
    const split = Math.max(candidate.lastIndexOf(", or "), candidate.lastIndexOf(" or "));
    if (split < 0) continue;
    const left = choice(candidate.slice(0, split));
    const right = choice(candidate.slice(split).replace(/^\s*,?\s*or\s+/i, ""));
    if (left !== null && right !== null && left !== right) return [left, right];
  }
  return null;
}

/**
 * What failed, in terms a person can act on.
 *
 * The raw line is whatever the tool wrote, and it is not always a sentence: a
 * `list_dir` on a missing path reports a fragment, and "Fix the failure: . is
 * empty" names no work at all. When the line names nothing, the command or the
 * file it was about is the thing that does.
 */
function describeFailure(summary: TurnSummary): string {
  const line = (summary.errors[0] ?? "").replace(TOOL_PREFIX, "").replace(/\s+/g, " ").trim();
  if (line.replace(/[^\p{L}\p{N}]/gu, "").length < 4) {
    const command = summary.commands[summary.commands.length - 1];
    if (command !== undefined) return `${shorten(command)} failed`;
    if (summary.filesChanged.length > 0) return `${summary.filesChanged[0]} did not apply cleanly`;
    return "the last step failed";
  }
  return shorten(line);
}

/**
 * Up to three next steps, most specific first.
 *
 * Ordered by what the turn actually left open: a failure it could not fix, then
 * the choice it asked the person to make, then the work the change makes
 * possible. `task` is the request being answered, used only when the turn did
 * nothing and said nothing — there the request is the only thing to build on, so
 * the chip narrows it rather than gesturing past it.
 */
export function suggestFollowups(summary: TurnSummary, task?: string): string[] {
  const out: string[] = [];
  const add = (value: string): void => {
    if (out.length < MAX_SUGGESTIONS && value.trim() !== "" && !out.includes(value)) out.push(value);
  };

  if (summary.errors.length > 0) {
    add(`Fix the failure: ${describeFailure(summary)}`);
    const command = summary.commands[summary.commands.length - 1];
    // Only when a command ran: a chip about "the last command" on a turn that ran
    // none is advice about something that does not exist.
    if (command !== undefined) add(`Re-run ${shorten(command, 80)} and show the full output`);
  }

  // Until the question is answered, review and commit are not what happens next.
  const choices = questionChoices(summary.said);
  if (choices !== null) {
    add(choices[0]);
    add(choices[1]);
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
    add(`Explain what ${shorten(summary.commands[summary.commands.length - 1] ?? "the command", 70)} showed`);
  }

  // "Walk me through ." is not a sentence about anything: a `list_dir` of the
  // workspace root is not a file to explain.
  const read = summary.filesRead.find((path) => path.trim() !== "" && path.trim() !== ".");
  if (read !== undefined && out.length === 0) {
    add(`Walk me through ${read}`);
  }

  if (!summary.spoke && out.length === 0) {
    add("Summarize what you did in this turn");
  }

  if (out.length === 0) {
    const topic = task === undefined ? "" : shorten(task.replace(/[.?!]+$/, ""), 60);
    add(topic === ""
      ? "Point me at the file or folder to start from"
      : `Make the first change that “${topic}” needs`);
  }

  return out.slice(0, MAX_SUGGESTIONS);
}
