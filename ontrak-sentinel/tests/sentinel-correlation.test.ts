/**
 * OnTrak Sentinel S3 tests: correlation, the one thing a pile of signatures cannot do.
 *
 * Four questions, and each is a way a correlation engine goes wrong:
 *
 *  - **Does it need *different* detections?** A rule that fired eleven times is the rule working
 *    as designed; an incident is two *different* detections agreeing about one subject, and a
 *    correlation that counted repeats would turn every noisy rule into an incident generator.
 *  - **Does one intrusion stay one incident?** The cooldown is a property of the raised alert's
 *    key, so a sprawling intrusion that keeps matching folds into the row that already exists
 *    rather than raising a new one every batch.
 *  - **Does it avoid correlating itself?** A correlated alert must never be evidence for another
 *    correlation, or a busy estate feeds itself and the queue fills with echoes.
 *  - **Does the pipeline actually raise it?** Correlation is only worth anything if the incident
 *    arrives as an alert — same store, same mute, same delivery, same queue — which is what the
 *    service test at the end drives end to end.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AuditEvent, HashFn } from "../src/lib/audit-chain";
import {
  CORRELATION_RULES,
  HOST_COMPROMISE_CORRELATION,
  RECON_THEN_AUTH_CORRELATION,
  correlateAlerts,
  correlationVersion,
  incidentDedupeKey,
  toCorrelationCandidate,
  worseSeverity,
  type CorrelationCandidate,
  type CorrelationRule,
} from "../src/lib/correlation-rules";
import { DetectionService, MemoryAlertStore, type AlertRecord } from "../src/lib/detection-service";
import { sha256Hex } from "../src/lib/hash";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog } from "../src/lib/identity-service";

const sha256: HashFn = sha256Hex;
const AT = Date.parse("2026-10-27T09:00:00.000Z");

function candidate(overrides: Partial<CorrelationCandidate> = {}): CorrelationCandidate {
  return {
    alertId: "a1",
    ruleId: "SG-BEH-001",
    severity: "MEDIUM",
    at: AT,
    sourceAddress: "203.0.113.7",
    identityId: null,
    asset: null,
    device: null,
    ...overrides,
  };
}

/** A rule that needs two different detections on one address inside a minute. */
function rule(overrides: Partial<CorrelationRule> = {}): CorrelationRule {
  return {
    id: "SG-COR-T00",
    version: 1,
    name: "a correlation",
    severity: "HIGH",
    description: "a correlation",
    references: [],
    groupBy: "sourceAddress",
    minAlerts: 2,
    minDistinctRules: 2,
    windowMs: 60_000,
    cooldownMs: 60_000,
    maxMembers: 12,
    ...overrides,
  };
}

/**
 * What a `guard.detection.correlated` row records, as this file reads it.
 *
 * `AuditEvent.detail` is deliberately `unknown` — one chain holds every module's records — so a
 * reader has to say which record it expects. Writing that down is what keeps the assertions
 * below checking the fields rather than poking at `any`.
 */
interface CorrelationDetail {
  correlated: boolean;
  groupBy: string;
  contributingRules: string[];
  worstMemberSeverity: string;
  severity: string;
  escalated: boolean;
}

/** The correlation row on the chain, or `undefined` when nothing correlated. */
function correlationRow(entries: readonly AuditEvent[]): CorrelationDetail | undefined {
  for (const entry of entries) {
    const detail = entry.detail as Partial<CorrelationDetail> | undefined;
    if (detail?.correlated === true) return detail as CorrelationDetail;
  }
  return undefined;
}

test("correlation: two different detections on one subject are one incident", () => {
  const incidents = correlateAlerts(
    [
      candidate({ alertId: "a1", ruleId: "SG-BEH-001", at: AT }),
      candidate({ alertId: "a2", ruleId: "SG-SIG-001", severity: "HIGH", at: AT + 5_000 }),
    ],
    [rule()],
    { now: AT + 5_000 },
  );

  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].group, "203.0.113.7");
  assert.deepEqual(incidents[0].distinctRules, ["SG-BEH-001", "SG-SIG-001"]);
  assert.deepEqual(incidents[0].members.map((member) => member.alertId), ["a1", "a2"]);
  // The floor is the rule's, and the worst member is worse: an incident that includes a HIGH
  // detection is HIGH however mild the correlation rule that noticed it.
  assert.equal(incidents[0].severity, "HIGH");
  assert.equal(incidents[0].firstSeenAt, AT);
  assert.equal(incidents[0].lastSeenAt, AT + 5_000);
});

test("correlation: the same rule firing repeatedly is not an incident", () => {
  const repeats = Array.from({ length: 5 }, (_, index) =>
    candidate({ alertId: `a${index}`, ruleId: "SG-BEH-001", at: AT + index * 1_000 }),
  );
  assert.deepEqual(correlateAlerts(repeats, [rule()], { now: AT }), []);

  // With `minDistinctRules` relaxed to one it *is* an incident, so the bar is what decided it
  // rather than the count being too small.
  const louder = correlateAlerts(repeats, [rule({ minDistinctRules: 1 })], { now: AT });
  assert.equal(louder.length, 1);
});

test("correlation: members outside the window are not members", () => {
  const incidents = correlateAlerts(
    [
      candidate({ alertId: "a1", ruleId: "SG-BEH-001", at: AT }),
      candidate({ alertId: "a2", ruleId: "SG-SIG-001", at: AT + 61_000 }),
    ],
    [rule()],
    { now: AT + 61_000 },
  );
  assert.deepEqual(incidents, [], "half an hour apart is not one incident");
  assert.equal(correlateAlerts(
    [
      candidate({ alertId: "a1", ruleId: "SG-BEH-001", at: AT }),
      candidate({ alertId: "a2", ruleId: "SG-SIG-001", at: AT + 59_000 }),
    ],
    [rule()],
    { now: AT + 59_000 },
  ).length, 1);
});

test("correlation: a repeat inside the cooldown folds into the same incident key", () => {
  const r = rule({ cooldownMs: 60_000 });
  const first = incidentDedupeKey(r, "203.0.113.7", AT);
  assert.equal(incidentDedupeKey(r, "203.0.113.7", AT + 30_000), first, "still the same incident");
  assert.notEqual(incidentDedupeKey(r, "203.0.113.7", AT + 61_000), first, "an hour-old block is not evidence about now");
  assert.notEqual(incidentDedupeKey(r, "198.51.100.4", AT), first, "another subject is another incident");
});

test("correlation: one long intrusion is one incident, not one per contributing alert", () => {
  const events = [
    candidate({ alertId: "a1", ruleId: "SG-BEH-001", at: AT }),
    candidate({ alertId: "a2", ruleId: "SG-SIG-001", at: AT + 10_000 }),
    candidate({ alertId: "a3", ruleId: "SG-BEH-003", at: AT + 20_000 }),
    candidate({ alertId: "a4", ruleId: "SG-HOST-001", at: AT + 30_000 }),
  ];
  const incidents = correlateAlerts(events, [rule({ windowMs: 60_000 })], { now: AT + 30_000 });
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].members.length, 4);
});

test("correlation: a subject is required, and a correlated alert is never evidence", () => {
  // No source address means no subject, and a rule grouped on one cannot fire. The alternative
  // is one estate-wide incident per batch, which is the noise correlation exists to remove.
  assert.deepEqual(correlateAlerts([candidate({ sourceAddress: null }), candidate({ alertId: "a2", ruleId: "SG-SIG-001", sourceAddress: null })], [rule()], { now: AT }), []);

  // A correlated alert (its rule id is a correlation rule) is filtered out of the pool, so
  // incidents cannot feed each other.
  const withCorrelated = correlateAlerts(
    [
      candidate({ alertId: "a1", ruleId: "SG-BEH-001", at: AT }),
      candidate({ alertId: "a2", ruleId: "SG-COR-T00", at: AT }),
    ],
    [rule()],
    { now: AT },
  );
  assert.deepEqual(withCorrelated, [], "the incident is not evidence for the incident");
});

test("correlation: severity floors, gates and caps behave", () => {
  assert.equal(worseSeverity("LOW", "CRITICAL"), "CRITICAL");
  assert.equal(worseSeverity("HIGH", "MEDIUM"), "HIGH");

  // A severity floor keeps mild detections out of an incident about a host.
  const gated = correlateAlerts(
    [
      candidate({ alertId: "a1", ruleId: "SG-BEH-001", severity: "LOW", asset: "web-01" }),
      candidate({ alertId: "a2", ruleId: "SG-SIG-001", severity: "CRITICAL", asset: "web-01" }),
    ],
    [rule({ groupBy: "asset", minSeverity: "MEDIUM" })],
    { now: AT },
  );
  assert.deepEqual(gated, [], "the LOW member is excluded, leaving one distinct rule");

  // The rule's severity is a *floor*: a CRITICAL member raises an incident whose rule says HIGH.
  const raised = correlateAlerts(
    [
      candidate({ alertId: "a1", ruleId: "SG-BEH-001", severity: "MEDIUM", asset: "web-01" }),
      candidate({ alertId: "a2", ruleId: "SG-SIG-001", severity: "CRITICAL", asset: "web-01" }),
    ],
    [rule({ groupBy: "asset", minSeverity: "MEDIUM" })],
    { now: AT },
  );
  assert.equal(raised[0].severity, "CRITICAL");

  // The member cap bounds what an incident carries, exactly as the evidence cap bounds an alert.
  const many = Array.from({ length: 9 }, (_, index) =>
    candidate({ alertId: `a${index}`, ruleId: `SG-R-${index}`, at: AT + index * 100 }),
  );
  const capped = correlateAlerts(many, [rule({ maxMembers: 3 })], { now: AT });
  assert.equal(capped[0].members.length, 3);
  assert.equal(capped[0].distinctRules.length, 3);
});

test("correlation: a rule's own id list narrows which alerts it considers", () => {
  const incidents = correlateAlerts(
    [
      candidate({ alertId: "a1", ruleId: "SG-BEH-001", at: AT }),
      candidate({ alertId: "a2", ruleId: "SG-SIG-001", at: AT }),
    ],
    [rule({ ruleIds: ["SG-SIG-001"] })],
    { now: AT },
  );
  assert.deepEqual(incidents, []);
});

test("correlation: the corpus has an id, and it is order-independent", () => {
  const version = correlationVersion();
  assert.match(version, /^[0-9a-f]{8}$/);
  assert.equal(correlationVersion([RECON_THEN_AUTH_CORRELATION, HOST_COMPROMISE_CORRELATION]), correlationVersion([HOST_COMPROMISE_CORRELATION, RECON_THEN_AUTH_CORRELATION]));
  assert.notEqual(version, correlationVersion([{ ...RECON_THEN_AUTH_CORRELATION, version: 2 }]));
  assert.equal(CORRELATION_RULES.length, 3);
});

/* -------------------------------------------------------------------------- */
/*  Through the pipeline                                                      */
/* -------------------------------------------------------------------------- */

let seq = 0;

/**
 * A fixed clock, passed to both the spine and the pipeline.
 *
 * Detection reads `nowMs()` for the moment it judges a batch against — the mute's window and
 * the cooldown bucket are both decided by it — so a test that let it read the real clock would
 * be asserting against whenever it happened to run. `ids` is written out rather than left to
 * the default for exactly that reason.
 */
function clock(tag: string) {
  let n = 0;
  return {
    id: () => `${tag}-${++n}`,
    now: () => new Date(AT).toISOString(),
    nowMs: () => AT,
  };
}

async function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const entities = new MemoryIdentityStore();
  const tag = `c${++seq}`;
  const spine = new IdentityService(entities, audit, clock(tag));
  const created = await spine.bootstrapOrganization("test", { name: `${tag} Inc`, slug: tag }, {
    identifier: `admin@${tag}.test`,
    displayName: "Admin",
  });
  assert.ok(created.ok, created.ok ? "" : created.error);
  const store = new MemoryAlertStore();
  // Its own id prefix as well as its own instance, so an alert can never share an id with the
  // identity the same test created.
  const ids = clock(`${tag}-alert`);
  const detection = new DetectionService(store, entities, audit, undefined, ids, sha256);
  return { store, detection, ids, organizationId: created.value.organization.id, audit };
}

test("correlation through the pipeline: two detections from one address raise one incident", async () => {
  const h = await harness();

  // A plaintext-management connection *and* a lateral sweep, both from 203.0.113.9. Each is one
  // alert; together they are the shape SG-COR-001 exists for.
  const telnet = { src_ip: "203.0.113.9", dst_ip: "10.0.0.5", dst_port: 23, proto: "tcp", direction: "OUTBOUND" };
  const sweep = Array.from({ length: 20 }, (_, index) => ({
    src_ip: "203.0.113.9",
    src_port: 40000 + index,
    dst_ip: `10.0.0.${index + 1}`,
    dst_port: 135,
    proto: "tcp",
    direction: "LATERAL",
  }));

  const ingested = await h.detection.ingest(h.organizationId, "NETFLOW", [telnet, ...sweep], { sensor: "fw-1", at: AT });
  assert.ok(ingested.ok, ingested.ok ? "" : ingested.error);

  const correlated = ingested.value.alerts.filter((alert) => alert.ruleId.startsWith("SG-COR-"));
  assert.equal(correlated.length, 1, "the detections are one incident");
  assert.equal(correlated[0].severity, "HIGH");
  assert.equal(correlated[0].created, true);

  const stored = (await h.detection.alerts({ id: "root", organizationId: h.organizationId, role: "ADMIN" }));
  assert.ok(stored.ok, stored.ok ? "" : stored.error);
  const incident = stored.value.find((alert: AlertRecord) => alert.ruleId === "SG-COR-001");
  assert.ok(incident, "the incident is a row in the same queue as every other alert");
  assert.equal(incident?.sourceAddress, "203.0.113.9");
  assert.equal(incident?.groupKey, "203.0.113.9");
  // Three detections agreed: the sweep trips both the scan threshold and the lateral-sweep one,
  // and the telnet connection is a third. `occurrences` is the membership, so it is three.
  assert.equal(incident?.occurrences, 3);
  // The contributing evidence is carried, so an analyst reading the incident at 09:00 is not
  // depending on a log buffer that rotated.
  assert.ok((incident?.evidence.length ?? 0) >= 21);
  assert.equal(incident?.assigneeId, null, "an incident is raised, not handed out");

  // The chain says the alert is a *group of* others and names them, so the record stands on its
  // own rather than requiring the queue to be reconstructed.
  const row = correlationRow(h.audit.trail(h.organizationId));
  assert.ok(row, "the correlation is on the chain");
  assert.equal(row?.groupBy, "sourceAddress");
  assert.deepEqual(row?.contributingRules, ["SG-BEH-001", "SG-BEH-004", "SG-SIG-001"]);
  assert.equal(row?.worstMemberSeverity, "HIGH");
  // This incident is *not* worse than its loudest member — the telnet signature is already HIGH —
  // and saying so is the point: correlation raised the *count*, not the severity.
  assert.equal(row?.escalated, false);

  // A second batch that sees the same intrusion again folds into the same row: one incident that
  // is still going, not a new one.
  const again = await h.detection.ingest(h.organizationId, "NETFLOW", [telnet, ...sweep], { sensor: "fw-1", at: AT + 1_000 });
  assert.ok(again.ok, again.ok ? "" : again.error);
  const second = again.value.alerts.filter((alert) => alert.ruleId.startsWith("SG-COR-"));
  assert.equal(second.length, 1);
  assert.equal(second[0].created, false, "the incident already exists");
  const still = (await h.detection.alerts({ id: "root", organizationId: h.organizationId, role: "ADMIN" }));
  assert.ok(still.ok);
  assert.equal(still.value.filter((alert: AlertRecord) => alert.ruleId === "SG-COR-001").length, 1);
});

test("correlation through the pipeline: a mute catches an incident too", async () => {
  const h = await harness();

  // A deployment that has muted the correlation rule is not told about the incident, exactly as
  // it is not told about the detections — the mute is one decision, not two.
  const detection = new DetectionService(
    h.store,
    new MemoryIdentityStore(),
    h.audit,
    undefined,
    h.ids,
    sha256,
    null,
    null,
    {
      activeSuppressions: async () => [
        {
          id: "mute-1",
          organizationId: h.organizationId,
          name: "known sweep",
          matcher: { ruleIds: ["SG-COR-001"], sourceAddresses: [], assets: [], devices: [], identityIds: [] },
          startsAt: new Date(AT - 3_600_000).toISOString(),
          endsAt: new Date(AT + 3_600_000).toISOString(),
          createdById: "root",
          createdByLabel: "Root",
          createdAt: new Date(AT).toISOString(),
        },
      ],
    },
  );

  const telnet = { src_ip: "203.0.113.9", dst_ip: "10.0.0.5", dst_port: 23, proto: "tcp", direction: "OUTBOUND" };
  const sweep = Array.from({ length: 20 }, (_, index) => ({
    src_ip: "203.0.113.9",
    dst_ip: `10.0.0.${index + 1}`,
    dst_port: 135,
    proto: "tcp",
    direction: "LATERAL",
  }));

  const ingested = await detection.ingest(h.organizationId, "NETFLOW", [telnet, ...sweep], { sensor: "fw-1", at: AT });
  assert.ok(ingested.ok, ingested.ok ? "" : ingested.error);
  assert.deepEqual(ingested.value.suppressed, [{ suppressionId: "mute-1", name: "known sweep", ruleId: "SG-COR-001" }]);
  assert.equal(ingested.value.alerts.some((alert) => alert.ruleId.startsWith("SG-COR-")), false);
});

test("correlation through the pipeline: the rule's severity is a floor, and escalation is recorded", async () => {
  const h = await harness();

  // A sweep alone: the scan threshold and the lateral-sweep rule both fire, both MEDIUM, so the
  // incident is HIGH because *the correlation rule says so* — the case where correlation really
  // did raise the severity rather than merely group what was already loud.
  const sweep = Array.from({ length: 20 }, (_, index) => ({
    src_ip: "198.51.100.4",
    dst_ip: `10.0.0.${index + 1}`,
    dst_port: 135,
    proto: "tcp",
    direction: "LATERAL",
  }));
  const ingested = await h.detection.ingest(h.organizationId, "NETFLOW", sweep, { sensor: "fw-1", at: AT });
  assert.ok(ingested.ok, ingested.ok ? "" : ingested.error);
  assert.deepEqual(
    ingested.value.alerts.filter((alert) => !alert.ruleId.startsWith("SG-COR-")).map((alert) => alert.ruleId),
    ["SG-BEH-001", "SG-BEH-004"],
  );

  const incident = correlationRow(h.audit.trail(h.organizationId));
  assert.ok(incident, "the two MEDIUM detections are one incident");
  assert.equal(incident?.severity, "HIGH", "the incident is above its worst member");
  assert.equal(incident?.worstMemberSeverity, "MEDIUM");
  assert.equal(incident?.escalated, true);
});

test("correlation through the pipeline: an empty corpus switches correlation off", async () => {
  const h = await harness();
  const detection = new DetectionService(h.store, new MemoryIdentityStore(), h.audit, undefined, h.ids, sha256, null, null, null, []);
  assert.deepEqual(detection.correlationRulebook(), []);

  const ingested = await detection.ingest(
    h.organizationId,
    "NETFLOW",
    [
      { src_ip: "203.0.113.9", dst_ip: "10.0.0.5", dst_port: 23, proto: "tcp", direction: "OUTBOUND" },
      { src_ip: "203.0.113.9", dst_ip: "10.0.0.6", dst_port: 135, proto: "tcp", direction: "LATERAL" },
    ],
    { sensor: "fw-1", at: AT },
  );
  assert.ok(ingested.ok, ingested.ok ? "" : ingested.error);
  assert.equal(ingested.value.alerts.some((alert) => alert.ruleId.startsWith("SG-COR-")), false);
});

test("correlation through the pipeline: toCorrelationCandidate reads the alert's own fields", async () => {
  const record: AlertRecord = {
    id: "a1",
    organizationId: "org",
    ruleId: "SG-BEH-001",
    ruleVersion: 1,
    ruleName: "a rule",
    severity: "MEDIUM",
    state: "NEW",
    dedupeKey: "k",
    groupKey: "g",
    sourceAddress: "203.0.113.7",
    identityId: "id-1",
    identityLabel: "ada@acme.test",
    device: "idp-01",
    asset: "auth-service",
    firstSeenAt: new Date(AT).toISOString(),
    lastSeenAt: new Date(AT).toISOString(),
    occurrences: 1,
    evidence: [],
    threatIntel: [],
    note: null,
    assigneeId: null,
    assigneeLabel: null,
    assignedAt: null,
    createdAt: new Date(AT).toISOString(),
    updatedAt: new Date(AT).toISOString(),
  };
  assert.deepEqual(toCorrelationCandidate(record), {
    alertId: "a1",
    ruleId: "SG-BEH-001",
    severity: "MEDIUM",
    at: AT,
    sourceAddress: "203.0.113.7",
    identityId: "id-1",
    asset: "auth-service",
    device: "idp-01",
  });

  // An unparseable timestamp lands at 0 rather than `NaN`: a candidate that cannot be placed in
  // time is one no window will contain, and `NaN` comparisons would silently be false everywhere.
  assert.equal(toCorrelationCandidate({ ...record, firstSeenAt: "not a time" }).at, 0);
});
