import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Saved workspace projects.
 *
 * The things worth pinning are the ones that would be a *quiet* bug: a name that
 * becomes a path, a delete that takes more than it was asked to, and a registry
 * that claims a directory is there after it is gone. The rest is bookkeeping.
 *
 * Env is set before any module reads the config, exactly as `preview-hosting`
 * does, so the registry lands in a scratch directory.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "projects-test-"));
process.env.AGENT_WORKSPACE = path.join(scratch, "workspace");
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");

const {
  adoptProject,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  normalizeProjectName,
  openProject,
  projectDirName,
  ProjectError,
  updateProject,
} = await import("../projects.js");
const { sandboxRoot, setSelectedWorkspace, selectedWorkspace } = await import("../scope.js");

test("project names", async (t) => {
  await t.test("trims and collapses whitespace", () => {
    assert.equal(normalizeProjectName("  My   App  "), "My App");
  });

  await t.test("a blank or missing name is refused, not invented", () => {
    assert.throws(() => normalizeProjectName("   "), ProjectError);
    assert.throws(() => normalizeProjectName(undefined), ProjectError);
    assert.throws(() => normalizeProjectName(42), ProjectError);
  });

  await t.test("a name longer than the cap is refused", () => {
    assert.throws(() => normalizeProjectName("x".repeat(65)), ProjectError);
  });

  await t.test("a directory name is a slug, never a traversal", () => {
    const id = "3f2504e0-4f89-31d3-9a0c-0305e82c3301";
    assert.equal(projectDirName("../../etc/passwd", id).includes("/"), false);
    assert.equal(projectDirName("..", id).startsWith("project-"), true);
    assert.equal(projectDirName("", id).startsWith("project-"), true);
    // Two names that slugify the same still get different directories, because
    // the digest is over the id rather than the name.
    assert.notEqual(projectDirName("My App", id), projectDirName("my-app", "other-id"));
  });
});

test("the project registry", async (t) => {
  await t.beforeEach(async () => {
    // A clean account each time: remove every project and the workspace tree.
    for (const project of await listProjects()) await deleteProject(project.id, true);
  });

  await t.test("creating one makes the directory and remembers it", async () => {
    const project = await createProject({ name: "Alpha" });
    assert.equal(project.name, "Alpha");
    assert.equal(project.exists, true);

    const abs = path.join(sandboxRoot(), project.dir);
    assert.equal((await fs.stat(abs)).isDirectory(), true);
    // Inside the sandbox, always.
    assert.equal(abs.startsWith(sandboxRoot() + path.sep), true);

    const listed = await listProjects();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.name, "Alpha");
  });

  await t.test("two projects cannot share a name, by case", async () => {
    await createProject({ name: "Alpha" });
    await assert.rejects(() => createProject({ name: "  alpha " }), ProjectError);
  });

  await t.test("opening one makes it the working directory", async () => {
    const project = await createProject({ name: "Beta" });
    await setSelectedWorkspace("");

    const opened = await openProject(project.id);
    assert.equal(opened?.active, true);
    assert.equal(selectedWorkspace(), project.dir);

    const listed = await listProjects(selectedWorkspace());
    assert.equal(listed[0]?.active, true);
  });

  await t.test("renaming changes the label, not the folder", async () => {
    const project = await createProject({ name: "Gamma" });
    const before = project.dir;

    const renamed = await updateProject(project.id, { name: "Gamma Prime" });
    assert.equal(renamed?.name, "Gamma Prime");
    assert.equal(renamed?.dir, before, "the folder keeps its name");

    await createProject({ name: "Delta" });
    await assert.rejects(() => updateProject(project.id, { name: "delta" }), ProjectError);
  });

  await t.test("removing from the list keeps the files", async () => {
    const project = await createProject({ name: "Keep" });
    const abs = path.join(sandboxRoot(), project.dir);

    assert.equal(await deleteProject(project.id, false), true);
    assert.equal(await getProject(project.id), null);
    assert.equal((await fs.stat(abs)).isDirectory(), true, "the directory is untouched");
  });

  await t.test("removing with files deletes the directory and everything in it", async () => {
    const project = await createProject({ name: "Toss" });
    const abs = path.join(sandboxRoot(), project.dir);
    await fs.writeFile(path.join(abs, "notes.txt"), "hello\n");

    assert.equal(await deleteProject(project.id, true), true);
    await assert.rejects(() => fs.stat(abs), "the directory is gone");
  });

  await t.test("a directory deleted out from under the registry is reported, not invented", async () => {
    const project = await createProject({ name: "Ghost" });
    await fs.rm(path.join(sandboxRoot(), project.dir), { recursive: true, force: true });

    const listed = await listProjects();
    const ghost = listed.find((row) => row.id === project.id);
    assert.equal(ghost?.exists, false);
  });

  await t.test("deleting a project that was never there is a no, not a throw", async () => {
    assert.equal(await deleteProject("not-a-project", true), false);
    assert.equal(await updateProject("not-a-project", { name: "x" }), null);
    assert.equal(await openProject("not-a-project"), null);
  });
});

/*
 * Saving a workspace that is not a project yet.
 *
 * The ship button's first half: a terminal has files but no project noun, and
 * publishing needs one. Two shapes worth pinning — a chosen directory becomes a
 * row without moving its files, and the sandbox root (which cannot be a row) is
 * copied into a directory of its own. Re-adopting must reuse, not duplicate, or a
 * second press of ship would fail on the name the first one just took.
 */
test("adopting a workspace as a project", async (t) => {
  await t.beforeEach(async () => {
    for (const project of await listProjects()) await deleteProject(project.id, true);
    await setSelectedWorkspace("");
    for (const entry of await fs.readdir(sandboxRoot())) {
      await fs.rm(path.join(sandboxRoot(), entry), { recursive: true, force: true });
    }
  });

  await t.test("a chosen directory becomes a row and keeps its files in place", async () => {
    const dir = path.join(sandboxRoot(), "existing-work");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "index.html"), "<h1>still here</h1>\n");
    await setSelectedWorkspace("existing-work");

    const adopted = await adoptProject({ name: "Existing Work", open: true });
    assert.equal(adopted.dir, "existing-work");
    assert.equal(adopted.existing, false);
    assert.equal(selectedWorkspace(), "existing-work", "the project is the working directory");
    assert.equal(await fs.readFile(path.join(dir, "index.html"), "utf8"), "<h1>still here</h1>\n");
    assert.equal((await listProjects()).length, 1);
  });

  await t.test("adopting the same directory again reuses the project, even unnamed", async () => {
    await fs.mkdir(path.join(sandboxRoot(), "twice"), { recursive: true });
    await setSelectedWorkspace("twice");
    const first = await adoptProject({ name: "Twice" });

    const again = await adoptProject({ name: undefined });
    assert.equal(again.id, first.id);
    assert.equal(again.existing, true);
    assert.equal((await listProjects()).length, 1, "a second press is a push, not a second project");
  });

  await t.test("the sandbox root is copied into a project of its own", async () => {
    await fs.writeFile(path.join(sandboxRoot(), "notes.md"), "root work\n");
    await fs.mkdir(path.join(sandboxRoot(), "node_modules", "left-pad"), { recursive: true });
    await fs.writeFile(path.join(sandboxRoot(), "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");

    const adopted = await adoptProject({ name: "Root Work", open: true });
    assert.notEqual(adopted.dir, "", "a row may not point at the sandbox itself");
    assert.equal(adopted.copied, 1, "the loose file was copied and node_modules was not");
    assert.equal(await fs.readFile(path.join(sandboxRoot(), adopted.dir, "notes.md"), "utf8"), "root work\n");
    await assert.rejects(() => fs.stat(path.join(sandboxRoot(), adopted.dir, "node_modules")));
    assert.equal(selectedWorkspace(), adopted.dir);
  });
});
