/**
 * Identity service (M2): persist the IdP connection and apply its decisions.
 *
 * `identity-rules.ts` decides what claims *mean*; this service decides what to
 * persist and what to record. Three flows share the same rules:
 *
 *  - **configure** — an administrator stores the tenant's connection, validated
 *    first and audited always.
 *  - **sign in** — claims are authorized, mapped to a role, and resolved to a
 *    user (created on first sign-in, updated on every one). Every attempt is
 *    audited, refused ones included: a denied sign-in is exactly the event an
 *    investigation needs.
 *  - **SCIM** — an IdP push is planned into one create/update/deactivate and
 *    applied, so provisioning and deprovisioning land in the same user record
 *    the rest of the app already trusts.
 *
 * The store and audit sink are injected, so the app shares the ticket stack's
 * per-tenant hash chain and the tests use fakes.
 */

import { randomUUID } from "node:crypto";

import { hasPermission, type Actor, type Role } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  authorizeSignIn,
  planScimProvision,
  validateIdentityConnection,
  type IdentityClaims,
  type IdentityConnection,
  type IdentityConnectionInput,
  type ScimPlan,
  type ScimUser,
  type ScimTargetUser,
} from "./identity-rules";
import type { ServiceResult } from "./ticket-service";

/** The user fields the identity flows read and write. */
export interface IdentityUser {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: Role;
  active: boolean;
  externalId: string | null;
}

export interface IdentityStore {
  findConnection(tenantId: string): Promise<IdentityConnection | null>;
  saveConnection(connection: IdentityConnection): Promise<void>;
  findUserByEmail(tenantId: string, email: string): Promise<IdentityUser | null>;
  findUserByExternalId(tenantId: string, externalId: string): Promise<IdentityUser | null>;
  createUser(user: IdentityUser): Promise<void>;
  updateUser(user: IdentityUser): Promise<void>;
}

export interface IdentityIds {
  id(): string;
  now(): string;
}

export function systemIdentityIds(): IdentityIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

export interface SignInResult {
  user: IdentityUser;
  actor: Actor;
  /** True when this sign-in created the user from the IdP's claims. */
  provisioned: boolean;
}

export interface ScimResult {
  plan: ScimPlan;
  user: IdentityUser | null;
}

export class IdentityService {
  constructor(
    private readonly store: IdentityStore,
    private readonly audit: AuditSink | null = null,
    private readonly ids: IdentityIds = systemIdentityIds(),
  ) {}

  /** Store the tenant's IdP connection. Administrator-only. */
  async configure(actor: Actor, input: IdentityConnectionInput): Promise<ServiceResult<IdentityConnection>> {
    if (!hasPermission(actor.role, "tenant:manage")) {
      return { ok: false, error: "You cannot configure identity for this tenant." };
    }
    const issues = validateIdentityConnection(input);
    if (issues.length > 0) return { ok: false, error: issues[0] };

    const existing = await this.store.findConnection(actor.tenantId);
    const now = this.ids.now();
    const connection: IdentityConnection = {
      ...input,
      id: existing?.id ?? this.ids.id(),
      tenantId: actor.tenantId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.store.saveConnection(connection);
    if (this.audit) await this.audit.append(connectionAudit(connection, actor.id));
    return { ok: true, value: connection };
  }

  async connectionFor(tenantId: string): Promise<IdentityConnection | null> {
    return this.store.findConnection(tenantId);
  }

  /**
   * Resolve a set of IdP claims to a user and an actor. Refusals are audited and
   * returned as errors; a first sign-in provisions the user.
   */
  async signIn(tenantId: string, claims: IdentityClaims): Promise<ServiceResult<SignInResult>> {
    const connection = await this.store.findConnection(tenantId);
    if (!connection) return { ok: false, error: "This tenant has no identity provider configured." };

    const authorization = authorizeSignIn(connection, claims);
    if (!authorization.ok) {
      if (this.audit) await this.audit.append(signInDeniedAudit(tenantId, claims, authorization.reason, this.ids.now()));
      return { ok: false, error: authorization.reason };
    }

    const subject = claims.subject.trim();
    const existing =
      (subject ? await this.store.findUserByExternalId(tenantId, subject) : null) ??
      (await this.store.findUserByEmail(tenantId, authorization.email));

    const now = this.ids.now();
    let user: IdentityUser;
    let provisioned = false;
    if (!existing) {
      user = {
        id: this.ids.id(),
        tenantId,
        email: authorization.email,
        displayName: (claims.name ?? authorization.email).trim() || authorization.email,
        role: authorization.role,
        active: true,
        externalId: subject || null,
      };
      await this.store.createUser(user);
      provisioned = true;
    } else {
      const roleChanged = existing.role !== authorization.role;
      user = {
        ...existing,
        email: authorization.email,
        displayName: (claims.name ?? existing.displayName).trim() || existing.displayName,
        role: authorization.role,
        active: true,
        externalId: subject || existing.externalId,
      };
      await this.store.updateUser(user);
      if (roleChanged && this.audit) {
        await this.audit.append(roleChangeAudit(user, existing.role, authorization.role, now));
      }
    }

    if (this.audit) {
      await this.audit.append(
        signInAudit(tenantId, user, { subject, mapped: authorization.mapped, provisioned, at: now }),
      );
    }

    return { ok: true, value: { user, actor: { id: user.id, tenantId, role: user.role }, provisioned } };
  }

  /** Apply a SCIM push: one create, update or deactivate, planned by the rules. */
  async provision(tenantId: string, incoming: ScimUser): Promise<ServiceResult<ScimResult>> {
    const connection = await this.store.findConnection(tenantId);
    if (!connection) return { ok: false, error: "This tenant has no identity provider configured." };
    if (!connection.scimEnabled) return { ok: false, error: "SCIM provisioning is not enabled for this tenant." };

    const existing =
      (await this.store.findUserByExternalId(tenantId, incoming.externalId)) ??
      (await this.store.findUserByEmail(tenantId, incoming.userName.trim().toLowerCase()));
    const plan = planScimProvision(connection, incoming, existing ? toScimTarget(existing) : null);

    if (plan.action === "NOOP") return { ok: true, value: { plan, user: existing } };

    const now = this.ids.now();
    let user: IdentityUser;
    if (plan.action === "CREATE") {
      user = {
        id: this.ids.id(),
        tenantId,
        email: plan.email,
        displayName: plan.displayName,
        role: plan.role,
        active: true,
        externalId: plan.externalId,
      };
      await this.store.createUser(user);
    } else {
      // UPDATE and DEACTIVATE only ever touch a user we already hold.
      user = {
        ...(existing as IdentityUser),
        email: plan.email,
        displayName: plan.displayName,
        role: plan.role,
        active: plan.active,
        externalId: plan.externalId,
      };
      await this.store.updateUser(user);
    }

    if (this.audit) await this.audit.append(scimAudit(tenantId, plan, user, now));
    return { ok: true, value: { plan, user } };
  }
}

function toScimTarget(user: IdentityUser): ScimTargetUser {
  return {
    id: user.id,
    externalId: user.externalId,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    active: user.active,
  };
}

/* -------------------------------------------------------------------------- */
/*  Audit                                                                     */
/* -------------------------------------------------------------------------- */

export function connectionAudit(connection: IdentityConnection, by: string): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId: connection.tenantId,
    at: connection.updatedAt,
    actor: by,
    action: "identity.connection.configure",
    targetType: "identity-connection",
    targetId: connection.id,
    detail: {
      protocol: connection.protocol,
      issuer: connection.issuer,
      defaultRole: connection.defaultRole,
      mfaRequired: connection.mfaRequired,
      scimEnabled: connection.scimEnabled,
      mappings: connection.roleMappings.length,
    },
  };
}

export function signInAudit(
  tenantId: string,
  user: IdentityUser,
  detail: { subject: string; mapped: boolean; provisioned: boolean; at: string },
): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId,
    at: detail.at,
    actor: user.id,
    action: "identity.signin",
    targetType: "user",
    targetId: user.id,
    detail: { subject: detail.subject, role: user.role, mapped: detail.mapped, provisioned: detail.provisioned },
  };
}

export function signInDeniedAudit(tenantId: string, claims: IdentityClaims, reason: string, at: string): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId,
    at,
    actor: "system:identity",
    action: "identity.signin.denied",
    targetType: "identity-connection",
    targetId: claims.issuer,
    // Never log the address wholesale; the reason is the point.
    detail: { reason, subject: claims.subject },
  };
}

export function roleChangeAudit(user: IdentityUser, from: Role, to: Role, at: string): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId: user.tenantId,
    at,
    actor: "system:identity",
    action: "identity.role.change",
    targetType: "user",
    targetId: user.id,
    detail: { from, to },
  };
}

export function scimAudit(tenantId: string, plan: ScimPlan, user: IdentityUser, at: string): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId,
    at,
    actor: "system:scim",
    action: plan.action === "DEACTIVATE" ? "identity.scim.deprovision" : "identity.scim.provision",
    targetType: "user",
    targetId: user.id,
    detail: { action: plan.action, email: plan.email, role: plan.role, externalId: plan.externalId, reason: plan.reason },
  };
}

/* -------------------------------------------------------------------------- */
/*  In-memory store (tests and local work)                                    */
/* -------------------------------------------------------------------------- */

export class MemoryIdentityStore implements IdentityStore {
  private readonly connections = new Map<string, IdentityConnection>();
  private readonly users = new Map<string, IdentityUser>();

  async findConnection(tenantId: string): Promise<IdentityConnection | null> {
    const found = this.connections.get(tenantId);
    return found ? structuredClone(found) : null;
  }

  async saveConnection(connection: IdentityConnection): Promise<void> {
    this.connections.set(connection.tenantId, structuredClone(connection));
  }

  async findUserByEmail(tenantId: string, email: string): Promise<IdentityUser | null> {
    const normalized = email.trim().toLowerCase();
    for (const user of this.users.values()) {
      if (user.tenantId === tenantId && user.email.toLowerCase() === normalized) return structuredClone(user);
    }
    return null;
  }

  async findUserByExternalId(tenantId: string, externalId: string): Promise<IdentityUser | null> {
    for (const user of this.users.values()) {
      if (user.tenantId === tenantId && user.externalId === externalId) return structuredClone(user);
    }
    return null;
  }

  async createUser(user: IdentityUser): Promise<void> {
    this.users.set(user.id, structuredClone(user));
  }

  async updateUser(user: IdentityUser): Promise<void> {
    this.users.set(user.id, structuredClone(user));
  }

  /** Test helper: the users currently provisioned for a tenant. */
  all(tenantId: string): IdentityUser[] {
    return [...this.users.values()].filter((user) => user.tenantId === tenantId).map((user) => structuredClone(user));
  }
}
