/**
 * Vendor telemetry connectors (M2): the seam that hands a vendor's alert to the
 * `SecurityAlertService`.
 *
 * The rules module already knows how to fold a `RawSecurityAlert` into the
 * canonical stream. What changes with a deployment is *how* an alert arrives: a
 * sensor or SIEM that POSTs JSON at us, or an API we poll on a timer. Both
 * converge here on one shape — `VendorAlertDelivery` — so the normalizing rules,
 * the dedupe ledger and the audit trail never learn which transport delivered
 * the alert.
 *
 * Two transports ship, mirroring the email intake:
 *   - `SecurityAlertConnector` parses one vendor payload and feeds the service
 *     once (the webhook path).
 *   - `VendorAlertPoller` drains an `AlertSource` (a vendor API, a queue, a fake)
 *     and acknowledges each alert only after the service has taken it, so a
 *     crash mid-batch leaves the unprocessed alerts unseen rather than lost.
 *
 * The `dedupeKey` is the real idempotency guard; acknowledgement is a throughput
 * optimisation, not the correctness boundary. A payload that is not a security
 * alert returns `null`, so a route can answer 400 without side effects.
 */

import { normalizeOccurredAt, type RawSecurityAlert } from "./security-alert-rules";
import type { IngestResult, SecurityAlertService } from "./security-alert-service";

/** The outcome of feeding one alert to the ingest service. */
export type AlertOutcome =
  | { kind: "created"; alertId: string; source: string; severity: string; occurrences: number }
  | { kind: "duplicate"; alertId: string; occurrences: number }
  | { kind: "failed"; error: string };

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text !== undefined && text.trim() !== "") return text;
  }
  return undefined;
}

/**
 * Turn a vendor webhook body into the rules module's `RawSecurityAlert`.
 *
 * Vendors disagree on field names, so the common aliases are accepted rather
 * than forcing one vendor's shape. A payload with no identifiable vendor or no
 * parseable time is not an alert we can dedupe or place, and returns `null` so
 * the caller can reject it instead of writing a junk row. A missing severity
 * defaults to `MEDIUM` — visible, never dropped.
 */
export function parseVendorAlert(body: unknown): RawSecurityAlert | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;

  const vendor = firstString(raw.vendor, raw.product, raw.detector, raw.sensor, raw.integration, raw.source);
  const occurredAt = firstString(raw.occurredAt, raw.timestamp, raw.time, raw.eventTime, raw.event_time, raw.date, raw.createdAt, raw.ts);
  if (!vendor || !occurredAt) return null;

  // A payload is only an alert if it names a detection or describes one.
  const signature = firstString(raw.signature, raw.rule, raw.ruleName, raw.detection, raw.alert, raw.name, raw.title);
  const description = firstString(raw.description, raw.message, raw.detail, raw.summary, raw.text, raw.note);
  if (!signature && !description) return null;

  const severity = raw.severity ?? raw.priority ?? raw.level ?? raw.riskScore ?? raw.score ?? "MEDIUM";

  try {
    // Validate the timestamp here so a bad time is a rejected payload, not a
    // half-ingested row.
    normalizeOccurredAt(occurredAt);
  } catch {
    return null;
  }

  return {
    vendor,
    severity: typeof severity === "number" ? severity : String(severity),
    signature,
    description,
    occurredAt,
    asset: firstString(raw.asset, raw.host, raw.hostname, raw.device, raw.endpoint, raw.machine) ?? null,
    identity: firstString(raw.identity, raw.user, raw.username, raw.userName, raw.account, raw.principal, raw.subject) ?? null,
    sourceIp: firstString(raw.sourceIp, raw.source_ip, raw.srcIp, raw.src_ip, raw.sourceAddress, raw.ip) ?? null,
    externalId: firstString(raw.externalId, raw.external_id, raw.alertId, raw.alert_id, raw.eventId, raw.event_id, raw.id, raw.uuid) ?? null,
    rawRef: firstString(raw.rawRef, raw.raw_ref, raw.rawUrl, raw.url, raw.link) ?? null,
  };
}

/** Feeds vendor payloads to the ingest service for one tenant. */
export class SecurityAlertConnector {
  constructor(
    private readonly service: Pick<SecurityAlertService, "ingest">,
    private readonly tenantId: string,
  ) {}

  /**
   * Returns the ingest outcome, or `null` when the payload was never a
   * recognizable alert (so the caller can reject it without side effects).
   */
  async receive(body: unknown): Promise<AlertOutcome | null> {
    const alert = parseVendorAlert(body);
    if (!alert) return null;

    let result: IngestResult;
    try {
      result = await this.service.ingest(this.tenantId, alert);
    } catch (error) {
      return { kind: "failed", error: error instanceof Error ? error.message : "Unexpected ingest failure." };
    }

    if (result.duplicate) {
      return { kind: "duplicate", alertId: result.alert.id, occurrences: result.alert.occurrences };
    }
    return {
      kind: "created",
      alertId: result.alert.id,
      source: result.alert.source,
      severity: result.alert.severity,
      occurrences: result.alert.occurrences,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Polling                                                                   */
/* -------------------------------------------------------------------------- */

/** One alert as a vendor API, a queue or a fake hands it over. */
export interface VendorAlertDelivery {
  /** Vendor- or queue-assigned id, so the alert can be acknowledged. */
  id: string;
  payload: unknown;
}

/** Where alerts come from. A real vendor API client or a fake implements this. */
export interface AlertSource {
  /** Unseen alerts, oldest first. */
  fetchUnseen(limit?: number): Promise<VendorAlertDelivery[]>;
  /** Mark an alert as taken so it is not delivered twice. */
  acknowledge(id: string): Promise<void>;
}

export interface PolledAlertOutcome {
  id: string;
  outcome: AlertOutcome | null;
}

export interface AlertPollResult {
  outcomes: PolledAlertOutcome[];
  /** Alerts the service could not take; left unseen for the next poll. */
  deferred: number;
}

/**
 * Drain an alert source through the connector.
 *
 * A created or duplicate alert is acknowledged. A `failed` outcome is *not* —
 * nothing was recorded, so leaving it unseen lets the next poll retry it, and
 * the dedupe key makes that retry safe. A payload that was never an alert is
 * acknowledged: retrying it would fail identically forever.
 */
export class VendorAlertPoller {
  constructor(
    private readonly connector: SecurityAlertConnector,
    private readonly source: AlertSource,
  ) {}

  async poll(limit = 25): Promise<AlertPollResult> {
    const deliveries = await this.source.fetchUnseen(limit);
    const outcomes: PolledAlertOutcome[] = [];
    let deferred = 0;

    for (const delivery of deliveries) {
      const outcome = await this.connector.receive(delivery.payload);
      outcomes.push({ id: delivery.id, outcome });
      if (outcome?.kind === "failed") {
        deferred += 1;
        continue;
      }
      await this.source.acknowledge(delivery.id);
    }

    return { outcomes, deferred };
  }
}

/* -------------------------------------------------------------------------- */
/*  HTTP policy                                                               */
/* -------------------------------------------------------------------------- */

export interface ConnectorReply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Map an ingest outcome onto an HTTP reply.
 *
 * `null` means the payload was never an alert: 400, and nothing happened.
 * `created` is a 202 (accepted), `duplicate` a 200 (idempotent redelivery), and
 * `failed` a 500 so the sender retries — the dedupe key makes the retry safe.
 */
export function connectorReply(outcome: AlertOutcome | null): ConnectorReply {
  if (!outcome) return { status: 400, body: { error: "Payload was not a recognizable security alert." } };

  switch (outcome.kind) {
    case "failed":
      return { status: 500, body: { error: outcome.error } };
    case "duplicate":
      return { status: 200, body: { status: "duplicate", alertId: outcome.alertId, occurrences: outcome.occurrences } };
    case "created":
      return {
        status: 202,
        body: { status: "created", alertId: outcome.alertId, source: outcome.source, severity: outcome.severity },
      };
  }
}

/* -------------------------------------------------------------------------- */
/*  In-memory source (tests and local work)                                   */
/* -------------------------------------------------------------------------- */

/** An in-memory alert source whose "unseen" set is emptied by acknowledgement. */
export class MemoryAlertSource implements AlertSource {
  private readonly deliveries = new Map<string, VendorAlertDelivery>();

  /** Queue a payload; returns the id so a test can assert on it. */
  add(payload: unknown, id?: string): string {
    const assigned = id ?? `a_${this.deliveries.size + 1}`;
    this.deliveries.set(assigned, { id: assigned, payload });
    return assigned;
  }

  /** How many alerts are still unseen. */
  get size(): number {
    return this.deliveries.size;
  }

  async fetchUnseen(limit = 25): Promise<VendorAlertDelivery[]> {
    return [...this.deliveries.values()].slice(0, limit).map((delivery) => ({ ...delivery }));
  }

  async acknowledge(id: string): Promise<void> {
    this.deliveries.delete(id);
  }
}

/* -------------------------------------------------------------------------- */
/*  HTTP source (a vendor API we poll)                                        */
/* -------------------------------------------------------------------------- */

/** The environment keys a polled vendor alert source is configured from. */
export const ALERT_SOURCE_URL_ENV = "ONTRAK_TIX_ALERT_SOURCE_URL";
export const ALERT_SOURCE_TOKEN_ENV = "ONTRAK_TIX_ALERT_SOURCE_TOKEN";
export const ALERT_SOURCE_ACK_URL_ENV = "ONTRAK_TIX_ALERT_SOURCE_ACK_URL";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function firstId(entry: Record<string, unknown>, index: number): string {
  const id = entry.id ?? entry.alertId ?? entry.eventId ?? entry.externalId;
  return typeof id === "string" && id.trim() !== "" ? id : `idx-${index}`;
}

/**
 * Read a vendor list response into deliveries. Vendors wrap their list
 * differently (`alerts`, `items`, `data`, or a bare array) and sometimes wrap
 * each alert in an envelope with its own id, so both shapes are accepted. A
 * non-list payload is an empty batch rather than an error — the poll then simply
 * has nothing to do.
 */
export function toAlertDeliveries(body: unknown): VendorAlertDelivery[] {
  const candidate =
    Array.isArray(body)
      ? body
      : typeof body === "object" && body !== null
        ? ((body as Record<string, unknown>).alerts ?? (body as Record<string, unknown>).items ?? (body as Record<string, unknown>).data)
        : null;
  if (!Array.isArray(candidate)) return [];

  return candidate
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry, index) => ("payload" in entry ? { id: firstId(entry, index), payload: entry.payload } : { id: firstId(entry, index), payload: entry }));
}

/**
 * An `AlertSource` over a vendor's HTTP API: list pending alerts, then
 * acknowledge the ones that were taken.
 *
 * The acknowledgement URL is a template with `<id>` in it, because vendors
 * disagree about whether an acknowledgement is a `POST /ack` or a `DELETE`. A
 * source with no acknowledgement URL is read-only — the service's dedupe key
 * still makes a re-read safe, so nothing is lost, it is just fetched twice.
 */
export class HttpAlertSource implements AlertSource {
  constructor(
    private readonly config: {
      url: string;
      token?: string | null;
      ackUrl?: string | null;
      fetchImpl?: FetchLike;
    },
  ) {}

  private headers(): Record<string, string> {
    return {
      accept: "application/json",
      ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
    };
  }

  private fetcher(): FetchLike {
    return this.config.fetchImpl ?? fetch;
  }

  async fetchUnseen(limit = 25): Promise<VendorAlertDelivery[]> {
    const url = new URL(this.config.url);
    url.searchParams.set("limit", String(limit));
    const response = await this.fetcher()(url, { headers: this.headers() });
    if (!response.ok) throw new Error(`The alert source answered ${response.status}.`);
    return toAlertDeliveries(await response.json());
  }

  async acknowledge(id: string): Promise<void> {
    const ackUrl = this.config.ackUrl;
    if (!ackUrl) return;
    const response = await this.fetcher()(ackUrl.replace("<id>", encodeURIComponent(id)), {
      method: "POST",
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`The alert source acknowledgement answered ${response.status}.`);
  }
}

/** The source config read from the environment, or `null` when none is set. */
export function alertSourceConfigFromEnv(env: Record<string, string | undefined> = process.env): {
  url: string;
  token: string | null;
  ackUrl: string | null;
} | null {
  const url = env[ALERT_SOURCE_URL_ENV]?.trim();
  if (!url) return null;
  return { url, token: env[ALERT_SOURCE_TOKEN_ENV]?.trim() || null, ackUrl: env[ALERT_SOURCE_ACK_URL_ENV]?.trim() || null };
}
