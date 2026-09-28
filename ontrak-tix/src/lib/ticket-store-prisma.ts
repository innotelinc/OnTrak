/**
 * Prisma adapters (M0): the concrete side of the `TicketStore` and `AuditSink`
 * ports that `ticket-service.ts` was written against.
 *
 * Two deliberate choices keep this testable and decoupled:
 *
 *  - The Prisma client is described structurally (`TicketPrismaClient`) rather
 *    than imported from a generated client. The tix schema is a separate
 *    database from the training app, so its client is generated per project;
 *    the adapter only needs these six delegate methods and works against the
 *    real client, a fake in tests, or a future repository layer.
 *  - `toTicketRecord` / `toTicketCreate` and friends are pure, so the
 *    date/omit conversions are unit-tested without a database.
 *
 * The chain is per tenant: `AuditEvent.seq` is the position inside that
 * tenant's chain (`@@unique([tenantId, seq])`), not a global row number.
 */

import { createHash, randomUUID } from "node:crypto";

import {
  GENESIS_HASH,
  appendAuditEvent,
  verifyAuditChain,
  type AuditChain,
  type AuditEventInput,
  type AuditRecord,
  type AuditSink,
  type HashFn,
} from "./audit-chain";
import { coercePauses, pausesToJson, type SlaPause } from "./sla-rules";
import type { MessageKind, TicketPriority, TicketStatus, TicketType } from "./ticket-rules";
import type { TicketMessage, TicketRecord, TicketStore } from "./ticket-service";

/** SHA-256 hex digest — the default hash for every Innotel Labs audit chain. */
export const sha256Hex: HashFn = (input) => createHash("sha256").update(input).digest("hex");

/* -------------------------------------------------------------------------- */
/*  Row shapes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A `Message` row as Prisma returns it. Prisma hands back `Date` objects, while
 * the domain layer (`TicketRecord`) speaks ISO strings so records survive a
 * round-trip through JSON and an audit hash.
 */
export interface MessageRow {
  id: string;
  tenantId: string;
  ticketId: string;
  authorId: string | null;
  kind: MessageKind;
  body: string;
  createdAt: Date;
}

/** A `Ticket` row, optionally with its messages included. */
export interface TicketRow {
  id: string;
  tenantId: string;
  ref: string;
  subject: string;
  description: string;
  type: TicketType;
  status: TicketStatus;
  priority: TicketPriority;
  requesterId: string;
  assigneeId: string | null;
  queueId: string | null;
  createdAt: Date;
  updatedAt: Date;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  /** Paused windows as stored JSON; validated on the way back in. */
  slaPauses?: unknown;
  messages?: MessageRow[];
}

/** An `AuditEvent` row. `seq` is the position within the tenant's chain. */
export interface AuditEventRow {
  id: string;
  tenantId: string;
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

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function fromIso(value: string): Date {
  return new Date(value);
}

/** A `Ticket` row → the domain record, mapping dates to ISO strings. */
export function toTicketRecord(row: TicketRow): TicketRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ref: row.ref,
    subject: row.subject,
    description: row.description,
    type: row.type,
    status: row.status,
    priority: row.priority,
    requesterId: row.requesterId,
    assigneeId: row.assigneeId,
    queueId: row.queueId,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    firstResponseAt: toIsoOrNull(row.firstResponseAt ?? null),
    resolvedAt: toIsoOrNull(row.resolvedAt),
    closedAt: toIsoOrNull(row.closedAt),
    pauses: coercePauses(row.slaPauses),
    messages: (row.messages ?? []).map(toMessageRecord),
  };
}

export function toMessageRecord(row: MessageRow): TicketMessage {
  return { id: row.id, kind: row.kind, body: row.body, authorId: row.authorId, createdAt: toIso(row.createdAt) };
}

/**
 * The scalar fields of a new ticket. `id`, `tenantId`, `ref` and the timestamps
 * are all supplied by the domain layer, so the database never invents them.
 */
export function toTicketCreate(ticket: TicketRecord) {
  return {
    id: ticket.id,
    tenantId: ticket.tenantId,
    ref: ticket.ref,
    subject: ticket.subject,
    description: ticket.description,
    type: ticket.type,
    status: ticket.status,
    priority: ticket.priority,
    requesterId: ticket.requesterId,
    assigneeId: ticket.assigneeId,
    queueId: ticket.queueId,
    createdAt: fromIso(ticket.createdAt),
    updatedAt: fromIso(ticket.updatedAt),
    firstResponseAt: ticket.firstResponseAt === null ? null : fromIso(ticket.firstResponseAt),
    resolvedAt: ticket.resolvedAt === null ? null : fromIso(ticket.resolvedAt),
    closedAt: ticket.closedAt === null ? null : fromIso(ticket.closedAt),
    slaPauses: pausesToJson(ticket.pauses),
  };
}

/**
 * Only the mutable fields. A ticket's identity (`id`, `tenantId`, `ref`) and its
 * creation time are immutable, so they are never sent in an `update`.
 */
export function toTicketUpdate(ticket: TicketRecord) {
  return {
    subject: ticket.subject,
    description: ticket.description,
    type: ticket.type,
    status: ticket.status,
    priority: ticket.priority,
    requesterId: ticket.requesterId,
    assigneeId: ticket.assigneeId,
    queueId: ticket.queueId,
    updatedAt: fromIso(ticket.updatedAt),
    firstResponseAt: ticket.firstResponseAt === null ? null : fromIso(ticket.firstResponseAt),
    resolvedAt: ticket.resolvedAt === null ? null : fromIso(ticket.resolvedAt),
    closedAt: ticket.closedAt === null ? null : fromIso(ticket.closedAt),
    slaPauses: pausesToJson(ticket.pauses),
  };
}

/** A ticket's messages as insert rows; the caller decides whether to dedupe. */
export function toMessageRows(ticket: TicketRecord) {
  return ticket.messages.map((message) => ({
    id: message.id,
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    authorId: message.authorId,
    kind: message.kind,
    body: message.body,
    createdAt: fromIso(message.createdAt),
  }));
}

/** An audit record → a database row. `undefined` becomes `null` so it is stored. */
export function toAuditRow(record: AuditRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    seq: record.seq,
    at: fromIso(record.at),
    actor: record.actor,
    action: record.action,
    targetType: record.targetType ?? null,
    targetId: record.targetId ?? null,
    detail: record.detail ?? null,
    prevHash: record.prevHash,
    recordHash: record.recordHash,
  };
}

/**
 * An audit row → a chain record. `null` becomes `undefined` again, which is the
 * inverse of `toAuditRow`, so the canonical payload re-hashes identically.
 */
export function toAuditRecord(row: AuditEventRow): AuditRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    seq: row.seq,
    at: toIso(row.at),
    actor: row.actor,
    action: row.action,
    targetType: row.targetType ?? undefined,
    targetId: row.targetId ?? undefined,
    detail: (row.detail ?? undefined) as Record<string, unknown> | undefined,
    prevHash: row.prevHash,
    recordHash: row.recordHash,
  };
}

/* -------------------------------------------------------------------------- */
/*  The structural Prisma surface                                             */
/* -------------------------------------------------------------------------- */

/**
 * The subset of a generated Prisma client these adapters use. Declared with
 * method syntax so a real client (whose arguments are far more specific) is
 * assignable, and loose enough that a fake is trivial to write in tests.
 */
export interface TicketPrismaClient {
  ticket: {
    count(args: { where: { tenantId: string } }): Promise<number>;
    findFirst(args: unknown): Promise<TicketRow | null>;
    findMany(args: unknown): Promise<TicketRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: { id: string }; data: unknown }): Promise<unknown>;
  };
  message: {
    createMany(args: { data: unknown[]; skipDuplicates?: boolean }): Promise<unknown>;
  };
  auditEvent: {
    findMany(args: unknown): Promise<AuditEventRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
  };
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

export class PrismaTicketStore implements TicketStore {
  constructor(private readonly db: TicketPrismaClient) {}

  /**
   * The next reference number for a tenant. Tickets are never deleted in M0, so
   * the row count is the high-water mark; a tenant that later deletes tickets
   * should switch this to a dedicated counter row in the same transaction.
   */
  async nextTicketSeq(tenantId: string): Promise<number> {
    return (await this.db.ticket.count({ where: { tenantId } })) + 1;
  }

  async listTickets(tenantId: string): Promise<TicketRecord[]> {
    const rows = await this.db.ticket.findMany({
      where: { tenantId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    return rows.map(toTicketRecord);
  }

  async findTicket(tenantId: string, ticketId: string): Promise<TicketRecord | null> {
    const row = await this.db.ticket.findFirst({
      where: { id: ticketId, tenantId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    return row ? toTicketRecord(row) : null;
  }

  async insertTicket(ticket: TicketRecord): Promise<void> {
    await this.db.ticket.create({
      data: { ...toTicketCreate(ticket), messages: { create: toMessageRows(ticket) } },
    });
  }

  /**
   * Write the ticket's current fields and append any messages it has gained.
   * Messages are append-only, so `skipDuplicates` makes re-writing a thread
   * safe: the ones already stored are ignored by primary key.
   */
  async updateTicket(ticket: TicketRecord): Promise<void> {
    await this.db.ticket.update({ where: { id: ticket.id }, data: toTicketUpdate(ticket) });
    const rows = toMessageRows(ticket);
    if (rows.length > 0) await this.db.message.createMany({ data: rows, skipDuplicates: true });
  }
}

/* -------------------------------------------------------------------------- */
/*  The durable audit sink                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A per-tenant, hash-chained audit sink backed by Prisma.
 *
 * Each tenant's chain is loaded once, verified on load (a tampered history is
 * refused rather than extended), then extended one record at a time. The new
 * row is written before the in-memory chain advances, so a failed write cannot
 * leave the cache ahead of the database.
 */
export class PrismaAuditSink implements AuditSink {
  private readonly chains = new Map<string, AuditChain>();

  constructor(
    private readonly db: TicketPrismaClient,
    private readonly hash: HashFn = sha256Hex,
  ) {}

  async append(event: AuditEventInput): Promise<void> {
    const chain = await this.chainFor(event.tenantId);
    const next = appendAuditEvent(chain, event, this.hash);
    const record = next.events[next.events.length - 1];
    await this.db.auditEvent.create({ data: toAuditRow(record) });
    this.chains.set(event.tenantId, next);
  }

  /** A detached copy of a tenant's chain, loading it from the database on first use. */
  async load(tenantId: string): Promise<AuditChain> {
    return structuredClone(await this.chainFor(tenantId));
  }

  /** Re-verify a tenant's persisted chain — the tamper check an auditor runs. */
  async verify(tenantId: string): Promise<ReturnType<typeof verifyAuditChain>> {
    const rows = await this.db.auditEvent.findMany({ where: { tenantId }, orderBy: { seq: "asc" } });
    return verifyAuditChain(chainFromRows(rows), this.hash);
  }

  private async chainFor(tenantId: string): Promise<AuditChain> {
    const cached = this.chains.get(tenantId);
    if (cached) return cached;

    const rows = await this.db.auditEvent.findMany({ where: { tenantId }, orderBy: { seq: "asc" } });
    const chain = chainFromRows(rows);
    const check = verifyAuditChain(chain, this.hash);
    if (!check.ok) {
      throw new Error(
        `Audit chain for tenant ${tenantId} failed verification at ${check.brokenAt}: ${check.reason}.`,
      );
    }
    this.chains.set(tenantId, chain);
    return chain;
  }
}

/**
 * Reads a tenant's audit chain exactly as persisted — *without* verifying it.
 *
 * `PrismaAuditSink.load` deliberately refuses to return a chain that fails
 * verification (appending to a broken chain would entrench the damage), but an
 * assurance packet needs the opposite: it must be able to report that the chain
 * did not verify rather than refuse to be produced at all. So the reader hands
 * back whatever is stored, and the caller decides what that means.
 */
export class PrismaAuditReader {
  constructor(private readonly db: TicketPrismaClient) {}

  async read(tenantId: string): Promise<AuditChain> {
    const rows = await this.db.auditEvent.findMany({ where: { tenantId }, orderBy: { seq: "asc" } });
    return chainFromRows(rows);
  }
}

/** Rebuild a chain from persisted rows. `head` is the last record, or genesis. */
export function chainFromRows(rows: readonly AuditEventRow[]): AuditChain {
  const events = rows.map(toAuditRecord);
  return { events, head: events.length > 0 ? events[events.length - 1].recordHash : GENESIS_HASH };
}

/** A fresh event id for a caller that does not inject one (e.g. the email worker). */
export function newAuditEventId(): string {
  return randomUUID();
}
