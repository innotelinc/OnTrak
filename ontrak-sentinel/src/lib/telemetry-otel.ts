/**
 * OTel rules (S3): an OpenTelemetry export, folded into the one record.
 *
 * The third protocol on the ingest path, and the only one that is *structured by
 * design*: a syslog frame is text with a JSON tail, a flow is a binary five-tuple,
 * and an OTLP export is JSON whose every field is named. That makes this reader the
 * shortest of the three, and it is short for one reason: it does not invent a second
 * vocabulary. An OTLP record becomes a plain `{ sourceAddress, destinationPort, … }`
 * object — the same shape a relay's JSON body is — and goes through the *same*
 * `toObservedEvent`, so "what is an observation" has one answer whatever carried it.
 *
 * Two decisions worth stating out loud.
 *
 * **Attributes are flattened, because that is what an exporter already sends.** An
 * OpenTelemetry agent routinely carries `src_ip`, `dst_port` and a `direction` as
 * attributes, and the normalizer already knows those spellings. So resource
 * attributes and record attributes are merged into one object and handed over, which
 * means a deployment that follows the semantic conventions needs no mapping at all.
 *
 * **A JSON `body` is parsed, exactly as a syslog tail is.** The single most common
 * shape in the wild is a log line whose body is a JSON string. It is parsed and
 * merged under the attributes rather than carried as an opaque `message`, for the
 * same reason `toObservedEventFromSyslog` parses its tail: a detector that read the
 * string would see nothing, and a rule that needed the five-tuple would silently
 * never fire.
 *
 * The kind is never invented. OTLP says nothing about whether a record is network,
 * host, HTTP or auth telemetry, so a record is filed by the `kind` it states (an
 * attribute, as the normalizer already accepts) and otherwise by its source's own
 * implication — `NETWORK`, because that is what `OTEL` implies. A deployment that
 * emits host telemetry sets `kind: HOST` on the record, and the coverage map reads
 * that as the truth.
 */

/**
 * One attribute's value, decoded to a scalar string, or `null` when the value is
 * structurally empty.
 *
 * OTLP's `AnyValue` is a union with exactly one arm set, and `intValue` is
 * deliberately a **string** in the JSON encoding (a 64-bit integer does not fit a
 * JSON number). Non-scalar values are kept as JSON rather than dropped: an array or
 * a nested map is a fact some sensor chose to send, and this reader's job is to carry
 * it, not to judge it.
 */
function decodeValue(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const arm = value as Record<string, unknown>;
  if (typeof arm.stringValue === "string") return arm.stringValue;
  if (typeof arm.boolValue === "boolean") return arm.boolValue ? "true" : "false";
  if (typeof arm.intValue === "string" || typeof arm.intValue === "number") return String(arm.intValue);
  if (typeof arm.doubleValue === "number") return String(arm.doubleValue);
  if (arm.arrayValue !== undefined) return JSON.stringify(arm.arrayValue);
  if (arm.kvlistValue !== undefined) return JSON.stringify(arm.kvlistValue);
  if (typeof arm.bytesValue === "string") return arm.bytesValue;
  return null;
}

/** An OTLP attribute list (`[{ key, value }]`) as a plain map. */
function attributesOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { key, value } = entry as { key?: unknown; value?: unknown };
    if (typeof key !== "string" || !key.trim()) continue;
    const decoded = decodeValue(value);
    if (decoded !== null) out[key.trim()] = decoded;
  }
  return out;
}

/**
 * A record's `body`, as fields.
 *
 * A string body that parses as JSON is merged key by key — the case this reader
 * exists for. A `kvlistValue` body is merged the same way. Anything else (a bare
 * string, a number, a byte array) becomes `message`, which is kept on the event as an
 * attribute because a reader looking at an alert should be able to see what the
 * sensor said even when it is not structured.
 */
function bodyFields(body: unknown): Record<string, unknown> {
  if (body === null || body === undefined) return {};
  if (typeof body !== "object") return typeof body === "string" || typeof body === "number" ? { message: String(body) } : {};

  const arm = body as Record<string, unknown>;
  if (typeof arm.stringValue === "string") {
    const text = arm.stringValue;
    const brace = text.indexOf("{");
    if (brace !== -1) {
      try {
        const parsed = JSON.parse(text.slice(brace)) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        // Not JSON: fall through and keep the whole string.
      }
    }
    return { message: text };
  }
  if (arm.kvlistValue && typeof arm.kvlistValue === "object") {
    const list = (arm.kvlistValue as { values?: unknown }).values;
    return attributesOf(list);
  }
  if (arm.intValue !== undefined || arm.doubleValue !== undefined || arm.boolValue !== undefined) {
    const decoded = decodeValue(arm);
    return decoded === null ? {} : { message: decoded };
  }
  return {};
}

/**
 * A nanosecond epoch, in milliseconds.
 *
 * OTLP timestamps are nanoseconds since the Unix epoch and arrive as strings (a
 * 64-bit value does not fit a JS number). Anything that does not parse to a positive
 * instant is `null`, so the caller falls back to the export's own time rather than
 * dating an event to 1970.
 */
export function millisFromNanos(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const nanos = Number(value);
  if (!Number.isFinite(nanos) || nanos <= 0) return null;
  return Math.round(nanos / 1_000_000);
}

/** The result of reading one OTLP export. */
export interface OtlpReadResult {
  /** Normalizer-shaped payloads, one per log record or span. */
  events: Record<string, unknown>[];
  /** The exporter's own name, from `service.name`/`host.name`, when it says so. */
  sensor: string | null;
  /** Why a resource or record was skipped. Never thrown — reported. */
  issues: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read an OTLP/JSON export — logs (`resourceLogs`) or traces (`resourceSpans`).
 *
 * Both are accepted because an agent commonly sends its host telemetry as spans and
 * its application output as logs, and a receiver that took one and silently discarded
 * the other would look, from the sensor's side, like a deployment with nothing to
 * report. Metrics are deliberately **not** read: a metric is an aggregate over time
 * and has no five-tuple, so there is no honest `ObservedEvent` to make of one.
 */
export function toObservedEventsFromOtlp(payload: unknown): OtlpReadResult {
  const events: Record<string, unknown>[] = [];
  const issues: string[] = [];
  if (!isRecord(payload)) return { events, sensor: null, issues: ["the payload is not an object"] };

  let sensor: string | null = null;
  const resourceLogs = payload.resourceLogs;
  const resourceSpans = payload.resourceSpans;
  if (resourceLogs === undefined && resourceSpans === undefined) {
    return {
      events,
      sensor: null,
      issues: ["the payload carries neither resourceLogs nor resourceSpans — this is not an OTLP log or trace export"],
    };
  }

  const readResource = (resource: unknown): { attrs: Record<string, string>; name: string | null } => {
    const attrs = isRecord(resource) ? attributesOf(resource.attributes) : {};
    const name = attrs["service.name"] ?? attrs["host.name"] ?? null;
    return { attrs, name };
  };

  const readRecords = (
    records: unknown,
    resourceAttrs: Record<string, string>,
    timeKeys: readonly string[],
    label: string,
  ): void => {
    if (!Array.isArray(records)) return;
    for (const [index, record] of records.entries()) {
      if (!isRecord(record)) {
        issues.push(`${label} ${index} is not an object`);
        continue;
      }
      const merged: Record<string, unknown> = {
        ...resourceAttrs,
        ...attributesOf(record.attributes),
        ...bodyFields(record.body),
      };
      for (const key of timeKeys) {
        const at = millisFromNanos(record[key]);
        if (at !== null) {
          merged.at = at;
          break;
        }
      }
      // The span's own name is a useful label; it is kept as an attribute rather than
      // guessed into a field, because it is not a five-tuple.
      if (typeof record.name === "string" && !merged.name) merged.name = record.name;
      events.push(merged);
    }
  };

  if (Array.isArray(resourceLogs)) {
    for (const [index, resourceLog] of resourceLogs.entries()) {
      if (!isRecord(resourceLog)) {
        issues.push(`resourceLogs ${index} is not an object`);
        continue;
      }
      const { attrs, name } = readResource(resourceLog.resource);
      sensor = sensor ?? name;
      const scopes = Array.isArray(resourceLog.scopeLogs) ? resourceLog.scopeLogs : [];
      for (const scope of scopes) {
        if (!isRecord(scope)) continue;
        readRecords(scope.logRecords, attrs, ["timeUnixNano", "observedTimeUnixNano"], "logRecord");
      }
    }
  }

  if (Array.isArray(resourceSpans)) {
    for (const [index, resourceSpan] of resourceSpans.entries()) {
      if (!isRecord(resourceSpan)) {
        issues.push(`resourceSpans ${index} is not an object`);
        continue;
      }
      const { attrs, name } = readResource(resourceSpan.resource);
      sensor = sensor ?? name;
      const scopes = Array.isArray(resourceSpan.scopeSpans) ? resourceSpan.scopeSpans : [];
      for (const scope of scopes) {
        if (!isRecord(scope)) continue;
        readRecords(scope.spans, attrs, ["startTimeUnixNano"], "span");
      }
    }
  }

  return { events, sensor, issues };
}
