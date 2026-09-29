/**
 * Prisma adapter for second factors (S1).
 *
 * The same split as every other adapter here: the port speaks domain records
 * with ISO strings, this file owns the row and the `Date` conversion, and nothing
 * here decides anything. The rows have existed since the first migration
 * (`MfaFactor`), unused; `20261001000000_mfa_totp` gives them the three columns
 * that make an enrollment a state rather than a hope — `confirmedAt`,
 * `lastUsedAt` and `lastUsedCounter`.
 *
 * One choice is worth naming. A row whose `kind` this deployment does not
 * implement maps to `null` rather than being coerced to `TOTP`: the alternative
 * hands the service a WebAuthn credential id and asks it to base32-decode it, and
 * "the secret is unreadable" is a worse error than "that factor is not one we
 * issue". Unknown rows are simply not returned.
 */

import { isMfaKind, type MfaFactorRecord } from "./mfa-rules";
import type { MfaStore } from "./mfa-service";
import type { WebAuthnCeremony, WebAuthnChallengeRecord } from "./webauthn-rules";
import type { WebAuthnChallengeStore } from "./webauthn-service";

export interface MfaFactorRow {
  id: string;
  organizationId: string;
  identityId: string;
  kind: string;
  /** TOTP: the base32 secret. WebAuthn: the base64url credential id. */
  secret: string;
  /** WebAuthn only: the COSE public key, as JSON. A public key is not a secret. */
  publicKey: string | null;
  /** WebAuthn only: the last authenticator signature counter. */
  signCount: number | null;
  label: string | null;
  confirmedAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedCounter: number | null;
  createdAt: Date;
}

export interface MfaPrismaClient {
  mfaFactor: {
    create(args: { data: unknown }): Promise<unknown>;
    findUnique(args: { where: { id: string } }): Promise<MfaFactorRow | null>;
    findFirst(args: unknown): Promise<MfaFactorRow | null>;
    findMany(args: unknown): Promise<MfaFactorRow[]>;
    update(args: { where: { id: string }; data: unknown }): Promise<unknown>;
    deleteMany(args: { where: unknown }): Promise<{ count: number }>;
  };
}

function toIso(value: Date | string | null): string | null {
  return value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** The row as the port sees it, or `null` when its kind is not one we implement. */
export function toMfaFactorRecord(row: MfaFactorRow): MfaFactorRecord | null {
  if (!isMfaKind(row.kind)) return null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    identityId: row.identityId,
    kind: row.kind,
    secret: row.secret,
    publicKey: row.publicKey,
    signCount: row.signCount,
    label: row.label,
    confirmedAt: toIso(row.confirmedAt),
    lastUsedAt: toIso(row.lastUsedAt),
    lastUsedCounter: row.lastUsedCounter,
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
  };
}

/** The write shape a factor's creation needs. Pure, so it is testable on its own. */
export function toMfaFactorCreate(record: MfaFactorRecord): Record<string, unknown> {
  return {
    id: record.id,
    organizationId: record.organizationId,
    identityId: record.identityId,
    kind: record.kind,
    secret: record.secret,
    publicKey: record.publicKey,
    signCount: record.signCount,
    label: record.label,
    confirmedAt: record.confirmedAt === null ? null : new Date(record.confirmedAt),
    lastUsedAt: record.lastUsedAt === null ? null : new Date(record.lastUsedAt),
    lastUsedCounter: record.lastUsedCounter,
    createdAt: new Date(record.createdAt),
  };
}

/** The columns a change may touch. Nothing is allowed to rewrite a factor's identity. */
export function toMfaFactorUpdate(record: MfaFactorRecord): Record<string, unknown> {
  return {
    label: record.label,
    publicKey: record.publicKey,
    signCount: record.signCount,
    confirmedAt: record.confirmedAt === null ? null : new Date(record.confirmedAt),
    lastUsedAt: record.lastUsedAt === null ? null : new Date(record.lastUsedAt),
    lastUsedCounter: record.lastUsedCounter,
  };
}

export class PrismaMfaStore implements MfaStore {
  constructor(private readonly db: MfaPrismaClient) {}

  async insertFactor(record: MfaFactorRecord): Promise<void> {
    await this.db.mfaFactor.create({ data: toMfaFactorCreate(record) });
  }

  async findFactorById(organizationId: string, factorId: string): Promise<MfaFactorRecord | null> {
    const row = await this.db.mfaFactor.findUnique({ where: { id: factorId } });
    if (!row || row.organizationId !== organizationId) return null;
    return toMfaFactorRecord(row);
  }

  async findFactor(organizationId: string, identityId: string, kind: string): Promise<MfaFactorRecord | null> {
    const rows = await this.db.mfaFactor.findMany({
      where: { organizationId, identityId, kind },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    return rows[0] ? toMfaFactorRecord(rows[0]) : null;
  }

  async listFactors(organizationId: string, identityId: string): Promise<MfaFactorRecord[]> {
    const rows = await this.db.mfaFactor.findMany({
      where: { organizationId, identityId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toMfaFactorRecord).filter((record): record is MfaFactorRecord => record !== null);
  }

  async updateFactor(record: MfaFactorRecord): Promise<void> {
    await this.db.mfaFactor.update({ where: { id: record.id }, data: toMfaFactorUpdate(record) });
  }

  async removeFactor(organizationId: string, factorId: string): Promise<void> {
    // Scoped in the `where`, like every other delete in this project: a query that
    // forgets its organization is a cross-tenant write.
    await this.db.mfaFactor.deleteMany({ where: { organizationId, id: factorId } });
  }
}

/* -------------------------------------------------------------------------- */
/*  WebAuthn challenges                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A ceremony in progress, as a row.
 *
 * Durable rather than in-process, and that is the point: a challenge is spent by a
 * conditional write, so the property that matters — **a challenge is accepted
 * exactly once** — holds across two workers behind a load balancer, not merely
 * inside one process's memory.
 */
export interface WebAuthnChallengeRow {
  id: string;
  organizationId: string;
  identityId: string;
  ceremony: string;
  challenge: string;
  origin: string;
  rpId: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface WebAuthnChallengePrismaClient {
  webAuthnChallenge: {
    create(args: { data: unknown }): Promise<unknown>;
    findFirst(args: unknown): Promise<WebAuthnChallengeRow | null>;
    updateMany(args: { where: unknown; data: unknown }): Promise<{ count: number }>;
    deleteMany(args: { where: unknown }): Promise<{ count: number }>;
  };
}

function isCeremony(value: string): value is WebAuthnCeremony {
  return value === "REGISTRATION" || value === "AUTHENTICATION";
}

function toChallengeRecord(row: WebAuthnChallengeRow): WebAuthnChallengeRecord | null {
  // An unknown ceremony maps to `null` rather than being coerced: a row this
  // deployment does not implement is not a ceremony it should verify.
  if (!isCeremony(row.ceremony)) return null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    identityId: row.identityId,
    ceremony: row.ceremony,
    challenge: row.challenge,
    origin: row.origin,
    rpId: row.rpId,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
    usedAt: row.usedAt === null ? null : row.usedAt.getTime(),
  };
}

export class PrismaWebAuthnChallengeStore implements WebAuthnChallengeStore {
  constructor(private readonly db: WebAuthnChallengePrismaClient) {}

  async insertChallenge(record: WebAuthnChallengeRecord): Promise<void> {
    await this.db.webAuthnChallenge.create({
      data: {
        id: record.id,
        organizationId: record.organizationId,
        identityId: record.identityId,
        ceremony: record.ceremony,
        challenge: record.challenge,
        origin: record.origin,
        rpId: record.rpId,
        createdAt: new Date(record.createdAt),
        expiresAt: new Date(record.expiresAt),
        usedAt: record.usedAt === null ? null : new Date(record.usedAt),
      },
    });
  }

  async findChallenge(organizationId: string, challengeId: string): Promise<WebAuthnChallengeRecord | null> {
    const row = await this.db.webAuthnChallenge.findFirst({ where: { organizationId, id: challengeId } });
    return row ? toChallengeRecord(row) : null;
  }

  async findLiveChallenge(
    organizationId: string,
    identityId: string,
    ceremony: WebAuthnCeremony,
  ): Promise<WebAuthnChallengeRecord | null> {
    const row = await this.db.webAuthnChallenge.findFirst({
      where: { organizationId, identityId, ceremony, usedAt: null },
      orderBy: { createdAt: "desc" },
    });
    return row ? toChallengeRecord(row) : null;
  }

  async updateChallenge(record: WebAuthnChallengeRecord): Promise<void> {
    await this.db.webAuthnChallenge.updateMany({
      where: { organizationId: record.organizationId, id: record.id },
      data: { usedAt: record.usedAt === null ? null : new Date(record.usedAt) },
    });
  }

  /**
   * Spend a challenge, in one conditional write.
   *
   * `usedAt: null` in the `where` is the whole of the replay defence: two ceremonies
   * racing on one challenge produce one update and one refusal, rather than two
   * verified registrations. The expiry is in the same condition, so a row that is
   * still technically present is not spendable an hour later.
   */
  async consumeChallenge(organizationId: string, challengeId: string, atMs: number): Promise<boolean> {
    const result = await this.db.webAuthnChallenge.updateMany({
      where: { organizationId, id: challengeId, usedAt: null, expiresAt: { gte: new Date(atMs) } },
      data: { usedAt: new Date(atMs) },
    });
    return result.count === 1;
  }

  async removeChallenge(organizationId: string, challengeId: string): Promise<void> {
    await this.db.webAuthnChallenge.deleteMany({ where: { organizationId, id: challengeId } });
  }
}
