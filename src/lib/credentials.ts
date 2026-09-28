/**
 * Completion records and certificates — the training side of the shared
 * evidence model.
 *
 * A completion record is a small, self-describing, tamper-evident statement:
 * *this learner completed this scenario on this date with this outcome.* The
 * digest commits to the record's canonical content, so any later edit is
 * detectable, and a set of records can be bundled into an **assurance packet**
 * for an auditor or insurer.
 *
 * The canonical-JSON + hash approach deliberately mirrors
 * `ontrak-sentinel/src/lib/audit-chain.ts`, so both products emit the same
 * evidence shape. The hash function is injected, keeping this module pure.
 */

/** A synchronous hash of a UTF-8 string, returned as a lower-case hex digest. */
export type HashFn = (input: string) => string;

export const COMPLETION_FORMAT = "ontrak.training.completion/v1";
export const ASSURANCE_PACKET_FORMAT = "ontrak.assurance.packet/v1";

export interface CompletionInput {
  learnerId: string;
  learnerName: string;
  scenarioId: string;
  scenarioTitle: string;
  platform: string;
  passed: boolean;
  score: number;
  maxScore: number;
  /** Whole-percent score, 0–100. */
  percent: number;
  /** Competencies demonstrated, e.g. `["networking", "linux-permissions"]`. */
  skills?: string[];
  /** When the attempt was graded, ISO-8601 UTC. */
  completedAt: string;
  /** Who issued the record (the training deployment / organisation). */
  issuer: string;
}

export interface CompletionRecord extends CompletionInput {
  format: typeof COMPLETION_FORMAT;
  /** Deterministic id derived from the record's content. */
  id: string;
  /** Digest over the canonical record (excluding `id`/`digest`). */
  digest: string;
}

export interface AssurancePacket {
  format: typeof ASSURANCE_PACKET_FORMAT;
  issuer: string;
  generatedAt: string;
  records: CompletionRecord[];
  /** Digest over the packet's canonical content. */
  digest: string;
}

/**
 * Deterministic JSON — object keys sorted, `undefined` dropped, `undefined` in
 * arrays becomes `null`. Identical content always hashes identically.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item ?? null)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function payloadOf(input: CompletionInput): CompletionInput {
  return {
    learnerId: input.learnerId,
    learnerName: input.learnerName,
    scenarioId: input.scenarioId,
    scenarioTitle: input.scenarioTitle,
    platform: input.platform,
    passed: input.passed,
    score: input.score,
    maxScore: input.maxScore,
    percent: input.percent,
    skills: input.skills ?? [],
    completedAt: input.completedAt,
    issuer: input.issuer,
  };
}

export function buildCompletionRecord(input: CompletionInput, hash: HashFn): CompletionRecord {
  const digest = hash(canonicalize(payloadOf(input)));
  return {
    ...payloadOf(input),
    format: COMPLETION_FORMAT,
    id: `crt_${digest.slice(0, 16)}`,
    digest,
  };
}

/** Recompute the digest and compare — `true` means the record is intact. */
export function verifyCompletionRecord(record: CompletionRecord, hash: HashFn): boolean {
  const expected = hash(canonicalize(payloadOf(record)));
  return expected === record.digest && record.format === COMPLETION_FORMAT;
}

/** A short, human-transcribable code derived from the digest. */
export function certificateCode(record: CompletionRecord): string {
  const hex = record.digest.replace(/[^0-9a-f]/gi, "").toUpperCase();
  return `ONTRAK-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

/**
 * Bundle records into a signed packet whose own digest covers every record, so
 * removing or reordering records invalidates the packet.
 */
export function buildAssurancePacket(
  records: readonly CompletionRecord[],
  issuer: string,
  generatedAt: string,
  hash: HashFn,
): AssurancePacket {
  const digest = hash(canonicalize({ issuer, generatedAt, records: [...records] }));
  return { format: ASSURANCE_PACKET_FORMAT, issuer, generatedAt, records: [...records], digest };
}

export function verifyAssurancePacket(packet: AssurancePacket, hash: HashFn): boolean {
  if (packet.format !== ASSURANCE_PACKET_FORMAT) return false;
  if (!packet.records.every((record) => verifyCompletionRecord(record, hash))) return false;
  const expected = hash(
    canonicalize({ issuer: packet.issuer, generatedAt: packet.generatedAt, records: packet.records }),
  );
  return expected === packet.digest;
}
