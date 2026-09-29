/**
 * Prisma adapters (S1): the concrete side of the `OidcStore` port.
 *
 * Same three choices as the S0 adapter in `identity-store-prisma.ts`:
 *
 *  - The generated client is described **structurally** (`OidcPrismaClient`), so
 *    the OIDC engine still typechecks and its tests still run with no database
 *    and no generated client — the adapter needs these three delegates and
 *    nothing else.
 *  - The mappers are pure functions. The domain speaks epoch milliseconds for a
 *    code's lifetime while Postgres speaks `DateTime`, and a code whose lifetime
 *    is off by a factor of 1000 is a bug nobody sees until every sign-in fails —
 *    so the conversion is worth testing without a server.
 *  - **`markCodeUsed` is one conditional write.** `updateMany` with
 *    `where: { code, usedAt: null }` returns the number of rows it changed: two
 *    exchanges racing on one code, and only one gets `1`. A read-then-write would
 *    leave the loser's outcome to luck, which is exactly the replay the flow
 *    exists to prevent.
 *
 * The access token is looked up by its *hash*, never by the token itself: the
 * provider hands the token out once and keeps only `SHA-256(token)`.
 */

import type { OidcClientRecord, OidcScope } from "./oidc-rules";
import type { AccessTokenRecord, AuthorizationCodeRecord, OidcStore } from "./oidc-service";

/* -------------------------------------------------------------------------- */
/*  Row shapes                                                                */
/* -------------------------------------------------------------------------- */

export interface OidcClientRow {
  clientId: string;
  organizationId: string;
  name: string;
  redirectUris: string[] | null;
  scopes: string[] | null;
  kind: string;
  createdBy: string;
  createdAt: Date;
}

/** An `AuthorizationCode` row. The domain reads the instants as epoch ms. */
export interface AuthorizationCodeRow {
  code: string;
  organizationId: string;
  clientId: string;
  redirectUri: string;
  scopes: string[] | null;
  identityId: string;
  sessionId: string;
  nonce: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  issuedAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface AccessTokenRow {
  tokenHash: string;
  organizationId: string;
  clientId: string;
  identityId: string;
  sessionId: string;
  scopes: string[] | null;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

/* -------------------------------------------------------------------------- */
/*  Mappers (pure)                                                            */
/* -------------------------------------------------------------------------- */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** A date column as epoch milliseconds — the unit the code rules read. */
function toMs(value: Date | string | number): number {
  if (typeof value === "number") return value;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function fromMs(value: number): Date {
  return new Date(value);
}

function asScopes(values: readonly string[] | null): OidcScope[] {
  return [...(values ?? [])] as OidcScope[];
}

/** An unknown kind is treated as public, which is the stricter of the two. */
function asKind(value: string): "public" | "confidential" {
  return value === "confidential" ? "confidential" : "public";
}

export function toClientRecord(row: OidcClientRow): OidcClientRecord {
  return {
    clientId: row.clientId,
    organizationId: row.organizationId,
    name: row.name,
    redirectUris: [...(row.redirectUris ?? [])],
    scopes: asScopes(row.scopes),
    kind: asKind(row.kind),
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
  };
}

export function toCodeRecord(row: AuthorizationCodeRow): AuthorizationCodeRecord {
  return {
    code: row.code,
    organizationId: row.organizationId,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    scopes: asScopes(row.scopes),
    identityId: row.identityId,
    sessionId: row.sessionId,
    nonce: row.nonce,
    codeChallenge: row.codeChallenge,
    // Only S256 is ever written — the domain type is a literal — so a row is
    // read back as the one method this provider speaks.
    codeChallengeMethod: "S256",
    issuedAt: toMs(row.issuedAt),
    expiresAt: toMs(row.expiresAt),
    usedAt: row.usedAt === null ? null : toMs(row.usedAt),
  };
}

export function toTokenRecord(row: AccessTokenRow): AccessTokenRecord {
  return {
    tokenHash: row.tokenHash,
    organizationId: row.organizationId,
    clientId: row.clientId,
    identityId: row.identityId,
    sessionId: row.sessionId,
    scopes: asScopes(row.scopes),
    issuedAt: toMs(row.issuedAt),
    expiresAt: toMs(row.expiresAt),
    revokedAt: row.revokedAt === null || row.revokedAt === undefined ? null : toMs(row.revokedAt),
  };
}

export function toClientCreate(record: OidcClientRecord) {
  return {
    clientId: record.clientId,
    organizationId: record.organizationId,
    name: record.name,
    redirectUris: [...record.redirectUris],
    scopes: [...record.scopes],
    kind: record.kind,
    createdBy: record.createdBy,
    createdAt: new Date(record.createdAt),
  };
}

export function toCodeCreate(record: AuthorizationCodeRecord) {
  return {
    code: record.code,
    organizationId: record.organizationId,
    clientId: record.clientId,
    redirectUri: record.redirectUri,
    scopes: [...record.scopes],
    identityId: record.identityId,
    sessionId: record.sessionId,
    nonce: record.nonce,
    codeChallenge: record.codeChallenge,
    codeChallengeMethod: record.codeChallengeMethod,
    issuedAt: fromMs(record.issuedAt),
    expiresAt: fromMs(record.expiresAt),
    usedAt: record.usedAt === null ? null : fromMs(record.usedAt),
  };
}

export function toTokenCreate(record: AccessTokenRecord) {
  return {
    tokenHash: record.tokenHash,
    organizationId: record.organizationId,
    clientId: record.clientId,
    identityId: record.identityId,
    sessionId: record.sessionId,
    scopes: [...record.scopes],
    issuedAt: fromMs(record.issuedAt),
    expiresAt: fromMs(record.expiresAt),
    revokedAt: record.revokedAt === null ? null : fromMs(record.revokedAt),
  };
}

/* -------------------------------------------------------------------------- */
/*  The structural Prisma surface                                             */
/* -------------------------------------------------------------------------- */

/**
 * The subset of a generated Prisma client these adapters use. Method syntax, so
 * a real client is assignable and a fake is trivial to write in tests.
 */
export interface OidcPrismaClient {
  oidcClient: {
    findFirst(args: unknown): Promise<OidcClientRow | null>;
    findMany(args: unknown): Promise<OidcClientRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
  };
  authorizationCode: {
    findFirst(args: unknown): Promise<AuthorizationCodeRow | null>;
    create(args: { data: unknown }): Promise<unknown>;
    updateMany(args: { where: unknown; data: unknown }): Promise<{ count: number }>;
  };
  accessToken: {
    findFirst(args: unknown): Promise<AccessTokenRow | null>;
    create(args: { data: unknown }): Promise<unknown>;
    updateMany(args: { where: unknown; data: unknown }): Promise<{ count: number }>;
  };
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

export class PrismaOidcStore implements OidcStore {
  constructor(private readonly db: OidcPrismaClient) {}

  async insertClient(record: OidcClientRecord): Promise<void> {
    await this.db.oidcClient.create({ data: toClientCreate(record) });
  }

  /** `client_id` is globally unique, so this is deliberately unscoped. */
  async findClient(clientId: string): Promise<OidcClientRecord | null> {
    const row = await this.db.oidcClient.findFirst({ where: { clientId } });
    return row ? toClientRecord(row) : null;
  }

  async listClients(organizationId: string): Promise<OidcClientRecord[]> {
    const rows = await this.db.oidcClient.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } });
    return rows.map(toClientRecord);
  }

  async insertCode(record: AuthorizationCodeRecord): Promise<void> {
    await this.db.authorizationCode.create({ data: toCodeCreate(record) });
  }

  async findCode(code: string): Promise<AuthorizationCodeRecord | null> {
    const row = await this.db.authorizationCode.findFirst({ where: { code } });
    return row ? toCodeRecord(row) : null;
  }

  /**
   * One conditional write. The loser of a race gets `false` — not a second token
   * — because the update only matches a code that has not been spent.
   */
  async markCodeUsed(code: string, at: number): Promise<boolean> {
    const result = await this.db.authorizationCode.updateMany({
      where: { code, usedAt: null },
      data: { usedAt: fromMs(at) },
    });
    return result.count === 1;
  }

  async insertToken(record: AccessTokenRecord): Promise<void> {
    await this.db.accessToken.create({ data: toTokenCreate(record) });
  }

  async findToken(tokenHash: string): Promise<AccessTokenRecord | null> {
    const row = await this.db.accessToken.findFirst({ where: { tokenHash } });
    return row ? toTokenRecord(row) : null;
  }

  /**
   * One conditional write, for the same reason `markCodeUsed` is: `where`
   * matches only a token that is not already revoked, so two revocations racing
   * produce exactly one `1` instead of both claiming the kill.
   */
  async revokeToken(tokenHash: string, at: number): Promise<boolean> {
    const result = await this.db.accessToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: fromMs(at) },
    });
    return result.count === 1;
  }

  /**
   * One statement for the whole session. Scoped by `organizationId` as well as
   * `sessionId`, so a sign-out cannot reach another tenant's tokens even if the
   * two happened to share a session id.
   */
  async revokeTokensForSession(organizationId: string, sessionId: string, at: number): Promise<number> {
    const result = await this.db.accessToken.updateMany({
      where: { organizationId, sessionId, revokedAt: null },
      data: { revokedAt: fromMs(at) },
    });
    return result.count;
  }
}
