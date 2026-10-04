import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { snapshotsDir } from "./scope.js";

/**
 * The previous contents of every file the agent has written.
 *
 * Only the most recent "before" is kept per path, which is exactly what the
 * file viewer needs: a diff between the file as it is now and the file as it was
 * before the agent last touched it. It also means a change made outside the
 * agent shows up in that diff, which is honest rather than surprising.
 *
 * Paths are hashed for the filename, so no workspace path is ever used as a
 * filesystem path here and traversal is not possible.
 *
 * The directory is the account's own (`scope.ts`), because the hash is of the
 * *relative* path: two accounts holding `index.html` would otherwise share one
 * baseline, and the second one's diff would render against a stranger's file.
 */

export interface Snapshot {
  path: string;
  savedAt: string;
  content: string;
}

function snapshotFile(rel: string): string {
  const hash = crypto.createHash("sha256").update(rel).digest("hex").slice(0, 32);
  return path.join(snapshotsDir(), `${hash}.json`);
}

/** Record what a file looked like before the agent rewrote it. */
export async function saveSnapshot(rel: string, content: string): Promise<void> {
  await fs.mkdir(snapshotsDir(), { recursive: true });
  const snapshot: Snapshot = { path: rel, savedAt: new Date().toISOString(), content };
  await fs.writeFile(snapshotFile(rel), JSON.stringify(snapshot), "utf8");
}

export async function readSnapshot(rel: string): Promise<Snapshot | null> {
  try {
    const raw = await fs.readFile(snapshotFile(rel), "utf8");
    const parsed = JSON.parse(raw) as Snapshot;
    if (typeof parsed.content !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Paths the agent has changed, mapped to when the snapshot was taken. */
export async function listSnapshots(): Promise<Map<string, string>> {
  const changed = new Map<string, string>();
  let names: string[];
  try {
    names = await fs.readdir(snapshotsDir());
  } catch {
    return changed;
  }

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(snapshotsDir(), name), "utf8")) as Snapshot;
      if (typeof parsed.path === "string") changed.set(parsed.path, parsed.savedAt);
    } catch {
      // A corrupt snapshot is not worth failing a request over.
    }
  }
  return changed;
}

/** Forget a path's history, e.g. after the agent deletes it. */
export async function dropSnapshot(rel: string): Promise<void> {
  await fs.unlink(snapshotFile(rel)).catch(() => {});
}

/**
 * Forget the history of a path and everything below it, returning how many were
 * dropped.
 *
 * A snapshot is the *before* half of a diff, so once a directory is emptied the
 * baseline is a lie: a file that is gone and a baseline from before the clear
 * would render as the agent having just deleted a pile of work. `rel` is
 * workspace-relative and forward-slashed; `"."` (the working directory itself)
 * clears all of them, which is the whole history of a workspace being started
 * over.
 */
export async function dropSnapshotsUnder(rel: string): Promise<number> {
  const within = rel === "." || rel === "" ? null : rel.replace(/\/+$/, "");

  let names: string[];
  try {
    names = await fs.readdir(snapshotsDir());
  } catch {
    return 0;
  }

  let dropped = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(snapshotsDir(), name);
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Snapshot;
      if (typeof parsed.path !== "string") continue;
      if (within !== null && parsed.path !== within && !parsed.path.startsWith(`${within}/`)) {
        continue;
      }
      await fs.unlink(file);
      dropped += 1;
    } catch {
      // An unreadable snapshot is not worth failing a clear over.
    }
  }
  return dropped;
}
