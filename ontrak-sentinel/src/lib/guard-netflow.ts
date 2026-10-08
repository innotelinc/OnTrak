/**
 * Guard's flow listener (S3): the second protocol on the network side.
 *
 * The syslog listener showed what "listening" meant — a socket that stays open,
 * frames what arrives and hands each event to *the same* ingest path a relay's
 * POST takes. This is the same shape for the protocol an IPFIX/NetFlow-capable
 * firewall speaks: a UDP socket that decodes flow export records and folds each
 * flow into the normalizer's vocabulary, so detection reasons about a flow
 * exactly as it reasons about a syslog frame.
 *
 * Flow export is a *binary* protocol with two entirely different generations, and
 * four decisions carry this file:
 *
 * **One reader, three versions.** NetFlow v5 and v9 and IPFIX (v10) all arrive on
 * the same collector port in the real world, so the version field is read first and
 * dispatched — a listener that only spoke v9 would silently discard half a fleet's
 * exports, and silence reads as "no incidents".
 *
 * **Templates are state, and a data record without one is skipped, not guessed.**
 * v9 and IPFIX describe their records with templates sent separately (and re-sent
 * periodically). A data set whose template has not been seen yet is *counted and
 * dropped*: an unknown layout decoded by position is fabricated telemetry, which is
 * worse than missing telemetry. The cache is keyed by the observation domain as well
 * as the template id, because two exporters number their templates independently.
 *
 * **The normalizer does the shaping, not this file.** A decoded flow becomes a plain
 * payload object (`sourceAddress`, `sourcePort`, …) and goes through `toObservedEvent`
 * — the one function that decides what an observation is. This module's job stops at
 * "five-tuple and counters", which is what keeps one answer to "what is a flow".
 *
 * **Direction is left alone when the protocol does not state it.** NetFlow has no
 * field that says inbound or outbound (only which interface a flow entered or left
 * on), and the normalizer's own rule is that a direction is stated, never inferred.
 * The interface indices are kept as attributes instead, because they are the honest
 * fact a sensor supplied.
 *
 * The tenant is configuration (`SENTINEL_GUARD_ORGANIZATION`), shared with the syslog
 * listener and for the same reason: a flow record has nowhere to put an organization
 * slug. The bind address is the access control, and the default is loopback.
 */

import { createSocket, type Socket } from "node:dgram";

import {
  toObservedEvent,
  type ObservedEvent,
  type TelemetrySource,
} from "./telemetry-rules";

/* -------------------------------------------------------------------------- */
/*  Settings                                                                  */
/* -------------------------------------------------------------------------- */

export interface GuardNetflowConfig {
  /** Address to bind. Default `127.0.0.1`: flow export cannot authenticate either. */
  host: string;
  port: number;
  /** What flows are attributed to when a record names no exporter of its own. */
  sensor: string;
  /** The tenant every flow belongs to. Required: a flow record cannot carry one. */
  organizationSlug: string;
  /** Longest datagram accepted. Longer is dropped and counted. */
  maxDatagramBytes: number;
}

export interface GuardNetflowStats {
  /** Datagrams read off the socket. */
  received: number;
  /** Flow records decoded from them. */
  records: number;
  /** Records the sink accepted. */
  accepted: number;
  /** Records the normalizer or the sink refused. */
  rejected: number;
  /** Datagrams (or records) dropped: too long, unreadable, or missing a template. */
  dropped: number;
  /** Socket-level errors, counted rather than thrown. */
  errors: number;
  /** When the last datagram arrived, ms since epoch, or null. */
  lastAt: number | null;
  /** Why the most recent refusal happened, for the operator reading the log. */
  lastError: string | null;
}

/** One normalised flow, in the shape the ingest path already accepts. */
export interface NetflowSink {
  accept(
    payload: { source: "NETFLOW" | "IPFIX"; sensor: string; event: ObservedEvent },
    at: number,
  ): Promise<{ ok: boolean; error?: string }>;
}

export interface GuardNetflowHandle {
  config: GuardNetflowConfig;
  stats(): GuardNetflowStats;
  close(): Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_SENSOR = "netflow";
/**
 * A datagram ceiling. A v9/IPFIX message can legally be up to 65,507 bytes, but an
 * export the collector is asked to hold in one piece past this is almost always a
 * malformed length field, and the number is configurable for a deployment whose
 * exporters legitimately send large template sets.
 */
const DEFAULT_MAX_DATAGRAM_BYTES = 65_507;

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The listener's settings, or null when this deployment does not listen.
 *
 * Throws for a listener that is *half* configured — a port with no organization is a
 * listener that would file flows under the wrong tenant, and refusing at boot is the
 * only cheap place to notice. The same rule the syslog listener applies, because the
 * reason is the protocol's rather than the transport's.
 */
export function guardNetflowConfigFromEnv(env: NodeJS.ProcessEnv): GuardNetflowConfig | null {
  const port = positiveInt(env.SENTINEL_GUARD_NETFLOW_PORT, 0);
  if (port === 0) return null;

  const organizationSlug = (env.SENTINEL_GUARD_ORGANIZATION ?? "").trim();
  if (organizationSlug === "") {
    throw new Error(
      "SENTINEL_GUARD_NETFLOW_PORT is set but SENTINEL_GUARD_ORGANIZATION is not: a flow record " +
        "cannot name its own tenant, so the listener must be told which one it serves.",
    );
  }

  return {
    host: (env.SENTINEL_GUARD_NETFLOW_HOST ?? "").trim() || DEFAULT_HOST,
    port,
    sensor: (env.SENTINEL_GUARD_NETFLOW_SENSOR ?? "").trim() || DEFAULT_SENSOR,
    organizationSlug,
    maxDatagramBytes: positiveInt(env.SENTINEL_GUARD_NETFLOW_MAX_DATAGRAM_BYTES, DEFAULT_MAX_DATAGRAM_BYTES),
  };
}

/* -------------------------------------------------------------------------- */
/*  Templates                                                                 */
/* -------------------------------------------------------------------------- */

/** One field in a template: the IANA type, and how many octets it occupies. */
export interface FieldSpec {
  type: number;
  length: number;
}

/**
 * The template cache a v9/IPFIX stream needs.
 *
 * Structurally typed rather than a class in the signature, so a test can hand the
 * parser a fixed map and assert what an unknown template does without a socket.
 */
export interface NetflowTemplates {
  learn(key: string, templateId: number, fields: readonly FieldSpec[]): void;
  get(key: string, templateId: number): readonly FieldSpec[] | null;
}

/**
 * Templates, keyed by exporter and id.
 *
 * A device re-sends templates periodically, so `learn` overwrites — a template that
 * changed is the device telling the collector about the change, and refusing it would
 * freeze the listener on a layout that no longer exists.
 */
export class TemplateCache implements NetflowTemplates {
  private readonly byKey = new Map<string, Map<number, readonly FieldSpec[]>>();

  learn(key: string, templateId: number, fields: readonly FieldSpec[]): void {
    let bucket = this.byKey.get(key);
    if (!bucket) {
      bucket = new Map();
      this.byKey.set(key, bucket);
    }
    bucket.set(templateId, fields);
  }

  get(key: string, templateId: number): readonly FieldSpec[] | null {
    return this.byKey.get(key)?.get(templateId) ?? null;
  }
}

/** The key that separates two exporters' template namespaces. */
function templateKey(version: number, domain: number): string {
  return `${version}:${domain}`;
}

/* -------------------------------------------------------------------------- */
/*  Field decoding                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The IANA IPFIX/NetFlow-v9 field ids this reader understands.
 *
 * Anything not here is skipped by length alone and kept as a hex attribute, so an
 * exporter's vendor field is neither dropped from the layout (which would shift every
 * field after it) nor invented into one of ours.
 */
const FIELD = {
  IN_BYTES: 1,
  IN_PKTS: 2,
  PROTOCOL: 4,
  TCP_FLAGS: 6,
  SRC_PORT: 7,
  SRC_IPV4: 8,
  INGRESS: 10,
  DST_PORT: 11,
  DST_IPV4: 12,
  EGRESS: 14,
  SRC_AS: 16,
  DST_AS: 17,
  SRC_IPV6: 27,
  DST_IPV6: 28,
  FLOW_START_MS: 152,
  FLOW_END_MS: 153,
  OUT_BYTES: 85,
  OUT_PKTS: 86,
} as const;

/** A handful of protocol numbers as names, because a rule reads `tcp`, not `6`. */
const PROTOCOL_NAMES: Record<number, string> = {
  1: "icmp",
  6: "tcp",
  17: "udp",
  47: "gre",
  50: "esp",
  51: "ah",
  58: "icmpv6",
  89: "ospf",
  132: "sctp",
};

function protocolName(value: number): string {
  return PROTOCOL_NAMES[value] ?? String(value);
}

/** An IPv4 address from four octets, dotted. */
function ipv4(buffer: Buffer, offset: number): string {
  return `${buffer[offset]}.${buffer[offset + 1]}.${buffer[offset + 2]}.${buffer[offset + 3]}`;
}

/** An IPv6 address from sixteen octets, in the RFC 5952 compressed form. */
function ipv6(buffer: Buffer, offset: number): string {
  const groups: number[] = [];
  for (let index = 0; index < 16; index += 2) groups.push(buffer.readUInt16BE(offset + index));
  // Find the longest run of zero groups to compress. A run of one is left expanded,
  // because `::` for a single group is longer than the group it replaces.
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let index = 0; index <= groups.length; index += 1) {
    if (index < groups.length && groups[index] === 0) {
      if (runStart === -1) runStart = index;
      continue;
    }
    const length = runStart === -1 ? 0 : index - runStart;
    if (length > bestLength) {
      bestStart = runStart;
      bestLength = length;
    }
    runStart = -1;
  }
  if (bestLength < 2) return groups.map((group) => group.toString(16)).join(":");
  const head = groups.slice(0, bestStart).map((group) => group.toString(16)).join(":");
  const tail = groups.slice(bestStart + bestLength).map((group) => group.toString(16)).join(":");
  return `${head}::${tail}`;
}

/** An unsigned integer of 1, 2, 4 or 8 octets; anything else is read as hex. */
function unsigned(buffer: Buffer, offset: number, length: number): number | null {
  if (length === 1) return buffer[offset];
  if (length === 2) return buffer.readUInt16BE(offset);
  if (length === 4) return buffer.readUInt32BE(offset);
  if (length === 8) return Number(buffer.readBigUInt64BE(offset));
  return null;
}

function hex(buffer: Buffer, offset: number, length: number): string {
  return buffer.subarray(offset, offset + length).toString("hex");
}

/**
 * One decoded record, as the payload the normalizer reads.
 *
 * The keys are the normalizer's own (`sourceAddress`, `sourcePort`, …) rather than the
 * IPFIX field names, because there is exactly one place that decides what an observation
 * is and this is not it.
 */
export interface DecodedFlow {
  payload: Record<string, unknown>;
  /** The event's own clock when the record carried one, else the export's. */
  at: number;
}

/* -------------------------------------------------------------------------- */
/*  NetFlow v5                                                                */
/* -------------------------------------------------------------------------- */

const V5_HEADER = 24;
const V5_RECORD = 48;

/**
 * NetFlow v5: a fixed 24-octet header and 48-octet records, no templates.
 *
 * The one generation with no state, and therefore the one whose parser cannot be told a
 * layout is wrong — the record length is the format. It is kept because firewalls and
 * routers still export it, and because a collector that ignored it would look like it
 * received nothing from the half of the fleet that had not been upgraded.
 */
function parseV5(buffer: Buffer, exportAt: number): { flows: DecodedFlow[]; issues: string[] } {
  const flows: DecodedFlow[] = [];
  const issues: string[] = [];
  if (buffer.length < V5_HEADER) return { flows, issues: ["the message is shorter than a v5 header"] };

  const count = buffer.readUInt16BE(2);
  const unixSecs = buffer.readUInt32BE(8);
  // The header's own clock is the export instant; a record has no wall-clock field, only
  // sysUptime offsets, so the export time is the honest timestamp for a v5 flow.
  const at = unixSecs > 0 ? unixSecs * 1000 : exportAt;

  for (let index = 0; index < count; index += 1) {
    const start = V5_HEADER + index * V5_RECORD;
    if (start + V5_RECORD > buffer.length) {
      issues.push(`record ${index} is truncated`);
      break;
    }
    const protocol = buffer[start + 38];
    flows.push({
      at,
      payload: {
        sourceAddress: ipv4(buffer, start),
        destinationAddress: ipv4(buffer, start + 4),
        sourcePort: buffer.readUInt16BE(start + 32),
        destinationPort: buffer.readUInt16BE(start + 34),
        protocol: protocolName(protocol),
        // NetFlow v5 names only the next hop, the packet and byte counts, the interface
        // indices and the AS numbers — none of which is a direction, so none is offered as
        // one. They are attributes, which is what they are.
        bytes: buffer.readUInt32BE(start + 20),
        packets: buffer.readUInt32BE(start + 16),
        nextHop: ipv4(buffer, start + 8),
        inputInterface: buffer.readUInt16BE(start + 12),
        outputInterface: buffer.readUInt16BE(start + 14),
        tcpFlags: buffer[start + 37],
        sourceAs: buffer.readUInt16BE(start + 40),
        destinationAs: buffer.readUInt16BE(start + 42),
      },
    });
  }
  return { flows, issues };
}

/* -------------------------------------------------------------------------- */
/*  NetFlow v9 / IPFIX                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One template-bearing record stream (v9 or IPFIX), decoded.
 *
 * The two formats are the same idea with different framing, so they share the template
 * store and the record reader and differ only in where the domain and the length live.
 */
function parseTemplated(
  buffer: Buffer,
  templates: NetflowTemplates,
  version: 9 | 10,
  exportAt: number,
): { flows: DecodedFlow[]; issues: string[] } {
  const flows: DecodedFlow[] = [];
  const issues: string[] = [];

  const header = version === 9 ? 20 : 16;
  if (buffer.length < header) return { flows, issues: [`the message is shorter than a v${version} header`] };

  // The observation domain is the exporter's own namespace for template ids, and it sits at
  // a different offset in the two headers: v9's *Source ID* is the last four octets of its
  // 20-octet header (offset 16), while IPFIX's *Observation Domain ID* is the last four of
  // its 16-octet header (offset 12). Reading one at the other's offset would put two
  // exporters' templates in one namespace.
  const domain = buffer.readUInt32BE(version === 9 ? 16 : 12);
  // A v9 header names the export instant in whole seconds at offset 8; IPFIX names it at
  // offset 4. Both are the fallback when a record carries no millisecond start of its own.
  const headerAt = version === 9 ? buffer.readUInt32BE(8) * 1000 : buffer.readUInt32BE(4) * 1000;
  const exportMs = headerAt > 0 ? headerAt : exportAt;

  // v9 declares its total length in a header field at offset 2 only for IPFIX; a v9
  // message runs to the end of the datagram, so the bound is the buffer either way.
  const end = version === 10 ? Math.min(buffer.readUInt16BE(2) || buffer.length, buffer.length) : buffer.length;
  let offset = header;
  let flowIndex = 0;

  while (offset + 4 <= end) {
    const setId = buffer.readUInt16BE(offset);
    const setLength = buffer.readUInt16BE(offset + 2);
    if (setLength < 4 || offset + setLength > end) {
      issues.push(`set at offset ${offset} declares an impossible length (${setLength})`);
      break;
    }
    const body = offset + 4;

    // A template set (v9 id 0, IPFIX id 2) or an options template set (v9 id 1, IPFIX id
    // 3). Only the former is read; options templates describe metering statistics, not
    // flows, and decoding them as one would invent a five-tuple.
    const isTemplateSet = (version === 9 && setId === 0) || (version === 10 && setId === 2);
    if (isTemplateSet) {
      let cursor = body;
      while (cursor + 4 <= offset + setLength) {
        const templateId = buffer.readUInt16BE(cursor);
        const fieldCount = buffer.readUInt16BE(cursor + 2);
        cursor += 4;
        const fields: FieldSpec[] = [];
        for (let field = 0; field < fieldCount; field += 1) {
          if (cursor + 4 > offset + setLength) {
            issues.push(`template ${templateId} is truncated`);
            break;
          }
          fields.push({ type: buffer.readUInt16BE(cursor), length: buffer.readUInt16BE(cursor + 2) });
          cursor += 4;
        }
        if (fields.length === fieldCount) templates.learn(templateKey(version, domain), templateId, fields);
      }
      offset += setLength;
      continue;
    }

    // A data set: id >= 256 in both versions. Anything in between is reserved and skipped.
    if (setId >= 256) {
      const fields = templates.get(templateKey(version, domain), setId);
      if (!fields) {
        // No layout, no record. Counting it and moving on is the only honest answer: a
        // record decoded by guesswork is fabricated telemetry.
        issues.push(`no template for data set ${setId} (exporter ${domain}) — its records were skipped`);
        offset += setLength;
        continue;
      }
      const recordLength = fields.reduce((total, field) => total + field.length, 0);
      if (recordLength <= 0) {
        offset += setLength;
        continue;
      }
      let cursor = body;
      while (cursor + recordLength <= offset + setLength) {
        const decoded = decodeRecord(buffer, cursor, fields, exportMs);
        if (decoded) flows.push(decoded);
        cursor += recordLength;
        flowIndex += 1;
      }
      // A trailing partial record is a real thing to see and worth naming once, but not
      // worth failing the whole set for — the complete records before it are valid.
      const remainder = offset + setLength - cursor;
      if (remainder > 0) issues.push(`data set ${setId} ends with ${remainder} stray octet(s)`);
    }

    offset += setLength;
  }

  return { flows, issues };
}

/**
 * One data record, decoded against its template.
 *
 * `null` when the record names neither an address — a flow with no endpoints is not an
 * observation, which is the same refusal the normalizer would make, taken one layer
 * earlier so a bad exporter costs a count rather than a parse error.
 */
function decodeRecord(
  buffer: Buffer,
  start: number,
  fields: readonly FieldSpec[],
  exportMs: number,
): DecodedFlow | null {
  const payload: Record<string, unknown> = {};
  let at = exportMs;
  let cursor = start;
  let bytes: number | null = null;
  let packets: number | null = null;

  for (const field of fields) {
    const value = unsigned(buffer, cursor, field.length);
    switch (field.type) {
      case FIELD.SRC_IPV4:
        if (field.length === 4) payload.sourceAddress = ipv4(buffer, cursor);
        break;
      case FIELD.DST_IPV4:
        if (field.length === 4) payload.destinationAddress = ipv4(buffer, cursor);
        break;
      case FIELD.SRC_IPV6:
        if (field.length === 16) payload.sourceAddress = ipv6(buffer, cursor);
        break;
      case FIELD.DST_IPV6:
        if (field.length === 16) payload.destinationAddress = ipv6(buffer, cursor);
        break;
      case FIELD.SRC_PORT:
        if (value !== null) payload.sourcePort = value;
        break;
      case FIELD.DST_PORT:
        if (value !== null) payload.destinationPort = value;
        break;
      case FIELD.PROTOCOL:
        if (value !== null) payload.protocol = protocolName(value);
        break;
      case FIELD.IN_BYTES:
      case FIELD.OUT_BYTES:
        if (value !== null) bytes = (bytes ?? 0) + value;
        break;
      case FIELD.IN_PKTS:
      case FIELD.OUT_PKTS:
        if (value !== null) packets = (packets ?? 0) + value;
        break;
      case FIELD.TCP_FLAGS:
        if (value !== null) payload.tcpFlags = value;
        break;
      case FIELD.INGRESS:
        if (value !== null) payload.inputInterface = value;
        break;
      case FIELD.EGRESS:
        if (value !== null) payload.outputInterface = value;
        break;
      case FIELD.SRC_AS:
        if (value !== null) payload.sourceAs = value;
        break;
      case FIELD.DST_AS:
        if (value !== null) payload.destinationAs = value;
        break;
      case FIELD.FLOW_START_MS:
        // A millisecond epoch is already what the normalizer's `parseTimestamp` expects, and
        // it is the flow's own clock rather than the export's — the difference between a
        // timeline and a batch's arrival time.
        if (value !== null && value > 0) at = value;
        break;
      default:
        // A field this build does not name is kept by its type id, so an operator can see
        // the exporter's own numbering rather than a silent gap.
        payload[`field_${field.type}`] = value !== null ? value : hex(buffer, cursor, field.length);
        break;
    }
    cursor += field.length;
  }

  if (bytes !== null) payload.bytes = bytes;
  if (packets !== null) payload.packets = packets;
  if (!payload.sourceAddress || !payload.destinationAddress) return null;
  return { at, payload };
}

/* -------------------------------------------------------------------------- */
/*  One message                                                               */
/* -------------------------------------------------------------------------- */

export interface ParsedNetflow {
  source: Extract<TelemetrySource, "NETFLOW" | "IPFIX">;
  /** The export's instant, used for a record that carries none of its own. */
  at: number;
  flows: DecodedFlow[];
  /** Reasons records or sets were skipped. Never thrown — reported. */
  issues: string[];
}

/**
 * One datagram, dispatched by version.
 *
 * `null` for a version this build does not read (v1-v4, v8, or a stray packet): the caller
 * counts it rather than treating it as an empty export. NetFlow v5 and v9 and IPFIX share
 * a version field, so the version decides the reader and nothing else does.
 */
export function parseNetflowMessage(
  buffer: Buffer,
  templates: NetflowTemplates,
  exportAt: number,
): ParsedNetflow | null {
  if (buffer.length < 2) return null;
  const version = buffer.readUInt16BE(0);

  if (version === 5) {
    const { flows, issues } = parseV5(buffer, exportAt);
    return { source: "NETFLOW", at: exportAt, flows, issues };
  }
  if (version === 9) {
    const { flows, issues } = parseTemplated(buffer, templates, 9, exportAt);
    return { source: "NETFLOW", at: exportAt, flows, issues };
  }
  if (version === 10) {
    const { flows, issues } = parseTemplated(buffer, templates, 10, exportAt);
    return { source: "IPFIX", at: exportAt, flows, issues };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  The listener                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Bind the collector socket.
 *
 * One UDP socket, because flow export is datagram-shaped and a lost export is the
 * protocol's own trade-off rather than something a listener can fix. Each decoded flow
 * is normalised and handed to the sink; the sink is the same `guardService.ingest` call
 * a relay's POST makes, so this is a door and not a second detection path.
 *
 * Nothing throws out of a socket handler: a malformed export, an unknown template, a sink
 * that refuses — each is a counter and a log line, so a peer cannot switch the detector
 * off by sending it something it did not expect.
 */
export async function startGuardNetflow(
  config: GuardNetflowConfig,
  deps: { sink: NetflowSink; log?: (message: string) => void; now?: () => number },
): Promise<GuardNetflowHandle> {
  const log = deps.log ?? ((): void => {});
  const now = deps.now ?? ((): number => Date.now());
  const templates = new TemplateCache();
  const stats: GuardNetflowStats = {
    received: 0,
    records: 0,
    accepted: 0,
    rejected: 0,
    dropped: 0,
    errors: 0,
    lastAt: null,
    lastError: null,
  };

  const socket = createSocket("udp4");
  socket.on("error", (error) => {
    stats.errors += 1;
    log(`netflow error: ${error.message}`);
  });

  socket.on("message", (message, _peer) => {
    // The handler is async but must not be awaited by the socket; a rejected promise here
    // would be an unhandled rejection, which is the one way a socket handler can still
    // bring the process down. Every await inside is wrapped.
    void handleDatagram(message).catch((error: unknown) => {
      stats.errors += 1;
      log(`netflow handler error: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  const handleDatagram = async (message: Buffer): Promise<void> => {
    stats.received += 1;
    stats.lastAt = now();
    if (message.length > config.maxDatagramBytes) {
      stats.dropped += 1;
      stats.lastError = `a datagram of ${message.length} bytes exceeds the ${config.maxDatagramBytes}-byte ceiling`;
      return;
    }

    const parsed = parseNetflowMessage(message, templates, now());
    if (parsed === null) {
      stats.dropped += 1;
      stats.lastError = "a datagram named a flow-export version this deployment does not read";
      return;
    }
    if (parsed.issues.length > 0) {
      // The issues are per-message detail; the first is the one an operator reads.
      stats.lastError = parsed.issues[0];
    }

    for (const flow of parsed.flows) {
      stats.records += 1;
      const observed = toObservedEvent(parsed.source, flow.payload, { sensor: config.sensor, at: flow.at });
      if (!observed.ok) {
        stats.rejected += 1;
        stats.lastError = observed.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
        continue;
      }
      let answer: { ok: boolean; error?: string };
      try {
        answer = await deps.sink.accept(
          { source: parsed.source, sensor: observed.event.sensor, event: observed.event },
          flow.at,
        );
      } catch (error) {
        answer = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (answer.ok) {
        stats.accepted += 1;
        continue;
      }
      stats.rejected += 1;
      stats.lastError = answer.error ?? "the sink refused the flow";
    }
  };

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(config.port, config.host, () => {
      socket.removeListener("error", reject);
      resolve();
    });
  });

  return {
    config,
    stats: () => ({ ...stats }),
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    },
  };
}
