/**
 * OnTrak Sentinel S3 tests: the clock that prunes the indicators whose date has passed.
 *
 * The matcher refuses an expired indicator at read time, so detection is correct whatever
 * this loop does — which is exactly why the loop needs its own tests. Nothing else fails
 * when it prunes the wrong row, when it prunes the same row twice, or when it dies on the
 * first error and never runs again. Each case below is one of those:
 *
 *  - **A row pruned for the wrong reason.** Only an expiry that has actually passed is due,
 *    and an indicator with no expiry is a row only a person can withdraw — the sweep must
 *    not guess that "no date" means "stale".
 *  - **A sweep that prunes twice.** Idempotence is what makes running it late, or twice,
 *    harmless, and the chain is where a second prune would show up as a second row.
 *  - **A prune mistaken for the safety property.** The list the detector reads refuses an
 *    expired indicator even when nothing has ever pruned the row, asserted with the store
 *    proving the row is still there.
 *  - **A loop that stops on one bad night.** A failed sweep is reported and the next one
 *    still happens, and a sweep already in flight is skipped rather than stacked.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sha256Hex } from "../src/lib/hash";
import { OrganizationAuditLog, type IdentityActor } from "../src/lib/identity-service";
import type { ObservedEvent } from "../src/lib/telemetry-rules";
import {
  DEFAULT_INTEL_SWEEP_INTERVAL_MS,
  MIN_INTEL_SWEEP_INTERVAL_MS,
  intelSweepIntervalMs,
  startThreatIntelScheduler,
} from "../src/lib/threat-intel-scheduler";
import { matchEvent } from "../src/lib/threat-intel-rules";
import {
  MemoryIndicatorStore,
  ThreatIntelService,
  type ThreatIntelIds,
} from "../src/lib/threat-intel-service";

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const START_ISO = "2026-10-01T09:00:00.000Z";
const ORG = "org_1";
const OTHER_ORG = "org_2";

const ADMIN: IdentityActor = { id: "admin_1", organizationId: ORG, role: "ADMIN" };
const OTHER_ADMIN: IdentityActor = { id: "admin_2", organizationId: OTHER_ORG, role: "ADMIN" };

/** A controllable clock, so "expired" is a fact rather than a wait. */
function makeIds(start: string): ThreatIntelIds & { advance(ms: number): void } {
  let at = Date.parse(start);
  let n = 0;
  return {
    id: () => `id_${(n += 1)}`,
    now: () => new Date(at).toISOString(),
    nowMs: () => at,
    advance(ms: number) {
      at += ms;
    },
  };
}

function harness() {
  const ids = makeIds(START_ISO);
  const store = new MemoryIndicatorStore();
  const audit = new OrganizationAuditLog(sha256Hex);
  return { ids, store, audit, service: new ThreatIntelService(store, audit, ids) };
}

/** A feed row, with only the parts a case cares about. */
function row(value: string, expiresAt?: number) {
  return {
    value,
    source: "test-feed",
    confidence: 90,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/** One observation, for the read-path case. */
function event(over: Partial<ObservedEvent> = {}): ObservedEvent {
  return {
    kind: "NETWORK",
    source: "NETFLOW",
    at: Date.parse(START_ISO),
    sensor: "fw-1",
    sourceAddress: "203.0.113.9",
    sourcePort: 51234,
    destinationAddress: "10.0.0.5",
    destinationPort: 22,
    protocol: "tcp",
    direction: null,
    attributes: {},
    ...over,
  };
}

const YESTERDAY = Date.parse("2026-09-30T00:00:00.000Z");
const IN_AN_HOUR = Date.parse("2026-10-01T10:00:00.000Z");

/* -------------------------------------------------------------------------- */
/*  What the sweep prunes, and what it must not                               */
/* -------------------------------------------------------------------------- */

test("the sweep prunes an expiry that has passed, in every organization, and nothing else", async () => {
  const h = harness();
  await h.service.ingest(ADMIN, [
    row("203.0.113.9", YESTERDAY),
    row("198.51.100.4", IN_AN_HOUR),
    row("bad.example"),
  ]);
  await h.service.ingest(OTHER_ADMIN, [row("192.0.2.7", YESTERDAY)]);

  const swept = await h.service.sweepExpired();

  // Deployment-wide, because the timer has no tenant list to hand it.
  assert.equal(swept.pruned.length, 2, "one expired row in each organization");
  assert.deepEqual(
    (await h.store.listIndicators(ORG)).map((indicator) => indicator.value).sort(),
    ["198.51.100.4", "bad.example"],
    "an expiry still to come, and no expiry at all, both stay",
  );
  assert.deepEqual(await h.store.listIndicators(OTHER_ORG), []);

  // The row that expires in an hour is untouched for a different reason than the one with
  // no expiry: its date has not arrived. Both are asserted, because a sweep that pruned by
  // "is this value old?" rather than by the date would pass the first half of this.
  h.ids.advance(2 * 60 * 60_000);
  const later = await h.service.sweepExpired();
  assert.equal(later.pruned.length, 1);
  assert.deepEqual(
    (await h.store.listIndicators(ORG)).map((indicator) => indicator.value),
    ["bad.example"],
    "the undated row is still the one only a person can withdraw",
  );
});

test("a second sweep prunes nothing, and the chain keeps one row per prune", async () => {
  const h = harness();
  await h.service.ingest(ADMIN, [row("203.0.113.9", YESTERDAY)]);

  const first = await h.service.sweepExpired();
  assert.equal(first.pruned.length, 1);

  // Idempotent: the store is asked for rows that are expired *and still present*.
  const second = await h.service.sweepExpired();
  assert.deepEqual(second.pruned, []);

  const withdrawals = (await h.audit.trail(ORG)).filter((entry) => entry.action === "guard.intel.withdrawn");
  assert.equal(withdrawals.length, 1, "a sweep that runs twice does not write a second withdrawal");
});

test("a prune is audited as an automatic withdrawal, naming the value and the feed", async () => {
  const h = harness();
  await h.service.ingest(ADMIN, [row("203.0.113.9", YESTERDAY)]);
  await h.service.sweepExpired();

  const [withdrawal] = (await h.audit.trail(ORG)).filter((entry) => entry.action === "guard.intel.withdrawn");
  assert.ok(withdrawal, "the prune is on the organization's chain");
  assert.equal(withdrawal.actor, "scheduler", "the actor is the loop, not a person");
  const detail = withdrawal.detail as Record<string, unknown>;
  // The same detail an operator's withdrawal carries — so "was this address ever watched,
  // and when did we stop?" has the same answer to give — plus how to tell the two apart.
  assert.equal(detail.value, "203.0.113.9");
  assert.equal(detail.source, "test-feed");
  assert.equal(detail.kind, "IPV4");
  assert.equal(detail.automatic, true);
  assert.equal(detail.by, "scheduler");
});

test("detection refuses an expired indicator even when no sweep has ever run", async () => {
  const h = harness();
  await h.service.ingest(ADMIN, [row("203.0.113.9", YESTERDAY)]);
  const stored = await h.store.listIndicators(ORG);

  // The row is still there — nothing pruned it — and the list the detector is handed is
  // empty anyway. That is the property this loop must not be mistaken for.
  assert.equal(stored.length, 1);
  assert.deepEqual(await h.service.activeIndicators(ORG, h.ids.nowMs()), []);
  assert.equal(matchEvent(event(), stored[0], h.ids.nowMs()), null);
  // And an indicator whose date has not arrived still matches, so the refusal is the date
  // and not a list the detector has stopped reading.
  const live = { ...stored[0], expiresAt: h.ids.nowMs() + 60_000 };
  assert.ok(matchEvent(event(), live, h.ids.nowMs()));
});

/* -------------------------------------------------------------------------- */
/*  The loop                                                                  */
/* -------------------------------------------------------------------------- */

/** A timer the test fires by hand, so nobody waits for a real interval. */
function manualTimer() {
  let callback: (() => void) | null = null;
  let cleared = false;
  return {
    setTimer: (cb: () => void) => {
      callback = cb;
      return { unref() {} };
    },
    clearTimer: () => {
      cleared = true;
    },
    fire: () => callback?.(),
    cleared: () => cleared,
  };
}

/** Let the loop's own promise chain settle after a fired tick. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the interval: unset is on at an hour, 0 is off, and a fraction is clamped", () => {
  assert.equal(intelSweepIntervalMs({}), DEFAULT_INTEL_SWEEP_INTERVAL_MS);
  assert.equal(intelSweepIntervalMs({ SENTINEL_INTEL_SWEEP_INTERVAL_MINUTES: "" }), DEFAULT_INTEL_SWEEP_INTERVAL_MS);
  assert.equal(intelSweepIntervalMs({ SENTINEL_INTEL_SWEEP_INTERVAL_MINUTES: "0" }), null);
  assert.equal(intelSweepIntervalMs({ SENTINEL_INTEL_SWEEP_INTERVAL_MINUTES: "-1" }), null);
  assert.equal(intelSweepIntervalMs({ SENTINEL_INTEL_SWEEP_INTERVAL_MINUTES: "nonsense" }), null);
  assert.equal(intelSweepIntervalMs({ SENTINEL_INTEL_SWEEP_INTERVAL_MINUTES: "30" }), 30 * 60_000);
  assert.equal(
    intelSweepIntervalMs({ SENTINEL_INTEL_SWEEP_INTERVAL_MINUTES: "0.001" }),
    MIN_INTEL_SWEEP_INTERVAL_MS,
    "a fraction is the floor rather than a busy loop",
  );
});

test("the loop prunes on its own, says what it pruned, and stop() ends it", async () => {
  const h = harness();
  await h.service.ingest(ADMIN, [row("203.0.113.9", YESTERDAY)]);

  const timer = manualTimer();
  const lines: string[] = [];
  const scheduler = startThreatIntelScheduler(h.service, {
    intervalMs: 60_000,
    log: (message) => lines.push(message),
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  assert.match(lines.join("\n"), /indicator sweep is on, every 60s/);
  timer.fire();
  await settle();

  assert.match(lines.join("\n"), /pruned 1 indicator\(s\) whose expiry had passed/);
  assert.deepEqual(await h.store.listIndicators(ORG), []);

  scheduler.stop();
  assert.equal(timer.cleared(), true, "a stopped loop clears its timer");
  // A tick that fires after the stop is ignored rather than running against a closing client.
  timer.fire();
  await settle();
  assert.equal(lines.filter((line) => line.includes("pruned")).length, 1, "the second tick never ran");
});

test("a failed sweep is reported and does not take the loop with it", async () => {
  const errors: unknown[] = [];
  const log: string[] = [];
  let calls = 0;
  const scheduler = startThreatIntelScheduler(
    {
      async sweepExpired() {
        calls += 1;
        if (calls === 1) throw new Error("the database went away");
        return { pruned: [] };
      },
    },
    { intervalMs: 1000, log: (message) => log.push(message), onError: (error) => errors.push(error) },
  );
  scheduler.stop();

  await scheduler.runOnce();
  await scheduler.runOnce();

  assert.equal(errors.length, 1);
  assert.match(String((errors[0] as Error).message), /database went away/);
  assert.equal(calls, 2, "the loop asked again after the failure");
});

test("a sweep already running is skipped rather than stacked", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const log: string[] = [];
  const scheduler = startThreatIntelScheduler(
    {
      async sweepExpired() {
        calls += 1;
        await gate;
        return { pruned: [] };
      },
    },
    { intervalMs: 1000, log: (message) => log.push(message) },
  );
  scheduler.stop();

  const first = scheduler.runOnce();
  // Started while the first is still writing: `sweepExpired` prunes row by row, so the
  // window is a whole sweep wide rather than one query.
  await scheduler.runOnce();
  assert.equal(calls, 1, "the second pass never reached the service");
  assert.match(log.join("\n"), /previous sweep is still running/);

  release();
  await first;
  assert.equal(calls, 1);
});
