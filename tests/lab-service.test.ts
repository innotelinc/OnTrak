/**
 * The lab's runtime seam, opened the way a page opens it.
 *
 * Everything under this file is either pure or takes its seams by injection, so this is
 * the first place where the ported control plane has to build *itself* out of an
 * environment: settings, the scenario tree, the store, the manager. The checks here are
 * therefore about the two things a page depends on and no unit test below can prove —
 * that a deployment with nothing configured is refused with a sentence naming what to
 * fix, and that a deployment which is configured gets a manager that runs a whole student
 * flow with no hypervisor in the room.
 *
 * The demo environment is used for the second half because it is the port's own answer to
 * "no `/dev/kvm` here" (§4): if the seam cannot drive a class through it, the pages will
 * not be able to either.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { synthesiseTicket } from "../src/lib/lab/demo";
import { forgetLabRuntime, labRuntime, openLabRuntime } from "../src/lib/lab/service";
import { InMemoryLabStore } from "../src/lib/lab/store";

const DEMO = { ONTRAK_DEMO__ENABLED: "true" };
/** The three secrets `requireSecrets` asks a real host for, and a usable key. */
const HOST = {
  ONTRAK_GUEST__PASSWORD: "TrainMe-1",
  ONTRAK_PORTAL__SECRET: "portal-secret",
  // Guacamole's key is 16 bytes: 32 hex characters, checked by the same rule the
  // gateway applies to it.
  ONTRAK_GUAC__SECRET_KEY: "a".repeat(32),
};

test("service: demo mode opens with no secrets, no database and no hypervisor", async () => {
  const read = await openLabRuntime({ env: DEMO });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  const runtime = read.runtime;

  assert.equal(runtime.mode, "demo");
  assert.equal(runtime.hypervisor, true, "the in-memory hypervisor is still a hypervisor");
  assert.equal(runtime.settings.demo.enabled, true);

  // The shipped tree, read from disk: the 14 real lab scenarios, the catalogue and the
  // lesson library. A runtime that opened with an empty catalogue would still "work" and
  // would serve a dashboard with nothing on it.
  assert.equal(runtime.repository.list().length, 14);
  assert.ok(runtime.catalog.load().size > 0, "the catalogue is read");
  assert.ok(runtime.lessons.list().length > 0, "the lesson library is read");

  // Templates built up front: the demo's whole job is to show the flow, and a scenario
  // with no template is refused before a session exists.
  assert.deepEqual(await runtime.manager.unavailableScenarios(), {});
});

test("service: a host with no password is refused by name, not by a throw", async () => {
  const read = await openLabRuntime({ env: {} });
  assert.equal(read.ok, false);
  if (read.ok) return;
  // The message is `requireSecrets`', which names the variable an operator has to set.
  assert.match(read.reason, /ONTRAK_GUEST__PASSWORD/);
  assert.match(read.reason, /ONTRAK_PORTAL__SECRET/);
  assert.match(read.reason, /ONTRAK_GUAC__SECRET_KEY/);
});

test("service: a host with no incus opens and says it has no hypervisor", async () => {
  const read = await openLabRuntime({
    env: HOST,
    store: new InMemoryLabStore(),
    // `null` rather than a probe: this asserts the *shape* a host without a hypervisor
    // gets, which is what a deployment on a machine that has not run `incus admin init`
    // really has.
    incus: null,
  });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.runtime.mode, "host");
  assert.equal(read.runtime.hypervisor, false);
  assert.equal(read.runtime.manager.hasHypervisor(), false);
});

test("service: the whole student flow runs through the seam, with no host", async () => {
  const read = await openLabRuntime({ env: DEMO });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  const { manager, store } = read.runtime;

  const scenarioId = read.runtime.repository.list()[0].id;
  const created = await manager.createSession("Ada", scenarioId);
  assert.equal(created.state, "requested");

  const ready = await manager.provision(created);
  assert.equal(ready.state, "ready");
  assert.notEqual(ready.hostIp, "", "a real address, from the in-memory hypervisor");

  // What the session page does on load: claim the machine (which is also the heartbeat).
  const claimed = await manager.claimForUse(ready);
  assert.equal(claimed.state, "in_use");

  // "Check my work" previews, and nothing about it is stored: the lab is results-only.
  const preview = await manager.runChecks(claimed, false);
  assert.equal(preview.error, "");
  assert.ok(preview.outcomes.length > 0, "the check script reported on its objectives");
  assert.equal((await store.listSessions({ student: "ada" }))[0]?.checksRun, 1);
  assert.equal(await store.latestReport(claimed.id ?? 0), null, "a preview is not a result");

  // "Complete & End": the machine half and the write-up, blended and stored once.
  const form = manager.ticketFormFor(claimed);
  assert.ok(form, "every shipped scenario declares a ticket form");
  const report = await manager.complete(claimed, synthesiseTicket(form));
  assert.equal(report.error, "");
  assert.ok(report.machineScore > 0, "the simulated guest graded the machine");
  assert.notEqual(report.ticketScore, null, "the write-up was marked");
  assert.equal(report.ticketWeight, form.weight);
  assert.equal(await store.attemptCounts(claimed.id ?? 0), 1, "one submission, one row");
  assert.ok(await store.latestReport(claimed.id ?? 0));
  assert.ok(await store.latestTicket(claimed.id ?? 0));
});

test("service: the process opens one runtime, and can be told to forget it", async () => {
  // `labRuntime()` caches the *promise*, so two requests arriving together cannot both
  // read the JSON and probe for `incus`. Proved through the real entry point, which is the
  // only one that caches at all.
  const saved = { ...process.env };
  process.env.ONTRAK_DEMO__ENABLED = "true";
  try {
    forgetLabRuntime();
    const first = await labRuntime();
    const second = await labRuntime();
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.runtime, second.runtime, "one lab per process");

    forgetLabRuntime();
    const third = await labRuntime();
    assert.equal(third.ok, true);
    if (!third.ok) return;
    assert.notEqual(third.runtime, first.runtime, "forgetting it opens a fresh one");
  } finally {
    process.env = saved;
    forgetLabRuntime();
  }
});
