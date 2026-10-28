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
import { currentScope } from "./scope.js";
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
 * ONE PENDING SET PER ACCOUNT
 * ---------------------------
 * The approval gate is per-prompt and short-lived; a change set is a *document* a
 * person reads, and reading it takes minutes. So an account has one pending set at
 * a time, not a queue: staging while a set is already waiting adds to it, because
 * two documents from one agent would be two things to reconcile by hand.
 *
 * That slot used to be the process's, which was honest for a single operator and
 * wrong the moment a second person signed in: their first proposal was added to a
 * set they could not see, or refused at the door as "already reviewable" by work
 * that was somebody else's. The key is the account, exactly as the workspace, the
 * chats and the file history are keyed (`scope.ts`), so a reviewer reads the set
 * proposed against the disk they will apply it to. Single-operator mode keeps the
 * literal `local` — one slot on a laptop, exactly as before tenancy existed.
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

/**
 * The sets waiting for a decision, keyed by the account that proposed them.
 *
 * A map rather than one slot per process (2.2), and still one set per key: the
 * isolation is between accounts, not a queue inside one.
 */
const pendingSets = new Map<string, ChangeSet>();

/**
 * Whose change sets this call's are.
 *
 * The same account key `scope.ts` uses for the workspace, so a set can only be
 * read and applied against the slice it was proposed for. No control plane means
 * no account, which is `local`: the single-operator slot that shipped first, and
 * is still what an un-tenanted deployment runs.
 */
export function changeSetOwner(): string {
  return currentScope().userId ?? "local";
}

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
export function stageChange(entry: StagedEntry, owner: string = changeSetOwner()): ChangeSet {
  const current = pendingSets.get(owner);
  const base: ChangeSet = current ?? {
    id: newId(),
    createdAt: new Date().toISOString(),
    entries: [],
  };
  const next: ChangeSet = { ...base, entries: addEntry(base.entries, entry) };
  pendingSets.set(owner, next);
  return next;
}

export function currentChangeSet(owner: string = changeSetOwner()): ChangeSet | null {
  return pendingSets.get(owner) ?? null;
}

/** Reset the in-process state. For tests, and for a deployment that wants a clean slate. */
export function resetChangeSets(): void {
  pendingSets.clear();
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
 *
 * `owner` decides **which** set is committed; the bytes still resolve through the
 * request's own scope, because in a deployment the two are the same account — the
 * key is the set's, the scope is the disk's, and neither can name the other's.
 */
export async function applyChangeSet(
  actor: string,
  owner: string = changeSetOwner(),
): Promise<ApplyResult> {
  const current = pendingSets.get(owner) ?? null;
  if (!hasEntries(current)) {
    throw new ChangeSetError("there is no proposed change set to apply");
  }
  const set = current as ChangeSet;
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

  pendingSets.delete(owner);
  recordLedger({
    id: set.id,
    action: "applied",
    actor,
    owner,
    paths: applied,
    proposedAt: set.createdAt,
    appliedAt: new Date().toISOString(),
  });
  return { applied: applied.length, paths: applied, id: set.id };
}

/**
 * Drop an account's pending set without writing anything.
 *
 * Returns whether there was one. The ledger names the account as well as the
 * actor: an address can change or be shared, and the row has to say whose
 * proposal was dropped.
 */
export function discardChangeSet(actor: string, owner: string = changeSetOwner()): boolean {
  const current = pendingSets.get(owner) ?? null;
  if (!hasEntries(current)) return false;
  const set = current as ChangeSet;
  pendingSets.delete(owner);
  recordLedger({
    id: set.id,
    action: "discarded",
    actor,
    owner,
    paths: set.entries.map((entry) => entry.path),
    proposedAt: set.createdAt,
    discardedAt: new Date().toISOString(),
  });
  return true;
}

/** The one-line summary, for a log line or a response body. */
export function describePending(owner: string = changeSetOwner()): string {
  return changeSetSummary(pendingSets.get(owner) ?? null);
}
