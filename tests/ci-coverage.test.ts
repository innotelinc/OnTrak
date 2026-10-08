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
  return read(path.posix.join(WORKFLOW_DIR, file))
    .split("\n")
    .map((line) => line.replace(/\s*#.*$/, ""))
    .join("\n");
}

/** Tools that exist only on a machine with a hypervisor, `/dev/kvm` included. */
const HYPERVISOR = /\b(incus|virsh|qemu|libvirt|kvm)\b/i;

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
