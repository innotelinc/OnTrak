/**
 * OIDC rules (S1): the pure half of an authorization-code handshake, from the
 * side that **issues** identity rather than the side that consumes it.
 *
 * Sentinel is the IdP; OnTrak Tix, the training app and anything a customer
 * writes are its clients. Every step is untrusted input — a query string a
 * browser can type, a `client_id` a stranger can send, a code that comes back
 * over an untrusted channel — so each check lives here, in a function a test can
 * call without a server, and the HTTP layer only moves bytes:
 *
 *  1. **The client is registered, and its redirect URI matches exactly.** A
 *     prefix match or a wildcard is how an authorization code gets delivered to
 *     somebody else's origin, so this is a string equality against what was
 *     registered and nothing cleverer.
 *  2. **PKCE is required of every client, public or not.** A code that leaks —
 *     through a referrer, a proxy log, a shared browser — is useless without the
 *     verifier, and requiring it universally removes the "is this client public?"
 *     judgement call that clients get wrong.
 *  3. **A code is single-use and short-lived.** Sixty seconds and one exchange:
 *     replay is refused by the record, not by hoping the client behaves.
 *
 * Pure: no fetch, no crypto, no clock. The hash for the PKCE challenge is
 * injected (see `hash.ts`), and the time is handed in, so the same decisions run
 * in a server, a worker and a test.
 */

import type { HashFn } from "./audit-chain";

/* -------------------------------------------------------------------------- */
/*  Endpoints and limits                                                      */
/* -------------------------------------------------------------------------- */

/** Where the provider's endpoints live, relative to the issuer. */
export const OIDC_PATHS = {
  discovery: "/.well-known/openid-configuration",
  jwks: "/.well-known/jwks.json",
  authorization: "/oauth2/authorize",
  token: "/oauth2/token",
  userinfo: "/oauth2/userinfo",
  /** RP-initiated logout: the client asks the provider to end the session. */
  logout: "/oauth2/logout",
  /** RFC 7009 token revocation. */
  revocation: "/oauth2/revoke",
} as const;

/** The scopes this provider issues. Anything else is refused, not ignored. */
export const SUPPORTED_SCOPES = ["openid", "profile", "email", "roles"] as const;
export type OidcScope = (typeof SUPPORTED_SCOPES)[number];

/** How long an authorization code is worth anything. */
export const CODE_TTL_SECONDS = 60;

/** How long an access token (and the ID token beside it) lasts. */
export const TOKEN_TTL_SECONDS = 60 * 60;

export const CLIENT_NAME_MAX = 120;
export const REDIRECT_URIS_MAX = 10;

/** An issuer identifier has no trailing slash; neither does ours. */
export function normalizeIssuer(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * The discovery document (RFC 8414 / OIDC Discovery).
 *
 * It advertises only what is actually implemented — `none` is the only token
 * endpoint authentication method, because client secrets are not built yet, and
 * `S256` is the only code challenge method, because `plain` is not offered at
 * all. A discovery document that over-claims is how an integrator finds out
 * about a missing feature in production.
 */
export function discoveryDocument(issuer: string): Record<string, unknown> {
  const base = normalizeIssuer(issuer);
  return {
    issuer: base,
    authorization_endpoint: `${base}${OIDC_PATHS.authorization}`,
    token_endpoint: `${base}${OIDC_PATHS.token}`,
    userinfo_endpoint: `${base}${OIDC_PATHS.userinfo}`,
    jwks_uri: `${base}${OIDC_PATHS.jwks}`,
    end_session_endpoint: `${base}${OIDC_PATHS.logout}`,
    revocation_endpoint: `${base}${OIDC_PATHS.revocation}`,
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    // Revocation is reached with the token itself, so a client secret is not
    // needed to spend one — which is the point of revocation: a leaked token
    // must be killable without the thing that leaked it.
    revocation_endpoint_auth_methods_supported: ["none"],
    id_token_signing_alg_values_supported: ["RS256"],
    // The end-session endpoint is advertised because a client that can end a
    // session itself needs to know where; a discovery document that omits it
    // makes sign-out the client's problem, which is how a session outlives its
    // user.

    subject_types_supported: ["public"],
    claims_supported: [
      "sub",
      "iss",
      "aud",
      "exp",
      "iat",
      "auth_time",
      "nonce",
      "sid",
      "amr",
      "email",
      "email_verified",
      "name",
      "preferred_username",
      "roles",
    ],
  };
}

/* -------------------------------------------------------------------------- */
/*  Registered clients                                                        */
/* -------------------------------------------------------------------------- */

/** A client application the provider will issue identity to. */
export interface OidcClientRecord {
  /** Globally unique, per OIDC: the token endpoint is reached with this alone. */
  clientId: string;
  /** The organization that registered it. Nothing crosses this. */
  organizationId: string;
  name: string;
  /** Exact match only. No wildcards, no prefixes. */
  redirectUris: readonly string[];
  scopes: readonly OidcScope[];
  /**
   * A public client cannot keep a secret (a browser, a CLI), so PKCE is the only
   * thing binding a code to its caller. Both kinds are held to it here, which is
   * why this field is recorded rather than enforced differently.
   */
  kind: "public" | "confidential";
  createdBy: string;
  createdAt: string;
}

export interface OidcIssue {
  field: string;
  message: string;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Whether a redirect URI is one we would register at all.
 *
 * `https` in general, and plain `http` only for a loopback address — a desktop
 * or CLI client listening on the developer's own machine cannot get a
 * certificate, and every other `http` origin is a code sent in the clear. A
 * fragment is refused because a redirect target's fragment is never sent to the
 * server, so a code placed after one would vanish.
 */
export function isRegistrableRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

export function validateClient(input: {
  name?: string;
  redirectUris?: readonly string[];
  scopes?: readonly string[];
  kind?: string;
}): OidcIssue[] {
  const issues: OidcIssue[] = [];

  const name = input.name?.trim() ?? "";
  if (!name) issues.push({ field: "name", message: "A client name is required." });
  else if (name.length > CLIENT_NAME_MAX) {
    issues.push({ field: "name", message: `The name may be at most ${CLIENT_NAME_MAX} characters.` });
  }

  if (input.kind !== undefined && input.kind !== "public" && input.kind !== "confidential") {
    issues.push({ field: "kind", message: "A client is either public or confidential." });
  }

  const redirectUris = (input.redirectUris ?? []).map((uri) => uri.trim()).filter(Boolean);
  if (redirectUris.length === 0) issues.push({ field: "redirectUris", message: "At least one redirect URI is required." });
  if (redirectUris.length > REDIRECT_URIS_MAX) {
    issues.push({ field: "redirectUris", message: `A client may register at most ${REDIRECT_URIS_MAX} redirect URIs.` });
  }
  if (new Set(redirectUris).size !== redirectUris.length) {
    issues.push({ field: "redirectUris", message: "The same redirect URI is listed twice." });
  }
  for (const uri of redirectUris) {
    if (!isRegistrableRedirectUri(uri)) {
      issues.push({ field: "redirectUris", message: `“${uri}” is not a redirect URI we can register: https, or http on a loopback address.` });
    }
  }

  const scopes = input.scopes ?? [];
  if (!scopes.includes("openid")) {
    issues.push({ field: "scopes", message: "A client must be allowed the openid scope, or it will never receive an ID token." });
  }
  for (const scope of scopes) {
    if (!(SUPPORTED_SCOPES as readonly string[]).includes(scope)) {
      issues.push({ field: "scopes", message: `“${scope}” is not a scope this provider issues.` });
    }
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/*  PKCE (RFC 7636)                                                           */
/* -------------------------------------------------------------------------- */

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding, over raw bytes. Pure, so it needs no `Buffer`. */
export function base64UrlEncode(bytes: readonly number[]): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index] ?? 0;
    const b1 = bytes[index + 1];
    const b2 = bytes[index + 2];
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 === undefined) break;
    out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 === undefined) break;
    out += B64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** A hex digest as bytes. The injected hash returns hex; PKCE needs octets. */
export function bytesFromHex(hex: string): number[] {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("a hash must be an even-length hexadecimal digest");
  }
  const bytes: number[] = [];
  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  return bytes;
}

/** `BASE64URL(SHA256(ASCII(verifier)))` — the `S256` challenge. */
export function codeChallengeFor(verifier: string, hash: HashFn): string {
  return base64UrlEncode(bytesFromHex(hash(verifier)));
}

/** A verifier is 43–128 characters of unreserved URL characters (RFC 7636 §4.1). */
export function isWellFormedVerifier(value: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

/**
 * Compare without leaking where they differ. The verifier is the secret half of
 * PKCE, so an early-exit comparison would let a client discover it one character
 * at a time — which is exactly the attack PKCE exists to stop.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

export type PkceResult = { ok: true } | { ok: false; reason: string };

export function verifyCodeChallenge(
  input: { verifier: string; challenge: string; method: string },
  hash: HashFn,
): PkceResult {
  if (input.method !== "S256") {
    return { ok: false, reason: `“${input.method}” is not a code challenge method this provider accepts; use S256.` };
  }
  if (!input.challenge) return { ok: false, reason: "The authorization request carried no code challenge." };
  if (!isWellFormedVerifier(input.verifier)) {
    return { ok: false, reason: "The code verifier is not a well-formed PKCE verifier." };
  }
  if (!timingSafeEqual(codeChallengeFor(input.verifier, hash), input.challenge)) {
    return { ok: false, reason: "The code verifier does not match the challenge this code was issued for." };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*  The authorization request                                                 */
/* -------------------------------------------------------------------------- */

export interface AuthorizationRequestInput {
  responseType?: string;
  clientId?: string;
  redirectUri?: string;
  /** Space-delimited, as it arrives on the wire. */
  scope?: string;
  state?: string;
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

/**
 * A validated request, or a refusal.
 *
 * `redirectUri` is carried on the failure too, but **only** when the redirect
 * URI itself was registered. That is the RFC 6749 §4.1.2.1 rule: an error may be
 * sent back to a redirect URI we recognise, and never to one we do not, because
 * doing so is how an open redirector is built.
 */
export type AuthorizationDecision =
  | {
      ok: true;
      client: OidcClientRecord;
      redirectUri: string;
      scopes: OidcScope[];
      state: string;
      nonce: string | null;
      codeChallenge: string;
      codeChallengeMethod: "S256";
    }
  | { ok: false; error: string; redirectUri: string | null; state: string | null };

function refuse(error: string, redirectUri: string | null, state: string | null = null): AuthorizationDecision {
  return { ok: false, error, redirectUri, state };
}

/**
 * Check an authorization request against the client it names.
 *
 * The order matters: the redirect URI is settled first, so every refusal after
 * it can be reported to a destination we trust rather than rendered as an error
 * page the user cannot act on.
 */
export function validateAuthorizationRequest(
  input: AuthorizationRequestInput,
  client: OidcClientRecord | null,
): AuthorizationDecision {
  if (!client) return refuse("Unknown client.", null);

  const redirectUri = (input.redirectUri ?? "").trim();
  if (!client.redirectUris.includes(redirectUri)) {
    return refuse("The redirect URI is not one this client registered.", null);
  }

  const state = (input.state ?? "").trim();
  if (!state) return refuse("The request carried no state, so its response could be replayed.", redirectUri);

  if ((input.responseType ?? "") !== "code") {
    return refuse("Only the authorization code flow is supported.", redirectUri, state);
  }

  const method = (input.codeChallengeMethod ?? "").trim();
  if (!input.codeChallenge?.trim() || method !== "S256") {
    return refuse("PKCE with S256 is required, for every client.", redirectUri, state);
  }

  const requested = (input.scope ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!requested.includes("openid")) {
    return refuse("The openid scope is required, or no ID token can be issued.", redirectUri, state);
  }
  const unsupported = requested.filter((scope) => !(SUPPORTED_SCOPES as readonly string[]).includes(scope));
  if (unsupported.length > 0) {
    // Refused rather than ignored: silently dropping a scope means silently
    // withholding claims the client asked for, which it then discovers as a
    // missing name in its own UI.
    return refuse(`This provider does not issue the scope${unsupported.length === 1 ? "" : "s"} ${unsupported.join(", ")}.`, redirectUri, state);
  }
  const notGranted = requested.filter((scope) => !(client.scopes as readonly string[]).includes(scope));
  if (notGranted.length > 0) {
    return refuse(`This client is not registered for the scope${notGranted.length === 1 ? "" : "s"} ${notGranted.join(", ")}.`, redirectUri, state);
  }

  return {
    ok: true,
    client,
    redirectUri,
    scopes: requested as OidcScope[],
    state,
    nonce: (input.nonce ?? "").trim() || null,
    codeChallenge: input.codeChallenge.trim(),
    codeChallengeMethod: "S256",
  };
}

/**
 * Whether two redirect URIs are the same one.
 *
 * Exact string equality, deliberately: no trailing-slash tolerance, no case
 * folding, no default ports. Each of those is a way for two different origins to
 * look like one, and the code is delivered to whatever this returns `true` for.
 */
export function isSameClientRedirect(registered: string, presented: string): boolean {
  return registered === presented;
}

/* -------------------------------------------------------------------------- */
/*  Claims                                                                    */
/* -------------------------------------------------------------------------- */

/** The identity fields the token and userinfo endpoints project. */
export interface ClaimIdentity {
  id: string;
  identifier: string;
  displayName: string;
  role: string;
  mfaEnrolled: boolean;
}

export interface IdTokenInput {
  issuer: string;
  clientId: string;
  identity: ClaimIdentity;
  sessionId: string;
  scopes: readonly string[];
  nonce?: string | null;
  nowMs: number;
  ttlSeconds?: number;
  /** When the human actually authenticated — not when this token was minted. */
  authTimeMs?: number;
}

/**
 * The ID token's claims.
 *
 * `sub` is the identity's own id, and it is the same value `userinfo` returns:
 * a client keys its local user on it, so an id that moved between the two would
 * fork every account. The profile claims are gated by the scope that asked for
 * them — an `email` claim in a token whose client never requested `email` is
 * data leaving the provider for no reason.
 */
export function idTokenClaims(input: IdTokenInput): Record<string, unknown> {
  const ttl = input.ttlSeconds ?? TOKEN_TTL_SECONDS;
  const claims: Record<string, unknown> = {
    iss: normalizeIssuer(input.issuer),
    sub: input.identity.id,
    aud: input.clientId,
    iat: Math.floor(input.nowMs / 1000),
    exp: Math.floor(input.nowMs / 1000) + ttl,
    auth_time: Math.floor((input.authTimeMs ?? input.nowMs) / 1000),
    sid: input.sessionId,
    amr: input.identity.mfaEnrolled ? ["pwd", "mfa"] : ["pwd"],
  };
  if (input.nonce) claims.nonce = input.nonce;

  Object.assign(claims, profileClaims(input.identity, input.scopes));
  return claims;
}

/**
 * The claims a scope unlocks, shared by the ID token and the userinfo endpoint so
 * the two cannot disagree about what an `email` scope means.
 */
export function profileClaims(identity: ClaimIdentity, scopes: readonly string[]): Record<string, unknown> {
  const claims: Record<string, unknown> = {};
  if (scopes.includes("profile")) {
    claims.name = identity.displayName;
    claims.preferred_username = identity.identifier;
  }
  if (scopes.includes("email")) {
    claims.email = identity.identifier;
    // The provider only ever issues identity it has verified — a customer's
    // directory is synced from theirs — so this is a statement, not a guess.
    claims.email_verified = true;
  }
  if (scopes.includes("roles")) {
    claims.roles = [identity.role];
  }
  return claims;
}

/** The userinfo endpoint's body. `sub` must match the ID token's, always. */
export function userinfoClaims(identity: ClaimIdentity, scopes: readonly string[]): Record<string, unknown> {
  return { sub: identity.id, ...profileClaims(identity, scopes) };
}

/* -------------------------------------------------------------------------- */
/*  Logout (RP-initiated) and revocation (RFC 7009)                           */
/* -------------------------------------------------------------------------- */

/**
 * Whether a token is still worth anything.
 *
 * Revocation is checked before expiry, and for the obvious reason: a token the
 * desk has already killed must not become usable again by nobody looking — the
 * answer has to be the same at every entry point, so it is one function.
 */
export function isTokenActive(
  record: { revokedAt: number | null; expiresAt: number },
  nowMs: number,
): boolean {
  if (record.revokedAt !== null) return false;
  return nowMs < record.expiresAt;
}

/** Why a token stopped being usable, for a message a person can read. */
export function tokenInactiveReason(
  record: { revokedAt: number | null; expiresAt: number },
  nowMs: number,
): string | null {
  if (record.revokedAt !== null) return "it was revoked";
  if (nowMs >= record.expiresAt) return "it has expired";
  return null;
}

export interface LogoutRequestInput {
  /**
   * The session being ended. Not read by these rules — the provider's cookie is
   * the only place it comes from — but part of the shape so a caller can hand the
   * whole request to one function.
   */
  sessionId?: string;
  /** The client asking. Required, because it is the only thing that names a tenant. */
  clientId?: string;
  /** Where to send the browser afterwards. Must be registered, or it is ignored. */
  postLogoutRedirectUri?: string;
  /** Echoed back on the redirect, unchanged. */
  state?: string;
  /**
   * The ID token the client is signing out of. Accepted but not trusted: this
   * provider does not need it to find the session, because the session id comes
   * from our own cookie. It is carried so a client can send what the standard
   * tells it to without an error.
   */
  idTokenHint?: string;
}

export type LogoutDecision =
  | { ok: true; client: OidcClientRecord; redirectTo: string | null }
  | { ok: false; error: string; redirectTo: string | null };

/**
 * Check an RP-initiated logout.
 *
 * The same rule as authorize applies to the destination: **a redirect is only
 * ever to a URI this client registered.** `post_logout_redirect_uri` is the
 * easiest place to build an open redirector, because a client can be talked into
 * passing anything through, so an unregistered one is *dropped* — the session is
 * still ended, and the browser is simply not sent anywhere by us.
 *
 * A `client_id` is required rather than optional. Without it there is no way to
 * know which organization's session is being ended, and guessing would be the
 * one cross-tenant read this product does not have.
 */
export function validateLogoutRequest(
  input: LogoutRequestInput,
  client: OidcClientRecord | null,
): LogoutDecision {
  const clientId = (input.clientId ?? "").trim();
  if (!clientId) {
    return { ok: false, error: "A client_id is required, so the session's organization is known.", redirectTo: null };
  }
  if (!client || client.clientId !== clientId) {
    return { ok: false, error: "Unknown client.", redirectTo: null };
  }

  const requested = (input.postLogoutRedirectUri ?? "").trim();
  if (!requested) return { ok: true, client, redirectTo: null };

  if (!client.redirectUris.includes(requested)) {
    // Not an error the user can act on, so it is not one: the session ends and
    // the browser is left where it is. Saying "that URI is not registered" to a
    // browser is how a client learns which URIs exist.
    return { ok: true, client, redirectTo: null };
  }
  return { ok: true, client, redirectTo: appendState(requested, input.state) };
}

/** Add `state` to a redirect, leaving whatever the URI already carried intact. */
function appendState(uri: string, state: string | undefined): string {
  const trimmed = (state ?? "").trim();
  if (!trimmed) return uri;
  const url = new URL(uri);
  url.searchParams.set("state", trimmed);
  return url.toString();
}

/**
 * The token types a caller may hint at. Unrecognised hints are ignored rather
 * than refused, as RFC 7009 requires: the hint is a lookup optimisation for the
 * server, not a claim the caller has to get right, and refusing one would make
 * revocation fail for a client that guessed the wrong noun.
 */
export const KNOWN_TOKEN_TYPE_HINTS = ["access_token", "refresh_token"] as const;

export type RevocationDecision = { ok: true; token: string } | { ok: false; error: string };

export function validateRevocationRequest(input: { token?: string; tokenTypeHint?: string }): RevocationDecision {
  const token = (input.token ?? "").trim();
  if (!token) return { ok: false, error: "A token is required." };
  return { ok: true, token };
}
