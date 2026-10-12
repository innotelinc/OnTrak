/**
 * OnTrak Sentinel ingest (M2): the family's own sensor, read natively.
 *
 * Every other sensor arrives through `parseVendorAlert`'s alias soup — `severity` or
 * `priority` or `level`, `hostname` or `asset` or `device` — and that is the right treatment
 * for a vendor whose payload nobody here controls. OnTrak Sentinel is not that. It is the
 * family's own product, its payload is *this* repository's other half, and reading it through
 * aliases would throw away the three fields a desk actually wants: the corpus the alert was
 * judged by, the ATT&CK techniques the rule maps to, and the number of threat-intelligence
 * indicators behind it.
 *
 * So this module is the pair of the sender in `ontrak-sentinel/src/lib/tix-alert-transport.ts`,
 * and it does two jobs:
 *
 *  - **Read** a Sentinel delivery into the canonical `RawSecurityAlert`, keeping the extra
 *    facts rather than discarding them. The `alertId` becomes the external id, so the desk's
 *    deduplication is 1:1 with Sentinel's own — an alert that Sentinel folded into one row
 *    arrives as one row here, and a retried delivery changes nothing.
 *  - **Authorize** an ingest, which is where the second credential lives. A shared bearer is a
 *    secret that every sensor holds and that a request log therefore contains; the HMAC pair
 *    is what makes a delivered body unusable an hour after it was captured, and the timestamp
 *    is inside the signature so it cannot be edited around. The decision is a pure function so
 *    the refusals can be proven without a server.
 *
 * The bearer path is unchanged and still works for every other sensor: a deployment that sets
 * no signing secret behaves exactly as it did, and one that does gets replay-resistant
 * deliveries from the family's own platform *in addition* to that.
 */

import { createHmac } from "node:crypto";

import { normalizeOccurredAt, type RawSecurityAlert } from "./security-alert-rules";
import { WEBHOOK_SECRET_ENV, extractSecret, secretsMatch, type HeaderReader } from "./intake-webhook";

/* -------------------------------------------------------------------------- */
/*  The wire contract                                                         */
/* -------------------------------------------------------------------------- */

/** What OnTrak Sentinel calls itself on the wire. */
export const SENTINEL_VENDOR = "OnTrak Sentinel";

/** Matched against a payload's vendor/product/integration field. */
const SENTINEL_VENDOR_PATTERN = /on ?trak[\s-]+sentinel|\bsentinel guard\b/i;

/** Where the desk's webhook secret is unset for the family, the signing secret is the gate. */
export const SENTINEL_SIGNING_SECRET_ENV = "ONTRAK_TIX_SENTINEL_SIGNING_SECRET";

/** `sha256=<hex>` over `` `${timestamp}.${body}` ``. Mirrors the sender's signer exactly. */
export const SENTINEL_SIGNATURE_HEADER = "x-ontrak-signature";
/** Unix seconds, inside the signature. */
export const SENTINEL_TIMESTAMP_HEADER = "x-ontrak-timestamp";

/**
 * How far apart the two clocks may be before a delivery is refused.
 *
 * Five minutes: long enough for two containers whose clocks drifted after a restart, short
 * enough that a body captured from a log is stale before anybody can use it. The window is
 * the whole value of signing, so it is a constant here rather than a per-deployment knob
 * somebody would widen to `86400` to make a broken clock stop complaining.
 */
export const SENTINEL_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * The signature over a delivery.
 *
 * Present in the *reader* as well as the sender because this is the contract's definition, and
 * a verifier that recomputed it differently would be a second opinion about the format. A test
 * uses it to produce exactly the bytes Sentinel sends.
 */
export function sentinelSignature(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/* -------------------------------------------------------------------------- */
/*  Reading a Sentinel alert                                                  */
/* -------------------------------------------------------------------------- */

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

/**
 * Whether a payload is an OnTrak Sentinel delivery.
 *
 * Answered from an explicit marker rather than from a field that merely *could* be Sentinel's:
 * `ruleId` and `occurrences` appear in half the world's alert payloads. A payload that names a
 * vendor is judged on that name; one that names none is judged on `rulebookVersion` beside
 * `dedupeKey`, which is the one pair of fields no other sender produces — a relay that strips
 * the vendor name still arrives as Sentinel, and a Microsoft Sentinel payload still does not.
 */
export function isSentinelAlert(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const raw = body as Record<string, unknown>;

  const vendor = text(raw.vendor) || text(raw.product) || text(raw.integration) || text(raw.sensor);
  if (vendor !== "") return SENTINEL_VENDOR_PATTERN.test(vendor);

  return text(raw.rulebookVersion) !== "" && text(raw.dedupeKey) !== "";
}

/**
 * Read a Sentinel delivery into the canonical raw alert, or `null` when it is not one.
 *
 * A payload with no time is refused rather than defaulted, for the same reason the alias
 * reader refuses one: an alert with an invented timestamp is an alert whose place in a
 * timeline is a lie, and the desk's whole value in an incident is that the timeline is real.
 */
export function parseSentinelAlert(body: unknown): RawSecurityAlert | null {
  if (!isSentinelAlert(body)) return null;
  const raw = body as Record<string, unknown>;

  const ruleId = text(raw.ruleId);
  const ruleName = text(raw.ruleName);
  const alertId = text(raw.alertId) || text(raw.id);

  // The signature is the rule's identity plus its name, because that string is what the desk
  // suppresses on and counts false-positive verdicts against. A rule *name* alone would make a
  // renamed rule look like a new detection with no history.
  const signature = [ruleId, ruleName].filter((part) => part !== "").join(" ").trim() || alertId;
  if (signature === "") return null;

  const occurredAtOrigin =
    text(raw.firstSeenAt) || text(raw.lastSeenAt) || text(raw.occurredAt) || text(raw.timestamp);
  if (occurredAtOrigin === "") return null;
  try {
    normalizeOccurredAt(occurredAtOrigin);
  } catch {
    return null;
  }

  const severity = raw.severity ?? raw.triageSeverity ?? "MEDIUM";
  const ruleDescription = text(raw.ruleDescription);

  return {
    vendor: SENTINEL_VENDOR,
    severity: typeof severity === "number" ? severity : String(severity),
    signature,
    description:
      ruleDescription !== ""
        ? ruleDescription
        : ruleName !== ""
          ? `${ruleName}${ruleId === "" ? "" : ` — OnTrak Sentinel rule ${ruleId}`}`
          : undefined,
    occurredAt: occurredAtOrigin,
    asset: text(raw.asset) || null,
    identity: text(raw.identityLabel) || text(raw.identity) || null,
    sourceIp: text(raw.sourceAddress) || null,
    // The desk's deduplication becomes 1:1 with Sentinel's own: an alert Sentinel folded into
    // one row is one row here, and a retried delivery changes nothing.
    externalId: alertId === "" ? null : alertId,
    // A reference *into* Sentinel rather than a copy of anything: the evidence stays in the
    // queue it was raised in, and the desk can reach it.
    rawRef: alertId === "" ? null : `sentinel://alerts/${alertId}`,
    rulebookVersion: text(raw.rulebookVersion) || null,
    techniques: Array.isArray(raw.techniques)
      ? raw.techniques.map((technique) => text(technique)).filter((technique) => technique !== "")
      : [],
    threatIntelCount:
      typeof raw.threatIntelCount === "number" && Number.isFinite(raw.threatIntelCount) && raw.threatIntelCount > 0
        ? Math.trunc(raw.threatIntelCount)
        : 0,
  };
}

/* -------------------------------------------------------------------------- */
/*  Authorizing an ingest                                                     */
/* -------------------------------------------------------------------------- */

/** How a delivery proved itself. Reported so the route can say which door was used. */
export type IngestAuthMode = "SHARED_SECRET" | "SIGNATURE";

export type IngestAuthorization = { ok: true; mode: IngestAuthMode } | { ok: false; error: string };

/**
 * Decide whether a delivery may be ingested.
 *
 * Ordered so that a signed delivery is judged *as* a signed delivery and nothing else: a
 * caller that presents a signature is never silently let in on the bearer, because the bearer
 * is the weaker credential and the one an attacker who captured a body would already hold.
 *
 * Three properties are the point:
 *
 *  - **Fail closed.** With no shared secret configured and no signature present, the answer is
 *    no — the same behaviour the route had before this module existed, kept deliberately.
 *  - **The clock is part of the signature.** The timestamp is signed alongside the body, so it
 *    cannot be edited to make an old delivery look current; a delivery outside the tolerance is
 *    refused with a sentence that says so rather than a bare `401`.
 *  - **Refusals are sentences.** The caller is an operator reading a log, not a browser.
 */
export function authorizeIngest(input: {
  headers: HeaderReader;
  rawBody: string;
  nowSeconds: number;
  sharedSecret: string | null;
  signingSecret: string | null;
}): IngestAuthorization {
  const signature = input.headers.get(SENTINEL_SIGNATURE_HEADER)?.trim() ?? "";
  const timestamp = input.headers.get(SENTINEL_TIMESTAMP_HEADER)?.trim() ?? "";

  if (signature !== "" || timestamp !== "") {
    if (input.signingSecret === null || input.signingSecret === "") {
      return {
        ok: false,
        error:
          "A signed delivery arrived but this deployment has no signing secret configured " +
          `(set ${SENTINEL_SIGNING_SECRET_ENV}), so it cannot be verified.`,
      };
    }
    if (signature === "" || timestamp === "") {
      return {
        ok: false,
        error: `A signed delivery needs both ${SENTINEL_SIGNATURE_HEADER} and ${SENTINEL_TIMESTAMP_HEADER}.`,
      };
    }

    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
      return { ok: false, error: `The ${SENTINEL_TIMESTAMP_HEADER} header has to be unix seconds.` };
    }
    const drift = Math.abs(input.nowSeconds - seconds);
    if (drift > SENTINEL_SIGNATURE_TOLERANCE_SECONDS) {
      return {
        ok: false,
        error:
          `The delivery is ${drift}s outside the ${SENTINEL_SIGNATURE_TOLERANCE_SECONDS}s signing window; ` +
          `check the two clocks, or the request was replayed.`,
      };
    }

    const expected = sentinelSignature(input.signingSecret, seconds, input.rawBody);
    // Constant-time, and hashed first so differing lengths cannot leak — the same comparison
    // every other secret here uses.
    if (!secretsMatch(signature, expected)) {
      return { ok: false, error: "The delivery signature does not match its body." };
    }
    return { ok: true, mode: "SIGNATURE" };
  }

  if (!secretsMatch(extractSecret(input.headers), input.sharedSecret)) {
    // The same sentence the route has always answered with: which credential is missing is a
    // thing a probe does not need to learn.
    return { ok: false, error: "Unauthorized." };
  }
  return { ok: true, mode: "SHARED_SECRET" };
}

/** The shared secret, as the route reads it, re-exported so the env name has one home. */
export { WEBHOOK_SECRET_ENV };
