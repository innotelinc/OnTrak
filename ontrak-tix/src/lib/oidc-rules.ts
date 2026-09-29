/**
 * OIDC rules (M2): the pure half of the SSO handshake.
 *
 * A handshake is three untrusted steps — a discovery document fetched from the
 * IdP, a redirect the browser comes back on, and an ID token the IdP signs. Each
 * one is checked here before anything is trusted, so the route handler only has
 * to move bytes:
 *
 *  1. **Discovery** must describe the issuer the tenant configured, with
 *     absolute endpoints. A discovery document that names a different issuer is
 *     how a mis-typed or hostile endpoint redirects users elsewhere.
 *  2. **The authorization request** is built from the connection's scopes plus
 *     `state` (CSRF), `nonce` (replay) and a PKCE challenge.
 *  3. **The ID token's claims** are checked against the expected issuer and
 *     nonce, and mapped onto the `IdentityClaims` the identity rules already
 *     understand — so the SSO path and the SCIM path share one role-mapping
 *     decision.
 *
 * Pure: no fetch, no jose, no cookies. The client and the session cookie live
 * beside this module.
 */

import type { IdentityClaims } from "./identity-rules";

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
 * Validate a fetched discovery document against the issuer the tenant
 * configured. The issuer must match exactly (modulo a trailing slash) — this is
 * the check that makes "which IdP did we just talk to?" have one answer.
 */
export function validateDiscovery(value: unknown, expectedIssuer: string): DiscoveryResult {
  if (typeof value !== "object" || value === null) return { ok: false, reason: "The identity provider returned no discovery document." };
  const raw = value as Record<string, unknown>;

  const issuer = typeof raw.issuer === "string" ? raw.issuer : "";
  if (!issuer) return { ok: false, reason: "The discovery document has no issuer." };
  if (normalizeIssuer(issuer) !== normalizeIssuer(expectedIssuer)) {
    return { ok: false, reason: `The discovery issuer "${issuer}" does not match the configured issuer.` };
  }

  const authorizationEndpoint = raw.authorization_endpoint;
  const tokenEndpoint = raw.token_endpoint;
  const jwksUri = raw.jwks_uri;
  if (!isHttpUrl(authorizationEndpoint)) return { ok: false, reason: "The discovery document has no authorization endpoint." };
  if (!isHttpUrl(tokenEndpoint)) return { ok: false, reason: "The discovery document has no token endpoint." };
  if (!isHttpUrl(jwksUri)) return { ok: false, reason: "The discovery document has no JWKS URI." };

  return {
    ok: true,
    discovery: {
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      jwksUri,
      ...(isHttpUrl(raw.userinfo_endpoint) ? { userinfoEndpoint: raw.userinfo_endpoint } : {}),
    },
  };
}

/** The well-known location of a discovery document for an issuer. */
export function discoveryUrl(issuer: string): string {
  return `${normalizeIssuer(issuer)}/.well-known/openid-configuration`;
}

/* -------------------------------------------------------------------------- */
/*  The authorization request                                                 */
/* -------------------------------------------------------------------------- */

/** Everything the redirect to the IdP needs besides the discovery document. */
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
 * IdP returns no ID token — and the connection's scopes are layered on top,
 * deduplicated so `openid` appearing twice does not confuse a strict IdP.
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

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value === "string") return [value];
  return [];
}

export type OidcClaimsResult = { ok: true; claims: IdentityClaims } | { ok: false; reason: string };

/**
 * Turn a verified ID token payload into the identity rules' claims.
 *
 * The signature was already checked by the client; here we check the two claims
 * only the caller can: `iss` (this is our IdP) and `nonce` (this is our
 * request, not a replayed one). An unverified email is refused rather than
 * trusted — a user must not be able to claim an address they do not control.
 */
export function extractOidcClaims(
  payload: Record<string, unknown>,
  expected: { issuer: string; nonce?: string },
): OidcClaimsResult {
  const issuer = typeof payload.iss === "string" ? payload.iss : "";
  if (normalizeIssuer(issuer) !== normalizeIssuer(expected.issuer)) {
    return { ok: false, reason: "The ID token was not issued by this tenant's identity provider." };
  }
  if (expected.nonce !== undefined && payload.nonce !== expected.nonce) {
    return { ok: false, reason: "The ID token did not match this sign-in request." };
  }

  const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!subject) return { ok: false, reason: "The ID token carried no subject." };

  if (payload.email_verified === false) {
    return { ok: false, reason: "The identity provider reported that the email address is not verified." };
  }

  const email =
    (typeof payload.email === "string" && payload.email.trim()) ||
    (typeof payload.preferred_username === "string" && payload.preferred_username.includes("@") ? payload.preferred_username.trim() : "");
  if (!email) return { ok: false, reason: "The ID token carried no usable email address." };

  const name = typeof payload.name === "string" ? payload.name : undefined;
  const groups = [...asStringArray(payload.groups), ...asStringArray(payload.roles)];

  return {
    ok: true,
    claims: {
      issuer,
      subject,
      email,
      ...(name ? { name } : {}),
      groups,
      claims: {
        roles: asStringArray(payload.roles),
        groups: asStringArray(payload.groups),
        ...(typeof payload.department === "string" ? { department: payload.department } : {}),
      },
      amr: asStringArray(payload.amr),
      ...(payload.mfa === true ? { mfa: true } : {}),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Authorization state (the round trip)                                      */
/* -------------------------------------------------------------------------- */

/**
 * What has to survive the round trip to the IdP and back: the CSRF `state`, the
 * replay `nonce`, the PKCE verifier, and where the user was heading. It is
 * carried in one short-lived signed cookie, never in the URL.
 */
export interface AuthorizationState {
  state: string;
  nonce: string;
  codeVerifier: string;
  tenantId: string;
  returnTo: string;
  at: string;
}

export const SSO_STATE_TTL_SECONDS = 600;

/**
 * The cookie the round trip is carried in. The *name* lives here, beside the
 * state rules, because a live test has to look for it on a raw HTTP response and
 * cannot import the cookie module (`server-only`).
 */
export const SSO_STATE_COOKIE = "ontrak_tix_sso";

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
    typeof state.tenantId === "string" &&
    state.tenantId.length > 0 &&
    typeof state.returnTo === "string" &&
    typeof state.at === "string"
  );
}

/** Whether a round trip started long enough ago to be abandoned. */
export function stateExpired(state: AuthorizationState, now: string): boolean {
  return new Date(now).getTime() - new Date(state.at).getTime() > SSO_STATE_TTL_SECONDS * 1000;
}

/**
 * Only a same-site path may be a post-sign-in destination, so a crafted
 * `returnTo` cannot turn the callback into an open redirect. Returns `null`
 * when there is no usable destination, so the caller can fall back to the
 * signed-in user's own home rather than a guess.
 */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.startsWith("/\\")) return null;
  return trimmed;
}

/** Where a signed-in role should land by default. */
export function homePathForRole(role: string): string {
  return role === "REQUESTER" ? "/portal" : "/inbox";
}

/* -------------------------------------------------------------------------- */
/*  Where this deployment actually is                                          */
/* -------------------------------------------------------------------------- */

/**
 * The origin this deployment is reached at, as the handshake has to name it.
 *
 * `request.nextUrl.origin` is the *server's* idea of where it is, and the two are
 * different the moment the app runs anywhere but on one host: in a container it is
 * the internal address (`0.0.0.0:3000`), and behind a proxy it is whatever the
 * socket was bound to. Neither is usable in a handshake. A redirect URI is matched
 * **exactly** against the one the provider registered, so a request built from the
 * internal address fails as a mismatch at the provider rather than as anything an
 * operator can see from the desk; and a post-sign-in redirect to the internal
 * address strands the browser somewhere it cannot reach.
 *
 * `ONTRAK_TIX_BASE_URL` is the deployment stating its own address, and only the
 * deployment knows it. Unset, the request origin is the best available answer —
 * right for a single-host development run, wrong behind a proxy — so the default is
 * a fallback rather than a policy.
 */
export function deploymentOrigin(configured: string | null | undefined, requestOrigin: string): string {
  const trimmed = (configured ?? "").trim().replace(/\/+$/, "");
  return trimmed || requestOrigin.replace(/\/+$/, "");
}

/** The single redirect URI this deployment is registered under, given its origin. */
export function ssoRedirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/sso/callback`;
}
