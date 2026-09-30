/**
 * Tenant audit-evidence export (M6): the whole hash-chained trail, as one signed
 * document an auditor can take away.
 *
 * M3 shipped the *incident* packet — an excerpt of the chain, anchored at the head,
 * bundled with one incident's evidence. M6's exit criterion asks for something
 * different and this is it: "audit evidence exports on demand", meaning the trail
 * itself, tenant-wide, not a slice of it attached to a ticket. The two are the same
 * envelope on purpose, because they are checked by the same verifier and read by the
 * same kind of person:
 *
 *  - `recordHash` fingerprints the **chain contents** — the entries and the policy
 *    versions. It is stable, so two exports of an unchanged trail agree whatever the
 *    clock says, which is what lets an auditor compare the copy they were handed last
 *    quarter with the one they are handed now and see that nothing was rewritten.
 *  - `contentHash` digests the record *and* the anchor, because "which head was this
 *    cut at, and did the chain verify then?" is part of what the document asserts.
 *  - `signature` is an HMAC over `contentHash`, so an entry cannot be dropped or
 *    edited — nor the anchor moved — without the deployment's key.
 *
 * Two things are stated rather than implied:
 *
 *  - **The chain is the record here, not an excerpt.** The incident packet carries
 *    the chain slice that names the incident; this one *is* the chain, so its anchor
 *    has no separate excerpt to point at.
 *  - **An unverified chain still exports, and says so.** Refusing to export a broken
 *    trail would be the worst possible moment to withhold the evidence: the document a
 *    reviewer most needs is the one that shows the break, with `verified: false` and a
 *    digest over exactly the bytes that were read. What must never happen is a broken
 *    chain exported as though it verified, which is why the flag is inside the signed
 *    anchor rather than beside it.
 */

import { stableStringify, type HashFn } from "./audit-chain";
import {
  ASSURANCE_ALGORITHM,
  ASSURANCE_PACKET_VERSION,
  ASSURANCE_POLICIES,
  verifyAssurancePacket,
  type PacketAuditEntry,
  type PolicyVersion,
  type SignFn,
  type VerifyPacketResult,
} from "./assurance-rules";

/**
 * Which kind of packet this is. The incident packet is recognised by its `incident`
 * field; saying it out loud here means one verifier, one archive and one reader can
 * tell the two documents apart without guessing from a filename.
 */
export const AUDIT_EXPORT_KIND = "ontrak-tix-audit-chain";

/** Where in the chain the export was cut. */
export interface AuditChainAnchor {
  /** The hash of the last entry, which the export commits to. */
  head: string;
  /** How many entries were read. */
  length: number;
  /** Whether the chain verified *at the moment of the export*. */
  verified: boolean;
  /** The seq this export's own audit event will occupy, one past the head. */
  exportSeq: number;
}

export interface AuditChainPacketInput {
  tenantId: string;
  /** Every entry, oldest first, exactly as stored. */
  entries: PacketAuditEntry[];
  audit: AuditChainAnchor;
  policies?: readonly PolicyVersion[];
  generatedAt: string;
}

/** What the packet asserts, minus the anchor: the part that must not move with the clock. */
export interface AuditChainRecordContent {
  kind: string;
  version: string;
  tenantId: string;
  entries: PacketAuditEntry[];
  policies: PolicyVersion[];
}

export interface AuditChainPacketContent extends AuditChainRecordContent {
  audit: AuditChainAnchor;
}

export interface AuditChainPacket extends AuditChainPacketContent {
  /** When this copy was produced. Reported, never committed to. */
  generatedAt: string;
  recordHash: string;
  contentHash: string;
  signature: string;
  algorithm: string;
}

export function auditRecordContent(input: AuditChainPacketInput): AuditChainRecordContent {
  return {
    kind: AUDIT_EXPORT_KIND,
    version: ASSURANCE_PACKET_VERSION,
    tenantId: input.tenantId,
    entries: input.entries,
    policies: [...(input.policies ?? ASSURANCE_POLICIES)],
  };
}

/** The canonical bytes the signature commits to: the record, plus the anchor. */
export function auditPacketContent(input: AuditChainPacketInput): AuditChainPacketContent {
  return { ...auditRecordContent(input), audit: input.audit };
}

export function buildAuditChainPacket(
  input: AuditChainPacketInput,
  hash: HashFn,
  sign: SignFn,
): AuditChainPacket {
  const content = auditPacketContent(input);
  const contentHash = hash(stableStringify(content));
  return {
    ...content,
    generatedAt: input.generatedAt,
    recordHash: hash(stableStringify(auditRecordContent(input))),
    contentHash,
    signature: sign(contentHash),
    algorithm: ASSURANCE_ALGORITHM,
  };
}

/**
 * Verify an audit export with the *incident* packet's verifier — which is the point
 * of sharing the envelope: one implementation, so the two kinds cannot disagree about
 * what a valid signature is.
 */
export function verifyAuditChainPacket(
  packet: AuditChainPacket,
  hash: HashFn,
  sign: SignFn,
): VerifyPacketResult {
  return verifyAssurancePacket(packet, hash, sign);
}

export interface AuditExportReport {
  ok: boolean;
  headline: string;
  lines: string[];
}

/**
 * The readable summary, for the same reason M3's report exists: a verifier that prints
 * nothing but "true" is one somebody has to take on faith.
 */
export function auditExportReport(packet: AuditChainPacket, result: VerifyPacketResult): AuditExportReport {
  const entries = Array.isArray(packet?.entries) ? packet.entries : [];
  const first = entries[0]?.seq;
  const last = entries[entries.length - 1]?.seq;
  const actors = new Set(entries.map((entry) => entry?.actor).filter(Boolean));

  const lines = [
    `packet kind: ${asText(packet?.kind)} v${asText(packet?.version)}`,
    `tenant: ${asText(packet?.tenantId)}`,
    `entries: ${entries.length}${entries.length > 0 ? ` (seq ${asText(first)} … ${asText(last)})` : ""}`,
    `distinct actors: ${actors.size}`,
    `chain head: ${asText(packet?.audit?.head)}`,
    `verified at export: ${asText(packet?.audit?.verified)}`,
    `record hash: ${asText(packet?.recordHash)}`,
    `content hash: ${asText(packet?.contentHash)}`,
    `signature: ${asText(packet?.signature)} (${asText(packet?.algorithm)})`,
    `exported at: ${asText(packet?.generatedAt)}`,
  ];

  if (!result.ok) {
    return { ok: false, headline: `FAILED — ${result.reason}`, lines };
  }

  // Intact and trustworthy are different questions. A packet can verify perfectly and
  // still report a trail that did not, and that is the answer a reviewer needs first.
  const headline = packet?.audit?.verified
    ? `VERIFIED — the packet is intact and the trail verified when it was taken (${entries.length} entries).`
    : `VERIFIED — the packet is intact, but the trail did NOT verify when it was taken.`;

  return { ok: true, headline, lines };
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "(absent)";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "(unreadable)";
}
