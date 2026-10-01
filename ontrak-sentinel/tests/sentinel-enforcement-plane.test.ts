/**
 * OnTrak Sentinel S4 tests: the enforcement **plane** — the seam that turns an
 * `ACTIVE` record into something that can actually drop a packet.
 *
 * Everything up to here is deliberately testable without a network, and this file is the
 * part that is not: what it asserts is the *conversation* between the service and a plane,
 * because the ways that goes wrong are the ways a prevention system goes wrong in
 * production:
 *
 *  - **Nothing is told before it is true.** A proposal that waits on a second approver does
 *    not reach a plane; the *approval* does. A plane that could enforce a `PENDING` record
 *    would be a rail somebody can ride around by leaving the proposal sitting there.
 *  - **A lift is told too.** The hand lift and the expiry sweep both tell the plane, from
 *    the record's *stored* plan — so what a firewall released is what it blocked, not a
 *    recomputation a policy change could have moved.
 *  - **A plane cannot undo an approval.** An unreachable firewall, a refusing plane and a
 *    plane whose implementation throws all leave the action `ACTIVE` with an
 *    `enforcement.plane.failed` row. The block is what was decided and approved; a plane
 *    that did not answer is a fact about the plane.
 *  - **No plane is a real configuration.** The shipped default is unchanged, and the seam
 *    does not claim a packet was filtered when none was.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AuditLog, type AuditEvent } from "../src/lib/audit-chain";
import { sha256Hex } from "../src/lib/hash";
import {
  HttpEnforcementPlane,
  RecordingEnforcementPlane,
  planeFromEnv,
  type EnforcementPlane,
  type PlaneOutcome,
} from "../src/lib/enforcement-plane";
import {
  EnforcementService,
  MemoryEnforcementStore,
  type EnforcementActionRecord,
  type EnforcementIds,
} from "../src/lib/enforcement-service";
import {
  DEFAULT_ENFORCEMENT_POLICY,
  type EnforcementPolicy,
  type EnforcementProposal,
  type RollbackPlan,
} from "../src/lib/enforcement-rules";

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const ORG = "org_1";

function makeIds(start: string): EnforcementIds & { advance(ms: number): void } {
  let at = Date.parse(start);
  let n = 0;
  return {
    id: () => `id_${++n}`,
    now: () => new Date(at).toISOString(),
    advance(ms: number) {
      at += ms;
    },
  };
}

/** A plane that answers however the test says, and counts what it was told. */
class ScriptedPlane implements EnforcementPlane {
  readonly name = "scripted";
  readonly calls: { op: "apply" | "lift"; record: EnforcementActionRecord; plan?: RollbackPlan }[] = [];
  private outcome: PlaneOutcome;
  private throws = false;

  constructor(outcome: PlaneOutcome = { ok: true, detail: "accepted" }) {
    this.outcome = outcome;
  }

  /** Answer every call with this, or throw from every call. */
  script(outcome: PlaneOutcome, throws = false): void {
    this.outcome = outcome;
    this.throws = throws;
  }

  async apply(record: EnforcementActionRecord): Promise<PlaneOutcome> {
    this.calls.push({ op: "apply", record });
    if (this.throws) throw new Error("the adapter is broken");
    return this.outcome;
  }

  async lift(record: EnforcementActionRecord, plan: RollbackPlan): Promise<PlaneOutcome> {
    this.calls.push({ op: "lift", record, plan });
    if (this.throws) throw new Error("the adapter is broken");
    return this.outcome;
  }
}

interface Harness {
  service: EnforcementService;
  store: MemoryEnforcementStore;
  log: AuditLog;
  ids: ReturnType<typeof makeIds>;
}

function harness(
  plane: EnforcementPlane | null,
  policy?: Partial<EnforcementPolicy>,
  start = "2026-10-01T12:00:00.000Z",
): Harness {
  const store = new MemoryEnforcementStore();
  const log = new AuditLog(sha256Hex);
  const ids = makeIds(start);
  const service = new EnforcementService(store, log, ids, plane);

  if (policy !== undefined) {
    void service.setPolicy(ORG, { ...DEFAULT_ENFORCEMENT_POLICY, ...policy }, {
      identityId: "id_seed",
      label: "seed",
    });
  }

  return { service, store, ids, log };
}

function proposal(overrides: Partial<EnforcementProposal> = {}): EnforcementProposal {
  return {
    action: "BLOCK",
    targets: [{ kind: "ADDRESS", value: "203.0.113.9", label: "the C2 host" }],
    alertId: "alert_1",
    reason: "Beaconing to a known C2 address every 30 seconds.",
    requestedBy: { identityId: "id_admin", label: "Ana", role: "ADMIN" },
    ...overrides,
  };
}

const audited = (h: Harness, action: string): AuditEvent[] =>
  (h.log.all() as AuditEvent[]).filter((event) => event.action === action);

/** A policy that applies without a second approver, so the plane is reached immediately. */
const immediate = { requireSecondApprover: false, allowPermanent: true };

/* -------------------------------------------------------------------------- */
/*  The default: no plane                                                     */
/* -------------------------------------------------------------------------- */

test("with no plane, the service is exactly what it was before the seam existed", async () => {
  const h = harness(null, immediate);
  const applied = await h.service.apply({ organizationId: ORG, proposal: proposal() });
  assert.equal(applied.ok, true);
  if (!applied.ok) return;

  // The action is in force and nothing claims it reached anywhere.
  assert.equal(applied.value.action.state, "ACTIVE");
  assert.equal(applied.value.plane, null);
  assert.equal(audited(h, "enforcement.plane.apply").length, 0);
  assert.equal(audited(h, "enforcement.plane.failed").length, 0);

  const lifted = await h.service.lift({
    organizationId: ORG,
    actionId: applied.value.action.id,
    by: { identityId: "id_admin2", label: "Bea" },
    reason: "the host was cleaned",
  });
  assert.equal(lifted.ok, true);
  assert.equal(audited(h, "enforcement.plane.lift").length, 0);
});

/* -------------------------------------------------------------------------- */
/*  Told on the way in                                                        */
/* -------------------------------------------------------------------------- */

test("a plane is told when an action becomes ACTIVE, and not while it waits", async () => {
  const plane = new RecordingEnforcementPlane("test-plane");
  // Two approvers required, so the first call records a proposal.
  const h = harness(plane, { requireSecondApprover: true, allowPermanent: true });

  const proposed = await h.service.apply({ organizationId: ORG, proposal: proposal() });
  assert.equal(proposed.ok, true);
  if (!proposed.ok) return;
  assert.equal(proposed.value.gate, "APPROVAL_REQUIRED");
  assert.equal(proposed.value.action.state, "PENDING");
  assert.equal(proposed.value.plane, null, "a waiting proposal is not enforced");
  assert.equal(plane.applied.length, 0, "a PENDING record must never reach a plane");
  assert.equal(audited(h, "enforcement.plane.apply").length, 0);

  const approved = await h.service.approve({
    organizationId: ORG,
    actionId: proposed.value.action.id,
    approver: { identityId: "id_admin2", label: "Bea", role: "ADMIN" },
  });
  assert.equal(approved.ok, true);
  if (!approved.ok) return;

  assert.equal(approved.value.action.state, "ACTIVE");
  assert.deepEqual(approved.value.plane, { ok: true, detail: "recorded BLOCK on 1 target(s)" });
  assert.equal(plane.applied.length, 1);
  // The record the plane was handed is the one that is in force — the action, its targets
  // and the alert behind it — so a firewall's own log can be joined back to the decision.
  assert.equal(plane.applied[0]?.id, approved.value.action.id);
  assert.equal(plane.applied[0]?.alertId, "alert_1");
  assert.deepEqual(plane.applied[0]?.targets, proposal().targets);
  // ...and the chain names the plane, so "which plane was told, and did it answer" is
  // answerable from the evidence log rather than from application logs.
  const row = audited(h, "enforcement.plane.apply")[0];
  assert.equal(row?.targetId, approved.value.action.id);
  assert.deepEqual((row?.detail as Record<string, unknown>).plane, "test-plane");
  assert.equal((row?.detail as Record<string, unknown>).op, "apply");
});

test("an immediate action is told straight away, and the record it is handed is the stored one", async () => {
  const plane = new RecordingEnforcementPlane();
  const h = harness(plane, immediate);
  const applied = await h.service.apply({ organizationId: ORG, proposal: proposal() });
  assert.equal(applied.ok, true);
  if (!applied.ok) return;

  assert.equal(applied.value.action.state, "ACTIVE");
  assert.equal(applied.value.plane?.ok, true);
  assert.equal(plane.applied.length, 1);
  assert.equal(plane.applied[0]?.appliedAt, applied.value.action.appliedAt);
  assert.deepEqual(audited(h, "enforcement.plane.apply")[0]?.detail, {
    organizationId: ORG,
    op: "apply",
    plane: "recording",
    action: "BLOCK",
    targets: proposal().targets,
    detail: "recorded BLOCK on 1 target(s)",
  });
});

/* -------------------------------------------------------------------------- */
/*  Told on the way out                                                       */
/* -------------------------------------------------------------------------- */

test("a hand lift and the expiry sweep both tell the plane, from the stored plan", async () => {
  const plane = new RecordingEnforcementPlane();
  const h = harness(plane, { ...immediate, defaultTtlSeconds: 3600, maxTargets: 2 });

  const applied = await h.service.apply({ organizationId: ORG, proposal: proposal() });
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.equal(plane.applied.length, 1);

  const lifted = await h.service.lift({
    organizationId: ORG,
    actionId: applied.value.action.id,
    by: { identityId: "id_admin2", label: "Bea" },
    reason: "the host was cleaned",
  });
  assert.equal(lifted.ok, true);
  assert.equal(plane.lifted.length, 1);
  // Released from the plan the decision produced, not a recomputation: `LIFT`, the same
  // action and exactly the targets that were blocked.
  assert.equal(plane.lifted[0]?.plan.kind, "LIFT");
  assert.equal(plane.lifted[0]?.plan.action, "BLOCK");
  assert.deepEqual(plane.lifted[0]?.plan.targets, proposal().targets);
  assert.equal(audited(h, "enforcement.plane.lift").length, 1);

  // The sweep tells the plane too — a TTL that only existed on paper would leave the block
  // standing at the firewall while the register said it was over.
  const second = await h.service.apply({ organizationId: ORG, proposal: proposal() });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  h.ids.advance(3600 * 1000 + 1);
  const swept = await h.service.sweepExpired();
  assert.deepEqual(swept.lifted, [second.value.action.id]);
  assert.equal(plane.lifted.length, 2);
  // Idempotent: sweeping again releases nothing and tells the plane nothing.
  await h.service.sweepExpired();
  assert.equal(plane.lifted.length, 2);
});

/* -------------------------------------------------------------------------- */
/*  A plane that does not answer                                              */
/* -------------------------------------------------------------------------- */

test("a plane that refuses, or is unreachable, leaves the approval standing", async (t) => {
  for (const [label, outcome, throws] of [
    ["refuses", { ok: false, error: "target is on the plane's own protected list" } as PlaneOutcome, false],
    ["cannot be reached", { ok: false, error: "plane unreachable: connect ECONNREFUSED" } as PlaneOutcome, false],
    ["throws", { ok: true, detail: "never returned" } as PlaneOutcome, true],
  ] as const) {
    await t.test(label, async () => {
      const plane = new ScriptedPlane();
      plane.script(outcome, throws);
      const h = harness(plane, immediate);

      const applied = await h.service.apply({ organizationId: ORG, proposal: proposal() });
      assert.equal(applied.ok, true, "the plane must not be able to refuse the action");
      if (!applied.ok) return;

      // The action is in force — that is what was decided and approved — and the plane's
      // failure is recorded rather than allowed to undo it.
      assert.equal(applied.value.action.state, "ACTIVE");
      assert.equal(applied.value.plane?.ok, false);
      const stored = await h.store.findAction(ORG, applied.value.action.id);
      assert.equal(stored?.state, "ACTIVE");

      const failures = audited(h, "enforcement.plane.failed");
      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.targetId, applied.value.action.id);
      const detail = failures[0]?.detail as Record<string, unknown>;
      assert.equal(detail.op, "apply");
      assert.equal(detail.plane, "scripted");
      assert.ok(typeof detail.error === "string" && detail.error !== "");
      // The person is still accountable for it: the row names the administrator whose
      // approval put the block there.
      assert.ok((failures[0]?.actor ?? "") !== "");
    });
  }
});

/* -------------------------------------------------------------------------- */
/*  The HTTP adapter and the environment                                      */
/* -------------------------------------------------------------------------- */

test("the HTTP plane posts one call per operation, and answers rather than throws", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true, applied: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const plane = new HttpEnforcementPlane({
    url: "https://firewall.innotel.us/sentinel/enforce",
    token: "plane-token",
    fetchImpl,
  });
  assert.equal(plane.name, "http:firewall.innotel.us");

  const record = { id: "act_1", organizationId: ORG, action: "BLOCK", targets: [] } as unknown as EnforcementActionRecord;
  const applied = await plane.apply(record);
  assert.deepEqual(applied, { ok: true, detail: "plane answered 200" });
  const body = JSON.parse(String(calls[0]?.init.body)) as { op: string; action: { id: string } };
  assert.equal(body.op, "apply");
  assert.equal(body.action.id, "act_1");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer plane-token");
  assert.equal(calls[0]?.init.method, "POST");

  // Lifting carries the plan, so the plane releases what it blocked.
  const plan: RollbackPlan = { kind: "LIFT", action: "BLOCK", targets: [], at: null, label: "lift" };
  await plane.lift(record, plan);
  const liftBody = JSON.parse(String(calls[1]?.init.body)) as { op: string; plan: RollbackPlan };
  assert.equal(liftBody.op, "lift");
  assert.equal(liftBody.plan.kind, "LIFT");

  // A refusal is the plane's own words, kept: a 4xx body is usually the only thing that
  // says *why* a target was rejected.
  const refusing = new HttpEnforcementPlane({
    url: "https://firewall.innotel.us/sentinel/enforce",
    fetchImpl: async () =>
      new Response(JSON.stringify({ ok: false, error: "unknown target kind" }), { status: 200 }),
  });
  assert.deepEqual(await refusing.apply(record), { ok: false, error: "unknown target kind" });

  // A dead endpoint is an outcome, not an exception: DNS, TLS and a refused connection are
  // one fact to an operator, and none of them may take the approval down with it.
  const dead = new HttpEnforcementPlane({
    url: "https://nowhere.invalid/enforce",
    timeoutMs: 100,
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND nowhere.invalid");
    },
  });
  const outcome = await dead.apply(record);
  assert.equal(outcome.ok, false);
  assert.match(String((outcome as { error: string }).error), /plane unreachable/);
});

test("a deployment with no plane URL has no plane, and says so rather than guessing", () => {
  assert.equal(planeFromEnv({}), null);
  assert.equal(planeFromEnv({ SENTINEL_ENFORCEMENT_PLANE_URL: "   " }), null);

  const plane = planeFromEnv({ SENTINEL_ENFORCEMENT_PLANE_URL: "http://127.0.0.1:9999/enforce" });
  assert.ok(plane instanceof HttpEnforcementPlane);
  assert.equal(plane?.name, "http:127.0.0.1:9999");
});
