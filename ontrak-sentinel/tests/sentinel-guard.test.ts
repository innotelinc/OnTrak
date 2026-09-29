/**
 * OnTrak Sentinel S3 tests: telemetry in, one alert out, and it knows who it is about.
 *
 * S3's exit criterion is specific, so the tests follow it: *a known-bad pattern is detected
 * from live telemetry, deduped, and correlated into one alert linked to an identity, device
 * and asset*. Around it, each test takes one way a detection platform fails:
 *
 *  - **Noise is admitted as an observation.** A payload with no addresses is not telemetry,
 *    and a normalizer that accepted it would make every later count wrong.
 *  - **One packet per alert.** The dedupe key is derived from what the event *is*, so two
 *    sensors reporting one connection produce one incident — and a platform that raises a
 *    hundred alerts is a platform somebody switches off.
 *  - **A rule that fires on nothing, or on everything.** Every rule is driven with the
 *    observations it must match and the ones just short of it.
 *  - **Detection without identity.** The alert has to name the person the address belongs
 *    to, and has to stay honest when no session owns it.
 *  - **An ingest endpoint that takes anything.** A token is required, compared in constant
 *    time, and the tenant is looked up rather than trusted.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import {
  DetectionService,
  MemoryAlertStore,
  ALERT_EVIDENCE_MAX,
} from "../src/lib/detection-service";
import {
  CREDENTIAL_STUFFING_RULE,
  DETECTION_RULES,
  SCAN_RULE,
  SUSPICIOUS_SERVICE_RULE,
  evaluateRules,
  inCidr,
  type DetectionRule,
} from "../src/lib/detection-rules";
import { GUARD_PATHS, routeGuard } from "../src/lib/guard-http";
import { GuardService } from "../src/lib/guard-service";
import { sha256Hex } from "../src/lib/hash";
import {
  IdentityService,
  MemoryIdentityStore,
  OrganizationAuditLog,
  type IdentityActor,
} from "../src/lib/identity-service";
import {
  dedupeKey,
  parseTimestamp,
  toObservedEvent,
  toObservedEventFromSyslog,
  type ObservedEvent,
  type TelemetrySource,
} from "../src/lib/telemetry-rules";
import type { HttpRequest } from "../src/lib/oidc-http";

const sha256: HashFn = sha256Hex;

/* -------------------------------------------------------------------------- */
/*  The normalizer                                                            */
/* -------------------------------------------------------------------------- */

const AT = Date.parse("2026-10-27T09:00:00.000Z");

function event(over: Partial<ObservedEvent> = {}): ObservedEvent {
  return {
    kind: "NETWORK",
    source: "NETFLOW",
    at: AT,
    sensor: "fw-1",
    sourceAddress: "203.0.113.7",
    sourcePort: 51234,
    destinationAddress: "10.0.0.5",
    destinationPort: 22,
    protocol: "tcp",
    direction: null,
    attributes: {},
    ...over,
  };
}

function normalize(source: TelemetrySource, payload: unknown, sensor = "fw-1", at = AT) {
  return toObservedEvent(source, payload, { sensor, at });
}

test("telemetry: vendor shapes fold into one record, and a shapeless one is refused", () => {
  // NetFlow, lowercase short names and a port as a string.
  const flow = normalize("NETFLOW", { src_ip: "203.0.113.7", src_port: "51234", dst_ip: "10.0.0.5", dst_port: 22, proto: "TCP" });
  assert.ok(flow.ok, flow.ok ? "" : JSON.stringify(flow.issues));
  assert.equal(flow.event.sourceAddress, "203.0.113.7");
  assert.equal(flow.event.sourcePort, 51234);
  assert.equal(flow.event.protocol, "tcp");
  assert.equal(flow.event.kind, "NETWORK", "a flow from a firewall is network telemetry without being told");
  assert.equal(flow.event.sensor, "fw-1");

  // A host agent's `host` is the sensor, and its kind is HOST.
  const host = normalize("EBPF", { src_ip: "10.0.0.9", dst_ip: "10.0.0.5", host: "web-01", process: "curl" });
  assert.ok(host.ok);
  assert.equal(host.event.kind, "HOST");
  assert.equal(host.event.sensor, "web-01");
  assert.equal(host.event.attributes["process"], "curl", "anything extra is kept, and never trusted");

  // No addresses at all is noise with a timestamp.
  const noise = normalize("SYSLOG", { message: "hello", host: "router" });
  assert.equal(noise.ok, false);
  if (!noise.ok) {
    assert.deepEqual(noise.issues.map((issue) => issue.field).sort(), ["destinationAddress", "sourceAddress"]);
  }

  // A syslog line is read for its structured tail.
  const line = toObservedEventFromSyslog("<134>Oct 27 09:00:00 fw-1 { \"src_ip\": \"203.0.113.7\", \"dst_ip\": \"10.0.0.5\" }", {
    sensor: "collector",
    at: AT,
  });
  assert.ok(line.ok, line.ok ? "" : JSON.stringify(line.issues));
  assert.equal(line.event.source, "SYSLOG");
  assert.equal(toObservedEventFromSyslog("plain text, no JSON", { sensor: "c", at: AT }).ok, false);
});

test("telemetry: a port that is not a port and a clock in the wrong unit are handled", () => {
  // A port the sensor got wrong is absent, not 0 — 0 is a real port number and would make a
  // rule about "any port" quietly match nothing.
  const badPort = normalize("NETFLOW", { src_ip: "1.2.3.4", dst_ip: "10.0.0.5", dst_port: 70000 });
  assert.ok(badPort.ok, badPort.ok ? "" : JSON.stringify(badPort.issues));
  assert.equal(badPort.event.destinationPort, null);

  // Seconds and milliseconds differ by a thousand, so the magnitude decides.
  assert.equal(parseTimestamp(1_700_000_000), 1_700_000_000_000);
  assert.equal(parseTimestamp(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(parseTimestamp("2026-10-27T09:00:00.000Z"), AT);
  assert.equal(parseTimestamp("not a time"), null);

  // The relay's clock wins when the payload has none.
  const undated = normalize("NETFLOW", { src_ip: "1.2.3.4", dst_ip: "10.0.0.5" }, "fw-1", AT);
  assert.ok(undated.ok);
  assert.equal(undated.event.at, AT);
});

test("telemetry: two sensors reporting one connection produce one key", () => {
  const first = dedupeKey(event({ sensor: "fw-1" }));
  const second = dedupeKey(event({ sensor: "fw-2" }), 60_000);
  assert.equal(first, second, "the sensor is not part of what the event is");

  // A different source port is a different flow, and a minute later is a different incident.
  assert.notEqual(first, dedupeKey(event({ sourcePort: 51235 })));
  assert.notEqual(first, dedupeKey(event({ at: AT + 61_000 })));
});

test("detection: CIDR matching is numeric, and an IPv6 block is not half-implemented", () => {
  assert.equal(inCidr("10.0.0.5", "10.0.0.0/24"), true);
  assert.equal(inCidr("10.0.1.5", "10.0.0.0/24"), false);
  assert.equal(inCidr("10.0.0.5", "10.0.0.5"), true);
  assert.equal(inCidr("10.0.0.6", "10.0.0.5"), false);
  assert.equal(inCidr("10.0.0.5", "0.0.0.0/0"), true, "a /0 is the whole internet");
  assert.equal(inCidr("10.0.0.5", "10.0.0.0/33"), false, "a prefix out of range matches nothing rather than everything");
  assert.equal(inCidr("2001:db8::1", "2001:db8::1"), true);
  assert.equal(inCidr("2001:db8::1", "2001:db8::/32"), false, "an IPv6 block is refused, not guessed at");
});

/* -------------------------------------------------------------------------- */
/*  The rules                                                                 */
/* -------------------------------------------------------------------------- */

test("rules: every shipped rule is documented and versioned", () => {
  for (const rule of DETECTION_RULES) {
    assert.ok(rule.id.trim(), "a rule without an id cannot be reported");
    assert.ok(Number.isInteger(rule.version) && rule.version >= 1, `${rule.id} has no version`);
    assert.ok(rule.name.trim() && rule.description.length > 40, `${rule.id} is not documented enough to read at 03:00`);
    assert.ok(["signature", "behavioural", "sequence"].includes(rule.detection.kind));
  }
});

test("rules: the signature rule fires on the port it names and not on the one beside it", () => {
  const telnet = evaluateRules([event({ destinationPort: 23, direction: "OUTBOUND" })], [SUSPICIOUS_SERVICE_RULE]);
  assert.equal(telnet.length, 1);
  assert.equal(telnet[0].ruleId, "SG-SIG-001");
  assert.equal(telnet[0].ruleVersion, 1);
  assert.equal(telnet[0].severity, "HIGH");

  assert.equal(evaluateRules([event({ destinationPort: 22, direction: "OUTBOUND" })], [SUSPICIOUS_SERVICE_RULE]).length, 0);
  // Direction is part of the match: somebody connecting *to* us on 23 is a different
  // conversation from us connecting out.
  assert.equal(evaluateRules([event({ destinationPort: 23, direction: "INBOUND" })], [SUSPICIOUS_SERVICE_RULE]).length, 0);
  // A rule only looks at the kinds it says it does.
  assert.equal(evaluateRules([event({ destinationPort: 23, direction: "OUTBOUND", kind: "HOST" })], [SUSPICIOUS_SERVICE_RULE]).length, 0);
});

test("rules: a threshold fires at the count, not before, and a burst is not split by a bucket", () => {
  const many = (count: number, spacingMs = 1000) =>
    Array.from({ length: count }, (_, index) => event({ direction: "LATERAL", at: AT + index * spacingMs, destinationPort: 445 }));

  assert.equal(evaluateRules(many(19), [SCAN_RULE]).length, 0, "nineteen is not a scan");
  const fired = evaluateRules(many(20), [SCAN_RULE]);
  assert.equal(fired.length, 1, "twenty in a minute is one incident, not twenty");
  assert.equal(fired[0].occurrences, 20);

  // The same twenty spread past the window are not one incident.
  assert.equal(evaluateRules(many(20, 5000), [SCAN_RULE]).length, 0);

  // A burst straddling a fixed clock boundary is still one burst: the window slides with
  // the observations rather than with the epoch.
  const straddling = Array.from({ length: 20 }, (_, index) => event({ direction: "LATERAL", at: AT + 45_000 + index * 1_000 }));
  assert.equal(evaluateRules(straddling, [SCAN_RULE]).length, 1);

  // Two sources are two groups, and one alert each.
  const twoSources = [
    ...many(20).map((entry) => ({ ...entry, sourceAddress: "203.0.113.7" })),
    ...many(20).map((entry) => ({ ...entry, sourceAddress: "203.0.113.8" })),
  ];
  assert.equal(evaluateRules(twoSources, [SCAN_RULE]).length, 2);
});

test("rules: the sequence rule needs the order, the count and the window", () => {
  const auth = (outcome: string, at: number, sourceAddress = "203.0.113.7") =>
    event({
      kind: "AUTH",
      source: "SYSLOG",
      at,
      sourceAddress,
      destinationAddress: "10.0.0.5",
      destinationPort: 443,
      attributes: { outcome },
    });

  const failures = (count: number) => Array.from({ length: count }, (_, index) => auth("failure", AT + index * 1_000));

  assert.equal(evaluateRules(failures(4).concat([auth("success", AT + 5_000)]), [CREDENTIAL_STUFFING_RULE]).length, 0, "four failures is a Tuesday");
  const fired = evaluateRules(failures(5).concat([auth("success", AT + 6_000)]), [CREDENTIAL_STUFFING_RULE]);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].severity, "CRITICAL");
  assert.equal(fired[0].occurrences, 6, "the whole pattern is the evidence, not just the last step");

  // A success *before* the failures is not the pattern: the order matters.
  assert.equal(evaluateRules([auth("success", AT)].concat(failures(5)), [CREDENTIAL_STUFFING_RULE]).length, 0);

  // And a success an hour later is a different story.
  assert.equal(
    evaluateRules(failures(5).concat([auth("success", AT + 60 * 60_000)]), [CREDENTIAL_STUFFING_RULE]).length,
    0,
  );

  // Two addresses are two groups.
  const twoSources = failures(5)
    .concat([auth("success", AT + 6_000)])
    .concat(failures(5).map((entry) => ({ ...entry, sourceAddress: "203.0.113.9" })))
    .concat([auth("success", AT + 7_000, "203.0.113.9")]);
  assert.equal(evaluateRules(twoSources, [CREDENTIAL_STUFFING_RULE]).length, 2);
});

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

let seq = 0;

function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const entities = new MemoryIdentityStore();
  let clock = AT;
  let n = 0;
  const tag = `g${++seq}`;
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
    store,
    detection,
    actor,
    advance: (ms: number) => {
      clock += ms;
    },
    async organization(slug: string) {
      const created = await spine.bootstrapOrganization("test", { name: `${slug} Inc`, slug }, { identifier: `admin@${slug}.test`, displayName: "Admin" });
      assert.ok(created.ok, created.ok ? "" : created.error);
      const admin: IdentityActor = { id: created.value.admin.id, organizationId: created.value.organization.id, role: "ADMIN" };
      // The harness's shared actor follows the organization it bootstrapped, so the
      // service calls in a test use the same caller a console would.
      actor.id = admin.id;
      actor.organizationId = admin.organizationId;
      return { admin, organizationId: admin.organizationId };
    },
  };
}

const authEvent = (outcome: string, at: number, sourceAddress = "203.0.113.7") => ({
  kind: "AUTH",
  src_ip: sourceAddress,
  dst_ip: "10.0.0.5",
  dst_port: 443,
  timestamp: at,
  outcome,
  device: "idp-01",
  asset: "auth-service",
});

test("guard: one alert, correlated to the identity the address belongs to", async () => {
  const h = harness();
  const { organizationId } = await h.organization("guard");

  // A person whose session was granted from the address in the telemetry.
  const person = await h.spine.createIdentity({ id: "root", organizationId, role: "ADMIN" }, { identifier: "ada@guard.test", displayName: "Ada" });
  assert.ok(person.ok, person.ok ? "" : person.error);
  const personActor: IdentityActor = { id: person.value.id, organizationId, role: "AGENT" };
  assert.ok((await h.spine.setMfaEnrolled(personActor, person.value.id, true)).ok);
  const session = await h.spine.issueSession(organizationId, person.value.id, { ipAddress: "203.0.113.7" });
  assert.ok(session.ok, session.ok ? "" : session.error);

  const payloads = [
    ...Array.from({ length: 5 }, (_, index) => authEvent("failure", AT + index * 1_000)),
    authEvent("success", AT + 6_000),
  ];
  const ingested = await h.detection.ingest(organizationId, "SYSLOG", payloads, { sensor: "idp-collector" });
  assert.ok(ingested.ok, ingested.ok ? "" : ingested.error);
  assert.equal(ingested.value.accepted, 6);
  assert.equal(ingested.value.alerts.length, 1, "six events, one incident");

  const alerts = await h.detection.alerts(h.actor);
  assert.ok(alerts.ok, alerts.ok ? "" : alerts.error);
  assert.equal(alerts.value.length, 1);
  const alert = alerts.value[0];
  assert.equal(alert.ruleId, "SG-BEH-002");
  assert.equal(alert.severity, "CRITICAL");
  assert.equal(alert.state, "NEW");
  assert.equal(alert.identityId, person.value.id, "the alert names the person the address belongs to");
  assert.equal(alert.identityLabel, "ada@guard.test");
  assert.equal(alert.device, "idp-01");
  assert.equal(alert.asset, "auth-service");
  assert.equal(alert.occurrences, 6);
  assert.equal(alert.evidence.length, 6);

  // And the chain says a rule fired, with what it fired about.
  const raised = h.audit.trail(organizationId).filter((entry) => entry.action === "guard.alert.raised");
  assert.equal(raised.length, 1);
  assert.equal((raised[0].detail as { identityId: string }).identityId, person.value.id);
});

test("guard: a repeat updates the incident instead of raising a second one", async () => {
  const h = harness();
  const { organizationId } = await h.organization("dedupe");

  const payloads = [authEvent("failure", AT), authEvent("failure", AT + 1_000), authEvent("failure", AT + 2_000), authEvent("failure", AT + 3_000), authEvent("failure", AT + 4_000), authEvent("success", AT + 5_000)];
  const first = await h.detection.ingest(organizationId, "SYSLOG", payloads, { sensor: "collector-a" });
  assert.ok(first.ok, first.ok ? "" : first.error);
  assert.equal(first.value.alerts[0].created, true);

  // The same second sensor reports the same window: one alert, updated.
  const again = await h.detection.ingest(organizationId, "SYSLOG", payloads, { sensor: "collector-b" });
  assert.ok(again.ok, again.ok ? "" : again.error);
  assert.equal(again.value.alerts[0].created, false);
  assert.equal(again.value.alerts[0].id, first.value.alerts[0].id);

  const alerts = await h.detection.alerts(h.actor);
  assert.ok(alerts.ok);
  assert.equal(alerts.value.length, 1, "a hundred packets are one incident");
  assert.equal(alerts.value[0].occurrences, 12);
  assert.ok(h.audit.trail(organizationId).some((entry) => entry.action === "guard.alert.repeated"));
});

test("guard: an unattributable event is left unattributed, and evidence is bounded", async () => {
  const h = harness();
  const { organizationId } = await h.organization("unattributed");

  // No session was ever granted from this address.
  const payloads = [
    ...Array.from({ length: 5 }, (_, index) => authEvent("failure", AT + index * 1_000, "198.51.100.4")),
    authEvent("success", AT + 6_000, "198.51.100.4"),
  ];
  const ingested = await h.detection.ingest(organizationId, "SYSLOG", payloads, { sensor: "idp" });
  assert.ok(ingested.ok, ingested.ok ? "" : ingested.error);

  const alerts = await h.detection.alerts(h.actor);
  assert.ok(alerts.ok);
  assert.equal(alerts.value[0].identityId, null, "inventing an owner would be worse than saying nobody knows");
  assert.equal(alerts.value[0].sourceAddress, "198.51.100.4");

  // Evidence is capped: an alert that keeps every packet is a memory leak with a severity.
  const scan = Array.from({ length: ALERT_EVIDENCE_MAX + 25 }, (_, index) => ({
    kind: "NETWORK",
    src_ip: "203.0.113.7",
    dst_ip: "10.0.0.5",
    dst_port: 445,
    direction: "LATERAL",
    timestamp: AT + index * 100,
  }));
  const fired = await h.detection.ingest(organizationId, "NETFLOW", scan, { sensor: "fw-1" });
  assert.ok(fired.ok, fired.ok ? "" : fired.error);
  assert.equal(fired.value.alerts.length, 1);
  const listed = await h.detection.alerts(h.actor);
  assert.ok(listed.ok, listed.ok ? "" : listed.error);
  const stored = listed.value.find((entry) => entry.ruleId === "SG-BEH-001");
  assert.ok(stored);
  assert.equal(stored.evidence.length, ALERT_EVIDENCE_MAX);
  assert.equal(stored.occurrences, ALERT_EVIDENCE_MAX + 25, "the count is the truth; the evidence is the sample");
});

test("guard: a payload the normalizer refuses is reported, not dropped", async () => {
  const h = harness();
  const { organizationId } = await h.organization("refused");

  const ingested = await h.detection.ingest(
    organizationId,
    "NETFLOW",
    [{ src_ip: "203.0.113.7", dst_ip: "10.0.0.5" }, { message: "no addresses here" }, { src_ip: "203.0.113.7", dst_ip: "10.0.0.5" }],
    { sensor: "fw-1" },
  );
  assert.ok(ingested.ok, ingested.ok ? "" : ingested.error);
  assert.equal(ingested.value.accepted, 2);
  assert.equal(ingested.value.rejected.length, 1);
  assert.match(ingested.value.rejected[0].reason, /sourceAddress/);

  const unknownSource = await h.detection.ingest(organizationId, "TELEPATHY", [], { sensor: "x" });
  assert.equal(unknownSource.ok, false);
});

test("guard: triage is audited, and closing needs a reason", async () => {
  const h = harness();
  const { organizationId } = await h.organization("triage");

  const ingested = await h.detection.ingest(
    organizationId,
    "NETFLOW",
    [{ kind: "NETWORK", src_ip: "203.0.113.7", dst_ip: "10.0.0.5", dst_port: 23, direction: "OUTBOUND", timestamp: AT }],
    { sensor: "fw-1" },
  );
  assert.ok(ingested.ok, ingested.ok ? "" : ingested.error);
  const alertId = ingested.value.alerts[0].id;

  const acked = await h.detection.acknowledge(h.actor, alertId, "looking into it");
  assert.ok(acked.ok, acked.ok ? "" : acked.error);
  assert.equal(acked.value.state, "ACKNOWLEDGED");
  assert.equal(acked.value.note, "looking into it");

  const noReason = await h.detection.close(h.actor, alertId, "");
  assert.equal(noReason.ok, false);

  const closed = await h.detection.close(h.actor, alertId, "confirmed a developer's own test");
  assert.ok(closed.ok, closed.ok ? "" : closed.error);
  assert.equal(closed.value.state, "CLOSED");

  const trail = h.audit.trail(organizationId).map((entry) => entry.action);
  assert.ok(trail.includes("guard.alert.acknowledged"));
  assert.ok(trail.includes("guard.alert.closed"));

  // A SERVICE identity has no business reading alerts.
  const machine = await h.detection.alerts({ id: "svc", organizationId, role: "SERVICE" });
  assert.equal(machine.ok, false);
});

/* -------------------------------------------------------------------------- */
/*  The ingest surface                                                        */
/* -------------------------------------------------------------------------- */

function post(body: string, headers: Record<string, string> = {}): HttpRequest {
  return {
    method: "POST",
    url: `https://id.sentinel.test${GUARD_PATHS.events}`,
    headers: { "content-type": "application/json", ...headers },
    body,
  };
}

test("guard http: a token is required, the tenant is looked up, and the rest is refused", async () => {
  const h = harness();
  const { organizationId } = await h.organization("ingest");
  void organizationId;

  const guard = new GuardService(h.detection, h.entities, { token: "guard-secret", organizationSlug: null });

  const body = JSON.stringify({
    source: "NETFLOW",
    sensor: "fw-1",
    events: [{ src_ip: "203.0.113.7", dst_ip: "10.0.0.5", dst_port: 23, direction: "OUTBOUND", timestamp: AT }],
  });

  // No token, and the wrong token, get the same answer.
  assert.equal((await routeGuard(post(body), guard)).status, 401);
  assert.equal((await routeGuard(post(body, { authorization: "Bearer nope" }), guard)).status, 401);
  assert.equal((await routeGuard(post(body, { authorization: "guard-secret" }), guard)).status, 401, "the scheme is part of it");

  // A deployment token with no tenant named is refused rather than guessed at.
  assert.equal((await routeGuard(post(body, { authorization: "Bearer guard-secret" }), guard)).status, 400);
  // An unknown tenant is refused, before any telemetry is looked at.
  const unknownOrg = await routeGuard(
    post(body, { authorization: "Bearer guard-secret", "x-sentinel-organization": "nope" }),
    guard,
  );
  assert.equal(unknownOrg.status, 400);
  assert.match(unknownOrg.body, /No organization has the slug/);

  const accepted = await routeGuard(
    post(body, { authorization: "Bearer guard-secret", "x-sentinel-organization": "ingest" }),
    guard,
  );
  assert.equal(accepted.status, 202);
  const parsed = JSON.parse(accepted.body) as { accepted: number; alerts: { ruleId: string }[] };
  assert.equal(parsed.accepted, 1);
  assert.equal(parsed.alerts[0].ruleId, "SG-SIG-001");

  // The rulebook is readable, and carries no matchers.
  const rules = await routeGuard({ method: "GET", url: `https://id.sentinel.test${GUARD_PATHS.rules}`, headers: {} }, guard);
  assert.equal(rules.status, 200);
  const rulebook = JSON.parse(rules.body) as { rules: { id: string; version: number; kind: string }[] };
  assert.equal(rulebook.rules.length, DETECTION_RULES.length);
  assert.ok(rulebook.rules.every((entry) => entry.id && entry.version && entry.kind));

  // Somewhere else is a 404, so the OIDC/SAML/SCIM/console routers behind it are still asked.
  assert.equal(
    (await routeGuard({ method: "GET", url: "https://id.sentinel.test/oauth2/authorize", headers: {} }, guard)).status,
    404,
  );
  // And a body that is not JSON, or not an object, is a bad request rather than a crash.
  assert.equal((await routeGuard({ ...post("{"), headers: { authorization: "Bearer guard-secret" } }, guard)).status, 400);
  assert.equal((await routeGuard({ ...post("[]"), headers: { authorization: "Bearer guard-secret" } }, guard)).status, 400);
});

test("guard http: a deployment pinned to one organization ignores the header", async () => {
  const h = harness();
  await h.organization("pinned");
  await h.organization("other");

  const guard = new GuardService(h.detection, h.entities, { token: "secret", organizationSlug: "pinned" });
  const body = JSON.stringify({
    source: "NETFLOW",
    events: [{ src_ip: "203.0.113.7", dst_ip: "10.0.0.5", dst_port: 23, direction: "OUTBOUND", timestamp: AT }],
  });

  // A header naming another tenant cannot move the telemetry.
  const accepted = await routeGuard(
    post(body, { authorization: "Bearer secret", "x-sentinel-organization": "other" }),
    guard,
  );
  assert.equal(accepted.status, 202);

  const pinned = await h.entities.findOrganizationBySlug("pinned");
  const other = await h.entities.findOrganizationBySlug("other");
  assert.ok(pinned && other);
  const pinnedAlerts = await h.detection.alerts({ id: "root", organizationId: pinned.id, role: "ADMIN" });
  const otherAlerts = await h.detection.alerts({ id: "root", organizationId: other.id, role: "ADMIN" });
  assert.ok(pinnedAlerts.ok && otherAlerts.ok);
  assert.equal(pinnedAlerts.value.length, 1, "the telemetry landed in the pinned organization");
  assert.equal(otherAlerts.value.length, 0, "and never in the one the header named");
});

test("guard service: with no token configured there is no ingest surface", async () => {
  const h = harness();
  await h.organization("off");
  const guard = new GuardService(h.detection, h.entities, { token: null, organizationSlug: null });
  assert.equal(guard.enabled(), false);

  const result = await guard.ingest({ authorization: "Bearer anything", organization: "off", payload: {}, at: AT });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /does not accept telemetry/);
});

test("guard: a rule that is edited later does not rewrite what it fired on", () => {
  // The alert records the version, so an alert raised by v1 stays explained by v1 even
  // after the rule changes — which is the only way an incident review can reason about it.
  const versioned: DetectionRule = { ...SUSPICIOUS_SERVICE_RULE, version: 2 };
  const [draft] = evaluateRules([event({ destinationPort: 23, direction: "OUTBOUND" })], [versioned]);
  assert.equal(draft.ruleVersion, 2);
  assert.equal(SUSPICIOUS_SERVICE_RULE.version, 1);
});
