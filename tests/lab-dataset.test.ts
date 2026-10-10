/**
 * The data a deployment actually reads.
 *
 * Every other lab suite proves the port's *code* against the lab's data; this one proves
 * the data is **there** — that the tree shipped in `scenarios/` holds all 14 records and,
 * crucially, the scripts each scenario's platform runs. That second half is the whole
 * reason this suite exists: the records were originally shipped as test fixtures in a flat
 * directory with no scripts at all, which is enough for a unit test and useless to a host.
 * A missing `check.sh` is not a failing test in most suites — it is a student whose work
 * cannot be graded, discovered in class.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-dataset.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SHELL_LIB,
  WINDOWS_LIB,
  loadCatalog,
  loadConfigData,
  loadLessons,
  loadScenarios,
  scenarioEntriesFrom,
  scenarioFiles,
  scenarioRoot,
  shippedDataDir,
} from "../src/lib/lab/dataset";
import { CHECK_NAMES, SETUP_NAMES } from "../src/lib/lab/scenarios";

const ROOT = scenarioRoot();

test("dataset: the shipped tree holds every scenario, with the script its platform needs", () => {
  const repository = loadScenarios(ROOT);
  const scenarios = repository.list();
  assert.equal(scenarios.length, 14, "the lab's whole catalogue, not a sample");

  const files = scenarioFiles(scenarios, ROOT);
  const linux = scenarios.filter((scenario) => scenario.platform === "linux");
  const windows = scenarios.filter((scenario) => scenario.platform !== "linux");
  assert.ok(linux.length > 0, "the catalogue has the Linux half too, which the CLI lessons use");
  assert.ok(windows.length > 0, "and the Windows half");

  for (const scenario of scenarios) {
    const present = files.get(scenario.id);
    assert.ok(present, `${scenario.id} has a directory`);
    const listing = present.present ?? [];
    const setup = SETUP_NAMES[scenario.platform];
    const check = CHECK_NAMES[scenario.platform];
    assert.ok(listing.includes(setup), `${scenario.id} ships ${setup}`);
    assert.ok(listing.includes(check), `${scenario.id} ships ${check}`);
    assert.ok((present.setupText ?? "").length > 0, `${scenario.id}: ${setup} is not empty`);
    assert.ok((present.checkText ?? "").length > 0, `${scenario.id}: ${check} is not empty`);
    // The platform's *own* scripts, not the other's: a Linux scenario that shipped only
    // PowerShell would be graded by the Windows transport, which is the drift the shell
    // transport tests exist to catch one level down.
    const wrong = scenario.platform === "linux" ? "setup.ps1" : "setup.sh";
    assert.equal(
      listing.includes(wrong),
      false,
      `${scenario.id} is ${scenario.platform} and must not ship ${wrong}`,
    );
  }
});

test("dataset: the shared libraries a scenario dots in are shipped", () => {
  // Every upload of a scenario copies `_lib/<name>` in first (see `uploadScenarioFiles`),
  // so a tree with records and no libraries clones a machine whose scripts can dot-source
  // nothing — a failure that shows up as an empty check result rather than an error.
  for (const library of [WINDOWS_LIB, SHELL_LIB]) {
    const path = join(ROOT, "_lib", library);
    assert.ok(existsSync(path), `scenarios/_lib/${library} is shipped`);
    assert.ok(
      readFileSync(path, "utf8").length > 500,
      `scenarios/_lib/${library} is a real library, not a placeholder`,
    );
  }
});

test("dataset: an empty tree is an error, not an empty catalogue", () => {
  const empty = mkdtempSync(join(tmpdir(), "ontrak-dataset-"));
  try {
    assert.throws(() => scenarioEntriesFrom(empty), /no scenarios found under/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  assert.throws(() => scenarioEntriesFrom(join(empty, "nope")), /not readable at/);
});

test("dataset: a directory with no record is skipped, and two records with one id are refused", () => {
  const tree = mkdtempSync(join(tmpdir(), "ontrak-dataset-"));
  try {
    // A stray directory (a README, an editor's scratch) must not stop a host from starting.
    mkdirSync(join(tree, "_lib"));
    mkdirSync(join(tree, "scratch"));
    mkdirSync(join(tree, "net-dns-failure"));
    const record = JSON.stringify({
      id: "net-dns-failure",
      title: "Nothing resolves on the intranet",
      category: "network",
      objectives: [{ id: "dns-resolve", text: "It resolves", weight: 1 }],
    });
    writeFileSync(join(tree, "net-dns-failure", "scenario.json"), record);

    const entries = scenarioEntriesFrom(tree);
    assert.equal(entries.length, 1, "the stray directory is not a scenario");
    assert.equal(entries[0]?.fileName, join("net-dns-failure", "scenario.json"));

    mkdirSync(join(tree, "duplicate"));
    writeFileSync(join(tree, "duplicate", "scenario.json"), record);
    assert.throws(
      // `load()` is what discovers, so the refusal happens on the first read rather than at
      // construction — a repository that threw here would throw for a caller that only
      // wanted to hold it.
      () => loadScenarios(tree).load(),
      /two scenarios both claim the id "net-dns-failure"/,
      "a duplicate id is data loss, so it is refused at load time",
    );
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("dataset: the ported catalogue, lessons and settings JSON load", () => {
  const data = shippedDataDir();
  const catalog = loadCatalog(data);
  const entries = catalog.load();
  assert.equal(entries.size, 63, "the four manifests' entries");
  assert.ok(entries.has("ubuntu-24.04"), "including the workload the Linux scenarios name");
  assert.equal(loadLessons(data).load().size, 7, "the lesson library");
  assert.ok(Object.keys(loadConfigData(data)).length > 0, "the site settings data");
});
