/**
 * Prisma adapter for public API tokens (M6).
 *
 * The same split as every other adapter in the project — the port speaks domain
 * records with ISO strings, this file owns the row and the `Date` conversions, and
 * nothing here decides anything — with one piece of real work: `consumeRateLimit`.
 *
 * It is written as **conditional writes rather than read-then-write**, for the
 * same reason `markCodeUsed` is:
 *
 *  1. A request that falls in a window other than the stored one starts a fresh
 *     window at 1. The `where` matches only a row whose window is *not* this one,
 *     so two concurrent first-requests in a new window cannot both reset it.
 *  2. Otherwise the count goes up — but only while it is under the ceiling, so a
 *     token that has already blown its limit cannot be made to grow a bigger
 *     number by being hammered. That ceiling is the one stated guarantee of a
 *     refusing endpoint: it stays cheap to refuse.
 *
 * The read-back afterwards is only to report the count; the decision is made from
 * it by the pure rules, so an off-by-one here surfaces as a `remaining` value a
 * test pins rather than as a silent change in who is allowed in.
 */

import type { ApiScope, ApiTokenRecord } from "./public-api-rules";
import type { ApiTokenStore, RateConsumption } from "./public-api-service";

export interface ApiTokenRow {
  id: string;
  tenantId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  scopes: string[] | null;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  rateLimitPerMinute: number;
  rateWindowStart: Date | null;
  rateCount: number;
}

export interface ApiTokenPrismaClient {
  apiToken: {
    findFirst(args: unknown): Promise<ApiTokenRow | null>;
    findMany(args: unknown): Promise<ApiTokenRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
    updateMany(args: { where: unknown; data: unknown }): Promise<{ count: number }>;
  };
}

/* -------------------------------------------------------------------------- */
/*  Mappers (pure)                                                            */
/* -------------------------------------------------------------------------- */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function toMsOrNull(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Unknown scopes are dropped on the way in: a scope we do not issue grants nothing. */
function asScopes(values: readonly string[] | null): ApiScope[] {
  const granted: ApiScope[] = [];
  for (const value of values ?? []) {
    if (value === "tickets:read" || value === "tickets:write" || value === "webhooks:manage") granted.push(value);
  }
  return granted;
}

export function toTokenRecord(row: ApiTokenRow): ApiTokenRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    tokenHash: row.tokenHash,
    tokenPrefix: row.tokenPrefix,
    scopes: asScopes(row.scopes),
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
    expiresAt: toIsoOrNull(row.expiresAt),
    revokedAt: toIsoOrNull(row.revokedAt),
    lastUsedAt: toIsoOrNull(row.lastUsedAt),
    rateLimitPerMinute: row.rateLimitPerMinute,
    rateWindowStart: toMsOrNull(row.rateWindowStart),
    rateCount: row.rateCount,
  };
}

export function toTokenCreate(record: ApiTokenRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    name: record.name,
    tokenHash: record.tokenHash,
    tokenPrefix: record.tokenPrefix,
    scopes: [...record.scopes],
    createdBy: record.createdBy,
    createdAt: new Date(record.createdAt),
    expiresAt: record.expiresAt === null ? null : new Date(record.expiresAt),
    revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt),
    lastUsedAt: record.lastUsedAt === null ? null : new Date(record.lastUsedAt),
    rateLimitPerMinute: record.rateLimitPerMinute,
    rateWindowStart: record.rateWindowStart === null ? null : new Date(record.rateWindowStart),
    rateCount: record.rateCount,
  };
}

export function toTokenUpdate(record: ApiTokenRecord) {
  return {
    name: record.name,
    scopes: [...record.scopes],
    expiresAt: record.expiresAt === null ? null : new Date(record.expiresAt),
    revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt),
    lastUsedAt: record.lastUsedAt === null ? null : new Date(record.lastUsedAt),
    rateLimitPerMinute: record.rateLimitPerMinute,
    rateWindowStart: record.rateWindowStart === null ? null : new Date(record.rateWindowStart),
    rateCount: record.rateCount,
  };
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

export class PrismaApiTokenStore implements ApiTokenStore {
  constructor(private readonly db: ApiTokenPrismaClient) {}

  async insertToken(record: ApiTokenRecord): Promise<void> {
    await this.db.apiToken.create({ data: toTokenCreate(record) });
  }

  /** By hash, unscoped: the hash is the credential, so there is no tenant hint yet. */
  async findTokenByHash(tokenHash: string): Promise<ApiTokenRecord | null> {
    const row = await this.db.apiToken.findFirst({ where: { tokenHash } });
    return row ? toTokenRecord(row) : null;
  }

  async findToken(tenantId: string, tokenId: string): Promise<ApiTokenRecord | null> {
    const row = await this.db.apiToken.findFirst({ where: { tenantId, id: tokenId } });
    return row ? toTokenRecord(row) : null;
  }

  async listTokens(tenantId: string): Promise<ApiTokenRecord[]> {
    const rows = await this.db.apiToken.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } });
    return rows.map(toTokenRecord);
  }

  async updateToken(record: ApiTokenRecord): Promise<void> {
    await this.db.apiToken.update({ where: { id: record.id }, data: toTokenUpdate(record) });
  }

  /** Two conditional writes and a read. See the note at the top of this file. */
  async consumeRateLimit(input: { tokenId: string; windowStartMs: number; nowMs: number; limit: number }): Promise<RateConsumption> {
    const windowStart = new Date(input.windowStartMs);
    const now = new Date(input.nowMs);

    const started = await this.db.apiToken.updateMany({
      where: { id: input.tokenId, NOT: { rateWindowStart: windowStart } },
      data: { rateWindowStart: windowStart, rateCount: 1, lastUsedAt: now },
    });
    if (started.count === 1) return { windowStartMs: input.windowStartMs, count: 1 };

    await this.db.apiToken.updateMany({
      where: { id: input.tokenId, rateCount: { lt: input.limit + 1 } },
      data: { rateCount: { increment: 1 }, lastUsedAt: now },
    });

    const row = await this.db.apiToken.findFirst({ where: { id: input.tokenId } });
    // A row that vanished between the two writes cannot be this request's token;
    // reporting a spent window refuses it, which is the safe direction.
    if (!row) return { windowStartMs: input.windowStartMs, count: input.limit + 1 };
    return { windowStartMs: toMsOrNull(row.rateWindowStart) ?? input.windowStartMs, count: row.rateCount };
  }
}
