/**
 * SCIM service (S2): provisioning, wired to the spine without a second set of rules.
 *
 * `scim-rules.ts` decides what a SCIM request *means*; `scim-http.ts` moves the
 * bytes; this file answers the one question neither can — **who is asking, and what
 * may they therefore do?** — and then calls the S0 spine for everything that is a
 * fact about an identity.
 *
 * Four decisions worth stating out loud:
 *
 *  - **The connector's authority is the administrator who minted its token.** A SCIM
 *    call arrives as `scim:<tokenId>` acting with `ADMIN` inside one organization.
 *    That is not a loophole, it is the delegation: minting a token in the console is
 *    an administrator saying "this connector may provision for us", and the token can
 *    do exactly what that administrator could and nothing wider. The audit trail
 *    names the connector rather than the human, so a machine's write is never
 *    attributed to a person who was asleep.
 *  - **Nothing here writes a record directly.** An identity is created, updated or
 *    deactivated through `IdentityService`, so `mfaEnrolled` keeps its single writer,
 *    the last-administrator refusal applies to a directory push exactly as it applies
 *    to the console, and every SCIM change lands on the organization's evidence chain
 *    as the same kind of event. A second write path would be a second set of rules,
 *    and they would drift.
 *  - **Deactivating somebody ends their access, not just their flag.** A leaver whose
 *    `active` was set to false but whose sessions stayed live would keep working until
 *    each one expired on its own — which is the whole failure mode offboarding exists
 *    to prevent. So `active: false` (and `DELETE`) deactivates, ends every session the
 *    identity holds, *and* revokes the access tokens those sessions minted, because
 *    ending a session leaves its already-issued tokens working otherwise.
 *  - **Token management is not on the SCIM surface.** A connector cannot mint itself
 *    another credential: tokens are minted, listed and revoked from the console by a
 *    person with a session. A machine-facing API that can widen its own access is a
 *    machine-facing API with no ceiling.
 */

import { randomBytes, randomUUID } from "node:crypto";

import type { AuditTrail, IdentityActor, IdentityService, ServiceResult } from "./identity-service";
import { canManageIdentities, type IdentityRecord } from "./identity-rules";
import { sha256Hex } from "./hash";
import type { HashFn } from "./audit-chain";
import {
  looksLikeScimToken,
  parseScimPatch,
  parseScimQuery,
  parseScimUserReplace,
  roleFromScim,
  scimError,
  scimGroupName,
  scimPage,
  scimUserInput,
  toScimGroup,
  toScimUser,
  validateScimTokenLabel,
  SCIM_ENDPOINTS,
  SCIM_ENTERPRISE_USER_SCHEMA,
  SCIM_GROUP_SCHEMA,
  SCIM_LIST_SCHEMA,
  SCIM_PAGE_MAX,
  SCIM_RESOURCE_TYPE_SCHEMA,
  SCIM_SCHEMA_SCHEMA,
  SCIM_SERVICE_CONFIG_SCHEMA,
  SCIM_TOKEN_BYTES,
  SCIM_TOKEN_PREFIX,
  SCIM_USER_SCHEMA,
  type ScimAttribute,
  type ScimError,
  type ScimGroupResource,
  type ScimListResponse,
  type ScimUserResource,
} from "./scim-rules";

/* -------------------------------------------------------------------------- */
/*  The records this milestone owns                                           */
/* -------------------------------------------------------------------------- */

/**
 * A credential a directory connector authenticates with.
 *
 * Stored as a hash, never as the token — the same rule as every other credential in
 * the product, and the reason a database copy is not a set of working tokens. The
 * plaintext exists once, in the response to the console request that minted it.
 */
export interface ScimTokenRecord {
  id: string;
  organizationId: string;
  label: string | null;
  tokenHash: string;
  /** Who minted it. The connector acts as this delegation, never as this person. */
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ScimGroupRecord {
  id: string;
  organizationId: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScimGroupMemberRecord {
  groupId: string;
  identityId: string;
}

/* -------------------------------------------------------------------------- */
/*  The store port                                                            */
/* -------------------------------------------------------------------------- */

export interface ScimStore {
  insertToken(record: ScimTokenRecord): Promise<void>;
  findTokenByHash(tokenHash: string): Promise<ScimTokenRecord | null>;
  listTokens(organizationId: string): Promise<ScimTokenRecord[]>;
  updateToken(record: ScimTokenRecord): Promise<void>;

  listGroups(organizationId: string): Promise<ScimGroupRecord[]>;
  findGroup(organizationId: string, groupId: string): Promise<ScimGroupRecord | null>;
  findGroupByName(organizationId: string, displayName: string): Promise<ScimGroupRecord | null>;
  insertGroup(record: ScimGroupRecord): Promise<void>;
  updateGroup(record: ScimGroupRecord): Promise<void>;
  removeGroup(organizationId: string, groupId: string): Promise<void>;

  listMembers(organizationId: string, groupId: string): Promise<ScimGroupMemberRecord[]>;
  /** Idempotent: a member already in the group is not an error, it is a no-op. */
  addMembers(organizationId: string, groupId: string, identityIds: string[]): Promise<void>;
  removeMembers(organizationId: string, groupId: string, identityIds: string[]): Promise<void>;
  /** Every group the identity belongs to, so a deactivation can report them. */
  listMembershipsForIdentity(organizationId: string, identityId: string): Promise<ScimGroupMemberRecord[]>;
}

export interface ScimIds {
  id(): string;
  /** ISO-8601, server-authoritative. */
  now(): string;
  nowMs(): number;
  /** The plaintext half of a token, before it is hashed. */
  token(): string;
}

export function systemScimIds(): ScimIds {
  return {
    id: () => randomUUID(),
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
    token: () => `${SCIM_TOKEN_PREFIX}${randomBytes(SCIM_TOKEN_BYTES).toString("base64url")}`,
  };
}

/* -------------------------------------------------------------------------- */
/*  The caller                                                                */
/* -------------------------------------------------------------------------- */

export interface ScimCaller {
  organizationId: string;
  tokenId: string;
  label: string | null;
  /**
   * The actor a change is made *as*. `scim:<tokenId>` with the administrator role the
   * token inherited when it was minted — so the chain says a connector did this, and
   * the spine's permission checks still apply to it.
   */
  actor: IdentityActor;
}

export interface ScimConfig {
  /** Where SCIM lives, for the `meta.location` links a connector may follow. */
  baseUrl: string;
}

/** What a caller needs of the OIDC store: kill the tokens a session minted. */
export interface ScimTokenRevoker {
  revokeTokensForSession(organizationId: string, sessionId: string, at: number): Promise<number>;
}

/* -------------------------------------------------------------------------- */
/*  Results                                                                   */
/* -------------------------------------------------------------------------- */

export type ScimResult<T> = { ok: true; value: T } | { ok: false; error: ScimError };

/**
 * Turn a spine refusal into a SCIM one.
 *
 * The spine answers in sentences, because a person reads them in the console; a
 * connector branches on `scimType`, because "somebody already has this user name" is
 * a conflict an administrator resolves while "that value is malformed" is a retry
 * that will never succeed. This is the one place the two vocabularies meet.
 */
export function asScimError(message: string): ScimError {
  if (/already .* (here|identity)/i.test(message)) return scimError(409, message, "uniqueness");
  if (/does not exist/i.test(message)) return scimError(404, message);
  if (/only active administrator/i.test(message)) return scimError(409, message, "mutability");
  if (/do not administer|not allowed/i.test(message)) return scimError(403, message);
  if (/not usable|sign in/i.test(message)) return scimError(401, message);
  return scimError(400, message, "invalidValue");
}

function fromSpine<T>(result: ServiceResult<T>): ScimResult<T> {
  return result.ok ? { ok: true, value: result.value } : { ok: false, error: asScimError(result.error) };
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

export class ScimService {
  constructor(
    private readonly store: ScimStore,
    private readonly spine: IdentityService,
    private readonly config: ScimConfig,
    private readonly audit: AuditTrail | null = null,
    private readonly tokens: ScimTokenRevoker | null = null,
    private readonly ids: ScimIds = systemScimIds(),
    private readonly hash: HashFn = sha256Hex,
  ) {}

  /* ----------------------------------------------------------- the caller */

  /**
   * Resolve a bearer token to the connector it belongs to.
   *
   * The prefix is checked first so a request that cannot be carrying one is refused
   * without a query, and a revoked token is refused here rather than at each endpoint
   * — one place to ask, one place to get it wrong.
   */
  async authenticate(rawToken: string): Promise<ScimResult<ScimCaller>> {
    const presented = (rawToken ?? "").trim();
    if (!looksLikeScimToken(presented)) {
      return { ok: false, error: scimError(401, "A provisioning token is required.", "invalidValue") };
    }

    const found = await this.store.findTokenByHash(this.hash(presented));
    if (!found) return { ok: false, error: scimError(401, "That provisioning token is not recognised.", "invalidValue") };
    if (found.revokedAt !== null) {
      return { ok: false, error: scimError(401, "That provisioning token has been revoked.", "invalidValue") };
    }

    // `lastUsedAt` is how somebody answers "is this token still in use?" before
    // revoking it. A failure to record it does not fail the call: the write is
    // bookkeeping, and refusing a directory push over it would be worse than a stale
    // timestamp.
    await this.store.updateToken({ ...found, lastUsedAt: this.ids.now() }).catch(() => undefined);

    return {
      ok: true,
      value: {
        organizationId: found.organizationId,
        tokenId: found.id,
        label: found.label,
        actor: { id: `scim:${found.id}`, organizationId: found.organizationId, role: "ADMIN" },
      },
    };
  }

  /* ------------------------------------------------------- tokens (people) */

  /**
   * Mint a connector token. **Returns the plaintext once, and stores only its hash.**
   *
   * Called from the console, where a person with a session is present: this is the
   * act of delegation the connector's authority comes from, so it is an
   * administrator's and it is on the record.
   */
  async mintToken(
    actor: IdentityActor,
    label: string | null,
  ): Promise<ServiceResult<{ token: ScimTokenRecord; plaintext: string }>> {
    if (actor.role !== "ADMIN") return { ok: false, error: "You do not administer identities." };

    const plaintext = this.ids.token();
    const record: ScimTokenRecord = {
      id: this.ids.id(),
      organizationId: actor.organizationId,
      label: validateScimTokenLabel(label),
      tokenHash: this.hash(plaintext),
      createdBy: actor.id,
      createdAt: this.ids.now(),
      lastUsedAt: null,
      revokedAt: null,
    };
    await this.store.insertToken(record);
    await this.append(record.organizationId, actor.id, "scim.token.mint", "ScimToken", record.id, {
      label: record.label,
    });
    return { ok: true, value: { token: record, plaintext } };
  }

  async listTokens(actor: IdentityActor): Promise<ServiceResult<ScimTokenRecord[]>> {
    if (actor.role !== "ADMIN") return { ok: false, error: "You do not administer identities." };
    return { ok: true, value: await this.store.listTokens(actor.organizationId) };
  }

  /** Revocation is a timestamp, so the record says *when* it stopped working. */
  async revokeToken(actor: IdentityActor, tokenId: string): Promise<ServiceResult<ScimTokenRecord>> {
    if (actor.role !== "ADMIN") return { ok: false, error: "You do not administer identities." };

    const found = (await this.store.listTokens(actor.organizationId)).find((entry) => entry.id === tokenId);
    if (!found) return { ok: false, error: "That provisioning token does not exist." };
    if (found.revokedAt !== null) return { ok: true, value: found };

    const next: ScimTokenRecord = { ...found, revokedAt: this.ids.now() };
    await this.store.updateToken(next);
    await this.append(actor.organizationId, actor.id, "scim.token.revoke", "ScimToken", next.id, {
      label: next.label,
    });
    return { ok: true, value: next };
  }

  /** Where a connector points, so the console can show it rather than describe it. */
  baseUrl(): string {
    return this.config.baseUrl;
  }

  /* ------------------------------------------------------------------------ */
  /*  The same paths, for a source of truth that is not a SCIM connector       */
  /* ------------------------------------------------------------------------ */

  /**
   * The leaver path, reachable by an in-process caller rather than only by a token.
   *
   * The directory sync (S2's other half) reads a roster itself and pushes it through
   * the *same* code SCIM uses — deactivating somebody and killing what they hold is one
   * operation with one audit sentence, and a second implementation of it would be a
   * second place for it to be wrong. The actor is a real administrator (the person who
   * owns the connection), and the permission is checked here rather than assumed,
   * because minting a caller is not evidence of anything.
   */
  async deprovisionForActor(
    actor: IdentityActor,
    identityId: string,
    reason: string,
  ): Promise<ServiceResult<{ identity: IdentityRecord; sessionsEnded: number }>> {
    if (!canManageIdentities(actor.role)) return { ok: false, error: "You do not administer identities." };
    const result = await this.deprovision(this.syntheticCaller(actor, "directory"), identityId, reason);
    return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error.detail };
  }

  /**
   * Replace a group's membership with exactly this set — what a directory sync means
   * by "these are the members".
   *
   * Deliberately a replacement rather than a merge: a directory that removed somebody
   * from a group has said something, and an add-only sync would never hear it. The
   * count of what was added and removed is returned because "a push that looks like it
   * did nothing" and "a push that removed nine people" are the same zero in a log.
   */
  async syncGroup(
    actor: IdentityActor,
    displayName: string,
    identityIds: readonly string[],
  ): Promise<ServiceResult<{ groupId: string; created: boolean; added: number; removed: number }>> {
    if (!canManageIdentities(actor.role)) return { ok: false, error: "You do not administer identities." };
    const name = displayName.trim();
    if (!name) return { ok: false, error: "A group needs a name." };

    let group = await this.store.findGroupByName(actor.organizationId, name);
    const created = group === null;
    if (!group) {
      group = {
        id: this.ids.id(),
        organizationId: actor.organizationId,
        displayName: name,
        createdAt: this.ids.now(),
        updatedAt: this.ids.now(),
      };
      await this.store.insertGroup(group);
    }

    const wanted = [...new Set(identityIds)];
    const existing = (await this.store.listMembers(actor.organizationId, group.id)).map((member) => member.identityId);
    const have = new Set(existing);
    const want = new Set(wanted);
    const added = wanted.filter((id) => !have.has(id));
    const removed = existing.filter((id) => !want.has(id));

    if (added.length > 0) await this.store.addMembers(actor.organizationId, group.id, added);
    if (removed.length > 0) await this.store.removeMembers(actor.organizationId, group.id, removed);

    if (added.length > 0 || removed.length > 0 || created) {
      await this.append(actor.organizationId, actor.id, created ? "scim.group.create" : "scim.group.members", "Group", group.id, {
        displayName: group.displayName,
        added: added.length,
        removed: removed.length,
      });
    }
    return { ok: true, value: { groupId: group.id, created, added: added.length, removed: removed.length } };
  }

  /**
   * A caller for a path that never presented a token.
   *
   * Private on purpose. A public way to mint a caller would be a way to skip token
   * authentication, which is the one thing the caller type exists to represent; here it
   * is only ever built from an `IdentityActor` the spine has already resolved, and only
   * the permission-checked methods above use it.
   */
  private syntheticCaller(actor: IdentityActor, label: string): ScimCaller {
    return { organizationId: actor.organizationId, tokenId: `${label}:${actor.id}`, label, actor };
  }

  /** The same, without a trailing slash, for building a link onto. */
  private root(): string {
    return this.config.baseUrl.replace(/\/+$/, "");
  }

  /**
   * The synced groups, for the console: what a directory has actually pushed at us.
   *
   * A person's view, so it is an administrator's — the groups themselves are readable
   * through the SCIM API by whichever connector token exists, which is a machine's
   * question rather than this one’s.
   */
  async listGroupsForActor(
    actor: IdentityActor,
  ): Promise<ServiceResult<{ id: string; displayName: string; memberCount: number }[]>> {
    if (actor.role !== "ADMIN") return { ok: false, error: "You do not administer identities." };

    const groups = await this.store.listGroups(actor.organizationId);
    const rows = await Promise.all(
      groups.map(async (group) => ({
        id: group.id,
        displayName: group.displayName,
        memberCount: (await this.store.listMembers(actor.organizationId, group.id)).length,
      })),
    );
    return { ok: true, value: rows };
  }

  /* --------------------------------------------------------------- users */

  async listUsers(
    caller: ScimCaller,
    params: URLSearchParams,
  ): Promise<ScimResult<ScimListResponse<ScimUserResource>>> {
    const query = parseScimQuery(params);
    if (query.error) return { ok: false, error: query.error };

    // Humans only: a provisioning push must not be able to switch off a machine
    // account, and a `SERVICE` identity is one.
    let records = (await this.humans(caller)).filter((identity) => matchesFilter(identity, query.filter));

    records = records.sort((a, b) => a.identifier.localeCompare(b.identifier));
    return { ok: true, value: scimPage(records.map((record) => this.userResource(record)), {
      startIndex: query.startIndex,
      count: query.count,
    }) };
  }

  async getUser(caller: ScimCaller, userId: string): Promise<ScimResult<ScimUserResource>> {
    const found = await this.human(caller, userId);
    if (!found.ok) return found;
    return { ok: true, value: this.userResource(found.value) };
  }

  /**
   * Create a user from a directory.
   *
   * Match order matters and is stated rather than implied: `externalId` first, then
   * the user name. A directory that provisioned somebody, then had their name change,
   * sends an `externalId` we already know — and answering that with a *conflict*
   * (rather than a second identity) is what tells the connector to send a PATCH.
   */
  async createUser(caller: ScimCaller, body: unknown): Promise<ScimResult<ScimUserResource>> {
    const input = scimUserInput(body);
    if ("status" in input) return { ok: false, error: input };

    if (input.externalId) {
      const known = await this.storeTokenIdentity(caller, input.externalId);
      if (known) {
        return {
          ok: false,
          error: scimError(409, "A user with that externalId already exists. Use PATCH to update it.", "uniqueness"),
        };
      }
    }

    const created = await this.spine.createIdentity(caller.actor, {
      identifier: input.userName,
      displayName: input.displayName,
      externalId: input.externalId,
      kind: "HUMAN",
      role: "AGENT",
    });
    if (!created.ok) return { ok: false, error: asScimError(created.error) };

    // A create that arrives already inactive is a leaver whose join we never saw; the
    // identity exists and is switched off, which is what was asked for.
    if (!input.active) {
      const deactivated = await this.deprovision(caller, created.value.id, "a directory provisioned this identity as inactive");
      if (!deactivated.ok) return deactivated;
      return { ok: true, value: this.userResource(deactivated.value.identity) };
    }
    return { ok: true, value: this.userResource(created.value) };
  }

  /** PUT: a replacement. Omitted attributes are reset, per the standard. */
  async replaceUser(caller: ScimCaller, userId: string, body: unknown): Promise<ScimResult<ScimUserResource>> {
    const known = await this.human(caller, userId);
    if (!known.ok) return known;

    const parsed = parseScimUserReplace(body);
    if ("status" in parsed) return { ok: false, error: parsed };

    const applied = await this.apply(caller, known.value, parsed.changes);
    if (!applied.ok) return applied;
    return { ok: true, value: this.userResource(applied.value.identity) };
  }

  /** PATCH: only the attributes named are touched. */
  async patchUser(caller: ScimCaller, userId: string, body: unknown): Promise<ScimResult<ScimUserResource>> {
    const known = await this.human(caller, userId);
    if (!known.ok) return known;

    const parsed = parseScimPatch(body);
    if ("status" in parsed) return { ok: false, error: parsed };

    const applied = await this.apply(caller, known.value, parsed.changes);
    if (!applied.ok) return applied;
    return { ok: true, value: this.userResource(applied.value.identity) };
  }

  /**
   * Delete a user: **deactivate, and end what they hold.**
   *
   * The row stays, so the sessions they held, the factors they enrolled and the audit
   * events naming them all survive — which is the one property this product cannot
   * trade away for tidiness. A connector that re-creates the same user name later gets
   * the same identity back, switched on again.
   */
  async deleteUser(caller: ScimCaller, userId: string): Promise<ScimResult<{ deactivated: true; sessionsEnded: number }>> {
    const known = await this.human(caller, userId);
    if (!known.ok) return known;

    const deactivated = await this.deprovision(caller, known.value.id, "a directory deleted this identity");
    if (!deactivated.ok) return deactivated;

    return { ok: true, value: { deactivated: true, sessionsEnded: deactivated.value.sessionsEnded } };
  }

  /* -------------------------------------------------------------- groups */

  async listGroups(
    caller: ScimCaller,
    params: URLSearchParams,
  ): Promise<ScimResult<ScimListResponse<ScimGroupResource>>> {
    const query = parseScimQuery(params);
    if (query.error) return { ok: false, error: query.error };
    if (query.filter && query.filter.attribute !== "displayName") {
      return { ok: false, error: scimError(400, "Groups may only be filtered on displayName.", "invalidFilter") };
    }

    const groups = (await this.store.listGroups(caller.organizationId))
      .filter((group) => !query.filter || group.displayName === query.filter.value)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    const resources = await Promise.all(groups.map((group) => this.groupResource(caller, group)));
    return { ok: true, value: scimPage(resources, { startIndex: query.startIndex, count: query.count }) };
  }

  async getGroup(caller: ScimCaller, groupId: string): Promise<ScimResult<ScimGroupResource>> {
    const found = await this.store.findGroup(caller.organizationId, groupId);
    if (!found) return { ok: false, error: scimError(404, "That group does not exist.") };
    return { ok: true, value: await this.groupResource(caller, found) };
  }

  /**
   * Create a group, with its members.
   *
   * A group is directory membership and nothing else: it changes **no** authorization
   * decision in v1 — roles and attribute-based policy are the rest of S1, and until
   * they land, membership is recorded, auditable and ready for them. Saying that here
   * is the point; a group that silently appeared to grant something would be worse
   * than one that plainly does not yet.
   */
  async createGroup(caller: ScimCaller, body: unknown): Promise<ScimResult<ScimGroupResource>> {
    const displayName = scimGroupName(body);
    if (typeof displayName !== "string") return { ok: false, error: displayName };

    if (await this.store.findGroupByName(caller.organizationId, displayName)) {
      return { ok: false, error: scimError(409, "A group with that name already exists.", "uniqueness") };
    }

    const now = this.ids.now();
    const group: ScimGroupRecord = {
      id: this.ids.id(),
      organizationId: caller.organizationId,
      displayName,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.insertGroup(group);

    const members = membersOf(body);
    if (members.length > 0) {
      const checked = await this.requireMembers(caller, members);
      if (!checked.ok) return checked;
      await this.store.addMembers(caller.organizationId, group.id, checked.value);
    }

    await this.append(caller.organizationId, caller.actor.id, "scim.group.create", "Group", group.id, {
      displayName: group.displayName,
      members: members.length,
    });
    return { ok: true, value: await this.groupResource(caller, group) };
  }

  async patchGroup(caller: ScimCaller, groupId: string, body: unknown): Promise<ScimResult<ScimGroupResource>> {
    const found = await this.store.findGroup(caller.organizationId, groupId);
    if (!found) return { ok: false, error: scimError(404, "That group does not exist.") };

    const parsed = parseScimPatch(body);
    if ("status" in parsed) return { ok: false, error: parsed };

    let group = found;
    for (const change of parsed.changes) {
      if (change.name === "displayName") {
        const name = String(change.value);
        const clash = await this.store.findGroupByName(caller.organizationId, name);
        if (clash && clash.id !== group.id) {
          return { ok: false, error: scimError(409, "A group with that name already exists.", "uniqueness") };
        }
        group = { ...group, displayName: name, updatedAt: this.ids.now() };
        await this.store.updateGroup(group);
        continue;
      }
      if (change.name === "members") {
        const wanted = (change.value as string[] | null) ?? [];
        if (wanted.length === 0) {
          // An empty list on a `remove` is "remove everybody"; on a `replace` it is
          // the same request. Both are legal and both are loud on the chain.
          const existing = await this.store.listMembers(caller.organizationId, group.id);
          await this.store.removeMembers(caller.organizationId, group.id, existing.map((entry) => entry.identityId));
          await this.append(caller.organizationId, caller.actor.id, "scim.group.members", "Group", group.id, {
            removed: existing.length,
          });
          continue;
        }
        const checked = await this.requireMembers(caller, wanted);
        if (!checked.ok) return checked;
        const existing = new Set((await this.store.listMembers(caller.organizationId, group.id)).map((entry) => entry.identityId));
        const adding = checked.value.filter((id) => !existing.has(id));
        const removing = checked.value.filter((id) => existing.has(id));
        // An operation with no path on `members` means "these are the members"; one
        // with a path filter names a single member. `replace` with a value list is the
        // union the connectors actually send, so it adds rather than clearing.
        if (adding.length > 0) await this.store.addMembers(caller.organizationId, group.id, adding);
        await this.append(caller.organizationId, caller.actor.id, "scim.group.members", "Group", group.id, {
          added: adding.length,
          alreadyPresent: removing.length,
        });
        continue;
      }
      return { ok: false, error: scimError(400, `A group has no “${change.name}” attribute.`, "invalidPath") };
    }

    return { ok: true, value: await this.groupResource(caller, group) };
  }

  /** Delete a group. Membership, unlike an identity's history, is not evidence. */
  async deleteGroup(caller: ScimCaller, groupId: string): Promise<ScimResult<{ deleted: true }>> {
    const found = await this.store.findGroup(caller.organizationId, groupId);
    if (!found) return { ok: false, error: scimError(404, "That group does not exist.") };

    await this.store.removeGroup(caller.organizationId, groupId);
    await this.append(caller.organizationId, caller.actor.id, "scim.group.delete", "Group", groupId, {
      displayName: found.displayName,
    });
    return { ok: true, value: { deleted: true } };
  }

  /* ---------------------------------------------------------- discovery */

  /**
   * What this server supports, said truthfully.
   *
   * A connector configures itself from this document, so every field here is a claim
   * that has to be true: `patch` is supported, `put` is supported, `filter` names the
   * single operator it understands, and `bulk` and `changePassword` are absent rather
   * than advertised and refused. There is no `etag`: an identity's version is not
   * something a directory needs from us, and claiming one would make every conditional
   * request fail closed for no benefit.
   */
  serviceProviderConfig(): Record<string, unknown> {
    return {
      schemas: [SCIM_SERVICE_CONFIG_SCHEMA],
      // A link that resolves: the project's own README carries the SCIM section.
      documentationUri: "https://github.com/innotelinc/OnTrak/blob/main/ontrak-sentinel/README.md",
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: SCIM_PAGE_MAX },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: "oauthbearertoken",
          name: "Provisioning token",
          description: "A token minted in the Sentinel console, sent as `Authorization: Bearer …`.",
          primary: true,
        },
      ],
      meta: {
        resourceType: "ServiceProviderConfig",
        location: `${this.root()}${SCIM_ENDPOINTS.serviceProviderConfig}`,
      },
    };
  }

  /** The two resources this server exposes: Users and Groups. */
  resourceTypes(): Record<string, unknown> {
    const resource = (name: string, endpoint: string, schema: string) => ({
      schemas: [SCIM_RESOURCE_TYPE_SCHEMA],
      id: name,
      name,
      endpoint,
      description: `${name} as OnTrak Sentinel stores them.`,
      schema,
      schemaExtensions: name === "User" ? [{ schema: SCIM_ENTERPRISE_USER_SCHEMA, required: false }] : [],
      meta: { resourceType: "ResourceType", location: `${this.root()}${SCIM_ENDPOINTS.resourceTypes}/${name}` },
    });

    return {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: 2,
      itemsPerPage: 2,
      startIndex: 1,
      Resources: [resource("User", "/Users", SCIM_USER_SCHEMA), resource("Group", "/Groups", SCIM_GROUP_SCHEMA)],
    };
  }

  /** The schemas themselves, as the core ones and nothing invented. */
  schemas(): Record<string, unknown> {
    const document = (id: string, name: string, attributes: unknown[]) => ({
      schemas: [SCIM_SCHEMA_SCHEMA],
      id,
      name,
      description: `${name}, as implemented here.`,
      attributes,
      meta: { resourceType: "Schema", location: `${this.root()}${SCIM_ENDPOINTS.schemas}/${name}` },
    });

    return {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: 2,
      itemsPerPage: 2,
      startIndex: 1,
      Resources: [
        document(SCIM_USER_SCHEMA, "User", [
          { name: "userName", type: "string", required: true, mutability: "readWrite", uniqueness: "server" },
          { name: "displayName", type: "string", required: false, mutability: "readWrite" },
          { name: "externalId", type: "string", required: false, mutability: "readWrite" },
          { name: "active", type: "boolean", required: false, mutability: "readWrite" },
          {
            name: "roles",
            type: "complex",
            multiValued: true,
            required: false,
            mutability: "readWrite",
            subAttributes: [{ name: "value", type: "string", mutability: "readWrite" }],
          },
        ]),
        document(SCIM_GROUP_SCHEMA, "Group", [
          { name: "displayName", type: "string", required: true, mutability: "readWrite" },
          {
            name: "members",
            type: "complex",
            multiValued: true,
            required: false,
            mutability: "readWrite",
            subAttributes: [
              { name: "value", type: "string", mutability: "readWrite" },
              { name: "display", type: "string", mutability: "readOnly" },
            ],
          },
        ]),
      ],
    };
  }

  /* ----------------------------------------------------------- internals */

  /**
   * Apply a set of changes to one identity.
   *
   * Every attribute goes through the spine, and the two that mean something beyond a
   * field — a role change and deactivation — go through the paths that carry the rule
   * with them. `mfaEnrolled` is deliberately not reachable from here: enrolling a
   * factor is not a directory's business, and a connector that could clear it would be
   * a connector that could lock somebody out.
   */
  private async apply(
    caller: ScimCaller,
    identity: IdentityRecord,
    changes: ScimAttribute[],
  ): Promise<ScimResult<{ identity: IdentityRecord; sessionsEnded: number }>> {
    const profile: Record<string, unknown> = {};
    let role: string | null = null;
    let active: boolean | null = null;

    for (const change of changes) {
      switch (change.name) {
        case "userName":
          profile.identifier = String(change.value);
          break;
        case "displayName":
          profile.displayName = String(change.value);
          break;
        case "externalId":
          profile.externalId = change.value === null ? null : String(change.value);
          break;
        case "role":
          role = change.value === null ? null : String(change.value);
          break;
        case "active":
          active = change.value === true;
          break;
        default:
          return { ok: false, error: scimError(400, `“${change.name}” is not a user attribute.`, "invalidPath") };
      }
    }

    let current = identity;
    if (Object.keys(profile).length > 0 || role !== null) {
      const updated = await this.spine.updateIdentity(caller.actor, identity.id, {
        ...(profile as { identifier?: string; displayName?: string; externalId?: string | null }),
        ...(role === null ? {} : { role: roleFromScim(role) ?? undefined }),
      });
      if (!updated.ok) return { ok: false, error: asScimError(updated.error) };
      current = updated.value;
    }

    if (active === false) {
      const deactivated = await this.deprovision(caller, current.id, "a directory deactivated this identity");
      if (!deactivated.ok) return deactivated;
      return { ok: true, value: { identity: deactivated.value.identity, sessionsEnded: deactivated.value.sessionsEnded } };
    }
    if (active === true && !current.active) {
      const switched = await this.spine.setActive(caller.actor, current.id, true);
      if (!switched.ok) return { ok: false, error: asScimError(switched.error) };
      current = switched.value;
    }

    return { ok: true, value: { identity: current, sessionsEnded: 0 } };
  }

  /**
   * Switch an identity off and take away what it holds.
   *
   * Three steps, and the third is the one that is easy to leave out: deactivate
   * through the spine (which the last-administrator rule guards), end every live
   * session, and **revoke the access tokens those sessions minted** — because ending a
   * session alone leaves a token the client already holds working until it expires,
   * and an offboarded person who can still call the API is not offboarded.
   */
  private async deprovision(
    caller: ScimCaller,
    identityId: string,
    reason: string,
  ): Promise<ScimResult<{ identity: IdentityRecord; sessionsEnded: number }>> {
    const deactivated = await this.spine.setActive(caller.actor, identityId, false);
    if (!deactivated.ok) return { ok: false, error: asScimError(deactivated.error) };

    const sessions = await this.spine.listSessions(caller.actor, identityId);
    if (sessions.ok && this.tokens) {
      for (const session of sessions.value) {
        if (session.revokedAt !== null) continue;
        await this.tokens.revokeTokensForSession(caller.organizationId, session.id, this.ids.nowMs());
      }
    }

    const ended = await this.spine.revokeAllForIdentity(caller.actor, identityId, reason);
    if (!ended.ok) return { ok: false, error: asScimError(ended.error) };

    const groups = await this.store.listMembershipsForIdentity(caller.organizationId, identityId);
    await this.append(caller.organizationId, caller.actor.id, "scim.deprovision", "Identity", identityId, {
      reason,
      sessionsEnded: ended.value.revoked,
      groups: groups.length,
    });

    return { ok: true, value: { identity: deactivated.value, sessionsEnded: ended.value.revoked } };
  }

  /** The human identities of the caller's organization — the SCIM user collection. */
  private async humans(caller: ScimCaller): Promise<IdentityRecord[]> {
    const listed = await this.spine.listIdentities(caller.actor);
    if (!listed.ok) return [];
    return listed.value.filter((identity) => identity.kind === "HUMAN");
  }

  /** One human. A service identity is *absent* here, not forbidden — see the module note. */
  private async human(caller: ScimCaller, identityId: string): Promise<ScimResult<IdentityRecord>> {
    const found = await this.spine.identity(caller.actor, identityId);
    if (!found.ok) return { ok: false, error: asScimError(found.error) };
    if (found.value.kind !== "HUMAN") {
      return { ok: false, error: scimError(404, "That user does not exist.") };
    }
    return { ok: true, value: found.value };
  }

  private async storeTokenIdentity(caller: ScimCaller, externalId: string): Promise<IdentityRecord | null> {
    const listed = await this.humans(caller);
    return listed.find((identity) => identity.externalId === externalId) ?? null;
  }

  /**
   * Every member id must name a human in this organization, or the whole write fails.
   *
   * Refusing the lot rather than the bad ones is deliberate: a group that quietly
   * accepted eight of ten members is a group somebody will make an access decision
   * from, and the missing two would be invisible in the answer.
   */
  private async requireMembers(caller: ScimCaller, identityIds: string[]): Promise<ScimResult<string[]>> {
    const humans = await this.humans(caller);
    const known = new Set(humans.map((identity) => identity.id));
    const unknown = identityIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      return {
        ok: false,
        error: scimError(400, `These are not users here: ${unknown.join(", ")}.`, "invalidValue"),
      };
    }
    return { ok: true, value: identityIds };
  }

  private userResource(identity: IdentityRecord): ScimUserResource {
    return toScimUser(identity, this.config.baseUrl);
  }

  private async groupResource(caller: ScimCaller, group: ScimGroupRecord): Promise<ScimGroupResource> {
    const members = await this.store.listMembers(caller.organizationId, group.id);
    const humans = await this.humans(caller);
    const byId = new Map(humans.map((identity) => [identity.id, identity]));
    // A member who is no longer here (a service identity that never was, or one that
    // was removed) is simply not rendered: the group's members are the ones that
    // resolve, and a dangling id in the response would be a lie a connector stores.
    const resolved = members
      .map((member) => byId.get(member.identityId))
      .filter((identity): identity is IdentityRecord => identity !== undefined)
      .map((identity) => ({ id: identity.id, identifier: identity.identifier }));
    return toScimGroup(group, resolved, this.config.baseUrl);
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

/** Filter a record by the one filter this server implements. */
function matchesFilter(
  identity: IdentityRecord,
  filter: { attribute: string; value: string } | null,
): boolean {
  if (!filter) return true;
  switch (filter.attribute) {
    case "userName":
      // Case-insensitively, because a directory and an address book disagree about
      // case and matching exactly is how a connector provisions a duplicate.
      return identity.identifier.toLowerCase() === filter.value.toLowerCase();
    case "externalId":
      return identity.externalId === filter.value;
    case "displayName":
      return identity.displayName === filter.value;
    case "id":
      return identity.id === filter.value;
    default:
      return false;
  }
}

/** The member ids a create body carries, if any. */
function membersOf(body: unknown): string[] {
  const members = (body as { members?: unknown } | null)?.members;
  if (!Array.isArray(members)) return [];
  return members
    .map((entry) =>
      typeof entry === "string" ? entry : ((entry as { value?: unknown } | null)?.value as string | undefined),
    )
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

/* -------------------------------------------------------------------------- */
/*  In-memory stores, for tests and the in-memory dev provider                */
/* -------------------------------------------------------------------------- */

export class MemoryScimStore implements ScimStore {
  private readonly tokens = new Map<string, ScimTokenRecord>();
  private readonly groups = new Map<string, ScimGroupRecord>();
  private readonly members = new Map<string, Set<string>>();

  async insertToken(record: ScimTokenRecord): Promise<void> {
    this.tokens.set(record.id, structuredClone(record));
  }

  async findTokenByHash(tokenHash: string): Promise<ScimTokenRecord | null> {
    const found = [...this.tokens.values()].find((entry) => entry.tokenHash === tokenHash);
    return found ? structuredClone(found) : null;
  }

  async listTokens(organizationId: string): Promise<ScimTokenRecord[]> {
    return [...this.tokens.values()]
      .filter((entry) => entry.organizationId === organizationId)
      .map((entry) => structuredClone(entry));
  }

  async updateToken(record: ScimTokenRecord): Promise<void> {
    this.tokens.set(record.id, structuredClone(record));
  }

  async listGroups(organizationId: string): Promise<ScimGroupRecord[]> {
    return [...this.groups.values()]
      .filter((entry) => entry.organizationId === organizationId)
      .map((entry) => structuredClone(entry));
  }

  async findGroup(organizationId: string, groupId: string): Promise<ScimGroupRecord | null> {
    const found = this.groups.get(groupId);
    return found && found.organizationId === organizationId ? structuredClone(found) : null;
  }

  async findGroupByName(organizationId: string, displayName: string): Promise<ScimGroupRecord | null> {
    const found = [...this.groups.values()].find(
      (entry) => entry.organizationId === organizationId && entry.displayName === displayName,
    );
    return found ? structuredClone(found) : null;
  }

  async insertGroup(record: ScimGroupRecord): Promise<void> {
    this.groups.set(record.id, structuredClone(record));
  }

  async updateGroup(record: ScimGroupRecord): Promise<void> {
    this.groups.set(record.id, structuredClone(record));
  }

  async removeGroup(organizationId: string, groupId: string): Promise<void> {
    const found = this.groups.get(groupId);
    if (!found || found.organizationId !== organizationId) return;
    this.groups.delete(groupId);
    this.members.delete(groupId);
  }

  async listMembers(organizationId: string, groupId: string): Promise<ScimGroupMemberRecord[]> {
    const group = await this.findGroup(organizationId, groupId);
    if (!group) return [];
    return [...(this.members.get(groupId) ?? [])].map((identityId) => ({ groupId, identityId }));
  }

  async addMembers(organizationId: string, groupId: string, identityIds: string[]): Promise<void> {
    const group = await this.findGroup(organizationId, groupId);
    if (!group) return;
    const current = this.members.get(groupId) ?? new Set<string>();
    for (const id of identityIds) current.add(id);
    this.members.set(groupId, current);
  }

  async removeMembers(organizationId: string, groupId: string, identityIds: string[]): Promise<void> {
    const group = await this.findGroup(organizationId, groupId);
    if (!group) return;
    const current = this.members.get(groupId) ?? new Set<string>();
    for (const id of identityIds) current.delete(id);
    this.members.set(groupId, current);
  }

  async listMembershipsForIdentity(organizationId: string, identityId: string): Promise<ScimGroupMemberRecord[]> {
    const groups = await this.listGroups(organizationId);
    return groups
      .filter((group) => (this.members.get(group.id) ?? new Set<string>()).has(identityId))
      .map((group) => ({ groupId: group.id, identityId }));
  }
}
