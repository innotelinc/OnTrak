/**
 * Selection decides what a student is asked to do, so these tests pin both the choice
 * and the explanation. An assignment nobody can explain is worse than a manual one,
 * which is why every case here asserts *why* as well as *what*.
 *
 * Ported from `OnTrak-dev/tests/test_selection.py`, with one change of instrument: the
 * Python reached for the real scenario repository and catalogue, and this port's loaders
 * do not exist yet, so the fixtures below are the same facts in the same shape — a
 * handful of scenarios across five families, with difficulties a distance from the 2.5
 * the scoring targets. Everything asserted about the policy is the policy, not the
 * fixture: the cap that refuses, the repeat penalty that steers away, the least-used
 * family bonus that spreads a class out, and the tie-breaks that keep a choice from
 * depending on catalogue order.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-selection.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Choice,
  STRATEGIES,
  choose,
  eligible,
  historyFromSessions,
  type SelectableScenario,
  type WorkloadFacts,
} from "../src/lib/lab/selection";

/**
 * A class-sized catalogue: two network scenarios, two OS ones, and one each of
 * hardware, security and identity, so a spread across families is something the
 * fixture can actually be caught failing.
 */
const SCENARIOS: SelectableScenario[] = [
  { id: "hw-driver-device", category: "hardware", difficulty: 3, requiresInternet: false },
  { id: "os-perf-startup", category: "os", difficulty: 2, requiresInternet: false },
  { id: "net-dns-failure", category: "network", difficulty: 2, requiresInternet: true },
  { id: "net-static-ip-conflict", category: "network", difficulty: 3, requiresInternet: false },
  { id: "os-crash-app", category: "os", difficulty: 1, requiresInternet: false },
  { id: "sec-phishing-triage", category: "security", difficulty: 3, requiresInternet: false },
  { id: "id-locked-account", category: "identity", difficulty: 1, requiresInternet: false },
];

/** A workload whose every field is stated by the case that uses it. */
function workload(fields: Partial<WorkloadFacts> & { id: string }): WorkloadFacts {
  return { kind: "vm", scenarioFamilies: [], ...fields };
}

function categoryOf(id: string): string {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id);
  assert.ok(scenario, `${id} is in the fixture`);
  return scenario.category;
}

test("selection: only the scenarios the workload declares survive, the rest carry a reason", () => {
  const entry = workload({ id: "ubuntu-24.04", scenarioFamilies: ["network", "os"], automation: "shell" });
  const { pool, rejected } = eligible(SCENARIOS, entry);

  assert.ok(pool.length > 0, "the declared families have scenarios");
  assert.ok(pool.every((scenario) => entry.scenarioFamilies.includes(scenario.category)));
  assert.ok(rejected.length > 0, "the families it does not declare are refused");
  assert.ok(rejected.every((entry_) => entry_.reason.length > 0), "every refusal says why");
  // Hardware is refused by the devices rule before the family rule, because a VM
  // workload with no devices has nothing to inject a driver fault into.
  assert.ok(rejected.some((entry_) => entry_.id === "hw-driver-device"));
});

test("selection: a container never gets a hardware scenario", () => {
  const container = workload({
    id: "debian-12",
    kind: "container",
    scenarioFamilies: ["hardware", "network"],
    profile: { devices: ["nic"] },
  });
  const { pool, rejected } = eligible(SCENARIOS, container);

  assert.ok(!pool.some((scenario) => scenario.category === "hardware"));
  const refused = rejected.find((entry) => entry.id === "hw-driver-device");
  assert.ok(refused, "the hardware scenario is refused, not silently dropped");
  assert.match(refused.reason, /need a VM, not a container/);
});

test("selection: a VM workload can host hardware scenarios", () => {
  const vm = workload({
    id: "win11-24h2",
    kind: "vm",
    scenarioFamilies: ["hardware"],
    profile: { devices: ["nic", "gpu"] },
  });
  const { pool } = eligible(SCENARIOS, vm);
  assert.ok(pool.some((scenario) => scenario.category === "hardware"));
});

test("selection: an empty device list is no devices, not a device list", () => {
  // The trap this pins: `Boolean([])` is true in JavaScript, so a profile that declares
  // no devices at all would read as "has devices" and let a driver fault through onto a
  // workload that cannot host it.
  const vm = workload({ id: "bare-vm", kind: "vm", scenarioFamilies: ["hardware"], profile: { devices: [] } });
  const { pool, rejected } = eligible(SCENARIOS, vm);

  assert.ok(!pool.some((scenario) => scenario.category === "hardware"));
  assert.ok(rejected.some((entry) => /no devices to break/.test(entry.reason)));
});

test("selection: max difficulty filters and explains", () => {
  const { pool, rejected } = eligible(SCENARIOS, null, 1);
  assert.ok(pool.every((scenario) => scenario.difficulty <= 1));
  assert.ok(rejected.some((entry) => /above the cap/.test(entry.reason)));
});

test("selection: a workload with no automation cannot host an internet scenario", () => {
  const offline = workload({ id: "air-gapped", scenarioFamilies: ["network"], automation: "none" });
  const { pool, rejected } = eligible(SCENARIOS, offline);

  assert.ok(!pool.some((scenario) => scenario.id === "net-dns-failure"));
  assert.ok(rejected.some((entry) => /needs internet/.test(entry.reason)));
});

test("selection: an empty pool is a report, not a crash", () => {
  // `eligible` never throws — it is the caller that decides an empty pool is fatal.
  const { pool, rejected } = eligible([]);
  assert.deepEqual(pool, []);
  assert.deepEqual(rejected, []);
});

test("selection: the choice is deterministic for a seed", () => {
  const first = choose(SCENARIOS, null, [], "balanced", null, 7);
  const second = choose(SCENARIOS, null, [], "balanced", null, 7);
  assert.equal(first.scenario.id, second.scenario.id);
  assert.ok(first.reasons.length > 0, "a choice always explains itself");

  // And the actually-random strategy is seeded too, so a class can be replayed.
  const random = choose(SCENARIOS, null, [], "random", null, 3);
  const randomAgain = choose(SCENARIOS, null, [], "random", null, 3);
  assert.equal(random.scenario.id, randomAgain.scenario.id);
  assert.deepEqual(random.reasons, ["random strategy"]);
});

test("selection: history steers away from a repeat", () => {
  const first = choose(SCENARIOS, null, [], "balanced", null, 1);
  const second = choose(SCENARIOS, null, [first.scenario.id], "balanced", null, 1);

  assert.notEqual(second.scenario.id, first.scenario.id);
  assert.ok(
    second.reasons.some((reason) => /already served/.test(reason)) ||
      second.reasons.some((reason) => /not yet served/.test(reason)),
  );
  // With a history to compare against, the explanation says what it beat.
  assert.ok(second.reasons.some((reason) => /chosen over \d+ other candidate/.test(reason)));
});

test("selection: balanced spreads a class across scenarios and families", () => {
  const history: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    history.push(choose(SCENARIOS, null, history, "balanced", null, index).scenario.id);
  }
  const families = history.map(categoryOf);
  assert.ok(new Set(history).size >= 4, `12 assignments used ${new Set(history).size} scenarios`);
  assert.ok(new Set(families).size >= 3, `12 assignments used ${new Set(families).size} families`);
});

test("selection: the named strategies order and rank as they say", () => {
  const hardest = choose(SCENARIOS, null, [], "hardest");
  const easiest = choose(SCENARIOS, null, [], "easiest");

  assert.ok(hardest.scenario.difficulty >= easiest.scenario.difficulty);
  assert.ok(hardest.score > 0, "the hardest available scores its own difficulty, which is positive");
  assert.ok(easiest.score < 0, "the easiest scores its negated difficulty, so a fresh class is not fooled");
  assert.deepEqual(hardest.reasons, ["hardest available"]);
  assert.deepEqual(easiest.reasons, ["easiest available"]);

  const random = choose(SCENARIOS, null, [], "random", null, 3);
  assert.ok(random instanceof Choice);
});

test("selection: the family strategy narrows to the workload's families", () => {
  const entry = workload({ id: "ubuntu-24.04", scenarioFamilies: ["network"], automation: "shell" });
  const choice = choose(SCENARIOS, entry, [], "family");

  assert.equal(choice.scenario.category, "network");
  assert.ok(choice.reasons.some((reason) => /family strategy, fewest prior runs \(0\)/.test(reason)));
});

test("selection: an unknown strategy is refused, naming the ones that exist", () => {
  assert.throws(
    () => choose(SCENARIOS, null, [], "vibes"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /unknown strategy/);
      for (const strategy of STRATEGIES) assert.match(error.message, new RegExp(strategy));
      return true;
    },
  );
});

test("selection: an empty catalogue is refused", () => {
  assert.throws(() => choose([]), /no scenarios available/);
});

test("selection: an impossible workload is refused with the first reason attached", () => {
  const entry = workload({ id: "ubuntu-24.04", scenarioFamilies: ["network"] });
  assert.throws(
    () => choose(SCENARIOS, entry, [], "balanced", 0),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /no scenario fits this workload/);
      assert.match(error.message, /above the cap/, "the refusal quotes why nothing fit");
      return true;
    },
  );
});

test("selection: the explanation names the scenario, its score and its reasons", () => {
  const entry = workload({ id: "win11-24h2", scenarioFamilies: ["hardware"], profile: { devices: ["nic"] } });
  const choice = choose(SCENARIOS, entry, [], "balanced", null, 2);
  const text = choice.explain();

  assert.ok(text.includes(choice.scenario.id));
  assert.match(text, /score \d+\.\d{2}/);
  assert.ok(choice.reasons.length > 0);
});

test("selection: the history helper reads stored rows and loose sessions alike", () => {
  assert.deepEqual(
    historyFromSessions([{ scenario_id: "a" }, { scenario: "b" }, { scenario_id: "" }]),
    ["a", "b"],
  );
  // The port's own camelCase spelling, for a row built in process rather than read back.
  assert.deepEqual(historyFromSessions([{ scenarioId: "c" }]), ["c"]);
  // A row that names no scenario is skipped rather than becoming an empty entry, which
  // would match nothing and quietly skew every count.
  assert.deepEqual(historyFromSessions([{ student: "ada" }]), []);
});
