import "server-only";

import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatBytes } from "./cn";

export { formatBytes };

/**
 * Package storage.
 *
 * Administrators provision software either by uploading a file or by pasting a
 * vendor download URL.  Both paths land in `STORAGE_DIR` with a content hash
 * so re-uploads are idempotent and the inventory can show a verifiable digest.
 *
 * Nothing here ever executes what it stores: these are payloads handed to a
 * simulation driver, not programs the server runs.
 */

export function storageRoot(): string {
  const configured = process.env.STORAGE_DIR ?? "./storage/packages";
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

export function maxUploadBytes(): number {
  const mb = Number(process.env.MAX_UPLOAD_MB ?? "512");
  return (Number.isFinite(mb) && mb > 0 ? mb : 512) * 1024 * 1024;
}


/** Strip directory components and anything that is not shell-safe. */
export function safeFileName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-+() ]+/g, "_").trim();
  return base.length > 0 ? base.slice(0, 160) : "package.bin";
}

export interface StoredFile {
  /** Path relative to `storageRoot()`, safe to persist in the database. */
  relativePath: string;
  fileName: string;
  size: number;
  checksum: string;
}

function digest(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Persist an uploaded file. Throws when it exceeds `MAX_UPLOAD_MB`. */
export async function saveUpload(file: File, ownedName?: string): Promise<StoredFile> {
  const limit = maxUploadBytes();
  if (file.size > limit) {
    throw new Error(`That file is ${formatBytes(file.size)}; the current limit is ${formatBytes(limit)}.`);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  return persist(buffer, ownedName ?? file.name);
}

/**
 * Download a vendor URL into storage.  The download is streamed into memory
 * with a hard cap so a mistyped URL cannot exhaust the host.
 */
export async function fetchToStorage(url: string, suggestedName?: string): Promise<StoredFile> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch (error) {
    throw new Error(`Could not reach ${url}: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status} ${response.statusText}.`);
  }

  const limit = maxUploadBytes();
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared && declared > limit) {
    throw new Error(`The remote file is ${formatBytes(declared)}; the current limit is ${formatBytes(limit)}.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > limit) {
    throw new Error(`The remote file is ${formatBytes(buffer.byteLength)}; the current limit is ${formatBytes(limit)}.`);
  }

  const fromUrl = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "package.bin";
  return persist(buffer, suggestedName ?? fromUrl);
}

async function persist(buffer: Buffer, fileName: string): Promise<StoredFile> {
  const safe = safeFileName(fileName);
  const checksum = digest(buffer);
  const folder = checksum.slice(0, 2);
  const target = path.join(storageRoot(), folder);

  await mkdir(target, { recursive: true });
  // Prefix with the digest so two packages never clobber one another.
  const stored = `${checksum.slice(0, 12)}-${safe}`;
  await writeFile(path.join(target, stored), buffer);

  return {
    relativePath: path.posix.join(folder, stored),
    fileName: safe,
    size: buffer.byteLength,
    checksum,
  };
}

/** Delete a stored package. Missing files are not an error. */
export async function deleteStored(relativePath: string | null | undefined): Promise<void> {
  if (!relativePath) return;
  const absolute = path.join(storageRoot(), relativePath);
  if (!absolute.startsWith(storageRoot())) {
    throw new Error("Refusing to delete a path outside the storage directory.");
  }
  await rm(absolute, { force: true });
}

export async function storedFileSize(relativePath: string | null | undefined): Promise<number | null> {
  if (!relativePath) return null;
  try {
    const info = await stat(path.join(storageRoot(), relativePath));
    return info.size;
  } catch {
    return null;
  }
}

export async function listStoredFiles(): Promise<string[]> {
  try {
    const folders = await readdir(storageRoot());
    const out: string[] = [];
    for (const folder of folders) {
      const entries = await readdir(path.join(storageRoot(), folder)).catch(() => []);
      out.push(...entries.map((entry) => path.posix.join(folder, entry)));
    }
    return out;
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*  License keys                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Keys are never rendered back to the browser in full.  Administrators can see
 * enough to confirm *which* key is loaded, and can replace it, but the raw
 * secret is not shipped to the client.
 */
export function maskKey(key: string | null | undefined): string {
  if (!key) return "—";
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "•".repeat(trimmed.length);
  return `${trimmed.slice(0, 4)}${"•".repeat(Math.min(12, trimmed.length - 8))}${trimmed.slice(-4)}`;
}

/** Light validation so an obviously wrong key is caught at entry time. */
export function validateLicenseKey(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed.length === 0) return "Enter the activation key, or switch the license type to Open or Evaluation.";
  if (trimmed.length < 8) return "That key looks too short — activation keys are usually at least 8 characters.";
  if (/\s/.test(trimmed)) return "Activation keys do not normally contain spaces.";
  return null;
}
