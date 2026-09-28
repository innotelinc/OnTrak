/**
 * Assurance Packet rules (M3): the one document an insurer or an auditor is
 * handed, assembled from the record the system already keeps.
 *
 * Everything in this module is pure — the hash and the signer are injected, the
 * way the audit chain injects its hash — so a packet can be built, digested and
 * verified in a test, in a route handler, or in a verification tool that never
 * touches the database.
 *
 * The packet is deliberately *not* a renderer's summary. It bundles:
 *
 *  - the incident's facts and its lifecycle (severity, phase, roles, inputs);
 *  - the playbook plan and what actually happened to each step;
 *  - the evidence manifest, digest included — so the packet commits to the same
 *    bytes the manifest route would hand out;
 *  - the chain of custody and any legal hold, because "who held this and why"
 *    is a question an adjuster asks;
 *  - the append-only timeline;
 *  - an excerpt of the tenant's hash-chained audit log for this incident, the
 *    chain head it was read at, and that head's verification result;
 *  - the policy versions in force at the time.
 *
 * Three hashes appear, and the differences matter:
 *
 *  - `recordHash` is a fingerprint of the **incident record** — the facts, the
 *    playbook, the evidence, the custody trail, the hold, the timeline and the
 *    policies. It is stable: export an unchanged record today and next year and
 *    the two packets carry the same `recordHash`, which is how someone compares
 *    an archived packet against a fresh one.
 *  - `contentHash` is a digest of the whole packet, so it also covers the audit
 *    anchor. It changes as the tenant's chain grows, because "where in history
 *    was this cut?" is part of what this packet is.
 *  - `signature` is an HMAC over `contentHash`, using the deployment's key, so
 *    nothing in the packet can be edited — anchor included — without the key.
 */

import { stableStringify, type HashFn } from "./audit-chain";
import type { CustodyEntry, EvidenceManifest, LegalHold } from "./evidence-rules";

/** Bumped when the packet's shape changes, so an archived packet stays readable. */
export const ASSURANCE_PACKET_VERSION = "1.0";

export const ASSURANCE_ALGORITHM = "HMAC-SHA256";

/* -------------------------------------------------------------------------- */
/*  Policies in force                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The policy versions the packet says were being followed. They are data, not
 * prose: a reader comparing two packets from different years can see which
 * response and retention policy each was measured against.
 */
export interface PolicyVersion {
  key: string;
  version: string;
  effectiveAt: string;
}

export const ASSURANCE_POLICIES: readonly PolicyVersion[] = [
  { key: "incident-response", version: "1.0", effectiveAt: "2026-01-01T00:00:00.000Z" },
  { key: "evidence-retention", version: "1.0", effectiveAt: "2026-01-01T00:00:00.000Z" },
  { key: "audit-chain", version: "1.0", effectiveAt: "2026-01-01T00:00:00.000Z" },
];

/* -------------------------------------------------------------------------- */
/*  Audit reference                                                           */
/* -------------------------------------------------------------------------- */

/** One audit record, as it appears in the packet (no payload detail). */
export interface PacketAuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  recordHash: string;
}

/**
 * The state of the tenant's audit chain the packet was assembled against. The
 * excerpt is filtered to this incident, but `head` commits to the *whole* chain,
 * so the packet is anchored to a verifiable chain position rather than to a
 * convenient subset of it.
 */
export interface PacketAuditRef {
  head: string;
  length: number;
  /** Whether the chain verified when the packet was built. */
  verified: boolean;
  /** The seq the packet's own export event will occupy, one past the head. */
  exportSeq: number;
  excerpt: PacketAuditEntry[];
}

/* -------------------------------------------------------------------------- */
/*  The packet                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What an export needs: the evidence manifest (which already holds the incident,
 * the playbook, the evidence, the custody trail, the legal hold and the
 * timeline), the audit anchor, and when the copy was produced.
 *
 * Taking the record from *one* place matters — a packet that reassembled these
 * pieces from separate arguments could disagree with the manifest it cites.
 */
export interface AssurancePacketInput {
  manifest: EvidenceManifest;
  audit: PacketAuditRef;
  policies?: readonly PolicyVersion[];
  generatedAt: string;
}

/** The incident record itself, as the packet states it. */
export interface AssuranceRecordContent {
  version: string;
  incident: EvidenceManifest["incident"];
  playbook: EvidenceManifest["steps"];
  evidence: EvidenceManifest["evidence"];
  /** The manifest digest, so the packet and the manifest route agree. */
  evidenceManifestHash: string;
  custody: CustodyEntry[];
  legalHold: LegalHold | null;
  timeline: EvidenceManifest["timeline"];
  policies: PolicyVersion[];
}

/** Everything the signature commits to: the record, plus where it was cut. */
export interface AssurancePacketContent extends AssuranceRecordContent {
  audit: PacketAuditRef;
}

export interface AssurancePacket extends AssurancePacketContent {
  /** When this copy was produced. Reported, never committed to. */
  generatedAt: string;
  /** Stable fingerprint of the incident record; unchanged while the record is. */
  recordHash: string;
  /** Digest of the whole packet, audit anchor included. */
  contentHash: string;
  signature: string;
  algorithm: string;
}

/**
 * The canonical bytes of the incident record. `buildAssurancePacket` and
 * `verifyAssurancePacket` both call this, so a digest can never be computed over
 * one shape and verified against another.
 */
export function packetRecord(input: AssurancePacketInput): AssuranceRecordContent {
  return {
    version: ASSURANCE_PACKET_VERSION,
    incident: input.manifest.incident,
    playbook: input.manifest.steps,
    evidence: input.manifest.evidence,
    evidenceManifestHash: input.manifest.manifestHash,
    custody: input.manifest.custody,
    legalHold: input.manifest.legalHold,
    timeline: input.manifest.timeline,
    policies: [...(input.policies ?? ASSURANCE_POLICIES)],
  };
}

/** The whole packet's content: the record plus the audit anchor. */
export function packetContent(input: AssurancePacketInput): AssurancePacketContent {
  return { ...packetRecord(input), audit: input.audit };
}

/** The stable fingerprint of the incident record. */
export function packetRecordHash(input: AssurancePacketInput, hash: HashFn): string {
  return hash(stableStringify(packetRecord(input)));
}

/** The digest of a packet's whole content, before it is signed. */
export function packetContentHash(input: AssurancePacketInput, hash: HashFn): string {
  return hash(stableStringify(packetContent(input)));
}

/**
 * Assemble and sign a packet. `sign` receives the content digest, so the
 * signature covers the audit anchor as well as the record.
 */
export function buildAssurancePacket(input: AssurancePacketInput, hash: HashFn, sign: SignFn): AssurancePacket {
  const content = packetContent(input);
  const contentHash = hash(stableStringify(content));
  return {
    ...content,
    generatedAt: input.generatedAt,
    recordHash: hash(stableStringify(packetRecord(input))),
    contentHash,
    signature: sign(contentHash),
    algorithm: ASSURANCE_ALGORITHM,
  };
}

export type SignFn = (payload: string) => string;

export type VerifyPacketResult = { ok: true; contentHash: string } | { ok: false; reason: string };

/**
 * Verify a packet without the database: recompute both digests from the packet's
 * own contents and check the signature over the content digest. An edit after
 * signing fails the signature check; a hand-rewritten packet fails the digest
 * checks; and a packet whose *record* was altered fails the record check even if
 * someone recomputed the rest.
 */
export function verifyAssurancePacket(packet: AssurancePacket, hash: HashFn, sign: SignFn): VerifyPacketResult {
  const { generatedAt, contentHash, recordHash, signature, algorithm, ...content } = packet;
  void generatedAt;

  const recomputed = hash(stableStringify(content));
  if (recomputed !== contentHash) {
    return { ok: false, reason: "The packet contents do not match its content hash." };
  }

  const { audit, ...record } = content;
  void audit;
  if (hash(stableStringify(record)) !== recordHash) {
    return { ok: false, reason: "The incident record does not match its record hash." };
  }

  if (algorithm !== ASSURANCE_ALGORITHM) {
    return { ok: false, reason: `Unknown signature algorithm "${algorithm}".` };
  }
  if (sign(contentHash) !== signature) {
    return { ok: false, reason: "The signature does not match this deployment's key." };
  }
  return { ok: true, contentHash };
}

/* -------------------------------------------------------------------------- */
/*  Completeness                                                              */
/* -------------------------------------------------------------------------- */

export interface PacketCompleteness {
  complete: boolean;
  /** What is missing, in the order a reviewer would care about it. */
  missing: string[];
}

/**
 * Whether a packet would stand on its own: a reviewed incident with a finished
 * playbook, at least one piece of evidence and its custody trail, and a verified
 * audit excerpt. This is the number the roadmap wants to report — *the share of
 * incidents with a complete evidence packet* — so it is a rule, not a guess.
 */
/* -------------------------------------------------------------------------- */
/*  The report a verification tool prints                                      */
/* -------------------------------------------------------------------------- */

/**
 * A verification reduced to something a person reads. It is here, next to the
 * rules, so the CLI, the HTTP verifier and the tests all report a packet the
 * same way — and so the wording of a failure is itself reviewable.
 */
export interface PacketReport {
  ok: boolean;
  headline: string;
  lines: string[];
  /** What is still missing from the record, when the packet parsed. */
  missing: string[];
}

/**
 * Report on a packet that has already been checked. Tolerant of a malformed
 * packet on purpose: the caller has the verification result either way, and a
 * tool that throws on a hand-edited file is a tool nobody can use on a corrupt
 * one.
 */
export function packetVerificationReport(packet: AssurancePacket, result: VerifyPacketResult): PacketReport {
  const incident = packet?.incident as { ref?: unknown; title?: unknown; severity?: unknown; phase?: unknown } | undefined;
  const ref = typeof incident?.ref === "string" ? incident.ref : "(unidentified incident)";

  const lines = [
    `packet version: ${asText(packet?.version)}`,
    `incident: ${ref}${typeof incident?.title === "string" ? ` — ${incident.title}` : ""}`,
    `severity / phase: ${asText(incident?.severity)} / ${asText(incident?.phase)}`,
    `record hash: ${asText(packet?.recordHash)}`,
    `content hash: ${asText(packet?.contentHash)}`,
    `signature: ${asText(packet?.signature)} (${asText(packet?.algorithm)})`,
    `audit anchor: seq ${asText(packet?.audit?.exportSeq)} after a chain of ${asText(packet?.audit?.length)} (verified at export: ${asText(packet?.audit?.verified)})`,
    `policies in force: ${policiesText(packet)}`,
    `exported at: ${asText(packet?.generatedAt)}`,
  ];

  if (!result.ok) {
    return { ok: false, headline: `FAILED — ${result.reason}`, lines, missing: [] };
  }

  // A packet that verifies is intact; whether it is *complete* is a different
  // question, and the one a reviewer actually asks next.
  let completeness: PacketCompleteness = { complete: false, missing: ["the packet could not be read"] };
  try {
    completeness = packetCompleteness(packet);
  } catch {
    /* a packet with a shape we do not know cannot be judged for completeness */
  }

  return {
    ok: true,
    headline: completeness.complete
      ? "VERIFIED — the packet is intact and the record is complete."
      : `VERIFIED — the packet is intact, and ${completeness.missing.length} thing(s) are still missing from the record.`,
    lines,
    missing: completeness.missing,
  };
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "(absent)";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "(unreadable)";
}

function policiesText(packet: AssurancePacket): string {
  const policies = packet?.policies;
  if (!Array.isArray(policies) || policies.length === 0) return "(none recorded)";
  return policies.map((policy) => `${policy?.key}@${policy?.version}`).join(", ");
}

export function packetCompleteness(packet: AssurancePacket): PacketCompleteness {
  const missing: string[] = [];
  if (packet.incident.phase !== "REVIEWED") missing.push("the incident has not been reviewed");
  if (packet.playbook.some((step) => step.status === "PENDING")) missing.push("the playbook still has open steps");
  if (packet.evidence.length === 0) missing.push("no evidence was collected");
  if (packet.custody.length === 0) missing.push("the evidence has no chain of custody");
  if (packet.timeline.length === 0) missing.push("the timeline is empty");
  if (!packet.audit.verified) missing.push("the audit chain did not verify");
  return { complete: missing.length === 0, missing };
}
