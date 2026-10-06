/**
 * Single sign-on rules: the pure half of an OIDC handshake.
 *
 * The training app is a *relying party* — it does not hold a directory. OnTrak
 * Sentinel (or any OpenID Connect provider: Authentik, Entra, Okta) is the
 * authority on who somebody is, and this module is the whole of the decision
 * about what a signed assertion means here.
 *
 * Pure on purpose: no fetch, no `jose`, no cookies, no `next/headers`. That is
 * what lets the entire sign-in path — including every refusal — be tested
 * without a provider, a browser or a database, and it is why the cookie *name*
 * lives here rather than in the module that sets it: a live test on a raw HTTP
 * response has to look for the cookie, and it cannot import a `server-only`
 * module to find out what it is called.
 *
 * Three untrusted steps, three checks:
 *
 *  1. **Discovery** must describe the issuer the deployment configured, with
 *     absolute endpoints. A discovery document that names a different issuer is
 *     how a mistyped endpoint sends people to somebody else's sign-in page.
 *  2. **The authorization request** is built with a CSRF `state`, a replay
 *     `nonce` and an S256 PKCE challenge — none of which travel in the URL.
 *  3. **The ID token's claims** are checked against the expected issuer and
 *     nonce, then authorized: the email has to be verified and in an allowed
 *     domain, the second factor has to be asserted if the deployment requires
 *     it, and the role is mapped from the group claims.
 */

export const SSO_ROLES = ["ADMIN", "INSTRUCTOR", "STUDENT"] as const;
export type SsoRole = (typeof SSO_ROLES)[number];

export function isSsoRole(value: unknown): value is SsoRole {
  return typeof value === "string" && (SSO_ROLES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

/** A `<claim>:<value>=<ROLE>` line, as the deployment writes it. */
export interface RoleMapping {
  claim: string;
  value: string;
  role: SsoRole;
}

export interface SsoConfig {
  issuer: string;
  clientId: string;
  /** `null` for a public client that proves itself with PKCE alone. */
  clientSecret: string | null;
  scopes: string[];
  defaultRole: SsoRole;
  roleMappings: RoleMapping[];
  /** When non-empty, only these email domains may sign in. */
  allowedDomains: string[];
  requireMfa: boolean;
}

/**
 * What the environment says about single sign-on. `enabled` is false when the
 * deployment has not configured a provider at all — the ordinary case, and not a
 * mistake. `config` is null with `issues` populated when it is half-configured,
 * which *is* a mistake worth saying out loud.
 */
export interface SsoConfigResult {
  enabled: boolean;
  config: SsoConfig | null;
  issues: string[];
}

export const SSO_ENV = {
  issuer: "ONTRAK_OIDC_ISSUER",
  clientId: "ONTRAK_OIDC_CLIENT_ID",
  clientSecret: "ONTRAK_OIDC_CLIENT_SECRET",
  scopes: "ONTRAK_OIDC_SCOPES",
  defaultRole: "ONTRAK_OIDC_DEFAULT_ROLE",
  roleMappings: "ONTRAK_OIDC_ROLE_MAPPINGS",
  allowedDomains: "ONTRAK_OIDC_ALLOWED_DOMAINS",
  requireMfa: "ONTRAK_OIDC_REQUIRE_MFA",
  redirectUri: "ONTRAK_TRAINING_BASE_URL",
} as const;

/**
 * Read the deployment's single sign-on configuration.
 *
 * **Unset means off.** A deployment that names no issuer keeps the ordinary
 * email-and-password sign-in it has always had, and the sign-in page shows no
 * SSO affordance at all — an SSO button on a deployment that cannot complete a
 * handshake is worse than no button.
 *
 * **Half-set means an error, not a fallback.** An issuer without a client id is
 * a configuration mistake, and a deployment that quietly ignored it would leave
 * people tapping a button that cannot work; the issues are returned so the
 * caller can say so out loud.
 */
export function ssoConfigFromEnv(env: Record<string, string | undefined> = process.env): SsoConfigResult {
  const issuer = (env[SSO_ENV.issuer] ?? "").trim();
  const clientId = (env[SSO_ENV.clientId] ?? "").trim();
  if (!issuer && !clientId) return { enabled: false, config: null, issues: [] };

  const refuse = (issues: string[]): SsoConfigResult => ({ enabled: true, config: null, issues });
  const issues: string[] = [];
  if (!issuer) issues.push(`${SSO_ENV.issuer} is not set.`);
  if (!clientId) issues.push(`${SSO_ENV.clientId} is not set.`);
  if (issuer && !isHttpUrl(issuer)) {
    issues.push(`${SSO_ENV.issuer} must be an absolute http(s) URL.`);
  }
  if (issues.length > 0) return refuse(issues);

  const defaultRole = (env[SSO_ENV.defaultRole] ?? "STUDENT").trim().toUpperCase();
  if (!isSsoRole(defaultRole)) {
    return refuse([`${SSO_ENV.defaultRole} must be ADMIN, INSTRUCTOR or STUDENT.`]);
  }

  const mappings = parseRoleMappings(env[SSO_ENV.roleMappings] ?? "");
  if (mappings.errors.length > 0) return refuse(mappings.errors);

  const domains = splitList(env[SSO_ENV.allowedDomains] ?? "").map((entry) => entry.replace(/^@/, "").toLowerCase());
  const badDomain = domains.find((entry) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(entry));
  if (badDomain) return refuse([`"${badDomain}" is not a domain.`]);

  const scopes = splitList(env[SSO_ENV.scopes] ?? "");
  return {
    enabled: true,
    issues: [],
    config: {
      issuer: issuer.trim().replace(/\/+$/, ""),
      clientId,
      clientSecret: (env[SSO_ENV.clientSecret] ?? "").trim() || null,
      scopes: scopes.length > 0 ? scopes : ["profile", "email"],
      defaultRole,
      roleMappings: mappings.mappings,
      allowedDomains: domains,
      requireMfa: truthy(env[SSO_ENV.requireMfa]),
    },
  };
}

/** The active configuration, or `null` when single sign-on is off or broken. */
export function activeSsoConfig(env: Record<string, string | undefined> = process.env): SsoConfig | null {
  return ssoConfigFromEnv(env).config;
}

/** Why single sign-on is configured but unusable, for a boot log or a page. */
export function ssoConfigIssues(env: Record<string, string | undefined> = process.env): string[] {
  const result = ssoConfigFromEnv(env);
  return result.enabled && result.config === null ? result.issues : [];
}

/**
 * The one line a boot log should print when a provider is configured but unusable.
 *
 * Single sign-on degrades quietly, and that is exactly the problem. A half-wired
 * `ONTRAK_OIDC_*` block publishes no button — `activeSsoConfig` is null, so the
 * sign-in page keeps only the password form — which *looks* like a deployment that
 * never wanted single sign-on. An operator who set those variables believes the
 * deployment is protected by their directory, while everybody keeps signing in
 * with a local password, and nothing anywhere says so.
 *
 * So the deployment says it out loud at startup instead, naming the variable at
 * fault. Returns `null` when single sign-on is off — the ordinary case, and not a
 * mistake — or when the configuration is complete. Wording a whole sentence rather
 * than a code is deliberate: this is read in a container log.
 */
export function ssoConfigWarning(env: Record<string, string | undefined> = process.env): string | null {
  const issues = ssoConfigIssues(env);
  if (issues.length === 0) return null;
  return `[sso] This deployment has single sign-on configured, but it cannot be used, so the sign-in page offers no single sign-on button: ${issues.join(" ")}`;
}

/** Split a comma- or newline-separated value into trimmed, non-empty entries. */
export function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

/**
 * Parse `group=ROLE` lines, one per line.
 *
 * The `<claim>:` prefix is optional and defaults to `groups`, so an org chart
 * change (a new team, a renamed one) is configuration rather than a deploy.
 * Every problem is reported rather than dropped: a mapping that silently does
 * nothing is worse than one that refuses to be saved.
 */
export function parseRoleMappings(text: string): { mappings: RoleMapping[]; errors: string[] } {
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
    if (!isSsoRole(role)) {
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
    mappings.push({ claim: claim || "groups", value, role });
  }

  return { mappings, errors };
}

/* -------------------------------------------------------------------------- */
/*  Discovery                                                                 */
/* -------------------------------------------------------------------------- */

export interface OidcDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint?: string;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Trailing slashes are not significant in an issuer identifier. */
function normalizeIssuer(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export type DiscoveryResult = { ok: true; discovery: OidcDiscovery } | { ok: false; reason: string };

/**
 * Validate a fetched discovery document against the configured issuer. The
 * issuer must match exactly (modulo a trailing slash): that is the check which
 * makes "which provider did we just talk to?" have one answer.
 */
export function validateDiscovery(value: unknown, expectedIssuer: string): DiscoveryResult {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "The identity provider returned no discovery document." };
  }
  const raw = value as Record<string, unknown>;

  const issuer = typeof raw.issuer === "string" ? raw.issuer : "";
  if (!issuer) return { ok: false, reason: "The discovery document has no issuer." };
  if (normalizeIssuer(issuer) !== normalizeIssuer(expectedIssuer)) {
    return { ok: false, reason: `The discovery issuer "${issuer}" does not match the configured issuer.` };
  }

  if (!isHttpUrl(raw.authorization_endpoint)) return { ok: false, reason: "The discovery document has no authorization endpoint." };
  if (!isHttpUrl(raw.token_endpoint)) return { ok: false, reason: "The discovery document has no token endpoint." };
  if (!isHttpUrl(raw.jwks_uri)) return { ok: false, reason: "The discovery document has no JWKS URI." };

  return {
    ok: true,
    discovery: {
      issuer,
      authorizationEndpoint: raw.authorization_endpoint,
      tokenEndpoint: raw.token_endpoint,
      jwksUri: raw.jwks_uri,
      ...(isHttpUrl(raw.userinfo_endpoint) ? { userinfoEndpoint: raw.userinfo_endpoint } : {}),
    },
  };
}

export function discoveryUrl(issuer: string): string {
  return `${normalizeIssuer(issuer)}/.well-known/openid-configuration`;
}

/* -------------------------------------------------------------------------- */
/*  The authorization request                                                 */
/* -------------------------------------------------------------------------- */

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  nonce: string;
  codeChallenge: string;
}

/**
 * Build the authorization URL. `openid` is always requested — without it the
 * provider returns no ID token — and the configured scopes are layered on top,
 * deduplicated so `openid` appearing twice cannot confuse a strict provider.
 */
export function buildAuthorizationUrl(discovery: OidcDiscovery, request: AuthorizationRequest): string {
  const scope = [...new Set(["openid", ...request.scopes.map((entry) => entry.trim()).filter(Boolean)])].join(" ");
  const url = new URL(discovery.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", request.state);
  url.searchParams.set("nonce", request.nonce);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/* -------------------------------------------------------------------------- */
/*  Claims                                                                    */
/* -------------------------------------------------------------------------- */

/** What an assertion says about somebody, once its signature has been checked. */
export interface SsoClaims {
  issuer: string;
  subject: string;
  email: string;
  name?: string;
  groups: string[];
  mfa: boolean;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value === "string") return [value];
  return [];
}

export type ClaimsResult = { ok: true; claims: SsoClaims } | { ok: false; reason: string };

/**
 * Turn a verified ID token payload into claims.
 *
 * The signature was checked by the client, and the two claims only the caller
 * can check are checked here: `iss` (this is our provider) and `nonce` (this is
 * our request, not a replay of somebody else's). An unverified email is refused
 * rather than trusted — otherwise a user could claim an address they do not
 * control and be provisioned as whoever owns it.
 */
export function extractOidcClaims(
  payload: Record<string, unknown>,
  expected: { issuer: string; nonce?: string },
): ClaimsResult {
  const issuer = typeof payload.iss === "string" ? payload.iss : "";
  if (normalizeIssuer(issuer) !== normalizeIssuer(expected.issuer)) {
    return { ok: false, reason: "The sign-in assertion was not issued by this deployment's identity provider." };
  }
  if (expected.nonce !== undefined && payload.nonce !== expected.nonce) {
    return { ok: false, reason: "The sign-in assertion did not match this sign-in request." };
  }

  const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!subject) return { ok: false, reason: "The sign-in assertion carried no subject." };

  if (payload.email_verified === false) {
    return { ok: false, reason: "The identity provider reported that this email address is not verified." };
  }

  const email =
    (typeof payload.email === "string" && payload.email.trim().toLowerCase()) ||
    (typeof payload.preferred_username === "string" && payload.preferred_username.includes("@")
      ? payload.preferred_username.trim().toLowerCase()
      : "");
  if (!email) return { ok: false, reason: "The sign-in assertion carried no usable email address." };

  const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : undefined;

  return {
    ok: true,
    claims: {
      issuer,
      subject,
      email,
      ...(name ? { name } : {}),
      groups: [...asStringArray(payload.groups), ...asStringArray(payload.roles)],
      mfa: payload.mfa === true || asStringArray(payload.amr).some((method) => method !== "pwd"),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Authorization                                                             */
/* -------------------------------------------------------------------------- */

export interface SsoAuthorization {
  email: string;
  subject: string;
  name: string;
  role: SsoRole;
  /** True when a configured mapping decided the role, rather than the default. */
  mapped: boolean;
}

/**
 * Decide what an assertion means for this deployment: which role, and under
 * which name. The order goes from the most structural (a foreign issuer was
 * already refused) to the most specific, so the reason a person sees is the
 * most useful one.
 */
export function authorizeSso(config: SsoConfig, claims: SsoClaims): { ok: true; authorization: SsoAuthorization } | { ok: false; reason: string } {
  const email = claims.email.trim().toLowerCase();
  if (!email.includes("@")) return { ok: false, reason: "The identity provider returned no usable email address." };

  const domain = emailDomain(email);
  if (config.allowedDomains.length > 0 && !config.allowedDomains.includes(domain)) {
    return { ok: false, reason: `"${domain}" is not an allowed sign-in domain on this deployment.` };
  }

  if (config.requireMfa && !claims.mfa) {
    return { ok: false, reason: "This deployment requires multi-factor authentication, and the identity provider did not assert it." };
  }

  const mapping = config.roleMappings.find((entry) =>
    claims.groups.some((group) => group.trim().toLowerCase() === entry.value.toLowerCase()),
  );

  return {
    ok: true,
    authorization: {
      email,
      subject: claims.subject,
      name: claims.name ?? localPart(email),
      role: mapping?.role ?? config.defaultRole,
      mapped: mapping !== undefined,
    },
  };
}

export function emailDomain(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

/* -------------------------------------------------------------------------- */
/*  A repeat sign-in, and the role it writes                                  */
/* -------------------------------------------------------------------------- */

export interface SsoRoleDecision {
  role: SsoRole;
  /** Why the mapped role was not written, when it was not. */
  note: string | null;
}

/**
 * Decide the role a returning sign-in writes.
 *
 * The provider is authoritative — a person moved out of the instructors' group
 * in the directory loses the instructor role here, without anybody remembering to
 * change it twice — with two deliberate exceptions, because the alternative to
 * each is a deployment somebody has to repair by hand:
 *
 *  - **An assertion never reactivates.** `active` is a local decision about who
 *    may use *this* deployment; a directory that still lists somebody must not be
 *    able to undo an administrator switching their account off here.
 *  - **The last administrator keeps the role.** Mapping a group to `ADMIN` and
 *    then renaming it in the directory would otherwise demote the only person who
 *    can administer the installation, and there would be no way back in. The
 *    sign-in proceeds, the role is left alone, and the audit records why.
 */
export function applySsoRole(input: {
  current: SsoRole;
  mapped: SsoRole;
  /** Active administrators other than this account. */
  otherActiveAdmins: number;
  active: boolean;
}): SsoRoleDecision {
  if (!input.active) return { role: input.current, note: null };
  if (input.current === input.mapped) return { role: input.mapped, note: null };
  if (input.current === "ADMIN" && input.otherActiveAdmins === 0) {
    return {
      role: "ADMIN",
      note: "This sign-in would have left the deployment with no administrator, so the role was left alone.",
    };
  }
  return { role: input.mapped, note: null };
}

function localPart(email: string): string {
  return email.split("@")[0] || email;
}

/* -------------------------------------------------------------------------- */
/*  Authorization state (the round trip)                                      */
/* -------------------------------------------------------------------------- */

/**
 * What has to survive the trip to the provider and back: the CSRF `state`, the
 * replay `nonce`, the PKCE verifier and where the user was heading. Carried in
 * one short-lived signed cookie, never in the URL.
 */
export interface AuthorizationState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  at: string;
}

export const SSO_STATE_TTL_SECONDS = 600;

/** The cookie the round trip is carried in. Named here so a test can look for it. */
export const SSO_STATE_COOKIE = "ontrak_training_sso";

export function isAuthorizationState(value: unknown): value is AuthorizationState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.state === "string" &&
    state.state.length > 0 &&
    typeof state.nonce === "string" &&
    state.nonce.length > 0 &&
    typeof state.codeVerifier === "string" &&
    state.codeVerifier.length > 0 &&
    typeof state.returnTo === "string" &&
    typeof state.at === "string"
  );
}

/** Whether a round trip started long enough ago to be abandoned. */
export function stateExpired(state: AuthorizationState, now: string): boolean {
  return new Date(now).getTime() - new Date(state.at).getTime() > SSO_STATE_TTL_SECONDS * 1000;
}

/* -------------------------------------------------------------------------- */
/*  Where this deployment actually is                                          */
/* -------------------------------------------------------------------------- */

export const SSO_CALLBACK_PATH = "/api/sso/callback";

/**
 * The origin this deployment is reached at, as the handshake has to name it.
 *
 * `request.nextUrl.origin` is the *server's* idea of where it is, and the two
 * differ the moment the app runs anywhere but on one host: in a container it is
 * the internal address (`0.0.0.0:3000`), and behind a proxy it is whatever the
 * socket was bound to. A redirect URI is matched **exactly** against the one the
 * provider registered, so a request built from the internal address fails at the
 * provider as a mismatch rather than as anything an operator can see from the
 * app.
 *
 * `ONTRAK_TRAINING_BASE_URL` is the deployment stating its own address, and only
 * the deployment knows it. Unset, the request origin is the best available
 * answer — right for a single-host development run, wrong behind a proxy — so the
 * default is a fallback rather than a policy.
 */
export function deploymentOrigin(configured: string | null | undefined, requestOrigin: string): string {
  const trimmed = (configured ?? "").trim().replace(/\/+$/, "");
  return trimmed || requestOrigin.replace(/\/+$/, "");
}

/** The single redirect URI this deployment is registered under, given its origin. */
export function ssoRedirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${SSO_CALLBACK_PATH}`;
}
