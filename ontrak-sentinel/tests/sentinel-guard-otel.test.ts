/**
 * Sentinel S3 tests: the *OpenTelemetry* listener — the third way telemetry arrives.
 *
 * The syslog suite proved a text frame, the flow suite proved a binary one; this suite is
 * about the one protocol that is **structured by design**. That should make it the easiest,
 * and it is — but it has its own two ways to lie:
 *
 *  - **A JSON body is carried as an opaque string.** The most common OTLP shape in the wild
 *    is a log record whose `body` is a JSON string. A reader that kept it as `message` would
 *    hand detection a blob, and a rule that needed the five-tuple would silently never fire.
 *  - **The kind is guessed.** OTLP says nothing about whether a record is network, host,
 *    HTTP or auth telemetry. A reader that invented `AUTH` from, say, the word "login" would
 *    file telemetry under a kind no rule agreed to; the record's own `kind` is the only
 *    honest answer, and `OTEL`'s implication is the fallback.
 *
 * The receiver is a route rather than a socket — OTLP/HTTP is a POST — so the server half is
 * tested through `routeGuard`, the same door a collector knocks on, and its own OTLP
 * `partialSuccess` shape is checked because an exporter inspects it.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import { DetectionService, MemoryAlertStore } from "../src/lib/detection-service";
import { GUARD_PATHS, routeGuard } from "../src/lib/guard-http";
import { GuardService } from "../src/lib/guard-service";
import { sha256Hex } from "../src/lib/hash";
import {
  IdentityService,
  MemoryIdentityStore,
  OrganizationAuditLog,
  type IdentityActor,
} from "../src/lib/identity-service";
import type { HttpRequest } from "../src/lib/oidc-http";
import { toObservedEvent } from "../src/lib/telemetry-rules";
import { millisFromNanos, toObservedEventsFromOtlp } from "../src/lib/telemetry-otel";

const sha256: HashFn = sha256Hex;
const AT = Date.parse("2026-10-27T09:00:00.000Z");
const NANOS = String(AT * 1_000_000);

/* -------------------------------------------------------------------------- */
/*  Builders — the OTLP/JSON encoding, written by hand                        */
/* -------------------------------------------------------------------------- */

const str = (value: string): { stringValue: string } => ({ stringValue: value });
const int = (value: number): { intValue: string } => ({ intValue: String(value) });
const attr = (key: string, value: unknown): { key: string; value: unknown } => ({ key, value });

/** A logs export: one resource, one scope, the records given. */
function logsExport(
  resourceAttributes: { key: string; value: unknown }[],
  records: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes },
        scopeLogs: [{ scope: { name: "test" }, logRecords: records }],
      },
    ],
  };
}

/** A traces export: one resource, one scope, the spans given. */
function spansExport(
  resourceAttributes: { key: string; value: unknown }[],
  spans: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [{ scope: { name: "test" }, spans }],
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/*  Reading an export                                                         */
/* -------------------------------------------------------------------------- */

test("otel: an export that is not one is refused, not read as empty", () => {
  assert.ok(toObservedEventsFromOtlp(null).issues.length > 0);
  assert.ok(toObservedEventsFromOtlp("a string").issues.length > 0);

  // A real OTLP *metrics* export is valid OTLP and still not telemetry this reader can use:
  // a metric is an aggregate over time and has no five-tuple. It is named rather than
  // silently accepted as "nothing happened".
  const metrics = toObservedEventsFromOtlp({ resourceMetrics: [] });
  assert.equal(metrics.events.length, 0);
  assert.match(metrics.issues[0], /neither resourceLogs nor resourceSpans/);
});

test("otel: a JSON body string is parsed into the five-tuple, as a syslog tail is", () => {
  const read = toObservedEventsFromOtlp(
    logsExport(
      [attr("service.name", str("edge-collector"))],
      [
        {
          timeUnixNano: NANOS,
          body: str(
            '{"src_ip":"203.0.113.7","dst_ip":"10.0.0.5","dst_port":23,"direction":"OUTBOUND"}',
          ),
        },
      ],
    ),
  );

  assert.deepEqual(read.issues, []);
  assert.equal(read.events.length, 1);
  assert.equal(read.sensor, "edge-collector", "the exporter names itself through service.name");
  // The body's fields, not the body's string: a detector reading `message` would see nothing.
  assert.equal(read.events[0].sourceAddress ?? read.events[0].src_ip, "203.0.113.7");
  assert.equal(read.events[0].dst_port, 23);
  assert.equal(read.events[0].at, AT, "the nanosecond clock becomes milliseconds");
});

test("otel: attributes are flattened, and a JSON body wins over the attributes under it", () => {
  const read = toObservedEventsFromOtlp(
    logsExport(
      [attr("host.name", str("web-01")), attr("deployment.environment", str("prod"))],
      [
        {
          // Record attributes sit beside resource attributes, and both are carried.
          attributes: [attr("src_ip", str("10.0.0.9")), attr("dst_ip", str("10.0.0.5"))],
          // The body's own fields are merged last, so a body that carries the five-tuple is
          // the record's five-tuple — an exporter's body is more specific than its envelope.
          body: str('{"src_ip":"10.0.0.9","dst_ip":"10.0.0.5","dst_port":443}'),
          timeUnixNano: NANOS,
        },
      ],
    ),
  );

  assert.deepEqual(read.issues, []);
  assert.equal(read.sensor, "web-01", "host.name is the fallback when service.name is absent");
  // Attribute keys keep their OTLP spelling, dots and all.
  assert.equal(read.events[0]["deployment.environment"], "prod");
  assert.equal(read.events[0].dst_port, 443);
  assert.equal(read.events[0].at, AT);
});

test("otel: a record's stated kind is carried, and the normalizer decides the rest", () => {
  // OTLP does not say what kind a record is. The reader carries the kind the record states
  // and never invents one; the normalizer it hands the payload to is what files it, honouring
  // the stated kind and otherwise taking `OTEL`'s own implication, NETWORK.
  const read = toObservedEventsFromOtlp(
    logsExport(
      [attr("service.name", str("agent"))],
      [
        { body: str('{"src_ip":"10.0.0.9","dst_ip":"10.0.0.5","kind":"HOST","process":"curl"}'), timeUnixNano: NANOS },
        { body: str('{"src_ip":"10.0.0.9","dst_ip":"10.0.0.5","dst_port":22}'), timeUnixNano: NANOS },
      ],
    ),
  );

  assert.equal(read.events.length, 2);
  assert.equal(read.events[0].kind, "HOST", "the reader carries a stated kind");
  assert.equal(read.events[1].kind, undefined, "and invents none when the record states none");

  const stated = toObservedEvent("OTEL", read.events[0], { sensor: "agent", at: AT });
  const implied = toObservedEvent("OTEL", read.events[1], { sensor: "agent", at: AT });
  assert.ok(stated.ok && implied.ok);
  assert.equal(stated.event.kind, "HOST", "a stated kind is honoured");
  assert.equal(implied.event.kind, "NETWORK", "OTEL's implication, not an invented AUTH");
});

test("otel: a kvlist body is merged, and a plain body is kept as the message", () => {
  const read = toObservedEventsFromOtlp(
    logsExport(
      [attr("service.name", str("agent"))],
      [
        {
          body: { kvlistValue: { values: [attr("src_ip", str("10.0.0.9")), attr("dst_ip", str("10.0.0.5"))] } },
          timeUnixNano: NANOS,
        },
        { body: str("just a line, no JSON in it"), timeUnixNano: NANOS },
      ],
    ),
  );

  assert.equal(read.events[0].src_ip, "10.0.0.9");
  // An unstructured body is kept, because a reader looking at an alert should see what the
  // sensor said — but it is `message`, not a field a detector would match a five-tuple on.
  assert.equal(read.events[1].message, "just a line, no JSON in it");
});

test("otel: spans are read too, because an agent sends host telemetry as traces", () => {
  const read = toObservedEventsFromOtlp(
    spansExport(
      [attr("service.name", str("agent"))],
      [
        {
          name: "connect",
          startTimeUnixNano: NANOS,
          attributes: [attr("src_ip", str("10.0.0.9")), attr("dst_ip", str("10.0.0.5"))],
        },
      ],
    ),
  );

  assert.equal(read.events.length, 1, "a receiver that read only logs would look empty to a tracing agent");
  assert.equal(read.events[0].name, "connect", "the span's name is kept as a label, not guessed into a field");
  assert.equal(read.events[0].at, AT);
});

test("otel: a record with no clock is left undated rather than dated to 1970", () => {
  assert.equal(millisFromNanos(NANOS), AT);
  assert.equal(millisFromNanos("not a number"), null);
  assert.equal(millisFromNanos("0"), null, "the Unix epoch is not a real observation time");
  assert.equal(millisFromNanos(undefined), null);

  const read = toObservedEventsFromOtlp(
    logsExport([attr("service.name", str("agent"))], [
      { body: str('{"src_ip":"10.0.0.9","dst_ip":"10.0.0.5"}') },
    ]),
  );
  // No `at` on the record: the receiver stamps it with the export's own time.
  assert.equal(read.events[0].at, undefined);
});

/* -------------------------------------------------------------------------- */
/*  The receiver                                                              */
/* -------------------------------------------------------------------------- */

let seq = 0;

function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const entities = new MemoryIdentityStore();
  let clock = AT;
  const tag = `otel${++seq}`;
  let n = 0;
  const spine = new IdentityService(entities, audit, {
    id: () => `${tag}-id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  });
  const store = new MemoryAlertStore();
  const detection = new DetectionService(store, entities, audit);
  const actor: IdentityActor = { id: "root", organizationId: "", role: "ADMIN" };

  return {
    spine,
    entities,
    audit,
    detection,
    actor,
    advance: (ms: number) => {
      clock += ms;
    },
    async organization(slug: string) {
      const created = await spine.bootstrapOrganization("test", { name: `${slug} Inc`, slug }, { identifier: `admin@${slug}.test`, displayName: "Admin" });
      assert.ok(created.ok, created.ok ? "" : created.error);
      actor.id = created.value.admin.id;
      actor.organizationId = created.value.organization.id;
      return { organizationId: actor.organizationId };
    },
  };
}

function post(body: string, headers: Record<string, string> = {}): HttpRequest {
  return {
    method: "POST",
    url: `https://id.sentinel.test${GUARD_PATHS.otel}`,
    headers: { "content-type": "application/json", ...headers },
    body,
  };
}

test("otel http: an export becomes observed events through the same door as a relay's POST", async () => {
  const h = harness();
  await h.organization("otel");
  const guard = new GuardService(h.detection, h.entities, { token: "secret", organizationSlug: null });

  const body = JSON.stringify(
    logsExport(
      [attr("service.name", str("edge"))],
      [
        {
          timeUnixNano: NANOS,
          body: str('{"src_ip":"203.0.113.7","dst_ip":"10.0.0.5","dst_port":23,"direction":"OUTBOUND"}'),
        },
      ],
    ),
  );

  // No token, and the wrong token, get the same answer.
  assert.equal((await routeGuard(post(body), guard)).status, 401);
  assert.equal((await routeGuard(post(body, { authorization: "Bearer nope" }), guard)).status, 401);

  const accepted = await routeGuard(
    post(body, { authorization: "Bearer secret", "x-sentinel-organization": "otel" }),
    guard,
  );
  assert.equal(accepted.status, 200);
  const parsed = JSON.parse(accepted.body) as { accepted: number; alerts: { ruleId: string }[] };
  assert.equal(parsed.accepted, 1);
  // The OTLP record reached detection and fired the same rule a NetFlow record would have:
  // one vocabulary whatever carried the observation.
  assert.equal(parsed.alerts[0].ruleId, "SG-SIG-001");
  // A clean export carries no partial success at all.
  assert.equal((JSON.parse(accepted.body) as { partialSuccess?: unknown }).partialSuccess, undefined);

  // The method is part of the contract.
  assert.equal(
    (await routeGuard({ method: "GET", url: `https://id.sentinel.test${GUARD_PATHS.otel}`, headers: {} }, guard)).status,
    405,
  );
});

test("otel http: an export with nothing to read is a bad request, not a silent 200", async () => {
  const h = harness();
  await h.organization("otelempty");
  const guard = new GuardService(h.detection, h.entities, { token: "secret", organizationSlug: "otelempty" });

  const empty = await routeGuard(
    post(JSON.stringify({ resourceLogs: [] }), { authorization: "Bearer secret" }),
    guard,
  );
  assert.equal(empty.status, 400);

  const notJson = await routeGuard(
    post("{", { authorization: "Bearer secret" }),
    guard,
  );
  assert.equal(notJson.status, 400);
});

test("otel http: a refused record is reported as OTLP's own partial success", async () => {
  const h = harness();
  await h.organization("otelpartial");
  const guard = new GuardService(h.detection, h.entities, { token: "secret", organizationSlug: "otelpartial" });

  // One record carries a five-tuple, the other names no addresses — the normalizer refuses
  // it, and OTLP has a shape for exactly that.
  const body = JSON.stringify(
    logsExport(
      [attr("service.name", str("edge"))],
      [
        { timeUnixNano: NANOS, body: str('{"src_ip":"203.0.113.7","dst_ip":"10.0.0.5","dst_port":22}') },
        { timeUnixNano: NANOS, body: str("no addresses in this one") },
      ],
    ),
  );

  const accepted = await routeGuard(post(body, { authorization: "Bearer secret" }), guard);
  assert.equal(accepted.status, 200);
  const parsed = JSON.parse(accepted.body) as {
    accepted: number;
    partialSuccess?: { rejectedLogRecords: number; errorMessage: string };
  };
  assert.equal(parsed.accepted, 1);
  assert.ok(parsed.partialSuccess, "a record the normalizer refused is a partial success, and saying so is the point");
  assert.equal(parsed.partialSuccess.rejectedLogRecords, 1);
  assert.match(parsed.partialSuccess.errorMessage, /sourceAddress|destinationAddress/);
});
