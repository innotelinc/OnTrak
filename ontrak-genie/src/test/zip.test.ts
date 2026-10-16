import assert from "node:assert/strict";
import test from "node:test";

/**
 * Reading a zip.
 *
 * The assertions that matter are the refusals. A reader that unpacks a healthy
 * archive is table stakes; a reader that unpacks `../../etc/passwd`, a corrupted
 * download, or a small file that expands to a gigabyte is the bug this module
 * exists to prevent — so most of what follows builds a *deliberately wrong*
 * archive and pins the refusal, message and all.
 */
import { crc32, readZipArchive, ZipError } from "../zip.js";
import { buildZip, crc32Bitwise, MODE_FILE, MODE_SYMLINK } from "./zip-fixture.js";

const paths = (archive: ReturnType<typeof readZipArchive>): string[] =>
  archive.files.map((file) => file.path).sort();

test("crc32 matches the reference vector", () => {
  // The standard check value for CRC-32 ("123456789"), so a table that is subtly
  // wrong cannot agree with itself and pass.
  assert.equal(crc32(Buffer.from("123456789", "utf8")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
  assert.equal(crc32Bitwise(Buffer.from("123456789", "utf8")), crc32(Buffer.from("123456789", "utf8")));
});

test("a stored entry and a deflated one come back byte for byte", () => {
  const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]);
  const archive = readZipArchive(
    buildZip([
      { name: "src/", data: "", mode: 0o040755 },
      { name: "src/app.js", data: "console.log(1);\n", method: 0 },
      { name: "assets/logo.png", data: binary },
      { name: "README.md", data: "# hi\n" },
    ]),
  );

  assert.deepEqual(paths(archive), ["README.md", "assets/logo.png", "src/app.js"]);
  assert.deepEqual(archive.directories, ["src"]);
  const byPath = new Map(archive.files.map((file) => [file.path, file.content]));
  assert.equal(byPath.get("src/app.js")?.toString("utf8"), "console.log(1);\n");
  assert.equal(byPath.get("README.md")?.toString("utf8"), "# hi\n");
  assert.equal(byPath.get("assets/logo.png")?.equals(binary), true, "binary survives exactly");
});

test("a trailing comment does not hide the directory record", () => {
  const archive = readZipArchive(buildZip([{ name: "a.txt", data: "a" }], { comment: "made by something" }));
  assert.deepEqual(paths(archive), ["a.txt"]);
});

test("ZIP64 sizes, offsets and directory are read", () => {
  const withZip64Entry = readZipArchive(
    buildZip([
      { name: "big.txt", data: "some bytes", zip64: true },
      { name: "small.txt", data: "x" },
    ]),
  );
  assert.deepEqual(paths(withZip64Entry), ["big.txt", "small.txt"]);
  assert.equal(withZip64Entry.files.find((file) => file.path === "big.txt")?.content.toString("utf8"), "some bytes");

  const withZip64Directory = readZipArchive(
    buildZip([{ name: "a.txt", data: "a" }, { name: "b.txt", data: "b" }], { zip64Directory: true }),
  );
  assert.deepEqual(paths(withZip64Directory), ["a.txt", "b.txt"]);
});

test("a name that leaves the project is refused", () => {
  for (const name of ["../escape.txt", "/etc/passwd", "../../a/b", "C:\\Windows\\x", "dir/../../x"]) {
    assert.throws(() => readZipArchive(buildZip([{ name, data: "x" }])), ZipError, `should refuse ${name}`);
  }
});

test("an encrypted entry, an unsupported method and a duplicate name are refused", () => {
  assert.throws(
    () => readZipArchive(buildZip([{ name: "secret.txt", data: "x", flags: 0x0001 }])),
    /password-protected/,
  );
  assert.throws(
    () => readZipArchive(buildZip([{ name: "odd.txt", data: "x", method: 12 }])),
    /bzip2/,
  );
  assert.throws(
    () => readZipArchive(buildZip([{ name: "odd.txt", data: "x", method: 99 }])),
    /compression method 99/,
  );
  assert.throws(
    () => readZipArchive(buildZip([{ name: "a.txt", data: "1" }, { name: "a.txt", data: "2" }])),
    /twice/,
  );
});

test("a corrupted entry and a truncated archive are refused", () => {
  // A checksum that does not match the bytes: what a bad download looks like.
  assert.throws(
    () => readZipArchive(buildZip([{ name: "a.txt", data: "hello", crc: 0x12345678 }])),
    /checksum/,
  );

  const good = buildZip([{ name: "a.txt", data: "hello" }]);
  assert.throws(() => readZipArchive(good.subarray(0, good.length - 30)), /not a zip archive|truncated/);

  // Flip a byte in the middle: the archive is intact enough to parse and the
  // *content* is what lies.
  const flipped = Buffer.from(good);
  flipped[30 + 5] = (flipped[30 + 5] ?? 0) ^ 0xff;
  assert.throws(() => readZipArchive(flipped), ZipError);
});

test("a symlink is named rather than unpacked", () => {
  const archive = readZipArchive(
    buildZip([
      { name: "real.txt", data: "x" },
      { name: "link.txt", data: "/etc/passwd", mode: MODE_SYMLINK },
    ]),
  );
  assert.deepEqual(paths(archive), ["real.txt"]);
  assert.deepEqual(archive.skipped, ["link.txt"]);
});

test("the entry count and the unpacked size are bounded", () => {
  const two = buildZip([{ name: "a.txt", data: "a" }, { name: "b.txt", data: "b" }]);
  assert.throws(() => readZipArchive(two, { maxEntries: 1 }), /more than the 1/);

  const big = buildZip([{ name: "a.txt", data: Buffer.alloc(64, 0x61) }]);
  assert.throws(() => readZipArchive(big, { maxBytes: 32 }), /unpacks to more than/);
});

test("an entry whose claimed size is a lie is refused", () => {
  // A claim *smaller* than the truth is stopped by the decompressor itself, which
  // is the point of passing the claim as `maxOutputLength`: the memory is never
  // spent. A claim *larger* than the truth is caught by the length check.
  assert.throws(
    () => readZipArchive(buildZip([{ name: "a.txt", data: "hello", declaredSize: 3 }])),
    /could not be unpacked/,
  );
  assert.throws(
    () => readZipArchive(buildZip([{ name: "a.txt", data: "hello", declaredSize: 10 }])),
    /unpacked to 5 bytes, not the 10 this zip claims/,
  );
});

test("something that is not a zip says so", () => {
  assert.throws(() => readZipArchive(Buffer.alloc(0)), /too short/);
  assert.throws(() => readZipArchive(Buffer.from("hello world", "utf8")), /not a zip archive/);
  assert.throws(() => readZipArchive(Buffer.from('{"format":"genie.project"}', "utf8")), /not a zip archive/);
  assert.throws(
    () => readZipArchive(buildZip([{ name: "a.txt", data: "a" }], { zip64Directory: true }).subarray(0, 40)),
    ZipError,
  );
});

test("a file mode that is not a symlink is still a file", () => {
  const archive = readZipArchive(buildZip([{ name: "run.sh", data: "#!/bin/sh\n", mode: MODE_FILE | 0o755 }]));
  assert.deepEqual(paths(archive), ["run.sh"]);
  assert.deepEqual(archive.skipped, []);
});
