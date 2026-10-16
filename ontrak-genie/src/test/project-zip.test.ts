import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * A zip as a project.
 *
 * The pure half (`planZipImport`) is where the product decisions are, so most of
 * this pins *that*: which wrapping folder is stripped, what is left out, and what a
 * project with no name of its own is called. The other half writes to disk, and the
 * assertions there are the ones a quiet bug would hide in — that the files are
 * really on disk, that the ignored directories really are not, and that loading the
 * same archive twice does not overwrite the first.
 *
 * Env is set before any module reads the config, exactly as `project-archive.test.ts`
 * does, so the sandbox and the per-account registry land in a scratch directory.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "project-zip-test-"));
process.env.AGENT_WORKSPACE = path.join(scratch, "workspace");
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");

const { importZipProject, planZipImport, zipProjectName } = await import("../project-zip.js");
const { deleteProject, listProjects } = await import("../projects.js");
const { sandboxRoot } = await import("../scope.js");
const { ZipError } = await import("../zip.js");
const { buildZip } = await import("./zip-fixture.js");

type Archive = Parameters<typeof planZipImport>[0];

function archiveOf(entries: { name: string; data?: string }[]): Archive {
  return {
    files: entries
      .filter((entry) => !entry.name.endsWith("/"))
      .map((entry) => ({ path: entry.name, content: Buffer.from(entry.data ?? "x", "utf8") })),
    directories: entries.filter((entry) => entry.name.endsWith("/")).map((entry) => entry.name.replace(/\/$/, "")),
    skipped: [],
  };
}

test("a wrapping folder is stripped, and only a common one", () => {
  const wrapped = planZipImport(
    archiveOf([
      { name: "widgets-main/package.json", data: "{}" },
      { name: "widgets-main/src/index.js" },
      { name: "widgets-main/readme.md" },
    ]),
  );
  assert.equal(wrapped.root, "widgets-main");
  assert.deepEqual(
    wrapped.files.map((file) => file.path).sort(),
    ["package.json", "readme.md", "src/index.js"],
  );

  // Two projects side by side: choosing one would be this function guessing.
  const sideBySide = planZipImport(
    archiveOf([
      { name: "one/package.json", data: "{}" },
      { name: "two/package.json", data: "{}" },
    ]),
  );
  assert.equal(sideBySide.root, null);
  assert.deepEqual(sideBySide.files.map((file) => file.path).sort(), ["one/package.json", "two/package.json"]);

  // A file at the root means the first segment is a name, not a folder.
  const flat = planZipImport(archiveOf([{ name: "readme.md" }, { name: "src/index.js" }]));
  assert.equal(flat.root, null);

  // A single file inside one folder is still a wrapped folder.
  const one = planZipImport(archiveOf([{ name: "only/thing.txt" }]));
  assert.equal(one.root, "only");
  assert.deepEqual(one.files.map((file) => file.path), ["thing.txt"]);
});

test("the directories the console ignores are skipped and named", () => {
  const plan = planZipImport(
    archiveOf([
      { name: "app/package.json", data: "{}" },
      { name: "app/node_modules/left-pad/index.js" },
      { name: "app/.git/config" },
      { name: "app/dist/bundle.js" },
      { name: "app/.agent/sessions/x.json" },
    ]),
  );
  assert.deepEqual(plan.files.map((file) => file.path), ["package.json"]);
  assert.deepEqual(
    plan.skipped.map((entry) => entry.path).sort(),
    ["app/.agent/sessions/x.json", "app/.git/config", "app/dist/bundle.js", "app/node_modules/left-pad/index.js"],
  );
});

test("the uploading machine's litter is dropped without being reported", () => {
  const plan = planZipImport(
    archiveOf([
      { name: "app/index.js" },
      { name: "__MACOSX/app/._index.js" },
      { name: "app/.DS_Store" },
      { name: "app/Thumbs.db" },
      { name: "app/desktop.ini" },
    ]),
  );
  assert.deepEqual(
    plan.files.map((file) => file.path),
    ["index.js"],
  );
  assert.deepEqual(plan.skipped, [], "not the uploader's laptop: their project");
});

test("a project is named by what was chosen, then the folder, then generically", () => {
  assert.equal(zipProjectName({ name: "  Chosen  ", root: "widgets-main" }), "Chosen");
  assert.equal(zipProjectName({ name: "", root: "widgets-main" }), "widgets-main");
  assert.equal(zipProjectName({ root: null }), "imported project");
  assert.equal(zipProjectName({ root: "   " }), "imported project");
});

test("an uploaded zip becomes a project you can work in", async (t) => {
  await t.beforeEach(async () => {
    for (const project of await listProjects()) await deleteProject(project.id, true);
  });

  await t.test("the files land, the ignored directories do not, and the name comes from the folder", async () => {
    const zip = buildZip([
      { name: "widgets-main/", data: "" },
      { name: "widgets-main/package.json", data: '{"name":"widgets"}\n' },
      { name: "widgets-main/src/index.js", data: "export const x = 1;\n" },
      { name: "widgets-main/node_modules/left-pad/index.js", data: "module.exports = 1;\n" },
      { name: "widgets-main/logo.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]) },
    ]);

    const imported = await importZipProject(zip, { open: true });
    assert.equal(imported.project.name, "widgets-main");
    assert.equal(imported.root, "widgets-main");
    assert.equal(imported.files, 3);
    assert.equal(imported.files, imported.paths.length);

    const dir = path.join(sandboxRoot(), imported.project.dir);
    assert.equal(
      await fs.readFile(path.join(dir, "package.json"), "utf8"),
      '{"name":"widgets"}\n',
    );
    assert.equal(await fs.readFile(path.join(dir, "src", "index.js"), "utf8"), "export const x = 1;\n");
    assert.equal((await fs.readFile(path.join(dir, "logo.png"))).subarray(0, 4).toString("hex"), "89504e47");
    await assert.rejects(() => fs.stat(path.join(dir, "node_modules")), "dependencies are not the project");
  });

  await t.test("a name can be chosen, and the same archive twice is two projects", async () => {
    const zip = buildZip([{ name: "app/index.js", data: "one\n" }]);
    const first = await importZipProject(zip, { name: "My App", description: "from a zip" });
    assert.equal(first.project.name, "My App");
    assert.equal(first.project.description, "from a zip");

    const second = await importZipProject(zip, { name: "My App" });
    assert.equal(second.project.name, "My App (2)");
    assert.equal(second.project.dir === first.project.dir, false);

    // With no name, the stripped folder names it — and that name is free, so it is
    // not counted up for no reason.
    assert.equal((await importZipProject(zip)).project.name, "app");

    // The first project is untouched by the second.
    assert.equal(
      await fs.readFile(path.join(sandboxRoot(), first.project.dir, "index.js"), "utf8"),
      "one\n",
    );
  });

  await t.test("an archive with nothing to work in says so rather than making a project", async () => {
    const ignoredOnly = buildZip([{ name: "app/node_modules/left-pad/index.js", data: "x" }]);
    await assert.rejects(() => importZipProject(ignoredOnly), ZipError);

    const empty = buildZip([{ name: "app/", data: "" }]);
    await assert.rejects(() => importZipProject(empty), ZipError);
  });

  await t.test("a hostile archive is refused before a project is made", async () => {
    const hostile = buildZip([
      { name: "app/index.js", data: "ok\n" },
      { name: "../../escape.txt", data: "no\n" },
    ]);
    await assert.rejects(() => importZipProject(hostile), ZipError);
    assert.deepEqual(await listProjects(), [], "no half-made project is left behind");
  });
});
