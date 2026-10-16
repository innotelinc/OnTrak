import zlib from "node:zlib";

/**
 * A zip writer, for the tests that read zips.
 *
 * `src/zip.ts` is a reader, and a reader can only be tested against archives that
 * are *actually* zips — a hand-rolled fixture that the reader's own assumptions
 * happen to match proves nothing. So this writes the format properly: local
 * headers, a central directory, an end-of-central-directory record, ZIP64 where it
 * is asked for, and the stored and deflated methods both. It is deliberately
 * independent of the reader, down to its own CRC-32 (a plain bit-at-a-time loop
 * rather than the reader's table), so a mistake in one cannot hide behind the same
 * mistake in the other.
 *
 * The knobs exist because the *interesting* cases are the malformed ones: a name
 * that climbs out, a size that lies, a CRC that does not match, an entry that is
 * encrypted, a method nothing here implements, and a directory that only ZIP64 can
 * describe. A fixture that could only write healthy archives would leave every one
 * of those untested.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

export const MODE_FILE = 0o100644;
export const MODE_DIRECTORY = 0o040755;
export const MODE_SYMLINK = 0o120777;

export interface FixtureEntry {
  /** The name exactly as it appears, including a trailing slash for a directory. */
  name: string;
  data?: Buffer | string;
  /** 0 is stored, 8 (the default) is deflated. Anything else is "unsupported". */
  method?: number;
  /** General-purpose flag bits. `0x0001` is "encrypted". */
  flags?: number;
  /** Override the CRC the central directory claims. */
  crc?: number;
  /** The Unix mode in the external attributes. Defaults by trailing slash. */
  mode?: number;
  /** Put this entry's sizes and offset in a ZIP64 extra field. */
  zip64?: boolean;
  /** Claim this uncompressed size instead of the real one. */
  declaredSize?: number;
}

export interface ZipFixtureOptions {
  /** Write the end-of-central-directory record in its ZIP64 form. */
  zip64Directory?: boolean;
  /** A trailing archive comment. */
  comment?: string;
}

/** CRC-32, bit at a time — the reader's table is not reused on purpose. */
export function crc32Bitwise(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip64Extra(values: number[]): Buffer {
  const body = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => body.writeBigUInt64LE(BigInt(value), index * 8));
  const extra = Buffer.alloc(4 + body.length);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(body.length, 2);
  body.copy(extra, 4);
  return extra;
}

export function buildZip(entries: FixtureEntry[], options: ZipFixtureOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const method = entry.method ?? 8;
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? "", "utf8");
    const deflated = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = entry.crc ?? crc32Bitwise(data);
    const unixMode = entry.mode ?? (entry.name.endsWith("/") ? MODE_DIRECTORY : MODE_FILE);
    const zip64 = entry.zip64 === true;

    const localExtra = zip64 ? zip64Extra([data.length, deflated.length]) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(zip64 ? 0xffffffff : deflated.length, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    parts.push(local, name, localExtra, deflated);

    const centralExtra = zip64
      ? zip64Extra([data.length, deflated.length, offset])
      : Buffer.alloc(0);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(SIG_CENTRAL, 0);
    head.writeUInt16LE(0x031e, 4);
    head.writeUInt16LE(45, 6);
    head.writeUInt16LE(entry.flags ?? 0, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt16LE(0, 12);
    head.writeUInt16LE(0x21, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(zip64 ? 0xffffffff : deflated.length, 20);
    head.writeUInt32LE(zip64 ? 0xffffffff : (entry.declaredSize ?? data.length), 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt16LE(centralExtra.length, 30);
    head.writeUInt16LE(0, 32);
    head.writeUInt16LE(0, 34);
    head.writeUInt16LE(0, 36);
    // `>>> 0` because a Unix mode shifted into the high half is negative as a
    // signed 32-bit integer, which `writeUInt32LE` refuses.
    head.writeUInt32LE((unixMode << 16) >>> 0, 38);
    head.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    central.push(head, name, centralExtra);

    offset += local.length + name.length + localExtra.length + deflated.length;
  }

  const directory = Buffer.concat(central);
  const comment = Buffer.from(options.comment ?? "", "utf8");
  const zip64 = options.zip64Directory === true;

  const record = Buffer.alloc(56);
  record.writeUInt32LE(SIG_ZIP64_EOCD, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeUInt32LE(0, 16);
  record.writeUInt32LE(0, 20);
  record.writeBigUInt64LE(BigInt(zip64 ? entries.length : 0), 24);
  record.writeBigUInt64LE(BigInt(zip64 ? entries.length : 0), 32);
  record.writeBigUInt64LE(BigInt(directory.length), 40);
  record.writeBigUInt64LE(BigInt(offset), 48);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
  locator.writeUInt32LE(0, 4);
  locator.writeBigUInt64LE(BigInt(zip64 ? offset + directory.length : 0), 8);
  locator.writeUInt32LE(1, 16);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  eocd.writeUInt16LE(comment.length, 20);

  return Buffer.concat([
    ...parts,
    directory,
    ...(zip64 ? [record, locator] : []),
    eocd,
    comment,
  ]);
}
