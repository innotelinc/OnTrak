import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Installing what an imported project needs.
 *
 * The detection is pinned hard, because it is the part a person experiences as
 * *magic*: the right installer runs, in the right order, from a list of file names
 * and nothing else — and the wrong one never does. Two properties are worth more
 * than the individual cases: every command writes inside the project (a sandboxed
 * command's home directory does not survive the container, so anything else is
 * silently lost), and a step that fails stops the ones after it.
 */
import fs from "node:fs/promises";

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "project-install-test-"));
process.env.AGENT_WORKSPACE = path.join(scratch, "workspace");
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");
// Stated rather than assumed: the default note depends on what the sandbox says.
process.env.AGENT_SANDBOX_NETWORK = "none";

const { detectProjectStack, INSTALLED_PATHS, installEnvironmentNotes, installProjectDependencies } =
  await import("../project-install.js");

const commands = (paths: string[]): string[] => detectProjectStack(paths).steps.map((step) => step.command);

test("a Node project installs with the package manager its lockfile names", () => {
  assert.deepEqual(commands(["package.json"]), ["npm install --no-audit --no-fund"]);
  assert.deepEqual(commands(["package.json", "package-lock.json"]), [
    "npm ci --no-audit --no-fund || npm install --no-audit --no-fund",
  ]);
  assert.deepEqual(commands(["package.json", "yarn.lock"]), ["yarn install --no-immutable"]);
  assert.deepEqual(commands(["package.json", "pnpm-lock.yaml"]), ["pnpm install --no-frozen-lockfile"]);

  // A lockfile wins over the plain install, and the note says why the toolchain
  // might not be there.
  const yarn = detectProjectStack(["package.json", "yarn.lock"]);
  assert.deepEqual(yarn.ecosystems, ["node"]);
  assert.deepEqual(yarn.markers, ["package.json", "yarn.lock"]);
  assert.equal(yarn.notes.some((note) => note.includes("yarn")), true);
});

test("a Python project installs into a virtualenv inside the project", () => {
  assert.deepEqual(commands(["requirements.txt"]), [
    "python3 -m venv .venv",
    ".venv/bin/python -m pip install -r requirements.txt",
  ]);
  assert.deepEqual(commands(["pyproject.toml"]), [
    "python3 -m venv .venv",
    ".venv/bin/python -m pip install -e .",
  ]);
  assert.deepEqual(commands(["requirements.txt", "pyproject.toml"]), [
    "python3 -m venv .venv",
    ".venv/bin/python -m pip install -r requirements.txt",
    ".venv/bin/python -m pip install -e .",
  ]);

  const stack = detectProjectStack(["requirements.txt"]);
  assert.equal(stack.notes.some((note) => note.includes(".venv")), true);
  assert.equal(
    stack.steps.every((step) => !step.command.includes("sudo") && !step.command.startsWith("pip ")),
    true,
    "nothing installs outside the project",
  );
});

test("a Pipfile is named rather than half-supported", () => {
  const stack = detectProjectStack(["Pipfile"]);
  assert.deepEqual(stack.steps, []);
  assert.deepEqual(stack.ecosystems, ["python"]);
  assert.equal(stack.notes.some((note) => note.includes("Pipfile")), true);
});

test("the stacks this image cannot build still detect, with the toolchain named", () => {
  assert.equal(commands(["go.mod"])[0]?.startsWith('GOPATH="$PWD/.gopath"'), true);
  assert.equal(commands(["Cargo.toml"])[0]?.startsWith('CARGO_HOME="$PWD/.cargo"'), true);
  assert.equal(commands(["composer.json"])[0], "composer install --no-interaction --prefer-dist");
  assert.equal(commands(["Gemfile"])[0]?.includes("vendor/bundle"), true);

  for (const [paths, ecosystem] of [
    [["go.mod"], "go"],
    [["Cargo.toml"], "rust"],
    [["composer.json"], "php"],
    [["Gemfile"], "ruby"],
  ] as const) {
    const stack = detectProjectStack([...paths]);
    assert.deepEqual(stack.ecosystems, [ecosystem]);
    assert.equal(
      stack.notes.some((note) => note.includes("not in the sandbox image")),
      true,
      `${ecosystem} says which toolchain is missing`,
    );
  }

  const java = detectProjectStack(["pom.xml"]);
  assert.deepEqual(java.ecosystems, ["java"]);
  assert.deepEqual(java.steps, [], "nothing is attempted with a toolchain that is not here");
  assert.equal(java.notes.some((note) => note.includes("JDK")), true);
});

test("a monorepo package is flagged, not half-installed", () => {
  const stack = detectProjectStack(["apps/web/package.json", "README.md"]);
  assert.deepEqual(stack.ecosystems, []);
  assert.deepEqual(stack.steps, []);
  assert.equal(stack.notes.some((note) => note.includes("only the project root")), true);
});

test("a source file in a subdirectory is not a monorepo package", () => {
  // Every project has these, and a note about "a manifest in a subdirectory" on a
  // project that has none is noise that teaches people to ignore notes.
  for (const stack of [
    detectProjectStack(["package.json", "src/index.js", "public/app.js"]),
    detectProjectStack(["requirements.txt", "tests/test_app.py"]),
  ]) {
    assert.deepEqual(
      stack.notes.filter((note) => note.includes("only the project root")),
      [],
    );
  }
});

test("a project with nothing recognisable installs nothing and claims nothing", () => {
  const stack = detectProjectStack(["index.html", "style.css", "./README.md"]);
  assert.deepEqual(stack, { ecosystems: [], markers: [], steps: [], notes: [] });
  assert.deepEqual(detectProjectStack([]), { ecosystems: [], markers: [], steps: [], notes: [] });
});

test("every installed path is inside the project", () => {
  for (const entry of INSTALLED_PATHS) {
    assert.equal(entry.endsWith("/"), true, `${entry} is a directory`);
    assert.equal(entry.startsWith("/"), false);
    assert.equal(entry.includes(".."), false);
  }
  assert.equal(INSTALLED_PATHS.includes("node_modules/"), true);
  assert.equal(INSTALLED_PATHS.includes(".venv/"), true);
});

test("a sandbox with no network says so before anything is attempted", () => {
  const notes = installEnvironmentNotes();
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.includes("AGENT_SANDBOX_NETWORK"), true);
});

test("the steps run in order, and a failure stops the rest", async () => {
  const calls: { command: string; cwd: string; timeoutMs?: number }[] = [];
  const ok = { ok: true, exitCode: 0, timedOut: false, backend: "docker" as const, output: "installed\n" };
  const bad = { ok: false, exitCode: 1, timedOut: false, backend: "docker" as const, output: "boom\n" };

  const stack = detectProjectStack(["requirements.txt", "package.json"]);
  const report = await installProjectDependencies({ dir: "/workspace/app", stack }, async (options) => {
    calls.push({ command: options.command, cwd: options.cwd, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
    return ok;
  });

  assert.deepEqual(
    calls.map((call) => call.command),
    stack.steps.map((step) => step.command),
    "every step runs, in the order the plan gives",
  );
  assert.equal(calls.every((call) => call.cwd === "/workspace/app"), true);
  assert.equal(
    calls.every((call) => (call.timeoutMs ?? 0) > 120_000),
    true,
    "an install gets longer than an ordinary command",
  );
  assert.equal(report.ok, true);
  assert.equal(report.ran, stack.steps.length);
  assert.equal(report.stopped, false);
  assert.equal(report.where, "container coding-agent-sandbox:latest");
  assert.equal(report.steps[0]?.output, "installed\n");

  // The plan for this project is [npm install, venv, pip install …], so failing the
  // middle step proves the last one is not attempted.
  calls.length = 0;
  const failed = await installProjectDependencies({ dir: "/workspace/app", stack }, async (options) => {
    calls.push({ command: options.command, cwd: options.cwd });
    return options.command.includes("python3 -m venv") ? bad : ok;
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.stopped, true);
  assert.equal(failed.steps.at(-1)?.ok, false);
  assert.equal(
    failed.steps.filter((step) => !step.ok).length,
    1,
    "nothing runs after the step that failed",
  );
  assert.deepEqual(
    calls.map((call) => call.command),
    stack.steps.slice(0, 2).map((step) => step.command),
    "the steps after the failure never ran",
  );
});

test("a plan with nothing in it runs nothing at all", async () => {
  let called = 0;
  const report = await installProjectDependencies(
    { dir: "/workspace/app", stack: detectProjectStack(["index.html"]) },
    async () => {
      called += 1;
      return { ok: true, exitCode: 0, timedOut: false, backend: "host" as const, output: "" };
    },
  );
  assert.equal(called, 0);
  assert.equal(report.ran, 0);
  assert.equal(report.where, "");
  assert.equal(report.ok, true);
});
