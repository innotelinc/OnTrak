/**
 * Telemetry rules (S3): the normalizer — every source's shape into one.
 *
 * Sentinel Guard's first problem is not detection, it is vocabulary. A firewall exports
 * NetFlow, a host agent exports JSON about processes, a proxy exports an HTTP log, and a
 * syslog relay exports whatever the device felt like. Detection cannot be written against
 * "whatever the device felt like", so everything is folded into one record — an
 * `ObservedEvent` — and every rule reads only that.
 *
 * Four decisions worth stating out loud:
 *
 *  - **Normalization is a pure function, and it is allowed to say no.** A payload that
 *    names neither a source nor a destination is not an observation; it is noise with a
 *    timestamp, and admitting it would make every later query wrong in a way nobody can
 *    point at. The result is a union — normalised, or refused with a reason — rather than
 *    a record with holes in it.
 *  - **The direction is stated, not inferred.** "Port 22" means opposite things in a
 *    connection and in a listen; a normalizer that guessed would produce rules that fire
 *    on the wrong half of the traffic.
 *  - **The dedupe key is derived from what the event *is*, never from the vendor's id.**
 *    Vendors disagree about whether a re-send reuses an id, and the same connection often
 *    arrives twice (once from each end). Keying on the five-tuple and a coarse timestamp
 *    is what makes one alert per incident rather than one per sensor.
 *  - **Bytes are not decoded here.** A signature match against a payload is a `Uint8Array`
 *    the caller supplies; this module never turns telemetry into something executable.
 */

import type { IdentityRecord } from "./identity-rules";

/* -------------------------------------------------------------------------- */
/*  The one record                                                            */
/* -------------------------------------------------------------------------- */

export const TELEMETRY_KINDS = ["NETWORK", "HOST", "HTTP", "AUTH"] as const;
export type TelemetryKind = (typeof TELEMETRY_KINDS)[number];

export const TELEMETRY_SOURCES = ["SYSLOG", "NETFLOW", "IPFIX", "EBPF", "OTEL", "PROXY", "EDR", "FIREWALL"] as const;
export type TelemetrySource = (typeof TELEMETRY_SOURCES)[number];

export const TRAFFIC_DIRECTIONS = ["INBOUND", "OUTBOUND", "LATERAL"] as const;
export type TrafficDirection = (typeof TRAFFIC_DIRECTIONS)[number];

export interface ObservedEvent {
  kind: TelemetryKind;
  source: TelemetrySource;
  /** Epoch milliseconds, server-authoritative — never a vendor's local string. */
  at: number;
  /** Who sent it, as the sensor names itself. */
  sensor: string;
  /** The origin: address, and host name when the sensor knows one. */
  sourceAddress: string | null;
  sourcePort: number | null;
  destinationAddress: string | null;
  destinationPort: number | null;
  protocol: string | null;
  direction: TrafficDirection | null;
  /** Whatever the sensor said beyond the five-tuple, kept but never trusted. */
  attributes: Record<string, string>;
}

export interface TelemetryIssue {
  field: string;
  message: string;
}

export type TelemetryResult = { ok: true; event: ObservedEvent } | { ok: false; issues: TelemetryIssue[] };

/* -------------------------------------------------------------------------- */
/*  Reading a payload                                                         */
/* -------------------------------------------------------------------------- */

/** The same problem as a directory payload: every vendor spells one thing differently. */
const SOURCE_ADDRESS_KEYS = ["sourceAddress", "src_ip", "srcIp", "source_ip", "clientIp", "client_ip", "source", "src"];
const SOURCE_PORT_KEYS = ["sourcePort", "src_port", "srcPort", "spt", "sport"];
const DESTINATION_ADDRESS_KEYS = ["destinationAddress", "dst_ip", "dstIp", "destination_ip", "serverIp", "server_ip", "destination", "dst"];
const DESTINATION_PORT_KEYS = ["destinationPort", "dst_port", "dstPort", "dpt", "dport"];
const PROTOCOL_KEYS = ["protocol", "proto", "transport"];
const SENSOR_KEYS = ["sensor", "host", "hostname", "device", "reporter"];
const DIRECTION_KEYS = ["direction", "flowDirection", "dir"];
const TIMESTAMP_KEYS = ["at", "timestamp", "time", "@timestamp", "eventTime", "ts"];

const ATTRIBUTE_EXCLUDE = new Set([
  ...SOURCE_ADDRESS_KEYS,
  ...SOURCE_PORT_KEYS,
  ...DESTINATION_ADDRESS_KEYS,
  ...DESTINATION_PORT_KEYS,
  ...PROTOCOL_KEYS,
  ...SENSOR_KEYS,
  ...DIRECTION_KEYS,
  ...TIMESTAMP_KEYS,
  "kind",
  "source_kind",
  "type",
]);

function scalar(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function pick(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const found = scalar(record[key]);
    if (found) return found;
  }
  return null;
}

/** A port, or `null` when the sensor sent something that is not a port. */
export function parsePort(value: unknown): number | null {
  const text = scalar(value);
  if (text === null) return null;
  const port = Number(text);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}

/**
 * A timestamp, in milliseconds.
 *
 * Seconds and milliseconds are both common and differ by a factor of a thousand, so the
 * magnitude decides: an epoch in the past is ~1.7e9 seconds or ~1.7e12 milliseconds, and
 * treating milliseconds as seconds dates an event to 1970 — which, in an incident
 * timeline, is worse than refusing the record.
 */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return normalizeEpoch(value);
  const text = scalar(value);
  if (text === null) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return normalizeEpoch(Number(text));
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeEpoch(value: number): number {
  // Anything below 1e12 is seconds (1e12 ms is 2001; 1e12 s is year 33658). A value that
  // large from a sensor is a bug in the sensor, and is passed through rather than mangled.
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

/**
 * The kind a source's events are filed under when the payload states none.
 *
 * Exported because the coverage map has to give the same answer this does: a page that
 * judged source coverage by its own reading of "what kind is a NetFlow record?" would be
 * a second opinion about the normalizer, and the two would drift. `AUTH` is never a
 * default — it is a kind a payload claims (`kind: AUTH`), not one a source implies — which
 * is why an authentication source has to say so rather than be assumed from its name.
 */
export function defaultKindForSource(source: TelemetrySource): TelemetryKind {
  if (source === "NETFLOW" || source === "IPFIX" || source === "FIREWALL") return "NETWORK";
  if (source === "EBPF" || source === "EDR") return "HOST";
  if (source === "PROXY") return "HTTP";
  return "NETWORK";
}

function kindOf(record: Record<string, unknown>, source: TelemetrySource): TelemetryKind {
  const stated = (pick(record, ["kind", "source_kind", "type"]) ?? "").toUpperCase();
  if ((TELEMETRY_KINDS as readonly string[]).includes(stated)) return stated as TelemetryKind;
  return defaultKindForSource(source);
}

function directionOf(value: unknown): TrafficDirection | null {
  const text = (scalar(value) ?? "").toUpperCase();
  return (TRAFFIC_DIRECTIONS as readonly string[]).includes(text) ? (text as TrafficDirection) : null;
}

/**
 * One vendor payload → one observation, or the reasons it is not one.
 *
 * `sensor` and `at` are arguments rather than read from the payload: a relay knows which
 * device it is relaying and what time it saw the frame, and a sensor that lies about its
 * own clock must not be able to move an incident's timeline.
 */
export function toObservedEvent(
  source: TelemetrySource,
  payload: unknown,
  context: { sensor: string; at: number },
): TelemetryResult {
  if (!payload || typeof payload !== "object") {
    return { ok: false, issues: [{ field: "payload", message: "the payload is not an object" }] };
  }
  const record = payload as Record<string, unknown>;

  const sourceAddress = pick(record, SOURCE_ADDRESS_KEYS);
  const destinationAddress = pick(record, DESTINATION_ADDRESS_KEYS);
  const issues: TelemetryIssue[] = [];
  if (!sourceAddress) issues.push({ field: "sourceAddress", message: "no source address" });
  if (!destinationAddress) issues.push({ field: "destinationAddress", message: "no destination address" });
  if (issues.length > 0) return { ok: false, issues };

  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (ATTRIBUTE_EXCLUDE.has(key)) continue;
    const text = scalar(value);
    if (text !== null) attributes[key] = text;
  }

  const sensor = pick(record, SENSOR_KEYS) ?? context.sensor;

  return {
    ok: true,
    event: {
      kind: kindOf(record, source),
      source,
      // The relay's clock wins when the payload has none, and the payload's is only used
      // when the relay did not stamp it.
      at: parseTimestamp(record[TIMESTAMP_KEYS[0]] ?? record.at) ?? context.at,
      sensor,
      sourceAddress,
      sourcePort: parsePort(pick(record, SOURCE_PORT_KEYS)),
      destinationAddress,
      destinationPort: parsePort(pick(record, DESTINATION_PORT_KEYS)),
      protocol: (pick(record, PROTOCOL_KEYS) ?? "").toLowerCase() || null,
      direction: directionOf(pick(record, DIRECTION_KEYS)),
      attributes,
    },
  };
}

/** A syslog line, as a relay hands it over: `<priority>…` or free text with a JSON tail. */
export function toObservedEventFromSyslog(line: string, context: { sensor: string; at: number }): TelemetryResult {
  const trimmed = line.trim().replace(/^<\d+>\s*/, "");
  const brace = trimmed.indexOf("{");
  if (brace === -1) {
    return { ok: false, issues: [{ field: "payload", message: "the syslog line carries no structured payload" }] };
  }
  try {
    return toObservedEvent("SYSLOG", JSON.parse(trimmed.slice(brace)), context);
  } catch {
    return { ok: false, issues: [{ field: "payload", message: "the structured part of the syslog line is not JSON" }] };
  }
}

/* -------------------------------------------------------------------------- */
/*  Dedupe and correlation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A key for "this is the same event", derived from what the event is.
 *
 * The five-tuple plus a bucket of the clock, and deliberately *not* the vendor's alert id:
 * the same connection frequently arrives twice (once from each sensor) and a re-send keeps
 * both the id and the tuple. The bucket is what makes two frames from one transfer one
 * incident while leaving a second attempt a minute later as its own — a fixed, documented
 * window rather than a guess inside a rule.
 */
export function dedupeKey(event: ObservedEvent, bucketMs = 60_000): string {
  const bucket = Math.floor(event.at / bucketMs);
  return [
    event.kind,
    event.sourceAddress ?? "-",
    event.sourcePort ?? "-",
    event.destinationAddress ?? "-",
    event.destinationPort ?? "-",
    event.protocol ?? "-",
    bucket,
  ].join("|");
}

/**
 * Which identity an event belongs to.
 *
 * The correlation key between what the network sees and who somebody is. In v1 it is the
 * address on the event matched against the address a session was granted from — the one
 * piece of identity data telemetry can be joined to without querying the directory on
 * every packet. `null` is a real answer and stays one: an unattributable event is not
 * made up, and a rule that needs an identity does not fire for it.
 */
export function correlateIdentity(event: ObservedEvent, sessions: readonly SessionAddress[]): string | null {
  if (!event.sourceAddress) return null;
  const match = sessions.find((session) => session.ipAddress === event.sourceAddress);
  return match ? match.identityId : null;
}

/** What correlation needs of a session: an address, and whose it was. */
export interface SessionAddress {
  identityId: string;
  ipAddress: string | null;
}

/**
 * The device and asset an event is about, taken from the attributes a sensor supplied.
 * Absent is absent: a rule that links an alert to a device names one only when the sensor
 * said which it was.
 */
export function deviceOf(event: ObservedEvent): string | null {
  return event.attributes["device"] ?? event.attributes["hostname"] ?? event.sensor ?? null;
}

export function assetOf(event: ObservedEvent): string | null {
  return event.attributes["asset"] ?? event.attributes["assetId"] ?? event.attributes["resource"] ?? null;
}

/** A person's address for an alert, when the identity is known. */
export function identityOf(identity: IdentityRecord | null): { id: string; label: string } | null {
  return identity ? { id: identity.id, label: identity.identifier } : null;
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

export function validateTelemetrySource(source: string): TelemetryIssue[] {
  if (!(TELEMETRY_SOURCES as readonly string[]).includes(source)) {
    return [{ field: "source", message: `“${source}” is not a source this deployment reads.` }];
  }
  return [];
}
