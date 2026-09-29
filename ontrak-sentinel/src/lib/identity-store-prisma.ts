/**
 * Prisma adapters (S0): the concrete side of the `IdentityStore` port and the
 * durable, per-organization evidence log.
 *
 * Three choices keep this testable and decoupled:
 *
 *  - The Prisma client is described **structurally** (`IdentityPrismaClient`)
 *    rather than imported from a generated client. The spine is a library before
 *    it is a server, so it must typecheck and its tests must run without a
 *    database or a generated client; the adapter needs these delegates and
 *    nothing else, so it works against the real client, a fake, or a later
 *    repository layer.
 *  - The mappers are pure functions. The conversions they perform are the ones
 *    worth testing without a database: the domain speaks ISO-8601 strings and
 *    epoch milliseconds while Postgres speaks `DateTime`, and a session whose
 *    lifetime is off by a factor of 1000 is a bug nobody sees until it locks an
 *    administrator out.
 *  - **One chain per organization, verified before it is extended.** The durable
 *    trail loads an organization's rows on first use and refuses to append to a
 *    chain that does not verify — a tampered history is a finding, not a base to
 *    build on. `verify()` and `trail()` re-read the rows rather than trusting the
 *    in-process cache, because the question they answer is about what is *stored*.
 */

import {
  appendAuditEvent,
  GENESIS_HASH,
  verifyAuditChain,
  type AuditChain,
  type AuditEvent,
  type AuditEventInput,
  type ChainVerification,
  type HashFn,
} from "./audit-chain";
import type {
  IdentityKind,
  IdentityRecord,
  IdentityRole,
  OrganizationRecord,
  SessionRecord,
} from "./identity-rules";
import { sha256Hex } from "./hash";
import type { AuditTrail, IdentityStore } from "./identity-service";

/** SHA-256 hex digest — the family's default audit hash. */
export { sha256Hex };

/* -------------------------------------------------------------------------- */
/*  Row shapes                                                                */
/* -------------------------------------------------------------------------- */

/** An `Organization` row as Prisma returns it. */
export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
}

export interface IdentityRow {
  id: string;
  organizationId: string;
  identifier: string;
  displayName: string;
  kind: IdentityKind;
  role: IdentityRole;
  active: boolean;
  mfaEnrolled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** A `Session` row. The domain reads these as epoch milliseconds. */
export interface SessionRow {
  id: string;
  organizationId: string;
  identityId: string;
  issuedAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  userAgent: string | null;
  ipAddress: string | null;
}

/** An `AuditEvent` row. `seq` is the position inside one organization's chain. */
export interface AuditEventRow {
  id: string;
  organizationId: string;
  seq: number;
  at: Date;
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: unknown;
  prevHash: string;
  recordHash: string;
}

/* -------------------------------------------------------------------------- */
/*  Mappers (pure)                                                            */
/* -------------------------------------------------------------------------- */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** A date column as epoch milliseconds — the unit the session rules read. */
function toMs(value: Date | string | number): number {
  if (typeof value === "number") return value;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function toMsOrNull(value: Date | string | number | null): number | null {
  return value === null ? null : toMs(value);
}

function fromMs(value: number): Date {
  return new Date(value);
}

export function toOrganizationRecord(row: OrganizationRow): OrganizationRecord {
  return { id: row.id, name: row.name, slug: row.slug, createdAt: toIso(row.createdAt) };
}

/**
 * An `Identity` row → the domain record. `mfaEnrolled` is read from the column
 * rather than recomputed from the factors: every session decision reads it, and
 * a decision that queries a second table is a decision that can disagree with
 * the first.
 */
export function toIdentityRecord(row: IdentityRow): IdentityRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    identifier: row.identifier,
    displayName: row.displayName,
    kind: row.kind,
    role: row.role,
    active: row.active,
    mfaEnrolled: row.mfaEnrolled,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    identityId: row.identityId,
    issuedAt: toMs(row.issuedAt),
    lastSeenAt: toMs(row.lastSeenAt),
    expiresAt: toMs(row.expiresAt),
    revokedAt: toMsOrNull(row.revokedAt),
    userAgent: row.userAgent,
    ipAddress: row.ipAddress,
  };
}

export function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    seq: row.seq,
    at: toIso(row.at),
    actor: row.actor,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    // `null` becomes `undefined` again, the inverse of `toAuditRow`, so the
    // canonical payload re-hashes identically.
    detail: row.detail ?? undefined,
    prevHash: row.prevHash,
    recordHash: row.recordHash,
  };
}

export function toOrganizationCreate(record: OrganizationRecord) {
  return { id: record.id, name: record.name, slug: record.slug, createdAt: new Date(record.createdAt) };
}

export function toIdentityCreate(record: IdentityRecord) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    identifier: record.identifier,
    displayName: record.displayName,
    kind: record.kind,
    role: record.role,
    active: record.active,
    mfaEnrolled: record.mfaEnrolled,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

/** Only the mutable fields: who an identity *is* does not change. */
export function toIdentityUpdate(record: IdentityRecord) {
  return {
    identifier: record.identifier,
    displayName: record.displayName,
    role: record.role,
    active: record.active,
    mfaEnrolled: record.mfaEnrolled,
    updatedAt: new Date(record.updatedAt),
  };
}

export function toSessionCreate(record: SessionRecord) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    identityId: record.identityId,
    issuedAt: fromMs(record.issuedAt),
    lastSeenAt: fromMs(record.lastSeenAt),
    expiresAt: fromMs(record.expiresAt),
    revokedAt: record.revokedAt === null ? null : fromMs(record.revokedAt),
    userAgent: record.userAgent,
    ipAddress: record.ipAddress,
  };
}

/** A session is never re-pointed at another identity or organization. */
export function toSessionUpdate(record: SessionRecord) {
  return {
    lastSeenAt: fromMs(record.lastSeenAt),
    expiresAt: fromMs(record.expiresAt),
    revokedAt: record.revokedAt === null ? null : fromMs(record.revokedAt),
    userAgent: record.userAgent,
    ipAddress: record.ipAddress,
  };
}

export function toAuditRow(event: AuditEvent) {
  return {
    id: event.id,
    organizationId: organizationOf(event),
    seq: event.seq,
    at: new Date(event.at),
    actor: event.actor,
    action: event.action,
    targetType: event.targetType ?? null,
    targetId: event.targetId ?? null,
    detail: event.detail ?? null,
    prevHash: event.prevHash,
    recordHash: event.recordHash,
  };
}

/**
 * The organization whose chain an event belongs to. It travels in `detail`, so
 * the chain format itself does not have to know about tenants — and an event
 * that does not name one is refused rather than filed in a chain it may not
 * belong to.
 */
export function organizationOf(event: AuditEventInput): string {
  const organizationId = (event.detail as { organizationId?: string } | undefined)?.organizationId;
  if (!organizationId) {
    throw new Error("an audit event must name the organization whose chain it belongs to");
  }
  return organizationId;
}

/* -------------------------------------------------------------------------- */
/*  The structural Prisma surface                                             */
/* -------------------------------------------------------------------------- */

/**
 * The subset of a generated Prisma client these adapters use. Method syntax, so
 * a real client (whose arguments are far more specific) is assignable and a fake
 * is trivial to write in tests.
 */
export interface IdentityPrismaClient {
  organization: {
    findFirst(args: unknown): Promise<OrganizationRow | null>;
    create(args: { data: unknown }): Promise<unknown>;
  };
  identity: {
    findMany(args: unknown): Promise<IdentityRow[]>;
    findFirst(args: unknown): Promise<IdentityRow | null>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
  session: {
    findMany(args: unknown): Promise<SessionRow[]>;
    findFirst(args: unknown): Promise<SessionRow | null>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
  auditEvent: {
    findMany(args: unknown): Promise<AuditEventRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
  };
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

export class PrismaIdentityStore implements IdentityStore {
  constructor(private readonly db: IdentityPrismaClient) {}

  async findOrganization(organizationId: string): Promise<OrganizationRecord | null> {
    const row = await this.db.organization.findFirst({ where: { id: organizationId } });
    return row ? toOrganizationRecord(row) : null;
  }

  async findOrganizationBySlug(slug: string): Promise<OrganizationRecord | null> {
    const row = await this.db.organization.findFirst({ where: { slug: slug.trim().toLowerCase() } });
    return row ? toOrganizationRecord(row) : null;
  }

  async insertOrganization(record: OrganizationRecord): Promise<void> {
    await this.db.organization.create({ data: toOrganizationCreate(record) });
  }

  async listIdentities(organizationId: string): Promise<IdentityRecord[]> {
    const rows = await this.db.identity.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } });
    return rows.map(toIdentityRecord);
  }

  /** A tenant-scoped read: another organization's id is simply not there. */
  async findIdentity(organizationId: string, identityId: string): Promise<IdentityRecord | null> {
    const row = await this.db.identity.findFirst({ where: { organizationId, id: identityId } });
    return row ? toIdentityRecord(row) : null;
  }

  /** Case-insensitively, because an address that differs only in case is one address. */
  async findIdentityByIdentifier(organizationId: string, identifier: string): Promise<IdentityRecord | null> {
    const row = await this.db.identity.findFirst({
      where: { organizationId, identifier: { equals: identifier.trim(), mode: "insensitive" } },
    });
    return row ? toIdentityRecord(row) : null;
  }

  async insertIdentity(record: IdentityRecord): Promise<void> {
    await this.db.identity.create({ data: toIdentityCreate(record) });
  }

  async updateIdentity(record: IdentityRecord): Promise<void> {
    await this.db.identity.update({ where: { id: record.id }, data: toIdentityUpdate(record) });
  }

  async listSessions(organizationId: string, identityId?: string): Promise<SessionRecord[]> {
    const rows = await this.db.session.findMany({
      where: identityId === undefined ? { organizationId } : { organizationId, identityId },
      orderBy: { issuedAt: "asc" },
    });
    return rows.map(toSessionRecord);
  }

  async findSession(organizationId: string, sessionId: string): Promise<SessionRecord | null> {
    const row = await this.db.session.findFirst({ where: { organizationId, id: sessionId } });
    return row ? toSessionRecord(row) : null;
  }

  /**
   * A session by its id alone — the console's lookup.
   *
   * Every other read in this file names its organization, and deliberately so. This
   * one exists because a browser holds one opaque cookie and cannot be expected to
   * know which tenant it belongs to; the organization comes back *from the row*, so
   * it is read rather than trusted, and the session id remains the credential. A
   * session id is a UUID, so this is not a search somebody can walk.
   */
  async findSessionByKey(sessionId: string): Promise<SessionRecord | null> {
    const row = await this.db.session.findFirst({ where: { id: sessionId } });
    return row ? toSessionRecord(row) : null;
  }

  async insertSession(record: SessionRecord): Promise<void> {
    await this.db.session.create({ data: toSessionCreate(record) });
  }

  async updateSession(record: SessionRecord): Promise<void> {
    await this.db.session.update({ where: { id: record.id }, data: toSessionUpdate(record) });
  }
}

/* -------------------------------------------------------------------------- */
/*  The durable evidence log                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A per-organization, hash-chained evidence log backed by Prisma.
 *
 * Each organization's chain is loaded once and verified on load; a chain that
 * fails verification is refused rather than extended, because appending to a
 * tampered history would make the tampering harder to see rather than easier.
 * The new row is written before the in-memory head advances, so a failed write
 * cannot leave the cache ahead of the database.
 */
export class PrismaOrganizationAuditTrail implements AuditTrail {
  private readonly heads = new Map<string, AuditChain>();

  constructor(
    private readonly db: IdentityPrismaClient,
    private readonly hash: HashFn = sha256Hex,
  ) {}

  async append(event: AuditEventInput): Promise<void> {
    const organizationId = organizationOf(event);
    const chain = await this.chainFor(organizationId);
    const next = appendAuditEvent(chain, event, this.hash);
    const record = next.events[next.events.length - 1];
    await this.db.auditEvent.create({ data: toAuditRow(record) });
    this.heads.set(organizationId, next);
  }

  /**
   * The organization's history, as **persisted** — another organization's is
   * never included, and the in-process cache is not consulted, because the
   * question this answers is what is stored.
   */
  async trail(organizationId: string): Promise<readonly AuditEvent[]> {
    return (await this.rows(organizationId)).map(toAuditEvent);
  }

  /** Re-verify the stored chain — the tamper check an auditor runs. */
  async verify(organizationId: string): Promise<ChainVerification> {
    return verifyAuditChain(await this.persisted(organizationId), this.hash);
  }

  /** A detached copy of an organization's chain, loading it on first use. */
  async load(organizationId: string): Promise<AuditChain> {
    return structuredClone(await this.chainFor(organizationId));
  }

  /** The chain as stored, without verifying it — `verify()` does the judging. */
  private async persisted(organizationId: string): Promise<AuditChain> {
    const events = (await this.rows(organizationId)).map(toAuditEvent);
    return { events, head: events.length > 0 ? events[events.length - 1].recordHash : GENESIS_HASH };
  }

  private async rows(organizationId: string): Promise<AuditEventRow[]> {
    return this.db.auditEvent.findMany({ where: { organizationId }, orderBy: { seq: "asc" } });
  }

  private async chainFor(organizationId: string): Promise<AuditChain> {
    const cached = this.heads.get(organizationId);
    if (cached) return cached;

    const chain = await this.persisted(organizationId);
    const check = verifyAuditChain(chain, this.hash);
    if (!check.ok) {
      throw new Error(
        `The evidence chain for organization ${organizationId} failed verification at ${check.brokenAt}: ${check.reason}.`,
      );
    }
    this.heads.set(organizationId, chain);
    return chain;
  }
}
