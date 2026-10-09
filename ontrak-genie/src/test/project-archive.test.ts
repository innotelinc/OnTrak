import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Project bundles.
 *
 * The things worth pinning are the ones that would be a *quiet* bug: a path in a
 * loaded bundle that climbs out of the project, a binary file that comes back as
 * replacement characters, and a bundle that claims a project can be moved when
 * something was silently left behind. The rest is bookkeeping.
 *
 * Env is set before any module reads the config, exactly as `projects.test.ts`
 * does, so the sandbox and the per-account registry land in a scratch directory.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "project-archive-test-"));
process.env.AGENT_WORKSPACE = path.join(scratch, "workspace");
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");

const {
  archiveFileName,
  encodeArchive,
  exportProject,
  importProject,
  parseArchive,
  ProjectArchiveError,
  safeArchivePath,
} = await import("../project-archive.js");
const { createProject, deleteProject, listProjects } = await import("../projects.js");
const { sandboxRoot } = await import("../scope.js");

test("a bundle path is data, not a path to trust", () => {
  // The benign case is normalized, not merely accepted.
  assert.equal(safeArchivePath("src/app.js"), "src/app.js");
  assert.equal(safeArchivePath("src\\app.js"), "src/app.js");

  for (const bad of ["../etc/passwd", "/etc/passwd", "C:\\Windows\\x", "a//b", "a/./b", "a/../b", "", "   ", null, 42]) {
    assert.throws(() => safeArchivePath(bad), ProjectArchiveError, `should refuse ${JSON.stringify(bad)}`);
  }
});

test("a download filename is a slug, never a traversal", () => {
  assert.equal(archiveFileName("My App"), "my-app.genie-project.json");
  assert.equal(archiveFileName("../../etc/passwd"), "etc-passwd.genie-project.json");
  assert.equal(archiveFileName(""), "project.genie-project.json");
});

test("parsing a bundle normalizes it and refuses the rest", () => {
  const archive = {
    format: "genie.project",
    version: 1,
    name: "  My   App ",
    description: "a note",
    exportedAt: "2026-01-01T00:00:00.000Z",
    files: [{ path: "index.js", encoding: "utf8", content: "console.log(1);\n" }],
    skipped: ["node_modules"],
  };

  const encoded = encodeArchive(archive as never);
  const parsed = parseArchive(encoded);
  assert.equal(parsed.name, "My App", "the name is flattened");
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0]?.path, "index.js");
  assert.equal(parsed.exportedAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(parsed.skipped, ["node_modules"]);

  // The object form is accepted too, since the console parses the file itself.
  assert.equal(parseArchive(archive).files.length, 1);

  assert.throws(() => parseArchive("not json"), ProjectArchiveError);
  assert.throws(() => parseArchive({ format: "something.else", version: 1, files: [] }), ProjectArchiveError);
  assert.throws(() => parseArchive({ format: "genie.project", version: 99, files: [] }), ProjectArchiveError);
  assert.throws(() => parseArchive({ format: "genie.project", version: 1 }), ProjectArchiveError);
  assert.throws(
    () =>
      parseArchive({
        format: "genie.project",
        version: 1,
        files: [
          { path: "a.js", encoding: "utf8", content: "1" },
          { path: "a.js", encoding: "utf8", content: "2" },
        ],
      }),
    ProjectArchiveError,
    "the same path twice is ambiguous, not a merge",
  );
  assert.throws(
    () => parseArchive({ format: "genie.project", version: 1, files: [{ path: "../x", encoding: "utf8", content: "1" }] }),
    ProjectArchiveError,
  );
  assert.throws(
    () => parseArchive({ format: "genie.project", version: 1, files: [{ path: "a.js", encoding: "utf8" }] }),
    ProjectArchiveError,
  );
});

test("a project exports to a bundle and loads back byte-for-byte", async (t) => {
  await t.beforeEach(async () => {
    for (const project of await listProjects()) await deleteProject(project.id, true);
  });

  await t.test("text and binary files survive the round trip, and the heavy directories are named", async () => {
    const project = await createProject({ name: "Alpha", description: "the first" });
    const dir = path.join(sandboxRoot(), project.dir);
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "index.js"), "export const x = 1;\n", "utf8");
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]);
    await fs.writeFile(path.join(dir, "logo.png"), binary);
    // The directories the file tree already ignores must be skipped *and named*.
    await fs.mkdir(path.join(dir, "node_modules", "left-pad"), { recursive: true });
    await fs.writeFile(path.join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    await fs.writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");

    const exported = await exportProject(project);
    assert.equal(exported.filename, "alpha.genie-project.json");
    assert.equal(exported.archive.name, "Alpha");
    assert.equal(exported.archive.description, "the first");

    const paths = exported.archive.files.map((file) => file.path).sort();
    assert.deepEqual(paths, ["logo.png", "src/index.js"]);
    assert.equal(exported.archive.skipped.includes("node_modules"), true);
    assert.equal(exported.archive.skipped.includes(".git"), true);

    // A new project, not the same one: the name is taken, so import counts.
    const importResult = await importProject(parseArchive(exported.content));
    assert.equal(importResult.project.name, "Alpha (2)");
    assert.equal(importResult.project.dir === project.dir, false, "a fresh directory");
    assert.equal(importResult.files, 2);

    const landed = path.join(sandboxRoot(), importResult.project.dir);
    assert.equal(await fs.readFile(path.join(landed, "src", "index.js"), "utf8"), "export const x = 1;\n");
    assert.equal((await fs.readFile(path.join(landed, "logo.png"))).equals(binary), true);
    // The skipped directory is named in the bundle, not carried in it.
    await assert.rejects(() => fs.stat(path.join(landed, "node_modules")));
  });

  await t.test("a name can be chosen on the way in", async () => {
    const project = await createProject({ name: "Beta" });
    await fs.writeFile(path.join(sandboxRoot(), project.dir, "readme.md"), "# beta\n", "utf8");

    const exported = await exportProject(project);
    const importResult = await importProject(parseArchive(exported.content), { name: "Loaded Beta" });
    assert.equal(importResult.project.name, "Loaded Beta");
    assert.equal(await fs.readFile(path.join(sandboxRoot(), importResult.project.dir, "readme.md"), "utf8"), "# beta\n");
  });

  await t.test("exporting a project whose folder is gone says so", async () => {
    const project = await createProject({ name: "Ghost" });
    await fs.rm(path.join(sandboxRoot(), project.dir), { recursive: true, force: true });
    await assert.rejects(() => exportProject(project), ProjectArchiveError);
  });
});
