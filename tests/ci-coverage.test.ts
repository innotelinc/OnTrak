/**
 * A package with a suite may not have that suite run only on somebody's laptop.
 *
 * `ontrak-portal` has 45 unit tests, a typecheck and a copy check, and it had no CI
 * job: `training`, `tix`, `sentinel`, `sync` and `genie` each have one, so the
 * family's front door was the single product whose rules only ever ran on the machine
 * of whoever was editing it. Its TypeScript was not wholly unchecked — the
 * `Image (portal)` job compiles it — but a build says the code compiles, not that the
 * rules hold, and nothing ran the 45 tests or the check that keeps the family's
 * taglines off the sign-in gate.
 *
 * The rule is derived from the packages rather than listed here: every `package.json`
 * in this repository that declares a `test` script must have a job running from its
 * directory that runs its tests and its typecheck. A hand-kept list of products would
 * be the same kind of stale claim this file exists to catch, one level down.
 *
 * The other half of the same question is what CI must *never* need. The lab's real work
 * is a hypervisor and a Windows image, and no hosted runner has one, so the boundary is
 * what CI can cover and the host half is an operator's deployment (§9/Q8). Three clauses
 * keep the honest green honest: no workflow step may name a hypervisor, every
 * `tests/*-live.test.ts` must be off unless its own flag is set — so `npm test` still runs
 * on a laptop with nothing installed — and the lab's two boundary tests, the only pair a
 * lab host depends on, must keep being run by a job rather than only by whoever remembers.
 *
 * The same thesis holds one artifact class over: a suite that is not an npm package.
 * `ontrak-genie/scripts/tests/test_verify_sso.py` is twelve offline tests of Genie's
 * sign-in posture check, and nothing ran them — `npm test` in that job is the TypeScript
 * suite, and no Makefile target named the directory — so they only ever ran on the
 * machine of whoever wrote them. Every directory of Python tests must therefore be run
 * by a job, derived from the tree rather than listed. A job runs such a directory when it
 * works in the directory whose own `tests/` that is, or names the directory as a path in a
 * step; a job's `working-directory`, a step's `cd` and the repository root are all places a
 * step can be said to work. Comments are stripped first, because a comment about a suite is
 * not a suite being run.
 *
 * What it does not check is whether those steps are all a package needs, or whether a
 * suite is worth running: those are judgements about a job that has to be read, and
 * this settles the claims a set of files can settle on their own.
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();
const WORKFLOW_DIR = path.posix.join(".github", "workflows");
const WORKFLOW = path.join(WORKFLOW_DIR, "ci.yml");

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

/**
 * The directories that may hold a package.
 *
 * The repository root (the training app), each product, and each product's own
 * sub-packages — `ontrak-sync/web` is one — but never `node_modules` or a build
 * output: both can carry a `package.json` no job should install.
 */
function packageDirectories(): string[] {
  const directories = ["."];
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("ontrak-")) continue;
    directories.push(entry.name);
    for (const nested of readdirSync(path.join(ROOT, entry.name), { withFileTypes: true })) {
      if (!nested.isDirectory() || nested.name.startsWith(".") || nested.name === "node_modules") continue;
      directories.push(path.posix.join(entry.name, nested.name));
    }
  }
  return directories;
}

/** The packages that declare a suite, by directory and by name. */
function packagesWithSuites(): { directory: string; name: string }[] {
  const packages: { directory: string; name: string }[] = [];
  for (const directory of packageDirectories()) {
    const file = path.join(ROOT, directory, "package.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    if (!manifest.scripts?.test) continue;
    packages.push({ directory, name: manifest.name ?? directory });
  }
  return packages;
}

/**
 * Each job's text, and the directory its steps run in by default.
 *
 * Read from the workflow rather than from GitHub: a check that had to ask an API
 * could only run where the API is reachable, and this has to fail in `npm test` too.
 */
function jobs(): { name: string; directory: string; text: string }[] {
  const lines = read(WORKFLOW).split("\n");
  const start = lines.indexOf("jobs:");
  assert.notEqual(start, -1, `${WORKFLOW} has no top-level jobs: line`);

  const found: { name: string; lines: string[] }[] = [];
  let current: { name: string; lines: string[] } | null = null;
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (header) {
      current = { name: header[1] ?? "", lines: [] };
      found.push(current);
      continue;
    }
    current?.lines.push(line);
  }

  return found.map((job) => {
    const text = job.lines.join("\n");
    // `defaults.run.working-directory` is the job's own default; a step may override
    // it, which is how the `sync` job typechecks the dashboard and tests the API.
    const directory = /^ {8}working-directory: (\S+)$/m.exec(text)?.[1] ?? "";
    return { name: job.name, directory, text };
  });
}

/** Every workflow file, by name: the ones that could acquire a hypervisor. */
function workflowFiles(): string[] {
  return readdirSync(path.join(ROOT, WORKFLOW_DIR))
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();
}

/**
 * A workflow file with its comments removed.
 *
 * YAML comments run to the end of their line, and the `training` job explains in prose
 * that it needs no hypervisor — so a scan of the raw text would fail on the sentence
 * asserting the very thing being checked. What is left is what a runner would execute.
 */
function uncommented(file: string): string {
  return executed(read(path.posix.join(WORKFLOW_DIR, file)));
}

/**
 * Workflow text with YAML and shell comments removed: what a runner would execute.
 *
 * Shared by the file-level scan above and the job-level coverage check below, and for
 * the same reason in both: a comment is prose about work, never the work. A step whose
 * comment names a test directory has not run it.
 */
function executed(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\s*#.*$/, ""))
    .join("\n");
}

/**
 * The directories a job works in: its own default, plus every `cd` in its steps.
 *
 * `cd` is resolved against the job's default rather than the repository root, because
 * that is what a shell in the runner does: `cd scripts` in the genie job — whose default
 * is `ontrak-genie` — means `ontrak-genie/scripts`. A job with no default works at the
 * repository root, spelled `.`.
 */
function workingDirectories(job: { directory: string; text: string }): string[] {
  const base = job.directory === "" ? "." : job.directory;
  // The repository root, because a step with nothing to say about its directory runs
  // there; then every step-level override, which GitHub resolves from the root; then
  // every `cd`, which a shell resolves from where the step started.
  const resolved = new Set<string>([".", base]);
  for (const match of job.text.matchAll(/^\s*working-directory: (\S+)$/gm)) {
    resolved.add((match[1] ?? "").replace(/^\.\//, "").replace(/\/$/, ""));
  }
  for (const match of job.text.matchAll(/^\s*cd (\S+)/gm)) {
    const target = match[1] ?? "";
    if (target.startsWith("/")) continue;
    const parts = base === "." ? [] : base.split("/");
    for (const segment of target.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") parts.pop();
      else parts.push(segment);
    }
    resolved.add(parts.length === 0 ? "." : parts.join("/"));
  }
  return [...resolved].filter(Boolean);
}

/**
 * Whether a job runs the Python tests in `directory`.
 *
 * Two shapes count, and both have to be something the runner does rather than something
 * a comment says, which is why the text is comment-stripped first. Either the job works
 * in the directory whose own `tests/` this is — discovery reaches a suite one level down,
 * not through an ancestor, so `cd scripts && … discover -s tests` counts and discovering
 * from the package root does not — or a step names the directory as one of its path
 * tokens, which is how the sync job runs its suite and how the structure job runs one by
 * file. A step that merely names an *ancestor* is not running the suite: the difference
 * between `discover -s tests` and `discover -s scripts/tests` is the whole check.
 */
function runsPythonTests(job: { directory: string; text: string }, directory: string): boolean {
  const text = executed(job.text);
  if (!/python3?|unittest|pytest/.test(text)) return false;
  const tokens = text.split(/[\s"'`()]+/).filter(Boolean);

  return workingDirectories({ directory: job.directory, text }).some((dir) => {
    const under =
      dir === "." ? directory : directory.startsWith(`${dir}/`) ? directory.slice(dir.length + 1) : "";
    if (under === "") return false;
    // The working directory's own tests, or a path a step spells out.
    return under === "tests" || tokens.some((token) => token === under || token.startsWith(`${under}/`));
  });
}

/** Tools that exist only on a machine with a hypervisor, `/dev/kvm` included. */
const HYPERVISOR = /\b(incus|virsh|qemu|libvirt|kvm)\b/i;

/**
 * Every directory in the tree that holds Python tests, as a repository-relative path.
 *
 * A `tests/` directory containing at least one `test_*.py`, which is how every Python
 * suite here is spelled — the provisioner's, the theme's, the lab client's, the sync
 * backend's. Build output and dependency trees are skipped: a `tests` directory inside
 * `node_modules` is not this repository's to run.
 */
function pythonTestDirectories(): string[] {
  const SKIP = new Set(["node_modules", ".git", ".next", "dist", "__pycache__", ".venv"]);
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(path.join(ROOT, directory || "."), { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
      const full = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.name === "tests") {
        const files = readdirSync(path.join(ROOT, full));
        if (files.some((file) => /^test_.*\.py$/.test(file))) {
          found.push(full);
          continue;
        }
      }
      walk(full);
    }
  };

  walk("");
  return found.sort();
}

/**
 * The root suite's live tests: the flag each one reads, and whether it skips.
 *
 * `tests/*-live.test.ts` is this repository's name for "this file boots a server and wants
 * a database", and each one is opt-in twice over — a flag of its own, and a skip when the
 * flag is unset. That is what lets the same suite run on a laptop with nothing installed
 * and let CI opt one in on a runner that has what it needs.
 */
function liveTests(): { file: string; flag: string; skips: boolean }[] {
  const directory = path.join(ROOT, "tests");
  return readdirSync(directory)
    .filter((file) => file.endsWith("-live.test.ts"))
    .sort()
    .map((file) => {
      const source = readFileSync(path.join(directory, file), "utf8");
      return {
        file,
        flag: /Boolean\(process\.env\.([A-Z0-9_]+)\)/.exec(source)?.[1] ?? "",
        skips: /t\.skip\(/.test(source),
      };
    });
}

test("ci: the workflow and the packages it has to cover were both read", () => {
  // A parser that silently found nothing would pass the check below by defining it
  // away, so both sides have to be shown to have content first.
  const packages = packagesWithSuites();
  assert.ok(
    packages.length >= 5,
    `the walk found ${packages.length} packages with a test script: ${packages.map((entry) => entry.directory).join(", ")}`,
  );
  assert.ok(
    packages.some((entry) => entry.directory === "ontrak-portal"),
    `the walk did not reach the portal, and found: ${packages.map((entry) => entry.directory).join(", ")}`,
  );

  const all = jobs();
  assert.ok(all.length >= 8, `${WORKFLOW} yielded ${all.length} jobs`);
  assert.ok(
    all.some((job) => job.directory === "."),
    `no job runs from the repository root, so the training app's suite would look uncovered: ${all.map((job) => job.name).join(", ")}`,
  );
});

test("ci: every package that declares a suite has a job that runs it", () => {
  const all = jobs();
  const problems: string[] = [];

  for (const { directory, name } of packagesWithSuites()) {
    const own = all.filter((job) => job.directory === directory);
    if (!own.length) {
      problems.push(`${name} (${directory}) declares a test script and no job runs from its directory`);
      continue;
    }
    const runner = own.find((job) => /\bnpm test\b/.test(job.text));
    if (!runner) {
      problems.push(
        `${name} (${directory}) declares a test script and no job running from that directory runs npm test`,
      );
    } else if (!/npm run typecheck\b/.test(runner.text)) {
      problems.push(`${name} (${directory}): the ${runner.name} job runs its tests but never typechecks it`);
    }
  }

  assert.deepEqual(problems, [], problems.join("\n"));
});

test("ci: every directory of Python tests is run by a job", () => {
  const directories = pythonTestDirectories();
  assert.ok(
    directories.length >= 4,
    `the walk found ${directories.length} directories of Python tests: ${directories.join(", ")}`,
  );

  const all = jobs();
  const problems: string[] = [];
  for (const directory of directories) {
    if (!all.some((job) => runsPythonTests(job, directory))) {
      problems.push(`${directory} holds Python tests and no job runs them`);
    }
  }

  assert.deepEqual(problems, [], problems.join("\n"));
});

test("ci: no job needs a hypervisor", () => {
  const files = workflowFiles();
  assert.ok(files.length >= 2, `the workflow directory yielded ${files.length} files`);

  const problems: string[] = [];
  for (const file of files) {
    for (const [index, line] of uncommented(file).split("\n").entries()) {
      if (HYPERVISOR.test(line)) problems.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }

  assert.deepEqual(
    problems,
    [],
    "a step that needs a hypervisor is a step that cannot run on a hosted runner, and the " +
      "lab's host half is an operator's deployment (§9/Q8):\n" +
      problems.join("\n"),
  );
});

test("ci: every live test is off unless its own flag says otherwise", () => {
  const live = liveTests();
  assert.ok(live.length >= 4, `the walk found ${live.length} live tests`);

  const problems: string[] = [];
  for (const entry of live) {
    if (entry.flag === "") {
      problems.push(`tests/${entry.file} does not read a flag of its own (Boolean(process.env.X_LIVE))`);
    }
    if (!entry.skips) {
      problems.push(`tests/${entry.file} never skips, so it boots on every \`npm test\` — including a laptop with nothing installed`);
    }
  }

  assert.deepEqual(problems, [], problems.join("\n"));
});

test("ci: the lab's boundary tests are run by a job, not only by whoever remembers", () => {
  // The lab's own tests are the ones whose flag names the lab: this repository's half of
  // the boundary is `tests/lab-live.test.ts` (the route) and `tests/lab-client-live.test.ts`
  // (the client's real request against it), the only pair a lab host depends on — and the
  // pair a hosted runner can run, because neither needs a VM (§9/Q8).
  const lab = liveTests().filter((entry) => /^ONTRAK_LAB[A-Z_]*_LIVE$/.test(entry.flag));
  assert.ok(
    lab.length >= 2,
    `the walk found ${lab.length} lab live tests: ${lab.map((entry) => entry.file).join(", ")}`,
  );

  const all = jobs();
  const problems: string[] = [];
  for (const entry of lab) {
    const runner = all.find((job) => new RegExp(`\\b${entry.flag}=1\\b`).test(job.text));
    if (!runner) {
      problems.push(`tests/${entry.file} is run by no job — set ${entry.flag}=1 in a step`);
    }
  }

  assert.deepEqual(problems, [], problems.join("\n"));
});
