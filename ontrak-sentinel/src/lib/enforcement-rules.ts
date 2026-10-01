import { inCidr } from "./detection-rules";
import { canApproveEnforcement, type IdentityRole } from "./identity-rules";

/**
 * The decision half of Sentinel's prevention (S4) — **what may be enforced against,
 * and on whose authority** — written before anything blocks traffic, on purpose.
 *
 * Prevention is the one thing in this product that can take a hospital's imaging
 * gateway off the network. So the ordering inside `decideEnforcement` is the
 * design, and it is a different order from the one that reads naturally:
 *
 *   1. **Is the target protected?** First, before blast radius, before the rate
 *      limit, before any question about who is asking — because a rail you can
 *      reach by exhausting the other rails is not a rail. A protected target is
 *      refused *even for an administrator*, and the refusal names the target and
 *      the rule that protects it.
 *   2. **Blast radius.** An action is capped at the policy's target count. A
 *      "block everything that talked to this C2 host" that resolves to nine
 *      thousand addresses is refused rather than truncated: silently reducing an
 *      action's scope produces a *different* action from the one somebody
 *      approved, which is worse than refusing it.
 *   3. **Rate limit.** A sliding window, passed in as the times of recent
 *      actions, so this module stays pure and the deployment owns the clock.
 *   4. **Authority.** Prevention is an administrator's action, and the policy
 *      decides whether it needs a *second* administrator — a different one, which
 *      is the whole point of asking. A non-administrator can propose and cannot
 *      apply.
 *
 * Two more properties are deliberately part of the answer rather than the caller's
 * problem. **Every allowed action carries its own rollback** (`LIFT` for a block
 * or a rate limit, `RELEASE` for a quarantine) and a TTL: reversible-by-default
 * means the inverse is computed at the moment of the decision, not remembered
 * later by whoever has to undo it. And **every allowed action carries the audit
 * intent** — actor, approver, action, target, the policy it was judged against —
 * because "every action audited" is a property of the decision, and an enforcement
 * path that could skip the audit row would be a hole in the evidence spine.
 *
 * What this module is **not**: the wire. Nothing here blocks a packet, writes a
 * row, or lifts an action. It is the pure rule the service (and the console, and
 * the test suite) calls, in the same shape `identity-rules.ts` and
 * `detection-rules.ts` already take — a decision that can be driven with the
 * inputs that must pass and the ones just short of it.
 */

/* -------------------------------------------------------------------------- */
/*  What may be proposed                                                      */
/* -------------------------------------------------------------------------- */

/** The three actions the roadmap names, each with its own inverse. */
export type EnforcementActionKind = "BLOCK" | "QUARANTINE" | "RATE_LIMIT";

export type EnforcementTargetKind = "ADDRESS" | "IDENTITY" | "DEVICE";

/**
 * The vocabulary, as values rather than only as a type.
 *
 * A console picker and a parser both need the list at runtime, and a second copy of it
 * in a template is how a form offers a value the decision would refuse. This is the one
 * copy, and `EnforcementTargetKind` is a type *over* it so the two cannot drift.
 */
export const ENFORCEMENT_ACTION_KINDS = ["BLOCK", "QUARANTINE", "RATE_LIMIT"] as const;
export const ENFORCEMENT_TARGET_KINDS = ["ADDRESS", "IDENTITY", "DEVICE"] as const;

export interface EnforcementTarget {
  kind: EnforcementTargetKind;
  /** An IPv4/IPv6 address, or an identity/device id. */
  value: string;
  /** What to call it in the audit row — an address alone reads badly next month. */
  label?: string;
}

/**
 * Read the console's target box into targets.
 *
 * One target per line, and the grammar is deliberately small: an optional kind, then the
 * value, then an optional human label for the audit row — `ADDRESS 203.0.113.7 scanner`. A
 * line with no recognised kind is an `ADDRESS`, because the common case is an operator
 * pasting addresses and a box that refused those until they typed `ADDRESS` in front of each
 * would be a box nobody uses. An empty line and a `#` comment are skipped rather than
 * reported as bad input, the same way the threat-intel paste is read.
 *
 * It does **not** validate the value: whether an address is well-formed, or whether it is on
 * the safe-list, is the decision's to answer, and a parser that also judged would be a second
 * place the rules live. The label is the rest of the line, so a value with no label still
 * produces a target rather than a refusal.
 */
export function parseTargetLines(text: string): EnforcementTarget[] {
  const targets: EnforcementTarget[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const tokens = line.split(/\s+/);
    const first = tokens[0]!.toUpperCase();
    const named = (ENFORCEMENT_TARGET_KINDS as readonly string[]).includes(first);
    const kind: EnforcementTargetKind = named ? (first as EnforcementTargetKind) : "ADDRESS";
    const value = named ? tokens[1] : tokens[0];
    if (!value) continue;
    const label = (named ? tokens.slice(2) : tokens.slice(1)).join(" ");
    targets.push(label === "" ? { kind, value } : { kind, value, label });
  }
  return targets;
}

export interface EnforcementProposal {
  action: EnforcementActionKind;
  targets: EnforcementTarget[];
  /** The alert this answers. An enforcement action with no detection behind it is not one. */
  alertId: string;
  /** Why, in a sentence a reviewer will accept. Required: see `decideEnforcement`. */
  reason: string;
  /** Who asked. */
  requestedBy: { identityId: string; label: string; role: IdentityRole };
  /**
   * Ask for an action that stands until somebody lifts it by hand.
   *
   * Reversible-by-default is the policy, so this is an explicit request that the
   * policy may refuse (`allowPermanent: false`).
   */
  permanent?: boolean;
}

/** The policy an organization has stored. This module never reads one from disk. */
export interface EnforcementPolicy {
  /**
   * Never enforced against: CIDRs for `ADDRESS` targets, exact ids for
   * `IDENTITY`/`DEVICE`.
   *
   * The roadmap calls this the safe-list for critical infrastructure. It is
   * checked first and it is absolute — an empty list is a policy nobody has
   * written yet, not a permission.
   */
  protectedTargets: string[];
  /** Blast radius: the most targets one action may name. */
  maxTargets: number;
  /** Rate limit: actions allowed in a rolling hour, across the organization. */
  maxActionsPerHour: number;
  /** How long an action stands before it lifts itself. `0` means until lifted by hand. */
  defaultTtlSeconds: number;
  /** Whether a permanent action may be taken at all. */
  allowPermanent: boolean;
  /** Whether a *second* administrator must approve. */
  requireSecondApprover: boolean;
}

/**
 * The posture a deployment starts in before anybody has written a policy.
 *
 * Deliberately the cautious end: one target per action, ten actions an hour, an
 * hour's TTL, permanent actions refused, and a second administrator required. An
 * operator relaxes these on the page that shows what each one means; a default
 * that did the opposite would be a default somebody only notices afterwards.
 */
export const DEFAULT_ENFORCEMENT_POLICY: EnforcementPolicy = {
  protectedTargets: [],
  maxTargets: 1,
  maxActionsPerHour: 10,
  defaultTtlSeconds: 3600,
  allowPermanent: false,
  requireSecondApprover: true,
};

/** An approval already on record for this proposal. */
export interface EnforcementApproval {
  identityId: string;
  role: IdentityRole;
  /** ISO-8601, for the audit row rather than the decision. */
  at: string;
}

export interface EnforcementContext {
  /** Server-authoritative UTC, ISO-8601. */
  now: string;
  /** When the organization's recent enforcement actions were applied, ISO-8601. */
  recentActionTimes: string[];
  /** Approvals recorded for this proposal so far. */
  approvals?: EnforcementApproval[];
  /** Stable id for the audit row, supplied by the caller so a replay is idempotent. */
  auditEventId: string;
}

/* -------------------------------------------------------------------------- */
/*  The answer                                                                */
/* -------------------------------------------------------------------------- */

export type EnforcementRefusal =
  | "NO_TARGETS"
  | "NO_REASON"
  | "NO_DETECTION"
  | "PROTECTED_TARGET"
  | "BLAST_RADIUS"
  | "RATE_LIMITED"
  | "PERMANENT_NOT_ALLOWED";

export type EnforcementGate = "IMMEDIATE" | "APPROVAL_REQUIRED";

/** The inverse of an allowed action, computed now rather than remembered later. */
export interface RollbackPlan {
  /** `LIFT` removes a block or a rate limit; `RELEASE` returns a quarantined target. */
  kind: "LIFT" | "RELEASE";
  action: EnforcementActionKind;
  targets: EnforcementTarget[];
  /** When the action lifts itself, or null when it stands until lifted by hand. */
  at: string | null;
  /** What to call this in the console. */
  label: string;
}

/** The `AuditEventInput` the caller appends, minus the chain's own fields. */
export interface EnforcementAuditIntent {
  id: string;
  at: string;
  /** The administrator the action is attributed to. */
  actor: string;
  /** `block.apply`, `quarantine.apply`, `rate-limit.apply` — the chain's vocabulary. */
  action: string;
  targetType: string;
  targetId: string;
  detail: {
    alertId: string;
    reason: string;
    targets: EnforcementTarget[];
    /**
     * The policy the action was judged against. `null` on a lift, which is judged
     * against no policy — a row that carried the default here would say a rule was
     * applied when none was.
     */
    policy: EnforcementPolicy | null;
    gate: EnforcementGate;
    approvedBy: string | null;
    rollback: RollbackPlan;
  };
}

export type EnforcementDecision =
  | {
      allow: false;
      code: EnforcementRefusal;
      /** A sentence for the operator's screen. */
      reason: string;
      /** Which targets triggered it, when the refusal is about particular ones. */
      targets?: EnforcementTarget[];
    }
  | {
      allow: true;
      gate: EnforcementGate;
      /** `null` until a second administrator has approved. */
      approvedBy: string | null;
      rollback: RollbackPlan;
      audit: EnforcementAuditIntent;
    };

/* -------------------------------------------------------------------------- */
/*  The checks                                                                */
/* -------------------------------------------------------------------------- */

/** Whether this target is one the policy refuses to touch. */
export function isProtectedTarget(target: EnforcementTarget, policy: EnforcementPolicy): boolean {
  for (const entry of policy.protectedTargets) {
    if (entry.trim() === "") continue;
    if (target.kind === "ADDRESS") {
      // An address is protected by a CIDR or by itself, so a policy can name a
      // /24 for the imaging VLAN without enumerating it.
      if (inCidr(target.value, entry.trim()) || target.value === entry.trim()) return true;
    } else if (target.value === entry.trim()) {
      return true;
    }
  }
  return false;
}

/** The protected subset of a proposal's targets, in the order they were given. */
export function protectedTargets(
  targets: EnforcementTarget[],
  policy: EnforcementPolicy,
): EnforcementTarget[] {
  return targets.filter((target) => isProtectedTarget(target, policy));
}

/**
 * Enforcement actions applied inside the rolling hour ending at `now`.
 *
 * Takes the times rather than a store so the rule is pure and the deployment owns
 * the clock: the caller passes what it has already recorded, and the same
 * function answers the same way in a test and in a container.
 */
export function actionsInLastHour(recentActionTimes: string[], now: string): number {
  const end = Date.parse(now);
  if (!Number.isFinite(end)) return 0;
  const start = end - 60 * 60 * 1000;
  return recentActionTimes.filter((at) => {
    const parsed = Date.parse(at);
    return Number.isFinite(parsed) && parsed > start && parsed <= end;
  }).length;
}

/** The chain vocabulary for an action. */
export function auditActionFor(action: EnforcementActionKind): string {
  switch (action) {
    case "BLOCK":
      return "block.apply";
    case "QUARANTINE":
      return "quarantine.apply";
    case "RATE_LIMIT":
      return "rate-limit.apply";
  }
}

function rollbackFor(
  action: EnforcementActionKind,
  targets: EnforcementTarget[],
  ttlSeconds: number,
  now: string,
): RollbackPlan {
  const at =
    ttlSeconds > 0 ? new Date(Date.parse(now) + ttlSeconds * 1000).toISOString() : null;
  const lift = action === "QUARANTINE" ? "RELEASE" : "LIFT";
  return {
    kind: lift,
    action,
    targets: [...targets],
    at,
    label:
      at === null
        ? `${lift} this ${action.toLowerCase().replace("_", "-")} by hand`
        : `lift this ${action.toLowerCase().replace("_", "-")} automatically at ${at}`,
  };
}

/**
 * Whether a proposed action may be applied, and on whose authority.
 *
 * Pure: no clock, no store, no network. See the file header for why the checks are
 * in this order.
 */
export function decideEnforcement(
  proposal: EnforcementProposal,
  policy: EnforcementPolicy,
  context: EnforcementContext,
): EnforcementDecision {
  if (proposal.targets.length === 0) {
    return {
      allow: false,
      code: "NO_TARGETS",
      reason: "An enforcement action needs at least one target; there is nothing to apply it to.",
    };
  }

  // An action has to say why, and it has to name the detection behind it. Both are
  // refused rather than defaulted: a block with no note is unauditable, and an act
  // of prevention with no detection behind it is somebody's opinion.
  if (proposal.reason.trim() === "") {
    return {
      allow: false,
      code: "NO_REASON",
      reason: "An enforcement action needs a reason; the audit row is what somebody reads later.",
    };
  }
  if (proposal.alertId.trim() === "") {
    return {
      allow: false,
      code: "NO_DETECTION",
      reason:
        "An enforcement action has to answer a detection. Name the alert it responds to, or raise one.",
    };
  }

  const protectedOnes = protectedTargets(proposal.targets, policy);
  if (protectedOnes.length > 0) {
    return {
      allow: false,
      code: "PROTECTED_TARGET",
      reason:
        `Refused: ${protectedOnes.length} target${protectedOnes.length === 1 ? " is" : "s are"} on the ` +
        `safe-list. A protected target is not enforced against by anybody, an administrator included.`,
      targets: protectedOnes,
    };
  }

  const maxTargets = Math.max(1, Math.trunc(policy.maxTargets));
  if (proposal.targets.length > maxTargets) {
    return {
      allow: false,
      code: "BLAST_RADIUS",
      reason:
        `Refused: ${proposal.targets.length} targets against a cap of ${maxTargets}. ` +
        `This is not truncated — a smaller action than the one described is a different action.`,
      targets: proposal.targets,
    };
  }

  const allowedPerHour = Math.max(0, Math.trunc(policy.maxActionsPerHour));
  const used = actionsInLastHour(context.recentActionTimes, context.now);
  if (used >= allowedPerHour) {
    return {
      allow: false,
      code: "RATE_LIMITED",
      reason:
        `Refused: ${used} enforcement action${used === 1 ? "" : "s"} already applied in the last hour, ` +
        `against a limit of ${allowedPerHour}. A response that runs faster than a person can watch it is how an outage starts.`,
    };
  }

  if (proposal.permanent === true && !policy.allowPermanent) {
    return {
      allow: false,
      code: "PERMANENT_NOT_ALLOWED",
      reason:
        "Refused: this policy does not allow an action that stands until lifted by hand. " +
        "Reversible by default is the posture; ask for a permanent action only where a policy allows it.",
    };
  }

  // Authority last, because everything above is a reason to refuse an
  // administrator too. Prevention is an administrator's action; the policy decides
  // whether it needs a second one, and the approver must be a *different* person —
  // an approval from the requester is not a second pair of eyes.
  const requesterIsApprover = canApproveEnforcement(proposal.requestedBy.role);
  const approvals = context.approvals ?? [];
  const secondApprover = approvals.find(
    (approval) =>
      approval.identityId !== proposal.requestedBy.identityId &&
      canApproveEnforcement(approval.role),
  );

  let gate: EnforcementGate;
  let approvedBy: string | null = null;
  if (!requesterIsApprover) {
    gate = "APPROVAL_REQUIRED";
  } else if (policy.requireSecondApprover) {
    if (secondApprover === undefined) {
      gate = "APPROVAL_REQUIRED";
    } else {
      gate = "IMMEDIATE";
      approvedBy = secondApprover.identityId;
    }
  } else {
    gate = "IMMEDIATE";
    approvedBy = proposal.requestedBy.identityId;
  }

  const ttlSeconds = proposal.permanent === true ? 0 : Math.max(0, Math.trunc(policy.defaultTtlSeconds));
  const rollback = rollbackFor(proposal.action, proposal.targets, ttlSeconds, context.now);

  return {
    allow: true,
    gate,
    approvedBy,
    rollback,
    audit: {
      id: context.auditEventId,
      at: context.now,
      actor: proposal.requestedBy.identityId,
      action: auditActionFor(proposal.action),
      targetType: proposal.targets.map((target) => target.kind).join(","),
      targetId: proposal.targets.map((target) => target.value).join(","),
      detail: {
        alertId: proposal.alertId,
        reason: proposal.reason.trim(),
        targets: proposal.targets,
        policy,
        gate,
        approvedBy,
        rollback,
      },
    },
  };
}

/**
 * The inverse of an action that is already in force, as its own decision-shaped
 * audit intent.
 *
 * The reason a rollback is a first-class call rather than a delete: an action that
 * was applied has to be *lifted*, visibly, by somebody — and the lift is as
 * auditable as the block. Nothing here checks policy: lifting is always allowed,
 * because a rail that could stop you from undoing your own outage is the last
 * thing anybody needs.
 */
export function decideRollback(
  rollback: RollbackPlan,
  by: { identityId: string; label: string },
  context: { now: string; auditEventId: string },
): EnforcementAuditIntent {
  return {
    id: context.auditEventId,
    at: context.now,
    actor: by.identityId,
    action: "enforcement.lift",
    targetType: rollback.targets.map((target) => target.kind).join(","),
    targetId: rollback.targets.map((target) => target.value).join(","),
    detail: {
      alertId: "",
      reason: `Lifted by ${by.label}.`,
      targets: rollback.targets,
      policy: null,
      gate: "IMMEDIATE",
      approvedBy: by.identityId,
      rollback: { ...rollback },
    },
  };
}
