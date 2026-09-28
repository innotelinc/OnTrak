/**
 * Security-telemetry rules (M2): fold IDS/IPS, SIEM, EDR and network-sensor
 * alerts into one normalized stream.
 *
 * Every sensor speaks a different dialect, so the desk cannot treat their alerts
 * alike until they are normalized. This module does the three jobs that matter
 * before an alert becomes work, and it does them purely so the ingest service
 * only has to move bytes:
 *
 *  1. **Normalize** a vendor's shape into one canonical `NormalizedSecurityAlert`
 *     (a closed source/severity vocabulary, a parseable timestamp).
 *  2. **Dedupe** repeats under a stable key, so the same IDS hit landing from two
 *     feeds — or the same alert retried by a webhook — folds into one row.
 *  3. **Enrich** the alert from what the desk already knows about its assets and
 *     identities, and roll that into a triage hint.
 *
 * We ingest telemetry; we do not replace the sensor. Nothing here acts on an
 * alert — it classifies, deduplicates and enriches so a human can.
 */

export type SecuritySource = "IDS" | "IPS" | "SIEM" | "EDR" | "NETWORK";
export type SecuritySeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export const SECURITY_SOURCES: readonly SecuritySource[] = ["IDS", "IPS", "SIEM", "EDR", "NETWORK"];
export const SECURITY_SEVERITIES: readonly SecuritySeverity[] = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

/** The vendor-specific shape a connector hands over before normalization. */
export interface RawSecurityAlert {
  /** Product or vendor, e.g. `Snort`, `CrowdStrike Falcon`, `Microsoft Sentinel`. */
  vendor: string;
  /** The vendor's own severity — a word or a number, any casing. */
  severity: string | number;
  /** The detector/signature name; falls back to the description. */
  signature?: string;
  description?: string;
  /** Event time: ISO string, epoch millis, or `Date`. */
  occurredAt: string | number | Date;
  asset?: string | null;
  identity?: string | null;
  sourceIp?: string | null;
  /** The vendor's own alert id, preferred for de-duplication when present. */
  externalId?: string | null;
  /** Where the raw payload is stored. A reference, never the payload itself. */
  rawRef?: string | null;
}

export interface NormalizedSecurityAlert {
  source: SecuritySource;
  severity: SecuritySeverity;
  signature: string;
  description: string;
  occurredAt: string;
  asset: string | null;
  identity: string | null;
  sourceIp: string | null;
  externalId: string | null;
  rawRef: string | null;
  /** Stable de-duplication key: the same alert seen twice shares it. */
  dedupeKey: string;
}

/* -------------------------------------------------------------------------- */
/*  Normalization                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Vendor/product signatures mapped to a source class. Order matters: a product
 * whose name contains another's (SentinelOne vs Microsoft Sentinel) has to be
 * tested first, so the more specific class comes before the broader one.
 */
const SOURCE_PATTERNS: readonly [RegExp, SecuritySource][] = [
  [/\b(?:edr|xdr)\b|crowdstrike|falcon|sentinelone|carbon ?black|cylance|defender|sophos intercept|trend micro apex/i, "EDR"],
  [/\bips\b|intrusion prevention|firepower|fortigate|palo ?alto threat/i, "IPS"],
  [/\bids\b|intrusion detection|snort|suricata|zeek|\bbro\b/i, "IDS"],
  [/\bsiem\b|splunk|microsoft sentinel|\bsentinel\b|qradar|elastic|wazuh|sumo|logrhythm|arcsight|chronicle|exabeam|graylog/i, "SIEM"],
  [/\bnetflow\b|network sensor|network telemetry|firewall|pfsense|ubiquiti|cisco umbrella|dns security/i, "NETWORK"],
];

/** Classify a vendor/product into a source. Unknown vendors default to `SIEM`. */
export function normalizeSource(vendor: string): SecuritySource {
  for (const [pattern, source] of SOURCE_PATTERNS) {
    if (pattern.test(vendor)) return source;
  }
  return "SIEM";
}

/**
 * Severity words, checked before anything numeric. `info`/`debug`/`verbose`
 * are informational rather than low — a debug line is not a low-severity
 * incident, and conflating them skews the triage queue.
 */
const SEVERITY_WORDS: readonly [RegExp, SecuritySeverity][] = [
  [/\b(?:critical|severe|emergency|fatal|catastrophic|urgent)\b/i, "CRITICAL"],
  [/\b(?:high|major|error|danger(?:ous)?)\b/i, "HIGH"],
  [/\b(?:medium|moderate|warning|warn|suspicious)\b/i, "MEDIUM"],
  [/\b(?:low|minor|trivial)\b/i, "LOW"],
  [/\b(?:info(?:rmational)?|notice|debug|verbose|none)\b/i, "INFO"],
];

/**
 * Numbers are interpreted against the two scales vendors actually use: a small
 * level (`0`–`5`, low to high), and a larger score out of 100. The ambiguity is
 * real, so the boundary and the mapping are documented rather than guessed at
 * silently at each call site.
 */
function severityFromNumber(value: number): SecuritySeverity {
  if (value > 5) {
    // A 0–100 score (risk score, percentage confidence).
    if (value >= 80) return "CRITICAL";
    if (value >= 60) return "HIGH";
    if (value >= 40) return "MEDIUM";
    if (value >= 20) return "LOW";
    return "INFO";
  }
  if (value <= 0) return "INFO";
  if (value <= 1) return "LOW";
  if (value <= 3) return "MEDIUM";
  if (value <= 4) return "HIGH";
  return "CRITICAL";
}

/** Normalize a vendor severity (word or number) into the closed vocabulary. */
export function normalizeSeverity(raw: string | number): SecuritySeverity {
  if (typeof raw === "number" && Number.isFinite(raw)) return severityFromNumber(raw);
  const text = String(raw).trim();
  if (text !== "" && Number.isFinite(Number(text))) return severityFromNumber(Number(text));
  for (const [pattern, severity] of SEVERITY_WORDS) {
    if (pattern.test(text)) return severity;
  }
  // An unreadable severity is treated as worth looking at, not ignored.
  return "MEDIUM";
}

/** Parse an alert time to ISO-8601 UTC, refusing an unparseable value. */
export function normalizeOccurredAt(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Unparseable alert timestamp: ${String(value)}`);
  return date.toISOString();
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

/* -------------------------------------------------------------------------- */
/*  De-duplication                                                            */
/* -------------------------------------------------------------------------- */

/** Repeats within this window with the same fingerprint are one alert. */
export const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/** Round a timestamp down to the start of its de-duplication window. */
export function windowStart(iso: string): string {
  const ms = new Date(iso).getTime();
  return new Date(Math.floor(ms / DEDUPE_WINDOW_MS) * DEDUPE_WINDOW_MS).toISOString();
}

/**
 * A stable de-duplication key. The vendor's own id wins when supplied, because
 * it is the only thing guaranteed to identify the same alert across feeds; with
 * no id we fingerprint the detection, the subject and the time window.
 */
export function computeDedupeKey(input: Pick<NormalizedSecurityAlert, "source" | "signature" | "asset" | "identity" | "occurredAt" | "externalId">): string {
  if (input.externalId) return `${input.source}:id:${input.externalId}`;
  const fingerprint = [
    input.source,
    input.signature.trim().toLowerCase(),
    (input.asset ?? "-").toLowerCase(),
    (input.identity ?? "-").toLowerCase(),
    windowStart(input.occurredAt),
  ].join("|");
  return `fp:${fingerprint}`;
}

/* -------------------------------------------------------------------------- */
/*  The pipeline entry point                                                  */
/* -------------------------------------------------------------------------- */

/** Normalize one raw vendor alert into the canonical record. */
export function normalizeAlert(raw: RawSecurityAlert): NormalizedSecurityAlert {
  const occurredAt = normalizeOccurredAt(raw.occurredAt);
  const source = normalizeSource(raw.vendor);
  const signature = trimmedOrNull(raw.signature) ?? trimmedOrNull(raw.description) ?? "unspecified detection";
  const base = {
    source,
    severity: normalizeSeverity(raw.severity),
    signature,
    description: trimmedOrNull(raw.description) ?? signature,
    occurredAt,
    asset: trimmedOrNull(raw.asset),
    identity: trimmedOrNull(raw.identity),
    sourceIp: trimmedOrNull(raw.sourceIp),
    externalId: trimmedOrNull(raw.externalId),
    rawRef: trimmedOrNull(raw.rawRef),
  } satisfies Omit<NormalizedSecurityAlert, "dedupeKey">;
  return { ...base, dedupeKey: computeDedupeKey(base) };
}

/* -------------------------------------------------------------------------- */
/*  Enrichment                                                                */
/* -------------------------------------------------------------------------- */

export type AssetCriticality = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";

/** What the desk knows about an asset an alert names. */
export interface AssetRecord {
  asset: string;
  owner?: string | null;
  clientId?: string | null;
  criticality?: AssetCriticality | null;
}

/** What the desk knows about an identity an alert names. */
export interface IdentityRecord {
  identity: string;
  displayName?: string | null;
  /** Admins and service accounts: an alert on one is worth more attention. */
  privileged?: boolean;
}

export interface EnrichmentContext {
  assets?: readonly AssetRecord[];
  identities?: readonly IdentityRecord[];
}

export interface EnrichedSecurityAlert extends NormalizedSecurityAlert {
  assetKnown: boolean;
  assetOwner: string | null;
  assetCriticality: AssetCriticality | null;
  clientId: string | null;
  identityKnown: boolean;
  identityName: string | null;
  identityPrivileged: boolean;
  /**
   * Severity after enrichment: a detection on a business-critical asset or a
   * privileged identity is raised one step. It is a triage hint, not a
   * re-classification of the sensor's own severity, which is kept untouched.
   */
  triageSeverity: SecuritySeverity;
}

function bump(severity: SecuritySeverity): SecuritySeverity {
  const index = SECURITY_SEVERITIES.indexOf(severity);
  return SECURITY_SEVERITIES[Math.min(index + 1, SECURITY_SEVERITIES.length - 1)];
}

/** Attach what the desk knows about the alert's asset and identity. */
export function enrichAlert(alert: NormalizedSecurityAlert, context: EnrichmentContext = {}): EnrichedSecurityAlert {
  const assetKey = alert.asset?.toLowerCase() ?? null;
  const identityKey = alert.identity?.toLowerCase() ?? null;
  const asset = context.assets?.find((entry) => entry.asset.toLowerCase() === assetKey) ?? null;
  const identity = context.identities?.find((entry) => entry.identity.toLowerCase() === identityKey) ?? null;

  const assetCritical = asset?.criticality === "HIGH" || asset?.criticality === "CRITICAL";
  const privileged = identity?.privileged === true;

  return {
    ...alert,
    assetKnown: asset !== null,
    assetOwner: asset?.owner ?? null,
    assetCriticality: asset?.criticality ?? null,
    clientId: asset?.clientId ?? null,
    identityKnown: identity !== null,
    identityName: identity?.displayName ?? null,
    identityPrivileged: privileged,
    triageSeverity: assetCritical || privileged ? bump(alert.severity) : alert.severity,
  };
}

/* -------------------------------------------------------------------------- */
/*  Coverage & summary                                                        */
/* -------------------------------------------------------------------------- */

/** How an expected detection fared: did the pipeline see it at all? */
export interface DetectionCoverage {
  detection: string;
  covered: boolean;
  alertCount: number;
}

/**
 * Map ingested alerts against the detections a sensor is expected to produce, so
 * a silent detector is visible rather than merely absent from the alert list.
 * A detections list with no matching alerts is reported as uncovered.
 */
export function coverageAgainst(
  alerts: readonly NormalizedSecurityAlert[],
  detections: readonly string[],
): DetectionCoverage[] {
  return detections.map((detection) => {
    const needle = detection.trim().toLowerCase();
    const matches = alerts.filter((alert) => alert.signature.toLowerCase().includes(needle));
    return { detection, covered: matches.length > 0, alertCount: matches.length };
  });
}

export interface AlertSummary {
  total: number;
  bySeverity: Record<SecuritySeverity, number>;
  bySource: Record<SecuritySource, number>;
  uniqueDetections: number;
}

/** A roll-up for a dashboard or a report; pure so it can be recomputed anywhere. */
export function summarizeAlerts(alerts: readonly NormalizedSecurityAlert[]): AlertSummary {
  const bySeverity = Object.fromEntries(SECURITY_SEVERITIES.map((severity) => [severity, 0])) as Record<SecuritySeverity, number>;
  const bySource = Object.fromEntries(SECURITY_SOURCES.map((source) => [source, 0])) as Record<SecuritySource, number>;
  const detections = new Set<string>();
  for (const alert of alerts) {
    bySeverity[alert.severity] += 1;
    bySource[alert.source] += 1;
    detections.add(alert.signature.toLowerCase());
  }
  return { total: alerts.length, bySeverity, bySource, uniqueDetections: detections.size };
}
