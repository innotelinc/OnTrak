/**
 * Prisma adapter (S4): the concrete side of the `EnforcementStore` port.
 *
 * The same shape as every other adapter in the family, and one thing here is worth reading
 * before the code: **nothing in this file pushes a block anywhere.** An `ACTIVE` row is the
 * local conclusion that a block is in force; the plane that actually filters packets is
 * somebody else's API, and keeping that seam out of the store is what lets the whole
 * enforcement path be tested without a firewall. `EnforcementTarget` — an address, an
 * identity or a device — is the whole contract a plane needs.
 *
 * The JSON columns are read defensively, as the alert store's evidence is: a row written by
 * an older build, or edited by hand, yields *no targets* or *the default policy* rather than
 * a crash in the middle of an incident. The one thing that is not repaired is the rollback:
 * a damaged inverse is reported as `null`, and `EnforcementService.lift` rebuilds it from the
 * action rather than refusing to undo something because its paperwork is untidy.
 */

import type {
  EnforcementActionRecord,
  EnforcementPolicyRecord,
  EnforcementStore,
  EnforcementState,
} from "./enforcement-service";
import type { IdentityRole } from "./identity-rules";
import { isUniqueViolation } from "./alert-store-prisma";
import {
  DEFAULT_ENFORCEMENT_POLICY,
  type EnforcementActionKind,
  type EnforcementPolicy,
  type EnforcementTarget,
  type RollbackPlan,
} from "./enforcement-rules";

/* -------------------------------------------------------------------------- */
/*  Row shape                                                                 */
/* -------------------------------------------------------------------------- */

export interface EnforcementActionRow {
  id: string;
  organizationId: string;
  action: string;
  state: string;
  targets: unknown;
  alertId: string;
  reason: string;
  requestedById: string;
  requestedByLabel: string;
  requestedByRole: string;
  approvedById: string | null;
  approvedByLabel: string | null;
  appliedAt: Date | null;
  expiresAt: Date | null;
  detectedAt: Date | null;
  timeToPreventMs: number | null;
  liftedAt: Date | null;
  liftedById: string | null;
  liftedByLabel: string | null;
  liftReason: string | null;
  refusedCode: string | null;
  refusedReason: string | null;
  rollback: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnforcementPolicyRow {
  organizationId: string;
  policy: unknown;
  updatedById: string | null;
  updatedAt: Date;
}

/* -------------------------------------------------------------------------- */
/*  Mappers (pure)                                                            */
/* -------------------------------------------------------------------------- */

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const ROLES: readonly string[] = ["ADMIN", "AGENT", "SERVICE", "AUDITOR"];

function roleOf(value: unknown): IdentityRole | null {
  return typeof value === "string" && ROLES.includes(value) ? (value as IdentityRole) : null;
}

const ACTIONS: readonly string[] = ["BLOCK", "QUARANTINE", "RATE_LIMIT"];
const STATES: readonly string[] = ["PENDING", "ACTIVE", "LIFTED", "REFUSED"];
const TARGET_KINDS: readonly string[] = ["ADDRESS", "IDENTITY", "DEVICE"];

/**
 * The targets a row holds, rebuilt entry by entry.
 *
 * Dropped rather than patched when they are not the shape this module wrote: an enforcement
 * action against a target nobody can parse is an action nobody can lift, and pretending
 * otherwise would put a broken address in front of an operator.
 */
export function enforcementTargetsOf(value: unknown): EnforcementTarget[] {
  if (!Array.isArray(value)) return [];
  const out: EnforcementTarget[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<EnforcementTarget>;
    if (typeof candidate.value !== "string" || candidate.value.trim() === "") continue;
    if (typeof candidate.kind !== "string" || !TARGET_KINDS.includes(candidate.kind)) continue;
    out.push({
      kind: candidate.kind as EnforcementTarget["kind"],
      value: candidate.value,
      ...(typeof candidate.label === "string" ? { label: candidate.label } : {}),
    });
  }
  return out;
}

export function rollbackOf(value: unknown): RollbackPlan | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RollbackPlan>;
  if (typeof candidate.kind !== "string" || (candidate.kind !== "LIFT" && candidate.kind !== "RELEASE")) {
    return null;
  }
  if (typeof candidate.action !== "string" || !ACTIONS.includes(candidate.action)) return null;
  const targets = enforcementTargetsOf(candidate.targets);
  if (targets.length === 0) return null;
  return {
    kind: candidate.kind,
    action: candidate.action as EnforcementActionKind,
    targets,
    at: typeof candidate.at === "string" ? candidate.at : null,
    label: typeof candidate.label === "string" ? candidate.label : "",
  };
}

/**
 * A stored policy, field by field, with the default filling anything missing.
 *
 * Read this way because a policy is the rails: a row from an older build is missing whatever
 * was added since, and the safe answer to a missing rail is the *cautious* one. Spreading the
 * stored object over the default means a new rail arrives at its cautious value on a
 * deployment that never set it, rather than at `undefined`.
 */
export function policyOf(value: unknown): EnforcementPolicy {
  if (!value || typeof value !== "object") return DEFAULT_ENFORCEMENT_POLICY;
  const stored = value as Partial<EnforcementPolicy>;
  return {
    protectedTargets: Array.isArray(stored.protectedTargets)
      ? stored.protectedTargets.filter((entry): entry is string => typeof entry === "string")
      : DEFAULT_ENFORCEMENT_POLICY.protectedTargets,
    maxTargets:
      typeof stored.maxTargets === "number" ? stored.maxTargets : DEFAULT_ENFORCEMENT_POLICY.maxTargets,
    maxActionsPerHour:
      typeof stored.maxActionsPerHour === "number"
        ? stored.maxActionsPerHour
        : DEFAULT_ENFORCEMENT_POLICY.maxActionsPerHour,
    defaultTtlSeconds:
      typeof stored.defaultTtlSeconds === "number"
        ? stored.defaultTtlSeconds
        : DEFAULT_ENFORCEMENT_POLICY.defaultTtlSeconds,
    allowPermanent:
      typeof stored.allowPermanent === "boolean"
        ? stored.allowPermanent
        : DEFAULT_ENFORCEMENT_POLICY.allowPermanent,
    requireSecondApprover:
      typeof stored.requireSecondApprover === "boolean"
        ? stored.requireSecondApprover
        : DEFAULT_ENFORCEMENT_POLICY.requireSecondApprover,
  };
}

export function toEnforcementAction(row: EnforcementActionRow): EnforcementActionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    // An action kind this build does not know is reported as `BLOCK`, which is the one whose
    // inverse is the *most* lifting rather than the least — an unknown action must not become
    // an un-liftable one.
    action: (ACTIONS.includes(row.action) ? row.action : "BLOCK") as EnforcementActionKind,
    state: (STATES.includes(row.state) ? row.state : "REFUSED") as EnforcementState,
    targets: enforcementTargetsOf(row.targets),
    alertId: row.alertId,
    reason: row.reason,
    requestedById: row.requestedById,
    requestedByLabel: row.requestedByLabel,
    // An unknown role is read as the least privileged one — the store's job is not to
    // promote anybody because a column is missing.
    requestedByRole: (roleOf(row.requestedByRole) ?? "SERVICE") as IdentityRole,
    approvedById: row.approvedById ?? null,
    approvedByLabel: row.approvedByLabel ?? null,
    appliedAt: toIso(row.appliedAt),
    expiresAt: toIso(row.expiresAt),
    detectedAt: toIso(row.detectedAt),
    timeToPreventMs: row.timeToPreventMs ?? null,
    liftedAt: toIso(row.liftedAt),
    liftedById: row.liftedById ?? null,
    liftedByLabel: row.liftedByLabel ?? null,
    liftReason: row.liftReason ?? null,
    refusedCode: row.refusedCode ?? null,
    refusedReason: row.refusedReason ?? null,
    rollback: rollbackOf(row.rollback),
    createdAt: toIso(row.createdAt) ?? "",
    updatedAt: toIso(row.updatedAt) ?? "",
  };
}

export function toEnforcementActionRow(record: EnforcementActionRecord) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    action: record.action,
    state: record.state,
    targets: record.targets,
    alertId: record.alertId,
    reason: record.reason,
    requestedById: record.requestedById,
    requestedByLabel: record.requestedByLabel,
    requestedByRole: record.requestedByRole,
    approvedById: record.approvedById,
    approvedByLabel: record.approvedByLabel,
    appliedAt: record.appliedAt === null ? null : new Date(record.appliedAt),
    expiresAt: record.expiresAt === null ? null : new Date(record.expiresAt),
    detectedAt: record.detectedAt === null ? null : new Date(record.detectedAt),
    timeToPreventMs: record.timeToPreventMs,
    liftedAt: record.liftedAt === null ? null : new Date(record.liftedAt),
    liftedById: record.liftedById,
    liftedByLabel: record.liftedByLabel,
    liftReason: record.liftReason,
    refusedCode: record.refusedCode,
    refusedReason: record.refusedReason,
    rollback: record.rollback,
    updatedAt: new Date(record.updatedAt),
  };
}

export function toEnforcementPolicyRecord(row: EnforcementPolicyRow): EnforcementPolicyRecord {
  return {
    organizationId: row.organizationId,
    policy: policyOf(row.policy),
    updatedById: row.updatedById ?? null,
    updatedAt: toIso(row.updatedAt) ?? "",
  };
}

/* -------------------------------------------------------------------------- */
/*  The structural Prisma surface                                             */
/* -------------------------------------------------------------------------- */

/**
 * The delegates this store uses, declared structurally.
 *
 * The same choice the alert store makes, for the same reason: this file needs four methods,
 * not a generated client, and a store that names only what it uses cannot be broken by a
 * schema change somewhere else.
 */
export interface EnforcementPrismaClient {
  enforcementAction: {
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
    findFirst(args: unknown): Promise<EnforcementActionRow | null>;
    findMany(args: unknown): Promise<EnforcementActionRow[]>;
  };
  enforcementPolicy: {
    findUnique(args: unknown): Promise<EnforcementPolicyRow | null>;
    upsert(args: { where: unknown; create: unknown; update: unknown }): Promise<unknown>;
  };
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

export class PrismaEnforcementStore implements EnforcementStore {
  constructor(private readonly db: EnforcementPrismaClient) {}

  /**
   * Write the row, whichever half of its life it is in.
   *
   * Insert first, and treat the unique violation as the ordinary case rather than the
   * exception — the same posture as the alert store, for the same reason: the id is chosen by
   * the service, so "this already exists" is a fact about the state machine, not a fault. The
   * update is *not* attempted first, because an update on a row that does not exist reports
   * success by doing nothing, and an enforcement action silently not being written is the
   * one failure this store must never have.
   */
  async saveAction(record: EnforcementActionRecord): Promise<void> {
    try {
      await this.db.enforcementAction.create({ data: toEnforcementActionRow(record) });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await this.db.enforcementAction.update({
        where: { id: record.id },
        data: toEnforcementActionRow(record),
      });
    }
  }

  async findAction(organizationId: string, actionId: string): Promise<EnforcementActionRecord | null> {
    const row = await this.db.enforcementAction.findFirst({
      where: { organizationId, id: actionId },
    });
    return row ? toEnforcementAction(row) : null;
  }

  async listActions(organizationId: string): Promise<EnforcementActionRecord[]> {
    const rows = await this.db.enforcementAction.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toEnforcementAction);
  }

  /**
   * When actions were applied, at or after a time.
   *
   * Selects one column rather than the rows: the rate limit wants times, and a store that
   * read every action's targets and reasons back to answer a question about an hour is a
   * store that gets slower the more it is used — which is exactly when the rail matters.
   */
  async recentAppliedAt(organizationId: string, sinceIso: string): Promise<string[]> {
    const rows = await this.db.enforcementAction.findMany({
      where: { organizationId, appliedAt: { gte: new Date(sinceIso) } },
      select: { appliedAt: true },
    });
    return rows
      .map((row) => toIso(row.appliedAt))
      .filter((at): at is string => typeof at === "string");
  }

  /**
   * Every organization's actions in force whose own deadline has passed.
   *
   * The `state` filter is part of the query rather than a filter here, because the sweep
   * runs on a timer over the whole deployment and reading back every action that has ever
   * been lifted to discard it is a query that grows without bound. A permanent action has a
   * null deadline and the `lte` comparison never matches it.
   */
  async expiringBefore(atIso: string): Promise<EnforcementActionRecord[]> {
    const rows = await this.db.enforcementAction.findMany({
      where: { state: "ACTIVE", expiresAt: { not: null, lte: new Date(atIso) } },
    });
    return rows.map(toEnforcementAction);
  }

  async getPolicy(organizationId: string): Promise<EnforcementPolicyRecord | null> {
    const row = await this.db.enforcementPolicy.findUnique({ where: { organizationId } });
    return row ? toEnforcementPolicyRecord(row) : null;
  }

  async savePolicy(record: EnforcementPolicyRecord): Promise<void> {
    const data = {
      policy: record.policy,
      updatedById: record.updatedById,
    };
    await this.db.enforcementPolicy.upsert({
      where: { organizationId: record.organizationId },
      create: { organizationId: record.organizationId, ...data },
      update: data,
    });
  }
}
