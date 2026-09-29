/**
 * A real, minimal OpenID Connect provider for tests.
 *
 * The rest of the SSO suite exercises the pure rules and the `MemoryOidcClient`
 * fixture, which proves the *decisions* but not the *handshake*. This boots an
 * actual HTTP provider on a loopback port and signs actual ID tokens with a real
 * key, so a test can drive the whole authorization-code flow — discovery, the
 * authorize redirect, the token exchange, and `jose` verifying the signature
 * against a published JWKS — with no network and no vendor account.
 *
 * It is deliberately strict where a real provider is strict, so the client is
 * tested against the checks that matter:
 *
 *  - the authorization request must name a client, a `response_type=code`, a
 *    `nonce` and an S256 PKCE challenge;
 *  - a code is single-use and expires;
 *  - the token exchange must present the matching `code_verifier`, the same
 *    `redirect_uri`, and the client secret when one is configured.
 *
 * Options let a test make it *fail* on purpose — a decoy signing key, a
 * different client secret — so "the app refuses a forged token" is proven rather
 * than assumed.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { SignJWT, exportJWK, generateKeyPair } from "jose";

export interface LocalIdpOptions {
  /** Claims merged into every ID token. */
  claims?: Record<string, unknown>;
  /** When set, the token endpoint requires this client secret. */
  clientSecret?: string;
  /** How long an authorization code stays usable. */
  codeTtlSeconds?: number;
  /**
   * Sign ID tokens with a key the provider does *not* publish. The token looks
   * well-formed and the JWKS resolves, but the signature cannot verify — the
   * "hostile provider" case.
   */
  signWithUnpublishedKey?: boolean;
}

export interface LocalIdp {
  /** The issuer identifier, which is also the discovery base URL. */
  readonly issuer: string;
  readonly clientId: string;
  /** Every code the provider issued, in order, for assertions. */
  readonly issuedCodes: readonly string[];
  /** Calls to each endpoint, so a test can assert one happened (or did not). */
  readonly calls: { authorize: number; token: number; jwks: number; discovery: number };
  close(): Promise<void>;
}

export const LOCAL_IDP_CLIENT_ID = "ontrak-training-test";

interface PendingCode {
  challenge: string;
  nonce: string;
  redirectUri: string;
  expiresAt: number;
}

function send(response: ServerResponse, status: number, body: unknown, contentType = "application/json"): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  response.end(text);
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Start the provider on an ephemeral loopback port. Always `close()` it — the
 * tests do so in a `finally`.
 */
export async function startLocalIdp(options: LocalIdpOptions = {}): Promise<LocalIdp> {
  const published = await generateKeyPair("ES256");
  const decoy = await generateKeyPair("ES256");
  const signingKey: CryptoKey = options.signWithUnpublishedKey ? decoy.privateKey : published.privateKey;
  const kid = "local-idp-1";
  const publicJwk = { ...(await exportJWK(published.publicKey)), kid, alg: "ES256", use: "sig" };

  const codes = new Map<string, PendingCode>();
  const issued: string[] = [];
  const calls = { authorize: 0, token: 0, jwks: 0, discovery: 0 };

  let issuer = "";

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      send(response, 500, { error: "server_error", error_description: String(error) });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", issuer || "http://127.0.0.1");
    const path = url.pathname;

    if (path === "/.well-known/openid-configuration") {
      calls.discovery += 1;
      return send(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks.json`,
        userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["ES256"],
        code_challenge_methods_supported: ["S256"],
      });
    }

    if (path === "/jwks.json") {
      calls.jwks += 1;
      return send(response, 200, { keys: [publicJwk] });
    }

    if (path === "/authorize") {
      calls.authorize += 1;
      const params = url.searchParams;
      const clientId = params.get("client_id");
      const redirectUri = params.get("redirect_uri");
      const challenge = params.get("code_challenge");
      const method = params.get("code_challenge_method");
      const state = params.get("state");
      const nonce = params.get("nonce") ?? "";

      if (clientId !== LOCAL_IDP_CLIENT_ID) return send(response, 400, { error: "invalid_client" });
      if (!redirectUri) {
        return send(response, 400, { error: "invalid_request", error_description: "redirect_uri is required" });
      }
      if (params.get("response_type") !== "code") {
        return send(response, 400, { error: "unsupported_response_type" });
      }
      if (!challenge || method !== "S256") {
        return send(response, 400, { error: "invalid_request", error_description: "PKCE S256 is required" });
      }
      if (!nonce) return send(response, 400, { error: "invalid_request", error_description: "nonce is required" });

      const code = `code-${issued.length + 1}-${Math.random().toString(36).slice(2, 10)}`;
      codes.set(code, {
        challenge,
        nonce,
        redirectUri,
        expiresAt: Date.now() + (options.codeTtlSeconds ?? 300) * 1000,
      });
      issued.push(code);

      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      if (state) target.searchParams.set("state", state);
      response.writeHead(302, { location: target.toString() });
      response.end();
      return;
    }

    if (path === "/token" && request.method === "POST") {
      calls.token += 1;
      const form = await readForm(request);
      const clientId = form.get("client_id");
      const clientSecret = form.get("client_secret");
      const code = form.get("code") ?? "";
      const verifier = form.get("code_verifier") ?? "";
      const redirectUri = form.get("redirect_uri");

      if (clientId !== LOCAL_IDP_CLIENT_ID) return send(response, 401, { error: "invalid_client" });
      if (options.clientSecret !== undefined && clientSecret !== options.clientSecret) {
        return send(response, 401, { error: "invalid_client", error_description: "bad client secret" });
      }

      const pending = codes.get(code);
      // Single use: a code is consumed on first exchange, so a replay fails.
      if (!pending) return send(response, 400, { error: "invalid_grant", error_description: "unknown or used code" });
      codes.delete(code);

      if (pending.expiresAt < Date.now()) {
        return send(response, 400, { error: "invalid_grant", error_description: "expired code" });
      }
      if (pending.redirectUri !== redirectUri) {
        return send(response, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
      }

      // PKCE: the verifier must hash to the challenge the authorize call sent.
      const { createHash } = await import("node:crypto");
      const computed = createHash("sha256").update(verifier).digest("base64url");
      if (computed !== pending.challenge) {
        return send(response, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      }

      const idToken = await new SignJWT({
        // A real provider echoes the request's nonce, which is what makes the
        // replay check in `extractOidcClaims` able to pass at all.
        nonce: pending.nonce,
        sub: "idp-subject-1",
        email: "sso.user@ontrak.local",
        email_verified: true,
        name: "Ida SSO",
        groups: ["instructors"],
        amr: ["pwd", "otp"],
        mfa: true,
        ...options.claims,
      })
        .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
        .setIssuer(issuer)
        .setAudience(LOCAL_IDP_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(signingKey);

      return send(response, 200, {
        access_token: "local-access-token",
        token_type: "Bearer",
        expires_in: 300,
        id_token: `${idToken}`,
      });
    }

    send(response, 404, { error: "not_found", error_description: path });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${address.port}`;

  return {
    get issuer() {
      return issuer;
    },
    clientId: LOCAL_IDP_CLIENT_ID,
    get issuedCodes() {
      return issued;
    },
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
