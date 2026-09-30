/**
 * Authentik (OIDC) sign-in for the API and the console.
 *
 * Why this exists: the console can read, edit and run code. `WEB_TOKEN` is a
 * shared secret in a file, which is the right thing for a laptop and the wrong
 * thing for the family — nothing binds it to a person, nothing expires it, and
 * revoking it revokes it for everyone. A deployment behind Cerulean's Authentik
 * gets the family's property instead: a role change takes effect everywhere at
 * once, because nothing here is copied anywhere.
 *
 * Built on `node:crypto` deliberately, matching the rest of this project, which
 * ships with no runtime dependencies at all. That means the JWT verification
 * below is ours, so its rules are stated rather than inherited:
 *
 *   - the algorithm is pinned to RS* (never `none`, never an HMAC, so an
 *     `alg: HS256` header cannot be used to trick us into signing with the
 *     public key as the secret);
 *   - the issuer must be what discovery published *and* what was configured;
 *   - the audience must include our client id, and `azp` is checked when the
 *     token names several audiences;
 *   - `exp` is required, `iat` may not be in the future, and the `nonce` must
 *     match the one this login started with.
 *
 * Sign-in is optional and off until configured: with no issuer, no client id or
 * no session secret, `oidcEnabled()` is false and the server behaves exactly as
 * it did before — `WEB_TOKEN`, or nothing on loopback.
 */

import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { config } from "./config.js";

const DISCOVERY_TTL_MS = 10 * 60_000;
const JWKS_TTL_MS = 10 * 60_000;
/** How long a started sign-in stays valid. It is a browser round trip, not a session. */
const STATE_TTL_MS = 10 * 60_000;
const HTTP_TIMEOUT_MS = 10_000;

export const SESSION_COOKIE = "ontrak_genie_session";
/** Only RS* is accepted: the family's provider signs with RSA. */
const ALLOWED_ALGS: Record<string, string> = {
  RS256: "RSA-SHA256",
  RS384: "RSA-SHA384",
  RS512: "RSA-SHA512",
};

export interface Identity {
  sub: string;
  email: string;
  name: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/**
 * True when a deployment has asked for sign-in. All three are required: an
 * issuer with no client id cannot be redirected to, and no session secret means
 * no way to remember the answer, which would mean re-authenticating every call.
 */
export function oidcEnabled(): boolean {
  return config.oidcIssuer !== "" && config.oidcClientId !== "" && config.oidcSessionSecret !== "";
}

/**
 * The address the provider sends the browser back to.
 *
 * Configured explicitly, because it has to match the redirect URI the provider
 * registered *byte for byte*, and it is the address the *browser* reaches — not
 * the one this process is bound to. Deriving it from HOST would send
 * `0.0.0.0` to the provider, which is why the fallback is loopback only.
 *
 * A deployment reachable at more than one name (the family's
 * `genie.ontrak.innotel.us` and the platform's `genie.innotel.us`) may list them
 * comma-separated. The provider matches the URI, so a name that is not listed
 * cannot sign in; the entry whose host matches the browser's `Host` header is
 * chosen, and the first entry is the default for any other caller.
 */
export function pickRedirectUri(configured: string, host: string | undefined, port: number): string {
  const uris = configured
    .split(",")
    .map((uri) => uri.trim())
    .filter((uri) => uri !== "");
  const first = uris[0];
  if (first === undefined) return `http://127.0.0.1:${port}/api/auth/callback`;
  if (uris.length === 1 || !host) return first;
  const wanted = (host.split(":")[0] ?? "").toLowerCase();
  const match = uris.find((uri) => {
    try {
      return new URL(uri).hostname.toLowerCase() === wanted;
    } catch {
      return false;
    }
  });
  return match ?? first;
}

export function redirectUri(host?: string): string {
  return pickRedirectUri(config.oidcRedirectUrl, host, config.port);
}

// --- small helpers ----------------------------------------------------------

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}: ${text.slice(0, 200)}`);
  }
  return parseJson<Record<string, unknown>>(text);
}

// --- discovery + keys -------------------------------------------------------

let discoveryCache: { at: number; value: Discovery } | null = null;
let jwksCache: { at: number; value: Record<string, unknown>[] } | null = null;

/** The provider's own description of itself. Cached: it changes when it is redeployed. */
export async function discover(force = false): Promise<Discovery> {
  if (!force && discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) {
    return discoveryCache.value;
  }
  const base = config.oidcIssuer.replace(/\/+$/, "");
  const doc = await fetchJson(`${base}/.well-known/openid-configuration`);
  const value: Discovery = {
    issuer: String(doc.issuer ?? ""),
    authorization_endpoint: String(doc.authorization_endpoint ?? ""),
    token_endpoint: String(doc.token_endpoint ?? ""),
    jwks_uri: String(doc.jwks_uri ?? ""),
  };
  for (const [key, entry] of Object.entries(value)) {
    if (entry === "") throw new Error(`discovery document has no ${key}`);
  }
  // A document that names a different issuer than the one that served it is how
  // a mix-up attack starts: the provider we trusted would be vouching for
  // tokens from somewhere else.
  //
  // A trailing slash is not a different issuer. Authentik publishes its issuer
  // with one (`…/application/o/ontrak/`) while a deployment naturally configures
  // it without, and both name the same provider — the same leniency `base`
  // already applies when it strips one to build the discovery URL.
  if (value.issuer.replace(/\/+$/, "") !== base) {
    throw new Error(`discovery issuer ${value.issuer} does not match configured ${config.oidcIssuer}`);
  }
  discoveryCache = { at: Date.now(), value };
  return value;
}

async function signingKeys(force = false): Promise<Record<string, unknown>[]> {
  if (!force && jwksCache && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.value;
  const { jwks_uri } = await discover();
  const doc = await fetchJson(jwks_uri);
  const keys = Array.isArray(doc.keys) ? (doc.keys as Record<string, unknown>[]) : [];
  if (keys.length === 0) throw new Error("JWKS contained no keys");
  jwksCache = { at: Date.now(), value: keys };
  return keys;
}

// --- id_token verification --------------------------------------------------

export interface IdTokenClaims extends Record<string, unknown> {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  azp?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
}

/**
 * Verify an `id_token` and return its claims, or throw.
 *
 * Every check here is one an attacker would otherwise get for free, so the
 * function is deliberately strict: it returns nothing rather than a partially
 * trusted token.
 */
export async function verifyIdToken(idToken: string, expectedNonce: string): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("id_token is not a JWS");
  const [header64, payload64, signature64] = parts as [string, string, string];

  const header = parseJson<{ alg?: string; kid?: string; typ?: string }>(fromBase64Url(header64).toString("utf8"));
  const algorithm = header.alg ?? "";
  const hash = ALLOWED_ALGS[algorithm];
  if (hash === undefined) throw new Error(`id_token alg ${algorithm || "(none)"} is not accepted`);
  if (header.typ !== undefined && header.typ.toUpperCase() !== "JWT") {
    throw new Error(`id_token typ ${header.typ} is not accepted`);
  }

  const keys = await signingKeys();
  const jwk = header.kid !== undefined ? keys.find((key) => key.kid === header.kid) : undefined;
  // A single key with no kid is the common case for a small provider; more than
  // one and the kid has to name which, because guessing is how a stale key gets
  // used.
  const chosen = jwk ?? (header.kid === undefined && keys.length === 1 ? keys[0] : undefined);
  if (chosen === undefined) throw new Error("id_token key is not in the JWKS");

  const key = crypto.createPublicKey({ key: chosen as crypto.JsonWebKey, format: "jwk" });
  const signed = Buffer.from(`${header64}.${payload64}`, "utf8");
  const valid = crypto.verify(hash, signed, key, fromBase64Url(signature64));
  if (!valid) throw new Error("id_token signature is invalid");

  const claims = parseJson<IdTokenClaims>(fromBase64Url(payload64).toString("utf8"));
  const discovery = await discover();

  if (claims.iss !== discovery.issuer && claims.iss !== config.oidcIssuer) {
    throw new Error("id_token issuer does not match");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.oidcClientId)) throw new Error("id_token audience does not include this client");
  // When a token names several audiences, `azp` says which client it was really
  // issued to — without this check another client of the same provider could
  // hand us its token.
  if (audiences.length > 1 && claims.azp !== config.oidcClientId) {
    throw new Error("id_token azp is not this client");
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number") throw new Error("id_token has no exp");
  if (claims.exp <= now) throw new Error("id_token has expired");
  if (typeof claims.iat === "number" && claims.iat > now + 120) {
    throw new Error("id_token was issued in the future");
  }
  if (claims.nonce !== expectedNonce) throw new Error("id_token nonce does not match this sign-in");

  if (typeof claims.sub !== "string" || claims.sub === "") throw new Error("id_token has no subject");
  return claims;
}

// --- the sign-in round trip -------------------------------------------------

interface Pending {
  verifier: string;
  nonce: string;
  at: number;
  /** Where the browser was headed when it was sent to the provider. */
  returnTo: string;
  /** The redirect URI this sign-in started with, so the exchange matches it. */
  redirectUri: string;
}

/**
 * A path this deployment will send a browser to after a sign-in, or `/`.
 *
 * Only a path on this origin is accepted. A `next` that is an absolute URL turns
 * the gate into an open redirect — the browser goes to the provider to prove who
 * it is and comes back elsewhere — and `//host` is an absolute URL wearing a
 * path's clothes, so it is refused with it. A path is still usable for the only
 * thing this is for: coming back to the page you asked for.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (typeof value !== "string" || value === "") return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

/**
 * Started sign-ins, keyed by state.
 *
 * In memory on purpose: this is one process, a sign-in lasts a browser round
 * trip, and a restart losing them costs a click. Storing them in the data
 * directory would be state to secure for no gain.
 */
const pending = new Map<string, Pending>();

function sweep(now = Date.now()): void {
  for (const [state, entry] of pending) {
    if (now - entry.at > STATE_TTL_MS) pending.delete(state);
  }
}

/**
 * Where to send the browser, and the state that ties the answer back to it.
 *
 * `host` is the browser's `Host` header: on a deployment with more than one
 * name it decides which of the configured redirect URIs this sign-in uses, and
 * that choice is stored with the state so the token exchange repeats it.
 */
export async function beginLogin(returnTo = "/", host?: string): Promise<string> {
  sweep();
  const discovery = await discover();
  const uri = redirectUri(host);
  const state = crypto.randomBytes(16).toString("base64url");
  const nonce = crypto.randomBytes(16).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  pending.set(state, { verifier, nonce, at: Date.now(), returnTo: safeReturnTo(returnTo), redirectUri: uri });

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.oidcClientId);
  url.searchParams.set("redirect_uri", uri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export class LoginError extends Error {}

/** The identity a sign-in proved, and the path it was started from. */
export interface CompletedLogin {
  identity: Identity;
  returnTo: string;
}

/**
 * Exchange the code and verify the token it came with.
 *
 * The state is consumed before the exchange, so a replayed callback finds
 * nothing rather than a second session.
 */
export async function completeLogin(code: string, state: string): Promise<CompletedLogin> {
  sweep();
  const entry = pending.get(state);
  if (entry === undefined) throw new LoginError("this sign-in is unknown or has expired — start again");
  pending.delete(state);
  if (code === "") throw new LoginError("the provider returned no code");

  const discovery = await discover();
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: entry.redirectUri,
    client_id: config.oidcClientId,
    code_verifier: entry.verifier,
  });
  // A public client has no secret; a confidential one does. Both are normal, so
  // the parameter is omitted rather than sent empty, which some providers reject.
  if (config.oidcClientSecret !== "") form.set("client_secret", config.oidcClientSecret);

  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  // Some providers also want basic auth; sending it as well is harmless and is
  // what the spec calls for with a secret.
  if (config.oidcClientSecret !== "") {
    headers.Authorization =
      "Basic " + Buffer.from(`${config.oidcClientId}:${config.oidcClientSecret}`).toString("base64");
  }

  const tokens = await fetchJson(discovery.token_endpoint, { method: "POST", headers, body: form });
  const idToken = tokens.id_token;
  if (typeof idToken !== "string") throw new LoginError("the provider returned no id_token");

  const claims = await verifyIdToken(idToken, entry.nonce);
  const email = typeof claims.email === "string" ? claims.email : "";
  const name =
    (typeof claims.name === "string" && claims.name) ||
    (typeof claims.preferred_username === "string" && claims.preferred_username) ||
    email ||
    claims.sub;
  return { identity: { sub: claims.sub, email, name }, returnTo: entry.returnTo };
}

/** Drop a started sign-in, e.g. when the provider answered with an error. */
export function abandonLogin(state: string): void {
  pending.delete(state);
}

// --- the session cookie -----------------------------------------------------

export interface Session extends Identity {
  exp: number;
}

function sign(data: string): string {
  return crypto.createHmac("sha256", config.oidcSessionSecret).update(data).digest("base64url");
}

/**
 * A signed, self-contained session.
 *
 * Not encrypted, because it holds nothing worth hiding — a subject, an email and
 * an expiry — and everything it authorises is re-checked against the workspace
 * anyway. Signed so it cannot be edited, which is the part that matters: the
 * only thing a caller would want to change is the expiry.
 */
export function mintSession(identity: Identity): string {
  const claims: Session = {
    ...identity,
    exp: Math.floor(Date.now() / 1000) + config.oidcSessionHours * 3600,
  };
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
}

export function readSession(value: string): Session | null {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [header64, payload64, signature64] = parts as [string, string, string];

  const expected = sign(`${header64}.${payload64}`);
  const given = Buffer.from(signature64, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  // Length first: timingSafeEqual throws on a length mismatch, and the throw
  // would be the leak it exists to avoid.
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return null;

  let claims: Session;
  try {
    claims = parseJson<Session>(fromBase64Url(payload64).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000)) return null;
  if (typeof claims.sub !== "string" || claims.sub === "") return null;
  return claims;
}

// --- reading it off a request ----------------------------------------------

function cookieValue(req: IncomingMessage, name: string): string {
  const raw = req.headers.cookie;
  if (raw === undefined) return "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

/** The signed-in identity, or null. Never throws: a bad cookie is simply not a session. */
export function sessionFrom(req: IncomingMessage): Session | null {
  if (!oidcEnabled()) return null;
  const value = cookieValue(req, SESSION_COOKIE);
  return value === "" ? null : readSession(value);
}

function attributes(maxAgeSeconds: number): string {
  // `Secure` follows the redirect URI rather than a separate switch: a cookie
  // the browser will not send back is a worse failure than one it sends in the
  // clear, and the redirect URI is the deployment's own statement about scheme.
  const secure = redirectUri().startsWith("https://") ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; ${attributes(config.oidcSessionHours * 3600)}`;
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; ${attributes(0)}`;
}

/** Test seam: forget cached discovery, keys and in-flight sign-ins. */
export function resetOidcCaches(): void {
  discoveryCache = null;
  jwksCache = null;
  pending.clear();
}
