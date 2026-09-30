/**
 * The compliance assurance packet (S4): the document a reviewer, an auditor or an
 * insurer is handed about a deployment's posture.
 *
 * OnTrak Tix shipped the family's first assurance packet (M3), for an *incident*.
 * This is the second, for a *posture*, and the two are deliberately one format
 * rather than two — which is what Sentinel's roadmap asked for before either product
 * exported anything: "define the shared assurance-packet format with OnTrak Tix".
 * A verifier that has to know which product produced a document is a verifier that
 * gets rewritten for the third product, so the envelope is Tix's — `version`,
 * `algorithm`, a record digest, a content digest, and a signature over the content
 * digest — and only the subject differs.
 *
 * Everything here is pure: the hash and the signer are injected, exactly as the audit
 * chain injects its hash, so a packet can be built, digested and verified in a test,
 * in a route handler, or in a tool that never touches the database.
 *
 * Three hashes appear, and the differences matter:
 *
 *  - `recordHash` fingerprints the **posture** — the controls, the coverage, the
 *    population, the queue and the policy versions. It is stable: two exports of an
 *    unchanged posture carry the same `recordHash` whatever the clock says, which is
 *    how somebody compares an archived packet against a fresh one and can tell a
 *    changed deployment from a later timestamp.
 *  - `contentHash` digests the whole packet, so it covers the audit anchor as well.
 *    It changes as the organization's chain grows, because "where in history was this
 *    cut?" is part of what the packet asserts.
 *  - `signature` is an HMAC over `contentHash`, so nothing in the packet — anchor
 *    included — can be edited without the deployment's key.
 */

import { stableStringify, type HashFn } from "./audit-chain";
import type { ComplianceControlView, ComplianceRoleView, ConsoleComplianceView } from "./console-rules";

/**
 * The shared assurance-packet format version. Kept equal to OnTrak Tix's
 * `ASSURANCE_PACKET_VERSION` on purpose: one number for the family's packet shape, so
 * bumping it is a decision both products make rather than two that drift.
 */
export const ASSURANCE_PACKET_VERSION = "1.0";

/** The one algorithm the family's packets are signed with. */
export const ASSURANCE_ALGORITHM = "HMAC-SHA256";

/**
 * What this packet is about. Tix's carries an incident; this carries a posture, and
 * saying so inside the signed record is what lets one verifier and one archive hold
 * both without guessing from the filename.
 */
export const COMPLIANCE_PACKET_KIND = "sentinel-compliance-posture";

/* -------------------------------------------------------------------------- */
/*  Policies in force                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A policy version the packet says was being followed. Data rather than prose: a
 * reader comparing two packets from different years can see which control set each
 * was measured against.
 */
export interface PolicyVersion {
  key: string;
  version: string;
  effectiveAt: string;
}

export const SENTINEL_POLICIES: readonly PolicyVersion[] = [
  { key: "session-policy", version: "1.0", effectiveAt: "2026-01-01T00:00:00.000Z" },
  { key: "second-factor", version: "1.0", effectiveAt: "2026-01-01T00:00:00.000Z" },
  { key: "evidence-retention", version: "1.0", effectiveAt: "2026-01-01T00:00:00.000Z" },
  { key: "audit-chain", version: "1.0", effectiveAt: "2026-01-01T00:00:00.000Z" },
];

/* -------------------------------------------------------------------------- */
/*  The packet                                                                */
/* -------------------------------------------------------------------------- */

/** Where in the organization's evidence chain the packet was cut. */
export interface CompliancePacketAnchor {
  /** True only when the chain verified at the moment of the export. */
  verified: boolean;
  /** How many events the chain held, or 0 when it could not be read. */
  length: number;
  detail: string;
}

export interface CompliancePacketInput {
  generatedAt: string;
  /** The organization whose posture this is. */
  organization: string;
  /** Who asked for the reading. A posture is taken by somebody. */
  generatedBy: string;
  /** The same view the compliance page renders, so the page and the packet cannot disagree. */
  view: ConsoleComplianceView;
  audit: CompliancePacketAnchor;
  policies?: readonly PolicyVersion[];
}

/**
 * What the packet asserts, minus the anchor — the part that must not move when the
 * clock does. `generatedAt` is deliberately outside it for that reason.
 */
export interface CompliancePacketRecord {
  packet: string;
  version: string;
  organization: string;
  generatedBy: string;
  controls: ComplianceControlView[];
  roles: ComplianceRoleView[];
  identities: ConsoleComplianceView["identities"];
  alerts: ConsoleComplianceView["alerts"];
  chain: ConsoleComplianceView["chain"];
  policies: ConsoleComplianceView["policies"];
  policyVersions: PolicyVersion[];
}

export interface CompliancePacketContent extends CompliancePacketRecord {
  audit: CompliancePacketAnchor;
}

export interface CompliancePacket extends CompliancePacketContent {
  generatedAt: string;
  recordHash: string;
  contentHash: string;
  signature: string;
  algorithm: string;
}

export function packetRecord(input: CompliancePacketInput): CompliancePacketRecord {
  return {
    packet: COMPLIANCE_PACKET_KIND,
    version: ASSURANCE_PACKET_VERSION,
    organization: input.organization,
    generatedBy: input.generatedBy,
    controls: input.view.controls,
    roles: input.view.roles,
    identities: input.view.identities,
    alerts: input.view.alerts,
    chain: input.view.chain,
    policies: input.view.policies,
    policyVersions: [...(input.policies ?? SENTINEL_POLICIES)],
  };
}

/** The whole packet's content: the record plus the audit anchor. */
export function packetContent(input: CompliancePacketInput): CompliancePacketContent {
  return { ...packetRecord(input), audit: input.audit };
}

/** The stable fingerprint of the posture. */
export function packetRecordHash(input: CompliancePacketInput, hash: HashFn): string {
  return hash(stableStringify(packetRecord(input)));
}

/** The digest of a packet's whole content, before it is signed. */
export function packetContentHash(input: CompliancePacketInput, hash: HashFn): string {
  return hash(stableStringify(packetContent(input)));
}

/**
 * Assemble and sign a packet. `sign` receives the content digest, so the signature
 * covers the audit anchor as well as the posture.
 */
export function buildCompliancePacket(
  input: CompliancePacketInput,
  hash: HashFn,
  sign: SignFn,
): CompliancePacket {
  const content = packetContent(input);
  const contentHash = hash(stableStringify(content));
  return {
    ...content,
    generatedAt: input.generatedAt,
    recordHash: packetRecordHash(input, hash),
    contentHash,
    signature: sign(contentHash),
    algorithm: ASSURANCE_ALGORITHM,
  };
}

export type SignFn = (payload: string) => string;

export type VerifyPacketResult = { ok: true; contentHash: string } | { ok: false; reason: string };

/**
 * Verify a packet without the database: recompute both digests from the packet's own
 * contents and check the signature over the content digest. An edit after signing
 * fails the signature check; a hand-rewritten packet fails the digest checks; and a
 * packet whose *record* was altered fails the record check even if somebody
 * recomputed the rest.
 */
export function verifyCompliancePacket(
  packet: CompliancePacket,
  hash: HashFn,
  sign: SignFn,
): VerifyPacketResult {
  const { generatedAt, contentHash, recordHash, signature, algorithm, ...content } = packet;
  void generatedAt;

  if (hash(stableStringify(content)) !== contentHash) {
    return { ok: false, reason: "The packet contents do not match its content hash." };
  }

  const { audit, ...record } = content;
  void audit;
  if (hash(stableStringify(record)) !== recordHash) {
    return { ok: false, reason: "The posture record does not match its record hash." };
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
/*  What the packet says, in words                                            */
/* -------------------------------------------------------------------------- */

/** The posture reduced to its counts, so a reviewer is not the one counting rows. */
export interface PostureSummary {
  failed: number;
  warned: number;
  ok: number;
}

export function postureSummary(packet: CompliancePacket): PostureSummary {
  const controls = Array.isArray(packet?.controls) ? packet.controls : [];
  return {
    failed: controls.filter((control) => control?.state === "FAIL").length,
    warned: controls.filter((control) => control?.state === "WARN").length,
    ok: controls.filter((control) => control?.state === "OK").length,
  };
}

/**
 * A verification reduced to something a person reads. It lives here, beside the
 * rules, so the console, a verification tool and the tests describe a packet the same
 * way — and so the wording of a failure is itself reviewable.
 */
export interface PacketReport {
  ok: boolean;
  headline: string;
  lines: string[];
}

/**
 * Report on a packet that has already been checked. Tolerant of a malformed packet on
 * purpose: the caller holds the verification result either way, and a tool that throws
 * on a hand-edited file is a tool nobody can use on a corrupt one.
 */
export function packetVerificationReport(packet: CompliancePacket, result: VerifyPacketResult): PacketReport {
  const lines = [
    `packet version: ${asText(packet?.version)} (${asText(packet?.packet)})`,
    `organization: ${asText(packet?.organization)}`,
    `record hash: ${asText(packet?.recordHash)}`,
    `content hash: ${asText(packet?.contentHash)}`,
    `signature: ${asText(packet?.signature)} (${asText(packet?.algorithm)})`,
    `audit anchor: ${asText(packet?.audit?.length)} event(s), verified at export: ${asText(packet?.audit?.verified)}`,
    `policies in force: ${policiesText(packet)}`,
    `generated at: ${asText(packet?.generatedAt)} by ${asText(packet?.generatedBy)}`,
  ];

  if (!result.ok) {
    return { ok: false, headline: `FAILED — ${result.reason}`, lines };
  }

  // Intact and clean are two different questions, and the second is the one a
  // reviewer asks next.
  let summary: PostureSummary = { failed: 0, warned: 1, ok: 0 };
  try {
    summary = postureSummary(packet);
  } catch {
    /* a packet with a shape we do not know cannot be counted */
  }

  const headline =
    summary.failed > 0
      ? `VERIFIED — the packet is intact, and ${summary.failed} control(s) read FAIL.`
      : summary.warned > 0
        ? `VERIFIED — the packet is intact, and ${summary.warned} control(s) read WARN.`
        : "VERIFIED — the packet is intact and every control reads OK.";

  return { ok: true, headline, lines };
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "(absent)";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "(unreadable)";
}

function policiesText(packet: CompliancePacket): string {
  const policies = packet?.policyVersions;
  if (!Array.isArray(policies) || policies.length === 0) return "(none recorded)";
  return policies.map((policy) => `${policy?.key}@${policy?.version}`).join(", ");
}
