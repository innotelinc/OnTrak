/**
 * Upstream sign-in service: the non-pure half of handing the console to a provider.
 *
 * `upstream-rules.ts` decides everything that can be decided from arguments; this file is
 * where the network, the clock and the cryptography live. The shape mirrors the product's
 * other logins: resolve, verify, then let `IdentityService.issueSession` make the session —
 * the spine re-checks the policy on the identity it is handed, so an upstream grant cannot
 * walk around a deactivated identity or an owed second factor any more than a password can.
 *
 * The handshake, and the three things that make it safe:
 *
 *  1. **Start** builds an authorization-code request with PKCE (S256), a nonce and an opaque
 *     state, and seals `{state, nonce, verifier, returnTo, expiresAt}` into a cookie. The
 *     browser is sent to the provider with nothing but the challenge.
 *  2. **Callback** reads the code and state from the query and the sealed attempt from the
 *     cookie. The state must match *and* the envelope must open *and* be unexpired;
 *     anything else is refused before a code is spent.
 *  3. **The token leg** exchanges the code for an ID token, whose RS256 signature is checked
 *     against the provider's JWKS, and then its `iss`, `aud`, `exp` and `nonce`. Only after
 *     all of that does a claim name a person.
 *
 * A login that the provider did not mark as multi-factor is still refused by the spine when
 * the policy requires MFA and the identity has no confirmed factor — deliberately, because
 * "the provider let them in" is not a factor we can see. `SENTINEL_UPSTREAM_TRUST_MFA=1`
 * is the deployment's explicit statement that the provider always challenges, for a
 * provider that does not emit `amr`.
 */

import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";

import type { AuditSink } from "./audit-chain";
import type { IdentityRecord, IdentityRole } from "./identity-rules";
import { IdentityService, type IdentityStore, type ServiceResult } from "./identity-service";
import {
  buildAuthorizeUrl,
  discoveryUrl,
  displayNameFromClaims,
  identifierFromClaims,
  parseDiscovery,
  roleFromClaims,
  safeReturnTo,
  UPSTREAM_STATE_COOKIE,
  upstreamAssertsMfa,
  withoutTrailingSlash,
  type UpstreamAttempt,
  type UpstreamConfig,
  type UpstreamEndpoints,
} from "./upstream-rules";

export interface UpstreamSignInIds {
  id(): string;
  now(): string;
  nowMs(): number;
}

export function systemUpstreamIds(): UpstreamSignInIds {
  let n = 0;
  return {
    id: () => `upstream-${Date.now().toString(36)}-${(++n).toString(36)}`,
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
}

export interface UpstreamStartOutcome {
  /** Where to send the browser. */
  redirectTo: string;
  /** The `Set-Cookie` value that carries the sealed attempt. */
  setCookie: string;
}

export interface UpstreamCompleteOutcome {
  sessionId: string;
  identityId: string;
  redirectTo: string;
  /** The `Set-Cookie` value that clears the sealed attempt. */
  clearCookie: string;
}

type Fetcher = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface UpstreamSignInDependencies {
  /** Seals and opens the state cookie. Rotating it invalidates in-flight attempts, which is fine. */
  secret: string;
  ids?: UpstreamSignInIds;
  audit?: AuditSink | null;
  /** Injectable so the flow is testable without a socket. */
  fetchImpl?: Fetcher;
  now?: () => number;
}

export class UpstreamSignInService {
  private readonly ids: UpstreamSignInIds;
  private readonly fetchImpl: Fetcher;
  private readonly now: () => number;
  private discovery: UpstreamEndpoints | null = null;

  constructor(
    private readonly config: UpstreamConfig,
    /** For finding the organization and the identity the provider named. */
    private readonly store: Pick<IdentityStore, "findOrganizationBySlug" | "findIdentityByIdentifier">,
    /** For issuing the session and, when the provider asserted it, recording the factor. */
    private readonly spine: Pick<IdentityService, "issueSession" | "setMfaEnrolled" | "createIdentity">,
    private readonly deps: UpstreamSignInDependencies,
  ) {
    this.ids = deps.ids ?? systemUpstreamIds();
    this.fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? (() => Date.now());
  }

  /** Whether this service is configured at all — the page asks before drawing a button. */
  get enabled(): boolean {
    return Boolean(this.config.clientId && this.config.issuer && this.config.redirectUri);
  }

  get label(): string {
    return this.config.label;
  }

  /**
   * The origin the provider will return the browser to.
   *
   * The one address a sign-in can finish on, which is not necessarily the one the browser
   * used: the attempt travels in a cookie, and cookies do not cross hosts. A console that
   * asks the provider from somewhere else starts a login whose ending it will never see.
   */
  get redirectOrigin(): string {
    return new URL(this.config.redirectUri).origin;
  }

  /**
   * Begin a sign-in: seal an attempt and hand back the provider's authorization URL.
   *
   * `returnTo` is a *path*, never an absolute URL, and it is re-validated at the end rather
   * than trusted here — a sealed value still arrives through a browser, and an open
   * redirect is what comes of skipping that.
   */
  async start(input: { returnTo?: string | null; secure?: boolean } = {}): Promise<ServiceResult<UpstreamStartOutcome>> {
    const endpoints = await this.endpoints();
    if ("error" in endpoints) return { ok: false, error: endpoints.error };

    const state = randomBytes(24).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const attempt: UpstreamAttempt = {
      state,
      nonce,
      verifier,
      returnTo: safeReturnTo(input.returnTo ?? null),
      expiresAt: this.now() + this.config.stateTtlSeconds * 1000,
    };

    const redirectTo = buildAuthorizeUrl(endpoints, this.config, {
      state,
      nonce,
      codeChallenge: pkceChallenge(verifier),
    });

    return {
      ok: true,
      value: {
        redirectTo,
        setCookie: this.stateCookie(seal(attempt, this.deps.secret), this.config.stateTtlSeconds, input.secure === true),
      },
    };
  }

  /**
   * Finish a sign-in: spend the code, verify the ID token, and let the spine mint a session.
   *
   * Every failure below is the same class of refusal as a wrong password — the caller shows
   * one sentence — but the reasons are distinct internally so the audit trail says what
   * actually happened.
   */
  async complete(input: {
    code: string;
    state: string;
    stateCookie: string | null;
    userAgent?: string | null;
    ipAddress?: string | null;
  }): Promise<ServiceResult<UpstreamCompleteOutcome>> {
    const endpoints = await this.endpoints();
    if ("error" in endpoints) return { ok: false, error: endpoints.error };

    // 1. The attempt must be ours, unexpired, and about this state.
    const sealed = input.stateCookie ?? "";
    const attempt = sealed ? open<UpstreamAttempt>(sealed, this.deps.secret) : null;
    if (!attempt) return this.refuse(null, "no sign-in attempt was present");
    if (attempt.expiresAt < this.now()) return this.refuse(null, "the sign-in attempt expired");
    if (!constantEquals(attempt.state, input.state)) return this.refuse(null, "the state did not match the attempt");
    if (attempt.returnTo !== safeReturnTo(attempt.returnTo)) return this.refuse(null, "the return path was not usable");

    // 2. The code for the token, with the verifier that proves we started it.
    const token = await this.exchange(endpoints, input.code, attempt.verifier);
    if ("error" in token) return this.refuse(null, token.error);

    // 3. The ID token, verified against the provider's published keys.
    const verified = await this.verifyIdToken(endpoints, token.idToken, attempt.nonce);
    if ("error" in verified) return this.refuse(null, verified.error);
    const claims = verified.claims;

    // 4. From here on the claims name a person, so this is the organization's business.
    const identifier = identifierFromClaims(claims);
    if (!identifier) return this.refuse(null, "the provider's token named no email address");

    const organization = await this.resolveOrganization();
    if (!organization) return { ok: false, error: "This deployment has no console organization configured for sign-in." };

    const existing = await this.store.findIdentityByIdentifier(organization.id, identifier);
    if (existing && !existing.active) {
      return this.refuse(organization.id, `“${identifier}” is deactivated`);
    }

    let identity: IdentityRecord;
    if (existing) {
      identity = existing;
    } else {
      const created = await this.provision(organization.id, identifier, claims);
      if ("error" in created) return this.refuse(organization.id, created.error);
      identity = created;
    }

    // 5. A factor the provider asserted is recorded through the spine's one writer, so
    //    `issueSession` below is judged against the same field every other login writes.
    const assertedMfa = upstreamAssertsMfa(claims);
    if (!identity.mfaEnrolled && (assertedMfa || this.config.trustAssertedMfa)) {
      const marked = await this.spine.setMfaEnrolled(this.systemActor(organization.id), identity.id, true);
      if (!marked.ok) return { ok: false, error: marked.error };
    } else if (!identity.mfaEnrolled && !assertedMfa) {
      return this.refuse(
        organization.id,
        "the provider did not assert a second factor and no factor is enrolled here",
      );
    }

    const session = await this.spine.issueSession(organization.id, identity.id, {
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
    });
    if (!session.ok) return { ok: false, error: session.error };

    await this.append(organization.id, identity.id, "identity.signin", identity.id, {
      identifier,
      method: "upstream",
      issuer: this.config.issuer,
      clientId: this.config.clientId,
      role: identity.role,
      mfa: assertedMfa ? "asserted" : this.config.trustAssertedMfa ? "trusted" : "none",
      provisioned: !existing,
    });

    return {
      ok: true,
      value: {
        sessionId: session.value.id,
        identityId: identity.id,
        redirectTo: attempt.returnTo ?? this.config.landingPath,
        clearCookie: this.stateCookie("", 0, false),
      },
    };
  }

  /* ------------------------------------------------------------ the network */

  /** Discovery, fetched once and kept; a failure is reported, never cached. */
  private async endpoints(): Promise<UpstreamEndpoints | { error: string }> {
    if (this.discovery) return this.discovery;
    const url = discoveryUrl(this.config.issuer);
    let response;
    try {
      response = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    } catch (cause) {
      return { error: `Could not reach the provider's discovery document: ${String(cause)}` };
    }
    if (!response.ok) return { error: `The provider's discovery document answered ${response.status}.` };
    let document: unknown;
    try {
      document = JSON.parse(await response.text());
    } catch {
      return { error: "The provider's discovery document is not JSON." };
    }
    const parsed = parseDiscovery(document, this.config.issuer);
    if ("error" in parsed) return parsed;
    this.discovery = parsed;
    return parsed;
  }

  private async exchange(
    endpoints: UpstreamEndpoints,
    code: string,
    verifier: string,
  ): Promise<{ idToken: string } | { error: string }> {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: verifier,
    });
    if (this.config.clientSecret) form.set("client_secret", this.config.clientSecret);

    let response;
    try {
      response = await this.fetchImpl(endpoints.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form.toString(),
      });
    } catch (cause) {
      return { error: `Could not reach the provider's token endpoint: ${String(cause)}` };
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(await response.text()) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const detail = typeof payload.error_description === "string" ? payload.error_description : String(payload.error ?? response.status);
      return { error: `The provider refused the code exchange: ${detail}` };
    }
    const idToken = typeof payload.id_token === "string" ? payload.id_token : "";
    if (!idToken) return { error: "The provider returned no ID token." };
    return { idToken };
  }

  private async verifyIdToken(
    endpoints: UpstreamEndpoints,
    token: string,
    nonce: string,
  ): Promise<{ claims: Record<string, unknown> } | { error: string }> {
    const parts = token.split(".");
    if (parts.length !== 3) return { error: "The ID token is not a compact JWS." };
    const [headerPart, claimsPart, signaturePart] = parts;

    let header: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      return { error: "The ID token header is not JSON." };
    }
    if (header.alg !== "RS256") return { error: `The ID token says it was signed with “${String(header.alg)}”.` };
    const kid = typeof header.kid === "string" ? header.kid : "";

    let keys: Record<string, unknown>[];
    try {
      const response = await this.fetchImpl(endpoints.jwksUri, { headers: { accept: "application/json" } });
      if (!response.ok) return { error: `The provider's JWKS answered ${response.status}.` };
      const document = JSON.parse(await response.text()) as { keys?: Record<string, unknown>[] };
      keys = Array.isArray(document.keys) ? document.keys : [];
    } catch (cause) {
      return { error: `Could not read the provider's JWKS: ${String(cause)}` };
    }
    const jwk = keys.find((candidate) => candidate.kid === kid) ?? (kid ? undefined : keys[0]);
    if (!jwk) return { error: "The ID token names a key the provider does not publish." };

    let publicKey;
    try {
      publicKey = createPublicKey({ key: jwk as never, format: "jwk" });
    } catch {
      return { error: "The provider published a key that is not usable." };
    }
    const valid = verify(
      "sha256",
      Buffer.from(`${headerPart}.${claimsPart}`, "utf8"),
      { key: publicKey, padding: 1 /* RSA_PKCS1_PADDING */ },
      Buffer.from(signaturePart, "base64url"),
    );
    if (!valid) return { error: "The ID token's signature does not verify against the provider's key." };

    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      return { error: "The ID token payload is not JSON." };
    }

    if (withoutTrailingSlash(String(claims.iss ?? "")) !== withoutTrailingSlash(this.config.issuer)) {
      return { error: "The ID token was not issued by the configured provider." };
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(this.config.clientId)) {
      return { error: "The ID token was issued for another client." };
    }
    if (typeof claims.nonce !== "string" || !constantEquals(claims.nonce, nonce)) {
      return { error: "The ID token does not answer this sign-in request." };
    }
    if (typeof claims.exp === "number" && this.now() >= claims.exp * 1000) {
      return { error: "The ID token has expired." };
    }
    return { claims };
  }

  /* ------------------------------------------------------------ the spine */

  /**
   * Create the identity a first-time upstream visitor arrives as.
   *
   * This is just-in-time provisioning, and it is deliberately narrow: the identifier is
   * the provider's email, the role comes only from the configured admin group, and the
   * write goes through `IdentityService.createIdentity` with a system actor so it lands on
   * the organization's evidence chain exactly as an administrator's create does. A
   * deployment that would rather provision ahead of time simply leaves the identity there:
   * this path is only reached when no identity matches.
   */
  private async provision(
    organizationId: string,
    identifier: string,
    claims: Record<string, unknown>,
  ): Promise<IdentityRecord | { error: string }> {
    const role: IdentityRole = roleFromClaims(claims, this.config.adminGroup);
    const created = await this.spine.createIdentity(this.systemActor(organizationId), {
      identifier,
      displayName: displayNameFromClaims(claims, identifier),
      kind: "HUMAN",
      role,
    } as never);
    if (!created.ok) return { error: created.error };
    return created.value;
  }

  private async resolveOrganization(): Promise<{ id: string } | null> {
    const slug = this.config.defaultOrganizationSlug;
    if (!slug) return null;
    const found = await this.store.findOrganizationBySlug(slug);
    return found ? { id: found.id } : null;
  }

  private systemActor(organizationId: string) {
    return { id: "system:upstream", organizationId, role: "ADMIN" as IdentityRole };
  }

  /* ------------------------------------------------------------ cookies */

  private stateCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
    const base = `${UPSTREAM_STATE_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
    return secure ? `${base}; Secure` : base;
  }

  private async refuse(organizationId: string | null, reason: string): Promise<ServiceResult<never>> {
    if (organizationId) await this.append(organizationId, "system:upstream", "identity.signin.refuse", null, { reason });
    // One sentence, whatever the reason: the distinct reasons are in the audit trail, not
    // in front of the person, exactly as the password form keeps them apart.
    return { ok: false, error: "That sign-in could not be completed. Try again, or use the password form." };
  }

  private async append(
    organizationId: string,
    actor: string,
    action: string,
    targetId: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.audit) return;
    await this.deps.audit.append({
      id: this.ids.id(),
      at: this.ids.now(),
      actor,
      action,
      targetType: "Identity",
      targetId,
      detail: { ...detail, organizationId },
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  PKCE, sealing and comparisons                                             */
/* -------------------------------------------------------------------------- */

/** `base64url(sha256(ascii(verifier)))`, which is what `S256` means. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest().toString("base64url");
}

/** A sealed envelope: `base64url(json).base64url(hmac)`. */
export function seal(value: unknown, secret: string): string {
  const body = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

/** Open a sealed envelope, or `null` for anything that is not intact. */
export function open<T>(sealed: string, secret: string): T | null {
  const dot = sealed.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = sealed.slice(0, dot);
  const mac = sealed.slice(dot + 1);
  if (!constantEquals(mac, sign(body, secret))) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** Length-safe comparison, so a wrong MAC cannot be found by how long it took. */
export function constantEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
