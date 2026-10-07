import fs from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

import {
  addEntry,
  changeSetSummary,
  hasEntries,
  sortEntriesForApply,
  type ChangeSet,
  type StagedEntry,
} from "./change-set.js";
import { config } from "./config.js";
import { saveSnapshot } from "./snapshots.js";
import { pathExists, readTextFile, resolveInWorkspace, writeTextFile } from "./workspace.js";

/**
 * The change set a reviewer commits — the state half of "propose then commit".
 *
 * When `AGENT_WRITE_MODE=propose`, the agent's file tools **stage** their writes
 * here instead of writing, and one review commits the whole set with a single
 * `POST /api/changes/apply`. That is the roadmap's "a reviewer approves a change
 * set rather than one write at a time".
 *
 * ONE PENDING SET PER PROCESS, AND WHY THAT IS HONEST
 * ---------------------------------------------------
 * The approval gate is per-prompt and short-lived; a change set is a *document* a
 * person reads, and reading it takes minutes. So there is one pending set at a
 * time, not a queue: staging while a set is already waiting adds to it, and a
 * second reviewer's turn is refused at the door (it is already reviewable). This
 * is deliberately the shape of a **single operator or a small team** in one
 * workspace, which is what v0.4's "beyond a single operator" is reaching for; a
 * per-account set is a later step, and pretending otherwise with a half-keyed map
 * would be the lie.
 *
 * EVERY DECISION IS FILED
 * -----------------------
 * Applying and discarding both append a `changes.jsonl` record — who, what paths,
 * how long the set waited. A change that was proposed and then quietly dropped is
 * exactly the thing a review is meant to surface, so it is a row rather than a
 * shrug. Best-effort, like the approval log and the ledger: a record that could not
 * be written must never stop the commit it is describing.
 */

/** The ledger, beside the sessions in the data directory. */
export const CHANGE_LOG = "changes.jsonl";

export function changeLogPath(): string {
  return path.join(config.dataDir, CHANGE_LOG);
}

/** The set waiting for a decision, or `null` when there is nothing to review. */
let pending: ChangeSet | null = null;

function newId(): string {
  return `cs_${randomBytes(8).toString("hex")}`;
}

/**
 * Stage a proposed write.
 *
 * Called from the file tools when propose mode is on, in place of the write. The
 * first entry opens the set; a later entry for a path replaces the earlier one (so
 * an agent correcting itself does not ask the reviewer to approve both).
 */
export function stageChange(entry: StagedEntry): ChangeSet {
  if (pending === null) {
    pending = { id: newId(), createdAt: new Date().toISOString(), entries: [] };
  }
  pending = { ...pending, entries: addEntry(pending.entries, entry) };
  return pending;
}

export function currentChangeSet(): ChangeSet | null {
  return pending;
}

/** Reset the in-process state. For tests, and for a deployment that wants a clean slate. */
export function resetChangeSets(): void {
  pending = null;
}

function recordLedger(record: Record<string, unknown>): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.appendFileSync(changeLogPath(), `${JSON.stringify(record)}\n`);
  } catch {
    // Deliberately swallowed — see the header.
  }
}

export interface ApplyResult {
  applied: number;
  paths: string[];
  /** The set that was applied, for the response body. */
  id: string;
}

export class ChangeSetError extends Error {}

/**
 * Write every staged entry, oldest path first, then close the set.
 *
 * A snapshot of each file's current contents is saved before it is overwritten, so
 * the diff viewer keeps the same history a direct write would have left. The paths
 * are resolved against the **applying** scope — the reviewer's own workspace — and
 * a path that escapes it is refused by `resolveInWorkspace`, the same fence every
 * tool call passes through.
 *
 * The set is cleared only after the last write succeeds. A failure partway through
 * leaves the set intact and names the path it stopped at, so a re-run retries the
 * whole set rather than half of it.
 */
export async function applyChangeSet(actor: string): Promise<ApplyResult> {
  if (!hasEntries(pending)) {
    throw new ChangeSetError("there is no proposed change set to apply");
  }
  const set = pending as ChangeSet;
  const entries = sortEntriesForApply(set.entries);
  const applied: string[] = [];

  for (const entry of entries) {
    const abs = resolveInWorkspace(entry.path);
    if (await pathExists(abs)) {
      try {
        const before = await readTextFile(abs);
        if (!before.truncated) await saveSnapshot(entry.path, before.content).catch(() => {});
      } catch {
        // A binary or unreadable predecessor is written over without a snapshot,
        // exactly as a direct write would have done.
      }
    }
    await writeTextFile(abs, entry.content);
    applied.push(entry.path);
  }

  pending = null;
  recordLedger({
    id: set.id,
    action: "applied",
    actor,
    paths: applied,
    proposedAt: set.createdAt,
    appliedAt: new Date().toISOString(),
  });
  return { applied: applied.length, paths: applied, id: set.id };
}

/** Drop the pending set without writing anything. Returns whether there was one. */
export function discardChangeSet(actor: string): boolean {
  if (!hasEntries(pending)) return false;
  const set = pending as ChangeSet;
  pending = null;
  recordLedger({
    id: set.id,
    action: "discarded",
    actor,
    paths: set.entries.map((entry) => entry.path),
    proposedAt: set.createdAt,
    discardedAt: new Date().toISOString(),
  });
  return true;
}

/** The one-line summary, for a log line or a response body. */
export function describePending(): string {
  return changeSetSummary(pending);
}
