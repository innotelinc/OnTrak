/**
 * A filesystem `EvidenceObjectStore` (M3), for local development and single-node
 * hosting.
 *
 * Write-once is enforced by the *filesystem* here, not by a check-then-write:
 * the file is opened with the `wx` flag, so a second create fails in the kernel
 * even if two uploads race. The bytes are then marked read-only (0444), so the
 * intent is visible to anyone who looks at the directory.
 *
 * Be honest about the limit: a root user on the box can still `chmod` and delete
 * these files. That is exactly why the retention decision is enforced in the
 * service and the lock is recorded in the database. A shared, object-locked
 * bucket is the answer for a real deployment — the rules module hands out the
 * headers for one (`objectLockHeaders`).
 *
 *   ONTRAK_TIX_EVIDENCE_DIR   # defaults to .ontrak-tix-evidence
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { sameBytes, type EvidenceObjectStore, type StorePutResult } from "./object-lock-rules";

/** SHA-256 of raw bytes, lower-case hex — the digest a key is derived from. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class FileEvidenceObjectStore implements EvidenceObjectStore {
  private readonly root: string;

  constructor(root = process.env.ONTRAK_TIX_EVIDENCE_DIR ?? ".ontrak-tix-evidence") {
    this.root = resolve(root);
  }

  async put(key: string, bytes: Uint8Array, _contentType?: string): Promise<StorePutResult> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });

    try {
      // `wx` — create, and fail if it exists. The write-once rule is the kernel's
      // to keep, so two uploads of the same key cannot both succeed.
      await writeFile(path, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const stored = new Uint8Array(await readFile(path));
      if (!sameBytes(stored, bytes)) {
        throw new Error(`Refusing to overwrite the locked object at ${key}.`);
      }
      return "unchanged";
    }

    await chmod(path, 0o444);
    return "created";
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    // Read-only is a statement about intent; removal after the retention window
    // is the point of having a window at all, so the mode is lifted first.
    await chmod(path, 0o644).catch(() => undefined);
    await rm(path, { force: true });
  }

  /** Resolve a key inside the root, refusing anything that would climb out. */
  private pathFor(key: string): string {
    const parts = key.split("/");
    if (key.startsWith("/") || parts.some((part) => part === ".." || part === "")) {
      throw new Error(`Refusing to use an unsafe evidence key: ${key}`);
    }
    return join(this.root, ...parts);
  }
}
