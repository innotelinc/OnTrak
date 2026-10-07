/**
 * A change set — the pure half of "propose then commit".
 *
 * The live diff already shows what a write *did*. This is the other mode the
 * roadmap asked for: a queued change a reviewer approves as a *set*, rather than
 * one write at a time, with the write held back until they say so.
 *
 * Everything here is a decision about a list, so it is pure and testable without a
 * filesystem: what an entry is, what happens when the same path is proposed twice,
 * how a set is summarised, and the order it is applied in. The state and the bytes
 * live in `proposals.ts`; this file never touches a disk.
 *
 * WHY THE LAST PROPOSAL FOR A PATH WINS
 * -------------------------------------
 * An agent refining its own work calls `write_file` on the same path more than
 * once in a turn. Keeping every revision would make the reviewer approve writes
 * that are not the change — the second write *is* the first write, corrected. So a
 * later proposal for a path **replaces** the earlier one rather than appending, and
 * the set holds at most one entry per path. The reviewer approves the net change,
 * which is what they are reviewing.
 */

/** How an entry changes a path, which is also how it reads in a summary. */
export type EntryKind = "create" | "overwrite" | "edit";

export interface StagedEntry {
  /** Workspace-relative, forward-slashed — resolved again when applied. */
  path: string;
  kind: EntryKind;
  /** The complete contents to write when the set is applied. */
  content: string;
  /** Lines the diff added, for the summary. Zero when the diff was not computed. */
  added: number;
  /** Lines the diff removed, for the summary. */
  removed: number;
}

export interface ChangeSet {
  id: string;
  /** ISO-8601, when the first entry of this set was staged. */
  createdAt: string;
  entries: StagedEntry[];
}

/** The line counts across a set, and how many distinct files it touches. */
export function totalChanges(entries: readonly StagedEntry[]): {
  files: number;
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const entry of entries) {
    added += entry.added;
    removed += entry.removed;
  }
  return { files: entries.length, added, removed };
}

/**
 * Add a proposal, replacing any earlier one for the same path.
 *
 * Order is preserved for paths already in the set — an entry keeps its position
 * when corrected — and a new path appends. That keeps the summary stable to read
 * while the agent works, rather than reshuffling on every edit.
 */
export function addEntry(entries: readonly StagedEntry[], entry: StagedEntry): StagedEntry[] {
  const index = entries.findIndex((existing) => existing.path === entry.path);
  if (index === -1) return [...entries, entry];
  const next = [...entries];
  next[index] = entry;
  return next;
}

/** One line for the reviewer: how many files, and how much moved. */
export function changeSetSummary(set: ChangeSet | null): string {
  if (set === null || set.entries.length === 0) return "no proposed changes";
  const { files, added, removed } = totalChanges(set.entries);
  const noun = files === 1 ? "file" : "files";
  return `${files} ${noun} (+${added} −${removed})`;
}

/** A per-entry line, e.g. `edit src/server.ts (+4 −1)`. */
export function describeEntry(entry: StagedEntry): string {
  return `${entry.kind} ${entry.path} (+${entry.added} −${entry.removed})`;
}

/**
 * The order a set is applied in: by path.
 *
 * A change set is not a transaction — there is no atomicity across files — so what
 * an order can offer is *determinism*: a re-run applies the same paths in the same
 * sequence, which is what makes a failure partway through explainable ("it had
 * written a, b and c when it stopped") rather than a race. Sorting by path also
 * puts a directory's entries together, so a partial apply is a prefix of a
 * directory rather than a scatter.
 */
export function sortEntriesForApply(entries: readonly StagedEntry[]): StagedEntry[] {
  return [...entries].sort((a, b) => a.path.localeCompare(b.path));
}

/** Whether a set is worth applying — an empty set is not an error, it is a no-op. */
export function hasEntries(set: ChangeSet | null): boolean {
  return set !== null && set.entries.length > 0;
}
