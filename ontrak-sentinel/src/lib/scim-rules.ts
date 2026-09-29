/**
 * SCIM rules (S2): provisioning, as pure decisions.
 *
 * S0 and S1 made Sentinel issue identity — a person could sign in, and a person
 * could enrol a factor. Neither answers the question every real deployment asks
 * next: *who makes the identities exist?* Until now: an administrator, by hand, in
 * a console. This module is the pure half of the answer — SCIM 2.0 as a directory
 * speaks it, so Entra, Okta and Google can push the same facts at us instead.
 *
 * Five decisions worth stating out loud, because each is a place a
 * half-implementation would look finished and be wrong:
 *
 *  - **The filter parser accepts a declared subset and refuses the rest by name.**
 *    RFC 7644's filter grammar is large (`co`, `sw`, `pr`, `gt`, `and`, `or`,
 *    parentheses, bracket expressions). A directory's sync engine sends exactly one
 *    shape — `userName eq "..."`, sometimes `externalId eq "..."` — and a parser
 *    that half-implements the rest is worse than one that refuses it: it silently
 *    ignores a clause and returns a page that looks like a complete answer. So
 *    anything outside the subset is `invalidFilter`, which the connector reports as
 *    a configuration problem instead of a directory that is quietly missing people.
 *  - **A token, external id or user name is compared against the value, not the
 *    pattern.** SCIM has no wildcards, and a `value` that contains `%` or `_` from a
 *    user's name must not be read as a pattern by a database underneath — which is
 *    why this module produces values and the store compares them exactly.
 *  - **`active: false` is deprovisioning, and denial is not deletion.** Deleting a
 *    SCIM user would take its evidence with it — the sessions it held, the audit
 *    events naming it, the factors enrolled on it — and the whole point of this
 *    product is that history cannot be deleted. `DELETE /Users/{id}` therefore
 *    deactivates, exactly like `PATCH active=false`, and says so in the response.
 *  - **The projection is an allowlist, never a spread.** `toScimUser` names every
 *    field it emits. Sentinels identities have no password column today; the day one
 *    is added (S2's password credentials), a spread here would publish it to every
 *    connected directory. An allowlist cannot make that mistake.
 *  - **Only human identities are SCIM users.** A `SERVICE` identity is a machine
 *    account — including the one a deployment might use to run this very connector
 *    — and a provisioning push should not be able to deactivate it. The Users
 *    collection is humans; a service identity is absent from it rather than
 *    forbidden in it.
 */

import type { IdentityKind, IdentityRecord, IdentityRole } from "./identity-rules";

/* -------------------------------------------------------------------------- */
/*  The wire shape                                                            */
/* -------------------------------------------------------------------------- */

/** SCIM's root below the issuer. */
export const SCIM_ROOT = "/scim/v2";

/**
 * The endpoints relative to the root.
 *
 * The projection builds `meta.location` links from these, while the router matches on
 * the absolute `SCIM_PATHS` below. They are separate on purpose: a deployment that
 * moves the surface (a path prefix, a hostname of its own) changes the configuration's
 * base URL and nothing else, and a link a connector was given still resolves.
 */
export const SCIM_ENDPOINTS = {
  users: "/Users",
  groups: "/Groups",
  serviceProviderConfig: "/ServiceProviderConfig",
  resourceTypes: "/ResourceTypes",
  schemas: "/Schemas",
} as const;

/** Where the SCIM surface lives. Named here so the router, the console and the
 *  tests agree on one list. */
export const SCIM_PATHS = {
  users: `${SCIM_ROOT}${SCIM_ENDPOINTS.users}`,
  groups: `${SCIM_ROOT}${SCIM_ENDPOINTS.groups}`,
  serviceProviderConfig: `${SCIM_ROOT}${SCIM_ENDPOINTS.serviceProviderConfig}`,
  resourceTypes: `${SCIM_ROOT}${SCIM_ENDPOINTS.resourceTypes}`,
  schemas: `${SCIM_ROOT}${SCIM_ENDPOINTS.schemas}`,
} as const;

/** A `Bearer` token minted for a connector, before it is hashed. */
export const SCIM_TOKEN_PREFIX = "sc1_";
export const SCIM_TOKEN_BYTES = 24;
export const SCIM_LABEL_MAX = 80;

/** `application/scim+json` is the media type RFC 7644 asks for. */
export const SCIM_CONTENT_TYPE = "application/scim+json";

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_ENTERPRISE_USER_SCHEMA = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
export const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCIM_SERVICE_CONFIG_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
export const SCIM_RESOURCE_TYPE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
export const SCIM_SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";

/** A page of results. SCIM's ceiling, not ours; a caller may ask for less. */
export const SCIM_PAGE_MAX = 200;
export const SCIM_PAGE_DEFAULT = 100;

/* -------------------------------------------------------------------------- */
/*  Errors                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The mismatch kinds a connector actually branches on.
 *
 * `uniqueness` means "somebody already has that user name" and is fixed by an
 * administrator looking at the directory; `invalidValue` is a value the *directory*
 * sent wrongly. Collapsing them into one `400` is how a sync engine retries forever
 * against a conflict it will never resolve.
 */
export type ScimType =
  | "invalidFilter"
  | "invalidPath"
  | "invalidValue"
  | "invalidSyntax"
  | "uniqueness"
  | "mutability"
  | "noTarget"
  | "tooMany"
  | "sensitive";

export interface ScimError {
  status: number;
  detail: string;
  scimType?: ScimType;
}

export function scimError(status: number, detail: string, scimType?: ScimType): ScimError {
  return scimType === undefined ? { status, detail } : { status, detail, scimType };
}

/* -------------------------------------------------------------------------- */
/*  Filters                                                                   */
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

  const match = /^([A-Za-z][A-Za-z0-9._]*)\s+([A-Za-z]{2})\s+"([^"]*)"$/.exec(raw);
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

/* -------------------------------------------------------------------------- */
/*  Attribute paths                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Attribute paths as different directories spell them.
 *
 * A path arrives three ways for the same attribute and all three are correct:
 * `userName`, `urn:ietf:params:scim:schemas:core:2.0:User:userName` (what Entra
 * sends), and — for a Group's members — `members`. Stripping the *known* schema
 * prefix is the whole conversion; an unknown URN is left whole, so it lands in the
 * refusal below rather than being silently mistaken for a core attribute.
 */
export function normalizeScimPath(raw: string): string {
  const path = raw.trim();
  const prefixes = [
    `${SCIM_USER_SCHEMA}:`,
    `${SCIM_ENTERPRISE_USER_SCHEMA}:`,
    `${SCIM_GROUP_SCHEMA}:`,
  ];
  for (const prefix of prefixes) {
    if (path.toLowerCase().startsWith(prefix.toLowerCase())) return path.slice(prefix.length);
  }
  return path;
}

/** The attributes a PATCH or PUT may write, and what each one means here. */
export type ScimAttributeName = "userName" | "displayName" | "externalId" | "active" | "role" | "members";

export interface ScimAttribute {
  name: ScimAttributeName;
  value: string | boolean | string[] | null;
}

/* -------------------------------------------------------------------------- */
/*  A SCIM user, and the identity behind it                                   */
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
  roles: { value: IdentityRole; primary: boolean }[];
  meta: ScimMeta;
}

export interface ScimGroupResource {
  schemas: string[];
  id: string;
  displayName: string;
  members: { value: string; display: string; type: "User" }[];
  meta: ScimMeta;
}

/**
 * An identity as a SCIM user.
 *
 * Every field is named explicitly; nothing is spread from the record. The identity
 * has no secret column *today*, and an allowlist is what keeps that true tomorrow —
 * the projection cannot leak a field that was added to `IdentityRecord` later, it can
 * only omit it, and an omission is visible in a diff while a leak is not.
 */
export function toScimUser(identity: IdentityRecord, baseUrl: string): ScimUserResource {
  const location = `${baseUrl.replace(/\/+$/, "")}${SCIM_ENDPOINTS.users}/${identity.id}`;
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: identity.id,
    ...(identity.externalId ? { externalId: identity.externalId } : {}),
    userName: identity.identifier,
    name: { formatted: identity.displayName },
    displayName: identity.displayName,
    active: identity.active,
    roles: [{ value: identity.role, primary: true }],
    meta: {
      resourceType: "User",
      created: identity.createdAt,
      lastModified: identity.updatedAt,
      location,
    },
  };
}

/** A group as a SCIM group. Members are named, so a connector can read them back. */
export function toScimGroup(
  group: { id: string; displayName: string; createdAt: string; updatedAt: string },
  members: { id: string; identifier: string }[],
  baseUrl: string,
): ScimGroupResource {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: group.id,
    displayName: group.displayName,
    members: members.map((member) => ({ value: member.id, display: member.identifier, type: "User" as const })),
    meta: {
      resourceType: "Group",
      created: group.createdAt,
      lastModified: group.updatedAt,
      location: `${baseUrl.replace(/\/+$/, "")}${SCIM_ENDPOINTS.groups}/${group.id}`,
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
 * "the total, no rows", which is how a connector asks "how many are there?" without
 * pulling them.
 */
export function scimPage<T>(
  records: T[],
  input: { startIndex?: number | null; count?: number | null } = {},
): ScimListResponse<T> {
  const total = records.length;
  const start = Number.isFinite(input.startIndex) && (input.startIndex ?? 0) >= 1 ? Math.trunc(input.startIndex!) : 1;
  const asked = Number.isFinite(input.count) && input.count !== null && input.count !== undefined
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
/*  Reads: query parameters                                                   */
/* -------------------------------------------------------------------------- */

export interface ScimQuery {
  filter: ScimFilter | null;
  startIndex: number | null;
  count: number | null;
  /** The reply's page size when the caller asked for none. */
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

function intParam(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/* -------------------------------------------------------------------------- */
/*  Writes: PATCH and PUT                                                     */
/* -------------------------------------------------------------------------- */

export interface ScimPatchOperation {
  op?: unknown;
  path?: unknown;
  value?: unknown;
}

/**
 * Turn a PATCH into the attributes it changes.
 *
 * Two shapes are legal and both are in use: an operation with a `path` and a scalar
 * value, and an operation with no `path` whose value is an object of attributes
 * (Entra sends the first, Okta the second). `remove` is accepted only for an
 * attribute that can meaningfully be absent — clearing a second factor is not
 * provisioning, and neither is clearing a user name.
 *
 * The refusals are the interesting half: an unknown path is `invalidPath` rather
 * than a silent no-op, because a connector that thinks it set a value and did not is
 * a directory that will disagree with Sentinel forever without anyone being told.
 */
export function parseScimPatch(body: unknown): { changes: ScimAttribute[] } | ScimError {
  const operations = (body as { Operations?: unknown } | null)?.Operations;
  if (!Array.isArray(operations)) {
    return scimError(400, "A PATCH body must carry an Operations array.", "invalidSyntax");
  }

  const changes: ScimAttribute[] = [];
  for (const entry of operations as ScimPatchOperation[]) {
    const op = String(entry?.op ?? "").toLowerCase();
    if (op !== "add" && op !== "replace" && op !== "remove") {
      return scimError(400, `“${entry?.op}” is not an operation. Use add, replace or remove.`, "invalidSyntax");
    }

    const rawPath = typeof entry.path === "string" && entry.path.trim() ? entry.path : null;
    // A members path may carry a filter — `members[value eq "id"]` — which names one
    // member to remove rather than all of them.
    const pathFilter = rawPath ? /\[value\s+eq\s+"([^"]*)"\]/.exec(rawPath) : null;
    const path = rawPath ? normalizeScimPath(rawPath.replace(/\[.*\]$/, "")) : null;

    if (!path) {
      const attributes = entry.value;
      if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
        return scimError(400, "An operation without a path must carry an object of attributes.", "invalidValue");
      }
      for (const [name, value] of Object.entries(attributes as Record<string, unknown>)) {
        const change = readAttribute(normalizeScimPath(name), value);
        if ("status" in change) return change;
        changes.push(change);
      }
      continue;
    }

    const value = op === "remove" ? (pathFilter ? [pathFilter[1]] : null) : entry.value;
    const change = readAttribute(path, value, op);
    if ("status" in change) return change;
    changes.push(change);
  }

  if (changes.length === 0) return scimError(400, "The PATCH changed nothing.", "invalidSyntax");
  return { changes };
}

/** Narrow one written attribute, or name the reason it cannot be written. */
function readAttribute(name: string, value: unknown, op = "replace"): ScimAttribute | ScimError {
  switch (name) {
    case "userName":
    case "identifier": {
      if (op === "remove") return scimError(400, "An identity needs a user name.", "mutability");
      if (typeof value !== "string" || !value.trim()) return scimError(400, "userName must be a string.", "invalidValue");
      return { name: "userName", value: value.trim() };
    }
    case "displayName":
    case "name.formatted":
    case "name": {
      if (op === "remove") {
        return scimError(400, "An identity needs a display name.", "mutability");
      }
      // `name` may arrive whole — `{ "name": { "formatted": "…" } }` — which is how a
      // connector with a split first/last name sends it.
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
      // A role arrives either as `roles: [{ value: "AGENT" }]` (what Entra sends for an
      // app role) or as a bare string.
      const candidate = Array.isArray(value)
        ? (value[0] as { value?: unknown } | string | undefined)
        : value;
      const role = typeof candidate === "string" ? candidate : ((candidate as { value?: unknown })?.value as string | undefined);
      const parsed = roleFromScim(role);
      if (!parsed) {
        return scimError(400, `“${String(role ?? "")}” is not a role this server issues.`, "invalidValue");
      }
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
      return scimError(400, `“${name}” is not an attribute this server writes.`, "invalidPath");
  }
}

/** A SCIM role value as our own, or `null` when it is not one we issue. */
export function roleFromScim(value: string | null | undefined): IdentityRole | null {
  const wanted = (value ?? "").trim().toUpperCase();
  return (["ADMIN", "AGENT", "SERVICE", "AUDITOR"] as const).find((role) => role === wanted) ?? null;
}

/**
 * A PUT body, which **replaces** the resource rather than patching it.
 *
 * This is the one place the two write verbs genuinely differ, and getting it wrong
 * deactivates people by accident: an omitted `active` on a PUT means *active*, while
 * an omitted `active` on a PATCH means *leave it alone*. Both are the standard, and
 * both are stated here rather than inferred at the call site.
 */
export function parseScimUserReplace(body: unknown): { changes: ScimAttribute[] } | ScimError {
  const resource = body as Record<string, unknown> | null;
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    return scimError(400, "A PUT body must be a SCIM user.", "invalidSyntax");
  }

  const userName = resource.userName;
  if (typeof userName !== "string" || !userName.trim()) {
    return scimError(400, "userName is required.", "invalidValue");
  }
  const formatted = (resource.name as { formatted?: unknown } | undefined)?.formatted;
  const displayName =
    typeof resource.displayName === "string" && resource.displayName.trim()
      ? resource.displayName.trim()
      : typeof formatted === "string" && formatted.trim()
        ? formatted.trim()
        : userName.trim();

  const changes: ScimAttribute[] = [
    { name: "userName", value: userName.trim() },
    { name: "displayName", value: displayName },
    // Replacement semantics: absent means active, which is what the standard says and
    // what a connector testing `PUT` expects.
    { name: "active", value: resource.active === undefined ? true : resource.active === true },
  ];

  if ("externalId" in resource) {
    const externalId = resource.externalId;
    if (externalId !== null && typeof externalId !== "string") {
      return scimError(400, "externalId must be a string.", "invalidValue");
    }
    changes.push({ name: "externalId", value: (externalId as string | null) ?? null });
  }
  if ("roles" in resource) {
    const roles = resource.roles;
    const candidate = Array.isArray(roles) ? (roles[0] as { value?: unknown } | undefined)?.value : roles;
    if (candidate !== undefined && candidate !== null) {
      const role = roleFromScim(typeof candidate === "string" ? candidate : null);
      if (!role) return scimError(400, "That is not a role this server issues.", "invalidValue");
      changes.push({ name: "role", value: role });
    }
  }
  return { changes };
}

/* -------------------------------------------------------------------------- */
/*  What a SCIM user has to be                                                */
/* -------------------------------------------------------------------------- */

export interface ScimUserInput {
  userName: string;
  displayName: string;
  externalId: string | null;
  active: boolean;
}

/**
 * A created user, checked against the spine's own rules.
 *
 * Deliberately not a second validator: it projects a SCIM body onto the input
 * `validateIdentity` already judges, so a user name that is not an email address is
 * refused with the same sentence whether it arrived from the console or from a
 * directory. A separate SCIM validator would be a second answer to one question.
 */
export function scimUserInput(body: unknown, kind: IdentityKind = "HUMAN"): ScimUserInput | ScimError {
  const resource = body as Record<string, unknown> | null;
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    return scimError(400, "A user must be a SCIM resource.", "invalidSyntax");
  }

  const userName = typeof resource.userName === "string" ? resource.userName.trim() : "";
  if (!userName) return scimError(400, "userName is required.", "invalidValue");

  const formatted = (resource.name as { formatted?: unknown } | undefined)?.formatted;
  const displayName =
    typeof resource.displayName === "string" && resource.displayName.trim()
      ? resource.displayName.trim()
      : typeof formatted === "string" && formatted.trim()
        ? formatted.trim()
        : userName;

  const rawExternal = resource.externalId;
  if (rawExternal !== undefined && rawExternal !== null && typeof rawExternal !== "string") {
    return scimError(400, "externalId must be a string.", "invalidValue");
  }

  return {
    userName,
    displayName,
    externalId: typeof rawExternal === "string" && rawExternal.trim() ? rawExternal.trim() : null,
    // A create that omits `active` creates an active user: the alternative is a
    // directory that provisions people nobody can sign in as.
    active: resource.active === undefined ? true : resource.active === true,
  };
}

/** A group's display name, checked before it becomes a row. */
export function scimGroupName(body: unknown): string | ScimError {
  const resource = body as Record<string, unknown> | null;
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    return scimError(400, "A group must be a SCIM resource.", "invalidSyntax");
  }
  const displayName = typeof resource.displayName === "string" ? resource.displayName.trim() : "";
  if (!displayName) return scimError(400, "displayName is required.", "invalidValue");
  if (displayName.length > SCIM_GROUP_NAME_MAX) {
    return scimError(400, `A group name may be at most ${SCIM_GROUP_NAME_MAX} characters.`, "invalidValue");
  }
  return displayName;
}

export const SCIM_GROUP_NAME_MAX = 120;

/* -------------------------------------------------------------------------- */
/*  Tokens                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether a string is even worth hashing and looking up.
 *
 * The same shape check the public API in Tix uses: a request that is not carrying our
 * prefix cannot be a token, so it is refused before it reaches the database. Without
 * it, every unauthenticated request is a query.
 */
/**
 * How many characters base64url spends on a given number of bytes.
 *
 * The shape check and the mint have to agree on this, and the first version of this
 * file did not: it asked for `bytes * 2` characters — the length *hex* would be —
 * while the mint encodes base64url, so every token the server issued failed its own
 * check and every connector was refused. The suites missed it because they wrote
 * their own fixtures at the length the check wanted. Both now derive from one number,
 * and `tests/sentinel-scim.test.ts` asserts the generator's output passes the guard,
 * which is the test that would have caught it.
 */
function base64UrlChars(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}

/** The shortest string the mint can produce, prefix aside. */
export const SCIM_TOKEN_BODY_MIN = base64UrlChars(SCIM_TOKEN_BYTES);

export function looksLikeScimToken(raw: string): boolean {
  return new RegExp(`^${SCIM_TOKEN_PREFIX}[A-Za-z0-9_-]{${SCIM_TOKEN_BODY_MIN},}$`).test(raw.trim());
}

/** The label a token is listed under — its own when it has one, its prefix otherwise. */
export function scimTokenLabel(token: { label: string | null; tokenHash: string }): string {
  return token.label && token.label.trim() ? token.label.trim() : `${token.tokenHash.slice(0, 8)}…`;
}

export function validateScimTokenLabel(label: string | null): string | null {
  const wanted = (label ?? "").trim();
  if (!wanted) return null;
  if (wanted.length > SCIM_LABEL_MAX) return wanted.slice(0, SCIM_LABEL_MAX);
  return wanted;
}
