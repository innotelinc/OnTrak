/**
 * Identity rules (M2): a tenant's IdP connection, role mapping, MFA enforcement
 * and SCIM provisioning.
 *
 * Local passwords are the M0 fallback. From M2 a staff member signs in through
 * the tenant's IdP, and what arrives is a set of claims — not a session. This
 * module is the whole decision about those claims, kept pure so the same
 * functions back the sign-in path, the SCIM path and their tests:
 *
 *  - **Which roles may sign in where.** `authorizeSignIn` checks the issuer, the
 *    email domain and — when the connection demands it — that the IdP actually
 *    asserted MFA. It refuses with a reason, and every refusal is a decision
 *    someone can review.
 *  - **What role they get.** `mapRole` walks the configured group→role mappings
 *    and falls back to the connection's default. The mapping is configuration,
 *    not code, so an org chart change is not a deploy.
 *  - **What SCIM does to a user.** `planScimProvision` turns an incoming SCIM
 *    user into exactly one create/update/deactivate — the same plan shape the
 *    ticket service uses, so the write is auditable and testable.
 *
 * Nothing here talks to an IdP. A service decides what to persist; this decides
 * what the claims mean.
 */

import { ROLES, isRole, type Role } from "./access-rules";

export type IdentityProtocol = "OIDC" | "SAML";
export const IDENTITY_PROTOCOLS: readonly IdentityProtocol[] = ["OIDC", "SAML"];

/* -------------------------------------------------------------------------- */
/*  Connection configuration                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A mapping from one value of a claims field to a Tix role. The value match is
 * case-insensitive, because IdPs disagree about the case of group names.
 */
export interface RoleMapping {
  /** The claim to read; defaults to `groups`. */
  claim?: string;
  /** Case-insensitive match against the claim's value(s). */
  value: string;
  role: Role;
}

export interface IdentityConnection {
  id: string;
  tenantId: string;
  protocol: IdentityProtocol;
  /** OIDC issuer / SAML IdP entity id. */
  issuer: string;
  /** The public client id. The secret never lands in this record. */
  clientId: string;
  /** Extra scopes to request (e.g. `groups`). */
  scopes: readonly string[];
  /** Email domains allowed to sign in through this connection. Empty = any. */
  allowedDomains: readonly string[];
  /** The role for a user no mapping matched. */
  defaultRole: Role;
  roleMappings: readonly RoleMapping[];
  /** Refuse a sign-in that did not assert a second factor. */
  mfaRequired: boolean;
  /** Whether SCIM is allowed to provision and deprovision this tenant. */
  scimEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The admin-supplied fields of a connection; identity and timestamps are derived. */
export type IdentityConnectionInput = Omit<IdentityConnection, "id" | "tenantId" | "createdAt" | "updatedAt">;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Validate a connection before it is stored. Returns every problem, not the first. */
export function validateIdentityConnection(input: Partial<IdentityConnectionInput>): string[] {
  const issues: string[] = [];

  if (input.protocol && !IDENTITY_PROTOCOLS.includes(input.protocol)) {
    issues.push(`Unknown identity protocol "${input.protocol}".`);
  }
  if (!input.issuer?.trim()) issues.push("An issuer is required.");
  else if (!isHttpUrl(input.issuer.trim())) issues.push("The issuer must be an absolute http(s) URL.");

  if (!input.clientId?.trim()) issues.push("A client id is required.");

  if (input.defaultRole && !isRole(input.defaultRole)) {
    issues.push(`Unknown default role "${input.defaultRole}".`);
  }
  // A requester may hold a ticket, but staff roles are what an IdP provisions;
  // still, any of the four is a legitimate mapping target.
  for (const mapping of input.roleMappings ?? []) {
    if (!mapping.value?.trim()) issues.push("A role mapping needs a claim value.");
    if (!isRole(mapping.role)) issues.push(`Unknown role "${mapping.role}" in a mapping.`);
  }
  for (const domain of input.allowedDomains ?? []) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.trim())) issues.push(`"${domain}" is not a valid email domain.`);
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/*  Claims                                                                    */
/* -------------------------------------------------------------------------- */

/** What an IdP asserts about a user, normalized away from protocol specifics. */
export interface IdentityClaims {
  /** The issuer that signed the assertion; must match the connection. */
  issuer: string;
  /** The IdP's stable subject id. */
  subject: string;
  email: string;
  name?: string;
  /** Values of the group/role claim, if the IdP provides one. */
  groups?: readonly string[];
  /** Any other raw claims, so a mapping can name its own field. */
  claims?: Record<string, unknown>;
  /** Authentication method references (`amr`), e.g. `["pwd","otp"]`. */
  amr?: readonly string[];
  /** An explicit assertion that a second factor was used. */
  mfa?: boolean;
}

/** Normalize an email to what the user table stores. */
export function normalizeIdentityEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The domain part of an email, lower-cased. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).trim().toLowerCase();
}

/** A case-insensitive membership test for the allowed-domain list. */
export function isDomainAllowed(connection: IdentityConnection, email: string): boolean {
  if (connection.allowedDomains.length === 0) return true;
  const domain = emailDomain(email);
  return connection.allowedDomains.some((allowed) => allowed.trim().toLowerCase() === domain);
}

/**
 * The second-factor evidence an IdP can assert. `amr` values vary, so the set is
 * deliberately generous, and an explicit `mfa: true` claim always counts.
 */
const MFA_AMR = /\b(?:mfa|otp|hwk|totp|webauthn|fido2?|u2f|sms|phone|pop|swk)\b/i;

/** Whether the assertion carries evidence of a second factor. */
export function assertedMfa(claims: IdentityClaims): boolean {
  if (claims.mfa === true) return true;
  return (claims.amr ?? []).some((method) => MFA_AMR.test(method));
}

/* -------------------------------------------------------------------------- */
/*  Role mapping                                                              */
/* -------------------------------------------------------------------------- */

function claimValues(claims: IdentityClaims, claim: string | undefined): readonly string[] {
  const name = (claim ?? "groups").trim();
  if (name === "groups") return claims.groups ?? [];
  const raw = claims.claims?.[name];
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === "string");
  if (typeof raw === "string") return [raw];
  return [];
}

/** The first mapping that matches, or `null` when none does. */
export function matchingRoleMapping(connection: IdentityConnection, claims: IdentityClaims): RoleMapping | null {
  for (const mapping of connection.roleMappings) {
    const wanted = mapping.value.trim().toLowerCase();
    if (wanted.length === 0) continue;
    const values = claimValues(claims, mapping.claim);
    if (values.some((value) => String(value).trim().toLowerCase() === wanted)) return mapping;
  }
  return null;
}

/** The role a sign-in gets: the first matching mapping, else the default. */
export function mapRole(connection: IdentityConnection, claims: IdentityClaims): Role {
  return matchingRoleMapping(connection, claims)?.role ?? connection.defaultRole;
}

/* -------------------------------------------------------------------------- */
/*  Sign-in authorization                                                     */
/* -------------------------------------------------------------------------- */

export type SignInAuthorization =
  | { ok: true; email: string; subject: string; role: Role; mapped: boolean }
  | { ok: false; reason: string };

/**
 * Decide whether a set of claims may sign in, and as what.
 *
 * Refusals are ordered from the most structural (wrong IdP) to the most
 * specific, so the reason a caller sees is the most useful one.
 */
export function authorizeSignIn(connection: IdentityConnection, claims: IdentityClaims): SignInAuthorization {
  if (claims.issuer.trim() !== connection.issuer.trim()) {
    return { ok: false, reason: "The assertion was not issued by this tenant's identity provider." };
  }
  const email = normalizeIdentityEmail(claims.email ?? "");
  if (!email || !email.includes("@")) return { ok: false, reason: "The assertion carried no usable email address." };
  if (!isDomainAllowed(connection, email)) {
    return { ok: false, reason: `"${emailDomain(email)}" is not an allowed sign-in domain for this tenant.` };
  }
  if (connection.mfaRequired && !assertedMfa(claims)) {
    return { ok: false, reason: "This tenant requires multi-factor authentication; the assertion did not assert it." };
  }
  const mapping = matchingRoleMapping(connection, claims);
  return { ok: true, email, subject: claims.subject, role: mapping?.role ?? connection.defaultRole, mapped: mapping !== null };
}

/* -------------------------------------------------------------------------- */
/*  SCIM provisioning                                                         */
/* -------------------------------------------------------------------------- */

/** The subset of a SCIM User resource the desk acts on. */
export interface ScimUser {
  /** The IdP's stable user id (`externalId`). */
  externalId: string;
  /** Usually the email (`userName`). */
  userName: string;
  displayName?: string;
  active: boolean;
  groups?: readonly string[];
}

/** What the desk already holds for a SCIM-provisioned user. */
export interface ScimTargetUser {
  id: string;
  externalId: string | null;
  email: string;
  displayName: string;
  role: Role;
  active: boolean;
}

export type ScimAction = "CREATE" | "UPDATE" | "DEACTIVATE" | "NOOP";

export interface ScimPlan {
  action: ScimAction;
  reason: string;
  email: string;
  displayName: string;
  role: Role;
  externalId: string;
  active: boolean;
}

/** The role a SCIM group list implies, through the connection's mappings. */
export function scimRole(connection: IdentityConnection, groups: readonly string[] | undefined): Role {
  return mapRole(connection, { issuer: connection.issuer, subject: "", email: "", groups });
}

/**
 * Plan the one write a SCIM push implies.
 *
 * A deactivation request wins over everything else — deprovisioning has to be
 * immediate and unconditional — and a user who was already inactive is a `NOOP`
 * so a repeated push does not rewrite history. Otherwise a known user is updated
 * (role included, because the org chart moves) and an unknown one is created.
 */
export function planScimProvision(
  connection: IdentityConnection,
  incoming: ScimUser,
  existing: ScimTargetUser | null,
): ScimPlan {
  const email = normalizeIdentityEmail(incoming.userName);
  const displayName = (incoming.displayName ?? incoming.userName).trim() || email;
  const role = scimRole(connection, incoming.groups);

  if (!incoming.active) {
    const already = existing !== null && !existing.active;
    return {
      action: already ? "NOOP" : "DEACTIVATE",
      reason: already ? "The user is already deprovisioned." : "The IdP deprovisioned this user.",
      email,
      displayName,
      role,
      externalId: incoming.externalId,
      active: false,
    };
  }

  if (!existing) {
    return {
      action: "CREATE",
      reason: "The IdP provisioned a new user.",
      email,
      displayName,
      role,
      externalId: incoming.externalId,
      active: true,
    };
  }

  const unchanged =
    existing.email === email &&
    existing.displayName === displayName &&
    existing.role === role &&
    existing.externalId === incoming.externalId &&
    existing.active;
  if (unchanged) {
    return {
      action: "NOOP",
      reason: "The user already matches the IdP.",
      email,
      displayName,
      role,
      externalId: incoming.externalId,
      active: true,
    };
  }

  return {
    action: "UPDATE",
    reason: "The IdP changed this user's details or role.",
    email,
    displayName,
    role,
    externalId: incoming.externalId,
    active: true,
  };
}

/** The roles a connection is allowed to hand out, for a config UI. */
export function assignableRoles(): readonly Role[] {
  return ROLES;
}

/* -------------------------------------------------------------------------- */
/*  Config text (the admin form)                                              */
/* -------------------------------------------------------------------------- */

/** Split a comma- or newline-separated field into trimmed, non-empty entries. */
export function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export interface RoleMappingParse {
  mappings: RoleMapping[];
  errors: string[];
}

/**
 * Parse the one-mapping-per-line form the admin UI edits:
 *
 * ```
 * helpdesk=AGENT
 * roles:it-leads=DISPATCHER
 * ```
 *
 * A `<claim>:` prefix selects the claim to read (default `groups`); the value
 * after `=` is the Tix role. Blank lines and `#` comments are ignored, and every
 * problem is reported rather than silently dropped — a mapping that quietly does
 * nothing is worse than one that refuses to save.
 */
export function parseRoleMappings(text: string): RoleMappingParse {
  const mappings: RoleMapping[] = [];
  const errors: string[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const equals = line.lastIndexOf("=");
    if (equals <= 0 || equals === line.length - 1) {
      errors.push(`"${line}" is not in the form value=ROLE.`);
      continue;
    }
    const role = line.slice(equals + 1).trim().toUpperCase();
    if (!isRole(role)) {
      errors.push(`"${line}" names an unknown role.`);
      continue;
    }
    const left = line.slice(0, equals).trim();
    const colon = left.indexOf(":");
    const claim = colon > 0 ? left.slice(0, colon).trim() : "";
    const value = (colon > 0 ? left.slice(colon + 1) : left).trim();
    if (value === "") {
      errors.push(`"${line}" has no claim value to match.`);
      continue;
    }
    mappings.push({ ...(claim ? { claim } : {}), value, role });
  }

  return { mappings, errors };
}

/** Render mappings back into the editable text form. */
export function formatRoleMappings(mappings: readonly RoleMapping[]): string {
  return mappings.map((mapping) => `${mapping.claim ? `${mapping.claim}:` : ""}${mapping.value}=${mapping.role}`).join("\n");
}
