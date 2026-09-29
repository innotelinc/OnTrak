/**
 * Identity service (S0): the spine everything else in Sentinel hangs off.
 *
 * S0's job is not features — it is the two things that are ruinous to add later.
 * The first is the **isolation boundary**: an organization is an MSP or one
 * internal IT department, every record carries the organization it belongs to,
 * and every read and write is scoped by it. The second is the **evidence log**:
 * every privileged action is appended to a hash-chained, per-organization record
 * from the very first write, so history cannot be quietly edited afterwards.
 *
 * Three decisions worth stating out loud:
 *
 *  - **One chain per organization.** The chain itself is org-agnostic (see
 *    `audit-chain.ts`), so isolation is achieved by keeping a separate chain for
 *    each organization rather than by filtering one big chain. A filter is a
 *    query somebody can forget; a separate chain is a different object.
 *  - **An organization cannot be left with no administrator.** Deactivating the
 *    last active admin is refused, because the alternative is a tenant nobody can
 *    administer and a support ticket to fix it.
 *  - **Sessions are policy-checked when they are issued *and* when they are
 *    read.** `sessionDecision` is pure and reused by both, so a session cannot
 *    become usable by being read through a different path.
 *
 * Verification of credentials is deliberately absent: it arrives with OIDC in S1.
 * `issueSession` is therefore the *policy* half of a login — MFA required, an
 * identity that is active — and it documents that the caller has already done the
 * half this milestone does not have.
 */

import { randomUUID } from "node:crypto";

import {
  appendAuditEvent,
  createAuditChain,
  verifyAuditChain,
  type AuditChain,
  type AuditEvent,
  type AuditEventInput,
  type AuditSink,
  type ChainVerification,
  type HashFn,
} from "./audit-chain";
import {
  canManageIdentities,
  canManagePolicies,
  canReadDirectory,
  identitySummary,
  isSameOrganization,
  policyForRole,
  sessionDecision,
  sessionExpiry,
  sessionInfo,
  validateIdentity,
  validateOrganization,
  validatePolicy,
  wouldStrandAdministration,
  type IdentityIssue,
  type IdentityKind,
  type IdentityPolicy,
  type IdentityRecord,
  type IdentityRole,
  type OrganizationRecord,
  type PolicyRecord,
  type PolicyScope,
  type SessionDecision,
  type SessionRecord,
} from "./identity-rules";

/* -------------------------------------------------------------------------- */
/*  The actor and the result shape                                            */
/* -------------------------------------------------------------------------- */

/** The authenticated caller, as resolved from a session. */
export interface IdentityActor {
  id: string;
  /** The organization the caller belongs to. Nothing crosses it, ever. */
  organizationId: string;
  role: IdentityRole;
}

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: string };

function firstIssue(issues: IdentityIssue[]): ServiceResult<never> | null {
  return issues.length > 0 ? { ok: false, error: issues[0].message } : null;
}

/* -------------------------------------------------------------------------- */
/*  The store port                                                            */
/* -------------------------------------------------------------------------- */

export interface IdentityStore {
  findOrganization(organizationId: string): Promise<OrganizationRecord | null>;
  findOrganizationBySlug(slug: string): Promise<OrganizationRecord | null>;
  insertOrganization(record: OrganizationRecord): Promise<void>;

  listIdentities(organizationId: string): Promise<IdentityRecord[]>;
  findIdentity(organizationId: string, identityId: string): Promise<IdentityRecord | null>;
  findIdentityByIdentifier(organizationId: string, identifier: string): Promise<IdentityRecord | null>;
  /** By the id the *source directory* uses — how SCIM recognises a rename as a move. */
  findIdentityByExternalId(organizationId: string, externalId: string): Promise<IdentityRecord | null>;
  insertIdentity(record: IdentityRecord): Promise<void>;
  updateIdentity(record: IdentityRecord): Promise<void>;

  /**
   * The organization's stored policies: its `ALL` baseline and any per-role
   * overrides. One read, because the pure rule picks between them.
   */
  listPolicies(organizationId: string): Promise<PolicyRecord[]>;
  upsertPolicy(record: PolicyRecord): Promise<void>;

  listSessions(organizationId: string, identityId?: string): Promise<SessionRecord[]>;
  findSession(organizationId: string, sessionId: string): Promise<SessionRecord | null>;
  /**
   * A session by its id alone, for the console.
   *
   * A browser holds one opaque cookie and cannot name the organization it belongs
   * to, so the organization is read back *from the row* rather than supplied. The
   * session id is the credential; everything else is looked up inside it.
   */
  findSessionByKey(sessionId: string): Promise<SessionRecord | null>;
  insertSession(record: SessionRecord): Promise<void>;
  updateSession(record: SessionRecord): Promise<void>;
}

export interface IdentityIds {
  id(): string;
  /** ISO-8601, server-authoritative. */
  now(): string;
  /** Epoch milliseconds, for the session clocks. */
  nowMs(): number;
}

export function systemIdentityIds(): IdentityIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString(), nowMs: () => Date.now() };
}

/* -------------------------------------------------------------------------- */
/*  One evidence log per organization                                         */
/* -------------------------------------------------------------------------- */

/**
 * What the service needs of an evidence log: append, read back, and verify.
 *
 * Reading and verifying are allowed to be asynchronous, and the service `await`s
 * them either way: the in-memory log answers immediately, while a durable one has
 * to read its rows first — and for a durable log that is the *point*, since the
 * question "is this history intact?" must be asked of what is stored rather than
 * of what this process happens to remember.
 */
export interface AuditTrail extends AuditSink {
  trail(organizationId: string): readonly AuditEvent[] | Promise<readonly AuditEvent[]>;
  verify(organizationId: string): ChainVerification | Promise<ChainVerification>;
}

/**
 * A hash-chained log per organization, in memory.
 *
 * The durable sink is a database adapter; this is the same shape so the service
 * does not know the difference, and so the tests exercise the real chain rather
 * than a stub that always agrees.
 */
export class OrganizationAuditLog implements AuditTrail {
  private readonly chains = new Map<string, AuditChain>();

  constructor(private readonly hash: HashFn) {}

  append(event: AuditEventInput): AuditEvent {
    const organizationId = (event.detail as { organizationId?: string } | undefined)?.organizationId;
    if (!organizationId) {
      throw new Error("an audit event must name the organization whose chain it belongs to");
    }
    const chain = this.chains.get(organizationId) ?? createAuditChain();
    const next = appendAuditEvent(chain, event, this.hash);
    this.chains.set(organizationId, next);
    return next.events[next.events.length - 1];
  }

  /**
   * The organization's history, oldest first. Another org's is never included.
   *
   * Returns deep copies, not the live array. A shallow copy would still hand out
   * references to the records themselves, and `trail(...)[0].actor = "someone"`
   * would rewrite the past — the one thing this class exists to prevent.
   */
  trail(organizationId: string): readonly AuditEvent[] {
    return (this.chains.get(organizationId)?.events ?? []).map((event) => structuredClone(event));
  }

  head(organizationId: string): string {
    return this.chains.get(organizationId)?.head ?? "0".repeat(64);
  }

  verify(organizationId: string): ChainVerification {
    const chain = this.chains.get(organizationId);
    return chain ? verifyAuditChain(chain, this.hash) : { ok: true, length: 0 };
  }
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

export interface CreateIdentityInput {
  identifier?: string;
  displayName?: string;
  kind?: string;
  role?: string;
  /** The source directory's id for this person, when a connector is creating them. */
  externalId?: string | null;
}

/**
 * The mover's edit: the fields an administrator (or a directory) may change about
 * somebody who already exists.
 *
 * Deliberately not a general record write. `kind` is absent because a service
 * identity does not become a person, `active` has its own method with its own rule,
 * and `mfaEnrolled` belongs to the factor services — so this is the *mover* half of
 * joiner/mover/leaver and nothing more.
 */
export interface UpdateIdentityInput {
  identifier?: string;
  displayName?: string;
  role?: string;
  externalId?: string | null;
}

export class IdentityService {
  constructor(
    private readonly store: IdentityStore,
    private readonly audit: AuditTrail | null = null,
    private readonly ids: IdentityIds = systemIdentityIds(),
  ) {}

  /* ---------------------------------------------------------- bootstrap */

  /**
   * Create an organization and its first administrator.
   *
   * The one operation that cannot be authorized *by* an organization, because
   * there is not one yet — so it is the only place an identity is created
   * without an actor, and it says so in the record: the audit event names the
   * human who ran it.
   */
  async bootstrapOrganization(
    createdBy: string,
    organization: { name?: string; slug?: string },
    admin: { identifier?: string; displayName?: string },
  ): Promise<ServiceResult<{ organization: OrganizationRecord; admin: IdentityRecord }>> {
    const orgIssues = firstIssue(validateOrganization(organization));
    if (orgIssues) return orgIssues;

    const slug = organization.slug!.trim().toLowerCase();
    if (await this.store.findOrganizationBySlug(slug)) {
      return { ok: false, error: `An organization with the slug “${slug}” already exists.` };
    }

    const now = this.ids.now();
    const record: OrganizationRecord = {
      id: this.ids.id(),
      slug,
      name: organization.name!.trim(),
      createdAt: now,
    };
    await this.store.insertOrganization(record);
    await this.append(record.id, createdBy, "organization.create", "Organization", record.id, {
      slug: record.slug,
      name: record.name,
    });

    const created = await this.createIdentity({ id: createdBy, organizationId: record.id, role: "ADMIN" }, {
      ...admin,
      kind: "HUMAN",
      role: "ADMIN",
    });
    if (!created.ok) return created;

    return { ok: true, value: { organization: record, admin: created.value } };
  }

  /* ------------------------------------------------------------ reading */

  /** The actor's own organization. It is the only one they can name. */
  async organization(actor: IdentityActor): Promise<ServiceResult<OrganizationRecord>> {
    const found = await this.store.findOrganization(actor.organizationId);
    if (!found) return { ok: false, error: "That organization does not exist." };
    return { ok: true, value: found };
  }

  /** The directory, scoped to the actor's organization. */
  async listIdentities(actor: IdentityActor): Promise<ServiceResult<IdentityRecord[]>> {
    if (!canReadDirectory(actor.role)) return { ok: false, error: "You do not have access to the directory." };
    return { ok: true, value: await this.store.listIdentities(actor.organizationId) };
  }

  /**
   * One identity, by id.
   *
   * Another organization's id is not "forbidden" — it simply is not there, so the
   * answer a caller can act on is the same as for an id that never existed.
   */
  async identity(actor: IdentityActor, identityId: string): Promise<ServiceResult<IdentityRecord>> {
    if (!canReadDirectory(actor.role)) return { ok: false, error: "You do not have access to the directory." };
    const found = await this.store.findIdentity(actor.organizationId, identityId);
    if (!found) return { ok: false, error: "That identity does not exist." };
    return { ok: true, value: found };
  }

  /* ------------------------------------------------------------ writing */

  async createIdentity(actor: IdentityActor, input: CreateIdentityInput): Promise<ServiceResult<IdentityRecord>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const issues = firstIssue(
      validateIdentity({ ...input, kind: input.kind ?? "HUMAN", role: input.role ?? "AGENT" }),
    );
    if (issues) return issues;

    const identifier = input.identifier!.trim();
    if (await this.store.findIdentityByIdentifier(actor.organizationId, identifier)) {
      return { ok: false, error: `“${identifier}” is already an identity here.` };
    }

    const externalId = input.externalId?.trim() || null;
    if (externalId && (await this.store.findIdentityByExternalId(actor.organizationId, externalId))) {
      return { ok: false, error: "That directory id is already an identity here." };
    }

    const now = this.ids.now();
    const record: IdentityRecord = {
      id: this.ids.id(),
      organizationId: actor.organizationId,
      identifier,
      displayName: input.displayName!.trim(),
      externalId,
      kind: (input.kind ?? "HUMAN") as IdentityKind,
      role: (input.role ?? "AGENT") as IdentityRole,
      active: true,
      mfaEnrolled: false,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.insertIdentity(record);
    await this.append(record.organizationId, actor.id, "identity.create", "Identity", record.id, {
      identifier: record.identifier,
      role: record.role,
      kind: record.kind,
      externalId: record.externalId,
    });
    return { ok: true, value: record };
  }

  /**
   * Change what an existing identity is called, what it may do, or which directory
   * record it came from — the *mover* half of joiner/mover/leaver.
   *
   * Three rules, and each one is a mistake somebody has made in a real deployment:
   * a rename may not collide with somebody else's user name, a rename may not
   * silently become a *different person* (which is what matching a connector on the
   * name alone does — hence `externalId`, and hence the refusal when it is already
   * taken), and a demotion may not leave the organization with nobody who can
   * administer it. The last one is asked through the same pure rule deactivation
   * uses, so "keep an administrator" has one answer rather than two.
   */
  async updateIdentity(
    actor: IdentityActor,
    identityId: string,
    input: UpdateIdentityInput,
  ): Promise<ServiceResult<IdentityRecord>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const found = await this.store.findIdentity(actor.organizationId, identityId);
    if (!found) return { ok: false, error: "That identity does not exist." };

    const role = (input.role ?? found.role) as IdentityRole;
    const identifier = (input.identifier ?? found.identifier).trim();
    const displayName = (input.displayName ?? found.displayName).trim();
    const externalId =
      input.externalId === undefined ? found.externalId : input.externalId?.trim() || null;

    const issues = firstIssue(
      validateIdentity({ identifier, displayName, kind: found.kind, role, externalId }),
    );
    if (issues) return issues;

    if (identifier.toLowerCase() !== found.identifier.toLowerCase()) {
      const clash = await this.store.findIdentityByIdentifier(actor.organizationId, identifier);
      if (clash && clash.id !== found.id) return { ok: false, error: `“${identifier}” is already an identity here.` };
    }
    if (externalId && externalId !== found.externalId) {
      const clash = await this.store.findIdentityByExternalId(actor.organizationId, externalId);
      if (clash && clash.id !== found.id) return { ok: false, error: "That directory id is already an identity here." };
    }

    if (role !== found.role) {
      const others = await this.store.listIdentities(actor.organizationId);
      if (wouldStrandAdministration(others, found.id, { role, active: found.active })) {
        return { ok: false, error: "This is the organization's only active administrator; it must keep one." };
      }
    }

    const next: IdentityRecord = { ...found, identifier, displayName, externalId, role, updatedAt: this.ids.now() };
    await this.store.updateIdentity(next);
    await this.append(next.organizationId, actor.id, "identity.update", "Identity", next.id, {
      identifier: next.identifier,
      displayName: next.displayName,
      role: next.role,
      externalId: next.externalId,
    });
    return { ok: true, value: next };
  }

  /**
   * Switch an identity on or off.
   *
   * The refusal is the interesting half: deactivating the last active
   * administrator would leave the organization with nobody able to administer
   * it, and no amount of audit trail fixes that.
   */
  async setActive(actor: IdentityActor, identityId: string, active: boolean): Promise<ServiceResult<IdentityRecord>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const found = await this.store.findIdentity(actor.organizationId, identityId);
    if (!found) return { ok: false, error: "That identity does not exist." };

    if (!active) {
      const others = await this.store.listIdentities(actor.organizationId);
      if (wouldStrandAdministration(others, found.id, { role: found.role, active: false })) {
        return { ok: false, error: "This is the organization's only active administrator; it must keep one." };
      }
    }

    const next: IdentityRecord = { ...found, active, updatedAt: this.ids.now() };
    await this.store.updateIdentity(next);
    await this.append(next.organizationId, actor.id, active ? "identity.activate" : "identity.deactivate", "Identity", next.id, {
      identifier: next.identifier,
    });
    return { ok: true, value: next };
  }

  /**
   * Record that a second factor is enrolled. MFA is required by default policy.
   *
   * **Self is allowed, and that is deliberate.** Enrollment is a user's own act now
   * — the console in S1 is self-service — so an actor may set this on their own
   * identity, while somebody else's still needs `canManageIdentities`. The *writer*
   * stays single: `MfaService` and `WebAuthnService` both go through here, so there
   * is one place a reviewer has to check that the flag only ever follows a proven
   * factor.
   */
  async setMfaEnrolled(actor: IdentityActor, identityId: string, enrolled: boolean): Promise<ServiceResult<IdentityRecord>> {
    if (actor.id !== identityId) {
      const denied = this.requireManage(actor);
      if (denied) return denied;
    }

    const found = await this.store.findIdentity(actor.organizationId, identityId);
    if (!found) return { ok: false, error: "That identity does not exist." };

    const next: IdentityRecord = { ...found, mfaEnrolled: enrolled, updatedAt: this.ids.now() };
    await this.store.updateIdentity(next);
    await this.append(next.organizationId, actor.id, enrolled ? "identity.mfa.enroll" : "identity.mfa.remove", "Identity", next.id, {
      identifier: next.identifier,
    });
    return { ok: true, value: next };
  }

  /* ------------------------------------------------------------ sessions */

  /**
   * Issue a session, if the policy allows one.
   *
   * The caller is assumed to have verified the credential already — that check
   * is the part of a login this milestone does not have. What the spine owns is
   * the policy: an inactive identity, or one that owes a second factor under a
   * policy that requires it, gets no session, and the refusal is recorded.
   */
  async issueSession(
    organizationId: string,
    identityId: string,
    details: { userAgent?: string | null; ipAddress?: string | null } = {},
    policy?: IdentityPolicy,
  ): Promise<ServiceResult<SessionRecord>> {
    const identity = await this.store.findIdentity(organizationId, identityId);
    if (!identity) return { ok: false, error: "That identity does not exist." };

    const effective = policy ?? (await this.policyFor(organizationId, identity.role));
    const nowMs = this.ids.nowMs();
    const decision = sessionDecision(identitySummary(identity), { issuedAt: nowMs, lastSeenAt: nowMs, revokedAt: null }, effective, nowMs);
    if (!decision.active) {
      await this.append(organizationId, identityId, "session.refuse", "Identity", identity.id, {
        reason: decision.reason,
        policyScope: identity.role,
      });
      return { ok: false, error: `No session: ${decision.reason}.` };
    }

    const record: SessionRecord = {
      id: this.ids.id(),
      organizationId,
      identityId: identity.id,
      issuedAt: nowMs,
      lastSeenAt: nowMs,
      expiresAt: sessionExpiry(nowMs, effective),
      revokedAt: null,
      userAgent: details.userAgent ?? null,
      ipAddress: details.ipAddress ?? null,
    };
    await this.store.insertSession(record);
    // The scope is recorded on the grant, so "which policy let this in?" is
    // answerable from the record rather than by reconstructing the table later.
    await this.append(organizationId, identity.id, "session.grant", "Session", record.id, {
      expiresAt: new Date(record.expiresAt).toISOString(),
      policyScope: identity.role,
      ipAddress: record.ipAddress,
    });
    return { ok: true, value: record };
  }

  /**
   * The policy that governs one identity, resolved from what the organization has
   * stored: its role's row, else the `ALL` row, else the built-in default.
   *
   * Public because the console shows an administrator the number a sign-in will
   * actually be judged by, and because a caller that wants to *ask* the question
   * explicitly can, rather than passing a policy in and getting a second opinion.
   */
  async policyFor(organizationId: string, role: IdentityRole): Promise<IdentityPolicy> {
    const rows = await this.store.listPolicies(organizationId);
    return policyForRole(rows, role);
  }

  /** The stored policy rows, for the console. Reading is wider than writing. */
  async policies(actor: IdentityActor): Promise<ServiceResult<PolicyRecord[]>> {
    if (!canReadDirectory(actor.role)) return { ok: false, error: "You do not have access to the organization's policies." };
    return { ok: true, value: await this.store.listPolicies(actor.organizationId) };
  }

  /**
   * Write the baseline or one role's override.
   *
   * Upsert rather than insert, because the row that matters is identified by
   * `(organization, scope)` and "the AGENT policy" is a thing an administrator
   * edits repeatedly, not a thing they accumulate.
   */
  async setPolicy(
    actor: IdentityActor,
    scope: string,
    input: { requireMfa?: boolean; maxSessionSeconds?: number; idleTimeoutSeconds?: number },
  ): Promise<ServiceResult<PolicyRecord>> {
    if (!canManagePolicies(actor.role)) return { ok: false, error: "You do not administer policies." };

    const issues = firstIssue(validatePolicy({ scope, ...input }));
    if (issues) return issues;

    const record: PolicyRecord = {
      organizationId: actor.organizationId,
      scope: scope as PolicyScope,
      requireMfa: input.requireMfa !== false,
      maxSessionSeconds: input.maxSessionSeconds!,
      idleTimeoutSeconds: input.idleTimeoutSeconds!,
      updatedAt: this.ids.now(),
    };
    await this.store.upsertPolicy(record);
    await this.append(actor.organizationId, actor.id, "policy.update", "IdentityPolicy", record.scope, {
      scope: record.scope,
      requireMfa: record.requireMfa,
      maxSessionSeconds: record.maxSessionSeconds,
      idleTimeoutSeconds: record.idleTimeoutSeconds,
    });
    return { ok: true, value: record };
  }

  /** Whether a stored session is still usable, asked the same way everywhere. */
  async checkSession(
    organizationId: string,
    sessionId: string,
    policy?: IdentityPolicy,
  ): Promise<SessionDecision> {
    const session = await this.store.findSession(organizationId, sessionId);
    if (!session) return { active: false, reason: "session does not exist" };
    const identity = await this.store.findIdentity(organizationId, session.identityId);
    if (!identity) return { active: false, reason: "identity does not exist" };
    const effective = policy ?? (await this.policyFor(organizationId, identity.role));
    return sessionDecision(identitySummary(identity), sessionInfo(session), effective, this.ids.nowMs());
  }

  /**
   * Resolve a live session to the identity it belongs to — what an OIDC
   * authorization needs before it may issue a code (S1).
   *
   * The policy is asked the same way it is asked everywhere else, so a session
   * cannot be alive at one entry point and dead at another. The organization is
   * part of the lookup rather than a check afterwards: another tenant's session
   * is not found at all.
   */
  async resolveSession(
    organizationId: string,
    sessionId: string,
    policy?: IdentityPolicy,
  ): Promise<ServiceResult<{ identity: IdentityRecord; session: SessionRecord }>> {
    const session = await this.store.findSession(organizationId, sessionId);
    if (!session) return { ok: false, error: "That session does not exist." };
    const identity = await this.store.findIdentity(organizationId, session.identityId);
    if (!identity) return { ok: false, error: "That identity does not exist." };

    const effective = policy ?? (await this.policyFor(organizationId, identity.role));
    const decision = sessionDecision(identitySummary(identity), sessionInfo(session), effective, this.ids.nowMs());
    if (!decision.active) return { ok: false, error: `That session is not usable: ${decision.reason}.` };
    return { ok: true, value: { identity, session } };
  }

  /**
   * Resolve a live session from the opaque id a browser holds, without being told
   * the organization — what the console needs.
   *
   * The policy is asked exactly the way `resolveSession` asks it, through the same
   * pure `sessionDecision`, so a session cannot be alive on the console page and
   * dead at authorize. The organization is *read from the session row* rather than
   * taken from the caller, so the only thing a browser can name is a session it was
   * already given.
   */
  async resolveOwnSession(
    sessionId: string,
    policy?: IdentityPolicy,
  ): Promise<ServiceResult<{ organizationId: string; identity: IdentityRecord; session: SessionRecord }>> {
    const session = await this.store.findSessionByKey(sessionId);
    if (!session) return { ok: false, error: "That session does not exist." };
    const identity = await this.store.findIdentity(session.organizationId, session.identityId);
    if (!identity) return { ok: false, error: "That identity does not exist." };

    const effective = policy ?? (await this.policyFor(session.organizationId, identity.role));
    const decision = sessionDecision(identitySummary(identity), sessionInfo(session), effective, this.ids.nowMs());
    if (!decision.active) return { ok: false, error: `That session is not usable: ${decision.reason}.` };
    return { ok: true, value: { organizationId: session.organizationId, identity, session } };
  }

  /** Move a session's idle clock. Returns whether it was still usable first. */
  async touchSession(organizationId: string, sessionId: string): Promise<ServiceResult<SessionRecord>> {
    const session = await this.store.findSession(organizationId, sessionId);
    if (!session) return { ok: false, error: "That session does not exist." };

    const decision = await this.checkSession(organizationId, sessionId);
    if (!decision.active) return { ok: false, error: `That session is not usable: ${decision.reason}.` };

    const next: SessionRecord = { ...session, lastSeenAt: this.ids.nowMs() };
    await this.store.updateSession(next);
    return { ok: true, value: next };
  }

  /**
   * End a session. A reason is required, because "why was this cut off?" is the
   * question an incident asks, and a blank one is not an answer.
   */
  async revokeSession(actor: IdentityActor, sessionId: string, reason: string): Promise<ServiceResult<SessionRecord>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const found = await this.store.findSession(actor.organizationId, sessionId);
    if (!found) return { ok: false, error: "That session does not exist." };
    if (reason.trim().length < 3) return { ok: false, error: "Ending a session needs a reason on the record." };

    const next: SessionRecord = { ...found, revokedAt: this.ids.nowMs() };
    await this.store.updateSession(next);
    await this.append(next.organizationId, actor.id, "session.revoke", "Session", next.id, {
      identityId: next.identityId,
      reason: reason.trim(),
    });
    return { ok: true, value: next };
  }

  /**
   * End a session at its holder's own request — sign-out.
   *
   * Deliberately *not* `revokeSession`: that one is an administrator cutting
   * somebody else's session off, so it checks `canManageIdentities` and names the
   * actor on the record. Sign-out is the opposite case — a person ending their
   * own session — and holding the session id *is* the proof, exactly as it is at
   * authorize time. Requiring an administrator for it would mean nobody could
   * ever sign themselves out, which is how a session outlives its user.
   *
   * The reason is still required, and still lands on the chain: "why did this
   * session end?" is asked about sign-outs too.
   */
  async endOwnSession(
    organizationId: string,
    sessionId: string,
    reason: string,
  ): Promise<ServiceResult<SessionRecord>> {
    const found = await this.store.findSession(organizationId, sessionId);
    if (!found) return { ok: false, error: "That session does not exist." };
    if (reason.trim().length < 3) return { ok: false, error: "Ending a session needs a reason on the record." };

    // Already ended is a success: signing out twice is what a person does when
    // the first click looked like it did nothing.
    if (found.revokedAt !== null) return { ok: true, value: found };

    const next: SessionRecord = { ...found, revokedAt: this.ids.nowMs() };
    await this.store.updateSession(next);
    await this.append(organizationId, found.identityId, "session.signout", "Session", next.id, {
      identityId: next.identityId,
      reason: reason.trim(),
    });
    return { ok: true, value: next };
  }

  /**
   * End every live session an identity holds — the leaver action.
   *
   * Returns the count, because "how many sessions did that cut off?" is the
   * number somebody will want, and 0 is a real answer worth seeing.
   */
  async revokeAllForIdentity(
    actor: IdentityActor,
    identityId: string,
    reason: string,
  ): Promise<ServiceResult<{ revoked: number }>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;
    if (reason.trim().length < 3) return { ok: false, error: "Ending sessions needs a reason on the record." };

    const found = await this.store.findIdentity(actor.organizationId, identityId);
    if (!found) return { ok: false, error: "That identity does not exist." };

    const sessions = await this.store.listSessions(actor.organizationId, identityId);
    const nowMs = this.ids.nowMs();
    let revoked = 0;
    for (const session of sessions) {
      if (session.revokedAt !== null) continue;
      await this.store.updateSession({ ...session, revokedAt: nowMs });
      revoked += 1;
    }

    await this.append(actor.organizationId, actor.id, "session.revoke_all", "Identity", identityId, {
      revoked,
      reason: reason.trim(),
    });
    return { ok: true, value: { revoked } };
  }

  /** Every live session for the actor's organization, for an admin console. */
  async listSessions(actor: IdentityActor, identityId?: string): Promise<ServiceResult<SessionRecord[]>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;
    return { ok: true, value: await this.store.listSessions(actor.organizationId, identityId) };
  }

  /* --------------------------------------------------------------- audit */

  /**
   * The organization's evidence log and whether it still verifies.
   *
   * This is the S0 exit criterion made usable: an administrator can read back
   * every privileged action their organization has taken, and check that none of
   * it was edited after the fact.
   */
  async auditTrail(actor: IdentityActor): Promise<ServiceResult<{ events: readonly AuditEvent[]; verification: ChainVerification }>> {
    if (!canReadDirectory(actor.role)) return { ok: false, error: "You do not have access to the audit trail." };
    if (!this.audit) return { ok: false, error: "This deployment has no audit trail configured." };
    const [events, verification] = await Promise.all([
      this.audit.trail(actor.organizationId),
      this.audit.verify(actor.organizationId),
    ]);
    return { ok: true, value: { events, verification } };
  }

  /* ----------------------------------------------------------- internals */

  private requireManage(actor: IdentityActor): ServiceResult<never> | null {
    if (!canManageIdentities(actor.role)) return { ok: false, error: "You do not administer identities." };
    return null;
  }

  private async append(
    organizationId: string,
    actor: string,
    action: string,
    targetType: string,
    targetId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) return;
    // The organization rides in the detail so the log can route an event to the
    // right chain without the chain format knowing about tenants.
    await this.audit.append({
      id: this.ids.id(),
      at: this.ids.now(),
      actor,
      action,
      targetType,
      targetId,
      detail: { ...detail, organizationId },
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  An in-memory store, used by tests and local development                   */
/* -------------------------------------------------------------------------- */

export class MemoryIdentityStore implements IdentityStore {
  private readonly organizations = new Map<string, OrganizationRecord>();
  private readonly identities = new Map<string, IdentityRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly policies = new Map<string, PolicyRecord>();

  private policyKey(organizationId: string, scope: PolicyScope): string {
    return `${organizationId}\u0000${scope}`;
  }

  async listPolicies(organizationId: string): Promise<PolicyRecord[]> {
    return [...this.policies.values()]
      .filter((entry) => entry.organizationId === organizationId)
      .map((entry) => structuredClone(entry));
  }

  async upsertPolicy(record: PolicyRecord): Promise<void> {
    this.policies.set(this.policyKey(record.organizationId, record.scope), structuredClone(record));
  }

  async findOrganization(organizationId: string): Promise<OrganizationRecord | null> {
    const found = this.organizations.get(organizationId);
    return found ? structuredClone(found) : null;
  }

  async findOrganizationBySlug(slug: string): Promise<OrganizationRecord | null> {
    const wanted = slug.trim().toLowerCase();
    const found = [...this.organizations.values()].find((entry) => entry.slug === wanted);
    return found ? structuredClone(found) : null;
  }

  async insertOrganization(record: OrganizationRecord): Promise<void> {
    this.organizations.set(record.id, structuredClone(record));
  }

  async listIdentities(organizationId: string): Promise<IdentityRecord[]> {
    return [...this.identities.values()]
      .filter((entry) => entry.organizationId === organizationId)
      .map((entry) => structuredClone(entry));
  }

  async findIdentity(organizationId: string, identityId: string): Promise<IdentityRecord | null> {
    const found = this.identities.get(identityId);
    return found && found.organizationId === organizationId ? structuredClone(found) : null;
  }

  async findIdentityByIdentifier(organizationId: string, identifier: string): Promise<IdentityRecord | null> {
    const wanted = identifier.trim().toLowerCase();
    const found = [...this.identities.values()].find(
      (entry) => entry.organizationId === organizationId && entry.identifier.toLowerCase() === wanted,
    );
    return found ? structuredClone(found) : null;
  }

  async findIdentityByExternalId(organizationId: string, externalId: string): Promise<IdentityRecord | null> {
    const wanted = externalId.trim();
    if (!wanted) return null;
    const found = [...this.identities.values()].find(
      (entry) => entry.organizationId === organizationId && entry.externalId === wanted,
    );
    return found ? structuredClone(found) : null;
  }

  async insertIdentity(record: IdentityRecord): Promise<void> {
    this.identities.set(record.id, structuredClone(record));
  }

  async updateIdentity(record: IdentityRecord): Promise<void> {
    this.identities.set(record.id, structuredClone(record));
  }

  async listSessions(organizationId: string, identityId?: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((entry) => entry.organizationId === organizationId)
      .filter((entry) => (identityId === undefined ? true : entry.identityId === identityId))
      .map((entry) => structuredClone(entry));
  }

  async findSession(organizationId: string, sessionId: string): Promise<SessionRecord | null> {
    const found = this.sessions.get(sessionId);
    return found && found.organizationId === organizationId ? structuredClone(found) : null;
  }

  async findSessionByKey(sessionId: string): Promise<SessionRecord | null> {
    const found = this.sessions.get(sessionId);
    return found ? structuredClone(found) : null;
  }

  async insertSession(record: SessionRecord): Promise<void> {
    this.sessions.set(record.id, structuredClone(record));
  }

  async updateSession(record: SessionRecord): Promise<void> {
    this.sessions.set(record.id, structuredClone(record));
  }
}
