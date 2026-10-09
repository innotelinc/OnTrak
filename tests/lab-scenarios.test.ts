/**
 * The lab's scenario catalogue: what loads, what is refused, and what a student may see.
 *
 * Ported from `OnTrak-dev/tests/test_scenarios.py`, with the two things this
 * repository changes kept visible rather than glossed:
 *
 * **The data is the lab's own.** These tests read the 14 real scenarios from
 * `tests/fixtures/lab-scenarios/` — the same files the family's lab-scenario
 * importer round-trips — so a rejection here means the port is wrong, not the data.
 * They carry no `setup`/`check` scripts, which is why the catalogue has two doors:
 * `validateRecords` for what a record can prove, and `validate` for the script
 * contract, which is proven here against inline script text instead.
 *
 * **The one rule that protects a student is the ticket header.** `ticket:` holds
 * both the request's header and `form:` — the rubric with its weights, hints and the
 * terms an answer must contain. The session page once rendered the whole block, so
 * the student read the answers in the card they were meant to answer from. The tests
 * below are structural: they assert what may arrive, not that a word is absent from
 * a string nobody checked.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-scenarios.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { LabScenario as ScenarioRecord } from "../src/lib/lab-scenario-import";
import { CATEGORIES } from "../src/lib/lab/models";
import {
  CHECK_NAMES,
  MAX_DIFFICULTY,
  ScenarioError,
  ScenarioRepository,
  SETUP_NAMES,
  buildScenario,
  criticalObjectives,
  hintsUpTo,
  normaliseCategory,
  normalisePlatform,
  parseScenarioRecord,
  platformWorkloads,
  publicView,
  scenarioIsLinux,
  scenarioObjective,
  ticketHeader,
  totalWeight,
  type ScenarioEntry,
  type ScenarioFiles,
  type TicketRules,
} from "../src/lib/lab/scenarios";

const DIR = path.join(process.cwd(), "tests", "fixtures", "lab-scenarios");

/** The 14 real lab scenarios, read from the JSON the catalogue consumes. */
function fixtureEntries(dir: string = DIR): ScenarioEntry[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((fileName) => ({
      fileName,
      record: parseScenarioRecord(readFileSync(path.join(dir, fileName), "utf8"), fileName),
    }));
}

function repository(entries: readonly ScenarioEntry[] = fixtureEntries()): ScenarioRepository {
  return new ScenarioRepository(entries);
}

function record(overrides: Record<string, unknown>): ScenarioRecord {
  return {
    id: "unit-scenario",
    title: "A unit scenario",
    category: "software",
    briefing: "Something is wrong and the student has to fix it.",
    objectives: [
      { id: "the-thing", text: "The thing is fixed", weight: 60, critical: true },
      { id: "the-notes", text: "The write-up explains it", weight: 40 },
    ],
    ...overrides,
  } as unknown as ScenarioRecord;
}

// Both spellings reach this helper: `record(...)` returns the loader's own view, and a
// test that mutates a fixture holds a plain record. The union says so rather than
// widening one of them to `any` or casting at eight call sites.
function entry(name: string, value: ScenarioRecord | Record<string, unknown>): ScenarioEntry {
  return { fileName: `${name}.json`, record: value as unknown as ScenarioRecord };
}

/* -------------------------------------------------------------------------- */
/*  The real catalogue                                                        */
/* -------------------------------------------------------------------------- */

test("scenarios: the lab's own 14 scenarios all pass the record rules", () => {
  const problems = repository().validateRecords();
  assert.deepEqual(problems, [], `\n${problems.join("\n")}`);
});

test("scenarios: all six survey categories are covered", () => {
  const categories = [...new Set(repository().list().map((scenario) => scenario.category))];
  assert.deepEqual(categories.sort(), [...CATEGORIES].sort());
});

test("scenarios: weights total 100 and the critical flags stay selective", () => {
  for (const scenario of repository().list()) {
    assert.ok(scenario.objectives.length > 0, `${scenario.id} declares objectives`);
    assert.ok(
      scenario.objectives.every((objective) => objective.weight > 0),
      `${scenario.id} has no weightless objective`,
    );
    assert.equal(totalWeight(scenario), 100, `${scenario.id} weights should total 100 for a predictable pass mark`);
    const critical = criticalObjectives(scenario);
    assert.ok(
      critical.length > 0 && critical.length < scenario.objectives.length,
      `${scenario.id} keeps critical for the must-not-miss items`,
    );
  }
});

test("scenarios: an id matches the file it came from", () => {
  const fileNames = new Set(fixtureEntries().map((candidate) => candidate.fileName));
  for (const scenario of repository().list()) {
    assert.ok(fileNames.has(`${scenario.id}.json`), `${scenario.id} came from ${scenario.id}.json`);
  }
});

test("scenarios: the hardware scenario's extra adapter is unmanaged", () => {
  // The failure the validator exists to catch: Incus refuses two NICs on one
  // managed network (duplicate DNS name), and eth0 already holds the lab bridge.
  // An unmanaged p2p adapter carries a live link, so enabling it really does
  // restore the port.
  const scenario = repository().get("hw-driver-device");
  assert.ok(scenario.instanceDevices.length > 0, "the device scenario needs a second NIC");
  const device = scenario.instanceDevices[0];
  assert.ok(device, "the second NIC is the first entry");
  assert.equal(device.type, "nic");
  assert.equal(device.nictype, "p2p");
  assert.equal("network" in device, false, "a p2p adapter must not also name a network");
});

test("scenarios: an extra NIC on the lab network is refused at validate time", () => {
  const original = fixtureEntries().find((candidate) => candidate.fileName === "hw-driver-device.json");
  assert.ok(original, "the device fixture must exist");
  const broken = JSON.parse(JSON.stringify(original.record)) as Record<string, unknown>;
  const devices = (broken.instance_devices ?? []) as Record<string, unknown>[];
  devices[0] = { name: "eth1", type: "nic", network: "lab" };

  const problems = repository([entry("hw-driver-device", broken)]).validateRecords().join("\n");
  assert.match(problems, /cannot join the lab network/);
});

test("scenarios: by category groups every scenario exactly once", () => {
  const catalogue = repository();
  const grouped = catalogue.byCategory();
  let counted = 0;
  for (const bucket of grouped.values()) counted += bucket.length;
  assert.equal(counted, catalogue.list().length);
});

/* -------------------------------------------------------------------------- */
/*  The views a student may see                                               */
/* -------------------------------------------------------------------------- */

test("scenarios: hints are revealed by asking, and never by accident", () => {
  const scenario = repository().get("sec-malware-persistence");
  assert.deepEqual(hintsUpTo(scenario, 0), []);
  assert.deepEqual(hintsUpTo(scenario, 1), scenario.hints.slice(0, 1));
  assert.deepEqual(hintsUpTo(scenario, 99), scenario.hints);
});

test("scenarios: the public view carries no script name and no unrevealed hint", () => {
  const scenario = repository().get("net-dns-failure");
  const view = publicView(scenario, 2);
  assert.equal(JSON.stringify(view).includes("setup.ps1"), false);
  assert.equal(view.hint_count, scenario.hints.length);
  assert.equal((view.hints_revealed as string[]).length, 2);
  assert.deepEqual(
    (view.objectives as { id: string }[]).map((objective) => objective.id).sort(),
    scenario.objectives.map((objective) => objective.id).sort(),
  );
});

test("scenarios: the public view never carries the ticket rubric", () => {
  // The reported bug: the session page printed the form beside the student —
  // the field list with its weights, hints and the terms a competent answer must
  // contain (`all_of: [750]`, `min_words: 6`).
  const scenario = repository().get("linux-dir-tree-build");
  assert.ok(scenario.ticket.form, "the fixture scenario must declare a form");

  const view = publicView(scenario);
  const header = view.ticket as Record<string, string>;
  assert.ok(header, "the header should still reach the page");
  assert.deepEqual(Object.keys(header).sort(), ["Channel", "From", "Priority", "Reported", "System"]);
  assert.equal(header.From, "Dana Okafor (Platform team)");

  // Structural, not a word search over arbitrary text: "form" is a substring of
  // "platform" in the briefing, and `weight` is a legitimate key on an objective.
  // What must never arrive is the rubric itself.
  assert.ok(Object.values(header).every((value) => typeof value === "string"));
  const rendered = JSON.stringify(header);
  for (const leak of ["min_words", "all_of", "any_of", "hint", "fields", "title"]) {
    assert.equal(rendered.includes(leak), false, `${leak} leaked into the ticket header`);
  }
  assert.equal(rendered.includes("Change record"), false, "the form's own title leaked");
});

test("scenarios: a ticket header drops everything that is not a label", () => {
  const header = ticketHeader(repository().get("linux-dir-tree-build"));
  assert.equal(header.System, "build-02 (Ubuntu)");
  assert.equal("Form" in header, false);
  assert.ok(Object.values(header).every((value) => typeof value === "string"));
});

test("scenarios: a scenario without a ticket reports an empty header", () => {
  // A scenario written before the ticket system has no block at all, so the header
  // must be empty rather than raise: the session page asks for it either way.
  const scenario = repository().get("linux-dir-tree-build");
  const without = { ...scenario, ticket: {}, ticketForm: null };
  assert.deepEqual(ticketHeader(without), {});
  assert.deepEqual(publicView(without).ticket, {});
  assert.equal(publicView(without).has_ticket, false);
});

/* -------------------------------------------------------------------------- */
/*  Loading, access and the reading order                                     */
/* -------------------------------------------------------------------------- */

test("scenarios: an unknown scenario is refused, naming what exists", () => {
  assert.throws(
    () => repository().get("does-not-exist"),
    (error: unknown) => error instanceof ScenarioError && /unknown scenario/.test(error.message),
  );
});

test("scenarios: two files claiming one id are refused rather than silently merged", () => {
  // Python's dict assignment kept whichever file was read last, which in a flat
  // directory whose ids live inside the files is data loss, not a policy.
  const catalogue = new ScenarioRepository([
    entry("first", record({ id: "same-id" })),
    entry("second", record({ id: "same-id" })),
  ]);
  assert.throws(() => catalogue.list(), /both claim the id "same-id"/);
});

test("scenarios: an unreadable record is refused with the file named", () => {
  assert.throws(() => parseScenarioRecord("{not json", "broken.json"), /broken\.json: invalid JSON/);
  assert.throws(() => parseScenarioRecord("[]", "broken.json"), /broken\.json: top level must be an object/);
});

test("scenarios: objectives are looked up by id, and a missing one is null", () => {
  const scenario = repository().get("net-dns-failure");
  assert.equal(scenarioObjective(scenario, "restore-resolver")?.critical, true);
  assert.equal(scenarioObjective(scenario, "nothing-like-this"), null);
});

test("scenarios: a workload-bearing scenario lists every catalog entry it can be built for", () => {
  assert.deepEqual(platformWorkloads(repository().get("linux-dir-tree-build")), ["ubuntu-24.04", "debian-12"]);
  assert.deepEqual(platformWorkloads(repository().get("net-dns-failure")), [], "no workload means the site's golden image");
  assert.equal(scenarioIsLinux(repository().get("linux-dir-tree-build")), true);
  assert.equal(scenarioIsLinux(repository().get("net-dns-failure")), false, "a record without a platform is a Windows scenario");
});

test("scenarios: categories and platforms accept the ways a manifest spells them", () => {
  assert.equal(normaliseCategory("Drivers"), "hardware");
  assert.equal(normaliseCategory("Malware"), "security");
  assert.equal(normaliseCategory("perf"), "os");
  assert.equal(normaliseCategory("Identity"), "identity");
  assert.throws(() => normaliseCategory("interpretive-dance"), ScenarioError);

  assert.equal(normalisePlatform("win"), "windows");
  assert.equal(normalisePlatform("PowerShell"), "windows");
  assert.equal(normalisePlatform(" sh "), "linux");
  assert.throws(() => normalisePlatform("solaris"), /unknown platform/);
});

/* -------------------------------------------------------------------------- */
/*  The rules a record cannot prove: the setup/check contract                 */
/* -------------------------------------------------------------------------- */

test("scenarios: a healthy script contract passes, and the script names are the platform's", () => {
  // The rules the JSON data files cannot exercise, proven against inline script
  // text: a Linux scenario whose setup confirms the fault and whose check reports
  // through the shell helper, naming both objectives.
  const linux = record({
    id: "linux-ok",
    platform: "linux",
    lessons: ["linux-files-and-dirs"],
    hints: ["a hint"],
    resources: ["resources/notes.txt"],
    workload: "ubuntu-24.04",
    objectives: [
      { id: "one", text: "First", weight: 60, critical: true },
      { id: "two", text: "Second", weight: 40 },
    ],
  });
  const files = new Map<string, ScenarioFiles>([
    [
      "linux-ok",
      {
        present: ["scenario.json", "resources/notes.txt"],
        setupText: "#!/bin/bash\nontrak_setup_ok\n",
        checkText: "#!/bin/bash\nontrak_check\nontrak_report 'one' 'two'\n",
      },
    ],
  ]);

  const catalogue = repository([entry("linux-ok", linux)]);
  assert.deepEqual(catalogue.validate(null, { files }), []);
  assert.equal(SETUP_NAMES.linux, "setup.sh");
  assert.equal(CHECK_NAMES.linux, "check.sh");
});

test("scenarios: a check script that cannot report an objective fails, naming it", () => {
  const files = new Map<string, ScenarioFiles>([
    [
      "unit-scenario",
      { present: null, setupText: "# no marker\n", checkText: "# no report call\n" },
    ],
  ]);
  const problems = repository([entry("unit-scenario", record({}))]).validate(null, { files });
  const joined = problems.join("\n");

  // The script exists and is not empty, so the failure is the contract, not a
  // missing file.
  assert.equal(/setup\.ps1 is missing or empty/.test(joined), false);
  assert.match(joined, /ONTRAK-SETUP-OK/);
  assert.match(joined, /must call Write-OnTrakReport/);
  assert.match(joined, /never reports objective "the-thing"/);
  assert.match(joined, /never reports objective "the-notes"/);
});

test("scenarios: a scenario given no scripts is reported, not skipped", () => {
  // A validator that returns clean because it was handed no evidence is the same
  // silence it exists to prevent, in a new place.
  const problems = repository().validate(["net-dns-failure"]);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /no scenario files were supplied/);
});

test("scenarios: the data-only door keeps every rule a record can prove", () => {
  // `validateRecords` is the data-only door, and it is named for what it checks.
  const problems = repository().validateRecords(["net-dns-failure"]);
  assert.deepEqual(problems, []);
  const hard = repository([entry("unit-scenario", record({ pass_score: 140, difficulty: 9, objectives: [] }))]);
  const recordOnly = hard.validateRecords().join("\n");
  assert.match(recordOnly, new RegExp(`difficulty must be 1\\.\\.${MAX_DIFFICULTY}`));
  assert.match(recordOnly, /pass_score must be in \(0, 100\]/);
  assert.match(recordOnly, /declares no objectives/);
});

test("scenarios: a manifest whose id disagrees with its file is refused", () => {
  // The analogue of Python's "id does not match directory name": someone renames
  // the file, and every link that addressed the scenario by id now misses.
  const problems = repository([entry("renamed", record({ id: "the-id-inside" }))]).validateRecords();
  assert.deepEqual(problems, ['[the-id-inside] id does not match the file name "renamed.json"']);
});

test("scenarios: duplicate objective ids and a missing lesson link are refused", () => {
  const problems = repository([
    entry(
      "unit-scenario",
      record({
        platform: "linux",
        hints: ["a hint"],
        lessons: [],
        workload: "Not A Workload",
        objectives: [
          { id: "twice", text: "First", weight: 50, critical: true },
          { id: "twice", text: "Second", weight: 50 },
        ],
      }),
    ),
  ]).validateRecords();
  const joined = problems.join("\n");
  assert.match(joined, /duplicate objective id\(s\): twice/);
  assert.match(joined, /is not a catalog entry id/);
  assert.match(joined, /names no lessons/);
});

test("scenarios: a catalog and a lesson repository, when supplied, are consulted", () => {
  const catalogue = repository([entry("unit-scenario", record({ workload: "win11-24h2", lessons: ["dead-link"] }))]);
  const problems = catalogue.validateRecords(null, {
    catalog: { entries: ["ubuntu-24.04"] },
    lessons: { find: (lessonId) => (lessonId === "dead-link" ? null : { id: lessonId }) },
  });
  const joined = problems.join("\n");
  assert.match(joined, /names workload "win11-24h2", which is not in the catalog/);
  assert.match(joined, /does not exist under lessons\//);
});

/* -------------------------------------------------------------------------- */
/*  The ticket-rubric seam                                                    */
/* -------------------------------------------------------------------------- */

test("scenarios: the default ticket rules find the form and validate none of it", () => {
  // Stated rather than hidden: `tickets.py`'s rubric checks are a later stage, so
  // the default finds whether a form exists — the fact `has_ticket` needs — and
  // performs no rubric validation. A caller with the real rules passes them in.
  const scenario = repository().get("linux-dir-tree-build");
  assert.notEqual(scenario.ticketForm, null);
  assert.equal(publicView(scenario).has_ticket, true);

  const rules: TicketRules = {
    loadForm: () => ({ fields: [] }),
    validateForm: (form, prefix) => (form === null ? [`${prefix} no write-up form`] : []),
  };
  const withRules = new ScenarioRepository(fixtureEntries(), { ticketRules: rules });
  assert.deepEqual(withRules.validateRecords(["linux-dir-tree-build"]), []);

  const complaining = new ScenarioRepository(fixtureEntries(), {
    ticketRules: {
      loadForm: () => null,
      validateForm: (_form, prefix) => [`${prefix} the rubric was refused`],
    },
  });
  const problems = complaining.validateRecords(["linux-dir-tree-build"]);
  assert.deepEqual(problems, ["[linux-dir-tree-build] the rubric was refused"]);
});

test("scenarios: the loaded view is what the grader takes, without a conversion", () => {
  // `Scenario` satisfies `GradeableScenario`, so the object the catalogue lists is
  // the object `evaluate` scores: id, title, pass score and weighted objectives.
  const scenario = buildScenario(record({ id: "graded", pass_score: 70 }), "graded.json");
  assert.equal(scenario.id, "graded");
  assert.equal(scenario.passScore, 70);
  assert.equal(totalWeight(scenario), 100);
  assert.equal(scenario.objectives.length, 2);
});
