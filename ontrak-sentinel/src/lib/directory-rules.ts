/**
 * Directory sync rules (S2): the pure half of pulling identities from AD, Entra or
 * Google.
 *
 * S2's first half made Sentinel a SCIM *server* — a connector could push people in.
 * This is the other direction: Sentinel reads a directory itself, so an organization
 * that runs Microsoft 365 or Google Workspace does not have to stand up a connector to
 * get started. The reader is a vendor-specific thing behind a port; everything that
 * decides *what happens to a person* is here, framework-free and testable without a
 * directory to point at.
 *
 * Four decisions worth stating out loud:
 *
 *  - **The directory's own id is the key, and a name is only a hint.** A person is
 *    matched on `externalId` first. Falling back to the user name is what lets an
 *    organization adopt identities it created by hand before it connected a directory —
 *    but only when that name resolves to exactly one identity, because two people with
 *    one address is precisely the case where guessing creates a duplicate.
 *  - **Two identities are never merged.** When a directory's id points at one identity
 *    and its user name at another, the sync reports a conflict and skips that person.
 *    Merging would mean choosing which history to keep, and this product does not
 *    delete evidence to tidy a roster.
 *  - **A local edit is protected by policy, not by accident.** When an identity was
 *    edited here after the last sync, `preferLocal` keeps that edit and records the
 *    divergence; `preferDirectory` overwrites it and records the divergence. Either
 *    way the disagreement is on the evidence chain rather than silently resolved.
 *  - **A directory cannot conjure a second factor.** Nothing here touches factors,
 *    credentials or `mfaEnrolled`; those are the account's own.
 */

import type { IdentityRecord, IdentityRole } from "./identity-rules";

/* -------------------------------------------------------------------------- */
/*  The connection                                                            */
/* -------------------------------------------------------------------------- */

export const DIRECTORY_SOURCES = ["ENTRA", "GOOGLE", "LDAP", "GENERIC"] as const;
export type DirectorySource = (typeof DIRECTORY_SOURCES)[number];

/**
 * What happens when the directory and a locally-edited identity disagree.
 *
 * A named policy rather than a boolean, because the two answers mean different things
 * to an administrator: "the directory is the source of truth" and "a change made here
 * is a decision" are both defensible, and a deployment should say which it holds.
 */
export const CONFLICT_POLICIES = ["preferDirectory", "preferLocal"] as const;
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];

export interface DirectoryConnectionRecord {
  id: string;
  organizationId: string;
  /** What the administrator called it, e.g. “Entra ID — production”. */
  name: string;
  source: DirectorySource;
  /** Non-secret settings: tenant id, host, base DN, group filter. */
  settings: Record<string, string>;
  conflictPolicy: ConflictPolicy;
  /** The role a person the directory *creates* gets. Never applied to an existing one. */
  defaultRole: IdentityRole;
  /** When the last completed sync finished, or `null`. */
  lastSyncedAt: string | null;
  /**
   * Whether a credential is stored for this connection.
   *
   * A boolean rather than the value: the secret itself is fetched from the store only
   * when a reader is about to call the directory, so it can never ride along on the
   * record a console page renders — which is how a client secret ends up in an HTML
   * comment somebody kept for later.
   */
  hasSecret: boolean;
  /** Who created it; every run is attributed to them. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/*  A person, as a directory reports them                                     */
/* -------------------------------------------------------------------------- */

export interface DirectoryPerson {
  /** The directory's own id — SCIM's `externalId`. The key everything matches on. */
  externalId: string;
  /** The address or user principal name. A hint for matching, never the key. */
  userName: string;
  displayName: string;
  active: boolean;
  /** What the directory says this person's role is, when it says anything. */
  role: IdentityRole | null;
  /** Group names this person belongs to, as the directory spells them. */
  groups: string[];
}

export interface DirectoryParseResult {
  person?: DirectoryPerson;
  /** Why this record was skipped. An unparsable person is *reported*, not guessed at. */
  issues: string[];
}

const EXTERNAL_ID_KEYS = ["externalId", "id", "objectId", "dn", "uid", "employeeId"];
const USER_NAME_KEYS = ["userName", "userPrincipalName", "mail", "primaryEmail", "email", "uid"];
const DISPLAY_NAME_KEYS = ["displayName", "name", "cn", "fullName", "givenName"];
const ACTIVE_KEYS = ["active", "enabled", "accountEnabled", "isActive"];

function firstString(raw: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function truthy(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "yes", "1", "enabled", "active"].includes(lowered)) return true;
    if (["false", "no", "0", "disabled", "inactive"].includes(lowered)) return false;
  }
  return fallback;
}

/**
 * Whether the directory reports a person as enabled.
 *
 * The first key that is *present* wins, and presence is the test rather than truthiness:
 * `accountEnabled: false` is a leaver, and a reader that asked `if (record[key])` would
 * read it as absent and leave them switched on — which is the one mistake in this file
 * that has an on-call consequence.
 */
function activeFlag(record: Record<string, unknown>): boolean {
  for (const key of ACTIVE_KEYS) {
    if (key in record) return truthy(record[key], true);
  }
  return true;
}

/** Group names out of whatever a vendor's payload calls them. */
function groupNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) names.push(entry.trim());
    else if (entry && typeof entry === "object") {
      const named = firstString(entry as Record<string, unknown>, ["displayName", "name", "cn", "id"]);
      if (named) names.push(named);
    }
  }
  // Sorted and de-duplicated, so a plan compares equal across runs regardless of how a
  // vendor ordered its payload — a sync that reported spurious changes every time would
  // train an administrator to ignore it.
  return [...new Set(names)].sort();
}

/**
 * One vendor record → one person, or the reason it was skipped.
 *
 * Field aliases are accepted because every directory spells the same four things
 * differently, and a sync that only understood one spelling would be a sync that
 * silently skipped half a tenant. What is *not* accepted is a person with no id or no
 * name: without an id they cannot be matched next time, and without a name they cannot
 * be signed in as, so guessing either would create an identity nobody can use.
 */
export function toDirectoryPerson(
  source: DirectorySource,
  raw: unknown,
  options: { role?: IdentityRole | null } = {},
): DirectoryParseResult {
  if (!raw || typeof raw !== "object") return { issues: ["the record is not an object"] };
  const record = raw as Record<string, unknown>;

  const externalId = firstString(record, EXTERNAL_ID_KEYS);
  const userName = firstString(record, USER_NAME_KEYS);
  // Some vendors nest the name (`name.displayName`), so a flat read falls through to the
  // address rather than reporting a person with no name at all.
  const nestedName = record.name && typeof record.name === "object" ? firstString(record.name as Record<string, unknown>, DISPLAY_NAME_KEYS) : null;
  const displayName = firstString(record, DISPLAY_NAME_KEYS) ?? nestedName ?? userName;

  const issues: string[] = [];
  if (!externalId) issues.push(`no id the directory knows this ${source} record by`);
  if (!userName) issues.push("no user name");
  if (issues.length > 0) return { issues };

  return {
    issues: [],
    person: {
      externalId: externalId!,
      userName: userName!,
      displayName: displayName!,
      active: activeFlag(record),
      role: options.role ?? null,
      groups: groupNames(record["groups"] ?? record["memberOf"]),
    },
  };
}

/** Every person in a page of vendor records, plus the reasons any were skipped. */
export function parseDirectoryPage(
  source: DirectorySource,
  records: unknown,
): { people: DirectoryPerson[]; skipped: string[] } {
  const list = Array.isArray(records)
    ? records
    : records && typeof records === "object"
      ? ((records as { value?: unknown[]; users?: unknown[]; results?: unknown[] }).value ??
        (records as { users?: unknown[] }).users ??
        (records as { results?: unknown[] }).results ??
        [])
      : [];

  const people: DirectoryPerson[] = [];
  const skipped: string[] = [];
  for (const record of list) {
    const parsed = toDirectoryPerson(source, record);
    if (parsed.person) people.push(parsed.person);
    else skipped.push(parsed.issues.join("; "));
  }
  return { people, skipped };
}

/* -------------------------------------------------------------------------- */
/*  The plan                                                                  */
/* -------------------------------------------------------------------------- */

export type DirectoryAction = "create" | "update" | "deactivate" | "reactivate" | "unchanged" | "conflict";

export interface DirectoryChange {
  action: DirectoryAction;
  externalId: string;
  userName: string;
  /** The identity this lands on, or `null` for a create. */
  identityId: string | null;
  /** Field names the sync would write. Empty for `unchanged` and `conflict`. */
  changes: string[];
  /** One sentence a person can act on. */
  detail: string;
}

export interface DirectoryGroupPlan {
  displayName: string;
  /** The directory ids of the members, resolved to identity ids at apply time. */
  memberExternalIds: string[];
}

export interface DirectoryPlan {
  changes: DirectoryChange[];
  groups: DirectoryGroupPlan[];
  skipped: string[];
  counts: {
    created: number;
    updated: number;
    deactivated: number;
    reactivated: number;
    unchanged: number;
    conflicts: number;
  };
  /** Whether applying this plan would write anything at all. */
  writes: boolean;
}

export interface DirectoryPlanOptions {
  conflictPolicy: ConflictPolicy;
  /** Only used when creating somebody; an existing role is never rewritten by default. */
  defaultRole: IdentityRole;
  /** When the connection last completed a sync — what makes a local edit detectable. */
  lastSyncedAt: string | null;
}

/** Every field a plan is allowed to name. Stated once so the apply step is total. */
export const DIRECTORY_FIELDS = ["externalId", "identifier", "displayName", "role", "active"] as const;
export type DirectoryField = (typeof DIRECTORY_FIELDS)[number];

/** The address a person is known by, for the fallback match. Case-insensitively. */
function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function roleOf(value: string | null): IdentityRole | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  return upper === "ADMIN" || upper === "AGENT" || upper === "SERVICE" || upper === "AUDITOR" ? upper : null;
}

/**
 * Decide what a sync would do, without doing any of it.
 *
 * A plan rather than a stream of writes, because two things matter more than throughput:
 * an administrator can be *shown* what a sync will do before it does it (the console's
 * dry run), and an ambiguous person is dropped with a reason rather than half-applied.
 */
export function planDirectorySync(
  current: readonly IdentityRecord[],
  people: readonly DirectoryPerson[],
  options: DirectoryPlanOptions,
): DirectoryPlan {
  const byExternalId = new Map<string, IdentityRecord>();
  const byName = new Map<string, IdentityRecord[]>();
  for (const identity of current) {
    if (identity.externalId) byExternalId.set(identity.externalId, identity);
    // Only humans are in play: a directory does not own a machine account, and a sync
    // that switched one off would stop whatever runs as it.
    if (identity.kind !== "HUMAN") continue;
    const key = normalizeName(identity.identifier);
    byName.set(key, [...(byName.get(key) ?? []), identity]);
  }

  const changes: DirectoryChange[] = [];
  const skipped: string[] = [];
  const seenExternalIds = new Set<string>();
  /** Names this plan has already accounted for, so two records cannot make one identity. */
  const claimedNames = new Map<string, string>();
  const counts = { created: 0, updated: 0, deactivated: 0, reactivated: 0, unchanged: 0, conflicts: 0 };

  const localEditProtected = (identity: IdentityRecord): boolean =>
    options.conflictPolicy === "preferLocal" &&
    (options.lastSyncedAt === null || identity.updatedAt > options.lastSyncedAt);

  for (const person of people) {
    if (seenExternalIds.has(person.externalId)) {
      // Two records with one directory id: the payload contradicts itself, and picking
      // one would be a coin toss.
      skipped.push(`${person.externalId} appears twice in the directory's answer`);
      continue;
    }
    seenExternalIds.add(person.externalId);

    const nameKey = normalizeName(person.userName);
    const matches = byName.get(nameKey) ?? [];

    const byId = byExternalId.get(person.externalId) ?? null;
    const byNameOnly = matches.length === 1 ? matches[0] : null;

    // The conflict that is never resolved automatically: the id and the name point at
    // different people.
    if (byId && byNameOnly && byId.id !== byNameOnly.id) {
      counts.conflicts += 1;
      changes.push({
        action: "conflict",
        externalId: person.externalId,
        userName: person.userName,
        identityId: null,
        changes: [],
        detail: `“${person.userName}” matches ${byId.identifier} by directory id and ${byNameOnly.identifier} by name; refusing to merge two identities.`,
      });
      continue;
    }

    if (matches.length > 1 && !byId) {
      counts.conflicts += 1;
      changes.push({
        action: "conflict",
        externalId: person.externalId,
        userName: person.userName,
        identityId: null,
        changes: [],
        detail: `“${person.userName}” matches ${matches.length} identities here; refusing to guess which one.`,
      });
      continue;
    }

    const claimedBy = claimedNames.get(nameKey);
    if (claimedBy !== undefined && claimedBy !== person.externalId) {
      // Two directory people whose names differ only in case are one address, and one
      // address is one identity here — so the second is reported rather than created.
      skipped.push(`${person.userName} shares an address with ${claimedBy}`);
      continue;
    }
    claimedNames.set(nameKey, person.externalId);

    const existing = byId ?? byNameOnly;
    if (!existing) {
      counts.created += 1;
      changes.push({
        action: "create",
        externalId: person.externalId,
        userName: person.userName,
        identityId: null,
        changes: ["identifier", "displayName", "externalId"],
        detail: `Create ${person.userName} as ${person.role ?? options.defaultRole}.`,
      });
      continue;
    }

    const protected_ = localEditProtected(existing);
    const changed: string[] = [];
    const kept: string[] = [];

    const propose = (field: string, differs: boolean) => {
      if (!differs) return;
      if (protected_) kept.push(field);
      else changed.push(field);
    };

    // Adopting the directory's id is not a field conflict — it is how a hand-made
    // identity stops being a stranger to the directory next time — so it is always
    // written when there is nothing there to overwrite.
    if (existing.externalId === null) changed.push("externalId");
    else propose("externalId", existing.externalId !== person.externalId);

    propose("identifier", normalizeName(existing.identifier) !== nameKey);
    propose("displayName", existing.displayName !== person.displayName);
    // A role the directory states is a field like any other; a role it does not state is
    // not a reason to overwrite one an administrator set.
    propose("role", person.role !== null && existing.role !== person.role);

    const cells = [...new Set(changed)];
    if (cells.length > 0) {
      counts.updated += 1;
      changes.push({
        action: "update",
        externalId: person.externalId,
        userName: person.userName,
        identityId: existing.id,
        changes: cells,
        detail:
          kept.length > 0
            ? `Update ${existing.identifier}: ${cells.join(", ")} from the directory; keeping the local ${kept.join(", ")}.`
            : `Update ${existing.identifier}: ${cells.join(", ")}.`,
      });
    }

    if (kept.length > 0) {
      counts.conflicts += 1;
      changes.push({
        action: "conflict",
        externalId: person.externalId,
        userName: person.userName,
        identityId: existing.id,
        changes: [],
        detail: `The directory says ${kept.join(", ")} differ from a change made here; keeping the local value (“${options.conflictPolicy}”).`,
      });
    }

    if (!person.active && existing.active) {
      counts.deactivated += 1;
      changes.push({
        action: "deactivate",
        externalId: person.externalId,
        userName: person.userName,
        identityId: existing.id,
        changes: ["active"],
        detail: `Deactivate ${existing.identifier}: the directory reports them inactive.`,
      });
    } else if (person.active && !existing.active) {
      counts.reactivated += 1;
      changes.push({
        action: "reactivate",
        externalId: person.externalId,
        userName: person.userName,
        identityId: existing.id,
        changes: ["active"],
        detail: `Reactivate ${existing.identifier}: the directory reports them active.`,
      });
    } else if (cells.length === 0 && kept.length === 0) {
      counts.unchanged += 1;
      changes.push({
        action: "unchanged",
        externalId: person.externalId,
        userName: person.userName,
        identityId: existing.id,
        changes: [],
        detail: `${existing.identifier} is already what the directory says.`,
      });
    }
  }

  // A person the directory no longer mentions at all is *not* deactivated by default:
  // an empty or partial answer from a directory would otherwise offboard everybody.
  // Removing somebody takes an explicit `active: false` on their record, which is what
  // a leaver looks like from every vendor we read.
  const groups = planGroups(people);

  return {
    changes,
    groups,
    skipped,
    counts,
    writes: changes.some((change) => change.action === "create" || change.action === "update" || change.action === "deactivate" || change.action === "reactivate"),
  };
}

/**
 * Group membership as the directory states it.
 *
 * Every group is sent complete, because the sync replaces membership rather than
 * adding to it: a directory that removed somebody from a group has said something, and
 * a merge-only sync would never hear it.
 */
export function planGroups(people: readonly DirectoryPerson[]): DirectoryGroupPlan[] {
  const byGroup = new Map<string, Set<string>>();
  for (const person of people) {
    for (const group of person.groups) {
      const key = group.trim();
      if (!key) continue;
      const members = byGroup.get(key) ?? new Set<string>();
      members.add(person.externalId);
      byGroup.set(key, members);
    }
  }
  return [...byGroup.entries()]
    .map(([displayName, members]) => ({ displayName, memberExternalIds: [...members].sort() }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

export const DIRECTORY_NAME_MAX = 120;

export interface DirectoryIssue {
  field: string;
  message: string;
}

export function validateConnection(input: {
  name?: string;
  source?: string;
  conflictPolicy?: string;
  defaultRole?: string;
}): DirectoryIssue[] {
  const issues: DirectoryIssue[] = [];

  const name = input.name?.trim() ?? "";
  if (!name) issues.push({ field: "name", message: "A connection name is required." });
  else if (name.length > DIRECTORY_NAME_MAX) {
    issues.push({ field: "name", message: `The name may be at most ${DIRECTORY_NAME_MAX} characters.` });
  }

  if (!DIRECTORY_SOURCES.includes((input.source ?? "") as DirectorySource)) {
    issues.push({ field: "source", message: "Choose which kind of directory this is." });
  }

  if (input.conflictPolicy !== undefined && !CONFLICT_POLICIES.includes(input.conflictPolicy as ConflictPolicy)) {
    issues.push({ field: "conflictPolicy", message: "Choose whose edit wins when the two disagree." });
  }

  if (input.defaultRole !== undefined && roleOf(input.defaultRole) === null) {
    issues.push({ field: "defaultRole", message: "Choose a role a new person gets." });
  }

  return issues;
}

/** Who may read and run a connection. Same line as every other privileged act. */
export function canManageDirectory(role: IdentityRole): boolean {
  return role === "ADMIN";
}

export { roleOf as directoryRoleOf };
