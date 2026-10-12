/**
 * The OnTrak Tix transport (S5): a raised alert, delivered to the desk.
 *
 * The delivery seam (`alert-notify.ts`) exists so a deployment writes its own adapter for its
 * own pager, chat or ticket intake, and it says so in as many words: "a vendor-specific
 * integration in this repository would be a pager pretending to be a seam." Tix is not a
 * vendor. It is the other half of this product's own family — the desk an alert becomes a
 * ticket in — and the reason this adapter ships here is that the *contract* has to have one
 * definition: if Tix's parser and Sentinel's sender are written independently, they disagree
 * the first time either changes, and the failure is a silent 400 on a webhook nobody reads.
 *
 * What travels is still the alert's summary rather than its evidence — that property is the
 * seam's and this module does not weaken it. What it *adds* is the two facts the desk needs
 * and the summary alone does not carry:
 *
 *  - **The corpus the alert was judged by** (`rulebookVersion`), so a ticket opened today is
 *    still explicable in six months when the rule that fired has been through three versions.
 *  - **The rule's ATT&CK techniques and its own description**, derived from the rulebook this
 *    deployment is running rather than from the notification — so a desk can group, filter and
 *    report on technique, which is what makes an alert list a picture of an intrusion.
 *
 * And it is **signed**. The bearer token that authenticates the ingest is a shared secret;
 * the HMAC over `timestamp.body` is what makes a captured delivery unusable an hour later, so
 * a relay that logs request bodies (they all do) is not a replayable copy of the desk's own
 * security feed. Tix verifies it, with a bounded clock skew, whenever
 * `ONTRAK_TIX_SENTINEL_SIGNING_SECRET` is set there.
 *
 * Like every transport on this seam: it never throws, it answers with an outcome, and a
 * refusal is recorded on the chain rather than swallowed.
 */

import { createHmac } from "node:crypto";

import { attackReferences } from "./attack-rules";
import { alertNotification, type AlertNotification, type AlertNotifier, type NotifyOutcome } from "./alert-notify";
import { rulebookVersion, DETECTION_RULES, type DetectionRule } from "./detection-rules";
import type { AlertRecord } from "./detection-service";

/* -------------------------------------------------------------------------- */
/*  The wire contract                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The vendor name this transport presents itself under.
 *
 * Tix's ingest reads *its own* family's payload through a dedicated reader rather than through
 * the vendor-alias soup every other sensor needs, and this string is how it tells the
 * difference. A relay that rewrites or drops it gets the alias reader and a worse mapping,
 * which is a reason to document the field rather than a reason to guess.
 */
export const TIX_SENTINEL_VENDOR = "OnTrak Sentinel";

/** `sha256=<hex>` over `` `${timestamp}.${body}` ``, exactly as Tix verifies it. */
export const TIX_SIGNATURE_HEADER = "x-ontrak-signature";
/** Unix seconds, inside the signature and checked against Tix's clock. */
export const TIX_TIMESTAMP_HEADER = "x-ontrak-timestamp";

/** How far the desk's clock and this one may disagree before a delivery is refused. */
export const TIX_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * The signature over a delivery.
 *
 * `timestamp.body` rather than the body alone: a signature over the body only is valid
 * forever, which is the same as not signing at all for the case signing exists for — a body
 * captured from a log and replayed later.
 */
export function sentinelSignature(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** The environment keys a Tix transport is configured from. */
export const TIX_TRANSPORT_ENV = {
  url: "SENTINEL_TIX_INGEST_URL",
  tenant: "SENTINEL_TIX_TENANT",
  token: "SENTINEL_TIX_INGEST_TOKEN",
  signingSecret: "SENTINEL_TIX_SIGNING_SECRET",
  timeoutMs: "SENTINEL_TIX_TIMEOUT_MS",
} as const;

/**
 * The delivery, as Tix's ingest reads it.
 *
 * Field names are Tix's, not Sentinel's, on purpose: this is the desk's contract and the desk
 * is the one that has to keep working for every other sensor. Where Tix has no field for a
 * fact Sentinel has — the corpus digest, the techniques — the payload carries it anyway and
 * Tix's reader keeps it, so the desk can show a rulebook version and a technique on a row
 * rather than having to go and ask.
 */
export function tixAlertPayload(
  event: AlertNotification,
  rulebook: readonly DetectionRule[] = DETECTION_RULES,
): Record<string, unknown> {
  const rule = rulebook.find((entry) => entry.id === event.ruleId) ?? null;

  return {
    vendor: TIX_SENTINEL_VENDOR,
    alertId: event.alertId,
    ruleId: event.ruleId,
    ruleName: event.ruleName,
    ruleVersion: event.ruleVersion,
    rulebookVersion: rulebookVersion(rulebook),
    ruleDescription: rule?.description ?? null,
    ruleReferences: rule ? [...rule.references] : [],
    // Derived here rather than sent by the sensor: the techniques belong to the rule, and the
    // rule belongs to the corpus this deployment runs.
    techniques: attackReferences(rule?.references ?? []),
    severity: event.severity,
    dedupeKey: event.dedupeKey,
    sourceAddress: event.sourceAddress,
    identityId: event.identityId,
    identityLabel: event.identityLabel,
    device: event.device,
    asset: event.asset,
    firstSeenAt: event.firstSeenAt,
    lastSeenAt: event.lastSeenAt,
    occurrences: event.occurrences,
    threatIntelCount: event.threatIntel,
  };
}

/* -------------------------------------------------------------------------- */
/*  The transport                                                             */
/* -------------------------------------------------------------------------- */

export interface TixAlertTransportOptions {
  /** Tix's ingest endpoint, e.g. `https://desk.example/api/security/ingest`. */
  url: string;
  /** The desk whose queue the alert belongs in, sent as `x-ontrak-tenant`. */
  tenant?: string | null;
  /** Tix's shared ingest secret (`ONTRAK_TIX_WEBHOOK_SECRET`), sent as a bearer. */
  token?: string | null;
  /** The signing secret. Absent means the delivery is authenticated by the bearer alone. */
  signingSecret?: string | null;
  timeoutMs?: number;
  /** The rulebook this deployment runs, so a rule's description and techniques travel. */
  rulebook?: readonly DetectionRule[];
  /** Injected only by a test. */
  fetchImpl?: typeof fetch;
  /** Injected only by a test, so the signature is a known value rather than a race. */
  nowSeconds?: () => number;
}

/**
 * A transport that speaks Tix's ingest.
 *
 * `POST` of the payload with a bearer, a tenant header and (when a signing secret is set) the
 * HMAC pair. A `2xx` means the desk took it; anything else, including a timeout, is the desk's
 * refusal and its own words are kept — a webhook that answers `401` on a misconfigured token
 * says so on the chain instead of being retried into a black hole.
 */
export class TixAlertTransport implements AlertNotifier {
  readonly name: string;
  private readonly url: string;
  private readonly tenant: string;
  private readonly token: string;
  private readonly signingSecret: string;
  private readonly timeoutMs: number;
  private readonly rulebook: readonly DetectionRule[];
  private readonly fetchImpl: typeof fetch;
  private readonly nowSeconds: () => number;

  constructor(options: TixAlertTransportOptions) {
    this.url = options.url;
    this.tenant = (options.tenant ?? "").trim();
    this.token = (options.token ?? "").trim();
    this.signingSecret = (options.signingSecret ?? "").trim();
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.rulebook = options.rulebook ?? DETECTION_RULES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    try {
      this.name = `tix:${new URL(this.url).host}`;
    } catch {
      this.name = "tix";
    }
  }

  /** Whether this transport signs. Reported so a deployment can be told which it is. */
  get signed(): boolean {
    return this.signingSecret !== "";
  }

  async notify(event: AlertNotification): Promise<NotifyOutcome> {
    const body = JSON.stringify(tixAlertPayload(event, this.rulebook));
    const timestamp = this.nowSeconds();

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      ...(this.token === "" ? {} : { authorization: `Bearer ${this.token}` }),
      ...(this.tenant === "" ? {} : { "x-ontrak-tenant": this.tenant }),
    };
    if (this.signingSecret !== "") {
      headers[TIX_SIGNATURE_HEADER] = sentinelSignature(this.signingSecret, timestamp, body);
      headers[TIX_TIMESTAMP_HEADER] = String(timestamp);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return {
          ok: false,
          error: `Tix answered ${response.status}${text === "" ? "" : `: ${text.slice(0, 200)}`}`,
        };
      }
      return { ok: true, detail: `Tix answered ${response.status}` };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      return { ok: false, error: `Tix unreachable: ${detail}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Wiring                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The Tix transport a deployment's environment describes, or `null` for none.
 *
 * An unset URL is **no transport** rather than a default that pretends, exactly as
 * `notifierFromEnv` is: a deployment that has not configured the desk must not be told its
 * alerts are reaching one.
 *
 * A URL *without* a credential still yields a transport, deliberately. The alternative is a
 * silent no-op, and the failure somebody needs to see is the one that says "Tix refused this:
 * 401" on the evidence chain. A missing credential is a misconfiguration, and a
 * misconfiguration that looks like a working deployment is the bug.
 */
export function tixTransportFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  rulebook: readonly DetectionRule[] = DETECTION_RULES,
): AlertNotifier | null {
  const url = String(env[TIX_TRANSPORT_ENV.url] ?? "").trim();
  if (url === "") return null;

  const timeout = Number(env[TIX_TRANSPORT_ENV.timeoutMs] ?? "");
  const read = (key: string): string | null => {
    const value = String(env[key] ?? "").trim();
    return value === "" ? null : value;
  };

  return new TixAlertTransport({
    url,
    tenant: read(TIX_TRANSPORT_ENV.tenant),
    token: read(TIX_TRANSPORT_ENV.token),
    signingSecret: read(TIX_TRANSPORT_ENV.signingSecret),
    rulebook,
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
  });
}

/** The projection of an alert this transport sends, for a caller that wants to look first. */
export function tixDeliveryPreview(
  alert: AlertRecord,
  rulebook: readonly DetectionRule[] = DETECTION_RULES,
): Record<string, unknown> {
  return tixAlertPayload(alertNotification(alert), rulebook);
}
