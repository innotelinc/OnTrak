/**
 * OIDC client: the two network calls of an authorization-code handshake.
 *
 * The decisions all live in `oidc-rules.ts`; this module is the seam that makes
 * them testable without a provider. Two implementations ship:
 *
 *  - `HttpOidcClient` fetches the discovery document and exchanges the code for
 *    an ID token, verifying the token's signature against the provider's JWKS
 *    (via `jose`). It is what the `/api/sso` routes use.
 *  - `MemoryOidcClient` answers from a fixture, so the routes and the whole
 *    sign-in path can be exercised with no network at all.
 *
 * PKCE is mandatory here rather than optional: the deployment's client is often a
 * public one (a self-hosted provider registering an app with no secret), and a
 * public client without PKCE would accept a stolen code.
 */

import { createHash, randomBytes } from "node:crypto";

import { createRemoteJWKSet, jwtVerify } from "jose";

import { discoveryUrl, validateDiscovery, type OidcDiscovery } from "./oidc-rules";

export interface TokenExchangeInput {
  discovery: OidcDiscovery;
  clientId: string;
  /** `null` for a public client using PKCE only. */
  clientSecret: string | null;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export interface TokenExchangeResult {
  idToken: string;
  /** The verified ID token payload, ready for `extractOidcClaims`. */
  payload: Record<string, unknown>;
  accessToken?: string;
}

export interface OidcClient {
  discover(issuer: string): Promise<OidcDiscovery>;
  exchangeCode(input: TokenExchangeInput): Promise<TokenExchangeResult>;
}

/* -------------------------------------------------------------------------- */
/*  PKCE                                                                      */
/* -------------------------------------------------------------------------- */

/** URL-safe random bytes, for a `state`, a `nonce` or a PKCE verifier. */
export function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** The S256 challenge for a verifier. */
export function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomUrlSafe(32);
  return { verifier, challenge: codeChallengeFor(verifier) };
}

/* -------------------------------------------------------------------------- */
/*  HTTP client                                                               */
/* -------------------------------------------------------------------------- */

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export class HttpOidcClient implements OidcClient {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async discover(issuer: string): Promise<OidcDiscovery> {
    const response = await this.fetchImpl(discoveryUrl(issuer), { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`The identity provider discovery endpoint answered ${response.status}.`);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("The identity provider discovery document was not JSON.");
    }
    const validated = validateDiscovery(body, issuer);
    if (!validated.ok) throw new Error(validated.reason);
    return validated.discovery;
  }

  async exchangeCode(input: TokenExchangeInput): Promise<TokenExchangeResult> {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.codeVerifier,
    });
    if (input.clientSecret) form.set("client_secret", input.clientSecret);

    const response = await this.fetchImpl(input.discovery.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
    });
    if (!response.ok) throw new Error(`The identity provider token endpoint answered ${response.status}.`);

    const body = (await response.json()) as Record<string, unknown>;
    const idToken = stringField(body.id_token);
    if (!idToken) throw new Error("The token response carried no ID token.");

    // Verify the signature against the provider's published keys, and the issuer
    // and audience against what we asked for. A token that fails either is not
    // evidence of anything.
    const jwks = createRemoteJWKSet(new URL(input.discovery.jwksUri));
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: input.discovery.issuer,
      audience: input.clientId,
    });

    return {
      idToken,
      payload: payload as Record<string, unknown>,
      ...(stringField(body.access_token) ? { accessToken: stringField(body.access_token) } : {}),
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Memory client (tests and local work)                                      */
/* -------------------------------------------------------------------------- */

/** A client that answers from a fixture, so the handshake needs no provider. */
export class MemoryOidcClient implements OidcClient {
  constructor(
    private readonly config: {
      /** Fields merged over the synthesized discovery document. */
      discovery?: Partial<OidcDiscovery>;
      /** ID token payloads keyed by authorization code. */
      payloads?: Record<string, Record<string, unknown>>;
    } = {},
  ) {}

  async discover(issuer: string): Promise<OidcDiscovery> {
    const base = issuer.trim().replace(/\/+$/, "");
    return {
      issuer,
      authorizationEndpoint: `${base}/authorize`,
      tokenEndpoint: `${base}/token`,
      jwksUri: `${base}/jwks.json`,
      ...this.config.discovery,
    };
  }

  async exchangeCode(input: TokenExchangeInput): Promise<TokenExchangeResult> {
    const payload = this.config.payloads?.[input.code];
    if (!payload) throw new Error(`No ID token fixture for authorization code "${input.code}".`);
    return { idToken: "memory.id.token", payload };
  }
}
