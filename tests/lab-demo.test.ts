/**
 * Demo mode is the fastest way for someone to judge the lab, so it has to actually work end
 * to end: assign, provision, check, submit, tear down — and it has to honour the
 * results-only policy, because that is the promise the UI makes.
 *
 * Ported from `OnTrak-dev/tests/test_demo.py`. The two cases that are *not* here are the
 * portal's: signing in through the demo door and driving a Linux scenario from the browser
 * are stage 3's, and they live with the routes (docs/lab-port.md §5). What can be proven
 * without a browser is here, and it is the part that matters: no hypervisor, no database and
 * no secrets, with the real session manager, the real scoring and the real store.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-demo.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadSettings, requireSecrets, type LabSettings } from "../src/lib/lab/config";
import { loadCatalog } from "../src/lib/lab/dataset";
import {
  DEMO_INSTRUCTOR,
  DemoDriver,
  buildDemoEnvironment,
  demoAccounts,
  renderDemoSummary,
  runDemo,
  seedPool,
  seedRange,
  synthesiseTicket,
  type DemoEnvironment,
} from "../src/lib/lab/demo";
import { grade as gradeTicket } from "../src/lib/lab/tickets";
import { JSON_BEGIN } from "../src/lib/lab/models";
import { InMemoryLabStore } from "../src/lib/lab/store";
import { choose } from "../src/lib/lab/selection";

/** Demo settings with demo mode on, which is what a first run of `ontrak demo` is. */
function demoSettings(env: Record<string, string> = {}): LabSettings {
  return loadSettings({
    env: { ...env, ONTRAK_DEMO__ENABLED: "true" },
    rootDir: process.cwd(),
  });
}

function environment(options: { successRate?: number; seed?: number } = {}): DemoEnvironment {
  return buildDemoEnvironment({
    settings: demoSettings(),
    successRate: options.successRate ?? 1,
    seed: options.seed ?? 3,
  });
}

test("demo: needs no secrets at all, and says so rather than failing at start", () => {
  const settings = demoSettings();
  assert.equal(settings.demo.enabled, true);
  assert.deepEqual(
    requireSecrets(settings),
    [],
    "demo mode short-circuits the secret requirements: clone and try it in two commands",
  );
  // And the same settings without demo mode *do* demand them, so the short-circuit is the
  // demo's and not a hole in the checker.
  const strict = loadSettings({ env: {}, rootDir: process.cwd() });
  assert.ok(requireSecrets(strict).length > 0, "a real deployment still has to set its secrets");
});

test("demo: the hypervisor is in memory, and the manager is using it", () => {
  const env = environment();
  assert.equal(env.incus.constructor.name, "InMemoryIncus");
  assert.equal(env.manager.hasHypervisor(), true);
  assert.equal(env.store instanceof InMemoryLabStore, true, "and the store needs no database");
});

test("demo: the roster is the students then the instructor, and it is stable", () => {
  const settings = demoSettings();
  const first = demoAccounts(settings);
  assert.deepEqual(demoAccounts(settings), first, "the same names every time");
  assert.equal(first.length, 7, "six students and the instructor, the lab's own roster");
  assert.equal(first[first.length - 1], DEMO_INSTRUCTOR);
  assert.equal(first[0], "student1");
  assert.deepEqual(demoAccounts(settings, 99), first, "asking for more than exist is clamped");
  assert.deepEqual(demoAccounts(settings, 2), ["student1", "student2", DEMO_INSTRUCTOR]);
});

test("demo: the simulated guest reports every objective the scenario declares", async () => {
  const env = environment();
  const scenario = env.repository.list()[0];
  assert.ok(scenario);
  const driver = new DemoDriver(env.settings.guest, env.repository, { successRate: 1 });
  const result = await driver.runPowerShell(`& 'C:\\ProgramData\\OnTrak\\scenarios\\${scenario.id}\\check.ps1'`);
  assert.ok(result.stdout.includes(JSON_BEGIN), "the grader's marker is there");
  for (const objective of scenario.objectives) {
    assert.ok(result.stdout.includes(objective.id), `${objective.id} is reported`);
  }
  assert.equal(result.exitCode, 0);
});

test("demo: setup reports the marker the manager insists on", async () => {
  const env = environment();
  const driver = new DemoDriver(env.settings.guest, env.repository);
  const setup = await driver.runPowerShell("& 'C:\\ProgramData\\OnTrak\\scenarios\\x\\setup.ps1'");
  assert.match(setup.stdout, /ONTRAK-SETUP-OK/);
  const shell = await driver.runShell("sh /usr/share/ontrak/scenarios/x/setup.sh");
  assert.match(shell.stdout, /ONTRAK-SETUP-OK/, "and the shell transport answers too");
});

test("demo: partial credit is reproducible, and the seed is what decides it", async () => {
  const env = environment();
  const scenario = env.repository.list()[0];
  assert.ok(scenario);
  const path = `check.ps1 ${scenario.id}`;
  const first = await new DemoDriver(env.settings.guest, env.repository, { successRate: 0.5, seed: 11 }).runPowerShell(path);
  const again = await new DemoDriver(env.settings.guest, env.repository, { successRate: 0.5, seed: 11 }).runPowerShell(path);
  assert.equal(first.stdout, again.stdout, "a demo run can be shown twice and match");
  const other = await new DemoDriver(env.settings.guest, env.repository, { successRate: 0.5, seed: 99 }).runPowerShell(path);
  assert.notEqual(other.stdout, first.stdout, "and a different seed gives a different mix");
});

test("demo: a template is built for every (scenario, workload) pair, and only some are warm", async () => {
  const env = environment();
  const ids = env.repository.list().map((scenario) => scenario.id);
  const expected = new Set(
    env.manager
      .workloadPairs()
      .map(({ scenario, workload }) => (workload ? `${scenario.id}@${workload}` : scenario.id)),
  );
  const built = await seedPool(env, ids, { perScenario: 2, prewarmIds: ids.slice(0, 2) });
  assert.deepEqual(new Set(Object.keys(built)), expected, "every pair has a template");

  const warm = Object.entries(built).filter(([, count]) => count > 0);
  assert.ok(warm.length > 0, "the requested scenarios are warm");
  for (const [, count] of warm) assert.equal(count, 2);
  assert.ok(warm.length < Object.keys(built).length, "and only the nominated ones");
  assert.ok(
    (await env.manager.poolStatus()).every((row) => row.templateReady),
    "the status rows agree the templates are ready",
  );
});

test("demo: seeding the range makes every scenario startable", async () => {
  const env = environment();
  const before = await env.manager.unavailableScenarios();
  assert.ok(Object.keys(before).length > 0, "nothing is startable on a fresh demo environment");
  await seedRange(env);
  assert.deepEqual(
    await env.manager.unavailableScenarios(),
    {},
    "without seeding, a demo portal's whole student flow dead-ends at 'not available yet'",
  );
});

test("demo: a whole class runs — assign, provision, check, submit, tear down", async () => {
  const summary = await runDemo({
    settings: demoSettings(),
    scenarioIds: ["net-dns-failure", "linux-dir-tree-build"],
    students: 4,
    verbose: false,
  });

  assert.equal(summary.students.length, 4);
  for (const row of summary.students) {
    assert.equal(row.error, "", `${row.student} provisioned cleanly`);
    assert.ok(["ready", "in_use", "passed"].includes(row.state), `${row.student} is ${row.state}`);
    assert.ok(row.instance !== "", `${row.student} has a machine`);
  }
  assert.equal(summary.completed.length, 4, "every student handed the work in");
  for (const row of summary.completed) {
    assert.equal(row.score, 100, "with a clean success rate every objective passes");
    assert.equal(row.resolved, true);
  }
  for (const row of summary.graded) assert.equal(row.previewScore, 100);
});

test("demo: only the submitted grade is stored, and the machine is gone", async () => {
  const env = environment();
  const summary = await runDemo({
    settings: demoSettings(),
    store: env.store,
    scenarioIds: ["net-dns-failure"],
    students: 2,
    verbose: false,
  });
  assert.equal(summary.completed.length, 2);

  const stored = await env.store.listSessions({ limit: 50 });
  const submitted = stored.filter((session) => session.state === "passed" || session.state === "failed");
  assert.equal(submitted.length, 2);
  for (const session of submitted) {
    assert.equal(
      await env.store.attemptCounts(session.id ?? 0),
      1,
      "exactly one stored result per submission: the preview check left no trace",
    );
    assert.equal(session.instance, "", "the machine is destroyed on submission");
  }
  assert.ok(summary.results.some((row) => row.reports.length === 1), "and the results page has rows");
});

test("demo: a preview run grades without submitting", async () => {
  const summary = await runDemo({
    settings: demoSettings(),
    scenarioIds: ["net-dns-failure"],
    students: 2,
    completeSessions: false,
    verbose: false,
  });
  assert.equal(summary.graded.length, 2);
  assert.deepEqual(summary.completed, []);
  for (const row of summary.graded) assert.equal(row.previewScore, 100);
  assert.match(summary.notes.join(" "), /not handed in/, "and the summary says so");
});

test("demo: automatic assignment mixes the class up, and says why each student got theirs", async () => {
  const summary = await runDemo({
    settings: demoSettings(),
    students: 6,
    verbose: false,
  });
  const assigned = new Set(summary.students.map((row) => row.scenarioId));
  assert.ok(assigned.size >= 4, `six students got ${assigned.size} distinct scenarios`);
  for (const row of summary.students) {
    assert.ok(row.reason !== "", `${row.student} was given a reason`);
  }
});

test("demo: an explicit scenario list is honoured rather than auto-assigned", async () => {
  const summary = await runDemo({
    settings: demoSettings(),
    scenarioIds: ["net-dns-failure"],
    students: 3,
    verbose: false,
  });
  assert.deepEqual(new Set(summary.students.map((row) => row.scenarioId)), new Set(["net-dns-failure"]));
  for (const row of summary.students) assert.match(row.reason, /rotated from the requested list/);
});

test("demo: every student gets a time limit from the site's choices", async () => {
  const summary = await runDemo({
    settings: demoSettings(),
    scenarioIds: ["net-dns-failure"],
    students: 2,
    verbose: false,
  });
  for (const row of summary.students) {
    assert.ok([45, 90, 180].includes(row.minutes), `${row.student} got ${row.minutes} minutes`);
  }
  assert.ok(summary.stats["templates"], "and the stats a dashboard reads are there");
});

test("demo: the run renders as a report", async () => {
  const summary = await runDemo({
    settings: demoSettings(),
    scenarioIds: ["net-dns-failure"],
    students: 2,
    verbose: false,
  });
  const text = renderDemoSummary(summary);
  assert.match(text, /OnTrak demo run/);
  assert.match(text, /student1/);
  assert.match(text, /Only the submitted grade is stored/);
  assert.match(
    text,
    /the write-up each student handed in was synthesised from the scenario's rubric/,
    "what the run did is stated, not implied",
  );
  assert.match(text, /blend of the machine check and that write-up/);
});

test("demo: the same selection API the portal uses works against the demo catalogue", () => {
  const env = environment();
  const catalog = loadCatalog();
  const entry = catalog.load().get("win11-24h2");
  assert.ok(entry, "the catalogue has the Windows workload");
  const choice = choose(env.repository.list(), entry, [], "balanced", null, 1);
  assert.ok(
    entry.scenarioFamilies.includes(choice.scenario.category),
    `the demo assignment respects the workload's families (got ${choice.scenario.category})`,
  );
});

test("demo: the submitted grade is the blend, so the write-up is exercised too", async () => {
  // `net-dns-failure` asks for a write-up, and the demo answers it from the rubric. Without
  // that, a run would show every scenario that asks for one scoring a zero on half its
  // rubric — which is what the port did while `tickets.py` was still unported.
  const summary = await runDemo({
    settings: demoSettings(),
    scenarioIds: ["net-dns-failure"],
    students: 3,
    successRate: 1,
    verbose: false,
  });
  assert.equal(summary.completed.length, 3);
  for (const row of summary.completed) {
    assert.equal(row.machineScore, 100, `${row.student}: the simulated guest passed everything`);
    assert.equal(row.ticketScore, 100, `${row.student}: and the synthesised write-up scored full marks`);
    assert.equal(row.score, 100, `${row.student}: the blend of two hundreds is a hundred`);
    assert.equal(row.resolved, true, row.student);
  }
  assert.match(summary.notes.join("\n"), /write-up each student handed in was synthesised/);
});

test("demo: writeUps false leaves the write-up out, and a scenario asking for one fails", async () => {
  const summary = await runDemo({
    settings: demoSettings(),
    scenarioIds: ["net-dns-failure"],
    students: 2,
    successRate: 1,
    writeUps: false,
    verbose: false,
  });
  assert.equal(summary.completed.length, 2);
  for (const row of summary.completed) {
    assert.equal(row.machineScore, 100, row.student);
    assert.equal(row.ticketScore, 0, `${row.student}: nothing was handed in`);
    assert.ok(row.score < 100, `${row.student}: so the blend is discounted, not the machine mark`);
    assert.equal(row.resolved, false, `${row.student}: an undocumented fix is not a resolved ticket`);
  }
  assert.match(summary.notes.join("\n"), /write-ups were left out/);
});

test("demo: the scenario's write-up rubric is answered from the rubric, field by field", () => {
  const env = environment({ successRate: 1 });
  const scenario = env.repository.get("net-dns-failure");
  const form = env.manager.ticketForm(scenario);
  assert.notEqual(form, null, "the fixture asks for a write-up");
  if (form === null) return;
  const answers = synthesiseTicket(form);
  assert.deepEqual(
    Object.keys(answers).sort(),
    form.fields.map((field) => field.id).sort(),
    "every field is answered, and nothing else is sent",
  );
  const marked = gradeTicket(form, answers, { scenarioId: scenario.id });
  assert.equal(marked.score, 100, "and the rubric is satisfied");
});
