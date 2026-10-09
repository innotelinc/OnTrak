/**
 * The in-memory hypervisor stands in for a real one in demo mode and in every test the
 * session manager will need. So its behaviour has to match the real client's in the ways
 * the manager relies on — otherwise a demo would pass while the real path fails, which
 * is the one failure this double exists to prevent.
 *
 * Ported from `OnTrak-dev/tests/test_memory.py`, plus one rule the Python suite got for
 * free and this port cannot: the last test walks the *real* client's method list and
 * fails if this fake stops covering it. The ported client was rewritten (it is async,
 * and its low-level `run` is public where Python's `_run` was private), so the two
 * classes can drift, and a drift here is invisible until a class is running.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-memory.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { IncusClient, IncusError, IncusNotFound, instanceRunning } from "../src/lib/lab/incus";
import { InMemoryIncus } from "../src/lib/lab/memory";

const IMAGE = "ontrak-win-base";

test("memory: there is an image to build from", async () => {
  const client = new InMemoryIncus(IMAGE);
  assert.equal(await client.available(), true);
  assert.equal(await client.imageExists(IMAGE), true);
  assert.equal((await client.imageAliases()).includes(IMAGE), true);
});

test("memory: creating an instance requires its image", async () => {
  const client = new InMemoryIncus(IMAGE);
  await assert.rejects(
    () => client.createInstance("tpl-x", "missing-base"),
    // The error type is asserted, not just the text: these classes are imported from
    // the real client, so this is also the test that `instanceof` holds across modules.
    (error: unknown) =>
      error instanceof IncusNotFound && /image missing-base not found/.test(error.message),
  );
});

test("memory: the lifecycle matches the real client", async () => {
  const client = new InMemoryIncus(IMAGE);
  await client.createInstance("tpl-net-dns-failure", IMAGE, ["default"]);
  assert.equal(await client.instanceStatus("tpl-net-dns-failure"), "STOPPED");
  // A stopped machine has no address, which is what the manager waits on.
  assert.equal(await client.instanceIp("tpl-net-dns-failure"), null);

  await client.startInstance("tpl-net-dns-failure");
  assert.equal(await client.instanceStatus("tpl-net-dns-failure"), "RUNNING");
  assert.equal(Boolean(await client.instanceIp("tpl-net-dns-failure")), true);

  await client.createSnapshot("tpl-net-dns-failure", "clean");
  assert.equal(await client.hasSnapshot("tpl-net-dns-failure", "clean"), true);
  assert.deepEqual(await client.snapshotNames("tpl-net-dns-failure"), ["clean"]);

  await client.copyInstance("tpl-net-dns-failure/clean", "ontrak-pool-net-dns-failure-1");
  assert.equal(await client.exists("ontrak-pool-net-dns-failure-1"), true);
  // A clone of a snapshot is a machine with no snapshots of its own: that is what makes
  // the pool's "is this a fresh machine" question answerable.
  assert.deepEqual(await client.snapshotNames("ontrak-pool-net-dns-failure-1"), []);

  await client.stopInstance("ontrak-pool-net-dns-failure-1");
  await client.deleteInstance("ontrak-pool-net-dns-failure-1", { force: true });
  assert.equal(await client.exists("ontrak-pool-net-dns-failure-1"), false);
});

test("memory: copying a missing snapshot fails like the daemon", async () => {
  const client = new InMemoryIncus(IMAGE);
  client.addInstance("tpl-x", { running: false });
  await assert.rejects(
    () => client.copyInstance("tpl-x/clean", "child"),
    (error: unknown) =>
      error instanceof IncusNotFound && /snapshot clean not found/.test(error.message),
  );
});

test("memory: copying a missing instance fails like the daemon", async () => {
  const client = new InMemoryIncus(IMAGE);
  await assert.rejects(
    () => client.copyInstance("tpl-nope/clean", "child"),
    (error: unknown) =>
      error instanceof IncusNotFound && /instance tpl-nope not found/.test(error.message),
  );
});

test("memory: the calls ledger records what was asked", async () => {
  const client = new InMemoryIncus(IMAGE);
  await client.createInstance("a", IMAGE, ["default", "ontrak-student"]);
  await client.addDevice("a", "disk", "root", { bus: "ide", size: "8GiB" });
  await client.setConfig("a", "limits.memory", "512MiB");

  assert.deepEqual(client.calls[0], ["create_instance", "a", IMAGE, ["default", "ontrak-student"]]);
  assert.deepEqual(client.devices[0], ["a", "disk", "root", { bus: "ide", size: "8GiB" }]);
  assert.deepEqual(client.configs[0], ["a", "limits.memory", "512MiB"]);
});

test("memory: there is no guest agent to exec into", async () => {
  const client = new InMemoryIncus(IMAGE);
  await assert.rejects(
    () => client.execIn("a", ["cmd", "/c", "echo hi"]),
    (error: unknown) => error instanceof IncusError && /no guest agent/.test(error.message),
  );
});

test("memory: the readiness probe is answered and nothing else is", async () => {
  const client = new InMemoryIncus(IMAGE);
  client.addInstance("a", { running: true });

  // The one thing the lifecycle genuinely needs from a machine with no guest.
  const ready = await client.guestShell("a", "echo ontrak-ready; exit 0");
  assert.equal(ready.code, 0);
  assert.match(ready.stdout, /ontrak-ready/);

  // Anything else is empty on purpose: a script run through a fake hypervisor graded
  // nothing, so a grading call must see "no grading payload" rather than a pass.
  const other = await client.guestShell("a", "Get-Date");
  assert.equal(other.stdout, "");
  assert.equal(other.code, 0);
  // The ledger keeps only the head of the script, as the Python double did.
  assert.deepEqual(client.calls.at(-1), ["guest_shell", "a", "Get-Date"]);
});

test("memory: guestShell on a machine that is not there raises", async () => {
  const client = new InMemoryIncus(IMAGE);
  await assert.rejects(
    () => client.guestShell("nope", "echo ontrak-ready"),
    (error: unknown) => error instanceof IncusNotFound,
  );
});

test("memory: starting a machine that is not there raises", async () => {
  const client = new InMemoryIncus(IMAGE);
  await assert.rejects(
    () => client.startInstance("nope"),
    (error: unknown) => error instanceof IncusNotFound && /not found/.test(error.message),
  );
});

test("memory: instances report running and stopped", async () => {
  const client = new InMemoryIncus(IMAGE);
  client.addInstance("up", { running: true });
  client.addInstance("down", { running: false });

  const statuses: Record<string, string> = {};
  for (const info of await client.listInstances()) statuses[info.name] = info.status;
  assert.deepEqual(statuses, { up: "RUNNING", down: "STOPPED" });

  const up = await client.getInstance("up");
  assert.equal(up !== null && instanceRunning(up), true);
  assert.equal(await client.getInstance("nope"), null);
  assert.deepEqual(client.liveNames(), new Set(["up", "down"]));
});

test("memory: deleting an instance takes its snapshots with it", async () => {
  const client = new InMemoryIncus(IMAGE);
  await client.createInstance("tpl-x", IMAGE);
  await client.createSnapshot("tpl-x", "clean");
  await client.deleteInstance("tpl-x");
  assert.equal(await client.hasSnapshot("tpl-x", "clean"), false);
  assert.deepEqual(await client.snapshotNames("tpl-x"), []);
});

test("memory: renaming moves the machine and its snapshots together", async () => {
  const client = new InMemoryIncus(IMAGE);
  await client.createInstance("tpl-x", IMAGE);
  await client.createSnapshot("tpl-x", "clean");
  await client.renameInstance("tpl-x", "tpl-y");
  assert.equal(await client.exists("tpl-x"), false);
  assert.deepEqual(await client.snapshotNames("tpl-y"), ["clean"]);
});

test("memory: network and server info are plausible placeholders", async () => {
  const client = new InMemoryIncus(IMAGE);
  const server = await client.serverInfo();
  assert.equal(Boolean((server.environment as Record<string, unknown> | undefined)?.server_version), true);
  assert.deepEqual(await client.networkNames(), ["ontrak0"]);
  const networks = await client.runJson<{ name: string }[]>(["network", "list", "--format=json"]);
  assert.equal(networks?.[0]?.name, "ontrak0");
});

test("memory: adding an image switches the golden alias", () => {
  const client = new InMemoryIncus("old-base");
  client.addImage("new-base");
  assert.equal(client.imageAlias, "new-base");
});

test("memory: an added-but-absent image does not become the golden alias", async () => {
  const client = new InMemoryIncus("old-base");
  client.addImage("half-built", false);
  assert.equal(await client.imageExists("half-built"), false);
  assert.equal(client.imageAlias, "old-base");
  // It is still a known alias, which is what the platform page lists.
  assert.equal((await client.imageAliases()).includes("half-built"), true);
});

/* -------------------------------------------------------------------------- */
/*  The contract with the real client                                         */
/* -------------------------------------------------------------------------- */

/**
 * The private helpers of the ported client.
 *
 * TypeScript's `private` is a compile-time marker, so these appear on the prototype
 * alongside the public methods and cannot be told apart at runtime. They are named
 * here instead of being pattern-matched away, so that adding a *public* method still
 * fails this test loudly.
 */
const CLIENT_PRIVATE_HELPERS = new Set(["base", "uidArgument"]);

function prototypeMethodNames(ctor: { prototype: object }): string[] {
  return Object.getOwnPropertyNames(ctor.prototype).filter((name) => name !== "constructor");
}

test("memory: the fake covers every method the real client exposes", () => {
  const fake = InMemoryIncus.prototype as unknown as Record<string, unknown>;
  const missing = prototypeMethodNames(IncusClient)
    .filter((name) => !CLIENT_PRIVATE_HELPERS.has(name))
    .filter((name) => typeof fake[name] !== "function");

  assert.deepEqual(
    missing,
    [],
    "the in-memory client must answer every call the real one does: a method it lacks " +
      "is a demo that passes while the real path throws. If a name here is a private " +
      "helper, add it to CLIENT_PRIVATE_HELPERS with a reason.",
  );

  // `available` is asked both ways: the ported client's is static (it answers by
  // running the binary) while the Python's was an instance method.
  assert.equal(typeof InMemoryIncus.available, "function");
  assert.equal(typeof new InMemoryIncus().available, "function");
  // And the classes are the ported ones, not lookalikes: the fake must raise the real
  // client's error types or a caller's `instanceof` checks silently stop matching.
  assert.equal(new InMemoryIncus().constructor.name, "InMemoryIncus");
});
