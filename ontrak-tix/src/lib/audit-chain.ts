/**
 * Hash-chained, append-only audit log (M0).
 *
 * Every tenant has its own chain; each record carries the tenant it belongs to
 * and commits to the previous record's hash, so history cannot be quietly
 * edited, deleted or spliced across tenants. This is the assurance spine the
 * incident-response work later hangs off, so it exists from day one.
 *
 * Pure and dependency-free: the caller supplies the hash function, which keeps
 * this usable in tests, in a server action, or in a worker.
 */

export const GENESIS_HASH = "0".repeat(64);

export type HashFn = (input: string) => string;

export interface AuditEventInput {
  id: string;
  tenantId: string;
  /** Server-authoritative UTC timestamp. */
  at: string;
  /** Who or what caused the event: a user id, or a system label. */
  actor: string;
  /** A stable verb, e.g. `ticket.create`. */
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}

export interface AuditRecord extends AuditEventInput {
  /** Chain position, 1-based. */
  seq: number;
  prevHash: string;
  recordHash: string;
}

export interface AuditChain {
  events: AuditRecord[];
  head: string;
}

/**
 * A deterministic JSON encoding: object keys are sorted and `undefined` is
 * dropped, so equal content always hashes equally regardless of insertion
 * order. Arrays keep their order and render holes as `null`.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * The canonical bytes a record commits to. Fields are listed explicitly rather
 * than spread, so a record's own `seq`/`prevHash`/`recordHash` can never leak
 * into its payload when it is re-hashed during verification.
 */
export function recordPayload(event: AuditEventInput, seq: number, prevHash: string): string {
  return stableStringify({
    seq,
    prevHash,
    id: event.id,
    tenantId: event.tenantId,
    at: event.at,
    actor: event.actor,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    detail: event.detail,
  });
}

export function createAuditChain(): AuditChain {
  return { events: [], head: GENESIS_HASH };
}

/** Append one event, returning a new chain. The input chain is never mutated. */
export function appendAuditEvent(chain: AuditChain, event: AuditEventInput, hash: HashFn): AuditChain {
  const seq = chain.events.length + 1;
  const prevHash = chain.head;
  const record: AuditRecord = { ...event, seq, prevHash, recordHash: hash(recordPayload(event, seq, prevHash)) };
  return { events: [...chain.events, record], head: record.recordHash };
}

export type VerifyResult =
  | { ok: true; length: number }
  | { ok: false; brokenAt: number; reason: string };

/** Walk the chain and report the first record that does not verify. */
export function verifyAuditChain(chain: AuditChain, hash: HashFn): VerifyResult {
  let prev = GENESIS_HASH;
  for (let index = 0; index < chain.events.length; index++) {
    const record = chain.events[index];
    const seq = index + 1;
    if (record.seq !== seq) return { ok: false, brokenAt: seq, reason: "sequence gap" };
    if (record.prevHash !== prev) return { ok: false, brokenAt: seq, reason: "link to the previous record was tampered with" };
    if (record.recordHash !== hash(recordPayload(record, seq, prev))) {
      return { ok: false, brokenAt: seq, reason: "record contents were tampered with" };
    }
    prev = record.recordHash;
  }
  if (chain.head !== prev) {
    return { ok: false, brokenAt: chain.events.length, reason: "head does not match the chain" };
  }
  return { ok: true, length: chain.events.length };
}

/**
 * Where an audit event goes. The ticket service depends on this, not on the
 * concrete in-memory `AuditLog`, so the app can hand it a durable, per-tenant
 * hash-chained sink (`PrismaAuditSink`) without the service knowing how history
 * is stored. Returning `unknown` keeps both the synchronous in-memory log and
 * the asynchronous database sink assignable, and callers simply `await` it.
 */
export interface AuditSink {
  append(event: AuditEventInput): unknown;
}

/** A small mutable wrapper for callers that append in a loop. */
export class AuditLog implements AuditSink {
  private chain: AuditChain = createAuditChain();

  constructor(private readonly hash: HashFn) {}

  append(event: AuditEventInput): AuditRecord {
    this.chain = appendAuditEvent(this.chain, event, this.hash);
    return this.chain.events[this.chain.events.length - 1];
  }

  verify(): VerifyResult {
    return verifyAuditChain(this.chain, this.hash);
  }

  /** A detached copy, safe to persist or inspect without aliasing. */
  snapshot(): AuditChain {
    return structuredClone(this.chain);
  }

  get length(): number {
    return this.chain.events.length;
  }
}
