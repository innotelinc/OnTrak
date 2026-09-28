/**
 * Hash-chained, append-only audit log.
 *
 * This is the evidence spine of OnTrak Sentinel (S0): every authentication,
 * policy change, detection and enforcement action is appended here, and each
 * record commits to the one before it. Rewriting or deleting any record breaks
 * the chain, so retroactive edits are *detectable*, not merely discouraged.
 *
 * The module is deliberately pure — no database, no framework, no Node built-ins.
 * The hash function is injected, so the same logic runs in a server process
 * (SHA-256 from `node:crypto`) and in tests, and can later be swapped for a
 * HSM-backed or hardware-rooted signer.
 */

/** A synchronous hash of a UTF-8 string, returned as a lower-case hex digest. */
export type HashFn = (input: string) => string;

/** The `prevHash` of the first event. Never the hash of anything real. */
export const GENESIS_HASH = "0".repeat(64);

/** The fields a caller supplies when appending an event. */
export interface AuditEventInput {
  /** Stable, unique id (for idempotent replay); supplied by the caller. */
  id: string;
  /** Server-authoritative UTC timestamp, ISO-8601. */
  at: string;
  /** Who acted: a human identity id, or a system/agent id. */
  actor: string;
  /** What happened, e.g. `identity.create`, `session.grant`, `block.apply`. */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  /** Structured detail. Canonicalised before hashing, so key order is irrelevant. */
  detail?: unknown;
}

/** An event as stored: the input plus its position in the chain. */
export interface AuditEvent extends AuditEventInput {
  /** Monotonic sequence number, starting at 1. */
  seq: number;
  /** Hash of the previous record (`GENESIS_HASH` for the first). */
  prevHash: string;
  /** Hash over this record's canonical payload, including `prevHash`. */
  recordHash: string;
}

export interface AuditChain {
  /** Oldest first; append-only. */
  events: AuditEvent[];
  /** The most recent `recordHash`, or `GENESIS_HASH` when empty. */
  head: string;
}

export interface AuditRecordPayload {
  seq: number;
  id: string;
  at: string;
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: unknown;
  prevHash: string;
}

export type ChainVerification =
  | { ok: true; length: number }
  | { ok: false; brokenAt: number; reason: string };

export function createAuditChain(): AuditChain {
  return { events: [], head: GENESIS_HASH };
}

/**
 * Deterministic JSON: object keys are sorted, `undefined` is dropped, and
 * `undefined` values inside arrays become `null`. Two records with the same
 * content always hash to the same digest regardless of insertion order.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return "null";

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item ?? null)).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

function payloadOf(event: AuditEvent): AuditRecordPayload {
  return {
    seq: event.seq,
    id: event.id,
    at: event.at,
    actor: event.actor,
    action: event.action,
    targetType: event.targetType ?? null,
    targetId: event.targetId ?? null,
    detail: event.detail ?? null,
    prevHash: event.prevHash,
  };
}

/** The digest a record commits to. */
export function hashRecord(payload: AuditRecordPayload, hash: HashFn): string {
  return hash(stableStringify(payload));
}

/**
 * Append an event, returning a **new** chain (the input is never mutated).
 * The record commits to the current head via `prevHash`.
 */
export function appendAuditEvent(chain: AuditChain, input: AuditEventInput, hash: HashFn): AuditChain {
  const seq = chain.events.length + 1;
  const prevHash = chain.head;
  const payload: AuditRecordPayload = {
    seq,
    id: input.id,
    at: input.at,
    actor: input.actor,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    detail: input.detail ?? null,
    prevHash,
  };
  const recordHash = hashRecord(payload, hash);
  const event: AuditEvent = { ...input, seq, prevHash, recordHash };

  return { events: [...chain.events, event], head: recordHash };
}

/**
 * Verify the whole chain: sequence is contiguous, every `prevHash` matches the
 * prior record, every `recordHash` recomputes, and `head` matches the last
 * record. Any tampering is reported with the first position that broke.
 */
export function verifyAuditChain(chain: AuditChain, hash: HashFn): ChainVerification {
  let prev = GENESIS_HASH;

  for (let index = 0; index < chain.events.length; index += 1) {
    const event = chain.events[index];
    const expectedSeq = index + 1;

    if (event.seq !== expectedSeq) {
      return { ok: false, brokenAt: expectedSeq, reason: `sequence ${event.seq} at position ${expectedSeq}` };
    }
    if (event.prevHash !== prev) {
      return { ok: false, brokenAt: expectedSeq, reason: "previous hash does not match the prior record" };
    }
    if (hashRecord(payloadOf(event), hash) !== event.recordHash) {
      return { ok: false, brokenAt: expectedSeq, reason: "record hash does not match its contents (tampered)" };
    }

    prev = event.recordHash;
  }

  if (chain.head !== prev) {
    return { ok: false, brokenAt: chain.events.length, reason: "chain head does not match the last record" };
  }

  return { ok: true, length: chain.events.length };
}

/** A tiny in-memory log for tests and single-process use. */
export class AuditLog {
  private chain: AuditChain = createAuditChain();

  constructor(private readonly hash: HashFn) {}

  append(input: AuditEventInput): AuditEvent {
    this.chain = appendAuditEvent(this.chain, input, this.hash);
    return this.chain.events[this.chain.events.length - 1];
  }

  all(): readonly AuditEvent[] {
    return this.chain.events;
  }

  head(): string {
    return this.chain.head;
  }

  verify(): ChainVerification {
    return verifyAuditChain(this.chain, this.hash);
  }

  /** Exposure for persistence/serialisation; returns the current chain shape. */
  snapshot(): AuditChain {
    return { events: [...this.chain.events], head: this.chain.head };
  }
}
