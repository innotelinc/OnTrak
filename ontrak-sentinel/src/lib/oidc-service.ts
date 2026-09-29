/**
 * OIDC service (S1): the provider's authorization-code flow, over the S0 spine.
 *
 * The rules module decides everything; this file is where those decisions are
 * stored, checked against the spine and recorded. Four decisions are worth
 * stating out loud:
 *
 *  - **A code is burned the moment it is presented, before it is judged.** If
 *    the exchange then fails — a wrong verifier, a session revoked in the last
 *    minute — the code is gone, and the client starts again. The alternative,
 *    releasing the code when the verifier was wrong, is an oracle that lets
 *    somebody guess at a verifier with unlimited attempts inside a minute.
 *  - **`markCodeUsed` is a conditional write, not a read-then-write.** Two
 *    exchanges racing on one code is exactly the replay this flow exists to
 *    prevent, so the store port makes the loser of that race observable instead
 *    of leaving it to the service to be lucky.
 *  - **The access token is stored as a hash.** The provider hands the token out
 *    once and keeps only `SHA-256(token)`, so a copy of the database is not a set
 *    of live sessions — the same reason a credential is stored as a hash.
 *  - **Every grant, refusal of a grant, and client registration is on the
 *    organization's evidence chain.** "Who let Tix in as this user?" is the
 *    question an incident asks, and it is answered from the same chain as the
 *    identity it was asked about.
 *
 * Registration and listing need an administrator or auditor from the S0 rules;
 * the token endpoint needs no actor at all, because the code *is* the credential.
 */

import { randomUUID } from "node:crypto";

import type { HashFn } from "./audit-chain";
import { sha256Hex } from "./hash";
import { canManageIdentities, canReadDirectory, type IdentityRecord } from "./identity-rules";
import type { AuditTrail, IdentityActor, IdentityService, IdentityStore, ServiceResult } from "./identity-service";
import { jwks, signJwt, type SigningKey } from "./oidc-keys";
import {
  CODE_TTL_SECONDS,
  TOKEN_TTL_SECONDS,
  discoveryDocument,
  idTokenClaims,
  isSameClientRedirect,
  isTokenActive,
  tokenInactiveReason,
  userinfoClaims,
  validateAuthorizationRequest,
  validateClient,
  validateLogoutRequest,
  validateRevocationRequest,
  verifyCodeChallenge,
  type AuthorizationRequestInput,
  type ClaimIdentity,
  type OidcClientRecord,
  type OidcScope,
} from "./oidc-rules";

/* -------------------------------------------------------------------------- */
/*  The stored records                                                        */
/* -------------------------------------------------------------------------- */

/** A code handed to the browser, worth one exchange inside one minute. */
export interface AuthorizationCodeRecord {
  code: string;
  organizationId: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly OidcScope[];
  identityId: string;
  sessionId: string;
  nonce: string | null;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  issuedAt: number;
  expiresAt: number;
  usedAt: number | null;
}

/**
 * An issued access token, keyed by its hash rather than by the token itself.
 *
 * `revokedAt` is what makes sign-out mean something: a session that ends has to
 * stop working *now*, not when the hour the token was granted for happens to be
 * up. It is a timestamp rather than a boolean so the record still says when.
 */
export interface AccessTokenRecord {
  tokenHash: string;
  organizationId: string;
  clientId: string;
  identityId: string;
  sessionId: string;
  scopes: readonly OidcScope[];
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

export interface OidcStore {
  insertClient(record: OidcClientRecord): Promise<void>;
  /** `client_id` is globally unique, so the token endpoint resolves it unscoped. */
  findClient(clientId: string): Promise<OidcClientRecord | null>;
  listClients(organizationId: string): Promise<OidcClientRecord[]>;
  insertCode(record: AuthorizationCodeRecord): Promise<void>;
  findCode(code: string): Promise<AuthorizationCodeRecord | null>;
  /**
   * Mark a code as spent. Returns `false` when it was already spent, which is
   * the answer the caller must act on: a durable adapter implements this as one
   * conditional update (`where: { code, usedAt: null }`), so two concurrent
   * exchanges cannot both win.
   */
  markCodeUsed(code: string, at: number): Promise<boolean>;
  insertToken(record: AccessTokenRecord): Promise<void>;
  findToken(tokenHash: string): Promise<AccessTokenRecord | null>;
  /**
   * Kill one token. Returns `false` when there was nothing live to kill, which
   * is not an error — revoking a token twice, or one that never existed, is the
   * same success (RFC 7009).
   */
  revokeToken(tokenHash: string, at: number): Promise<boolean>;
  /**
   * Kill every token a session holds, and return how many that was. Sign-out
   * ends a session, not one token: a client that fetched three of them must not
   * keep the two it did not mention.
   */
  revokeTokensForSession(organizationId: string, sessionId: string, at: number): Promise<number>;
}

export interface OidcIds {
  /** A general-purpose id: audit event ids and anything else the flow mints. */
  id(): string;
  clientId(): string;
  code(): string;
  token(): string;
  now(): string;
  nowMs(): number;
}

export function systemOidcIds(): OidcIds {
  const mint = () => randomUUID();
  return {
    id: mint,
    clientId: mint,
    code: mint,
    token: mint,
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
}

/** Everything the provider needs that is deployment configuration, not logic. */
export interface OidcConfig {
  /** The issuer identifier: clients check this against the ID token's `iss`. */
  issuer: string;
  keys: SigningKey;
}

/* -------------------------------------------------------------------------- */
/*  Results                                                                   */
/* -------------------------------------------------------------------------- */

export interface AuthorizeInput extends AuthorizationRequestInput {
  /** The session the browser presented. The flow cannot proceed without one. */
  sessionId: string;
}

/**
 * An authorization decision. The refusal carries the destination an error may be
 * reported to — `null` when the redirect URI itself was not recognised, because
 * redirecting to an unregistered URI is how an open redirector is built.
 */
export type AuthorizeResult =
  | { ok: true; code: string; redirectTo: string }
  | { ok: false; error: string; redirectUri: string | null; state: string | null };

export interface TokenInput {
  grantType?: string;
  clientId?: string;
  code?: string;
  redirectUri?: string;
  codeVerifier?: string;
}

/** A sign-out. `sessionId` comes from the provider's own cookie, not the client. */
export interface LogoutInput {
  clientId?: string;
  postLogoutRedirectUri?: string;
  state?: string;
  idTokenHint?: string;
  sessionId: string;
}

/**
 * The outcome of a sign-out. `redirectTo` is `null` when we were not given a
 * registered destination, which is a success and not a failure: the session is
 * over either way, and the caller decides where the browser goes next.
 */
export type LogoutResult =
  | { ok: true; redirectTo: string | null; revokedTokens: number }
  | { ok: false; error: string };

export interface RevokeInput {
  token?: string;
  tokenTypeHint?: string;
}

/**
 * Revocation always succeeds when a token was presented. That is deliberate:
 * answering "that token is not valid" would turn the endpoint into a way of
 * testing whether a token is live, which is the one question an attacker with a
 * stolen token wants answered. `known` says *to us* what happened, for the log.
 */
export type RevokeResult = { ok: true; known: boolean } | { ok: false; error: string };

export type OAuthErrorCode = "invalid_request" | "invalid_client" | "invalid_grant";

export type TokenResult =
  | { ok: true; accessToken: string; idToken: string; tokenType: "Bearer"; expiresIn: number; scope: string }
  | { ok: false; error: string; code: OAuthErrorCode };

export interface RegisterClientInput {
  name?: string;
  redirectUris?: readonly string[];
  scopes?: readonly string[];
  kind?: string;
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

function claimIdentityOf(identity: IdentityRecord): ClaimIdentity {
  return {
    id: identity.id,
    identifier: identity.identifier,
    displayName: identity.displayName,
    role: identity.role,
    mfaEnrolled: identity.mfaEnrolled,
  };
}

/** Append `code` and `state` to a redirect URI without disturbing what it had. */
function redirectWith(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export class OidcService {
  constructor(
    private readonly store: OidcStore,
    private readonly identities: IdentityStore,
    /** The S0 spine: the session policy and the directory, reused rather than re-derived. */
    private readonly spine: IdentityService,
    private readonly config: OidcConfig,
    private readonly audit: AuditTrail | null = null,
    private readonly ids: OidcIds = systemOidcIds(),
    private readonly hash: HashFn = sha256Hex,
  ) {}

  /* ------------------------------------------------------------ metadata */

  /** The discovery document. What is advertised is what is implemented. */
  discovery(): Record<string, unknown> {
    return discoveryDocument(this.config.issuer);
  }

  /** The public keys a client verifies ID tokens with. */
  jwks(): { keys: Record<string, unknown>[] } {
    return jwks(this.config.keys);
  }

  /* ------------------------------------------------------------ clients */

  /** Register a client. Administrator work: it decides who may receive identity. */
  async registerClient(actor: IdentityActor, input: RegisterClientInput): Promise<ServiceResult<OidcClientRecord>> {
    if (!canManageIdentities(actor.role)) return { ok: false, error: "You do not register clients." };

    const issues = validateClient(input);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const record: OidcClientRecord = {
      clientId: this.ids.clientId(),
      organizationId: actor.organizationId,
      name: input.name!.trim(),
      redirectUris: (input.redirectUris ?? []).map((uri) => uri.trim()),
      scopes: [...(input.scopes ?? [])] as OidcScope[],
      kind: (input.kind ?? "public") as "public" | "confidential",
      createdBy: actor.id,
      createdAt: this.ids.now(),
    };
    await this.store.insertClient(record);
    // A registered client is a decision about who receives identity, so it
    // belongs on the chain beside the identities it will be handed.
    await this.append(record.organizationId, actor.id, "oauth.client.register", "OidcClient", record.clientId, {
      name: record.name,
      redirectUris: record.redirectUris,
      scopes: record.scopes,
      kind: record.kind,
    });
    return { ok: true, value: record };
  }

  /** The clients this organization has registered. */
  async listClients(actor: IdentityActor): Promise<ServiceResult<OidcClientRecord[]>> {
    if (!canReadDirectory(actor.role)) return { ok: false, error: "You do not have access to the registered clients." };
    return { ok: true, value: await this.store.listClients(actor.organizationId) };
  }

  /* -------------------------------------------------------- authorization */

  /**
   * Decide an authorization request and, if it holds, issue a code.
   *
   * The session is resolved through the spine, so the policy that decides
   * whether a session is usable is the same one that guards every other read —
   * an OIDC grant cannot be a way around a deactivated identity, an unenrolled
   * second factor or an idle timeout.
   */
  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const client = input.clientId ? await this.store.findClient(input.clientId) : null;
    const decision = validateAuthorizationRequest(input, client);
    if (!decision.ok) {
      return { ok: false, error: decision.error, redirectUri: decision.redirectUri, state: decision.state };
    }

    // Scoped by the client's organization: a session belonging to another tenant
    // is simply not found, rather than found and refused.
    const session = await this.spine.resolveSession(decision.client.organizationId, input.sessionId);
    if (!session.ok) {
      return { ok: false, error: session.error, redirectUri: decision.redirectUri, state: decision.state };
    }

    const now = this.ids.nowMs();
    const record: AuthorizationCodeRecord = {
      code: this.ids.code(),
      organizationId: decision.client.organizationId,
      clientId: decision.client.clientId,
      redirectUri: decision.redirectUri,
      scopes: decision.scopes,
      identityId: session.value.identity.id,
      sessionId: session.value.session.id,
      nonce: decision.nonce,
      codeChallenge: decision.codeChallenge,
      codeChallengeMethod: "S256",
      issuedAt: now,
      expiresAt: now + CODE_TTL_SECONDS * 1000,
      usedAt: null,
    };
    await this.store.insertCode(record);
    await this.append(record.organizationId, session.value.identity.id, "oauth.authorize", "OidcClient", record.clientId, {
      subject: record.identityId,
      sessionId: record.sessionId,
      scopes: record.scopes,
      redirectUri: record.redirectUri,
    });

    return {
      ok: true,
      code: record.code,
      redirectTo: redirectWith(record.redirectUri, { code: record.code, state: decision.state }),
    };
  }

  /* ----------------------------------------------------------- the token */

  /**
   * Exchange a code for tokens.
   *
   * No actor: the code is the credential, and it is bound to one client, one
   * redirect URI, one session and one PKCE challenge. Every one of those is
   * re-checked here because the code travelled through a browser.
   */
  async token(input: TokenInput): Promise<TokenResult> {
    if ((input.grantType ?? "") !== "authorization_code") {
      return { ok: false, error: "Only the authorization_code grant is supported.", code: "invalid_request" };
    }
    const clientId = (input.clientId ?? "").trim();
    const code = (input.code ?? "").trim();
    const redirectUri = (input.redirectUri ?? "").trim();
    const verifier = input.codeVerifier ?? "";
    if (!clientId || !code || !redirectUri || !verifier) {
      return { ok: false, error: "client_id, code, redirect_uri and code_verifier are all required.", code: "invalid_request" };
    }

    const client = await this.store.findClient(clientId);
    if (!client) return { ok: false, error: "Unknown client.", code: "invalid_client" };

    const record = await this.store.findCode(code);
    if (!record) return { ok: false, error: "That authorization code is not valid.", code: "invalid_grant" };
    if (record.clientId !== client.clientId) {
      return { ok: false, error: "That authorization code was issued to another client.", code: "invalid_grant" };
    }
    if (!isSameClientRedirect(record.redirectUri, redirectUri)) {
      return { ok: false, error: "The redirect URI does not match the one the code was issued for.", code: "invalid_grant" };
    }
    if (this.ids.nowMs() >= record.expiresAt) {
      return { ok: false, error: "That authorization code has expired.", code: "invalid_grant" };
    }

    // Spent first, judged second: see the note at the top of this file.
    const spent = record.usedAt === null && (await this.store.markCodeUsed(code, this.ids.nowMs()));
    if (!spent) {
      await this.append(record.organizationId, "system:oidc", "oauth.token.reuse", "OidcClient", client.clientId, {
        code,
        subject: record.identityId,
      });
      return { ok: false, error: "That authorization code has already been exchanged.", code: "invalid_grant" };
    }

    const pkce = verifyCodeChallenge(
      { verifier, challenge: record.codeChallenge, method: record.codeChallengeMethod },
      this.hash,
    );
    if (!pkce.ok) {
      await this.append(record.organizationId, "system:oidc", "oauth.token.refuse", "OidcClient", client.clientId, {
        reason: pkce.reason,
        subject: record.identityId,
      });
      return { ok: false, error: pkce.reason, code: "invalid_grant" };
    }

    // The session may have been revoked or the identity deactivated in the sixty
    // seconds since the code was issued, so the policy is asked again.
    const session = await this.spine.resolveSession(record.organizationId, record.sessionId);
    if (!session.ok) return { ok: false, error: session.error, code: "invalid_grant" };

    const now = this.ids.nowMs();
    const accessToken = this.ids.token();
    await this.store.insertToken({
      tokenHash: this.hash(accessToken),
      organizationId: record.organizationId,
      clientId: client.clientId,
      identityId: record.identityId,
      sessionId: record.sessionId,
      scopes: record.scopes,
      issuedAt: now,
      expiresAt: now + TOKEN_TTL_SECONDS * 1000,
      revokedAt: null,
    });

    const idToken = signJwt(
      idTokenClaims({
        issuer: this.config.issuer,
        clientId: client.clientId,
        identity: claimIdentityOf(session.value.identity),
        sessionId: record.sessionId,
        scopes: record.scopes,
        nonce: record.nonce,
        nowMs: now,
        authTimeMs: record.issuedAt,
      }),
      this.config.keys,
    );

    await this.append(record.organizationId, record.identityId, "oauth.token", "OidcClient", client.clientId, {
      subject: record.identityId,
      sessionId: record.sessionId,
      scopes: record.scopes,
      expiresAt: new Date(now + TOKEN_TTL_SECONDS * 1000).toISOString(),
    });

    return {
      ok: true,
      accessToken,
      idToken,
      tokenType: "Bearer",
      expiresIn: TOKEN_TTL_SECONDS,
      scope: record.scopes.join(" "),
    };
  }

  /* ------------------------------------------------------------ userinfo */

  /**
   * The claims behind an access token.
   *
   * Looked up by the token's hash, so a stolen database is not a set of usable
   * tokens. A revoked session is refused here too: a token should stop working
   * when the session behind it does, not when it happens to expire.
   */
  async userinfo(accessToken: string): Promise<ServiceResult<Record<string, unknown>>> {
    if (!accessToken.trim()) return { ok: false, error: "No access token was presented." };

    const record = await this.store.findToken(this.hash(accessToken.trim()));
    if (!record) return { ok: false, error: "That access token is not valid." };
    // Revocation and expiry are one question, asked in one place: a token the
    // desk killed must not come back to life by being presented here.
    if (!isTokenActive(record, this.ids.nowMs())) {
      return { ok: false, error: `That access token is no longer usable: ${tokenInactiveReason(record, this.ids.nowMs())}.` };
    }

    const session = await this.spine.checkSession(record.organizationId, record.sessionId);
    if (!session.active) return { ok: false, error: `That access token is no longer usable: ${session.reason}.` };

    const identity = await this.identities.findIdentity(record.organizationId, record.identityId);
    if (!identity) return { ok: false, error: "That access token's identity does not exist." };
    if (!identity.active) return { ok: false, error: "That access token's identity is deactivated." };

    return { ok: true, value: userinfoClaims(claimIdentityOf(identity), record.scopes) };
  }

  /* -------------------------------------------------------------- logout */

  /**
   * End the session behind a sign-out, and kill every token it minted.
   *
   * Two things happen and both are required for sign-out to mean anything:
   * the **session** is ended through the S0 spine, so every other entry point
   * (a fresh authorize, a userinfo read) sees it as dead, and every **access
   * token** issued for that session is revoked, because a client that kept one
   * would otherwise keep working after the user left. Ending the session alone
   * leaves already-issued tokens live; revoking the tokens alone leaves the
   * session usable for another code. Doing one without the other is the bug this
   * endpoint exists to avoid.
   *
   * The organization comes from the named client, never from the request's own
   * idea of who it is, so a sign-out cannot reach another tenant's session.
   */
  async logout(input: LogoutInput): Promise<LogoutResult> {
    const client = input.clientId ? await this.store.findClient(input.clientId.trim()) : null;
    const decision = validateLogoutRequest(input, client);
    if (!decision.ok) return { ok: false, error: decision.error };

    // Scoped by the client's organization: another tenant's session is not found
    // at all, rather than found and refused.
    const session = await this.spine.resolveSession(decision.client.organizationId, input.sessionId);
    if (!session.ok) return { ok: false, error: session.error };

    const now = this.ids.nowMs();
    const ended = await this.spine.endOwnSession(
      decision.client.organizationId,
      session.value.session.id,
      "signed out through the OIDC end-session endpoint",
    );
    if (!ended.ok) return { ok: false, error: ended.error };

    const revokedTokens = await this.store.revokeTokensForSession(
      decision.client.organizationId,
      session.value.session.id,
      now,
    );

    await this.append(decision.client.organizationId, session.value.identity.id, "oauth.logout", "OidcClient", decision.client.clientId, {
      subject: session.value.identity.id,
      sessionId: session.value.session.id,
      revokedTokens,
      postLogoutRedirectUri: decision.redirectTo,
    });

    return { ok: true, redirectTo: decision.redirectTo, revokedTokens };
  }

  /* ---------------------------------------------------------- revocation */

  /**
   * Revoke one access token (RFC 7009).
   *
   * No actor: the token itself is the credential, and requiring anything else
   * would mean a leaked token could not be killed by the party that noticed the
   * leak. An unknown token is still a success — the caller learns nothing about
   * which tokens exist, and a client that revokes twice is not an error.
   */
  async revoke(input: RevokeInput): Promise<RevokeResult> {
    const decision = validateRevocationRequest(input);
    if (!decision.ok) return { ok: false, error: decision.error };

    const tokenHash = this.hash(decision.token);
    const record = await this.store.findToken(tokenHash);
    if (!record) return { ok: true, known: false };

    const revoked = await this.store.revokeToken(tokenHash, this.ids.nowMs());
    if (revoked) {
      await this.append(record.organizationId, "system:oidc", "oauth.token.revoke", "OidcClient", record.clientId, {
        subject: record.identityId,
        sessionId: record.sessionId,
        tokenTypeHint: (input.tokenTypeHint ?? "").trim() || null,
      });
    }
    return { ok: true, known: revoked };
  }

  /* ------------------------------------------------------------- internals */

  private async append(
    organizationId: string,
    actor: string,
    action: string,
    targetType: string,
    targetId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) return;
    await this.audit.append({
      id: this.ids.id(),
      at: this.ids.now(),
      actor,
      action,
      targetType,
      targetId,
      // The organization rides in the detail so the log routes the event to the
      // right chain without the chain format knowing about tenants.
      detail: { ...detail, organizationId },
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  An in-memory store, used by tests and local development                   */
/* -------------------------------------------------------------------------- */

export class MemoryOidcStore implements OidcStore {
  private readonly clients = new Map<string, OidcClientRecord>();
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly tokens = new Map<string, AccessTokenRecord>();

  async insertClient(record: OidcClientRecord): Promise<void> {
    this.clients.set(record.clientId, structuredClone(record));
  }

  async findClient(clientId: string): Promise<OidcClientRecord | null> {
    const found = this.clients.get(clientId);
    return found ? structuredClone(found) : null;
  }

  async listClients(organizationId: string): Promise<OidcClientRecord[]> {
    return [...this.clients.values()]
      .filter((entry) => entry.organizationId === organizationId)
      .map((entry) => structuredClone(entry));
  }

  async insertCode(record: AuthorizationCodeRecord): Promise<void> {
    this.codes.set(record.code, structuredClone(record));
  }

  async findCode(code: string): Promise<AuthorizationCodeRecord | null> {
    const found = this.codes.get(code);
    return found ? structuredClone(found) : null;
  }

  /** One conditional write: the loser of a race gets `false`, not a second token. */
  async markCodeUsed(code: string, at: number): Promise<boolean> {
    const found = this.codes.get(code);
    if (!found || found.usedAt !== null) return false;
    this.codes.set(code, { ...found, usedAt: at });
    return true;
  }

  async insertToken(record: AccessTokenRecord): Promise<void> {
    this.tokens.set(record.tokenHash, structuredClone(record));
  }

  async findToken(tokenHash: string): Promise<AccessTokenRecord | null> {
    const found = this.tokens.get(tokenHash);
    return found ? structuredClone(found) : null;
  }

  /** Already-revoked is `false`, not an error, so revoking twice is idempotent. */
  async revokeToken(tokenHash: string, at: number): Promise<boolean> {
    const found = this.tokens.get(tokenHash);
    if (!found || found.revokedAt !== null) return false;
    this.tokens.set(tokenHash, { ...found, revokedAt: at });
    return true;
  }

  async revokeTokensForSession(organizationId: string, sessionId: string, at: number): Promise<number> {
    let revoked = 0;
    for (const [hash, record] of this.tokens) {
      if (record.organizationId !== organizationId || record.sessionId !== sessionId) continue;
      if (record.revokedAt !== null) continue;
      this.tokens.set(hash, { ...record, revokedAt: at });
      revoked += 1;
    }
    return revoked;
  }
}
