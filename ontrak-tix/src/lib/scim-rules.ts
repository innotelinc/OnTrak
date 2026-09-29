/**
 * Outbound SCIM rules: the desk telling the identity provider who works here.
 *
 * OnTrak Tix already *accepts* SCIM — `planScimProvision` in `identity-rules.ts`
 * turns an inbound push into one create/update/deactivate, which is the direction
 * an IdP drives. This module is the other direction, and it exists because of how
 * the family is actually deployed: **the desk is where the people are.** An
 * administrator adds an agent in Tix; nobody wants to add them a second time in
 * the provider's console, and a deployment where the two disagree is one where
 * somebody who left still has an identity at the IdP.
 *
 * Pure: no fetch, no database, no clock. Every decision — whether a person needs
 * pushing at all, and what the push looks like on the wire — is a function here,
 * so the whole sync is testable without a provider.
 *
 * Three choices stated out loud:
 *
 *  - **A person is matched by `externalId` first, then by `userName`.** Tix's
 *    account id is the stable key, so somebody changing their name at the desk
 *    moves the provider's identity rather than creating a second one — the same
 *    reasoning `Identity.externalId` exists for on the receiving end.
 *  - **Roles are deliberately not pushed.** Sentinel issues its own roles
 *    (ADMIN / AGENT / AUDITOR), Tix has a different set, and any mapping between
 *    them silently grants or removes *privilege* at the provider as a side effect
 *    of a desk edit. Provisioning answers "who exists and may they sign in"; the
 *    provider's console stays the one place that decides what they may do there.
 *  - **A push that changes nothing is a `NOOP`.** A sync run over a hundred people
 *    should write nothing at all on a quiet day, so the provider's audit trail
 *    stays a record of changes rather than of polling.
 */

import type { IdentityUser } from "./identity-service";

export const SCIM_USERS_PATH = "/scim/v2/Users";

/** Where the deployment says the provider's SCIM surface is, and its token. */
export const SCIM_TARGET_ENV = {
  baseUrl: "ONTRAK_TIX_SCIM_BASE_URL",
  token: "ONTRAK_TIX_SCIM_TOKEN",
} as const;

export const SCIM_CONTENT_TYPE = "application/scim+json";
export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_MAX_PAGE = 200;

export interface ScimTarget {
  /** The provider's origin, without the SCIM path. */
  baseUrl: string;
  token: string;
}

export interface ScimTargetResult {
  /** True when the deployment asked for outbound provisioning at all. */
  enabled: boolean;
  target: ScimTarget | null;
  issues: string[];
}

/**
 * Read the deployment's provisioning target.
 *
 * Unset means off — a desk that has not been given a provider keeps working
 * exactly as before, and the console says so rather than offering a button that
 * cannot work. Half-set is an error, not a fallback: an endpoint without a token
 * would be rejected by the provider on every person, and a token without an
 * endpoint names nobody.
 */
export function scimTargetFromEnv(env: Record<string, string | undefined> = process.env): ScimTargetResult {
  const baseUrl = (env[SCIM_TARGET_ENV.baseUrl] ?? "").trim();
  const token = (env[SCIM_TARGET_ENV.token] ?? "").trim();
  if (!baseUrl && !token) return { enabled: false, target: null, issues: [] };

  const issues: string[] = [];
  if (!baseUrl) issues.push(`${SCIM_TARGET_ENV.baseUrl} is not set.`);
  if (!token) issues.push(`${SCIM_TARGET_ENV.token} is not set.`);
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        issues.push(`${SCIM_TARGET_ENV.baseUrl} must be an absolute http(s) URL.`);
      }
    } catch {
      issues.push(`${SCIM_TARGET_ENV.baseUrl} must be an absolute http(s) URL.`);
    }
  }
  if (issues.length > 0) return { enabled: true, target: null, issues };

  return { enabled: true, target: { baseUrl: baseUrl.replace(/\/+$/, ""), token }, issues: [] };
}

/** The Users collection URL, optionally filtered and paged. */
export function usersUrl(target: ScimTarget, params: { filter?: string; count?: number } = {}): string {
  const url = new URL(`${target.baseUrl}${SCIM_USERS_PATH}`);
  if (params.filter) url.searchParams.set("filter", params.filter);
  if (params.count !== undefined) url.searchParams.set("count", String(params.count));
  return url.toString();
}

/** One user resource's URL. The id is percent-encoded, so a provider-assigned id
 *  containing a slash cannot become a path traversal. */
export function userUrl(target: ScimTarget, id: string): string {
  return `${target.baseUrl}${SCIM_USERS_PATH}/${encodeURIComponent(id)}`;
}

/** The filter a lookup by a `userName` sends. Quotes are escaped, not interpolated. */
export function userNameFilter(userName: string): string {
  return `userName eq "${escapeFilterValue(userName)}"`;
}

/** The filter a lookup by Tix's own account id sends. */
export function externalIdFilter(externalId: string): string {
  return `externalId eq "${escapeFilterValue(externalId)}"`;
}

/** RFC 7644 escapes a double quote inside a filter value with a backslash. */
function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/* -------------------------------------------------------------------------- */
/*  What the provider holds, and what the desk holds                          */
/* -------------------------------------------------------------------------- */

/** A person as the provider describes them. */
export interface PersonAtProvider {
  id: string;
  userName: string;
  active: boolean;
  externalId: string | null;
}

/** The desk's account, narrowed to what provisioning cares about. */
export interface DeskPerson {
  id: string;
  email: string;
  displayName: string;
  active: boolean;
}

export function deskPerson(user: IdentityUser): DeskPerson {
  return { id: user.id, email: user.email, displayName: user.displayName, active: user.active };
}

/**
 * A SCIM user for a person.
 *
 * Every field is named; nothing is spread from the account row. `externalId` is
 * Tix's own id, so the next sync recognises the person even after their address
 * changed, and `roles` is absent on purpose — see the note at the top of this
 * file.
 */
export function personBody(person: DeskPerson): Record<string, unknown> {
  return {
    schemas: [SCIM_USER_SCHEMA],
    externalId: person.id,
    userName: person.email,
    name: { formatted: person.displayName },
    displayName: person.displayName,
    active: person.active,
  };
}

/** The `PATCH` that switches somebody off — the shape Entra and Okta both send. */
export function deactivatePatch(): Record<string, unknown> {
  return {
    schemas: [SCIM_PATCH_SCHEMA],
    Operations: [{ op: "replace", path: "active", value: false }],
  };
}

/* -------------------------------------------------------------------------- */
/*  The plan                                                                  */
/* -------------------------------------------------------------------------- */

export type ScimPushAction = "CREATE" | "REPLACE" | "DEACTIVATE" | "NOOP";

export interface ScimPush {
  action: ScimPushAction;
  reason: string;
}

/**
 * Decide the one write a person implies.
 *
 * A deactivation wins over everything: somebody who has left the desk must not
 * keep an identity at the provider because a display name also changed. A person
 * the provider does not have is created, even when they are inactive — an account
 * that never existed needs no push, but a *bootstrap* of a former colleague who
 * is still in the desk's history would otherwise be retried on every sync.
 * (It is created switched off, which is the honest representation.)
 */
export function planScimPush(person: DeskPerson, existing: PersonAtProvider | null): ScimPush {
  if (!person.active) {
    if (!existing) return { action: "NOOP", reason: "The provider never had this person, and they are off." };
    return existing.active
      ? { action: "DEACTIVATE", reason: "The person is no longer active at the desk." }
      : { action: "NOOP", reason: "The person is already switched off at the provider." };
  }

  if (!existing) return { action: "CREATE", reason: "The provider does not have this person yet." };

  const unchanged =
    existing.userName === person.email &&
    existing.externalId === person.id &&
    existing.active;
  if (unchanged) return { action: "NOOP", reason: "The provider already matches the desk." };

  // Either a detail moved or the account was switched off at the provider. The
  // desk is the system of record for its own people, so an active person is
  // replaced as active — a provider-side deactivation of somebody who still works
  // here is exactly the drift this sync exists to close.
  return {
    action: "REPLACE",
    reason: existing.active ? "The person's details changed at the desk." : "The person is switched off at the provider but active here.",
  };
}

/* -------------------------------------------------------------------------- */
/*  Responses                                                                 */
/* -------------------------------------------------------------------------- */

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A SCIM user resource, narrowed. Returns `null` when it is not one. */
export function parseUserResource(value: unknown): PersonAtProvider | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = stringField(raw.id);
  const userName = stringField(raw.userName);
  if (!id || !userName) return null;
  return {
    id,
    userName,
    active: raw.active !== false,
    externalId: stringField(raw.externalId),
  };
}

/** A SCIM ListResponse's resources, or `null` when the body is not one. */
export function parseUserList(value: unknown): PersonAtProvider[] | null {
  if (typeof value !== "object" || value === null) return null;
  const resources = (value as { Resources?: unknown }).Resources;
  if (!Array.isArray(resources)) return null;
  return resources.map(parseUserResource).filter((entry): entry is PersonAtProvider => entry !== null);
}

/**
 * The message a provider's refusal carries.
 *
 * RFC 7644 puts it in `detail`, and the `scimType` beside it says *why* —
 * `uniqueness` and `invalidValue` are different futures for a sync, one of which
 * a person resolves and one of which never will work. Both are surfaced, because
 * an operator reading "409" alone learns nothing.
 */
export function scimErrorDetail(value: unknown, status: number): string {
  if (typeof value === "object" && value !== null) {
    const raw = value as Record<string, unknown>;
    const detail = stringField(raw.detail) ?? stringField(raw.message);
    const scimType = stringField(raw.scimType);
    if (detail) return scimType ? `${detail} (${scimType})` : detail;
  }
  return `The identity provider refused the request with status ${status}.`;
}
