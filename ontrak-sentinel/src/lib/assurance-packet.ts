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

import { stableStringify, type AuditEvent, type HashFn } from "./audit-chain";
import type {
  ComplianceControlHistory,
  ComplianceControlView,
  ComplianceRetention,
  ComplianceRoleView,
  ConsoleComplianceView,
} from "./console-rules";

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
  /**
   * The declared evidence-retention window, and what the chain actually holds.
   *
   * Inside the signed record on purpose: "how long is evidence kept?" is one of the
   * questions an auditor asks, and an answer that lives only on a web page is an
   * answer nobody can check a year later.
   */
  retention: ComplianceRetention;
  /**
   * The control changes the evidence chain records, or `null` when the exporter may
   * not read the trail. `null` rather than an empty list: an empty list asserts that
   * nothing changed, which is a claim this exporter cannot make.
   */
  controlHistory: ComplianceControlHistory | null;
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
    retention: input.view.retention,
    controlHistory: input.view.controlHistory,
  };
}

/* -------------------------------------------------------------------------- */
/*  Retention and control history                                            */
/* -------------------------------------------------------------------------- */

/**
 * The retention window a deployment keeps evidence for, when it does not say.
 *
 * A year is the number most audit frameworks ask for and the shortest window that
 * still covers "the incident happened last spring". It is a *declaration*, not a
 * deletion rule: this product never drops chain entries, because a packet whose
 * chain is missing rows cannot be verified.
 */
export const DEFAULT_RETENTION_MONTHS = 12;

/** The env var a deployment sets to declare a different window. */
export const RETENTION_MONTHS_ENV = "SENTINEL_EVIDENCE_RETENTION_MONTHS";

/** Ten years is the longest window this build will believe; beyond it is a typo. */
export const MAX_RETENTION_MONTHS = 120;

/**
 * Read the declared window leniently.
 *
 * An unreadable value does not fail an export — the packet is still a true reading of
 * the posture, and refusing to produce one because a number is malformed would let a
 * typo block an audit response. It falls back to the default and the packet says so,
 * in the signed record, so the fallback is auditable rather than silent.
 */
export function retentionMonths(raw: string | number | null | undefined): { months: number; source: string } {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return { months: DEFAULT_RETENTION_MONTHS, source: "default" };
  }
  const text = typeof raw === "number" ? String(raw) : raw.trim();
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > MAX_RETENTION_MONTHS) {
    return {
      months: DEFAULT_RETENTION_MONTHS,
      source: `default (ignored unreadable ${RETENTION_MONTHS_ENV}=${JSON.stringify(text)})`,
    };
  }
  return { months: value, source: RETENTION_MONTHS_ENV };
}

/**
 * The instant a window of `months` began, counted in calendar months from `asOf`.
 *
 * Month-end is clamped rather than rolled over: a window that starts on the 31st and
 * ends in a 30-day month reaches the 30th, and one ending in February reaches its last
 * day. JavaScript's `setUTCMonth` would slide into the next month instead, which would
 * make a "twelve month" window longer than twelve months once a year.
 */
export function retentionStart(asOf: string, months: number): string {
  const start = new Date(Date.parse(asOf));
  if (!Number.isFinite(start.getTime())) return new Date(0).toISOString();
  const day = start.getUTCDate();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - months);
  const daysInMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(day, daysInMonth));
  return start.toISOString();
}

/**
 * The declared window against what the chain actually holds.
 *
 * The counts are the point: a reader can see that the window is twelve months while
 * the chain reaches back four years, and that the entries before the window are
 * carried rather than trimmed. A product that quietly truncated its own evidence to
 * match a policy number would be destroying the thing the packet exists to prove.
 */
export function retentionWindow(
  events: readonly AuditEvent[],
  choice: { months: number; source: string; asOf: string },
): ComplianceRetention {
  const windowStart = retentionStart(choice.asOf, choice.months);
  const startMs = Date.parse(windowStart);
  const beforeWindow = events.filter((event) => {
    const at = Date.parse(event?.at ?? "");
    return Number.isFinite(at) && at < startMs;
  }).length;
  const oldestAt = events.length > 0 ? events[0]!.at : null;
  const detail =
    `Declared retention window: ${choice.months} month(s) from ${windowStart} ` +
    `(${choice.source}). The chain holds ${events.length} event(s)` +
    (oldestAt ? ` back to ${oldestAt}` : "") +
    `; ${beforeWindow} predate the window and are carried in full rather than truncated.`;

  return {
    months: choice.months,
    windowStart,
    asOf: choice.asOf,
    source: choice.source,
    chainLength: events.length,
    beforeWindow,
    oldestAt,
    detail,
  };
}

/** How far back the packet's control history reaches when nothing else is asked. */
export const CONTROL_HISTORY_MONTHS = 24;

/** The most changes one packet carries, newest kept. */
export const MAX_CONTROL_CHANGES = 200;

/**
 * The control changes in an evidence chain.
 *
 * "Control history" is the audit trail read as *decisions about controls* rather than
 * as a list of everything: the two actions that carry a control's new shape are
 * `policy.update` (one identity-policy scope) and `enforcement.policy` (the Guard
 * rails). Each change's `from` is the previous event's `to` for the same control, so a
 * reader can follow a control across several edits without opening the chain.
 *
 * `unavailable` is for the exporter whose role may not read the trail: the result is
 * then the refusal sentence with `total: null`, never an empty list that would assert
 * nothing ever changed.
 */
export function controlHistoryFrom(
  events: readonly AuditEvent[],
  options: { asOf: string; months?: number; maxChanges?: number; unavailable?: string },
): ComplianceControlHistory | null {
  const months = options.months ?? CONTROL_HISTORY_MONTHS;
  const since = retentionStart(options.asOf, months);
  if (options.unavailable) {
    return { changes: [], total: null, since, truncated: false, detail: options.unavailable };
  }

  const all: Array<{ controlId: string; at: string; from: string | null; to: string; actor: string; ref: string }> = [];
  for (const event of events) {
    const change = controlChangeOf(event);
    if (change) {
      all.push({
        controlId: change.controlId,
        at: event.at,
        from: null,
        to: change.to,
        actor: event.actor,
        ref: `#${event.seq} ${event.recordHash.slice(0, 12)}`,
      });
    }
  }

  const sinceMs = Date.parse(since);
  const inWindow = all.filter((change) => Date.parse(change.at) >= sinceMs);
  const max = options.maxChanges ?? MAX_CONTROL_CHANGES;
  const kept = inWindow.slice(-max);

  // `from` is derived oldest-first, before the window is applied, so the first change a
  // packet carries still says what it replaced even when the edit before it is older.
  const previous = new Map<string, string>();
  for (const change of all) {
    change.from = previous.get(change.controlId) ?? null;
    previous.set(change.controlId, change.to);
  }

  const changes = kept.map((change) => ({
    controlId: change.controlId,
    at: change.at,
    from: change.from,
    to: change.to,
    actor: change.actor,
    ref: change.ref,
  }));
  const truncated = changes.length < all.length;
  // Say *why* rows are missing: a count bound and a time bound leave different things
  // out, and a reader reconciling the packet with the chain needs to know which.
  const bounds: string[] = [];
  if (inWindow.length > max) bounds.push(`bounded to the newest ${max}`);
  if (inWindow.length < all.length) bounds.push(`changes older than ${since} left out`);
  const detail =
    all.length === 0
      ? `No control change is recorded in the chain (looking back ${months} month(s) to ${since}).`
      : `${all.length} control change(s) on record; the packet carries ` +
        `${changes.length} since ${since}` +
        (bounds.length > 0 ? `, ${bounds.join("; ")}.` : ".");

  return { changes, total: all.length, since, truncated, detail };
}

/** One chain event as a control change, or `null` when it is not one. */
function controlChangeOf(event: AuditEvent): { controlId: string; to: string } | null {
  const detail = (event?.detail ?? {}) as Record<string, unknown>;
  if (event?.action === "policy.update") {
    const scope = typeof detail.scope === "string" && detail.scope ? detail.scope : "unknown";
    return {
      controlId: `identity-policy:${scope}`,
      to:
        `second factor ${detail.requireMfa === true ? "required" : "not required"}; ` +
        `session ${minutesOf(detail.maxSessionSeconds)}; idle ${minutesOf(detail.idleTimeoutSeconds)}`,
    };
  }
  if (event?.action === "enforcement.policy") {
    const policy = (detail.policy ?? {}) as Record<string, unknown>;
    const targets = Array.isArray(policy.protectedTargets) ? policy.protectedTargets.length : 0;
    return {
      controlId: "enforcement-rails",
      to:
        `${targets} protected target(s); max ${numberOf(policy.maxTargets)} target(s) per action, ` +
        `${numberOf(policy.maxActionsPerHour)} per hour; ttl ${numberOf(policy.defaultTtlSeconds)}s; ` +
        `permanent ${policy.allowPermanent === true ? "allowed" : "refused"}; ` +
        `second approver ${policy.requireSecondApprover === true ? "required" : "not required"}`,
    };
  }
  return null;
}

function numberOf(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "(unreadable)";
}

function minutesOf(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "(unreadable)";
  if (value % 3600 === 0) return `${value / 3600}h`;
  if (value % 60 === 0) return `${value / 60}m`;
  return `${value}s`;
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
    `retention: ${retentionText(packet)}`,
    `control history: ${historyText(packet)}`,
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

function retentionText(packet: CompliancePacket): string {
  const retention = packet?.retention;
  if (!retention) return "(not stated)";
  return `${asText(retention.months)} month(s) from ${asText(retention.windowStart)}; ${asText(retention.beforeWindow)} event(s) before it`;
}

function historyText(packet: CompliancePacket): string {
  const history = packet?.controlHistory;
  if (!history) return "(not asserted)";
  if (history.total === null) return "(not readable)";
  return `${asText(history.total)} change(s), ${asText(history.changes?.length ?? 0)} carried`;
}

function policiesText(packet: CompliancePacket): string {
  const policies = packet?.policyVersions;
  if (!Array.isArray(policies) || policies.length === 0) return "(none recorded)";
  return policies.map((policy) => `${policy?.key}@${policy?.version}`).join(", ");
}
