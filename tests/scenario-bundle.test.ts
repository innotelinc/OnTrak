/**
 * Scenario bundles (2.1 — authoring at scale).
 *
 * The property that matters is that a bundle carries the *grading contract* and
 * nothing about the row that produced it. So the round trip asserts the
 * definition comes back byte-identical, the envelope refuses anything it cannot
 * grade, and the export never includes a slug, author or publish flag that would
 * let an import guess at another deployment's catalog state.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_BUNDLE_BYTES,
  SCENARIO_BUNDLE_FORMAT,
  SCENARIO_BUNDLE_VERSION,
  bundleFilename,
  exportScenarioBundle,
  parseScenarioBundle,
  type BundleSource,
} from "../src/lib/scenario-bundle";

function row(): BundleSource {
  return {
    title: "Accounts & Permissions",
    summary: "Repair a broken account.",
    description: "A colleague cannot sign in.",
    platform: "LINUX",
    engine: "bash",
    difficulty: "INTERMEDIATE",
    timeLimitSec: 1800,
    passScore: 70,
    tags: ["linux", "accounts"],
    definition: {
      version: 1,
      platform: "LINUX",
      engine: "bash",
      briefing: "Fix the account.",
      checks: [{ id: "password", label: "Password is set", kind: "command_matched", value: "passwd" }],
    },
  };
}

test("export then import preserves the grading contract", () => {
  const source = row();
  const exported = exportScenarioBundle(source, new Date("2026-10-24T12:00:00Z"));

  assert.equal(exported.format, SCENARIO_BUNDLE_FORMAT);
  assert.equal(exported.version, SCENARIO_BUNDLE_VERSION);
  assert.equal(exported.exportedAt, "2026-10-24T12:00:00.000Z");

  const parsed = parseScenarioBundle(exported);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.bundle.scenario, exported.scenario);
  assert.deepEqual(parsed.bundle.scenario.definition, source.definition);
});

test("a bundle carries no local row state", () => {
  const exported = exportScenarioBundle(row());
  const keys = Object.keys(exported.scenario);
  for (const local of ["id", "slug", "authorId", "author", "published", "organizationId", "attempts"]) {
    assert.equal(keys.includes(local), false, `bundle leaked ${local}`);
  }
});

test("export does not mutate the stored definition or tags", () => {
  const source = row();
  const before = JSON.stringify(source);
  const exported = exportScenarioBundle(source);
  exported.scenario.definition.checks = [];
  exported.scenario.tags.push("mutated");
  assert.equal(JSON.stringify(source), before);
});

test("the file form is accepted", () => {
  const text = JSON.stringify(exportScenarioBundle(row()));
  const parsed = parseScenarioBundle(text);
  assert.equal(parsed.ok, true);
});

test("refuses a file that is not a bundle", () => {
  assert.deepEqual(parseScenarioBundle({ hello: "world" }), {
    ok: false,
    error: "That file is not an OnTrak scenario bundle.",
  });
  assert.deepEqual(parseScenarioBundle([1, 2, 3]), { ok: false, error: "A bundle is a JSON object." });
});

test("refuses a newer format rather than half-reading it", () => {
  const bundle = exportScenarioBundle(row());
  const parsed = parseScenarioBundle({ ...bundle, version: 2 });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /bundle version 2/);
});

test("refuses a bundle with no title", () => {
  const bundle = exportScenarioBundle(row());
  const parsed = parseScenarioBundle({ ...bundle, scenario: { ...bundle.scenario, title: "  " } });
  assert.deepEqual(parsed, { ok: false, error: "The scenario has no title." });
});

test("refuses a definition that cannot grade anybody", () => {
  const bundle = exportScenarioBundle(row());
  const parsed = parseScenarioBundle({
    ...bundle,
    scenario: { ...bundle.scenario, definition: { ...bundle.scenario.definition, checks: [] } },
  });
  assert.deepEqual(parsed, {
    ok: false,
    error: "The definition has no checks, so it cannot grade anybody.",
  });
});

test("refuses an envelope that disagrees with its definition", () => {
  const bundle = exportScenarioBundle(row());
  const parsed = parseScenarioBundle({
    ...bundle,
    scenario: { ...bundle.scenario, platform: "WINDOWS" },
  });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /envelope says WINDOWS/);
});

test("refuses an out-of-range time limit or pass mark instead of clamping", () => {
  const bundle = exportScenarioBundle(row());
  const time = parseScenarioBundle({ ...bundle, scenario: { ...bundle.scenario, timeLimitSec: 5 } });
  assert.equal(time.ok, false);
  if (!time.ok) assert.match(time.error, /time limit/);

  const pass = parseScenarioBundle({ ...bundle, scenario: { ...bundle.scenario, passScore: 101 } });
  assert.equal(pass.ok, false);
  if (!pass.ok) assert.match(pass.error, /pass mark/);
});

test("defaults a missing difficulty, time limit and pass mark", () => {
  const bundle = exportScenarioBundle(row());
  const parsed = parseScenarioBundle({
    ...bundle,
    scenario: { ...bundle.scenario, difficulty: undefined, timeLimitSec: undefined, passScore: undefined },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.bundle.scenario.difficulty, "INTERMEDIATE");
  assert.equal(parsed.bundle.scenario.timeLimitSec, 1800);
  assert.equal(parsed.bundle.scenario.passScore, 70);
});

test("normalises tags and drops duplicates", () => {
  const bundle = exportScenarioBundle(row());
  const parsed = parseScenarioBundle({
    ...bundle,
    scenario: { ...bundle.scenario, tags: [" linux ", "linux", "", "accounts"] },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.bundle.scenario.tags, ["linux", "accounts"]);
});

test("refuses an oversized or malformed file", () => {
  const huge = " ".repeat(MAX_BUNDLE_BYTES + 1);
  assert.deepEqual(parseScenarioBundle(huge), {
    ok: false,
    error: `That file is larger than ${MAX_BUNDLE_BYTES} bytes.`,
  });
  const broken = parseScenarioBundle("{not json");
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.match(broken.error, /not valid JSON/);
});

test("names the download after the scenario", () => {
  assert.equal(bundleFilename("Accounts & Permissions"), "accounts-permissions.ontrak-scenario.json");
  assert.equal(bundleFilename("!!!"), "scenario.ontrak-scenario.json");
});
