/**
 * OnTrak Sentinel S4 tests: the enforcement path, end to end, without a network.
 *
 * The rules module has its own tests; these are about what happens once an action *exists* —
 * and the cases are chosen around the ways a prevention system goes wrong after it works:
 *
 *  - **An action that is refused leaves no action.** A rail said no, so there is nothing in
 *    force and `list` is empty; the refusal is in the audit trail where a review will look.
 *  - **An approval re-runs the rails.** A policy tightened while a proposal waited has to
 *    take effect, which means the safe-list is checked again at the approval and not only at
 *    the proposal — otherwise an old proposal is a way past a new rail.
 *  - **The TTL is real.** An action lifts itself when its deadline passes, once, whoever is
 *    asleep — and running the sweep twice does not write a second lift.
 *  - **Every step is in the chain.** Proposed, applied, refused and lifted are rows: the same
 *    evidence spine the identity side uses, so "who blocked that host, and who let it go"
 *    is answerable without reading application logs.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AuditLog, type AuditEvent } from "../src/lib/audit-chain";
import { sha256Hex } from "../src/lib/hash";
import {
  EnforcementService,
  MemoryEnforcementStore,
  validatePolicy,
  type EnforcementIds,
} from "../src/lib/enforcement-service";
import {
  DEFAULT_ENFORCEMENT_POLICY,
  type EnforcementPolicy,
  type EnforcementProposal,
} from "../src/lib/enforcement-rules";

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const ORG = "org_1";

/** A controllable clock, so the TTL is a fact rather than a wait. */
function makeIds(start: string): EnforcementIds & { advance(ms: number): void; count(): number } {
  let at = Date.parse(start);
  let n = 0;
  return {
    id: () => `id_${++n}`,
    now: () => new Date(at).toISOString(),
    advance(ms: number) {
      at += ms;
    },
    count: () => n,
  };
}

interface Harness {
  service: EnforcementService;
  store: MemoryEnforcementStore;
  /** The live log, read on demand — a copy taken at construction would miss later rows. */
  log: AuditLog;
  ids: ReturnType<typeof makeIds>;
}

function harness(policy?: Partial<EnforcementPolicy>, start = "2026-10-01T12:00:00.000Z"): Harness {
  const store = new MemoryEnforcementStore();
  const log = new AuditLog(sha256Hex);
  const ids = makeIds(start);
  const service = new EnforcementService(store, log, ids);

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

/* -------------------------------------------------------------------------- */
/*  Applying                                                                  */
/* -------------------------------------------------------------------------- */

test("an action that needs a second approver waits, and one that does not is applied", async (t) => {
  await t.test("the default posture stores a proposal rather than applying it", async () => {
    const h = harness();
    const applied = await h.service.apply({ organizationId: ORG, proposal: proposal() });

    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.equal(applied.value.gate, "APPROVAL_REQUIRED");
    assert.equal(applied.value.action.state, "PENDING");
    assert.equal(applied.value.action.appliedAt, null);

    // Nothing is in force, and the proposal is in the chain where somebody will look.
    assert.deepEqual(await h.service.inForce(ORG), []);
    assert.equal(audited(h, "enforcement.proposed").length, 1);
    assert.equal(audited(h, "block.apply").length, 0);
  });

  await t.test("one administrator is enough where the policy says so", async () => {
    const h = harness({ requireSecondApprover: false });
    const applied = await h.service.apply({ organizationId: ORG, proposal: proposal() });

    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.equal(applied.value.gate, "IMMEDIATE");
    assert.equal(applied.value.action.state, "ACTIVE");
    assert.equal(applied.value.action.approvedById, "id_admin");

    // The decision's own intent is the row — actor, targets, and the policy as judged.
    const rows = audited(h, "block.apply");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.actor, "id_admin");
    assert.equal(rows[0]?.targetId, "203.0.113.9");
    assert.match(String(rows[0]?.id), /^id_/);

    // And it is in force, with an inverse computed at the decision.
    const inForce = await h.service.inForce(ORG);
    assert.equal(inForce.length, 1);
    assert.equal(inForce[0]?.rollback?.kind, "LIFT");
  });

  await t.test("a refusal stores no action and says so in the chain", async () => {
    const h = harness({ protectedTargets: ["203.0.113.0/24"], requireSecondApprover: false });
    const refused = await h.service.apply({ organizationId: ORG, proposal: proposal() });

    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.error, /safe-list/);

    assert.deepEqual(await h.service.list(ORG), []);
    const refusals = audited(h, "enforcement.refused");
    assert.equal(refusals.length, 1);
    const detail = refusals[0]?.detail as { code?: string; targets?: unknown[] };
    assert.equal(detail.code, "PROTECTED_TARGET");
    assert.equal(detail.targets?.length, 1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Approving                                                                 */
/* -------------------------------------------------------------------------- */

test("an approval re-runs the rails", async (t) => {
  await t.test("a second administrator applies the waiting action", async () => {
    const h = harness();
    const proposed = await h.service.apply({ organizationId: ORG, proposal: proposal() });
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;

    const approved = await h.service.approve({
      organizationId: ORG,
      actionId: proposed.value.action.id,
      approver: { identityId: "id_admin2", label: "Bea", role: "ADMIN" },
    });

    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    assert.equal(approved.value.action.state, "ACTIVE");
    assert.equal(approved.value.action.approvedById, "id_admin2");
    assert.equal(approved.value.action.approvedByLabel, "Bea");

    const rows = audited(h, "block.apply");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.actor, "id_admin");
    const detail = rows[0]?.detail as { approvedBy?: string; approvedByLabel?: string };
    assert.equal(detail.approvedBy, "id_admin2");
    assert.equal(detail.approvedByLabel, "Bea");
  });

  await t.test("the requester cannot approve their own action", async () => {
    const h = harness();
    const proposed = await h.service.apply({ organizationId: ORG, proposal: proposal() });
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;

    const self = await h.service.approve({
      organizationId: ORG,
      actionId: proposed.value.action.id,
      approver: { identityId: "id_admin", label: "Ana", role: "ADMIN" },
    });

    assert.equal(self.ok, false);
    if (!self.ok) assert.match(self.error, /second administrator/);
    assert.equal((await h.service.inForce(ORG)).length, 0);
  });

  await t.test("a rail tightened while it waited still refuses it", async () => {
    // The property that makes the safe-list a rail rather than a formality: an old proposal
    // must not be a way past a rule added since it was made.
    const h = harness({ requireSecondApprover: true });
    const proposed = await h.service.apply({ organizationId: ORG, proposal: proposal() });
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;

    await h.service.setPolicy(
      ORG,
      { ...DEFAULT_ENFORCEMENT_POLICY, protectedTargets: ["203.0.113.9"], requireSecondApprover: true },
      { identityId: "id_admin3", label: "Cleo" },
    );

    const approved = await h.service.approve({
      organizationId: ORG,
      actionId: proposed.value.action.id,
      approver: { identityId: "id_admin2", label: "Bea", role: "ADMIN" },
    });

    assert.equal(approved.ok, false);
    if (!approved.ok) assert.match(approved.error, /safe-list/);

    // Recorded as refused rather than left pending: somebody asked and a rail said no.
    const stored = await h.store.findAction(ORG, proposed.value.action.id);
    assert.equal(stored?.state, "REFUSED");
    assert.equal(stored?.refusedCode, "PROTECTED_TARGET");
    assert.deepEqual(await h.service.inForce(ORG), []);

    const refusals = audited(h, "enforcement.refused");
    assert.equal(refusals.length, 1);
    const detail = refusals[0]?.detail as { approvalWithheldBy?: string };
    assert.equal(detail.approvalWithheldBy, "Bea");
  });

  await t.test("an action that is not pending cannot be approved", async () => {
    const h = harness({ requireSecondApprover: false });
    const applied = await h.service.apply({ organizationId: ORG, proposal: proposal() });
    assert.equal(applied.ok, true);
    if (!applied.ok) return;

    const again = await h.service.approve({
      organizationId: ORG,
      actionId: applied.value.action.id,
      approver: { identityId: "id_admin2", label: "Bea", role: "ADMIN" },
    });
    assert.equal(again.ok, false);
    if (!again.ok) assert.match(again.error, /active/);
  });
});

/* -------------------------------------------------------------------------- */
/*  The rate limit, measured rather than counted                              */
/* -------------------------------------------------------------------------- */

test("the hourly rail counts what was applied", async (t) => {
  await t.test("the second action inside the hour is refused", async () => {
    const h = harness({ maxActionsPerHour: 1, requireSecondApprover: false });

    const first = await h.service.apply({ organizationId: ORG, proposal: proposal() });
    assert.equal(first.ok, true);

    const second = await h.service.apply({
      organizationId: ORG,
      proposal: proposal({
        targets: [{ kind: "ADDRESS", value: "198.51.100.7" }],
        alertId: "alert_2",
      }),
    });

    assert.equal(second.ok, false);
    if (!second.ok) assert.match(second.error, /already applied in the last hour/);
  });

  await t.test("an action from more than an hour ago does not hold the slot", async () => {
    const h = harness({ maxActionsPerHour: 1, requireSecondApprover: false });
    const first = await h.service.apply({ organizationId: ORG, proposal: proposal() });
    assert.equal(first.ok, true);

    h.ids.advance(61 * 60 * 1000);
    const second = await h.service.apply({
      organizationId: ORG,
      proposal: proposal({ targets: [{ kind: "ADDRESS", value: "198.51.100.7" }], alertId: "alert_2" }),
    });
    assert.equal(second.ok, true);
  });

  await t.test("a proposal that was never applied does not consume the limit", async () => {
    // A pending action is not an action. If it counted, a queue of proposals nobody approved
    // would lock the deployment out of responding at all.
    const h = harness({ maxActionsPerHour: 1, requireSecondApprover: true });
    const proposed = await h.service.apply({ organizationId: ORG, proposal: proposal() });
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    assert.equal(proposed.value.action.state, "PENDING");

    await h.service.setPolicy(
      ORG,
      { ...DEFAULT_ENFORCEMENT_POLICY, maxActionsPerHour: 1, requireSecondApprover: false },
      { identityId: "id_admin3", label: "Cleo" },
    );

    const second = await h.service.apply({
      organizationId: ORG,
      proposal: proposal({ targets: [{ kind: "ADDRESS", value: "198.51.100.7" }], alertId: "alert_2" }),
    });
    assert.equal(second.ok, true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Lifting, by hand and by its own clock                                     */
/* -------------------------------------------------------------------------- */

test("an action is reversible, and the TTL is what reverses it", async (t) => {
  await t.test("its deadline lifts it, once", async () => {
    const h = harness({ defaultTtlSeconds: 900, requireSecondApprover: false });
    const applied = await h.service.apply({ organizationId: ORG, proposal: proposal() });
    assert.equal(applied.ok, true);
    if (!applied.ok) return;

    // Before the deadline: still in force, and nothing to expire.
    h.ids.advance(899_000);
    assert.deepEqual((await h.service.expire(ORG)).lifted, []);
    assert.equal((await h.service.inForce(ORG)).length, 1);

    // After it: lifted, by the scheduler, with the reason saying so.
    h.ids.advance(1000);
    const swept = await h.service.expire(ORG);
    assert.deepEqual(swept.lifted, [applied.value.action.id]);

    const stored = await h.store.findAction(ORG, applied.value.action.id);
    assert.equal(stored?.state, "LIFTED");
    assert.equal(stored?.liftedById, "scheduler");
    assert.match(String(stored?.liftReason), /time limit/);

    // Idempotent: a second sweep lifts nothing and writes no second row.
    assert.deepEqual((await h.service.expire(ORG)).lifted, []);
    assert.equal(audited(h, "enforcement.lift").length, 1);
    assert.deepEqual(await h.service.inForce(ORG), []);
  });

  await t.test("a lift names the person who lifted it", async () => {
    const h = harness({ requireSecondApprover: false, defaultTtlSeconds: 0 });
    const applied = await h.service.apply({ organizationId: ORG, proposal: proposal() });
    assert.equal(applied.ok, true);
    if (!applied.ok) return;

    const lifted = await h.service.lift({
      organizationId: ORG,
      actionId: applied.value.action.id,
      by: { identityId: "id_admin2", label: "Bea" },
      reason: "False positive; the host is a scanner.",
    });

    assert.equal(lifted.ok, true);
    if (!lifted.ok) return;
    assert.equal(lifted.value.state, "LIFTED");
    assert.equal(lifted.value.liftedById, "id_admin2");
    assert.equal(lifted.value.liftReason, "False positive; the host is a scanner.");

    const rows = audited(h, "enforcement.lift");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.actor, "id_admin2");
    assert.match(String((rows[0]?.detail as { reason?: string }).reason), /Lifted by Bea/);
    const detail = rows[0]?.detail as { actionId?: string; automatic?: boolean };
    assert.equal(detail.actionId, applied.value.action.id);
    assert.equal(detail.automatic, false);
  });

  await t.test("an action that is not in force cannot be lifted", async () => {
    const h = harness({ requireSecondApprover: false });
    const applied = await h.service.apply({ organizationId: ORG, proposal: proposal() });
    assert.equal(applied.ok, true);
    if (!applied.ok) return;

    await h.service.lift({
      organizationId: ORG,
      actionId: applied.value.action.id,
      by: { identityId: "id_admin", label: "Ana" },
    });
    const again = await h.service.lift({
      organizationId: ORG,
      actionId: applied.value.action.id,
      by: { identityId: "id_admin", label: "Ana" },
    });

    assert.equal(again.ok, false);
    if (!again.ok) assert.match(again.error, /lifted/);
  });
});

/* -------------------------------------------------------------------------- */
/*  The policy                                                                */
/* -------------------------------------------------------------------------- */

test("the policy is stored, audited, and validated", async (t) => {
  await t.test("it round-trips per organization", async () => {
    const h = harness();
    assert.deepEqual(await h.service.policy(ORG), DEFAULT_ENFORCEMENT_POLICY);

    const stored = { ...DEFAULT_ENFORCEMENT_POLICY, protectedTargets: ["10.20.0.0/24"], maxTargets: 3 };
    const result = await h.service.setPolicy(ORG, stored, { identityId: "id_admin", label: "Ana" });
    assert.equal(result.ok, true);
    assert.deepEqual(await h.service.policy(ORG), stored);
    // Not another organization's.
    assert.deepEqual(await h.service.policy("org_2"), DEFAULT_ENFORCEMENT_POLICY);

    const rows = audited(h, "enforcement.policy");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.actor, "id_admin");
    // The whole policy is recorded, so "what were the rails then" is answerable later.
    assert.deepEqual((rows[0]?.detail as { policy?: EnforcementPolicy }).policy, stored);
  });

  await t.test("a policy that would not work is refused rather than stored", async () => {
    assert.match(String(validatePolicy({ ...DEFAULT_ENFORCEMENT_POLICY, protectedTargets: [" "] })), /blank/);
    assert.match(String(validatePolicy({ ...DEFAULT_ENFORCEMENT_POLICY, maxTargets: 0 })), /blast-radius/);
    assert.match(String(validatePolicy({ ...DEFAULT_ENFORCEMENT_POLICY, maxActionsPerHour: -1 })), /hourly/);
    assert.match(String(validatePolicy({ ...DEFAULT_ENFORCEMENT_POLICY, defaultTtlSeconds: -5 })), /lifetime/);
    assert.equal(validatePolicy(DEFAULT_ENFORCEMENT_POLICY), null);

    const h = harness();
    const refused = await h.service.setPolicy(ORG, { ...DEFAULT_ENFORCEMENT_POLICY, maxTargets: 0 }, {
      identityId: "id_admin",
      label: "Ana",
    });
    assert.equal(refused.ok, false);
    assert.deepEqual(await h.service.policy(ORG), DEFAULT_ENFORCEMENT_POLICY);
    assert.equal(audited(h, "enforcement.policy").length, 0);
  });
});

test("time-to-prevent is measured when an action goes in force", async (t) => {
  await t.test("an immediate action carries the interval from the detection", async () => {
    const h = harness({ requireSecondApprover: false });
    const applied = await h.service.apply({
      organizationId: ORG,
      detectedAt: "2026-10-01T11:58:00.000Z",
      proposal: proposal(),
    });

    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.equal(applied.value.action.detectedAt, "2026-10-01T11:58:00.000Z");
    assert.equal(applied.value.action.timeToPreventMs, 120_000);
  });

  await t.test("a waiting proposal is measured at approval, so the wait is part of it", async () => {
    const h = harness();
    const proposed = await h.service.apply({
      organizationId: ORG,
      detectedAt: "2026-10-01T11:59:00.000Z",
      proposal: proposal(),
    });
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;

    // Nothing is in force, so nothing has been prevented: the detection is recorded and the
    // interval is deliberately not. A time written here would count a decision nobody made.
    assert.equal(proposed.value.action.state, "PENDING");
    assert.equal(proposed.value.action.detectedAt, "2026-10-01T11:59:00.000Z");
    assert.equal(proposed.value.action.timeToPreventMs, null);

    // Two minutes pass waiting for the second administrator.
    h.ids.advance(120_000);
    const approved = await h.service.approve({
      organizationId: ORG,
      actionId: proposed.value.action.id,
      approver: { identityId: "id_admin2", label: "Bea", role: "ADMIN" },
    });

    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    assert.equal(approved.value.action.timeToPreventMs, 180_000);
  });

  await t.test("a proposal with no detection instant is applied unmeasured", async () => {
    const h = harness({ requireSecondApprover: false });
    const applied = await h.service.apply({ organizationId: ORG, proposal: proposal() });

    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.equal(applied.value.action.detectedAt, null);
    assert.equal(applied.value.action.timeToPreventMs, null);
    // Unmeasured is not un-applied: the block is in force either way.
    assert.equal((await h.service.inForce(ORG)).length, 1);
  });

  await t.test("a detection after the application measures nothing", async () => {
    const h = harness({ requireSecondApprover: false });
    const applied = await h.service.apply({
      organizationId: ORG,
      // Later than now: a skewed sensor or a mis-set clock, recorded as unmeasured rather
      // than as an impossibly fast response.
      detectedAt: "2026-10-01T12:30:00.000Z",
      proposal: proposal(),
    });

    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.equal(applied.value.action.timeToPreventMs, null);
  });
});

test("what is in force is a question the store can answer", async () => {
  const h = harness({ requireSecondApprover: false, maxActionsPerHour: 10 });

  const first = await h.service.apply({ organizationId: ORG, proposal: proposal() });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  await h.service.lift({
    organizationId: ORG,
    actionId: first.value.action.id,
    by: { identityId: "id_admin", label: "Ana" },
  });

  const second = await h.service.apply({
    organizationId: ORG,
    proposal: proposal({ targets: [{ kind: "IDENTITY", value: "id_svc" }], alertId: "alert_2", action: "QUARANTINE" }),
  });
  assert.equal(second.ok, true);

  const inForce = await h.service.inForce(ORG);
  assert.equal(inForce.length, 1);
  assert.equal(inForce[0]?.action, "QUARANTINE");
  assert.equal(inForce[0]?.rollback?.kind, "RELEASE");

  // The history is still there — the lift did not delete anything.
  assert.equal((await h.service.list(ORG)).length, 2);
});
