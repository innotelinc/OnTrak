/**
 * The session lifecycle, driven end to end with no hypervisor at all.
 *
 * `ontrak/sessions.py` is the largest module in the lab and the one every other moving
 * part goes through, so the point of this suite is the *flow*: request, claim or clone,
 * wait for the transport, grade, reset, complete, reap. It runs against
 * `InMemoryIncus`, `InMemoryLabStore` and a driver that records what it was asked to run
 * rather than pretending to run it — which is the only way those claims are worth
 * anything, because a stub that returns a plausible grade passes whether or not the
 * manager works.
 *
 * Two things make it deterministic, and both are injected rather than stubbed out:
 * the **clock**, so a 90-minute TTL and a 20-minute idle sweep happen now, and the
 * **sleep**, so a retry loop does not take five real seconds. The lab's own data is used
 * where it can be: the scenarios are the 14 converted fixtures and the catalogue is the
 * ported manifests, so a `workload:` pair is resolved through the real code path.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-sessions.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Catalog } from "../src/lib/lab/catalog";
import { loadCatalog, loadScenarios } from "../src/lib/lab/dataset";
import { loadSettings, type LabSettings } from "../src/lib/lab/config";
import { InMemoryIncus } from "../src/lib/lab/memory";
import { JSON_BEGIN, JSON_END, parseIso, type LabSession } from "../src/lib/lab/models";
import {
  RecordingDriver,
  SessionError,
  SessionManager,
  TEMPLATE_PSEUDO_STUDENT,
  testClock,
} from "../src/lib/lab/sessions";
import {
  ScenarioRepository,
  parseScenarioRecord,
  type Scenario,
  type ScenarioEntry,
} from "../src/lib/lab/scenarios";
import { InMemoryLabStore } from "../src/lib/lab/store";
import type { TicketForm } from "../src/lib/lab/tickets";
// The demo's write-up synthesiser, used here because a scenario that asks for a write-up
// cannot be completed without one: the answers are built from the rubric itself (and
// `tests/lab-tickets.test.ts` proves they satisfy every shipped rubric), so this suite is
// not the second place that decides what a passing write-up looks like.
import { synthesiseTicket } from "../src/lib/lab/demo";

/** The 14 real scenarios, from the tree a deployment reads (`scenarios/<id>/scenario.json`). */
function repository(): ScenarioRepository {
  return loadScenarios();
}

/** The ported catalogue manifests, which is what makes `workload:` resolution real. */
function catalog(): Catalog {
  return loadCatalog();
}

function settings(env: Record<string, string> = {}): LabSettings {
  return loadSettings({
    env: { ONTRAK_GUEST__PASSWORD: "TrainMe-1", ...env },
    rootDir: process.cwd(),
  });
}

interface Harness {
  settings: LabSettings;
  store: InMemoryLabStore;
  repo: ScenarioRepository;
  catalog: Catalog;
  incus: InMemoryIncus;
  driver: RecordingDriver;
  shell: RecordingDriver;
  clock: { clock: () => Date; sleep: (seconds: number) => Promise<void>; advance: (seconds: number) => void };
  manager: SessionManager;
}

function harness(env: Record<string, string> = {}): Harness {
  const config = settings(env);
  const store = new InMemoryLabStore();
  const repo = repository();
  const cat = catalog();
  const incus = new InMemoryIncus(config.incus.imageAlias, true);
  const driver = new RecordingDriver(config.guest);
  const shell = new RecordingDriver(config.guest, "shell");
  const time = testClock();
  const manager = new SessionManager({
    settings: config,
    store,
    repository: repo,
    catalog: cat,
    incus,
    driver,
    shellDriver: shell,
    clock: time.clock,
    sleep: time.sleep,
  });
  return { settings: config, store, repo, catalog: cat, incus, driver, shell, clock: time, manager };
}

/** A scenario's check output that passes everything, in the guest's own contract. */
function passingCheck(scenario: Scenario): string {
  const checks = scenario.objectives.map((objective) => ({ objective: objective.id, passed: true }));
  return `\n${JSON_BEGIN}\n${JSON.stringify({ checks })}\n${JSON_END}\n`;
}

/** Build the template a scenario is cloned from, the way a build would have. */
function builtTemplate(harnessed: Harness, scenarioId: string, workload = ""): string {
  const name = harnessed.settings.incus.templateName(scenarioId, workload);
  harnessed.incus.addInstance(name, { running: false, snapshots: ["clean"] });
  return name;
}

/** A prewarmed, running, unclaimed machine for a scenario. */
function prewarmed(harnessed: Harness, scenarioId: string, index: number, workload = ""): string {
  const name = harnessed.settings.incus.poolName(scenarioId, index, workload);
  harnessed.incus.addInstance(name, { running: true });
  return name;
}

/** Event kinds recorded against a session, in order. */
async function eventsFor(harnessed: Harness, session: LabSession): Promise<string[]> {
  const events = await harnessed.manager.sessionEvents(session, 100);
  return events.map((event) => event.kind);
}

/* -------------------------------------------------------------------------- */
/*  request → ready                                                           */
/* -------------------------------------------------------------------------- */

test("sessions: a request is a row, and provisioning fills it in", async () => {
  const h = harness();
  builtTemplate(h, "net-dns-failure");

  const requested = await h.manager.createSession("Ada", "net-dns-failure");
  assert.equal(requested.state, "requested");
  assert.equal(requested.instance, "", "a row with no machine yet");
  assert.equal(requested.student, "ada", "the student name is normalised");
  // 45, not `session.ttl_minutes` (90): the lab's `default_time_limit` returns the FIRST
  // of `time_limit_choices` ([45, 90, 180]), and only falls back to the TTL when a site
  // clears the choices. `sessions.py` asks for exactly that
  // (`int(time_limit_minutes or self.settings.session.default_time_limit)`), and
  // `config.ts` keeps both defaults, so this is the lab's number.
  assert.equal(requested.timeLimitMinutes, 45, "the site default limit");

  const ready = await h.manager.provision(requested);
  assert.equal(ready.state, "ready");
  assert.equal(
    ready.instance,
    h.settings.incus.sessionName("net-dns-failure", ready.id ?? 0, ""),
    "it cloned a fresh machine named for the session",
  );
  assert.ok(ready.hostIp !== "", "and waited until it had an address");
  assert.ok(ready.readyAt !== "", "the moment it became ready is on the row");
  assert.ok(ready.expiresAt !== "", "and so is the limit the student was given");
  assert.ok(
    (parseIso(ready.expiresAt)?.getTime() ?? 0) > h.clock.clock().getTime(),
    "which is in the future by the injected clock, not the real one",
  );

  const stored = await h.store.getSession(ready.id ?? 0);
  assert.equal(stored?.state, "ready", "the row is what the portal reads");

  // Newest first, because that is how the lab reads its own trail (`ORDER BY id DESC`) and
  // the point of an audit log is the last thing that happened. There is no `allocating`
  // entry: the lab logs the request, the clone and the readiness, and the intermediate
  // states are what the *row* says, not what the log says.
  assert.deepEqual(await eventsFor(h, ready), ["ready", "cloned", "requested"]);
});

test("sessions: a prewarmed machine is claimed, and it keeps its pool name", async () => {
  const h = harness();
  builtTemplate(h, "net-dns-failure");
  const pooled = prewarmed(h, "net-dns-failure", 1);

  const session = await h.manager.allocate("Ada", "net-dns-failure");
  assert.equal(session.state, "ready");
  assert.equal(session.instance, pooled, "the pooled machine, not a new clone");
  assert.ok(
    (await eventsFor(h, session)).includes("claimed_pool"),
    "a claim is on the record",
  );
  assert.equal(
    [...h.incus.liveNames()].includes(h.settings.incus.sessionName("net-dns-failure", session.id ?? 0, "")),
    false,
    "nothing was cloned for a session that found a warm machine",
  );
});

test("sessions: a Linux scenario is driven by the shell transport", async () => {
  const h = harness();
  // This scenario declares a workload (`ubuntu-24.04`), and the manager resolves an unset
  // one to the *first declared* — the lab's rule — so the template to clone is the one for
  // that workload. Building the bare golden image instead is what the availability check
  // refuses, by name and with the command to fix it.
  builtTemplate(h, "linux-perms-chmod-repair", "ubuntu-24.04");

  const session = await h.manager.allocate("Ada", "linux-perms-chmod-repair");
  assert.equal(session.state, "ready");
  assert.equal(session.workload, "ubuntu-24.04", "the scenario's first declared workload");

  // A clone copies the template, so nothing is pushed into the guest at allocation: the lab
  // uploads a scenario's files when the template is built and again when a check runs. A
  // check is therefore what makes the transport visible — and it is the thing that has to
  // speak the guest's language to grade at all.
  await h.manager.runChecks(session);

  assert.ok(h.shell.uploads.length > 0, "the shell driver copied the scenario in");
  assert.equal(h.driver.uploads.length, 0, "and the Windows transport was not used");
  assert.ok(
    h.shell.scripts.some((script) => script.remotePath.endsWith("check.sh")),
    "check.sh ran over the shell transport",
  );
  assert.equal(h.driver.scripts.length, 0, "no PowerShell was run at a Linux guest");
});

test("sessions: asking twice for the scenario already running returns that machine", async () => {
  const h = harness();
  builtTemplate(h, "net-dns-failure");

  const first = await h.manager.allocate("Ada", "net-dns-failure");
  const again = await h.manager.createSession("ada", "net-dns-failure");
  assert.equal(again.id, first.id, "a reload does not burn a second VM");
  assert.equal([...h.incus.liveNames()].filter((name) => name.includes("ontrak-sess")).length, 1);
});

test("sessions: the per-student limit refuses a second machine and says what is holding it", async () => {
  const h = harness();
  builtTemplate(h, "net-dns-failure");
  builtTemplate(h, "hw-driver-device");
  await h.manager.allocate("Ada", "net-dns-failure");

  await assert.rejects(
    () => h.manager.createSession("Ada", "hw-driver-device"),
    (error: unknown) =>
      error instanceof SessionError &&
      /already has a live session \(net-dns-failure\)/.test(error.message),
  );
});

test("sessions: a scenario the range cannot run is refused before a row exists", async () => {
  const h = harness();
  // No template and no pool, but the golden image is published, so the missing layer is
  // named rather than the session dying in a thread.
  const reason = await h.manager.scenarioAvailability("net-dns-failure");
  assert.match(reason, /its template tpl-net-dns-failure has not been built/);
});

/* -------------------------------------------------------------------------- */
/*  grading                                                                   */
/* -------------------------------------------------------------------------- */

test("sessions: a check grades the work and is discarded by default", async () => {
  const h = harness();
  builtTemplate(h, "net-dns-failure");
  const scenario = h.repo.get("net-dns-failure");
  h.driver.answers.set("check.ps1", passingCheck(scenario));

  const session = await h.manager.allocate("Ada", "net-dns-failure");
  const report = await h.manager.runChecks(session);

  assert.equal(report.error, "");
  assert.equal(report.score, 100);
  assert.equal(report.resolved, true);
  assert.equal(session.resolved, true, "resolving is sticky");
  assert.equal(session.state, "passed");
  assert.equal(
    await h.store.attemptCounts(session.id ?? 0),
    0,
    "results-only: the machine stays the student's to practise on",
  );
  assert.ok((await eventsFor(h, session)).includes("checked_discarded"));
});

test("sessions: the submission is the one that is recorded", async () => {
  const h = harness();
  builtTemplate(h, "net-dns-failure");
  const scenario = h.repo.get("net-dns-failure");
  h.driver.answers.set("check.ps1", passingCheck(scenario));

  const session = await h.manager.allocate("Ada", "net-dns-failure");
  await h.manager.runChecks(session, true);

  assert.equal(await h.store.attemptCounts(session.id ?? 0), 1, "one row per recorded check");
  const latest = await h.store.latestReport(session.id ?? 0);
  assert.equal(latest?.score, 100);
  assert.ok((await eventsFor(h, session)).includes("checked"));
});

test("sessions: breaking it again does not take the credit back", async () => {
  const h = harness();
  builtTemplate(h, "net-dns-failure");
  const scenario = h.repo.get("net-dns-failure");
  h.driver.answers.set("check.ps1", passingCheck(scenario));

  const session = await h.manager.allocate("Ada", "net-dns-failure");
  const passed = await h.manager.runChecks(session);
  assert.equal(passed.resolved, true);
  const best = session.bestScore;

  // The student breaks the fix, then checks again: the score tells the truth, and the
  // resolution they earned stays earned.
  h.driver.answers.set("check.ps1", "the script says nothing at all");
  const failed = await h.manager.runChecks(session);
  assert.equal(failed.resolved, false, "this run did not resolve it");
  assert.equal(session.resolved, true, "but the session is still resolved");
  assert.equal(session.state, "passed");
  assert.equal(session.bestScore, best, "the best score is not lowered by a bad run");
});

test("sessions: a grading failure is an error, not a zero", async () => {
  const h = harness();
  builtTemplate(h, "net-dns-failure");
  h.driver.answers.set("check.ps1", "no payload between the markers");

  const session = await h.manager.allocate("Ada", "net-dns-failure");
  const report = await h.manager.runChecks(session);

  assert.ok(report.error !== "", "a crashed check must not look like a student who fixed nothing");
  assert.equal(session.resolved, false);
  assert.equal(await h.store.attemptCounts(session.id ?? 0), 0);
});

/* -------------------------------------------------------------------------- */
/*  reset, complete                                                           */
/* -------------------------------------------------------------------------- */

test("sessions: reset throws the machine away and hands back a fresh one", async () => {
  const h = harness();
  builtTemplate(h, "net-dns-failure");

  const session = await h.manager.allocate("Ada", "net-dns-failure");
  const first = session.instance;
  const reset = await h.manager.reset(session);

  assert.equal(reset.state, "ready");
  assert.ok(reset.instance !== "", "a machine, again");
  assert.equal(reset.instance, first, "the same session name is reused after the old one is gone");
  assert.equal([...h.incus.liveNames()].includes(first), true);
  assert.ok((await eventsFor(h, reset)).includes("reset"));
});

test("sessions: complete records one result, ends the session and removes the machine", async () => {
  const h = harness();
  builtTemplate(h, "net-dns-failure");
  const scenario = h.repo.get("net-dns-failure");
  h.driver.answers.set("check.ps1", passingCheck(scenario));

  const session = await h.manager.allocate("Ada", "net-dns-failure");
  const instance = session.instance;
  // The scenario asks for a write-up, so one is handed in: a scenario with a form treats
  // documentation as part of the work (see the two tests below).
  const form = h.manager.ticketFormFor(session) as TicketForm;
  const report = await h.manager.complete(session, synthesiseTicket(form));

  assert.equal(report.resolved, true);
  assert.equal(report.score, 100, "the machine passed, so the blend is a hundred");
  assert.equal(report.ticketScore, 100, "and the write-up half is kept, not just mixed in");
  assert.equal(report.ticketWeight, form.weight);
  assert.equal(session.state, "passed");
  assert.equal(session.instance, "", "the machine is gone");
  assert.equal([...h.incus.liveNames()].includes(instance), false);
  assert.equal(await h.store.attemptCounts(session.id ?? 0), 1, "exactly one stored attempt");
  assert.equal((await h.store.ticketsForSession(session.id ?? 0)).length, 1, "and one write-up");
  const events = await eventsFor(h, session);
  assert.ok(events.includes("completed"));
  assert.ok(events.includes("ticket_graded"), "the write-up's own mark is in the audit trail");

  await assert.rejects(
    () => h.manager.complete(session),
    (error: unknown) => error instanceof SessionError && /nothing to complete/.test(error.message),
  );
});

test("sessions: a write-up is blended into the grade, and the two halves stay apart", async () => {
  const h = harness();
  builtTemplate(h, "net-dns-failure");
  const scenario = h.repo.get("net-dns-failure");
  h.driver.answers.set("check.ps1", passingCheck(scenario));

  const session = await h.manager.allocate("Ada", "net-dns-failure");
  // Marking the draft is what the portal's Preview does, and it is what `complete` is
  // handed if the student does not submit values with the button.
  const form = h.manager.ticketFormFor(session) as TicketForm;
  const answers = synthesiseTicket(form);
  await h.manager.saveTicketDraft(session, answers);
  assert.deepEqual(await h.manager.ticketAnswers(session), answers, "the draft is kept");
  const preview = await h.manager.gradeTicket(session);
  assert.equal(preview?.score, 100, "and marks full marks without recording anything");

  const report = await h.manager.complete(session);
  assert.equal(report.resolved, true);
  assert.equal(report.machineScore, 100, "the machine half is what the script reported");
  assert.equal(report.score, 100, "machine 100 and write-up 100, whatever the weight is");
  assert.ok(
    report.notes.some((note) => /machine 100% x 70% \+ ticket 100% x 30%/.test(note)),
    `the report breaks the blend down: ${report.notes.join(" | ")}`,
  );
  assert.deepEqual(
    await h.store.ticketDraft(session.id ?? 0),
    {},
    "handing the write-up in forgets the draft it came from",
  );
  assert.deepEqual(
    await h.store.ticketValues(session.id ?? 0),
    answers,
    "and the answers are stored beside the mark",
  );
});

test("sessions: an unsubmitted write-up is a zero and the attempt cannot resolve", async () => {
  const h = harness();
  builtTemplate(h, "net-dns-failure");
  const scenario = h.repo.get("net-dns-failure");
  assert.ok(h.manager.ticketForm(scenario) !== null, "this fixture asks for a write-up");
  h.driver.answers.set("check.ps1", passingCheck(scenario));

  const session = await h.manager.allocate("Ada", "net-dns-failure");
  const report = await h.manager.complete(session);

  // The machine was fixed — the script says so — and the work was not documented, so the
  // ticket counts as zero and the attempt does not resolve. That is the lab's own rule:
  // "the fix nobody recorded" is not a finished job.
  assert.equal(report.machineScore, 100, "the machine half is marked honestly");
  assert.equal(report.ticketScore, 0);
  assert.equal(report.score, 70, "a hundred machine marks, discounted by the write-up's weight");
  assert.equal(report.resolved, false);
  assert.equal(session.state, "failed");
  assert.ok(
    report.notes.some((note) => /no ticket was submitted/.test(note)),
    "and the report says which half was missing rather than just showing a lower number",
  );
});

/* -------------------------------------------------------------------------- */
/*  the pool and the sweeps                                                   */
/* -------------------------------------------------------------------------- */

test("sessions: prewarm fills only the deficit and stops at the ceiling", async () => {
  const h = harness({ ONTRAK_POOL__MAX_TOTAL: "2" });
  builtTemplate(h, "net-dns-failure");

  assert.equal(await h.manager.prewarm("net-dns-failure", 5), 2, "the ceiling caps it");
  assert.equal(await h.manager.prewarm("net-dns-failure", 1), 0, "and the pool is full");

  const status = await h.manager.poolStatus("net-dns-failure");
  const row = status[0];
  assert.equal(row?.total, 2);
  assert.equal(row?.target, 0, "targets default to 0: nothing is resident until a class is due");
  assert.equal(row?.ready, 2, "both are booted and unclaimed");
});

test("sessions: draining the pool takes the spare machines and leaves the student's", async () => {
  const h = harness();
  builtTemplate(h, "net-dns-failure");
  prewarmed(h, "net-dns-failure", 1);
  prewarmed(h, "net-dns-failure", 2);

  const session = await h.manager.allocate("Ada", "net-dns-failure");
  const held = session.instance;
  assert.equal(held, h.settings.incus.poolName("net-dns-failure", 1, ""), "the lowest name is claimed");

  assert.equal(await h.manager.drainPool("net-dns-failure"), 1, "one spare went");
  const live = h.incus.liveNames();
  assert.equal(live.has(held), true, "a student still working keeps their machine");
  assert.equal(live.has(h.settings.incus.poolName("net-dns-failure", 2, "")), false);
});

test("sessions: the sweep recycles what has run out and nothing else", async () => {
  const h = harness();
  builtTemplate(h, "net-dns-failure");
  builtTemplate(h, "hw-driver-device");

  const expiring = await h.manager.allocate("Ada", "net-dns-failure");
  const idle = await h.manager.allocate("Grace", "hw-driver-device");

  // Twenty-five minutes pass with nobody touching anything: the TTL has not run out, but
  // the idle window has. Ada is then recorded opening her console again, so the two
  // sessions are not both idle — otherwise this would prove only that the sweep works on
  // whichever it looked at first.
  h.clock.advance(25 * 60);
  await h.manager.touch(expiring);
  const firstPass = await h.manager.reap();
  assert.deepEqual(firstPass.recycled, [idle.id], "only the idle one went");
  const idleAfter = await h.store.getSession(idle.id ?? 0);
  assert.equal(idleAfter?.state, "destroyed");

  // Past the 90-minute limit, the other one goes too.
  h.clock.advance(70 * 60);
  const secondPass = await h.manager.reap();
  assert.deepEqual(secondPass.recycled, [expiring.id]);
  const expiringAfter = await h.store.getSession(expiring.id ?? 0);
  assert.equal(expiringAfter?.state, "destroyed");
  assert.ok((expiringAfter?.notes ?? "").includes("ttl_expired"));
});

/* -------------------------------------------------------------------------- */
/*  ownership                                                                 */
/* -------------------------------------------------------------------------- */

test("sessions: a session cannot be handed to another student", async () => {
  const h = harness();
  builtTemplate(h, "net-dns-failure");
  const session = await h.manager.allocate("Ada", "net-dns-failure");

  await assert.rejects(
    () => h.manager.getOwnedSession("Grace", session.id ?? 0),
    (error: unknown) => error instanceof SessionError && /belongs to another student/.test(error.message),
  );
  const asInstructor = await h.manager.getOwnedSession("Grace", session.id ?? 0, true);
  assert.equal(asInstructor.id, session.id, "an instructor may act on any session");
});

test("sessions: the template a scenario clones is keyed by its workload too", async () => {
  const h = harness();
  const template = builtTemplate(h, "net-dns-failure");
  assert.equal(template, "tpl-net-dns-failure", "no workload means the site's golden image");

  const withWorkload = h.settings.incus.templateName("net-dns-failure", "win11-24h2");
  assert.equal(withWorkload, "tpl-net-dns-failure-win11-24h2", "the same fault on a named platform is another machine");
  assert.equal(
    h.settings.incus.sessionName("net-dns-failure", 7, "win11-24h2"),
    "ontrak-sess-net-dns-failure-win11-24h2-7",
  );
  assert.equal(TEMPLATE_PSEUDO_STUDENT, "<template>", "a template build is not a student's session");
});
