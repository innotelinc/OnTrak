/**
 * OnTrak Sentinel S4 tests: what may be enforced against, and on whose authority.
 *
 * Prevention is the only part of this product that can take somebody's production
 * off the network, so the tests are organised around the ways it goes wrong rather
 * than around the functions:
 *
 *  - **A protected target is refused, full stop.** Not "refused for this role" and
 *    not "refused unless approved" — the check runs before the others so it cannot
 *    be reached by exhausting them, and the case is driven with an administrator
 *    who already has a second approval on file.
 *  - **Blast radius refuses rather than truncates.** A cap of one against three
 *    targets is a refusal naming all three, because a silently smaller action is a
 *    different action from the one that was described.
 *  - **The rate limit is a rolling hour**, not a counter: what matters is the times
 *    passed in, so the test passes times and not a number.
 *  - **Two administrators means two people.** The requester's own approval does not
 *    satisfy the requirement, which is the entire purpose of asking for one.
 *  - **Every allowed action is reversible and auditable by construction.** The
 *    rollback is computed at the decision, and the audit intent is part of the
 *    answer rather than something a caller might remember to write.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  actionsInLastHour,
  auditActionFor,
  decideEnforcement,
  decideRollback,
  DEFAULT_ENFORCEMENT_POLICY,
  isProtectedTarget,
  protectedTargets,
  type EnforcementContext,
  type EnforcementPolicy,
  type EnforcementProposal,
  type EnforcementTarget,
} from "../src/lib/enforcement-rules";

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const NOW = "2026-10-01T12:00:00.000Z";

const address = (value: string, label?: string): EnforcementTarget => ({
  kind: "ADDRESS",
  value,
  ...(label === undefined ? {} : { label }),
});

const identity = (value: string): EnforcementTarget => ({ kind: "IDENTITY", value });

function policy(overrides: Partial<EnforcementPolicy> = {}): EnforcementPolicy {
  // A permissive policy by default, so each test's refusal is caused by the rule
  // under test rather than by a cautious default somewhere else.
  return {
    protectedTargets: [],
    maxTargets: 5,
    maxActionsPerHour: 100,
    defaultTtlSeconds: 3600,
    allowPermanent: false,
    requireSecondApprover: false,
    ...overrides,
  };
}

function proposal(overrides: Partial<EnforcementProposal> = {}): EnforcementProposal {
  return {
    action: "BLOCK",
    targets: [address("203.0.113.9", "the C2 host")],
    alertId: "alert_1",
    reason: "Beaconing to a known C2 address every 30 seconds.",
    requestedBy: { identityId: "id_admin", label: "Ana", role: "ADMIN" },
    ...overrides,
  };
}

const context = (overrides: Partial<EnforcementContext> = {}): EnforcementContext => ({
  now: NOW,
  recentActionTimes: [],
  auditEventId: "audit_1",
  ...overrides,
});

/* -------------------------------------------------------------------------- */
/*  What a proposal must say                                                  */
/* -------------------------------------------------------------------------- */

test("a proposal has to be actionable and answer a detection", async (t) => {
  await t.test("nothing to act on is refused", () => {
    const decision = decideEnforcement(proposal({ targets: [] }), policy(), context());
    assert.equal(decision.allow, false);
    if (!decision.allow) assert.equal(decision.code, "NO_TARGETS");
  });

  await t.test("a block with no note is refused, not defaulted", () => {
    const decision = decideEnforcement(proposal({ reason: "   " }), policy(), context());
    assert.equal(decision.allow, false);
    if (!decision.allow) assert.equal(decision.code, "NO_REASON");
  });

  await t.test("prevention with no detection behind it is somebody's opinion", () => {
    const decision = decideEnforcement(proposal({ alertId: "" }), policy(), context());
    assert.equal(decision.allow, false);
    if (!decision.allow) assert.equal(decision.code, "NO_DETECTION");
  });
});

/* -------------------------------------------------------------------------- */
/*  1. The safe-list, checked first and absolute                             */
/* -------------------------------------------------------------------------- */

test("a protected target is refused by anybody", async (t) => {
  await t.test("an address inside a protected CIDR is protected", () => {
    const p = policy({ protectedTargets: ["10.20.0.0/24"] });
    assert.equal(isProtectedTarget(address("10.20.0.7"), p), true);
    assert.equal(isProtectedTarget(address("10.20.1.7"), p), false);
    // A single address can be named without enumerating its subnet.
    assert.equal(isProtectedTarget(address("10.20.0.7"), policy({ protectedTargets: ["10.20.0.7"] })), true);
  });

  await t.test("an identity or device is protected by its own id", () => {
    const p = policy({ protectedTargets: ["id_ceo"] });
    assert.equal(isProtectedTarget(identity("id_ceo"), p), true);
    assert.equal(isProtectedTarget(identity("id_someone_else"), p), false);
    // Blank entries are not a wildcard.
    assert.equal(isProtectedTarget(identity("   "), policy({ protectedTargets: ["", "  "] })), false);
  });

  await t.test("only the protected subset is named back", () => {
    const targets = [address("10.20.0.7"), address("203.0.113.9")];
    const found = protectedTargets(targets, policy({ protectedTargets: ["10.20.0.0/24"] }));
    assert.deepEqual(found, [address("10.20.0.7")]);
  });

  await t.test("an administrator with a second approval still cannot touch it", () => {
    // The ordering property: the safe-list is checked before the blast radius, the
    // rate limit and the authority question, so there is no combination of a
    // permissive policy and a well-approved request that reaches a protected target.
    const decision = decideEnforcement(
      proposal({ targets: [address("10.20.0.7", "the imaging gateway")] }),
      policy({
        protectedTargets: ["10.20.0.0/24"],
        requireSecondApprover: true,
        maxTargets: 50,
        maxActionsPerHour: 500,
      }),
      context({ approvals: [{ identityId: "id_admin2", role: "ADMIN", at: NOW }] }),
    );

    assert.equal(decision.allow, false);
    if (!decision.allow) {
      assert.equal(decision.code, "PROTECTED_TARGET");
      assert.deepEqual(decision.targets, [address("10.20.0.7", "the imaging gateway")]);
      assert.match(decision.reason, /safe-list/);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  2. Blast radius                                                           */
/* -------------------------------------------------------------------------- */

test("an action larger than the cap is refused, never quietly smaller", async (t) => {
  await t.test("more targets than the policy allows", () => {
    const decision = decideEnforcement(
      proposal({ targets: [address("203.0.113.9"), address("203.0.113.10"), address("203.0.113.11")] }),
      policy({ maxTargets: 1 }),
      context(),
    );

    assert.equal(decision.allow, false);
    if (!decision.allow) {
      assert.equal(decision.code, "BLAST_RADIUS");
      // All three, not the first one: the operator has to see the size of what they asked for.
      assert.equal(decision.targets?.length, 3);
      assert.match(decision.reason, /not truncated/);
    }
  });

  await t.test("exactly at the cap is allowed", () => {
    const decision = decideEnforcement(
      proposal({ targets: [address("203.0.113.9"), address("203.0.113.10")] }),
      policy({ maxTargets: 2 }),
      context(),
    );
    assert.equal(decision.allow, true);
  });
});

/* -------------------------------------------------------------------------- */
/*  3. The rate limit is a rolling hour                                       */
/* -------------------------------------------------------------------------- */

test("the rate limit is measured, not counted", async (t) => {
  await t.test("the window is the hour ending now, inclusive of now", () => {
    const times = [
      "2026-10-01T12:00:00.000Z", // now — counts
      "2026-10-01T11:30:00.000Z", // inside
      "2026-10-01T11:00:00.000Z", // the boundary itself — outside, one hour is up
      "2026-10-01T09:00:00.000Z", // yesterday's work
      "not a time",
    ];
    assert.equal(actionsInLastHour(times, NOW), 2);
  });

  await t.test("a full hour refuses the next action", () => {
    const recent = ["2026-10-01T11:05:00.000Z", "2026-10-01T11:25:00.000Z"];
    const decision = decideEnforcement(
      proposal(),
      policy({ maxActionsPerHour: 2 }),
      context({ recentActionTimes: recent }),
    );

    assert.equal(decision.allow, false);
    if (!decision.allow) {
      assert.equal(decision.code, "RATE_LIMITED");
      assert.match(decision.reason, /2 enforcement actions already applied/);
    }
  });

  await t.test("an action from more than an hour ago does not hold the slot", () => {
    const decision = decideEnforcement(
      proposal(),
      policy({ maxActionsPerHour: 1 }),
      context({ recentActionTimes: ["2026-10-01T10:59:59.000Z"] }),
    );
    assert.equal(decision.allow, true);
  });

  await t.test("a limit of zero refuses every action rather than meaning no limit", () => {
    const decision = decideEnforcement(proposal(), policy({ maxActionsPerHour: 0 }), context());
    assert.equal(decision.allow, false);
    if (!decision.allow) assert.equal(decision.code, "RATE_LIMITED");
  });
});

/* -------------------------------------------------------------------------- */
/*  4. Authority — two administrators means two people                        */
/* -------------------------------------------------------------------------- */

test("prevention is an administrator's action", async (t) => {
  await t.test("a non-administrator can propose and cannot apply", () => {
    const decision = decideEnforcement(
      proposal({ requestedBy: { identityId: "id_auditor", label: "Sam", role: "AUDITOR" } }),
      policy(),
      context(),
    );

    assert.equal(decision.allow, true);
    if (decision.allow) {
      assert.equal(decision.gate, "APPROVAL_REQUIRED");
      assert.equal(decision.approvedBy, null);
    }
  });

  await t.test("a second approver is required, and it has to be somebody else", () => {
    const p = policy({ requireSecondApprover: true });

    const alone = decideEnforcement(proposal(), p, context());
    assert.equal(alone.allow, true);
    if (alone.allow) {
      assert.equal(alone.gate, "APPROVAL_REQUIRED");
      assert.equal(alone.approvedBy, null);
    }

    // The requester approving their own action is not a second pair of eyes.
    const selfApproved = decideEnforcement(
      proposal(),
      p,
      context({ approvals: [{ identityId: "id_admin", role: "ADMIN", at: NOW }] }),
    );
    assert.equal(selfApproved.allow, true);
    if (selfApproved.allow) assert.equal(selfApproved.gate, "APPROVAL_REQUIRED");

    // A non-administrator's approval is not an approval either.
    const auditorApproved = decideEnforcement(
      proposal(),
      p,
      context({ approvals: [{ identityId: "id_auditor", role: "AUDITOR", at: NOW }] }),
    );
    assert.equal(auditorApproved.allow, true);
    if (auditorApproved.allow) assert.equal(auditorApproved.gate, "APPROVAL_REQUIRED");

    // A second administrator's is.
    const approved = decideEnforcement(
      proposal(),
      p,
      context({ approvals: [{ identityId: "id_admin2", role: "ADMIN", at: NOW }] }),
    );
    assert.equal(approved.allow, true);
    if (approved.allow) {
      assert.equal(approved.gate, "IMMEDIATE");
      assert.equal(approved.approvedBy, "id_admin2");
    }
  });

  await t.test("one administrator is enough where the policy says so", () => {
    const decision = decideEnforcement(
      proposal(),
      policy({ requireSecondApprover: false }),
      context(),
    );
    assert.equal(decision.allow, true);
    if (decision.allow) {
      assert.equal(decision.gate, "IMMEDIATE");
      assert.equal(decision.approvedBy, "id_admin");
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  5. Reversible by default, auditable by construction                       */
/* -------------------------------------------------------------------------- */

test("every allowed action carries its own inverse and its own audit row", async (t) => {
  await t.test("a block lifts itself when the TTL is up", () => {
    const decision = decideEnforcement(proposal(), policy({ defaultTtlSeconds: 900 }), context());
    assert.equal(decision.allow, true);
    if (!decision.allow) return;

    assert.equal(decision.rollback.kind, "LIFT");
    assert.equal(decision.rollback.action, "BLOCK");
    assert.equal(decision.rollback.at, "2026-10-01T12:15:00.000Z");
    assert.deepEqual(decision.rollback.targets, [address("203.0.113.9", "the C2 host")]);
  });

  await t.test("a quarantine is released, and a rate limit is lifted", () => {
    const quarantine = decideEnforcement(proposal({ action: "QUARANTINE" }), policy(), context());
    assert.equal(quarantine.allow, true);
    if (quarantine.allow) assert.equal(quarantine.rollback.kind, "RELEASE");

    const limited = decideEnforcement(proposal({ action: "RATE_LIMIT" }), policy(), context());
    assert.equal(limited.allow, true);
    if (limited.allow) assert.equal(limited.rollback.kind, "LIFT");
  });

  await t.test("a permanent action is refused where the policy forbids it", () => {
    const decision = decideEnforcement(proposal({ permanent: true }), policy(), context());
    assert.equal(decision.allow, false);
    if (!decision.allow) assert.equal(decision.code, "PERMANENT_NOT_ALLOWED");
  });

  await t.test("where a policy allows one, it has no TTL and says so", () => {
    const decision = decideEnforcement(
      proposal({ permanent: true }),
      policy({ allowPermanent: true, defaultTtlSeconds: 3600 }),
      context(),
    );
    assert.equal(decision.allow, true);
    if (decision.allow) {
      assert.equal(decision.rollback.at, null);
      assert.match(decision.rollback.label, /by hand/);
    }
  });

  await t.test("the audit intent names the actor, the alert and the policy", () => {
    const p = policy({ requireSecondApprover: true, protectedTargets: ["10.0.0.0/8"] });
    const decision = decideEnforcement(
      proposal(),
      p,
      context({
        auditEventId: "audit_42",
        approvals: [{ identityId: "id_admin2", role: "ADMIN", at: NOW }],
      }),
    );

    assert.equal(decision.allow, true);
    if (!decision.allow) return;

    // The id comes from the caller, so a retried request appends one row and not two.
    assert.equal(decision.audit.id, "audit_42");
    assert.equal(decision.audit.action, "block.apply");
    assert.equal(decision.audit.actor, "id_admin");
    assert.equal(decision.audit.targetType, "ADDRESS");
    assert.equal(decision.audit.targetId, "203.0.113.9");
    assert.equal(decision.audit.detail.alertId, "alert_1");
    assert.equal(decision.audit.detail.gate, "IMMEDIATE");
    assert.equal(decision.audit.detail.approvedBy, "id_admin2");
    // The policy is recorded as it was judged, not as it is later edited.
    assert.deepEqual(decision.audit.detail.policy, p);
    assert.deepEqual(decision.audit.detail.rollback, decision.rollback);
  });

  await t.test("each action has one name in the chain", () => {
    assert.equal(auditActionFor("BLOCK"), "block.apply");
    assert.equal(auditActionFor("QUARANTINE"), "quarantine.apply");
    assert.equal(auditActionFor("RATE_LIMIT"), "rate-limit.apply");
  });
});

test("lifting an action is as auditable as applying it", async (t) => {
  await t.test("the lift names the person who lifted it, and no policy", () => {
    const decision = decideEnforcement(proposal(), policy(), context());
    assert.equal(decision.allow, true);
    if (!decision.allow) return;

    const intent = decideRollback(
      decision.rollback,
      { identityId: "id_admin2", label: "Bea" },
      { now: "2026-10-01T13:00:00.000Z", auditEventId: "audit_lift" },
    );

    assert.equal(intent.action, "enforcement.lift");
    assert.equal(intent.actor, "id_admin2");
    assert.equal(intent.targetId, "203.0.113.9");
    assert.match(intent.detail.reason, /Lifted by Bea/);
    // No policy was applied to a lift, and the row must not claim one was.
    assert.equal(intent.detail.policy, null);
    assert.deepEqual(intent.detail.targets, decision.rollback.targets);
  });

  await t.test("the default posture is the cautious one", () => {
    assert.deepEqual(DEFAULT_ENFORCEMENT_POLICY.protectedTargets, []);
    assert.equal(DEFAULT_ENFORCEMENT_POLICY.maxTargets, 1);
    assert.equal(DEFAULT_ENFORCEMENT_POLICY.maxActionsPerHour, 10);
    assert.equal(DEFAULT_ENFORCEMENT_POLICY.allowPermanent, false);
    assert.equal(DEFAULT_ENFORCEMENT_POLICY.requireSecondApprover, true);
  });
});
