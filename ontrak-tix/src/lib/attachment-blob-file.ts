/**
 * A filesystem `BlobStore` (M1), for local development and single-node hosting.
 *
 * Not the production answer — multi-instance deployments need shared,
 * object-locked storage — but it is durable across restarts and needs no
 * credentials, so the attachment flow is exercisable end to end today. Keys are
 * validated on the way in so a crafted key can never escape the root directory.
 *
 *   ONTRAK_TIX_BLOB_DIR   # defaults to .ontrak-tix-blobs
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { BlobStore } from "./attachment-rules";

export class FileBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root = process.env.ONTRAK_TIX_BLOB_DIR ?? ".ontrak-tix-blobs") {
    this.root = resolve(root);
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  /**
   * Resolve a key inside the root, refusing anything that would climb out.
   * Leading slashes and `..` segments are rejected outright rather than
   * silently rewritten, because a malformed key is a bug worth surfacing.
   */
  private pathFor(key: string): string {
    const parts = key.split("/");
    if (key.startsWith("/") || parts.some((part) => part === ".." || part === "")) {
      throw new Error(`Refusing to use an unsafe blob key: ${key}`);
    }
    return join(this.root, ...parts);
  }
}
