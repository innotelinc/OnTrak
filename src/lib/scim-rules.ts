/**
 * SCIM 2.0 rules: directory sync, as pure decisions.
 *
 * Single sign-on answers "who is this person, and do they already exist?". It does
 * not answer the question every organisation asks next: **who makes the accounts
 * exist at all?** Until now, on this side: an administrator, by hand, or a CSV
 * roster somebody maintains. This module is the pure half of the other answer —
 * SCIM 2.0, which is the shape Entra, Okta and Google already speak — so the
 * directory that owns a person's name, address and class can push those facts here
 * instead of a spreadsheet being re-uploaded.
 *
 * Five decisions worth stating out loud, because each is somewhere a
 * half-implementation looks finished and is wrong:
 *
 *  - **The filter parser accepts a declared subset and refuses the rest by name.**
 *    RFC 7644's grammar is large (`co`, `sw`, `pr`, `gt`, `and`, `or`, parentheses,
 *    bracket expressions). A sync engine sends exactly one shape —
 *    `userName eq "..."`, sometimes `externalId eq "..."` — and a parser that
 *    half-implements the rest is worse than one that refuses it: it silently drops a
 *    clause and answers a narrower question while looking like a success. Anything
 *    outside the subset is `invalidFilter`, which a connector reports as a
 *    configuration problem rather than a directory that is quietly missing people.
 *  - **The projection is an allowlist, never a spread.** `toScimUser` names every
 *    field it emits. A `passwordHash` sits on the user row today, and a spread here
 *    would publish it to every connected directory the day somebody adds a column.
 *    An omission is visible in a diff; a leak is not.
 *  - **`active: false` is deprovisioning, and denial is not deletion.** Deleting a
 *    SCIM user here would take their attempts, certificates and audit trail with it —
 *    the entire point of the product is that training evidence cannot be deleted.
 *    `DELETE /Users/{id}` therefore deactivates, exactly like `PATCH active:false`.
 *  - **A class is not invented from a group push.** A cohort is owned by an
 *    instructor here and carries a join code a person chose. A `POST /Groups` naming
 *    a class nobody owns would create a class with no teacher, so it is refused with
 *    a reason rather than obeyed — the same rule the CSV roster applies to an
 *    unrecognised cohort name.
 *  - **A user created here has no local password**, exactly like one provisioned by
 *    the identity provider: the directory says who exists, not what their secret is.
 *
 * Pure on purpose — no fetch, no database, no `next/headers` — so every refusal is
 * testable without a directory, and so the live routes are only wiring. The cookie
 * names and the root path live here for the same reason they do elsewhere: a test
 * that looks for a `Location` header cannot import a `server-only` module to find out
 * what to look for.
 */

import type { Role } from "@prisma/client";

import { ROSTER_ROLES } from "./csv-rules";

/* -------------------------------------------------------------------------- */
/*  The wire shape                                                            */
/* -------------------------------------------------------------------------- */

/** SCIM's root below this deployment's API base. */
export const SCIM_ROOT = "/api/scim/v2";

/** The endpoints relative to the root, spelled once so the routes and tests agree. */
export const SCIM_ENDPOINTS = {
  users: "/Users",
  groups: "/Groups",
  serviceProviderConfig: "/ServiceProviderConfig",
} as const;

export const SCIM_PATHS = {
  users: `${SCIM_ROOT}${SCIM_ENDPOINTS.users}`,
  groups: `${SCIM_ROOT}${SCIM_ENDPOINTS.groups}`,
  serviceProviderConfig: `${SCIM_ROOT}${SCIM_ENDPOINTS.serviceProviderConfig}`,
} as const;

/** `application/scim+json` is the media type RFC 7644 asks for. */
export const SCIM_CONTENT_TYPE = "application/scim+json";

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_ENTERPRISE_USER_SCHEMA = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
export const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCIM_SERVICE_CONFIG_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";

/** A page of results. SCIM's ceiling, not ours; a caller may ask for less. */
export const SCIM_PAGE_MAX = 200;
export const SCIM_PAGE_DEFAULT = 100;

/** The roles this deployment issues, which is exactly the roster's vocabulary. */
export const SCIM_ROLES: readonly Role[] = ROSTER_ROLES;

/** A class name, as a group's display name, may be at most this long. */
export const SCIM_GROUP_NAME_MAX = 80;

/* -------------------------------------------------------------------------- */
/*  Errors                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The mismatch kinds a connector actually branches on.
 *
 * `uniqueness` means "somebody already has that user name" and is fixed by a person
 * looking at the directory; `invalidValue` is a value the *directory* sent wrongly.
 * Collapsing them into one `400` is how a sync engine retries forever against a
 * conflict it will never resolve.
 */
export type ScimType =
  | "invalidFilter"
  | "invalidPath"
  | "invalidValue"
  | "invalidSyntax"
  | "uniqueness"
  | "mutability"
  | "noTarget"
  | "tooMany";

export interface ScimError {
  status: number;
  detail: string;
  scimType?: ScimType;
}

export function scimError(status: number, detail: string, scimType?: ScimType): ScimError {
  return scimType === undefined ? { status, detail } : { status, detail, scimType };
}

/* -------------------------------------------------------------------------- */
/*  Attribute paths                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Attribute paths as different directories spell them.
 *
 * The same attribute arrives three ways and all three are correct: `userName`,
 * `urn:ietf:params:scim:schemas:core:2.0:User:userName` (what Entra sends) and, for
 * a group, `members`. Stripping the *known* schema prefix is the whole conversion;
 * an unknown URN is left whole, so it lands in a refusal rather than being silently
 * mistaken for a core attribute.
 */
export function normalizeScimPath(raw: string): string {
  const path = raw.trim();
  const prefixes = [`${SCIM_USER_SCHEMA}:`, `${SCIM_ENTERPRISE_USER_SCHEMA}:`, `${SCIM_GROUP_SCHEMA}:`];
  for (const prefix of prefixes) {
    if (path.toLowerCase().startsWith(prefix.toLowerCase())) return path.slice(prefix.length);
  }
  return path;
}

/* -------------------------------------------------------------------------- */
/*  Filters and reads                                                         */
/* -------------------------------------------------------------------------- */

/** The attributes a lookup may name. Others are refused, not ignored. */
export const SCIM_FILTER_ATTRIBUTES = ["userName", "externalId", "displayName", "id"] as const;
export type ScimFilterAttribute = (typeof SCIM_FILTER_ATTRIBUTES)[number];

export interface ScimFilter {
  attribute: ScimFilterAttribute;
  operator: "eq";
  value: string;
}

/**
 * Parse one filter expression, or refuse it.
 *
 * The subset is `eq` on a declared attribute and nothing else: no boolean operators,
 * no parentheses, no comparison beyond equality. `and` is refused deliberately even
 * though a connector might send it, because honouring only the first clause of one
 * would answer a narrower question than was asked while looking like a success.
 */
export function parseScimFilter(text: string | null | undefined): ScimFilter | ScimError {
  const raw = (text ?? "").trim();
  if (!raw) return scimError(400, "A filter is required.", "invalidFilter");

  // The attribute token may carry a schema URN (`…:2.0:User:userName`), which is
  // what Entra sends, so `:` is part of a path here.
  const match = /^([A-Za-z][A-Za-z0-9._:]*)\s+([A-Za-z]{2})\s+"([^"]*)"$/.exec(raw);
  if (!match) {
    return scimError(
      400,
      `This server understands “attribute eq "value"” and nothing else; “${raw}” is not that.`,
      "invalidFilter",
    );
  }

  const [, name, operator, value] = match;
  if (operator.toLowerCase() !== "eq") {
    return scimError(400, `Only the “eq” operator is supported; “${operator}” is not.`, "invalidFilter");
  }

  const attribute = normalizeScimPath(name);
  if (!(SCIM_FILTER_ATTRIBUTES as readonly string[]).includes(attribute)) {
    return scimError(
      400,
      `“${name}” cannot be filtered on. The directory may filter on ${SCIM_FILTER_ATTRIBUTES.join(", ")}.`,
      "invalidFilter",
    );
  }

  return { attribute: attribute as ScimFilterAttribute, operator: "eq", value };
}

function intParam(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export interface ScimQuery {
  filter: ScimFilter | null;
  startIndex: number | null;
  count: number | null;
  error: ScimError | null;
}

/** Read a query string into the three parameters a listing may carry. */
export function parseScimQuery(params: URLSearchParams): ScimQuery {
  const rawFilter = params.get("filter");
  let filter: ScimFilter | null = null;
  if (rawFilter !== null) {
    const parsed = parseScimFilter(rawFilter);
    if ("status" in parsed) return { filter: null, startIndex: null, count: null, error: parsed };
    filter = parsed;
  }

  const startIndex = intParam(params.get("startIndex"));
  const count = intParam(params.get("count"));
  if (startIndex !== null && startIndex < 1) {
    return { filter, startIndex: null, count: null, error: scimError(400, "startIndex starts at 1.", "invalidValue") };
  }
  if (count !== null && count < 0) {
    return { filter, startIndex, count: null, error: scimError(400, "count cannot be negative.", "invalidValue") };
  }
  return { filter, startIndex, count, error: null };
}

/* -------------------------------------------------------------------------- */
/*  A SCIM user and a SCIM group                                              */
/* -------------------------------------------------------------------------- */

export interface ScimName {
  formatted: string;
}

export interface ScimMeta {
  resourceType: string;
  created: string;
  lastModified: string;
  location: string;
}

export interface ScimUserResource {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name: ScimName;
  displayName: string;
  active: boolean;
  roles: { value: Role; primary: boolean }[];
  meta: ScimMeta;
}

export interface ScimGroupResource {
  schemas: string[];
  id: string;
  displayName: string;
  members: { value: string; display: string; type: "User" }[];
  meta: ScimMeta;
}

/** The user row a projection reads, named explicitly rather than spread. */
export interface ScimUserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScimGroupRow {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A user as a SCIM resource.
 *
 * Every field is named; nothing is spread from the row. The row carries a
 * `passwordHash` and an `accent`, and an allowlist is what keeps them out — the
 * projection can only ever omit a field added later, and an omission shows up in a
 * diff while a leak does not.
 */
export function toScimUser(user: ScimUserRow, baseUrl: string): ScimUserResource {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    ...(user.externalId ? { externalId: user.externalId } : {}),
    userName: user.email,
    name: { formatted: user.name },
    displayName: user.name,
    active: user.active,
    roles: [{ value: user.role, primary: true }],
    meta: {
      resourceType: "User",
      created: user.createdAt,
      lastModified: user.updatedAt,
      location: `${baseUrl.replace(/\/+$/, "")}${SCIM_ENDPOINTS.users}/${user.id}`,
    },
  };
}

/** A class as a SCIM group. Members are named, so a connector can read them back. */
export function toScimGroup(
  cohort: ScimGroupRow,
  members: { userId: string; email: string }[],
  baseUrl: string,
): ScimGroupResource {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: cohort.id,
    displayName: cohort.name,
    members: members.map((member) => ({ value: member.userId, display: member.email, type: "User" as const })),
    meta: {
      resourceType: "Group",
      created: cohort.createdAt,
      lastModified: cohort.updatedAt,
      location: `${baseUrl.replace(/\/+$/, "")}${SCIM_ENDPOINTS.groups}/${cohort.id}`,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Pagination                                                                */
/* -------------------------------------------------------------------------- */

export interface ScimListResponse<T> {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

/**
 * One page of a result set.
 *
 * SCIM's `startIndex` is **1-based** and its `totalResults` counts the whole match,
 * not the page — two details that are easy to get subtly wrong and impossible to
 * notice without a directory on the other end. A `count` of zero is legal and means
 * "the total, no rows", which is how a connector asks "how many are there?".
 */
export function scimPage<T>(
  records: T[],
  input: { startIndex?: number | null; count?: number | null } = {},
): ScimListResponse<T> {
  const total = records.length;
  const start =
    Number.isFinite(input.startIndex) && (input.startIndex ?? 0) >= 1 ? Math.trunc(input.startIndex!) : 1;
  const asked =
    Number.isFinite(input.count) && input.count !== null && input.count !== undefined
      ? Math.trunc(input.count)
      : SCIM_PAGE_DEFAULT;
  const count = Math.max(0, Math.min(asked, SCIM_PAGE_MAX));

  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: total,
    startIndex: start,
    itemsPerPage: Math.min(count, Math.max(0, total - (start - 1))),
    Resources: count === 0 ? [] : records.slice(start - 1, start - 1 + count),
  };
}

/* -------------------------------------------------------------------------- */
/*  Writes: what a SCIM body has to be                                        */
/* -------------------------------------------------------------------------- */

export const SCIM_MAX_NAME = 120;
export const SCIM_MAX_USERNAME = 254;

/**
 * A created user, checked against the roster's own rules.
 *
 * Deliberately not a second validator: it reads the same fields the CSV importer
 * reads, so an address that is not an email address is refused with the same
 * sentence whether it arrived in a spreadsheet or over SCIM. A separate SCIM
 * validator would be a second answer to one question.
 */
export interface ScimUserInput {
  userName: string;
  displayName: string;
  externalId: string | null;
  active: boolean;
  role: Role;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function scimUserInput(body: unknown): ScimUserInput | ScimError {
  const resource = body as Record<string, unknown> | null;
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    return scimError(400, "A user must be a SCIM resource.", "invalidSyntax");
  }

  const userName = typeof resource.userName === "string" ? resource.userName.trim().toLowerCase() : "";
  if (!userName) return scimError(400, "userName is required.", "invalidValue");
  if (userName.length > SCIM_MAX_USERNAME || !EMAIL.test(userName)) {
    return scimError(400, "userName must be an email address.", "invalidValue");
  }

  const formatted = (resource.name as { formatted?: unknown } | undefined)?.formatted;
  const displayName =
    typeof resource.displayName === "string" && resource.displayName.trim()
      ? resource.displayName.trim()
      : typeof formatted === "string" && formatted.trim()
        ? formatted.trim()
        : userName;
  if (displayName.length > SCIM_MAX_NAME) {
    return scimError(400, `The name is longer than ${SCIM_MAX_NAME} characters.`, "invalidValue");
  }

  const rawExternal = resource.externalId;
  if (rawExternal !== undefined && rawExternal !== null && typeof rawExternal !== "string") {
    return scimError(400, "externalId must be a string.", "invalidValue");
  }

  const role = roleFromScim(resourceRole(resource));
  if (role === null) {
    return scimError(400, `role must be one of ${SCIM_ROLES.join(", ")}.`, "invalidValue");
  }

  return {
    userName,
    displayName,
    externalId: typeof rawExternal === "string" && rawExternal.trim() ? rawExternal.trim() : null,
    // A create that omits `active` creates an active user: the alternative is a
    // directory that provisions people nobody can sign in as.
    active: resource.active === undefined ? true : resource.active === true,
    role,
  };
}

/** The role a SCIM resource carries, accepting both `roles: [{value}]` and a bare string. */
function resourceRole(resource: Record<string, unknown>): string | null {
  const value = resource.roles ?? resource.role;
  if (value === undefined || value === null) return "STUDENT";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value[0] as { value?: unknown } | string | undefined;
    if (typeof first === "string") return first;
    return typeof (first as { value?: unknown } | null)?.value === "string"
      ? ((first as { value: string }).value)
      : null;
  }
  const object = value as { value?: unknown };
  return typeof object.value === "string" ? object.value : null;
}

/** A SCIM role value as this deployment's, or `null` when it is not one we issue. */
export function roleFromScim(value: string | null | undefined): Role | null {
  const wanted = (value ?? "").trim().toUpperCase();
  return SCIM_ROLES.find((role) => role === wanted) ?? null;
}

/** A class name from a group body, checked before it becomes a row. */
export function scimGroupName(body: unknown): string | ScimError {
  const resource = body as Record<string, unknown> | null;
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    return scimError(400, "A group must be a SCIM resource.", "invalidSyntax");
  }
  const displayName = typeof resource.displayName === "string" ? resource.displayName.trim() : "";
  if (!displayName) return scimError(400, "displayName is required.", "invalidValue");
  if (displayName.length > SCIM_GROUP_NAME_MAX) {
    return scimError(400, `A class name may be at most ${SCIM_GROUP_NAME_MAX} characters.`, "invalidValue");
  }
  return displayName;
}

/** One attribute a PATCH or a PUT changes. */
export type ScimAttributeName = "userName" | "displayName" | "externalId" | "active" | "role" | "members";

export interface ScimAttribute {
  name: ScimAttributeName;
  value: string | boolean | string[] | null;
}

/**
 * Turn a PATCH into the attributes it changes.
 *
 * Two shapes are legal and both are in use: an operation with a `path` and a scalar
 * value, and an operation with no `path` whose value is an object of attributes
 * (Entra sends the first, Okta the second). `remove` is accepted only for an
 * attribute that can meaningfully be absent — clearing a user name is not
 * provisioning, and neither is clearing the address that identifies the person.
 *
 * The refusals are the interesting half: an unknown path is `invalidPath` rather
 * than a silent no-op, because a connector that thinks it set a value and did not
 * is a directory that will disagree with this one forever without anybody being told.
 */
export function parseScimPatch(body: unknown): { changes: ScimAttribute[] } | ScimError {
  const operations = (body as { Operations?: unknown } | null)?.Operations;
  if (!Array.isArray(operations)) {
    return scimError(400, "A PATCH body must carry an Operations array.", "invalidSyntax");
  }

  const changes: ScimAttribute[] = [];
  for (const entry of operations as { op?: unknown; path?: unknown; value?: unknown }[]) {
    const op = String(entry?.op ?? "").toLowerCase();
    if (op !== "add" && op !== "replace" && op !== "remove") {
      return scimError(400, `“${entry?.op}” is not an operation. Use add, replace or remove.`, "invalidSyntax");
    }

    const rawPath = typeof entry.path === "string" && entry.path.trim() ? entry.path : null;
    const pathFilter = rawPath ? /\[value\s+eq\s+"([^"]*)"\]/.exec(rawPath) : null;
    const path = rawPath ? normalizeScimPath(rawPath.replace(/\[.*\]$/, "")) : null;

    if (!path) {
      const attributes = entry.value;
      if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
        return scimError(400, "An operation without a path must carry an object of attributes.", "invalidValue");
      }
      for (const [name, value] of Object.entries(attributes as Record<string, unknown>)) {
        const change = readScimAttribute(normalizeScimPath(name), value);
        if ("status" in change) return change;
        changes.push(change);
      }
      continue;
    }

    const value = op === "remove" ? (pathFilter ? [pathFilter[1]] : null) : entry.value;
    const change = readScimAttribute(path, value, op);
    if ("status" in change) return change;
    changes.push(change);
  }

  if (changes.length === 0) return scimError(400, "The PATCH changed nothing.", "invalidSyntax");
  return { changes };
}

/** Narrow one written attribute, or name the reason it cannot be written. */
function readScimAttribute(name: string, value: unknown, op = "replace"): ScimAttribute | ScimError {
  switch (name) {
    case "userName":
    case "identifier": {
      if (op === "remove") return scimError(400, "An account needs a user name.", "mutability");
      if (typeof value !== "string" || !value.trim()) return scimError(400, "userName must be a string.", "invalidValue");
      const userName = value.trim().toLowerCase();
      if (!EMAIL.test(userName)) return scimError(400, "userName must be an email address.", "invalidValue");
      return { name: "userName", value: userName };
    }
    case "displayName":
    case "name.formatted":
    case "name": {
      if (op === "remove") return scimError(400, "An account needs a name.", "mutability");
      const formatted =
        typeof value === "string"
          ? value
          : typeof (value as { formatted?: unknown } | null)?.formatted === "string"
            ? (value as { formatted: string }).formatted
            : null;
      if (formatted === null || !formatted.trim()) {
        return scimError(400, "name.formatted must be a string.", "invalidValue");
      }
      return { name: "displayName", value: formatted.trim() };
    }
    case "externalId": {
      if (op === "remove" || value === null) return { name: "externalId", value: null };
      if (typeof value !== "string") return scimError(400, "externalId must be a string.", "invalidValue");
      return { name: "externalId", value: value.trim() || null };
    }
    case "active": {
      if (op === "remove") return scimError(400, "active cannot be removed; set it to false.", "mutability");
      if (typeof value !== "boolean") return scimError(400, "active must be true or false.", "invalidValue");
      return { name: "active", value };
    }
    case "roles":
    case "role": {
      if (op === "remove" || value === null) return { name: "role", value: null };
      const candidate = Array.isArray(value) ? (value[0] as { value?: unknown } | string | undefined) : value;
      const role = typeof candidate === "string" ? candidate : ((candidate as { value?: unknown })?.value as string | undefined);
      const parsed = roleFromScim(role);
      if (!parsed) return scimError(400, `“${String(role ?? "")}” is not a role this deployment issues.`, "invalidValue");
      return { name: "role", value: parsed };
    }
    case "members": {
      const values = Array.isArray(value)
        ? value.map((entry) =>
            typeof entry === "string" ? entry : ((entry as { value?: unknown } | null)?.value as string | undefined),
          )
        : null;
      if (values === null || values.some((entry) => typeof entry !== "string" || !entry)) {
        return scimError(400, "members must be a list of ids.", "invalidValue");
      }
      return { name: "members", value: values as string[] };
    }
    default:
      return scimError(400, `“${name}” is not an attribute this deployment writes.`, "invalidPath");
  }
}

/**
 * A PUT body, which **replaces** the resource rather than patching it.
 *
 * This is the one place the two write verbs genuinely differ, and getting it wrong
 * deactivates people by accident: an omitted `active` on a PUT means *active*, while
 * an omitted `active` on a PATCH means *leave it alone*. Both are the standard, and
 * both are stated here rather than inferred at the call site.
 */
export function parseScimUserReplace(body: unknown): ScimUserInput | ScimError {
  const resource = body as Record<string, unknown> | null;
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    return scimError(400, "A PUT body must be a SCIM user.", "invalidSyntax");
  }
  // Replacement semantics: absent means active, which is what the standard says and
  // what a connector testing PUT expects.
  return scimUserInput({ ...resource, active: resource.active === undefined ? true : resource.active === true });
}

/* -------------------------------------------------------------------------- */
/*  Discovery: what this server supports                                      */
/* -------------------------------------------------------------------------- */

/**
 * The Service Provider Configuration.
 *
 * It answers honestly rather than optimistically: `filter` is supported with `eq`
 * only, `patch` and `put` are supported, and `bulk`, `changePassword` and `sort` are
 * declared unsupported. A connector that reads `true` for a feature this surface does
 * not have will use it and fail on somebody's first real sync.
 */
export function serviceProviderConfig(): Record<string, unknown> {
  return {
    schemas: [SCIM_SERVICE_CONFIG_SCHEMA],
    documentationUri: "https://github.com/innotelinc/OnTrak",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SCIM_PAGE_MAX },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "Bearer token",
        description: "A provisioning token set as ONTRAK_SCIM_TOKEN on this deployment.",
        specUri: "https://www.rfc-editor.org/rfc/rfc6750",
        primary: true,
      },
    ],
    meta: {
      resourceType: "ServiceProviderConfig",
      location: SCIM_PATHS.serviceProviderConfig,
    },
  };
}
