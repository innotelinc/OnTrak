/**
 * The media store is the one place that touches licensed software, so these tests
 * pin what it *refuses* as much as what it does — the refusal is the feature.
 *
 * Three rules carry the weight, and each is a case below:
 *
 * 1. **Licensed media is never downloaded.** A `source: operator` entry is the
 *    operator's to supply, and the message has to name the file and the directory or
 *    the operator is left guessing which build is missing.
 * 2. **A checksum mismatch leaves nothing behind.** The Python's stub is worse than a
 *    failure in this case: a file that looks fetched, boots nothing, and is discovered
 *    an hour later inside a template build. The test asserts the directory is empty,
 *    not merely that an error was raised.
 * 3. **A fetch is a no-op when the media is already there.** Which is what makes it
 *    safe to call from a setup path that runs more than once, and it is asserted by
 *    counting the requests the fetcher received rather than by trusting a return
 *    value.
 *
 * Everything runs against in-memory fakes — a filesystem, a fetcher — so no test
 * opens a socket or writes a real path. The checksum is *not* faked: the store's
 * default digest reads through the same filesystem seam and hashes with
 * `node:crypto`, so the mismatch cases exercise the real comparison.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-media.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DOWNLOAD_TIMEOUT_SECONDS,
  MEDIA_CHUNK,
  MediaError,
  MediaStore,
  mediaSizeHuman,
  mediaStatusReady,
  rechunk,
  sha256Hex,
  type FetchOptions,
  type Fetcher,
  type MediaCatalogEntry,
  type MediaDescriptor,
  type MediaFileSystem,
} from "../src/lib/lab/media";

/* -------------------------------------------------------------------------- */
/*  Fakes                                                                     */
/* -------------------------------------------------------------------------- */

function parentOf(full: string): string {
  const index = full.lastIndexOf("/");
  return index <= 0 ? "" : full.slice(0, index);
}

function baseOf(full: string): string {
  return full.slice(full.lastIndexOf("/") + 1);
}

class FakeFileSystem implements MediaFileSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();

  join(...parts: string[]): string {
    return parts
      .filter((part) => part !== "")
      .join("/")
      .replace(/\/{2,}/g, "/");
  }

  async exists(target: string): Promise<boolean> {
    return this.files.has(target) || this.dirs.has(target);
  }

  async isFile(target: string): Promise<boolean> {
    return this.files.has(target);
  }

  async size(target: string): Promise<number> {
    const data = this.files.get(target);
    if (!data) throw new Error(`no such file: ${target}`);
    return data.byteLength;
  }

  async names(dir: string): Promise<string[]> {
    return [...this.files.keys()].filter((full) => parentOf(full) === dir).map(baseOf);
  }

  async mkdirp(dir: string): Promise<void> {
    this.dirs.add(dir);
  }

  async write(target: string, chunks: AsyncIterable<Uint8Array>): Promise<number> {
    const pieces: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of chunks) {
      pieces.push(chunk);
      total += chunk.byteLength;
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const piece of pieces) {
      joined.set(piece, offset);
      offset += piece.byteLength;
    }
    this.put(target, joined);
    return total;
  }

  async rename(from: string, to: string): Promise<void> {
    const data = this.files.get(from);
    if (!data) throw new Error(`no such file: ${from}`);
    this.files.delete(from);
    this.files.set(to, data);
  }

  async remove(target: string): Promise<void> {
    this.files.delete(target);
  }

  async *read(target: string, chunkSize: number): AsyncIterable<Uint8Array> {
    const data = this.files.get(target);
    if (!data) throw new Error(`no such file: ${target}`);
    const size = chunkSize > 0 ? chunkSize : data.byteLength || 1;
    for (let offset = 0; offset < data.byteLength; offset += size) {
      yield data.subarray(offset, Math.min(offset + size, data.byteLength));
    }
  }

  /** Seed a file the way an operator would have left it there. */
  put(target: string, data: Uint8Array): void {
    this.files.set(target, data);
    this.dirs.add(parentOf(target));
  }

  /** Every path held, ending in `suffix` — the way 'nothing was left behind' is read. */
  seeds(suffix: string): string[] {
    return [...this.files.keys()].filter((full) => full.endsWith(suffix)).sort();
  }
}

class FakeFetcher implements Fetcher {
  readonly sources = new Map<string, Uint8Array>();
  readonly requests: { url: string; options: FetchOptions }[] = [];

  async open(url: string, options: FetchOptions): Promise<AsyncIterable<Uint8Array>> {
    this.requests.push({ url, options });
    const data = this.sources.get(url);
    if (!data) throw new Error(`could not reach ${url}`);
    return sliced(data, options.chunkSize);
  }
}

async function* sliced(data: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  const block = size > 0 ? size : data.byteLength || 1;
  for (let offset = 0; offset < data.byteLength; offset += block) {
    yield data.subarray(offset, Math.min(offset + block, data.byteLength));
  }
}

async function* piecesOf(list: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const piece of list) yield piece;
}

/** Every failure in this module is a `MediaError`, so this reads the message it carried. */
async function mediaErrorFrom(run: () => Promise<unknown>): Promise<MediaError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof MediaError) return error;
    throw error;
  }
  throw new Error("expected a MediaError, but the call succeeded");
}

/**
 * Consume a stream and report how many bytes it carried.
 *
 * A generator body does not run until the first read, so a guard inside one is
 * asserted by actually drawing from it rather than by calling it.
 */
async function drain(iterable: AsyncIterable<Uint8Array>): Promise<number> {
  let total = 0;
  for await (const chunk of iterable) total += chunk.byteLength;
  return total;
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const FREE_URL = "https://media.example.test/free.iso";
const LICENSED = entry({
  id: "licensed-iso",
  label: "Licensed ISO",
  media: { source: "operator", filename: "licensed.iso" },
});

function entry(fields: {
  id: string;
  label?: string;
  imageAlias?: string;
  media?: Partial<MediaDescriptor>;
}): MediaCatalogEntry {
  return {
    id: fields.id,
    label: fields.label ?? fields.id,
    imageAlias: fields.imageAlias ?? "",
    media: {
      source: "operator",
      kind: "iso",
      filename: "",
      url: "",
      sha256: "",
      ...fields.media,
    },
  };
}

function freeEntry(sha256 = ""): MediaCatalogEntry {
  return entry({
    id: "free-iso",
    label: "Free ISO",
    media: { source: "free", filename: "free.iso", url: FREE_URL, sha256 },
  });
}

function storeFor(entries: readonly MediaCatalogEntry[]): {
  store: MediaStore;
  fs: FakeFileSystem;
  fetcher: FakeFetcher;
} {
  const fs = new FakeFileSystem();
  const fetcher = new FakeFetcher();
  const store = new MediaStore("media", { list: () => [...entries] }, { fs, fetcher });
  return { store, fs, fetcher };
}

/* -------------------------------------------------------------------------- */
/*  Status                                                                    */
/* -------------------------------------------------------------------------- */

test("media: status reports the three states, and the summary counts them", async () => {
  const image = entry({
    id: "image-entry",
    label: "Image entry",
    imageAlias: "images:alpine/3.21",
    media: { source: "free", kind: "image", filename: "images:alpine/3.21" },
  });
  const { store } = storeFor([freeEntry(), LICENSED, image]);

  const free = await store.status(freeEntry());
  assert.equal(free.state, "fetchable");
  assert.equal(free.source, "free");
  assert.equal(free.filename, "free.iso");

  // The operator has to be told which file and where, or the message is useless.
  const licensed = await store.status(LICENSED);
  assert.equal(licensed.state, "operator-required");
  assert.match(licensed.note, /licensed\.iso/);
  assert.ok(licensed.note.includes(store.root), "the note names the media directory");

  // An image entry is not a file at all: the daemon pulls it on first use.
  const imageStatus = await store.status(image);
  assert.equal(imageStatus.state, "fetchable");
  assert.match(imageStatus.note, /image server/);
  assert.equal(imageStatus.filename, "images:alpine/3.21");

  const counts = await store.summary();
  assert.equal(counts.fetchable, 2);
  assert.equal(counts["operator-required"], 1);
  assert.equal(counts.present, undefined, "a state nobody is in is not a row");
});

test("media: a file that is already there is present, sized, and not missing", async () => {
  const { store, fs } = storeFor([LICENSED]);
  fs.put("media/licensed.iso", new Uint8Array(2048));

  const status = await store.status(LICENSED);
  assert.equal(status.state, "present");
  assert.equal(mediaStatusReady(status), true);
  assert.equal(status.sizeBytes, 2048);
  assert.equal(status.path, "media/licensed.iso");
  assert.equal(mediaSizeHuman(status.sizeBytes), "2.0 KiB");
  assert.deepEqual(await store.missingOperatorMedia(), []);
});

test("media: a renamed copy of the media still counts, because the stem decides", async () => {
  // Operators rename files. A manifest naming licensed.iso has to find the copy
  // somebody left as licensed-extra-copy.iso, or every range reports its media missing.
  const { store, fs } = storeFor([LICENSED]);
  fs.put("media/licensed-extra-copy.iso", new Uint8Array([1]));

  const status = await store.status(LICENSED);
  assert.equal(status.state, "present");
  assert.equal(status.filename, "licensed-extra-copy.iso");
});

/* -------------------------------------------------------------------------- */
/*  Fetching                                                                  */
/* -------------------------------------------------------------------------- */

test("media: fetching free media verifies the checksum, and a second fetch is a no-op", async () => {
  const payload = new Uint8Array(4096).fill(7);
  // Hand `fetch` the entry that carries the checksum: the store verifies what the
  // caller passes it, so fetching a checksum-less copy of the same entry would skip
  // verification entirely and this test would pass while proving nothing.
  const entry = freeEntry(sha256Hex(payload));
  const { store, fs, fetcher } = storeFor([entry]);
  fetcher.sources.set(FREE_URL, payload);

  const target = await store.fetch(entry);
  assert.equal(target, "media/free.iso");
  assert.deepEqual(fs.files.get(target), payload, "the bytes arrived whole");
  assert.deepEqual(fs.seeds(".part"), [], "the partial file did not survive the rename");

  const first = fetcher.requests[0];
  assert.ok(first, "the transfer was opened once");
  assert.equal(first.url, FREE_URL);
  assert.equal(first.options.chunkSize, MEDIA_CHUNK);
  assert.equal(first.options.timeoutSeconds, DOWNLOAD_TIMEOUT_SECONDS);

  // Called again — from a setup path that runs twice — it must not re-download.
  const again = await store.fetch(entry);
  assert.equal(again, target);
  assert.equal(fetcher.requests.length, 1, "the second fetch made no request");
});

test("media: a checksum mismatch fails the download and leaves nothing behind", async () => {
  const entry = freeEntry("0".repeat(64));
  const { store, fs, fetcher } = storeFor([entry]);
  fetcher.sources.set(FREE_URL, new Uint8Array([1, 2, 3]));

  const error = await mediaErrorFrom(() => store.fetch(entry));
  assert.match(error.message, /checksum mismatch/);
  // The point of the rule: a stub that looks fetched is worse than a failure.
  assert.deepEqual(fs.seeds(".iso"), []);
  assert.deepEqual(fs.seeds(".part"), []);
  assert.equal(await store.ready(entry), false);
});

test("media: the verification can be waived, and then the file is accepted as-is", async () => {
  // `verify: false` exists for an operator fetching media whose manifest has no
  // checksum yet. It is a deliberate escape hatch, so it is pinned rather than left
  // to be discovered as an accident.
  const entry = freeEntry("0".repeat(64));
  const { store, fs, fetcher } = storeFor([entry]);
  fetcher.sources.set(FREE_URL, new Uint8Array([1, 2, 3]));

  const target = await store.fetch(entry, { verify: false });
  assert.deepEqual(fs.files.get(target), new Uint8Array([1, 2, 3]));
});

test("media: fetching licensed media is refused, naming the file and the directory", async () => {
  const { store, fs, fetcher } = storeFor([LICENSED]);

  const error = await mediaErrorFrom(() => store.fetch(LICENSED));
  assert.match(error.message, /operator-supplied/);
  assert.ok(error.message.includes(store.root));
  assert.equal(fetcher.requests.length, 0, "nothing was even asked for");
  assert.deepEqual(fs.seeds(".iso"), []);
});

test("media: an image entry has nothing to download", async () => {
  const image = entry({
    id: "image-entry",
    imageAlias: "images:alpine/3.21",
    media: { source: "free", kind: "image", filename: "images:alpine/3.21" },
  });
  const { store, fetcher } = storeFor([image]);

  const error = await mediaErrorFrom(() => store.fetch(image));
  assert.match(error.message, /nothing to download/);
  assert.equal(fetcher.requests.length, 0);
});

test("media: a failed transfer is reported, and the partial file is removed", async () => {
  // The URL is not in the fetcher's sources: this is the transfer that dies halfway.
  const { store, fs } = storeFor([freeEntry()]);

  const error = await mediaErrorFrom(() => store.fetch(freeEntry()));
  assert.match(error.message, /could not download/);
  assert.match(error.message, /could not reach/);
  assert.deepEqual(fs.seeds(".part"), [], "a half-written file is not left under an .iso name");
});

test("media: fetchable lists only what a media fetch could actually fetch", async () => {
  const image = entry({
    id: "image-entry",
    imageAlias: "images:alpine/3.21",
    media: { source: "free", kind: "image", filename: "images:alpine/3.21" },
  });
  const freeWithoutUrl = entry({
    id: "free-no-url",
    media: { source: "free", filename: "free-no-url.iso" },
  });
  const { store } = storeFor([freeEntry(), LICENSED, image, freeWithoutUrl]);

  const fetchable = await store.fetchable();
  assert.deepEqual(
    fetchable.map((row) => row.id),
    ["free-iso"],
  );
});

/* -------------------------------------------------------------------------- */
/*  The pieces the fetch is built from                                        */
/* -------------------------------------------------------------------------- */

test("media: the checksum helper agrees with the digest everyone else computes", () => {
  // The same vector the Python's `test_sha256_file_helper` uses, so the port is pinned
  // against a number nobody here calculated.
  assert.equal(
    sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("media: rechunk emits whole blocks and one remainder, in order", async () => {
  // This is `shutil.copyfileobj(..., length)` in the other direction: the block size is
  // the caller's decision, and nothing may be lost or reordered at a boundary.
  const input = new Uint8Array(2500);
  for (let index = 0; index < input.byteLength; index += 1) input[index] = index % 251;

  const parts: Uint8Array[] = [];
  const stream = piecesOf([input.subarray(0, 300), input.subarray(300, 1000), input.subarray(1000)]);
  for await (const part of rechunk(stream, 1024)) parts.push(part);

  assert.deepEqual(
    parts.map((part) => part.byteLength),
    [1024, 1024, 452],
  );
  const rejoined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    rejoined.set(part, offset);
    offset += part.byteLength;
  }
  assert.deepEqual(rejoined, input);
});

test("media: rechunk refuses a block size that would never flush", async () => {
  const error = await mediaErrorFrom(() => drain(rechunk(piecesOf([new Uint8Array([1])]), 0)));
  assert.match(error.message, /chunk size must be a positive number/);
});

test("media: sizes are printed the way the lab prints them", () => {
  assert.equal(mediaSizeHuman(0), "0 B");
  assert.equal(mediaSizeHuman(512), "512 B");
  assert.equal(mediaSizeHuman(1023), "1023 B", "bytes truncate rather than round");
  assert.equal(mediaSizeHuman(1536), "1.5 KiB");
  assert.equal(mediaSizeHuman(MEDIA_CHUNK), "1.0 MiB");
  assert.equal(mediaSizeHuman(1024 ** 3), "1.0 GiB");
});
