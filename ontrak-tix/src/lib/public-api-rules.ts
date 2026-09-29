/**
 * Public REST API rules (M6): scopes, tokens, rate limits and pagination.
 *
 * M0–M5 built a product a person signs into. M6 is the first surface something
 * that is *not* a person reaches, so every decision here is about what a bearer
 * token is allowed to do and what happens when it asks too often:
 *
 *  1. **A token is a hash in the database and a string on exactly one screen.**
 *     The plaintext is generated, returned once at creation, and never stored —
 *     the same reason a credential is hashed. What is kept beside the hash is a
 *     short prefix, so a human can tell two tokens apart when deciding which one
 *     to revoke.
 *  2. **Scopes are closed and each one is a permission, not a label.** A token
 *     with `tickets:read` cannot write, and an unknown scope is refused at
 *     creation rather than silently carried around. The set is small on purpose:
 *     a scope that means "and everything else" is how an integration ends up
 *     holding more than it needs.
 *  3. **The rate limit is a fixed window per token, and the refusal is
 *     arithmetic.** A window is sixty seconds wide, the count is what the token
 *     spent inside it, and `Retry-After` is the distance to the next window —
 *     not a guess, and not a number a client has to discover by being refused
 *     repeatedly.
 *  4. **Expiry and revocation are one question asked in one place**
 *     (`apiTokenUsable`), exactly as they are for a session, so a token that
 *     stopped working at one endpoint did not merely stop working *there*.
 *
 * Pure and framework-free: no clock, no crypto, no `Request`. The hash is
 * injected by the service and the time is handed in, so the same decisions run
 * in a route handler, a worker and a test.
 */

/* -------------------------------------------------------------------------- */
/*  The version and the scopes                                                */
/* -------------------------------------------------------------------------- */

/**
 * The API's version, in the path.
 *
 * A version in the path rather than a header because it is the thing a caller
 * bookmarks, pastes into a script and reads in a log line — and because an
 * unversioned public API is one where the first breaking change is a support
 * incident for every integrator at once.
 */
export const API_VERSION = "v1";
export const API_PREFIX = `/api/${API_VERSION}`;

/** What a token may do. Closed set: anything else is refused, not ignored. */
export const API_SCOPES = ["tickets:read", "tickets:write", "webhooks:manage"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/** Every scope, for a console that offers them all. */
export function allApiScopes(): readonly ApiScope[] {
  return API_SCOPES;
}

/**
 * Whether a set of granted scopes covers a required one.
 *
 * A plain membership test today, and a function anyway: the day a scope means
 * *more* than itself (`tickets:write` implying `tickets:read`, say) there is one
 * place to say so, and every call site already asks here instead of comparing
 * strings itself.
 */
export function scopeCovers(granted: readonly ApiScope[], required: ApiScope): boolean {
  return granted.includes(required);
}

/* -------------------------------------------------------------------------- */
/*  Tokens                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The prefix every token this product mints begins with.
 *
 * A recognisable prefix is not decoration: it is what lets a secret scanner, a
 * log redactor and a support engineer tell one of our tokens from a random
 * string — which is the difference between finding a leaked credential in a
 * repository and not.
 */
export const API_TOKEN_PREFIX = "tx1_";

export const API_TOKEN_NAME_MAX = 80;
export const API_TOKEN_TTL_DAYS_MAX = 730;
/** How much of the token is kept so a person can identify it later. */
export const API_TOKEN_DISPLAY_PREFIX_LENGTH = API_TOKEN_PREFIX.length + 6;

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
export const MIN_RATE_LIMIT_PER_MINUTE = 1;
export const MAX_RATE_LIMIT_PER_MINUTE = 6_000;

/** The width of a rate-limit window. One minute, so `Retry-After` reads nicely. */
export const RATE_WINDOW_SECONDS = 60;

/**
 * An issued API token.
 *
 * `tokenHash` is the only thing that identifies it, and `tokenPrefix` exists so a
 * human can pick the right row without the plaintext ever coming back out of the
 * database.
 */
export interface ApiTokenRecord {
  id: string;
  tenantId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  scopes: readonly ApiScope[];
  createdBy: string;
  createdAt: string;
  /** `null` means "no expiry", which is a choice somebody made on purpose. */
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  rateLimitPerMinute: number;
  /** The current fixed window, as epoch milliseconds. `null` before first use. */
  rateWindowStart: number | null;
  /** Requests counted inside that window. Stops growing at the limit plus one. */
  rateCount: number;
}

export interface ApiIssue {
  field: string;
  message: string;
}

export function validateApiToken(input: {
  name?: string;
  scopes?: readonly string[];
  expiresInDays?: number | null;
  rateLimitPerMinute?: number;
}): ApiIssue[] {
  const issues: ApiIssue[] = [];

  const name = input.name?.trim() ?? "";
  if (!name) issues.push({ field: "name", message: "A name is required, so somebody can tell this token from the others." });
  else if (name.length > API_TOKEN_NAME_MAX) {
    issues.push({ field: "name", message: `The name may be at most ${API_TOKEN_NAME_MAX} characters.` });
  }

  const scopes = input.scopes ?? [];
  if (scopes.length === 0) issues.push({ field: "scopes", message: "At least one scope is required." });
  if (new Set(scopes).size !== scopes.length) {
    issues.push({ field: "scopes", message: "The same scope is listed twice." });
  }
  for (const scope of scopes) {
    if (!isApiScope(scope)) issues.push({ field: "scopes", message: `“${scope}” is not a scope this API issues.` });
  }

  if (input.expiresInDays !== undefined && input.expiresInDays !== null) {
    if (!Number.isFinite(input.expiresInDays) || input.expiresInDays <= 0) {
      issues.push({ field: "expiresInDays", message: "An expiry is a positive number of days, or nothing at all." });
    } else if (input.expiresInDays > API_TOKEN_TTL_DAYS_MAX) {
      issues.push({ field: "expiresInDays", message: `A token may live at most ${API_TOKEN_TTL_DAYS_MAX} days.` });
    }
  }

  if (input.rateLimitPerMinute !== undefined) {
    const rate = input.rateLimitPerMinute;
    if (!Number.isInteger(rate) || rate < MIN_RATE_LIMIT_PER_MINUTE || rate > MAX_RATE_LIMIT_PER_MINUTE) {
      issues.push({
        field: "rateLimitPerMinute",
        message: `A rate limit is a whole number between ${MIN_RATE_LIMIT_PER_MINUTE} and ${MAX_RATE_LIMIT_PER_MINUTE} requests a minute.`,
      });
    }
  }

  return issues;
}

export type ApiTokenDecision = { ok: true } | { ok: false; reason: string };

/**
 * Whether a token still works, and why not when it does not.
 *
 * Revocation is checked before expiry for the same reason it is for a session: a
 * token the desk has killed must not become usable again by nobody looking. The
 * two answers are deliberately distinguishable to *us* — the audit line wants to
 * say which happened — while the caller is told only that the token is not valid.
 */
export function apiTokenUsable(record: { revokedAt: string | null; expiresAt: string | null }, nowMs: number): ApiTokenDecision {
  if (record.revokedAt !== null) return { ok: false, reason: "the token was revoked" };
  if (record.expiresAt !== null && nowMs >= Date.parse(record.expiresAt)) return { ok: false, reason: "the token expired" };
  return { ok: true };
}

/** The `Authorization: Bearer …` value, or `null`. Header names are not case-sensitive. */
export function bearerToken(headers: { get(name: string): string | null }): string | null {
  const authorization = headers.get("authorization");
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1].trim() || null : null;
}

/**
 * Whether a presented string is shaped like one of our tokens at all.
 *
 * Checked *before* a database lookup, so a request carrying a random string costs
 * a string comparison rather than a query. It is not a security boundary — the
 * hash comparison is — but it is the difference between a token endpoint that
 * can be used to hammer the database and one that cannot.
 */
export function looksLikeApiToken(value: string): boolean {
  return value.startsWith(API_TOKEN_PREFIX) && value.length > API_TOKEN_PREFIX.length + 20;
}

/** The part of a token kept for display, e.g. `tx1_9fK2pQ`. */
export function tokenDisplayPrefix(token: string): string {
  return token.slice(0, API_TOKEN_DISPLAY_PREFIX_LENGTH);
}

/* -------------------------------------------------------------------------- */
/*  The rate limit                                                            */
/* -------------------------------------------------------------------------- */

export interface RateWindow {
  startMs: number;
  /** When the next window begins, which is when the refused caller may retry. */
  resetMs: number;
}

/**
 * The fixed window `nowMs` falls in.
 *
 * Windows are aligned to the epoch rather than to a token's first request, so two
 * processes (and, later, two instances) agree on which window a request belonged
 * to without sharing anything but the clock. An hour of clock skew would move a
 * boundary; it would not let anybody through twice.
 */
export function rateWindow(nowMs: number, windowSeconds: number = RATE_WINDOW_SECONDS): RateWindow {
  const width = windowSeconds * 1000;
  const startMs = Math.floor(nowMs / width) * width;
  return { startMs, resetMs: startMs + width };
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  /** Requests left in this window, never negative. */
  remaining: number;
  resetAt: string;
  /** Whole seconds until the window resets — the honest value for `Retry-After`. */
  retryAfterSeconds: number;
}

/**
 * Whether a request fits inside the window, given what the token has spent.
 *
 * `count` includes the request being judged, so the window admits exactly `limit`
 * requests and the next one is refused. The arithmetic is done here rather than in
 * the route because "how many are left?" is a number a client acts on, and
 * off-by-one errors in it are the kind of thing an integrator reports as a bug in
 * the documentation.
 */
export function rateLimitDecision(input: {
  limit: number;
  windowStartMs: number;
  count: number;
  nowMs: number;
  windowSeconds?: number;
}): RateLimitDecision {
  const window = rateWindow(input.nowMs, input.windowSeconds);
  // A count from a window that has already turned over is not this window's, so
  // it is spent but does not win.
  const inWindow = input.windowStartMs === window.startMs ? Math.max(input.count, 1) : 1;
  const allowed = inWindow <= input.limit;
  return {
    allowed,
    limit: input.limit,
    remaining: Math.max(0, input.limit - inWindow),
    resetAt: new Date(window.resetMs).toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((window.resetMs - input.nowMs) / 1000)),
  };
}

/**
 * The headers that answer "how close am I?" before the client is refused.
 *
 * `Retry-After` appears only on a refusal, because on a success it would be a
 * lie about what the client should do next.
 */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    "ratelimit-limit": String(decision.limit),
    "ratelimit-remaining": String(decision.remaining),
    "ratelimit-reset": String(Math.floor(Date.parse(decision.resetAt) / 1000)),
  };
  if (!decision.allowed) headers["retry-after"] = String(decision.retryAfterSeconds);
  return headers;
}

/* -------------------------------------------------------------------------- */
/*  Pagination                                                                */
/* -------------------------------------------------------------------------- */

export const API_PAGE_DEFAULT = 25;
export const API_PAGE_MAX = 100;

export interface ApiPage {
  limit: number;
  cursor: string | null;
}

/**
 * Read `?limit` and `?cursor`.
 *
 * A cursor rather than a page number because the API walks a list that is being
 * written to: `?page=2` over a changed set skips or repeats rows, while "the rows
 * after this one" means the same thing however much arrived meanwhile.
 */
export function apiPage(params: { get(name: string): string | null }): ApiPage {
  const requested = Number.parseInt(params.get("limit") ?? "", 10);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, API_PAGE_MAX) : API_PAGE_DEFAULT;
  const cursor = (params.get("cursor") ?? "").trim() || null;
  return { limit, cursor };
}

/** The page envelope, plus the cursor for the next call when there is one. */
export function pageResult<T extends { id: string }>(
  rows: readonly T[],
  page: ApiPage,
): { data: T[]; nextCursor: string | null } {
  // The store is asked for one row more than the page, so "is there a next page?"
  // is answered by the data rather than by an estimate or a second query.
  const hasMore = rows.length > page.limit;
  const data = (hasMore ? rows.slice(0, page.limit) : [...rows]);
  return { data, nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null };
}
