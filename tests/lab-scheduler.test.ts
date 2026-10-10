/**
 * The schedule decides when host memory is spent.
 *
 * Prewarming exists for one reason and it is a scarce resource: a resident pool VM
 * costs RAM whether or not a student is in it, so the pool is filled only for the
 * class that is about to run and only up to a deficit. Every rule these tests pin is
 * downstream of that — a window's lead-in is what opens prewarming, the pool's
 * *claimable* count is what decides whether there is anything to do, a closed window
 * drains what nobody took, and an off switch does nothing at all.
 *
 * The arithmetic is pure, so these tests are time-travel rather than waiting for a
 * clock. The dates are built from local components on purpose: Python compared naive
 * local datetimes, and `new Date(2026, 8, 14, 10, 0)` names the same instant in the
 * site's own timezone that the Python suite named.
 *
 *   2026-09-14 is a Monday; 2026-09-19 is a Saturday.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-scheduler.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LabAction,
  LabSchedule,
  LabScheduler,
  LabWindow,
  parseDay,
  parseTime,
  type SchedulerManager,
  type WindowInit,
} from "../src/lib/lab/scheduler";

const MONDAY = new Date(2026, 8, 14, 8, 45);
const MONDAY_CLASS = new Date(2026, 8, 14, 10, 0);
const MONDAY_AFTER = new Date(2026, 8, 14, 12, 5);
const SATURDAY = new Date(2026, 8, 19, 10, 0);

function window(overrides: WindowInit = {}): LabWindow {
  const base: WindowInit = {
    label: "morning-class",
    days: ["mon", "wed"],
    start: "09:00",
    end: "12:00",
    prewarmMinutes: 30,
    target: 2,
    scenarios: ["net-dns-failure"],
  };
  return new LabWindow({ ...base, ...overrides });
}

test("window: the three phases, and a weekend that is none of them", () => {
  const w = window();
  assert.equal(w.inPrewarm(MONDAY), true);
  assert.equal(w.covers(MONDAY), false);
  assert.equal(w.covers(MONDAY_CLASS), true);
  assert.equal(w.inPrewarm(MONDAY_CLASS), false);
  assert.equal(w.justEnded(MONDAY_AFTER), true);
  assert.equal(w.covers(SATURDAY), false);
  assert.equal(w.inPrewarm(SATURDAY), false);
});

test("window: an end before the start, or a negative lead-in, is refused at parse time", () => {
  assert.throws(() => window({ start: "12:00" }), /end must be after start/);
  assert.throws(() => window({ prewarmMinutes: -5 }), /prewarm_minutes/);
});

test("day and time parsing: the aliases work, and rubbish is refused rather than guessed", () => {
  assert.equal(parseDay("Monday"), "mon");
  assert.equal(parseDay("THURS"), "thu");
  assert.throws(() => parseDay("funday"), /unknown day/);
  assert.equal(parseTime("09:30").hour, 9);
  assert.equal(parseTime("09:30:15").second, 15);
  assert.throws(() => parseTime("half past nine"), /HH:MM/);
});

test("prewarm: the deficit is filled, and a met target is left alone", () => {
  const schedule = new LabSchedule({ windows: [window({ target: 5 })] });
  const actions = schedule.actions(MONDAY, { pool: { "net-dns-failure": 3 } });
  assert.deepEqual(
    actions.map((action) => action.kind),
    ["prewarm"],
  );
  assert.equal(actions[0]?.count, 2);
  assert.match(actions[0]?.reason ?? "", /wants 5, pool has 3/);

  const covered = schedule.actions(MONDAY, { pool: { "net-dns-failure": 5 } });
  assert.deepEqual(covered, []);
});

test("prewarm: nothing happens before the lead-in opens", () => {
  const schedule = new LabSchedule({ windows: [window({ prewarmMinutes: 30 })] });
  assert.deepEqual(schedule.actions(new Date(2026, 8, 14, 8, 20), { pool: {} }), []);
});

test("prewarm: a window with no scenarios of its own falls back to every scenario", () => {
  const schedule = new LabSchedule({ windows: [window({ target: 1, scenarios: [] })] });
  const actions = schedule.actions(MONDAY, { pool: {}, scenarios: ["a", "b"] });
  assert.deepEqual(
    [...new Set(actions.map((action) => action.scenarioId))].sort(),
    ["a", "b"],
  );
  assert.equal(
    actions.every((action) => action.count === 1),
    true,
  );
});

test("drain: the pool is emptied when the window closes, and an empty pool is not a drain", () => {
  const schedule = new LabSchedule({ windows: [window()] });
  const actions = schedule.actions(MONDAY_AFTER, { pool: { "net-dns-failure": 4, other: 0 } });
  assert.deepEqual(
    actions.map((action) => action.kind),
    ["drain-pool"],
  );
  assert.equal(actions[0]?.count, 4);
  assert.match(actions[0]?.reason ?? "", /wastes host memory/);
});

test("recycle: only a session past the idle threshold, during an open window", () => {
  const schedule = new LabSchedule({ windows: [window()] });
  const actions = schedule.actions(MONDAY_CLASS, {
    pool: { "net-dns-failure": 2 },
    idleSessions: [
      { id: 4, scenarioId: "net-dns-failure", idleMinutes: 25 },
      { id: 5, scenarioId: "net-dns-failure", idleMinutes: 3 },
    ],
    idleMinutes: 20,
  });
  const kinds = actions.map((action) => action.kind);
  assert.equal(kinds.filter((kind) => kind === "recycle-idle").length, 1);
  const recycled = actions.find((action) => action.kind === "recycle-idle");
  assert.match(recycled?.reason ?? "", /session 4/);
});

test("a disabled, empty, or out-of-window schedule does nothing at all", () => {
  assert.deepEqual(
    new LabSchedule({ windows: [window()], enabled: false }).actions(MONDAY, { pool: {} }),
    [],
  );
  assert.deepEqual(new LabSchedule({ windows: [] }).actions(MONDAY, { pool: {} }), []);
  assert.deepEqual(new LabSchedule({ windows: [window()] }).actions(SATURDAY, { pool: {} }), []);
});

test("actionFor names the phase an operator is reading about", () => {
  const schedule = new LabSchedule({ windows: [window()] });
  assert.equal(schedule.actionFor(MONDAY), "prewarming for morning-class");
  assert.equal(schedule.actionFor(MONDAY_CLASS), "open: morning-class");
  assert.equal(schedule.actionFor(MONDAY_AFTER), "just closed: morning-class");
  assert.equal(schedule.actionFor(SATURDAY), "idle");
});

test("schedule config round-trips, and a key it does not know is ignored rather than fatal", () => {
  const data = {
    enabled: true,
    windows: [{ label: "c", days: ["mon"], start: "09:00", end: "10:00", target: 1 }],
  };
  const schedule = LabSchedule.fromConfig(data);
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.windows[0]?.label, "c");
  const windows = schedule.toDict().windows as Record<string, unknown>[];
  assert.deepEqual(windows[0]?.days, ["mon"]);

  // Configs drift between versions; an unknown key must not stop a class starting.
  assert.equal(
    LabSchedule.fromConfig({ windows: [{ label: "x", nonsense: true }] }).windows[0]?.label,
    "x",
  );
});

test("an action serialises for the CLI under the Python keys", () => {
  const action = new LabAction("prewarm", { scenarioId: "s", count: 2, reason: "because" });
  assert.deepEqual(action.toDict(), {
    kind: "prewarm",
    scenario_id: "s",
    count: 2,
    reason: "because",
  });
});

/**
 * A manager double.
 *
 * `pool` is the claimable count, which is the only number the schedule reads; a
 * prewarm adds to it and a drain empties it, which is what lets the tick test assert
 * the same thing the Python suite asserted — that a closed window leaves the pool at
 * zero.
 */
function fakeManager(initial: Record<string, number>): {
  manager: SchedulerManager;
  pool: Map<string, number>;
} {
  const pool = new Map<string, number>(Object.entries(initial));
  const manager: SchedulerManager = {
    settings: { idleRecycleMinutes: 20 },
    poolStatus: () =>
      [...pool.entries()].map(([scenarioId, ready]) => ({ scenarioId, ready, total: ready })),
    prewarm: (scenarioId, count) => {
      pool.set(scenarioId, (pool.get(scenarioId) ?? 0) + count);
      return count;
    },
    drainPool: (scenarioId) => {
      const removed = pool.get(scenarioId) ?? 0;
      pool.set(scenarioId, 0);
      return removed;
    },
    listInUseSessions: () => [],
    sessionAgeMinutes: () => 0,
    scenarioIds: () => [...pool.keys()],
  };
  return { manager, pool };
}

test("tick: a closed window actually drains the pool through the manager", () => {
  const { manager, pool } = fakeManager({ "net-dns-failure": 1 });
  const result = new LabScheduler(manager, new LabSchedule({ windows: [window({ target: 1 })] })).tick(
    MONDAY_AFTER,
  );

  assert.equal(result.phase, "just closed: morning-class");
  assert.equal(
    result.performed.some((row) => row.kind === "drain-pool"),
    true,
  );
  assert.equal(pool.get("net-dns-failure"), 0);
});

test("tick: a lead-in actually creates the deficit through the manager", () => {
  const { manager, pool } = fakeManager({});
  const result = new LabScheduler(manager, new LabSchedule({ windows: [window({ target: 3 })] })).tick(
    MONDAY,
  );

  assert.equal(result.phase, "prewarming for morning-class");
  const prewarmed = result.performed.find((row) => row.kind === "prewarm");
  assert.equal(prewarmed?.created, 3);
  assert.equal(pool.get("net-dns-failure"), 3);
});

test("tick: one failing action is reported and the rest of the plan still runs", () => {
  const { manager } = fakeManager({ "net-dns-failure": 2, other: 3 });
  const failing: SchedulerManager = {
    ...manager,
    prewarm: () => {
      throw new Error("no room on the host");
    },
    drainPool: () => 3,
  };
  const schedule = new LabSchedule({ windows: [window({ target: 5 })] });
  const result = new LabScheduler(failing, schedule).tick(MONDAY);

  const failed = result.performed.find((row) => row.kind === "prewarm");
  assert.match(String(failed?.error ?? ""), /no room on the host/);
  assert.equal(result.planned.length, result.performed.length);
});

test("tick: a tick during a closed window is recorded with the phase it happened in", () => {
  const { manager } = fakeManager({});
  const result = new LabScheduler(manager, new LabSchedule({ windows: [window()] })).tick(SATURDAY);
  assert.equal(result.phase, "idle");
  assert.deepEqual(result.planned, []);
  assert.deepEqual(result.performed, []);
  // The instant is recorded, not "now": an operator reading a tick log has to be able
  // to tell a quiet Saturday from a scheduler that never ran.
  assert.equal(typeof result.when, "string");
  assert.equal(Number.isNaN(new Date(result.when).getTime()), false);
});
