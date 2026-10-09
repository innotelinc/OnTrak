/**
 * The fault primitives, and the contract a generated scenario depends on.
 *
 * The lab has no `test_primitives.py`: primitives are exercised through
 * `test_generator.py`, which generates a scenario from each one and validates it. This suite
 * takes the contract directly, because it is the thing the generator relies on and the thing
 * a reviewer of a *new* primitive would otherwise have to check by eye:
 *
 * **A check script must report exactly the objectives the primitive declares.** A check that
 * never names an objective scores it zero for ever, and a check that names one nobody
 * declared scores a student on something the ticket never asked for. Neither shows up as a
 * crash; both show up as a grade that is quietly wrong, which is why it is asserted here.
 *
 * Every primitive's fields were also compared against the Python, field for field, when the
 * module was ported (`scripts` included, character for character); these tests are what keeps
 * that true for the next one.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-primitives.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CATEGORIES } from "../src/lib/lab/models";
import {
  PRIMITIVES,
  PrimitiveError,
  getPrimitive,
  listPrimitives,
  objective,
  primitive,
  primitiveIds,
  primitivesByCategory,
} from "../src/lib/lab/primitives";

const ALL = listPrimitives();

test("primitives: the registry holds the lab's own nine, each with a working check", () => {
  assert.equal(ALL.length, 9, "the lab shipped nine fault primitives");
  assert.equal(new Set(ALL.map((item) => item.id)).size, 9, "ids are unique");

  for (const item of ALL) {
    assert.ok(CATEGORIES.includes(item.category), `${item.id}: ${item.category} is a category`);
    assert.ok(item.label.length > 0, `${item.id} has a label`);
    assert.ok(item.title.length > 0, `${item.id} has a title`);
    assert.ok(item.briefing.length > 40, `${item.id} has a briefing a student can read`);
    assert.ok(item.difficulty >= 1 && item.difficulty <= 4, `${item.id}: difficulty 1-4`);
    assert.ok(item.minutes > 0, `${item.id}: a positive time budget`);
    assert.ok(item.hints.length > 0, `${item.id}: at least one hint`);
    assert.ok(item.tags.length > 0, `${item.id}: at least one tag`);
    assert.ok(item.setupPs.length > 0, `${item.id} has a setup script`);
    assert.ok(item.checkPs.length > 0, `${item.id} has a check script`);
  }
});

test("primitives: every objective is weighted, and each primitive has a critical one", () => {
  for (const item of ALL) {
    assert.ok(item.objectives.length > 0, `${item.id} declares objectives`);
    const ids = item.objectives.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, `${item.id}: objective ids are unique`);
    for (const entry of item.objectives) {
      assert.ok(entry.id.length > 0, `${item.id}: an objective has an id`);
      assert.ok(entry.text.length > 0, `${item.id}.${entry.id}: objective text`);
      assert.ok(entry.weight > 0, `${item.id}.${entry.id}: a positive weight`);
    }
    assert.ok(
      item.objectives.some((entry) => entry.critical),
      `${item.id}: at least one critical objective, or nothing blocks resolution`,
    );
  }
});

test("primitives: every check reports exactly its declared objectives, and nothing else", () => {
  for (const item of ALL) {
    const named = new Set(
      [...item.checkPs.matchAll(/-Objective '([^']+)'/g)].map((match) => match[1] ?? ""),
    );
    const declared = new Set(item.objectives.map((entry) => entry.id));
    const missing = [...declared].filter((id) => !named.has(id));
    const extra = [...named].filter((id) => !declared.has(id));
    assert.deepEqual(missing, [], `${item.id}: every declared objective is reported`);
    assert.deepEqual(extra, [], `${item.id}: no objective is reported that nobody declared`);
    // And it has to use the shared library's helper: the payload the grader reads is what
    // `Add-OnTrakCheck` emits, so a check written another way would report nothing at all.
    assert.ok(
      item.checkPs.includes("Add-OnTrakCheck"),
      `${item.id}: the check reports through the shared library`,
    );
  }
});

test("primitives: every setup reports a step, so a fault that was not applied is visible", () => {
  for (const item of ALL) {
    // The `.ps1` uploads into a guest whose library provides `Write-OnTrakStep`; a setup that
    // reported nothing would leave "the fault did not apply" indistinguishable from silence.
    //
    // Beyond that the scripts differ on purpose: `proxy-hijacked` writes the registry and the
    // WinHTTP proxy with raw cmdlets and `netsh` because the shared library has no helper for
    // either, so an assertion that every setup goes through the library would be a rule the
    // lab does not hold — the invariant is the narration, not the spelling.
    assert.ok(item.setupPs.includes("Write-OnTrakStep"), `${item.id}: the setup narrates its steps`);
  }
});

test("primitives: the two simulations say so in their notes", () => {
  const device = getPrimitive("device-disabled");
  assert.match(device.notes, /stand-in/, "the device fault is honest about being a stand-in");
  const malware = getPrimitive("malware-persistence");
  assert.match(malware.notes, /Simulation only/, "and the malware fault about being a simulation");
  assert.equal(malware.objectives.filter((entry) => entry.critical).length, 2, "two criticals");
});

test("primitives: an unknown id is refused with the list of the ones that exist", () => {
  assert.equal(getPrimitive("service-disabled").id, "service-disabled");
  assert.equal(PRIMITIVES.size, 9);
  assert.throws(
    () => getPrimitive("no-such-fault"),
    (error: unknown) =>
      error instanceof PrimitiveError &&
      /unknown fault primitive "no-such-fault"; known: /.test(error.message) &&
      error.message.includes("dns-resolver-trapped"),
  );
});

test("primitives: the list is ordered by category then id, and grouping loses nobody", () => {
  const order = new Map<string, number>(CATEGORIES.map((category, index) => [category, index]));
  for (let index = 1; index < ALL.length; index += 1) {
    const previous = ALL[index - 1];
    const current = ALL[index];
    assert.ok(previous && current);
    const left = order.get(previous.category) ?? 99;
    const right = order.get(current.category) ?? 99;
    assert.ok(
      left < right || (left === right && previous.id <= current.id),
      `${previous.id} comes before ${current.id}`,
    );
  }

  const grouped = primitivesByCategory();
  const seen = [...grouped.values()].flat().map((item) => item.id);
  assert.deepEqual([...seen].sort(), [...primitiveIds()].sort(), "grouping is a partition");
  assert.deepEqual(
    [...grouped.keys()],
    CATEGORIES.filter((category) => grouped.has(category)),
    "and the groups are in the model's own category order",
  );
});

test("primitives: registering a duplicate id is refused, and changes nothing", () => {
  const before = listPrimitives().map((item) => item.id);
  assert.throws(
    () =>
      primitive({
        id: "service-disabled",
        label: "a second spooler fault",
        category: "software",
        title: "t",
        briefing: "b",
        objectives: [objective("x", "x")],
        setupPs: "s",
        checkPs: "c",
      }),
    /two primitives both claim the id "service-disabled"/,
  );
  assert.deepEqual(
    listPrimitives().map((item) => item.id),
    before,
    "the refusal happens before anything is stored",
  );
});
