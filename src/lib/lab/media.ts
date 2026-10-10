/**
 * The media store: where installation media actually lives.
 *
 * The TypeScript half of OnTrak-dev's `ontrak/media.py`. The catalog *describes*
 * media (`source`, `kind`, `filename`, `url`, `sha256`); this module resolves it to a
 * file on disk, and it is the one place in the product that touches licensed
 * software. Two rules are the reason it exists, and both are refusals:
 *
 * 1. **Licensed media is never downloaded.** A `source: operator` manifest names a
 *    file the operator supplies from their own licensed source. OnTrak ships
 *    manifests, not ISOs — the repository fails its own build if an ISO is ever
 *    committed — so the honest behaviour is to say exactly which filename belongs at
 *    exactly which path, not to fetch something that would be a licence violation
 *    and possibly not even the right build.
 * 2. **A download is verified before it is accepted.** A checksum mismatch deletes
 *    the file and fails, rather than leaving a file that looks present and boots
 *    nothing. Silent corruption in a 5 GiB ISO is discovered an hour later, at the
 *    far end of a template build, by whoever is least able to explain it.
 *
 * Three things differ from the Python, each deliberate and each visible here rather
 * than discovered later:
 *
 * **I/O is injectable, and async.** Python reaches straight for `Path`, `urllib` and
 * `hashlib`. This port takes a `MediaFileSystem`, a `Fetcher` and a `FileDigest` as
 * constructor seams, defaulting to `node:fs/promises`, `fetch` and `node:crypto`. The
 * methods are therefore `async` — a multi-gigabyte download inside a request handler
 * must not block the event loop — which is the same call the ported `incus` client
 * made. The defaults are the only part that touches a socket or a real path.
 *
 * **The stem match is a literal prefix, not a glob.** Python globs
 * `<stem>*` to find a file an operator renamed; this port matches names that *start
 * with* the stem. Same result for every real filename, and strictly safer: a
 * filename containing `*` or `[` cannot widen the match into a different file.
 *
 * **`path_for`'s existence check is kept as `exists`.** Python treats anything
 * present at the exact filename — including a directory — as found, and the port
 * keeps that rather than "improving" it, because an operator reading a `present`
 * verdict has a path to look at either way. It is named here so the wart is visible
 * rather than surprising.
 *
 * Nothing in this module writes outside the media root, and a transfer only ever
 * starts for a manifest that is marked free.
 */

import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as pathModule from "node:path";

/** Read/write block size, and the size the digest reads in. Python's `CHUNK`. */
export const MEDIA_CHUNK = 1024 * 1024;
/**
 * How long a transfer may go *without delivering anything* before it is abandoned.
 *
 * An idle timeout, not a deadline, and the distinction matters: Python's
 * `urlopen(..., timeout=60)` is a socket timeout, so a 5 GiB ISO that streams for
 * twenty minutes is fine as long as bytes keep arriving. Reading that number as a
 * total budget would abort exactly the downloads this module exists to perform.
 */
export const DOWNLOAD_TIMEOUT_SECONDS = 60;

/** Raised when media is missing where it is required, or a transfer fails. */
export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaError";
  }
}

/* -------------------------------------------------------------------------- */
/*  The catalog, as this module reads it                                      */
/* -------------------------------------------------------------------------- */

/** Where an entry's installation media comes from. Mirrors the catalog's `Media`. */
export interface MediaDescriptor {
  /** `free` | `operator`. Only `free` may be downloaded. */
  source: string;
  /** `iso` | `image` | `archive`. `image` is an Incus alias, not a file. */
  kind: string;
  filename: string;
  url: string;
  sha256: string;
}

export function mediaIsFree(media: MediaDescriptor): boolean {
  return media.source === "free";
}

export function mediaIsImage(media: MediaDescriptor): boolean {
  return media.kind === "image";
}

/**
 * The narrow view of a catalog entry this module reads.
 *
 * `catalog.ts` is a later stage of the port, so the shape is structural: the real
 * `CatalogEntry` (with its `label` and `image_alias` properties) satisfies this
 * without anything here importing it, which is what keeps this module testable
 * against fixtures rather than against the whole catalog loader.
 */
export interface MediaCatalogEntry {
  id: string;
  /** The entry's display label — the catalog's `name`, plus its edition if it has one. */
  label: string;
  /** The Incus image alias, for `kind: image` entries. */
  imageAlias: string;
  media: MediaDescriptor;
}

/** The catalog as a whole, reduced to the one thing this module asks of it. */
export interface MediaCatalog {
  list(): MediaCatalogEntry[];
}

/* -------------------------------------------------------------------------- */
/*  Status                                                                    */
/* -------------------------------------------------------------------------- */

export const MEDIA_STATES = ["present", "fetchable", "operator-required"] as const;
export type MediaState = (typeof MEDIA_STATES)[number];

export interface MediaStatus {
  entryId: string;
  name: string;
  source: string;
  filename: string;
  state: MediaState;
  path: string;
  sizeBytes: number;
  note: string;
}

/** Whether the media is actually on this host. Python's `MediaStatus.ready`. */
export function mediaStatusReady(status: MediaStatus): boolean {
  return status.state === "present";
}

/**
 * A byte count as a person reads it.
 *
 * Bytes are printed whole (`512 B`), everything larger to one decimal. Ported
 * faithfully, including the truncation of the byte case: `int(size)` in Python
 * truncates rather than rounds, so 1023 bytes is `1023 B` and not `1023 B` by
 * accident.
 */
export function mediaSizeHuman(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let size = Number(bytes);
  for (const unit of units) {
    if (size < 1024 || unit === "TiB") {
      return unit === "B" ? `${Math.trunc(size)} B` : `${size.toFixed(1)} ${unit}`;
    }
    size /= 1024;
  }
  return `${size.toFixed(1)} TiB`;
}

/* -------------------------------------------------------------------------- */
/*  The seams                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The filesystem, reduced to what a media store does with one.
 *
 * A narrow interface rather than `node:fs` directly, so a test can exercise the
 * store's decisions — a renamed copy, a partial file left behind, a mismatch that
 * must not leave a file — with no real path on disk.
 */
export interface MediaFileSystem {
  join(...parts: string[]): string;
  exists(target: string): Promise<boolean>;
  isFile(target: string): Promise<boolean>;
  size(target: string): Promise<number>;
  /** Directory entries (names only); `[]` when the directory is not there. */
  names(dir: string): Promise<string[]>;
  mkdirp(dir: string): Promise<void>;
  /** Write a stream of chunks to `target`, returning the byte count written. */
  write(target: string, chunks: AsyncIterable<Uint8Array>): Promise<number>;
  rename(from: string, to: string): Promise<void>;
  /** Remove `target`; a path that is not there is not an error. */
  remove(target: string): Promise<void>;
  read(target: string, chunkSize: number): AsyncIterable<Uint8Array>;
}

export interface FetchOptions {
  /** The block size the caller wants the transfer read in. */
  chunkSize: number;
  /** How long the transfer may stall with no data before it is abandoned. */
  timeoutSeconds: number;
}

/**
 * Where bytes come from.
 *
 * `open` resolves to a stream rather than a buffer on purpose: the Python streams a
 * `copyfileobj` with a 1 MiB block precisely so a multi-gigabyte ISO never has to be
 * held in memory, and returning `Uint8Array` here would quietly undo that.
 */
export interface Fetcher {
  open(url: string, options: FetchOptions): Promise<AsyncIterable<Uint8Array>>;
}

/** How a finished download is checked against the manifest's checksum. */
export interface FileDigest {
  sha256(target: string, chunkSize: number): Promise<string>;
}

/** The SHA-256 of some bytes, lowercase hex — the shape a manifest stores. */
export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Re-block a stream into fixed-size pieces, flushing the remainder at the end.
 *
 * This is `shutil.copyfileobj(..., length)` in the other direction: it is what makes
 * a transfer's block size the caller's decision rather than the transport's. Exported
 * and pure so it can be tested without a network, which is why the default fetcher
 * can use it and stay a two-line composition.
 */
export async function* rechunk(
  source: AsyncIterable<Uint8Array>,
  size: number,
): AsyncIterable<Uint8Array> {
  if (!Number.isFinite(size) || size <= 0) {
    throw new MediaError(`chunk size must be a positive number, got ${size}`);
  }
  let buffer = new Uint8Array(0);
  for await (const piece of source) {
    if (piece.byteLength === 0) continue;
    const merged = new Uint8Array(buffer.byteLength + piece.byteLength);
    merged.set(buffer, 0);
    merged.set(piece, buffer.byteLength);
    buffer = merged;
    while (buffer.byteLength >= size) {
      yield buffer.subarray(0, size);
      buffer = buffer.subarray(size);
    }
  }
  if (buffer.byteLength > 0) yield buffer;
}

/** The real filesystem. The only place in this module that touches a path. */
export function nodeFileSystem(): MediaFileSystem {
  return {
    join(...parts: string[]): string {
      return pathModule.join(...parts);
    },
    async exists(target: string): Promise<boolean> {
      try {
        await fsp.stat(target);
        return true;
      } catch {
        return false;
      }
    },
    async isFile(target: string): Promise<boolean> {
      try {
        return (await fsp.stat(target)).isFile();
      } catch {
        return false;
      }
    },
    async size(target: string): Promise<number> {
      return (await fsp.stat(target)).size;
    },
    async names(dir: string): Promise<string[]> {
      try {
        return await fsp.readdir(dir);
      } catch {
        return [];
      }
    },
    async mkdirp(dir: string): Promise<void> {
      await fsp.mkdir(dir, { recursive: true });
    },
    async write(target: string, chunks: AsyncIterable<Uint8Array>): Promise<number> {
      const handle = await fsp.open(target, "wb");
      let written = 0;
      try {
        for await (const chunk of chunks) {
          await handle.write(chunk);
          written += chunk.byteLength;
        }
      } finally {
        await handle.close();
      }
      return written;
    },
    async rename(from: string, to: string): Promise<void> {
      await fsp.rename(from, to);
    },
    async remove(target: string): Promise<void> {
      await fsp.rm(target, { force: true });
    },
    async *read(target: string, chunkSize: number): AsyncIterable<Uint8Array> {
      const handle = await fsp.open(target, "rb");
      try {
        // One buffer, refilled per block, so reading a multi-gigabyte file does not
        // allocate it in memory. The yielded views are only valid until the next read,
        // which is what every consumer here does with them (hash and drop) — a caller
        // that wants to keep them must copy.
        const buffer = new Uint8Array(chunkSize);
        while (true) {
          const { bytesRead } = await handle.read(buffer, 0, chunkSize, null);
          if (bytesRead <= 0) return;
          yield buffer.subarray(0, bytesRead);
        }
      } finally {
        await handle.close();
      }
    },
  };
}

/**
 * The real fetcher: `fetch`, streamed.
 *
 * A non-2xx response is an error here rather than a body to be written, so a captive
 * portal's HTML error page is never saved under an `.iso` name.
 *
 * The timeout is applied **per read**, not to the whole transfer: a stalled connection
 * is abandoned after `timeoutSeconds`, while a slow-but-alive one is allowed to finish.
 * The transfer is aborted through the response's own controller so the socket is
 * released rather than left for the garbage collector.
 */
export function httpFetcher(): Fetcher {
  return {
    async open(url: string, options: FetchOptions): Promise<AsyncIterable<Uint8Array>> {
      const controller = new AbortController();
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        controller.abort();
        throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
      }
      const body = response.body;
      if (!body) {
        controller.abort();
        return emptyStream();
      }
      return rechunk(readWebStream(body, options.timeoutSeconds, controller), options.chunkSize);
    },
  };
}

/**
 * A read that gives up only if nothing arrives for `seconds`.
 *
 * The work is already in flight, so the timer is what changes the wait, not the
 * request: when it fires, the transfer is aborted and the caller gets a message it can
 * act on instead of a promise that never settles.
 */
async function readWithIdleTimeout<T>(
  work: Promise<T>,
  seconds: number,
  controller: AbortController,
): Promise<T> {
  if (!(seconds > 0)) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no data for ${seconds}s`));
    }, seconds * 1000);
  });
  try {
    return await Promise.race([work, stalled]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The digest, read through the same filesystem seam the store writes through. */
export function fileDigest(fs: MediaFileSystem, chunkSize: number = MEDIA_CHUNK): FileDigest {
  return {
    async sha256(target: string, size: number): Promise<string> {
      const hash = createHash("sha256");
      for await (const chunk of fs.read(target, size > 0 ? size : chunkSize)) {
        hash.update(chunk);
      }
      return hash.digest("hex");
    },
  };
}

/** A stream with nothing in it, for a response that carried no body. */
async function* emptyStream(): AsyncIterable<Uint8Array> {
  // Deliberately empty: a 200 with no body is not an error, it is nothing to write.
}

async function* readWebStream(
  body: ReadableStream<Uint8Array>,
  timeoutSeconds: number,
  controller: AbortController,
): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(reader.read(), timeoutSeconds, controller);
      if (done) return;
      if (value && value.byteLength > 0) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

export interface MediaStoreSeams {
  fs?: MediaFileSystem;
  fetcher?: Fetcher;
  digest?: FileDigest;
}

export class MediaStore {
  readonly root: string;
  readonly catalog: MediaCatalog;
  private readonly fs: MediaFileSystem;
  private readonly fetcher: Fetcher;
  private readonly digest: FileDigest;

  constructor(root: string, catalog: MediaCatalog, seams: MediaStoreSeams = {}) {
    this.root = root;
    this.catalog = catalog;
    this.fs = seams.fs ?? nodeFileSystem();
    this.fetcher = seams.fetcher ?? httpFetcher();
    this.digest = seams.digest ?? fileDigest(this.fs);
  }

  /* -- resolution ------------------------------------------------------ */

  /** Where this entry's media would live, or `null` for an image entry. */
  pathFor(entry: MediaCatalogEntry): string | null {
    if (mediaIsImage(entry.media) || !entry.media.filename) return null;
    return this.fs.join(this.root, entry.media.filename);
  }

  /**
   * Look for the manifest's filename, then for any file with that stem.
   *
   * The second half is for operators, who rename things: a manifest naming
   * `licensed.iso` finds a file called `licensed-extra-copy.iso`, because the stem is
   * what identifies the media. Candidates are sorted so a directory holding two
   * copies reports the same one every time.
   */
  async find(entry: MediaCatalogEntry): Promise<string | null> {
    const candidate = this.pathFor(entry);
    // `exists`, not `isFile`: the Python accepts anything at the exact name, and this
    // port does not quietly tighten that.
    if (candidate !== null && (await this.fs.exists(candidate))) return candidate;

    const filename = entry.media.filename;
    if (!filename) return null;
    const stem = pathModule.parse(filename).name;
    if (!(await this.fs.exists(this.root))) return null;

    const names = [...(await this.fs.names(this.root))].sort();
    for (const name of names) {
      if (!name.startsWith(stem)) continue;
      const full = this.fs.join(this.root, name);
      if (await this.fs.isFile(full)) return full;
    }
    return null;
  }

  async status(entry: MediaCatalogEntry): Promise<MediaStatus> {
    if (mediaIsImage(entry.media)) {
      return {
        entryId: entry.id,
        name: entry.label,
        source: "free",
        filename: entry.imageAlias,
        state: "fetchable",
        path: "",
        sizeBytes: 0,
        note: `pulled from the image server as '${entry.imageAlias}' on first use`,
      };
    }

    const found = await this.find(entry);
    if (found !== null) {
      return {
        entryId: entry.id,
        name: entry.label,
        source: entry.media.source,
        filename: pathModule.basename(found),
        state: "present",
        path: found,
        sizeBytes: await this.fs.size(found),
        note: "",
      };
    }

    if (mediaIsFree(entry.media) && entry.media.url) {
      return {
        entryId: entry.id,
        name: entry.label,
        source: "free",
        filename: entry.media.filename,
        state: "fetchable",
        path: "",
        sizeBytes: 0,
        note: `run \`ontrak media fetch ${entry.id}\``,
      };
    }

    return {
      entryId: entry.id,
      name: entry.label,
      source: entry.media.source,
      filename: entry.media.filename,
      state: "operator-required",
      path: "",
      sizeBytes: 0,
      note: entry.media.filename
        ? `place ${entry.media.filename} in ${this.root} from your licensed source`
        : "no filename declared in the catalog",
    };
  }

  async statuses(entries?: readonly MediaCatalogEntry[] | null): Promise<MediaStatus[]> {
    const rows = entries ?? this.catalog.list();
    const out: MediaStatus[] = [];
    for (const entry of rows) out.push(await this.status(entry));
    return out;
  }

  async ready(entry: MediaCatalogEntry): Promise<boolean> {
    return mediaStatusReady(await this.status(entry));
  }

  /* -- fetching -------------------------------------------------------- */

  /**
   * Download a **freely redistributable** manifest. Refuses anything else.
   *
   * The refusals come before the transfer, in this order, so the message an operator
   * gets names the actual situation: an image entry has nothing to download at all, a
   * licensed entry is theirs to supply, and only then is a missing `url` a catalog
   * mistake.
   *
   * A file already present is returned untouched — a fetch is a no-op, not a
   * re-download — which is also what makes it safe to call from a setup path that
   * runs more than once.
   */
  async fetch(entry: MediaCatalogEntry, options: { verify?: boolean } = {}): Promise<string> {
    const verify = options.verify ?? true;

    if (mediaIsImage(entry.media)) {
      throw new MediaError(
        `${entry.id} is an Incus image (${entry.imageAlias}); there is nothing to ` +
          "download — the daemon pulls it on first use",
      );
    }
    if (!mediaIsFree(entry.media)) {
      throw new MediaError(
        `${entry.id} media is operator-supplied (${entry.media.filename}). OnTrak does not ` +
          `download licensed media: copy it into ${this.root}`,
      );
    }
    if (!entry.media.url) {
      throw new MediaError(`${entry.id} declares free media without a url`);
    }

    const existing = await this.find(entry);
    if (existing !== null) return existing;

    await this.fs.mkdirp(this.root);
    const target = this.fs.join(this.root, entry.media.filename);
    const partial = `${target}.part`;
    try {
      const stream = await this.fetcher.open(entry.media.url, {
        chunkSize: MEDIA_CHUNK,
        timeoutSeconds: DOWNLOAD_TIMEOUT_SECONDS,
      });
      await this.fs.write(partial, stream);
    } catch (error) {
      // A half-written `.part` file is never left behind: it is indistinguishable
      // from media to anything that looks at the suffix.
      await this.fs.remove(partial);
      const detail = error instanceof Error ? error.message : String(error);
      throw new MediaError(`could not download ${entry.media.url}: ${detail}`);
    }
    await this.fs.rename(partial, target);

    if (verify && entry.media.sha256) {
      const actual = await this.digest.sha256(target, MEDIA_CHUNK);
      if (actual !== entry.media.sha256) {
        await this.fs.remove(target);
        throw new MediaError(
          `checksum mismatch for ${pathModule.basename(target)}: expected ` +
            `${entry.media.sha256}, got ${actual}`,
        );
      }
    }
    return target;
  }

  /** Entries a `media fetch` could actually fetch: free, a file, and with a url. */
  async fetchable(): Promise<MediaCatalogEntry[]> {
    return this.catalog
      .list()
      .filter(
        (entry) => mediaIsFree(entry.media) && !mediaIsImage(entry.media) && Boolean(entry.media.url),
      );
  }

  /** Everything a deployment is still waiting for an operator to supply. */
  async missingOperatorMedia(): Promise<MediaStatus[]> {
    return (await this.statuses()).filter((row) => row.state === "operator-required");
  }

  /** How many entries are in each state — the one number a range page shows. */
  async summary(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const row of await this.statuses()) {
      counts[row.state] = (counts[row.state] ?? 0) + 1;
    }
    return counts;
  }
}

/** The media directory as configuration names it. `config.ts` satisfies this. */
export interface MediaSettings {
  mediaDir: string;
}

export function defaultMediaStore(settings: MediaSettings, catalog: MediaCatalog): MediaStore {
  return new MediaStore(settings.mediaDir, catalog);
}
