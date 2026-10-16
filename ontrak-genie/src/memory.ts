/**
 * The project's memory: what this workspace has learned, kept with the code.
 *
 * A chat is forgotten when it ends, and everything an agent works out — how this
 * project is built, what broke last time, the convention nobody wrote down — is
 * the part worth keeping. So the memory is a **file in the workspace**
 * (`MEMORY.md`), and that choice does the work:
 *
 *   * it is *visible*: it appears in the file tree, in diffs, and in the change
 *     list, so it can be read by a person and corrected by them;
 *   * it is *committed*: memory that ships with the code is memory a team shares,
 *     reviews and revises, rather than a private notebook that goes stale;
 *   * it is *scoped like the work*: the file resolves inside the working
 *     directory, so the memory for `services/billing` is not the memory for the
 *     whole repository, and nothing leaks between projects.
 *
 * WHAT IS INJECTED, AND WHAT IS NOT
 * ---------------------------------
 * The prompt gets the *contents* of the file at the top of every turn, because
 * that is the whole point — the agent should not have to be told to go and read
 * it. The prompt does **not** get the write path: writing happens through a tool
 * (`remember`), which means it passes the same gate, produces the same diff and
 * lands in the same history as any other change. Memory is a file the agent edits,
 * not a side channel it talks into.
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";

import { buildFileDiff, type FileDiff } from "./diff.js";
import { saveSnapshot } from "./snapshots.js";
import { readTextFile, resolveInWorkspace, toRel, writeTextFile } from "./workspace.js";

export const MEMORY_FILE = "MEMORY.md";

/** The default section a remembered fact lands in when nobody names one. */
export const DEFAULT_SECTION = "Notes";

/** How much of the file is injected into a prompt. */
export const MEMORY_INJECT_LIMIT = 8_000;

const HEADER = `# Project memory

What this project has learned, written down so a later session starts where the
last one finished. The agent keeps this current with the \`remember\` tool; anyone
may edit it by hand, and it is meant to be committed with the code.
`;

/** The absolute path of the memory file for the working directory. */
export function memoryPath(): string {
  return resolveInWorkspace(MEMORY_FILE);
}

/** The memory as it stands, or `""` when there is none. Never throws. */
export async function readMemory(): Promise<string> {
  try {
    const { content } = await readTextFile(memoryPath());
    return content;
  } catch {
    return "";
  }
}

/**
 * The same, synchronously.
 *
 * The prompt is assembled on the request path and a missing memory file is the
 * normal case, so this is one `readFileSync` that returns `""` rather than a
 * promise rearranging a function that has nothing else async about it.
 */
export function readMemorySync(): string {
  try {
    return fsSync.readFileSync(memoryPath(), "utf8");
  } catch {
    return "";
  }
}

export interface RememberInput {
  /** The fact, in the agent's own words. */
  entry: string;
  /** Which heading it belongs under. Defaults to "Notes". */
  section?: string;
  /** Injectable clock, so a test asserts on a stable string. */
  at?: Date;
}

/**
 * The new contents of the memory file.
 *
 * Pure, because the interesting behaviour is all here: where a heading goes when
 * the file already has one (the end of its section, not the end of the file), what
 * happens when it does not (the section is created), and what a repeated entry
 * looks like (kept — the date is part of the note, and "this again" is
 * information). Entries are newest-last inside their section, so the file reads
 * like a record rather than a stack.
 */
export function appendMemory(existing: string, input: RememberInput): string {
  const section = (input.section ?? "").trim() === "" ? DEFAULT_SECTION : (input.section ?? "").trim();
  const stamp = (input.at ?? new Date()).toISOString().slice(0, 10);
  const entry = input.entry.trim();
  if (entry === "") throw new Error("nothing to remember");
  const bullet = `- ${stamp}: ${entry.replace(/\r?\n/g, " ")}`;

  const base = existing.trim() === "" ? `${HEADER}\n` : existing.replace(/\s+$/, "");
  const lines = base.split(/\r?\n/);
  const heading = `## ${section}`;
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());

  if (start === -1) {
    return `${lines.join("\n")}\n\n${heading}\n\n${bullet}\n`;
  }

  // The end of that section: the next heading of the same rank, or the end.
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  while (end > start + 1 && (lines[end - 1] ?? "").trim() === "") end -= 1;
  const updated = [...lines.slice(0, end), bullet, ...lines.slice(end)];
  return `${updated.join("\n").replace(/\s+$/, "")}\n`;
}

export interface RememberOutcome {
  /** The memory file's path, relative to the workspace. */
  rel: string;
  /** True when the file did not exist before. */
  created: boolean;
  section: string;
  content: string;
  diff: FileDiff;
  bytes: number;
}

/** Append one entry to the project's memory, on disk. */
export async function remember(input: RememberInput): Promise<RememberOutcome> {
  const abs = memoryPath();
  const rel = toRel(abs);
  const before = await readMemory();
  const content = appendMemory(before, input);
  const created = before.trim() === "";
  const diff = buildFileDiff(rel, before, content);

  await saveSnapshot(rel, before).catch(() => {});
  const bytes = await writeTextFile(abs, content);
  return {
    rel,
    created,
    section: (input.section ?? "").trim() === "" ? DEFAULT_SECTION : (input.section ?? "").trim(),
    content,
    diff,
    bytes,
  };
}

/** The memory, bounded, for a prompt — with a note saying how to add to it. */
export function memoryForPrompt(memory: string): string {
  const trimmed = memory.trim();
  if (trimmed === "") {
    return [
      "Project memory: empty.",
      `This workspace has a ${MEMORY_FILE} that survives between chats and is committed with the code.`,
      "When you learn something durable about this project — a build step, a convention, a trap — record it with the `remember` tool.",
    ].join("\n");
  }
  const body =
    trimmed.length > MEMORY_INJECT_LIMIT
      ? `${trimmed.slice(0, MEMORY_INJECT_LIMIT)}\n... [memory truncated; read ${MEMORY_FILE} for the rest]`
      : trimmed;
  return [
    `Project memory (${MEMORY_FILE}) — what earlier sessions recorded about this project:`,
    "",
    body,
    "",
    "Add to it with the `remember` tool when you learn something durable.",
  ].join("\n");
}


