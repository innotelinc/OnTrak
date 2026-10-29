import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

import { resolveInWorkspace, toRel } from "./workspace.js";

/**
 * One writer per file, for as long as its change is in flight.
 *
 * An edit is a **read and a write that must not be interleaved**: `edit_file`
 * reads the file, replaces the substring, and writes the result. Two turns doing
 * that to the same file at the same time both read the same original, and the
 * second write silently discards the first change — the agent is told both edits
 * landed, the diff of each was computed against a file that no longer exists, and
 * the loss is invisible until somebody reads the file. A person typing in the
 * console while a turn writes does the same thing through the file editor.
 *
 * So a change holds a lock on its path for the whole read-modify-write, and a
 * second change to a *locked* path is refused rather than queued. Refusing is the
 * part that matters: a queued write would apply an edit whose `oldString` was
 * computed against a file that has since changed, which fails or, worse, matches
 * somewhere else. The model is told which file, and to try again — a turn that
 * gets this answer loses one step, where the interleaved write loses the work.
 *
 * **Locked by whom, not just whether.** The holder is an id the caller owns — the
 * session running the turn — so re-entering is possible: a tool that writes
 * `MEMORY.md` inside a write to `MEMORY.md` (or a future tool that composes
 * others) must not deadlock against itself.
 *
 * The registry is in-process and keyed on the *resolved absolute path*, so two
 * spellings of the same file (`./a.ts`, `a.ts`, `src/../a.ts`) collide as they
 * should, and two accounts' workspaces never do. It is deliberately not a file on
 * disk: this is coordination between requests in one process, and a lock that
 * outlived the process that took it would be a lock nobody can release.
 */

interface HeldLock {
  /** Who holds it — a session id, for a turn. */
  owner: string;
  /** When it was taken, for the status route and for reading a stuck lock. */
  since: number;
  /** Re-entrant depth, so a nested acquire does not release the outer one. */
  depth: number;
}

export interface LockInfo {
  /** Workspace-relative, forward-slashed, as a person reads it. */
  path: string;
  owner: string;
  /** Milliseconds it has been held. */
  heldMs: number;
}

const held = new Map<string, HeldLock>();

/**
 * Thrown when a change cannot start because another turn holds the file.
 *
 * Extends `Error` rather than `ToolError` so this module has no dependency on the
 * tool registry: `tools.ts` translates it into the model-visible result, which is
 * where the wording for "and now what" belongs.
 */
export class FileLockedError extends Error {
  readonly path: string;
  readonly holder: string;
  readonly heldMs: number;

  constructor(rel: string, holder: string, heldMs: number) {
    super(
      `${rel} is being changed by another turn right now, so nothing was written. ` +
        `Wait for that turn to finish, then make this change again.`,
    );
    this.name = "FileLockedError";
    this.path = rel;
    this.holder = holder;
    this.heldMs = heldMs;
  }
}

/**
 * An owner id that is unique per turn, for a caller that has none.
 *
 * Never the empty string: two anonymous turns must collide with each other, and
 * a shared id would let the second one through as a re-entry.
 */
export function newLockOwner(): string {
  return `turn-${crypto.randomUUID()}`;
}

/**
 * The owner a tool call is running as.
 *
 * Carried in an `AsyncLocalStorage` rather than added to every tool's signature:
 * the alternative is a `context` argument on eighteen handlers and a lock owner in
 * each of them, for a value that is fixed for the whole call. `runAsLockOwner` is
 * entered once, in `runTool`, and every write inside it — including one a tool
 * makes through another module — holds the lock as that turn.
 */
const owners = new AsyncLocalStorage<string>();

/** Run `fn` as `owner`. The caller's context is restored on the way out. */
export function runAsLockOwner<T>(owner: string, fn: () => Promise<T>): Promise<T> {
  return owners.run(owner.trim() === "" ? "turn" : owner, fn);
}

/** Who this call is, for a lock. "turn" when nobody said. */
export function currentLockOwner(): string {
  return owners.getStore() ?? "turn";
}

/**
 * Run `fn` holding the lock for `rel`.
 *
 * The lock is released in a `finally`, so a tool that throws, an approval that is
 * denied and a turn that is cancelled all leave the file unlocked. `rel` is
 * resolved through the same fence as every other tool path, so a lock can only
 * ever be taken on a file inside the workspace.
 */
export async function withFileLock<T>(rel: string, owner: string, fn: () => Promise<T>): Promise<T> {
  const abs = resolveInWorkspace(rel);
  const key = abs;
  const holder = owner.trim() === "" ? "turn" : owner;
  const existing = held.get(key);

  if (existing !== undefined) {
    if (existing.owner !== holder) {
      throw new FileLockedError(toRel(abs), existing.owner, Date.now() - existing.since);
    }
    // Re-entry by the same turn: run it, and let the outer acquire release.
    existing.depth += 1;
    try {
      return await fn();
    } finally {
      existing.depth -= 1;
    }
  }

  held.set(key, { owner: holder, since: Date.now(), depth: 1 });
  try {
    return await fn();
  } finally {
    const current = held.get(key);
    if (current !== undefined && current.owner === holder && current.depth <= 1) held.delete(key);
  }
}

/**
 * Drop every lock a turn holds.
 *
 * `withFileLock` already releases in a `finally`, so this exists for the case
 * that cannot run one: a turn aborted hard enough that its tool promise is left
 * pending. Called by the chat route when a turn ends, so a lock can never outlive
 * the turn that took it and leave a file permanently un-editable.
 */
export function releaseLocks(owner: string): number {
  const holder = owner.trim() === "" ? "turn" : owner;
  let released = 0;
  for (const [key, lock] of held) {
    if (lock.owner !== holder) continue;
    held.delete(key);
    released += 1;
  }
  return released;
}

/** Every lock currently held, for the status route and for reading a stuck one. */
export function activeLocks(now = Date.now()): LockInfo[] {
  return [...held.entries()]
    .map(([key, lock]) => ({ path: toRel(key), owner: lock.owner, heldMs: now - lock.since }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Is this path locked by somebody other than `owner`? */
export function lockedByOther(rel: string, owner: string): LockInfo | null {
  const abs = resolveInWorkspace(rel);
  const lock = held.get(abs);
  if (lock === undefined) return null;
  const holder = owner.trim() === "" ? "turn" : owner;
  if (lock.owner === holder) return null;
  return { path: toRel(abs), owner: lock.owner, heldMs: Date.now() - lock.since };
}
