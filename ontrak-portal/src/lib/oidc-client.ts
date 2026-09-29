/**
 * The two network calls a sign-in makes, and the key material it needs.
 *
 * The decisions live in `oidc-rules.ts`; this file only fetches. It is written
 * with `fetch` and `jose` and nothing else — `jose` because verifying an RS256
 * signature by hand is exactly the kind of code that looks fine and accepts a
 * forgery, and the estate's other Next.js products already depend on it, so it is
 * not a new package in the family.
 *
 * Discovery and the JWKS are cached for an hour per process: a sign-in is then
 * two calls to the provider rather than four, and a provider that briefly stops
 * answering does not sign everybody out.
 */

import { createHash } from "node:crypto";

import { createRemoteJWKSet, jwtVerify } from "jose";

import { portalConfig, redirectUri } from "./config";
import type { AuthorizationState } from "./oidc-rules";

/**
 * RFC 7636 S256: the challenge that goes to the provider, from the verifier that
 * is kept back. It lives here rather than in `oidc-rules` because it needs a hash,
 * and `oidc-rules` is imported by a client component — a `node:crypto` import at
 * the top of that file would fail the browser bundle for the sake of one helper
 * the browser never calls.
 */
function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

const DISCOVERY_TTL_SECONDS = 3600;
const HTTP_TIMEOUT_MS = 20_000;

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

export class OidcError extends Error {}

let cached: { document: Discovery; at: number } | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksUri = "";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new OidcError(
      `the identity provider could not be reached at ${new URL(url).origin}: ` +
      `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new OidcError(
      `the identity provider refused the request (${response.status}): ${text.slice(0, 300)}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new OidcError("the identity provider returned a response that is not JSON");
  }
}

export async function discovery(): Promise<Discovery> {
  const config = portalConfig();
  if (!config.issuer) throw new OidcError("single sign-on is not configured for this portal");
  const now = Date.now();
  if (cached && now - cached.at < DISCOVERY_TTL_SECONDS * 1000) return cached.document;

  const document = await fetchJson<Discovery>(
    `${config.issuer}/.well-known/openid-configuration`,
  );
  // The document has to name the issuer it was asked about. A document that
  // renames it elsewhere is how a redirect quietly leaves the estate.
  const advertised = (document.issuer ?? "").replace(/\/+$/, "");
  if (advertised && advertised !== config.issuer) {
    throw new OidcError(
      `${config.providerName} advertises issuer ${advertised}, not ${config.issuer}`,
    );
  }
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (!document[key]) {
      throw new OidcError(`${config.providerName}'s discovery document has no ${key}`);
    }
  }
  cached = { document, at: now };
  return document;
}

/** The JWKS, fetched once per process and rotated by `jose` when a `kid` is new. */
export async function keySet(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const document = await discovery();
  if (!jwks || jwksUri !== document.jwks_uri) {
    jwks = createRemoteJWKSet(new URL(document.jwks_uri));
    jwksUri = document.jwks_uri;
  }
  return jwks;
}

/** The address to send the browser to, with PKCE and a nonce. */
export async function authorizationUrl(state: AuthorizationState): Promise<string> {
  const config = portalConfig();
  const document = await discovery();
  const callback = redirectUri(config);
  if (!callback) {
    throw new OidcError(
      "ONTRAK_PORTAL_PUBLIC_URL is not set, so there is no redirect URI to register "
      + "with the provider — and one built from the container's own address can never match.",
    );
  }
  const query = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: callback,
    scope: config.scopes,
    state: state.state,
    nonce: state.nonce,
    code_challenge: codeChallenge(state.verifier),
    code_challenge_method: "S256",
  });
  return `${document.authorization_endpoint}?${query.toString()}`;
}

export interface TokenResponse {
  id_token?: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
}

export async function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
  const config = portalConfig();
  const document = await discovery();
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(config),
    client_id: config.clientId,
    code_verifier: verifier,
  });
  if (config.clientSecret) form.set("client_secret", config.clientSecret);
  return fetchJson<TokenResponse>(document.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  });
}

/**
 * Verify the ID token's signature and standard claims, and return its payload.
 *
 * `jose` performs the signature check against the provider's JWKS, including
 * rejecting `alg: none` and the symmetric family — a provider that signed with a
 * key we hold would make this service the provider. The claim decisions that
 * follow (issuer, audience, nonce, expiry, the domain rule) are in
 * `oidc-rules.checkClaims`, so they can be tested without a network.
 */
export async function verifyIdToken(idToken: string): Promise<Record<string, unknown>> {
  if (!idToken) throw new OidcError("the provider returned no ID token");
  const config = portalConfig();
  const document = await discovery();
  const keys = await keySet();
  try {
    const { payload } = await jwtVerify(idToken, keys, {
      // The issuer **as the provider advertises it**, never the normalized form
      // `config.issuer` holds: `jose` compares this option byte for byte, and
      // Authentik's application-scoped issuer ends in a slash
      // (`.../application/o/ontrak/`). Handing `jose` the stripped string rejects
      // a token that is entirely valid, with `unexpected "iss" claim value` —
      // after the password has already been typed, which is the worst place for it.
      // `checkClaims` still compares the two with the trailing slash ignored, so a
      // discovery document naming some other issuer is refused either way.
      issuer: document.issuer || config.issuer,
      audience: config.clientId,
      algorithms: ["RS256", "ES256"],
      // The clock skew is applied again in `checkClaims` for the readings `jose`
      // does not police; keeping both means neither one is the only defence.
      clockTolerance: 90,
    });
    return payload as Record<string, unknown>;
  } catch (cause) {
    throw new OidcError(
      `the ID token was not accepted: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * Claims from the userinfo endpoint.
 *
 * Not required — the ID token is authoritative — but Authentik includes `groups`
 * here, and reading them is what lets a role be decided when the ID token alone
 * carries none.
 */
export async function userinfo(accessToken: string): Promise<Record<string, unknown>> {
  if (!accessToken) return {};
  const document = await discovery();
  if (!document.userinfo_endpoint) return {};
  try {
    return await fetchJson<Record<string, unknown>>(document.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
  } catch {
    // A userinfo failure is not a sign-in failure: the ID token already carried
    // the subject and the email. The group list may be missing, and the role
    // falls back to the default, which the login page states.
    return {};
  }
}
