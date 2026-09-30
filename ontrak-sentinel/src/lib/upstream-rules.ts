/**
 * Upstream sign-in rules: the pure half of handing the console to a provider.
 *
 * Sentinel is an identity provider, and its console is the one login in the family it
 * owns outright — `sign-in-service.ts` checks a password itself. That is the right shape
 * for the product that holds the identities, and the wrong shape for a deployment that
 * already has a provider: Cerulean's Authentik holds the people, so a second password
 * beside it is a second thing to reset, a second place to forget a leaver, and a second
 * way to enumerate accounts.
 *
 * So the console also accepts a sign-in *from upstream*: the browser is handed to the
 * configured provider with an OIDC authorization-code request, and what comes back is an
 * ID token the non-pure half (`upstream-service.ts`) verifies. Nothing here touches the
 * network or the clock; the parts worth testing — the shape of the request, what the
 * callback must carry, which claim names the person, and whether the provider asserted a
 * second factor — are decidable from arguments alone.
 *
 * Four choices worth stating out loud:
 *
 *  - **The state lives in a sealed cookie, never in the callback.** The callback carries
 *    an opaque state and the browser carries the sealed envelope; sealing pins the nonce,
 *    the PKCE verifier and the return path to this browser, so a callback a stranger
 *    crafts cannot name someone else's return path, and replaying a response into another
 *    browser fails on the cookie rather than on a guessable value.
 *  - **PKCE is required of us too.** We are the client here, and the code arrives on a
 *    redirect; without S256 a leaked code is a session for anyone who has it.
 *  - **The person is named by the provider's `email`, and nothing else.** Identities in
 *    this product are keyed by identifier, and the identifier everywhere else in the
 *    family is the address. Matching on `sub` would be a second key nothing else knows.
 *  - **A second factor is taken at the provider's word — but only when it says so.** The
 *    spine refuses a session from an identity that owes MFA and has not proven one, so a
 *    login that the provider did *not* challenge is refused rather than silently trusted.
 *
 * The upstream issuer is Authentik in this Network (`auth.cerulean.innotel.us`), but
 * nothing here is Authentik-specific: it is the standard authorization-code flow against
 * a discovered issuer.
 */

import type { IdentityRole } from "./identity-rules";

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

/** The cookie that carries a sealed sign-in attempt between the two legs. */
export const UPSTREAM_STATE_COOKIE = "sentinel_upstream_state";

/** Where the console's upstream legs live, under the one `/console` prefix. */
export const UPSTREAM_PATHS = {
  start: "/console/sign-in/upstream",
  callback: "/console/sign-in/upstream/callback",
} as const;

export interface UpstreamConfig {
  /**
   * The app-scoped issuer, exactly as the provider mints `iss`.
   *
   * Authentik's per-provider issuer ends in a slash
   * (`https://auth.cerulean.innotel.us/application/o/sentinel/`); the trailing slashes
   * are trimmed only when building the discovery URL and when comparing issuers, never
   * when the value is shown.
   */
  issuer: string;
  clientId: string;
  /** Omitted for a public client; a confidential client sends it on the token leg. */
  clientSecret: string | null;
  /** The console's callback, matched exactly at the provider. */
  redirectUri: string;
  /** Defaults to the standard OIDC scopes. */
  scopes: readonly string[];
  /** Upstream group whose members arrive as ADMIN here; everyone else is an AGENT. */
  adminGroup: string | null;
  /** The workspace signed into when the attempt named none. */
  defaultOrganizationSlug: string | null;
  /** Where a successful sign-in lands. */
  landingPath: string;
  /**
   * Whether a login the provider did not explicitly mark as multi-factor is still
   * accepted. Off by default: an assertion we cannot see is not an assertion.
   */
  trustAssertedMfa: boolean;
  /** How long a sealed attempt stays good. */
  stateTtlSeconds: number;
  /** The button's label, so the page can say whose SSO this is. */
  label: string;
}

/** The scopes asked for when the deployment names none. */
export const DEFAULT_UPSTREAM_SCOPES: readonly string[] = ["openid", "email", "profile"];

/**
 * Read the upstream configuration from an environment, or `null` when it is absent.
 *
 * Absent means "this console is password-only", which is a legitimate deployment and the
 * one `npm run serve` starts in — so a missing client id is *not* an error, it is the
 * feature being off. A configuration that is *present but wrong* (an issuer that is not a
 * URL, a redirect that is not absolute) is an error the caller must not paper over, hence
 * the throw: a half-configured provider is a login that fails at the worst moment.
 */
export function upstreamConfigFromEnv(
  env: Record<string, string | undefined>,
): UpstreamConfig | null {
  const read = (name: string): string => (env[name] ?? "").trim();
  const clientId = read("SENTINEL_UPSTREAM_CLIENT_ID");
  const issuer = read("SENTINEL_UPSTREAM_ISSUER");
  const redirectUri = read("SENTINEL_UPSTREAM_REDIRECT_URI");
  if (!clientId && !issuer && !redirectUri) return null;

  if (!clientId) throw new Error("SENTINEL_UPSTREAM_CLIENT_ID is required when upstream sign-in is configured.");
  if (!issuer) throw new Error("SENTINEL_UPSTREAM_ISSUER is required when upstream sign-in is configured.");
  if (!redirectUri) throw new Error("SENTINEL_UPSTREAM_REDIRECT_URI is required when upstream sign-in is configured.");
  assertHttpUrl(issuer, "SENTINEL_UPSTREAM_ISSUER");
  assertHttpUrl(redirectUri, "SENTINEL_UPSTREAM_REDIRECT_URI");

  const configuredScopes = read("SENTINEL_UPSTREAM_SCOPES")
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const scopes = configuredScopes.length > 0 ? configuredScopes : [...DEFAULT_UPSTREAM_SCOPES];
  if (!scopes.includes("openid")) scopes.unshift("openid");

  const ttl = Number(read("SENTINEL_UPSTREAM_STATE_TTL_SECONDS") || "600");
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error("SENTINEL_UPSTREAM_STATE_TTL_SECONDS must be a positive number of seconds.");
  }

  return {
    issuer,
    clientId,
    clientSecret: read("SENTINEL_UPSTREAM_CLIENT_SECRET") || null,
    redirectUri,
    scopes,
    adminGroup: read("SENTINEL_UPSTREAM_ADMIN_GROUP") || null,
    defaultOrganizationSlug: read("SENTINEL_UPSTREAM_ORGANIZATION") || null,
    landingPath: read("SENTINEL_UPSTREAM_LANDING") || "/console",
    trustAssertedMfa: read("SENTINEL_UPSTREAM_TRUST_MFA") === "1",
    stateTtlSeconds: Math.floor(ttl),
    label: read("SENTINEL_UPSTREAM_LABEL") || "Single sign-on",
  };
}

function assertHttpUrl(value: string, name: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must be an http or https URL.`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Discovery                                                                 */
/* -------------------------------------------------------------------------- */

export interface UpstreamEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  endSessionEndpoint: string | null;
}

/** The discovery document's URL: the issuer with the trailing slashes trimmed. */
export function discoveryUrl(issuer: string): string {
  return `${withoutTrailingSlash(issuer)}/.well-known/openid-configuration`;
}

export function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Read the endpoints out of a discovery document.
 *
 * Every URL is absolute and `https` in a real deployment, but a loopback `http` is
 * allowed on purpose, for the same reason the provider's own registrations allow it: a
 * single-machine stack is a deployment too. The issuer the document names must match the
 * one configured (modulo a trailing slash), because otherwise discovery has quietly
 * pointed us at a different provider than the one we checked `iss` against.
 */
export function parseDiscovery(
  document: unknown,
  expectedIssuer: string,
): UpstreamEndpoints | { error: string } {
  if (!document || typeof document !== "object") return { error: "The discovery document is not an object." };
  const doc = document as Record<string, unknown>;
  const issuer = typeof doc.issuer === "string" ? doc.issuer : "";
  if (withoutTrailingSlash(issuer) !== withoutTrailingSlash(expectedIssuer)) {
    return { error: "The provider's discovery document names a different issuer." };
  }
  const authorizationEndpoint = stringField(doc, "authorization_endpoint");
  const tokenEndpoint = stringField(doc, "token_endpoint");
  const jwksUri = stringField(doc, "jwks_uri");
  if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) {
    return { error: "The discovery document is missing an authorization, token or JWKS endpoint." };
  }
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    endSessionEndpoint: stringField(doc, "end_session_endpoint"),
  };
}

function stringField(doc: Record<string, unknown>, name: string): string | null {
  const value = doc[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/* -------------------------------------------------------------------------- */
/*  The request                                                               */
/* -------------------------------------------------------------------------- */

export interface UpstreamAttempt {
  /** Opaque, echoed back in the callback and matched against the sealed cookie. */
  state: string;
  /** Replayed into the ID token and checked on the way back. */
  nonce: string;
  /** The PKCE verifier, sealed with the state and spent on the token leg. */
  verifier: string;
  /** Where the browser should land, when it asked to return somewhere specific. */
  returnTo: string | null;
  /** Epoch milliseconds the attempt stops being good. */
  expiresAt: number;
}

/** The authorization URL the browser is sent to. */
export function buildAuthorizeUrl(
  endpoints: UpstreamEndpoints,
  config: UpstreamConfig,
  input: { state: string; nonce: string; codeChallenge: string },
): string {
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/**
 * What the callback must carry, or the reason it cannot be trusted.
 *
 * A callback that carries the provider's own error is reported as the provider's
 * refusal rather than passed on, and both `code` and `state` are required: a code with
 * no state is a response this browser did not ask for, and spending it would be exactly
 * the login-CSRF the state exists to stop.
 */
export function readCallback(
  query: URLSearchParams,
): { ok: true; code: string; state: string } | { ok: false; error: string } {
  const error = query.get("error");
  if (error) {
    const description = query.get("error_description");
    return { ok: false, error: description ? `The provider refused: ${description}` : `The provider refused (${error}).` };
  }
  const code = (query.get("code") ?? "").trim();
  const state = (query.get("state") ?? "").trim();
  if (!code) return { ok: false, error: "The provider returned no authorization code." };
  if (!state) return { ok: false, error: "The provider returned no state, so this is not a reply to a sign-in we started." };
  return { ok: true, code, state };
}

/* -------------------------------------------------------------------------- */
/*  Claims                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The identifier the person signs in as, from the provider's claims.
 *
 * `email` first because that is the identifier this product and the rest of the family
 * key on; `preferred_username` second, for a provider that leaves `email` out; nothing
 * else, because a `sub` is a per-client number that would create a second identity for
 * the same person the moment another client names them. Lower-cased to match the way
 * `normalizeIdentifier` and the store look one up.
 */
export function identifierFromClaims(claims: Record<string, unknown>): string | null {
  for (const name of ["email", "preferred_username"]) {
    const value = claims[name];
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return null;
}

/** A human-readable name for the identity, defaulting to the identifier. */
export function displayNameFromClaims(claims: Record<string, unknown>, fallback: string): string {
  for (const name of ["name", "given_name", "preferred_username", "email"]) {
    const value = claims[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

/** The upstream's groups, however the provider spells them. */
export function groupsFromClaims(claims: Record<string, unknown>): string[] {
  const raw = claims.groups ?? claims.roles;
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === "string").map((g) => g.trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(/[\s,]+/).map((g) => g.trim()).filter(Boolean);
  return [];
}

/**
 * The role this person arrives with.
 *
 * Membership of the configured administrator group is the whole rule, and everyone else
 * is an AGENT — deliberately not "whatever the provider said", because a group name is
 * an attribute an upstream administrator controls and a role here is a grant this product
 * makes. With no admin group configured nobody is promoted, which is the safe default.
 */
export function roleFromClaims(claims: Record<string, unknown>, adminGroup: string | null): IdentityRole {
  if (!adminGroup) return "AGENT";
  return groupsFromClaims(claims).some((group) => group.toLowerCase() === adminGroup.toLowerCase())
    ? "ADMIN"
    : "AGENT";
}

/**
 * Whether the provider said this login was multi-factor.
 *
 * Read from `amr` (the standard list of methods) and from an Authentik-style `acr`. The
 * names are the RFC's: `mfa`, `otp`, `hwk` (hardware key), `swk` (software key), `totp`.
 * An empty or unrecognised answer is *not* a factor — a provider that does not say so is
 * one this deployment has to configure (`SENTINEL_UPSTREAM_TRUST_MFA=1`) rather than one
 * it should assume.
 */
export function upstreamAssertsMfa(claims: Record<string, unknown>): boolean {
  const methods = new Set<string>();
  const add = (value: string): void => {
    for (const method of value.split(/[\s,]+/)) {
      if (method) methods.add(method.toLowerCase());
    }
  };
  const amr = claims.amr;
  if (Array.isArray(amr)) {
    for (const entry of amr) if (typeof entry === "string") add(entry);
  } else if (typeof amr === "string") {
    add(amr);
  }
  const factors = ["mfa", "otp", "totp", "hwk", "swk", "webauthn", "fido"];
  if ([...methods].some((method) => factors.includes(method))) return true;
  const acr = typeof claims.acr === "string" ? claims.acr.toLowerCase() : "";
  return acr.includes("mfa") || acr.includes("multi-factor");
}

/**
 * A return path we are willing to send a browser to: a rooted path and nothing else.
 *
 * `//evil.test` and `https://evil.test` are both absolute URLs to a browser, so the only
 * safe shape is a single leading slash followed by something that is neither a slash nor a
 * backslash — which is why this is a whitelist rather than a check for "starts with /".
 */
export function safeReturnTo(value: string | null): string | null {
  if (!value) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  if (/[\r\n]/.test(value)) return null;
  return value;
}
