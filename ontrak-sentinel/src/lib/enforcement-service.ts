/**
 * The enforcement path (S4): propose, approve, apply, expire, lift — on the rails
 * `enforcement-rules.ts` already decides.
 *
 * The rules module answers *may this be done, by whom, and what is its inverse*. This
 * module is the part that does it, and the three decisions worth reading before the code
 * are about what an enforcement action **is** once it exists.
 *
 *   * **An action is a record with a life, not a call.** Prevention is state that outlives
 *     the request that created it — a block stands until something lifts it — so it is
 *     stored and read back, with four states rather than a success/failure: `PENDING`
 *     (proposed, waiting for the second administrator), `ACTIVE` (in force), `LIFTED`
 *     (undone, by hand or by its own TTL) and `REFUSED` (a rule said no, recorded because a
 *     refused attempt is evidence too). A service that only returned a value would make
 *     "what is blocked right now" unanswerable, which is the first question in an incident.
 *   * **The decision is never re-made by guesswork.** `apply` and `approve` both call
 *     `decideEnforcement` with the policy, the approvals and the recent action times as they
 *     are *at that moment*. That is what makes a policy tightened between the proposal and
 *     the approval take effect, and what keeps the safe-list from being something an old
 *     proposal was grandfathered past.
 *   * **The TTL is real.** `expire` lifts whatever its own deadline has reached, so
 *     "reversible by default" is a mechanism and not a promise: an operator who is asleep
 *     does not have to be the one who undoes it. Nothing here schedules that call — it is
 *     the deployment's clock that does, as the audit sweep already is (`scheduler`).
 *
 * What this module does **not** do is touch the network itself. A block that is `ACTIVE`
 * here is a record that says a block is in force; pushing it to a firewall, agent or proxy
 * is the *enforcement plane* (`enforcement-plane.ts`), which this service is given rather
 * than builds. The seam is `EnforcementTarget` — an address, an identity or a device — and
 * the plane is told the record, so its own log can be joined back to the decision.
 *
 * The plane is **optional and never fatal**: with none configured nothing changes, and a
 * plane that refuses or cannot be reached leaves the action `ACTIVE` with an
 * `enforcement.plane.failed` row on the chain. The action is what was decided and
 * approved; a plane that did not answer is a fact about the plane, not a reason for the
 * approval to evaporate. Told on the way in *and* on the way out, from the record's own
 * stored rollback plan, so a TTL is not a promise made on paper only.
 */

import { randomUUID } from "node:crypto";

import {
  decideEnforcement,
  decideRollback,
  auditActionFor,
  timeToPreventMs,
  DEFAULT_ENFORCEMENT_POLICY,
  type EnforcementActionKind,
  type EnforcementApproval,
  type EnforcementPolicy,
  type EnforcementProposal,
  type EnforcementTarget,
  type RollbackPlan,
} from "./enforcement-rules";
import type { AuditSink } from "./audit-chain";
import type { EnforcementPlane, PlaneOutcome } from "./enforcement-plane";
import type { IdentityRole } from "./identity-rules";
import type { ServiceResult } from "./identity-service";

/* -------------------------------------------------------------------------- */
/*  The records                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Where an action is in its life.
 *
 * `REFUSED` is a state rather than an error because a refused attempt is evidence: it says
 * somebody asked for a block and a rail stopped it, which is exactly what an incident
 * review wants to read.
 */
export type EnforcementState = "PENDING" | "ACTIVE" | "LIFTED" | "REFUSED";

export interface EnforcementActionRecord {
  id: string;
  organizationId: string;
  action: EnforcementActionKind;
  state: EnforcementState;
  targets: EnforcementTarget[];
  /** The detection this answers. */
  alertId: string;
  reason: string;
  requestedById: string;
  requestedByLabel: string;
  /**
   * The role the requester held *when they asked*.
   *
   * Stored rather than re-derived at approval time because the approval re-decides the whole
   * request: whether prevention was the requester's to take is part of that decision, and a
   * role read from today's directory would answer a different question from the one the
   * proposal was made under.
   */
  requestedByRole: IdentityRole;
  /** The second administrator, once there is one. */
  approvedById: string | null;
  approvedByLabel: string | null;
  /** Set when the action is applied. */
  appliedAt: string | null;
  /** When it lifts itself, or null when it stands until lifted by hand. */
  expiresAt: string | null;
  /**
   * When the detection this answers was first seen, carried from the alert at proposal time.
   *
   * Stored on the action rather than joined from the alert when the figure is read, for the
   * same reason the evidence and the rollback are: an alert is closed, and a queue is read
   * with the window an operator is looking at. Time-to-prevent is a fact about *this* action,
   * and it has to survive the alert leaving the queue that produced it.
   */
  detectedAt: string | null;
  /**
   * How long prevention took — `appliedAt − detectedAt` — or `null` when it was not measured.
   *
   * Set at the moment the action goes `ACTIVE`, not at proposal: a waiting proposal has not
   * prevented anything yet, and a time recorded then would count a decision nobody had made.
   */
  timeToPreventMs: number | null;
  /** Set when it is lifted, and by whom. */
  liftedAt: string | null;
  liftedById: string | null;
  liftedByLabel: string | null;
  liftReason: string | null;
  /** Why it was refused, when it was. */
  refusedCode: string | null;
  refusedReason: string | null;
  /** The inverse, computed when the decision was made and stored with it. */
  rollback: RollbackPlan | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnforcementPolicyRecord {
  organizationId: string;
  policy: EnforcementPolicy;
  updatedById: string | null;
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/*  The port                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the service needs from storage, and nothing else.
 *
 * `recentAppliedAt` is on the port rather than a count because the rate limit is a *window*
 * (`actionsInLastHour`), and a store that kept a counter could not answer a question about
 * time. The service asks for the times and does the arithmetic, so the rule stays in one
 * place and a database that loses an hour of history cannot silently reset a limit.
 */
export interface EnforcementStore {
  saveAction(record: EnforcementActionRecord): Promise<void>;
  findAction(organizationId: string, actionId: string): Promise<EnforcementActionRecord | null>;
  listActions(organizationId: string): Promise<EnforcementActionRecord[]>;
  /** When actions for this organization were applied at or after `sinceIso`. */
  recentAppliedAt(organizationId: string, sinceIso: string): Promise<string[]>;
  /**
   * Every organization's actions still in force whose own deadline is at or before `atIso`.
   *
   * Deployment-wide rather than per-organization, which is what lets the timer be wired
   * without a list of the deployment's tenants. Only `ACTIVE` records with a deadline are
   * answered — a permanent action has nothing to expire.
   */
  expiringBefore(atIso: string): Promise<EnforcementActionRecord[]>;
  getPolicy(organizationId: string): Promise<EnforcementPolicyRecord | null>;
  savePolicy(record: EnforcementPolicyRecord): Promise<void>;
}

export interface EnforcementIds {
  id(): string;
  now(): string;
}

export function systemEnforcementIds(): EnforcementIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What `apply` was asked to do and what came of it.
 *
 * `gate` is reported rather than inferred from `state`, because the two answer different
 * questions: the state is where the action is, and the gate is *why* — a caller that has to
 * decide whether to prompt somebody needs to know it was the second-approver rule and not,
 * say, a refusal it should surface as an error.
 */
export interface AppliedEnforcement {
  action: EnforcementActionRecord;
  gate: "IMMEDIATE" | "APPROVAL_REQUIRED";
  /** The audit row that was written, so a caller can point at it. */
  auditEventId: string;
  /**
   * What the enforcement plane answered, or `null` when no plane is configured.
   *
   * Reported rather than swallowed, because "the block is approved" and "the block
   * reached something that can drop a packet" are different claims and an operator
   * is entitled to know which one is true. A refusal here does not undo the action;
   * it is on the chain as `enforcement.plane.failed` and the record stays `ACTIVE`.
   */
  plane: PlaneOutcome | null;
}

export class EnforcementService {
  constructor(
    private readonly store: EnforcementStore,
    private readonly audit: AuditSink | null = null,
    private readonly ids: EnforcementIds = systemEnforcementIds(),
    /**
     * Where an `ACTIVE` action is pushed, or `null` for a deployment with no plane —
     * which is every deployment until one is configured, and behaves exactly as it did
     * before this parameter existed.
     */
    private readonly plane: EnforcementPlane | null = null,
  ) {}

  /* ---------------------------------------------------------------- policy - */

  /** The policy in force for an organization, or the cautious default. */
  async policy(organizationId: string): Promise<EnforcementPolicy> {
    const stored = await this.store.getPolicy(organizationId);
    return stored ? stored.policy : DEFAULT_ENFORCEMENT_POLICY;
  }

  /**
   * The stored policy row, or `null` when nobody has written one.
   *
   * Separate from `policy` because the console shows the two differently: the *effective*
   * policy is what a proposal will be judged by, and whether it is a decision this
   * organization recorded or the built-in default is a different fact about it.
   */
  policyRecord(organizationId: string): Promise<EnforcementPolicyRecord | null> {
    return this.store.getPolicy(organizationId);
  }

  /**
   * Store a policy.
   *
   * Stored whole rather than field by field, because a policy is what the rails are judged
   * against and a half-applied one would be a set of rails nobody can reason about. The
   * change is audited with the whole object, so "what were the rails when this block was
   * applied" has an answer that does not depend on reading today's settings.
   */
  async setPolicy(
    organizationId: string,
    policy: EnforcementPolicy,
    by: { identityId: string; label: string },
  ): Promise<ServiceResult<EnforcementPolicy>> {
    const invalid = validatePolicy(policy);
    if (invalid) return { ok: false, error: invalid };

    const at = this.ids.now();
    await this.store.savePolicy({
      organizationId,
      policy,
      updatedById: by.identityId,
      updatedAt: at,
    });

    await this.append({
      id: this.ids.id(),
      at,
      actor: by.identityId,
      action: "enforcement.policy",
      targetType: "Organization",
      targetId: organizationId,
      // The organization is named in the detail because that is where the chain sink reads
      // it from: a policy change is on the organization's chain, and a sink that cannot
      // place an event refuses to append it at all.
      detail: { organizationId, policy, by: by.label },
    });

    return { ok: true, value: policy };
  }

  /* ----------------------------------------------------------------- apply - */

  /**
   * Propose an action and apply it if the rails allow it now.
   *
   * Refusals are audited and not stored as actions: a refused action never existed, and a
   * `REFUSED` row is only written when a *proposal* was recorded and then refused — which
   * is the `approve` path, where an action somebody already asked for is turned down.
   */
  async apply(input: {
    organizationId: string;
    proposal: EnforcementProposal;
    /** Approvals already on record for this proposal. */
    approvals?: EnforcementApproval[];
    /**
     * When the alert behind this was first seen, so a measured time-to-prevent can be taken.
     *
     * Supplied by the caller because the alert is the caller's to read — the console already
     * holds the queue it chose from — and optional so a proposal made without a detection
     * instant is recorded with no measurement rather than a fabricated one.
     */
    detectedAt?: string | null;
  }): Promise<ServiceResult<AppliedEnforcement>> {
    const at = this.ids.now();
    const policy = await this.policy(input.organizationId);
    const view = await this.railsView(input.organizationId, at);

    // The audit id is chosen here and passed in, so the row the decision describes and the
    // row that gets written are the same row — a retried request appends one, not two.
    const auditEventId = this.ids.id();
    const decision = decideEnforcement(input.proposal, policy, {
      now: at,
      recentActionTimes: view,
      ...(input.approvals === undefined ? {} : { approvals: input.approvals }),
      auditEventId,
    });

    if (!decision.allow) {
      await this.append({
        id: auditEventId,
        at,
        actor: input.proposal.requestedBy.identityId,
        action: "enforcement.refused",
        targetType: "Enforcement",
        targetId: input.proposal.alertId,
        detail: {
          organizationId: input.organizationId,
          code: decision.code,
          reason: decision.reason,
          action: input.proposal.action,
          targets: decision.targets ?? input.proposal.targets,
          alertId: input.proposal.alertId,
        },
      });
      return { ok: false, error: decision.reason };
    }

    const gate = decision.gate;
    const record: EnforcementActionRecord = {
      id: this.ids.id(),
      organizationId: input.organizationId,
      action: input.proposal.action,
      state: gate === "IMMEDIATE" ? "ACTIVE" : "PENDING",
      targets: input.proposal.targets,
      alertId: input.proposal.alertId,
      reason: input.proposal.reason.trim(),
      requestedById: input.proposal.requestedBy.identityId,
      requestedByLabel: input.proposal.requestedBy.label,
      requestedByRole: input.proposal.requestedBy.role,
      approvedById: decision.approvedBy,
      approvedByLabel: null,
      appliedAt: gate === "IMMEDIATE" ? at : null,
      expiresAt: decision.rollback.at,
      detectedAt: input.detectedAt ?? null,
      // Measured only if this action is in force now: a `PENDING` proposal has prevented
      // nothing, and its interval is taken when the approval applies it.
      timeToPreventMs:
        gate === "IMMEDIATE" ? timeToPreventMs(input.detectedAt ?? null, at) : null,
      liftedAt: null,
      liftedById: null,
      liftedByLabel: null,
      liftReason: null,
      refusedCode: null,
      refusedReason: null,
      rollback: decision.rollback,
      createdAt: at,
      updatedAt: at,
    };

    await this.store.saveAction(record);

    // The decision's own intent is the audit row — the same object the rules module built,
    // so the chain cannot describe something other than what was decided.
    let plane: PlaneOutcome | null = null;
    if (gate === "IMMEDIATE") {
      await this.append({
        ...decision.audit,
        detail: { ...decision.audit.detail, organizationId: input.organizationId },
      });
      // Told only once the action is `ACTIVE` and on the chain: a plane is never asked to
      // enforce something the record does not yet say is in force.
      plane = await this.pushToPlane(
        "apply",
        record,
        record.approvedById ?? record.requestedById,
      );
    } else {
      await this.append({
        id: auditEventId,
        at,
        actor: input.proposal.requestedBy.identityId,
        action: "enforcement.proposed",
        targetType: "Enforcement",
        targetId: record.id,
        detail: {
          action: record.action,
          targets: record.targets,
          alertId: record.alertId,
          reason: record.reason,
          organizationId: input.organizationId,
        },
      });
    }

    return { ok: true, value: { action: record, gate, auditEventId, plane } };
  }

  /**
   * Record a second administrator's approval, and apply the action if that was the last
   * thing it needed.
   *
   * The decision is re-made rather than assumed: the policy may have been tightened while
   * the proposal waited, and the safe-list check runs again with today's list. An action
   * that was refused this time is stored `REFUSED`, with the code and the reason, because
   * somebody asked for it and the answer is worth keeping.
   */
  async approve(input: {
    organizationId: string;
    actionId: string;
    approver: { identityId: string; label: string; role: EnforcementApproval["role"] };
  }): Promise<ServiceResult<AppliedEnforcement>> {
    const at = this.ids.now();
    const record = await this.store.findAction(input.organizationId, input.actionId);
    if (!record) return { ok: false, error: "No such enforcement action." };
    if (record.state !== "PENDING") {
      return { ok: false, error: `This action is ${record.state.toLowerCase()} and cannot be approved.` };
    }
    if (record.requestedById === input.approver.identityId) {
      return {
        ok: false,
        error: "The requester cannot approve their own action; ask a second administrator.",
      };
    }

    const policy = await this.policy(input.organizationId);
    const view = await this.railsView(input.organizationId, at);
    const auditEventId = this.ids.id();
    const decision = decideEnforcement(
      {
        action: record.action,
        targets: record.targets,
        alertId: record.alertId,
        reason: record.reason,
        requestedBy: {
          identityId: record.requestedById,
          label: record.requestedByLabel,
          // Their role as recorded when they asked — see `requestedByRole`.
          role: record.requestedByRole,
        },
        ...(record.expiresAt === null ? { permanent: true } : {}),
      },
      policy,
      {
        now: at,
        recentActionTimes: view,
        approvals: [
          { identityId: input.approver.identityId, role: input.approver.role, at },
        ],
        auditEventId,
      },
    );

    if (!decision.allow) {
      // Recorded rather than merely refused: somebody asked for this action and a rail said
      // no, and that is the sort of thing an incident review wants to be able to read.
      const refused: EnforcementActionRecord = {
        ...record,
        state: "REFUSED",
        refusedCode: decision.code,
        refusedReason: decision.reason,
        updatedAt: at,
      };
      await this.store.saveAction(refused);
      await this.append({
        id: auditEventId,
        at,
        actor: input.approver.identityId,
        action: "enforcement.refused",
        targetType: "Enforcement",
        targetId: record.id,
        detail: {
          code: decision.code,
          reason: decision.reason,
          action: record.action,
          targets: decision.targets ?? record.targets,
          alertId: record.alertId,
          organizationId: input.organizationId,
          approvalWithheldBy: input.approver.label,
        },
      });
      return { ok: false, error: decision.reason };
    }

    const applied: EnforcementActionRecord = {
      ...record,
      state: "ACTIVE",
      approvedById: input.approver.identityId,
      approvedByLabel: input.approver.label,
      appliedAt: at,
      expiresAt: decision.rollback.at,
      // The interval is measured here, against the detection instant the proposal carried, so
      // the time-to-prevent spans the wait for a second administrator. That wait is part of
      // how long prevention took, and it is the part a slow approval is responsible for.
      timeToPreventMs: timeToPreventMs(record.detectedAt, at),
      rollback: decision.rollback,
      updatedAt: at,
    };
    await this.store.saveAction(applied);
    await this.append({
      ...decision.audit,
      detail: {
        ...decision.audit.detail,
        organizationId: input.organizationId,
        approvedByLabel: input.approver.label,
        actionId: applied.id,
      },
    });
    // The waiting proposal becomes in force here, which is the moment the plane is told.
    const plane = await this.pushToPlane(
      "apply",
      applied,
      applied.approvedById ?? applied.requestedById,
    );

    return { ok: true, value: { action: applied, gate: "IMMEDIATE", auditEventId, plane } };
  }

  /* ------------------------------------------------------------- lift/expire */

  /**
   * Lift an action by hand.
   *
   * Not policy-checked, deliberately (see `decideRollback`): a rail that could stop you
   * undoing your own outage is the last thing an incident needs.
   */
  async lift(input: {
    organizationId: string;
    actionId: string;
    by: { identityId: string; label: string };
    reason?: string;
  }): Promise<ServiceResult<EnforcementActionRecord>> {
    const at = this.ids.now();
    const record = await this.store.findAction(input.organizationId, input.actionId);
    if (!record) return { ok: false, error: "No such enforcement action." };
    if (record.state !== "ACTIVE") {
      return { ok: false, error: `This action is ${record.state.toLowerCase()} and is not in force.` };
    }

    const auto = input.reason === undefined;
    const lifted: EnforcementActionRecord = {
      ...record,
      state: "LIFTED",
      liftedAt: at,
      liftedById: input.by.identityId,
      liftedByLabel: input.by.label,
      liftReason: input.reason ?? "Its own time limit was reached.",
      updatedAt: at,
    };
    await this.store.saveAction(lifted);

    // A record written before the rollback was stored still has to be liftable, so a missing
    // plan is rebuilt from the action rather than refused.
    const plan: RollbackPlan = record.rollback ?? {
      kind: record.action === "QUARANTINE" ? "RELEASE" : "LIFT",
      action: record.action,
      targets: record.targets,
      at: record.expiresAt,
      label: `lift this ${record.action.toLowerCase()}`,
    };
    const intent = decideRollback(plan, input.by, { now: at, auditEventId: this.ids.id() });
    await this.append({
      ...intent,
      // Say which action this undid: the lift is its own row, and a reader has to be able to
      // follow it back to the block it released.
      detail: { ...intent.detail, organizationId: input.organizationId, actionId: record.id, automatic: auto },
    });
    // Told from the *stored* plan, so a hand lift and the expiry sweep release exactly the
    // targets that were enforced against — not a recomputation that could differ.
    await this.pushToPlane("lift", lifted, input.by.identityId, plan);

    return { ok: true, value: lifted };
  }

  /**
   * Lift everything, in every organization, whose own deadline has passed.
   *
   * This is what the deployment's timer actually calls. `expire` is scoped to one
   * organization because that is the unit the rest of the service works in; this is the
   * deployment-wide sweep built on it, so wiring a timer does not require a list of tenants.
   * Idempotent for the same reason `expire` is — a sweep that runs twice, or runs late, lifts
   * each action exactly once and never writes a second lift row.
   */
  async sweepExpired(): Promise<{ lifted: string[] }> {
    const at = this.ids.now();
    const due = await this.store.expiringBefore(at);
    const lifted: string[] = [];
    for (const record of due) {
      const result = await this.lift({
        organizationId: record.organizationId,
        actionId: record.id,
        by: { identityId: "scheduler", label: "Sentinel scheduler" },
      });
      if (result.ok) lifted.push(record.id);
    }
    return { lifted };
  }

  /**
   * Lift everything in one organization whose own deadline has passed.
   *
   * Kept beside the deployment-wide sweep rather than replaced by it: a caller that already
   * has an organization (a test, an operator's script) should not have to sweep the whole
   * deployment to lift what it is looking at. Idempotent by construction: an action that is
   * already `LIFTED` is skipped, so a sweep that runs twice, or runs late, lifts each action
   * exactly once and never writes a second lift row.
   */
  async expire(organizationId: string): Promise<{ lifted: string[] }> {
    const at = this.ids.now();
    const atMs = Date.parse(at);
    const actions = await this.store.listActions(organizationId);
    const lifted: string[] = [];

    for (const record of actions) {
      if (record.state !== "ACTIVE" || record.expiresAt === null) continue;
      const deadline = Date.parse(record.expiresAt);
      if (!Number.isFinite(deadline) || deadline > atMs) continue;
      const result = await this.lift({
        organizationId,
        actionId: record.id,
        by: { identityId: "scheduler", label: "Sentinel scheduler" },
      });
      if (result.ok) lifted.push(record.id);
    }

    return { lifted };
  }

  /* ------------------------------------------------------------------ read - */

  list(organizationId: string): Promise<EnforcementActionRecord[]> {
    return this.store.listActions(organizationId);
  }

  /** What is in force right now — the first question in an incident. */
  async inForce(organizationId: string): Promise<EnforcementActionRecord[]> {
    const actions = await this.store.listActions(organizationId);
    return actions.filter((record) => record.state === "ACTIVE");
  }

  /* --------------------------------------------------------------- private - */

  /**
   * The times the rate limit is measured against.
   *
   * One hour back from now, so the store does the narrowing and the rule does the counting.
   */
  private async railsView(organizationId: string, at: string): Promise<string[]> {
    const since = new Date(Date.parse(at) - 60 * 60 * 1000).toISOString();
    return this.store.recentAppliedAt(organizationId, since);
  }

  private async append(input: Parameters<AuditSink["append"]>[0]): Promise<void> {
    if (!this.audit) return;
    await this.audit.append(input);
  }

  /**
   * Tell the enforcement plane, and put its answer on the chain.
   *
   * Never throws and never refuses the action. The block was decided and approved; a plane
   * that could not be told is recorded as `enforcement.plane.failed` and the record stays
   * `ACTIVE`, because a firewall being unreachable must not turn an operator's approval
   * into nothing. A plane whose implementation throws is held to the same answer as one
   * that refuses: the interface says it answers with an outcome, and a broken adapter does
   * not get to take the decision down with it.
   */
  private async pushToPlane(
    op: "apply" | "lift",
    record: EnforcementActionRecord,
    actor: string,
    plan?: RollbackPlan,
  ): Promise<PlaneOutcome | null> {
    if (this.plane === null) return null;

    let outcome: PlaneOutcome;
    try {
      outcome =
        op === "apply"
          ? await this.plane.apply(record)
          : await this.plane.lift(record, plan ?? fallbackRollback(record));
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : "the plane threw" };
    }

    await this.append({
      id: this.ids.id(),
      at: this.ids.now(),
      actor,
      action: outcome.ok ? `enforcement.plane.${op}` : "enforcement.plane.failed",
      targetType: "Enforcement",
      targetId: record.id,
      detail: {
        organizationId: record.organizationId,
        op,
        plane: this.plane.name,
        action: record.action,
        targets: record.targets,
        ...(outcome.ok ? { detail: outcome.detail } : { error: outcome.error }),
      },
    });
    return outcome;
  }
}

/** The inverse of a record with no stored plan — a record written before plans were stored. */
function fallbackRollback(record: EnforcementActionRecord): RollbackPlan {
  return {
    kind: record.action === "QUARANTINE" ? "RELEASE" : "LIFT",
    action: record.action,
    targets: record.targets,
    at: record.expiresAt,
    label: `lift this ${record.action.toLowerCase()}`,
  };
}

/**
 * Whether a policy is usable, or the sentence saying why not.
 *
 * Validated rather than trusted because every rail reads it: a negative cap would make
 * `maxTargets` mean nothing (the floor is applied in the rules module, but a stored policy
 * that says `-1` is a typo somebody should see), and a protected list with a malformed entry
 * is a safe-list with a hole in it.
 */
export function validatePolicy(policy: EnforcementPolicy): string | null {
  // A CIDR or an id. The value is checked for shape rather than parsed: an entry that is not
  // a CIDR is treated as an exact id by `isProtectedTarget`, so only blank entries are wrong.
  const blanks = policy.protectedTargets.filter((entry) => entry.trim() === "");
  if (blanks.length > 0) {
    return "A protected target cannot be blank; remove it or name the address or id.";
  }
  if (!Number.isInteger(policy.maxTargets) || policy.maxTargets < 1) {
    return "The blast-radius cap has to be a whole number of targets, at least one.";
  }
  if (!Number.isInteger(policy.maxActionsPerHour) || policy.maxActionsPerHour < 0) {
    return "The hourly limit has to be a whole number of actions; zero means none.";
  }
  if (!Number.isInteger(policy.defaultTtlSeconds) || policy.defaultTtlSeconds < 0) {
    return "The default lifetime has to be a whole number of seconds; zero means until lifted by hand.";
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  An in-memory store, used by tests and the memory-mode server              */
/* -------------------------------------------------------------------------- */

export class MemoryEnforcementStore implements EnforcementStore {
  private readonly actions = new Map<string, EnforcementActionRecord>();
  private readonly policies = new Map<string, EnforcementPolicyRecord>();

  async saveAction(record: EnforcementActionRecord): Promise<void> {
    this.actions.set(`${record.organizationId}:${record.id}`, { ...record });
  }

  async findAction(organizationId: string, actionId: string): Promise<EnforcementActionRecord | null> {
    return this.actions.get(`${organizationId}:${actionId}`) ?? null;
  }

  async listActions(organizationId: string): Promise<EnforcementActionRecord[]> {
    return [...this.actions.values()]
      .filter((record) => record.organizationId === organizationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async recentAppliedAt(organizationId: string, sinceIso: string): Promise<string[]> {
    const since = Date.parse(sinceIso);
    return [...this.actions.values()]
      .filter((record) => record.organizationId === organizationId && record.appliedAt !== null)
      .map((record) => record.appliedAt!)
      .filter((at) => Date.parse(at) >= since);
  }

  async expiringBefore(atIso: string): Promise<EnforcementActionRecord[]> {
    const at = Date.parse(atIso);
    return [...this.actions.values()].filter(
      (record) =>
        record.state === "ACTIVE" && record.expiresAt !== null && Date.parse(record.expiresAt) <= at,
    );
  }

  async getPolicy(organizationId: string): Promise<EnforcementPolicyRecord | null> {
    return this.policies.get(organizationId) ?? null;
  }

  async savePolicy(record: EnforcementPolicyRecord): Promise<void> {
    this.policies.set(record.organizationId, { ...record });
  }
}

/** Re-exported so a caller does not have to reach into the rules module for the default. */
export { DEFAULT_ENFORCEMENT_POLICY };
export type { EnforcementPolicy, EnforcementProposal, EnforcementTarget, RollbackPlan };
