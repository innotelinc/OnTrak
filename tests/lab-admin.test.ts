/**
 * The admin panel's read models.
 *
 * The panel itself is JSX over these, so this is where the panel's *rules* are pinned: which
 * section a path is, that a state count hides nothing, that a host reading which failed is a
 * line rather than a 500, that a catalogue entry is shown with the plan the host's facts imply,
 * and that the schedule's plan is computed rather than guessed. Everything here is a value, so
 * the suite needs no server, no database, no hypervisor and no clock of its own.
 *
 * The catalogue, the lessons and the scenarios are the **shipped data** — the same tree a
 * deployment reads — so "every entry plans" is a statement about the real range rather than
 * about a fixture written to make it true.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-admin.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADMIN_SECTIONS,
  auditKindOptions,
  catalogFacts,
  guardedRead,
  liveCount,
  platformGroups,
  readyPool,
  readyTemplates,
  scenarioKey,
  scenariosWithTicket,
  scheduleView,
  sectionForPath,
  settingsSummary,
  stateCounts,
} from "../src/lib/lab/admin";
import { loadSettings } from "../src/lib/lab/config";
import { loadCatalog, loadLessons, loadScenarios, scenarioFiles } from "../src/lib/lab/dataset";
import { SESSION_STATES, newLabSession, type SessionState } from "../src/lib/lab/models";
import { LabSchedule, LabWindow } from "../src/lib/lab/scheduler";

/* -------------------------------------------------------------------------- */
/*  The nav                                                                   */
/* -------------------------------------------------------------------------- */

test("admin: the nav's paths resolve to exactly one section each", () => {
  const ids = ADMIN_SECTIONS.map((section) => section.id);
  assert.equal(new Set(ids).size, ids.length, "no section id is used twice");
  const hrefs = ADMIN_SECTIONS.map((section) => section.href);
  assert.equal(new Set(hrefs).size, hrefs.length, "no two sections share a page");

  assert.equal(sectionForPath("/lab/admin")?.id, "overview", "the panel root is the overview");
  assert.equal(sectionForPath("/lab/admin/users")?.id, "users");
  assert.equal(sectionForPath("/lab/admin/schedule/")?.id, "schedule", "a trailing slash is the same page");
  assert.equal(sectionForPath("/lab/admin/tickets/7")?.id, "tickets", "a detail page is its section");
  assert.equal(
    sectionForPath("/lab/admin/tickets/7"),
    sectionForPath("/lab/admin/tickets"),
    "a detail page does not fall back to the overview's prefix",
  );
  assert.equal(sectionForPath("/lab/nope"), undefined, "a page the panel does not own has no section");
});

/* -------------------------------------------------------------------------- */
/*  Counting the estate                                                       */
/* -------------------------------------------------------------------------- */

test("admin: a state count seeds every state, and hides nothing", () => {
  const sessions = [
    { state: "ready" as SessionState },
    { state: "ready" as SessionState },
    { state: "destroyed" as SessionState },
  ];
  const counts = stateCounts(sessions);

  for (const state of SESSION_STATES) {
    assert.equal(typeof counts[state], "number", `${state} is present even when it is zero`);
  }
  assert.equal(counts.ready, 2);
  assert.equal(counts.destroyed, 1);
  assert.equal(counts.error, 0, "a state nobody is in reads as zero, not as absent");

  // A state the model does not know is counted under its own key rather than dropped: a
  // dashboard that silently omits a session is worse than one that shows a state somebody
  // has to explain.
  const unknown = stateCounts([{ state: "quarantined" as SessionState }]);
  assert.equal(unknown.quarantined, 1);

  assert.equal(liveCount(counts), 2, "ready is live; destroyed is not");
  assert.equal(
    liveCount(stateCounts([])),
    0,
    "an empty estate is zero live machines, not a division by nothing",
  );
});

test("admin: the host readings count an empty list without a type error", () => {
  assert.equal(readyTemplates([]), 0);
  assert.equal(readyPool([]), 0);
  assert.equal(readyTemplates([{ ready: true }, { ready: false }, { ready: true }]), 2);
  assert.equal(readyPool([{ ready: 2 }, { ready: 0 }, { ready: 3 }]), 5);

  const settings = settingsSummary(loadSettings({ env: {} }));
  assert.ok(settings.ttlMinutes > 0, "the session lifetime has a value to print");
  assert.equal(typeof settings.poolEnabled, "boolean");
});

test("admin: a guarded read reports the failure and hands back nothing", async () => {
  const problems: string[] = [];
  const ok = await guardedRead("templates", async () => [1, 2], problems);
  assert.deepEqual(ok, [1, 2]);
  assert.deepEqual(problems, [], "a read that worked reports nothing");

  const failed = await guardedRead(
    "warm pool",
    async () => {
      throw new Error("incus: daemon is not running");
    },
    problems,
  );
  assert.deepEqual(failed, [], "the fallback is the empty list the counters accept");
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /warm pool/);
  assert.match(problems[0] ?? "", /daemon is not running/, "the host's own words are kept");
});

/* -------------------------------------------------------------------------- */
/*  The catalogue, planned                                                    */
/* -------------------------------------------------------------------------- */

test("admin: every shipped catalogue entry is shown with a plan", () => {
  const catalog = loadCatalog();
  const groups = platformGroups(catalog, []);

  assert.equal(groups.length, catalog.groupList().length, "one group per catalogue group");
  const entries = groups.flatMap((group) => group.entries);
  assert.equal(entries.length, catalog.load().size, "every entry appears exactly once, in its group");
  assert.ok(entries.length > 0, "the shipped catalogue is not empty");
  assert.ok(
    entries.every((entry) => entry.plan !== null),
    "planning is guarded per entry, and the shipped catalogue plans cleanly",
  );

  // The rule the page exists for: an entry whose image the host does not hold names the alias
  // that is missing, and the same entry plans without a blocker once the host has it.
  const imageLaunched = entries.filter((entry) => entry.plan?.strategy === "image-launch");
  assert.ok(imageLaunched.length > 0, "the catalogue has image-backed entries to plan");

  for (const { entry, plan } of imageLaunched) {
    assert.ok(
      plan?.blockers.some((blocker) => blocker.includes(entry.imageAlias)),
      `${entry.id}: a missing image is named as the blocker`,
    );
  }

  const aliases = imageLaunched.map(({ entry }) => entry.imageAlias);
  const withImages = new Map(
    platformGroups(catalog, aliases)
      .flatMap((group) => group.entries)
      .map(({ entry, plan }) => [entry.id, plan]),
  );
  for (const { entry } of imageLaunched) {
    assert.deepEqual(
      withImages.get(entry.id)?.blockers,
      [],
      `${entry.id}: the alias present removes the blocker`,
    );
  }
});

test("admin: the validator's catalogue view is the catalogue's own ids", () => {
  const catalog = loadCatalog();
  const facts = catalogFacts(catalog);
  assert.deepEqual(
    [...facts.entries].sort(),
    [...catalog.load().keys()].sort(),
    "the ids a scenario may name are the entries the catalogue holds",
  );
});

/* -------------------------------------------------------------------------- */
/*  Tickets                                                                   */
/* -------------------------------------------------------------------------- */

test("admin: every shipped scenario that declares a form is listed", () => {
  const repository = loadScenarios();
  const withTicket = scenariosWithTicket(repository);
  const declared = repository.list().filter((scenario) => scenario.ticketForm !== null);

  assert.deepEqual(
    withTicket.map((scenario) => scenario.id),
    [...declared.map((scenario) => scenario.id)].sort(),
    "the list is exactly the scenarios that declare a form, and it is sorted for a stable page",
  );
  assert.equal(
    withTicket.length,
    repository.list().length,
    "every scenario the range ships asks for a write-up (lab-port.md stage 3a)",
  );
});

/* -------------------------------------------------------------------------- */
/*  The schedule                                                              */
/* -------------------------------------------------------------------------- */

test("admin: the schedule view computes the plan at an instant rather than guessing it", () => {
  const schedule = new LabSchedule({
    enabled: true,
    windows: [
      new LabWindow({
        label: "morning",
        days: ["mon"],
        start: "09:00",
        end: "12:00",
        prewarmMinutes: 30,
        target: 2,
        scenarios: ["net-dns-failure"],
      }),
    ],
  });

  // 2026-09-14 is a Monday. 08:45 is inside the 30-minute lead-in, so the window is
  // prewarming and the empty pool is a deficit of two.
  const prewarming = scheduleView(schedule, new Date(2026, 8, 14, 8, 45));
  assert.equal(prewarming.windows.length, 1);
  assert.match(prewarming.phase, /prewarming for morning/);
  assert.deepEqual(
    prewarming.planned.map((action) => [action.kind, action.scenario_id, action.count]),
    [["prewarm", "net-dns-failure", 2]],
    "the deficit is the plan, without executing anything",
  );

  const open = scheduleView(schedule, new Date(2026, 8, 14, 10, 0));
  assert.match(open.phase, /open: morning/);

  const idle = scheduleView(schedule, new Date(2026, 8, 19, 10, 0)); // the Saturday after
  assert.equal(idle.phase, "idle");
  assert.deepEqual(idle.planned, [], "no window is open, so there is nothing to do");

  const off = scheduleView(new LabSchedule({ enabled: false, windows: schedule.windows }), new Date(2026, 8, 14, 10, 0));
  assert.equal(off.enabled, false);
  assert.deepEqual(off.planned, [], "a schedule that is switched off plans nothing, whatever the clock says");
});

test("admin: every window's fields are carried to the page", () => {
  const schedule = new LabSchedule({
    enabled: true,
    windows: [
      new LabWindow({
        label: "evening",
        days: ["tue", "thu"],
        start: "18:00",
        end: "21:30",
        prewarmMinutes: 15,
        target: 4,
        scenarios: ["a-b", "c-d"],
      }),
    ],
  });
  const view = scheduleView(schedule, new Date(2026, 8, 15, 12, 0));
  assert.deepEqual(view.windows[0], {
    label: "evening",
    days: ["tue", "thu"],
    start: "18:00",
    end: "21:30",
    prewarmMinutes: 15,
    target: 4,
    scenarios: ["a-b", "c-d"],
  });
});

/* -------------------------------------------------------------------------- */
/*  Small rules                                                               */
/* -------------------------------------------------------------------------- */

test("admin: a scenario key is the spelling the config and the pool names use", () => {
  assert.equal(scenarioKey("net-dns-failure"), "net-dns-failure");
  assert.equal(scenarioKey("net-dns-failure", "ubuntu-24.04"), "net-dns-failure@ubuntu-24.04");
});

test("admin: the audit filter offers 'everything' first, then the log's own kinds", () => {
  assert.deepEqual(auditKindOptions([]), [{ value: "", label: "Every kind" }]);
  assert.deepEqual(auditKindOptions(["checked", "ready"]), [
    { value: "", label: "Every kind" },
    { value: "checked", label: "checked" },
    { value: "ready", label: "ready" },
  ]);
});

test("admin: the accounts story and the session story are readable from the shipped data", () => {
  // A small end-to-end over the read models the pages call, so this file fails if a page's
  // inputs stop lining up: the tree loads, the lessons group by platform, and no lesson is
  // missing from the index the browser page draws.
  const lessons = loadLessons();
  const grouped = [...lessons.byPlatform().values()].flat();
  assert.equal(grouped.length, lessons.list().length, "every lesson is in exactly one platform group");
  assert.deepEqual(lessons.validate(), [], "the shipped lesson library validates");

  const repository = loadScenarios();
  assert.deepEqual(
    repository.validate(null, {
      files: scenarioFiles(repository.list()),
      catalog: catalogFacts(loadCatalog()),
      lessons,
    }),
    [],
    "the shipped scenarios validate against the shipped catalogue, lessons and scripts",
  );
  assert.ok(newLabSession({ student: "ada", scenarioId: "net-dns-failure" }).id === null, "a session starts with no id");
});
