import zlib from "node:zlib";

import { safeArchivePath } from "./project-archive.js";

/**
 * Reading a `.zip`, without a dependency.
 *
 * Somebody's project usually arrives as a zip: an export from their desk, a
 * "Download ZIP" from a forge, an archive of a folder. Everything else in this
 * product works on a *directory*, so the one thing this module has to do is turn
 * one into the other — safely, and without being talked into anything.
 *
 * WHY THERE IS NO LIBRARY HERE
 * ---------------------------
 * This deployment ships no runtime dependencies (see `package.json`): the console
 * is `node` and the standard library, and a zip is a container format with a
 * published layout rather than an algorithm. The whole reader is the central
 * directory plus `zlib.inflateRawSync`, which node already carries — so the cost
 * of a library (a supply chain, a version to track, a bundling question) buys
 * nothing but convenience.
 *
 * WHAT IT REFUSES, AND WHY EACH IS A REFUSAL RATHER THAN A GUESS
 * -------------------------------------------------------------
 *   * **A name that leaves the project.** Every path goes through the *same*
 *     fence a project bundle's does (`safeArchivePath`), so `../../etc/passwd`,
 *     an absolute path and a Windows drive letter are refused in one place, by
 *     the code the bundle importer already uses. A zip is the classic container
 *     for that attack and there is exactly one rule about it: the entry never
 *     names a path, it names a *file inside the project*.
 *   * **A password.** An encrypted entry cannot be read, and pretending a
 *     half-unpacked project is the project would be worse than saying so.
 *   * **A compression method this reader does not implement** (bzip2, LZMA,
 *     zstd, and the shrink/reduce family). Refused by name, so the message can
 *     say which tool would open it.
 *   * **A corrupted entry.** Every file's CRC-32 and its claimed length are
 *     checked against what was actually unpacked, so a truncated download is
 *     reported as one rather than imported as a project of mangled files.
 *   * **More than the deployment will unpack.** A zip is bounded three ways
 *     before anything is written: the upload's own size, the number of entries,
 *     and the total uncompressed size. The last is the one that matters — a
 *     "zip bomb" is small on the wire and enormous out of it, and a decompressor
 *     that is only bounded on the way in is not bounded at all. Each entry is
 *     inflated with `maxOutputLength` set to the size the zip *claims*, so the
 *     lie is where it stops, not after the memory was spent.
 *
 * A symlink entry is not refused, it is *named* (`skipped`): an archive of a
 * project tree commonly holds one, and a link is a promise about where something
 * is, which is exactly what this deployment cannot carry — the same decision the
 * bundle exporter makes in `project-archive.ts`.
 *
 * ZIP64 is read (the locator, the record, and the per-entry extra field), because
 * a project with a lot of files crosses the 16-bit entry count or a 4 GiB offset
 * without being unusual — and "this zip is too big for me" is a poor answer to a
 * perfectly ordinary archive.
 */

export class ZipError extends Error {}

/** The largest upload this reader is given, enforced by the server as well. */
export const MAX_ZIP_BYTES = 160 * 1024 * 1024;
/** The most entries one archive may list. */
export const MAX_ZIP_ENTRIES = 20_000;
/** The most *uncompressed* bytes one archive may expand to. */
export const MAX_ZIP_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

/** The flag bits that change how an entry is read. */
const FLAG_ENCRYPTED = 0x0001;

/** Compression methods, by the numbers the format assigns them. */
const METHOD_NAMES: Record<number, string> = {
  0: "stored",
  1: "shrunk",
  6: "imploded",
  8: "deflated",
  9: "deflate64",
  12: "bzip2",
  14: "LZMA",
  93: "zstd",
  95: "xz",
  98: "ppmd",
};

export interface ZipFile {
  /** Project-relative, forward-slashed, never absolute and never climbs out. */
  path: string;
  content: Buffer;
}

export interface ZipArchive {
  files: ZipFile[];
  /** Directory entries, which may be empty. Sorted, project-relative. */
  directories: string[];
  /** Entries deliberately left out because they are links rather than files. */
  skipped: string[];
}

export interface ZipReadOptions {
  /** Defaults to `MAX_ZIP_ENTRIES`. */
  maxEntries?: number;
  /** Defaults to `MAX_ZIP_UNCOMPRESSED_BYTES`. */
  maxBytes?: number;
}

function readU16(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset);
}

function readU32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

/** A 64-bit field, refused when it is larger than this program can address. */
function readU64(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipError("this zip is larger than this deployment can address");
  }
  return Number(value);
}

/**
 * Where the end-of-central-directory record is.
 *
 * Scanned backwards from the end because that is the only place it can be — but
 * the scan is *checked*: a record whose comment length does not reach exactly to
 * the end of the file is a coincidence of bytes rather than the record, and a
 * candidate that only nearly fits is kept as a fallback for the writers that pad
 * an archive. Returning `-1` is the honest answer for something that is not a
 * zip at all, and the caller says that rather than a signature number.
 */
function findEocd(buffer: Buffer): number {
  if (buffer.length < EOCD_MIN) return -1;
  const lowest = Math.max(0, buffer.length - EOCD_MIN - MAX_COMMENT);
  let loose = -1;
  for (let offset = buffer.length - EOCD_MIN; offset >= lowest; offset -= 1) {
    if (readU32(buffer, offset) !== SIG_EOCD) continue;
    const commentLength = readU16(buffer, offset + 20);
    if (offset + EOCD_MIN + commentLength === buffer.length) return offset;
    if (loose === -1) loose = offset;
  }
  return loose;
}

/** The 64-bit counts, when the 32-bit record says "look elsewhere". */
function readZip64Directory(
  buffer: Buffer,
  eocd: number,
): { total: number; cdSize: number; cdOffset: number } {
  const locator = eocd - 20;
  if (locator < 0 || readU32(buffer, locator) !== SIG_ZIP64_LOCATOR) {
    throw new ZipError("this zip claims ZIP64 sizes but carries no ZIP64 record");
  }
  const record = readU64(buffer, locator + 8);
  if (record + 56 > buffer.length || readU32(buffer, record) !== SIG_ZIP64_EOCD) {
    throw new ZipError("this zip's ZIP64 record is missing or truncated");
  }
  return {
    total: readU64(buffer, record + 32),
    cdSize: readU64(buffer, record + 40),
    cdOffset: readU64(buffer, record + 48),
  };
}

/**
 * The values a ZIP64 extra field overrides.
 *
 * The fields appear in a fixed order and only for the ones the 32-bit record
 * could not hold, which is why this walks them rather than reading a fixed
 * layout: an archive may be ZIP64 for its *offset* alone.
 */
function readZip64Extra(
  buffer: Buffer,
  start: number,
  length: number,
  current: { uncompressedSize: number; compressedSize: number; localOffset: number },
): { uncompressedSize: number; compressedSize: number; localOffset: number } {
  const end = start + length;
  let cursor = start;
  while (cursor + 4 <= end) {
    const id = readU16(buffer, cursor);
    const size = readU16(buffer, cursor + 2);
    const body = cursor + 4;
    if (body + size > end) return current;
    if (id === 0x0001) {
      const result = { ...current };
      let field = body;
      if (current.uncompressedSize === 0xffffffff && field + 8 <= body + size) {
        result.uncompressedSize = readU64(buffer, field);
        field += 8;
      }
      if (current.compressedSize === 0xffffffff && field + 8 <= body + size) {
        result.compressedSize = readU64(buffer, field);
        field += 8;
      }
      if (current.localOffset === 0xffffffff && field + 8 <= body + size) {
        result.localOffset = readU64(buffer, field);
      }
      return result;
    }
    cursor = body + size;
  }
  return current;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32, as the format specifies it. What proves an entry came back whole. */
export function crc32(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * Read every file out of an archive.
 *
 * Nothing is written and nothing is trusted: the result is a list of safe,
 * project-relative paths with their bytes, and the caller decides what to do
 * with them. That split is what makes this testable without a filesystem, and it
 * is what keeps the fence (the path check) in the one place a caller cannot
 * forget to apply it.
 */
export function readZipArchive(input: Buffer, options: ZipReadOptions = {}): ZipArchive {
  const maxEntries = options.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxBytes = options.maxBytes ?? MAX_ZIP_UNCOMPRESSED_BYTES;

  const buffer = input;
  if (buffer.length < EOCD_MIN) {
    throw new ZipError("that file is not a zip archive: it is too short to be one");
  }

  const eocd = findEocd(buffer);
  if (eocd === -1) {
    throw new ZipError("that file is not a zip archive: it has no end-of-central-directory record");
  }

  let total = readU16(buffer, eocd + 10);
  let cdSize = readU32(buffer, eocd + 12);
  let cdOffset = readU32(buffer, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    ({ total, cdSize, cdOffset } = readZip64Directory(buffer, eocd));
  }

  if (total > maxEntries) {
    throw new ZipError(`this zip lists ${total} entries, more than the ${maxEntries} this deployment will unpack`);
  }
  if (cdOffset + cdSize > buffer.length) {
    throw new ZipError("this zip's central directory runs past the end of the file");
  }

  const files: ZipFile[] = [];
  const directories: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let uncompressedTotal = 0;
  let offset = cdOffset;

  for (let index = 0; index < total; index += 1) {
    if (offset + 46 > buffer.length) {
      throw new ZipError("this zip's central directory is truncated");
    }
    if (readU32(buffer, offset) !== SIG_CENTRAL) {
      throw new ZipError("this zip's central directory is damaged");
    }

    const flags = readU16(buffer, offset + 8);
    const method = readU16(buffer, offset + 10);
    const checksum = readU32(buffer, offset + 16);
    let compressedSize = readU32(buffer, offset + 20);
    let uncompressedSize = readU32(buffer, offset + 24);
    const nameLength = readU16(buffer, offset + 28);
    const extraLength = readU16(buffer, offset + 30);
    const commentLength = readU16(buffer, offset + 32);
    const externalAttributes = readU32(buffer, offset + 38);
    let localOffset = readU32(buffer, offset + 42);

    const nameStart = offset + 46;
    if (nameStart + nameLength + extraLength + commentLength > buffer.length) {
      throw new ZipError("this zip's central directory is truncated");
    }
    const rawName = buffer.toString("utf8", nameStart, nameStart + nameLength);

    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      ({ uncompressedSize, compressedSize, localOffset } = readZip64Extra(
        buffer,
        nameStart + nameLength,
        extraLength,
        { uncompressedSize, compressedSize, localOffset },
      ));
    }

    // The next entry starts after this one's variable-length fields.
    offset = nameStart + nameLength + extraLength + commentLength;

    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new ZipError("this zip is password-protected; unpack it first and upload the project itself");
    }

    const isDirectory = rawName.endsWith("/");
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const isSymlink = (unixMode & 0xf000) === 0xa000;

    // One fence for both halves of an entry's name, and the same fence a project
    // bundle's paths go through.
    let rel: string;
    try {
      rel = safeArchivePath(isDirectory ? rawName.replace(/\/+$/g, "") : rawName);
    } catch {
      throw new ZipError(`this zip names an entry outside the project: ${rawName}`);
    }

    if (seen.has(rel)) throw new ZipError(`this zip lists “${rel}” twice`);
    seen.add(rel);

    if (isSymlink) {
      skipped.push(rel);
      continue;
    }
    if (isDirectory) {
      directories.push(rel);
      continue;
    }

    if (method !== 0 && method !== 8) {
      const named = METHOD_NAMES[method];
      throw new ZipError(
        `this zip stores “${rel}” with ${named === undefined ? `compression method ${method}` : named} compression, which this deployment cannot unpack`,
      );
    }
    if (uncompressedSize > maxBytes - uncompressedTotal) {
      throw new ZipError(
        `this zip unpacks to more than the ${Math.round(maxBytes / (1024 * 1024))} MB this deployment will unpack`,
      );
    }

    if (localOffset + 30 > buffer.length || readU32(buffer, localOffset) !== SIG_LOCAL) {
      throw new ZipError(`this zip's entry for “${rel}” has no local header`);
    }
    const dataStart = localOffset + 30 + readU16(buffer, localOffset + 26) + readU16(buffer, localOffset + 28);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      throw new ZipError(`this zip is truncated inside “${rel}”`);
    }

    const raw = buffer.subarray(dataStart, dataEnd);
    let content: Buffer;
    if (method === 0) {
      content = Buffer.from(raw);
    } else {
      try {
        // `maxOutputLength` is the claim, so a written-down lie about the size
        // cannot spend the memory it promised.
        content = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(uncompressedSize, 1) });
      } catch (error) {
        throw new ZipError(`“${rel}” could not be unpacked: ${(error as Error).message}`);
      }
    }

    if (content.length !== uncompressedSize) {
      throw new ZipError(
        `“${rel}” unpacked to ${content.length} bytes, not the ${uncompressedSize} this zip claims`,
      );
    }
    if (crc32(content) !== checksum) {
      throw new ZipError(`“${rel}” failed its checksum, so this zip is corrupted`);
    }

    uncompressedTotal += content.length;
    files.push({ path: rel, content });
  }

  directories.sort((a, b) => a.localeCompare(b));
  return { files, directories, skipped };
}
