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
 * What it does not check is whether those steps are all a package needs, or whether a
 * suite is worth running: those are judgements about a job that has to be read, and
 * this settles the claim a set of files can settle on its own.
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();
const WORKFLOW = path.join(".github", "workflows", "ci.yml");

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
