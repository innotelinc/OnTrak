/**
 * Public API token service (M6): minting, revoking and spending a bearer token.
 *
 * `public-api-rules.ts` decides everything; this file generates the secret, stores
 * the hash, records every change and answers the one question a route asks —
 * "is this token allowed to do this, and has it asked too often?". Four choices
 * worth stating out loud:
 *
 *  - **The plaintext token exists once.** `create` returns it, and nothing stores
 *    it. A second read of the row cannot produce it, which is the point: a
 *    support engineer who can read the database still cannot impersonate an
 *    integration, and a backup is not a set of credentials.
 *  - **The rate limit is spent by the same statement that records the use.** One
 *    write per authenticated request, not two, and the counter cannot be
 *    incremented by a request the store never saw.
 *  - **A token's authority is narrower than its creator's.** It carries scopes
 *    *and* a role, and the role is the least one that could serve those scopes —
 *    so an integration can never do something an agent could not, and the scope
 *    only ever narrows the role further. Two fences, and the inner one is never
 *    opened by the outer.
 *  - **Every minting, revocation and authenticated call is audited** — with the
 *    token's id, never its value. `ticket.api` names *which integration* touched a
 *    ticket, which is the question an incident asks after a bad bulk update.
 */

import { randomBytes, randomUUID } from "node:crypto";

import { hasPermission, type Actor, type Role } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  API_TOKEN_PREFIX,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  apiTokenUsable,
  looksLikeApiToken,
  rateLimitDecision,
  rateWindow,
  tokenDisplayPrefix,
  validateApiToken,
  type ApiScope,
  type ApiTokenRecord,
  type ApiIssue,
  type RateLimitDecision,
} from "./public-api-rules";
import type { ServiceResult } from "./ticket-service";

/* -------------------------------------------------------------------------- */
/*  The port                                                                  */
/* -------------------------------------------------------------------------- */

export interface RateConsumption {
  /** The window the request was counted in, as epoch milliseconds. */
  windowStartMs: number;
  /** The token's count inside that window, including this request. */
  count: number;
}

export interface ApiTokenStore {
  insertToken(record: ApiTokenRecord): Promise<void>;
  findTokenByHash(tokenHash: string): Promise<ApiTokenRecord | null>;
  findToken(tenantId: string, tokenId: string): Promise<ApiTokenRecord | null>;
  listTokens(tenantId: string): Promise<ApiTokenRecord[]>;
  updateToken(record: ApiTokenRecord): Promise<void>;
  /**
   * Record one authenticated request against a token's fixed window and stamp
   * its `lastUsedAt`, in **one** write.
   *
   * A durable adapter does it with a conditional `updateMany` chain so that a
   * request which straddles a window boundary resets the count rather than
   * carrying the old one into the new window. `limit` is passed so the counter
   * stops growing once the window is already blown — a refusing endpoint must not
   * be a way to make a big number.
   */
  consumeRateLimit(input: { tokenId: string; windowStartMs: number; nowMs: number; limit: number }): Promise<RateConsumption>;
}

export interface ApiIds {
  id(): string;
  /** The plaintext token, generated once. */
  token(): string;
  now(): string;
  nowMs(): number;
}

export function systemApiIds(): ApiIds {
  const mint = () => randomUUID();
  return {
    id: mint,
    token: () => `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`,
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
}

/* -------------------------------------------------------------------------- */
/*  Results                                                                   */
/* -------------------------------------------------------------------------- */

export interface CreateApiTokenInput {
  name?: string;
  scopes?: readonly string[];
  expiresInDays?: number | null;
  rateLimitPerMinute?: number;
}

/** The one moment the secret is visible. */
export interface CreatedApiToken {
  token: ApiTokenRecord;
  secret: string;
}

/** An authenticated API call: who asked, what they may do, and how much is left. */
export interface ApiCaller {
  tokenId: string;
  tenantId: string;
  name: string;
  scopes: readonly ApiScope[];
  /** The least role that could serve those scopes. Never wider than a token's own. */
  actor: Actor;
  rate: RateLimitDecision;
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The least role that could serve a set of scopes.
 *
 * An integration that writes tickets is an agent; one that only reads is an agent
 * too, because reading *the desk's* tickets needs `ticket:read:any`, which a
 * requester does not hold. A token with neither ticket scope gets `REQUESTER`, so
 * it can reach nothing it should not. The scope check in the route is what
 * actually narrows this; the role is the floor under it, and it never rises.
 */
export function roleForScopes(scopes: readonly ApiScope[]): Role {
  return scopes.some((scope) => scope === "tickets:read" || scope === "tickets:write") ? "AGENT" : "REQUESTER";
}

export class ApiTokenService {
  constructor(
    private readonly store: ApiTokenStore,
    private readonly audit: AuditSink | null = null,
    private readonly ids: ApiIds = systemApiIds(),
    /** SHA-256, injected so a test can drive the same path with a known digest. */
    private readonly hash: (input: string) => string,
  ) {}

  /* ------------------------------------------------------------ minting */

  /**
   * Create a token. Administrator work: it decides what an outside system may do
   * inside the tenant.
   */
  async create(actor: Actor, input: CreateApiTokenInput): Promise<ServiceResult<CreatedApiToken>> {
    if (!hasPermission(actor.role, "tenant:manage")) return { ok: false, error: "You do not manage API tokens." };

    const issues: ApiIssue[] = validateApiToken(input);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const now = this.ids.nowMs();
    const expiresAt =
      input.expiresInDays === undefined || input.expiresInDays === null
        ? null
        : new Date(now + input.expiresInDays * 24 * 60 * 60 * 1000).toISOString();

    const secret = this.ids.token();
    const record: ApiTokenRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      name: input.name!.trim(),
      tokenHash: this.hash(secret),
      tokenPrefix: tokenDisplayPrefix(secret),
      scopes: [...(input.scopes ?? [])] as ApiScope[],
      createdBy: actor.id,
      createdAt: this.ids.now(),
      expiresAt,
      revokedAt: null,
      lastUsedAt: null,
      rateLimitPerMinute: input.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
      rateWindowStart: null,
      rateCount: 0,
    };

    await this.store.insertToken(record);
    // The token's id and prefix, never its value: an audit trail that leaks a
    // credential is worse than no audit trail.
    await this.append(actor, "api.token.create", record.id, {
      name: record.name,
      tokenPrefix: record.tokenPrefix,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      rateLimitPerMinute: record.rateLimitPerMinute,
    });

    return { ok: true, value: { token: record, secret } };
  }

  /** The tenant's tokens, newest first. Never includes a secret. */
  async list(actor: Actor): Promise<ServiceResult<ApiTokenRecord[]>> {
    if (!hasPermission(actor.role, "tenant:manage")) return { ok: false, error: "You do not manage API tokens." };
    const tokens = await this.store.listTokens(actor.tenantId);
    return { ok: true, value: tokens.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  }

  /**
   * Revoke a token. Idempotent: revoking one twice is a success, because the
   * second click is what a person does when the first looked like it did nothing.
   */
  async revoke(actor: Actor, tokenId: string): Promise<ServiceResult<ApiTokenRecord>> {
    if (!hasPermission(actor.role, "tenant:manage")) return { ok: false, error: "You do not manage API tokens." };

    const record = await this.store.findToken(actor.tenantId, tokenId);
    if (!record) return { ok: false, error: "That token does not exist." };
    if (record.revokedAt !== null) return { ok: true, value: record };

    const next: ApiTokenRecord = { ...record, revokedAt: this.ids.now() };
    await this.store.updateToken(next);
    await this.append(actor, "api.token.revoke", next.id, { name: next.name, tokenPrefix: next.tokenPrefix });
    return { ok: true, value: next };
  }

  /* -------------------------------------------------- authenticating */

  /**
   * Turn a presented token into a caller, or refuse.
   *
   * The order matters and is the cheapest-first one: the shape is checked before
   * any query, the hash lookup decides whether the token exists, usability
   * (revoked, expired) comes next, and the rate limit is spent last — so a
   * revoked or expired token does not consume its owner's budget, and a flooded
   * token does not have to be looked up twice.
   *
   * The refusal is one sentence for every cause. Which of "unknown", "revoked"
   * and "expired" it was is information an attacker holding a guess would like,
   * and it is already on our audit trail where it belongs.
   */
  async authenticate(presented: string | null): Promise<ServiceResult<ApiCaller>> {
    const unauthorized = { ok: false as const, error: "A valid API token is required." };
    if (!presented || !looksLikeApiToken(presented.trim())) return unauthorized;

    const record = await this.store.findTokenByHash(this.hash(presented.trim()));
    if (!record) return unauthorized;

    const usable = apiTokenUsable(record, this.ids.nowMs());
    if (!usable.ok) {
      // On the chain even when refused: "somebody kept using a token we revoked"
      // is exactly the signal a leak produces.
      await this.appendRaw(record, "api.token.refused", { reason: usable.reason });
      return unauthorized;
    }

    const nowMs = this.ids.nowMs();
    const consumed = await this.store.consumeRateLimit({
      tokenId: record.id,
      windowStartMs: rateWindow(nowMs).startMs,
      nowMs,
      limit: record.rateLimitPerMinute,
    });
    const rate = rateLimitDecision({
      limit: record.rateLimitPerMinute,
      windowStartMs: consumed.windowStartMs,
      count: consumed.count,
      nowMs,
    });

    const actor: Actor = { id: `api-token:${record.id}`, tenantId: record.tenantId, role: roleForScopes(record.scopes) };
    return {
      ok: true,
      value: {
        tokenId: record.id,
        tenantId: record.tenantId,
        name: record.name,
        scopes: record.scopes,
        actor,
        rate,
      },
    };
  }

  /* ------------------------------------------------------------ internals */

  private async append(actor: Actor, action: string, tokenId: string, detail: Record<string, unknown>): Promise<void> {
    if (!this.audit) return;
    const event: AuditEventInput = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      at: this.ids.now(),
      actor: actor.id,
      action,
      targetType: "ApiToken",
      targetId: tokenId,
      detail,
    };
    await this.audit.append(event);
  }

  private async appendRaw(record: ApiTokenRecord, action: string, detail: Record<string, unknown>): Promise<void> {
    await this.append(
      { id: `api-token:${record.id}`, tenantId: record.tenantId, role: "REQUESTER" },
      action,
      record.id,
      { name: record.name, tokenPrefix: record.tokenPrefix, ...detail },
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  An in-memory store, used by tests and local development                   */
/* -------------------------------------------------------------------------- */

export class MemoryApiTokenStore implements ApiTokenStore {
  private readonly tokens = new Map<string, ApiTokenRecord>();

  async insertToken(record: ApiTokenRecord): Promise<void> {
    this.tokens.set(record.id, structuredClone(record));
  }

  async findTokenByHash(tokenHash: string): Promise<ApiTokenRecord | null> {
    const found = [...this.tokens.values()].find((entry) => entry.tokenHash === tokenHash);
    return found ? structuredClone(found) : null;
  }

  async findToken(tenantId: string, tokenId: string): Promise<ApiTokenRecord | null> {
    const found = this.tokens.get(tokenId);
    return found && found.tenantId === tenantId ? structuredClone(found) : null;
  }

  async listTokens(tenantId: string): Promise<ApiTokenRecord[]> {
    return [...this.tokens.values()]
      .filter((entry) => entry.tenantId === tenantId)
      .map((entry) => structuredClone(entry));
  }

  async updateToken(record: ApiTokenRecord): Promise<void> {
    this.tokens.set(record.id, structuredClone(record));
  }

  /**
   * One conditional step, mirroring the durable adapter: a request in a window we
   * have not seen starts a new window at 1, and otherwise the count goes up — but
   * only while it is under the limit, so a flooded token stops growing.
   */
  async consumeRateLimit(input: { tokenId: string; windowStartMs: number; nowMs: number; limit: number }): Promise<RateConsumption> {
    const found = this.tokens.get(input.tokenId);
    if (!found) return { windowStartMs: input.windowStartMs, count: 1 };
    const fresh = found.rateWindowStart !== input.windowStartMs;
    const count = fresh ? 1 : Math.min(found.rateCount + 1, input.limit + 1);
    this.tokens.set(input.tokenId, {
      ...found,
      rateWindowStart: input.windowStartMs,
      rateCount: count,
      lastUsedAt: new Date(input.nowMs).toISOString(),
    });
    return { windowStartMs: input.windowStartMs, count };
  }
}
