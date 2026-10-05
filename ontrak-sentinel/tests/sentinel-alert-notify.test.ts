/**
 * OnTrak Sentinel S4 tests: an alert somebody is told about, once.
 *
 * Delivery is the half of detection that makes a queue usable, so the cases are chosen
 * around the ways a notification system goes wrong rather than around the function:
 *
 *  - **One incident, one message.** A rule that fires repeatedly is *one* alert the store
 *    refreshes; delivering on every refresh would turn the cure for a noisy queue into the
 *    disease, so the second sighting must not send a second message.
 *  - **A transport never takes the alert down.** A pager that refuses, a webhook that is
 *    unreachable and an adapter that throws are all the same answer: the alert is what was
 *    detected, and "somebody was told" is a different claim — recorded on the chain, not
 *    assumed.
 *  - **Nothing is claimed with no transport.** A deployment that has not configured one must
 *    not be told its alerts are delivered anywhere.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import {
  HttpAlertNotifier,
  RecordingAlertNotifier,
  alertNotification,
  notifierFromEnv,
  type AlertNotification,
  type AlertNotifier,
  type NotifyOutcome,
} from "../src/lib/alert-notify";
import {
  DetectionService,
  MemoryAlertStore,
  type DetectionIds,
} from "../src/lib/detection-service";
import { DETECTION_RULES } from "../src/lib/detection-rules";
import { sha256Hex } from "../src/lib/hash";
import {
  IdentityService,
  MemoryIdentityStore,
  OrganizationAuditLog,
  type IdentityActor,
} from "../src/lib/identity-service";

const sha256: HashFn = sha256Hex;
const AT = Date.parse("2026-10-27T09:00:00.000Z");

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

/** A transport that answers with whatever the case needs, and records the calls. */
class StubNotifier implements AlertNotifier {
  readonly name: string;
  readonly calls: AlertNotification[] = [];
  private readonly answer: (event: AlertNotification) => Promise<NotifyOutcome>;

  constructor(name: string, answer: (event: AlertNotification) => Promise<NotifyOutcome>) {
    this.name = name;
    this.answer = answer;
  }

  async notify(event: AlertNotification): Promise<NotifyOutcome> {
    this.calls.push(event);
    return this.answer(event);
  }
}

let seq = 0;

function makeIds(tag: string, startMs: number): DetectionIds & { advance(ms: number): void } {
  let clock = startMs;
  let n = 0;
  return {
    id: () => `${tag}-id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
    advance(ms: number) {
      clock += ms;
    },
  };
}

async function harness(notifier: AlertNotifier | null) {
  const audit = new OrganizationAuditLog(sha256);
  const entities = new MemoryIdentityStore();
  const store = new MemoryAlertStore();
  const tag = `n${++seq}`;
  const ids = makeIds(tag, AT);
  const spine = new IdentityService(entities, audit, ids);
  // Positional, like the deployment's wiring: the feed (null here) has to be named to reach
  // the transport, which is deliberately last.
  const detection = new DetectionService(
    store,
    entities,
    audit,
    DETECTION_RULES,
    ids,
    sha256,
    null,
    notifier,
  );

  const created = await spine.bootstrapOrganization(
    "test",
    { name: "Notify Inc", slug: "notify" },
    { identifier: "admin@notify.test", displayName: "Admin" },
  );
  assert.ok(created.ok, created.ok ? "" : created.error);

  const organizationId = created.value.organization.id;
  const actor: IdentityActor = { id: created.value.admin.id, organizationId, role: "ADMIN" };
  return { audit, store, detection, ids, spine, organizationId, actor };
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

/** Five failures and a success: one credential-stuffing alert the rule will fire on. */
const credentialStuffing = () => [
  ...Array.from({ length: 5 }, (_, index) => authEvent("failure", AT + index * 1_000)),
  authEvent("success", AT + 6_000),
];

function sampleNotification(over: Partial<AlertNotification> = {}): AlertNotification {
  return {
    alertId: "alert_1",
    organizationId: "org_1",
    ruleId: "SG-BEH-002",
    ruleName: "Credential stuffing",
    ruleVersion: 1,
    severity: "CRITICAL",
    sourceAddress: "203.0.113.7",
    identityId: null,
    identityLabel: null,
    device: "idp-01",
    asset: "auth-service",
    firstSeenAt: new Date(AT).toISOString(),
    lastSeenAt: new Date(AT + 6_000).toISOString(),
    occurrences: 6,
    dedupeKey: "SG-BEH-002@1|203.0.113.7|1",
    threatIntel: 0,
    ...over,
  };
}

const notified = (audit: OrganizationAuditLog, organizationId: string, action: string) =>
  audit.trail(organizationId).filter((event) => event.action === action);

/* -------------------------------------------------------------------------- */
/*  Delivery, wired into the pipeline                                         */
/* -------------------------------------------------------------------------- */

test("an alert is delivered once, when it is raised", async () => {
  const notifier = new RecordingAlertNotifier();
  const h = await harness(notifier);

  const ingested = await h.detection.ingest(h.organizationId, "SYSLOG", credentialStuffing(), {
    sensor: "idp-collector",
  });
  assert.ok(ingested.ok, ingested.ok ? "" : ingested.error);
  assert.equal(ingested.value.alerts.length, 1);
  assert.equal(ingested.value.alerts[0]?.created, true);

  // The transport is told the alert's own summary — what it is, how bad, and the key the
  // queue stores it under, so the message can be joined back to the row.
  assert.equal(notifier.delivered.length, 1);
  const told = notifier.delivered[0]!;
  assert.equal(told.alertId, ingested.value.alerts[0]!.id);
  assert.equal(told.organizationId, h.organizationId);
  assert.equal(told.ruleId, "SG-BEH-002");
  assert.equal(told.severity, "CRITICAL");
  assert.equal(told.sourceAddress, "203.0.113.7");
  assert.equal(told.device, "idp-01");
  assert.equal(told.asset, "auth-service");
  assert.ok(told.dedupeKey.length > 0);

  // And the chain says the transport was told, by name.
  const rows = notified(h.audit, h.organizationId, "guard.alert.notified");
  assert.equal(rows.length, 1);
  assert.equal((rows[0]?.detail as { transport?: string }).transport, "recording");
});

test("a repeat refreshes the alert and does not deliver it again", async () => {
  const notifier = new RecordingAlertNotifier();
  const h = await harness(notifier);

  await h.detection.ingest(h.organizationId, "SYSLOG", credentialStuffing(), { sensor: "collector-a" });
  // The same burst reported by a second sensor: the store dedupes it to one incident.
  const again = await h.detection.ingest(h.organizationId, "SYSLOG", credentialStuffing(), {
    sensor: "collector-b",
  });
  assert.ok(again.ok, again.ok ? "" : again.error);
  assert.equal(again.value.alerts.length, 1);
  assert.equal(again.value.alerts[0]?.created, false, "the same incident, refreshed");

  assert.equal(notifier.delivered.length, 1, "one incident, one message");
  assert.equal(notified(h.audit, h.organizationId, "guard.alert.notified").length, 1);
  assert.equal(notified(h.audit, h.organizationId, "guard.alert.repeated").length, 1);
});

test("a transport that refuses is recorded and does not undo the alert", async () => {
  const notifier = new StubNotifier("pager", async () => ({ ok: false, error: "pager is down" }));
  const h = await harness(notifier);

  await h.detection.ingest(h.organizationId, "SYSLOG", credentialStuffing(), { sensor: "idp-collector" });

  // The alert is what was detected; a transport that could not be reached is a fact about
  // the transport, and the row stays exactly where it is.
  const alerts = await h.detection.alerts(h.actor);
  assert.ok(alerts.ok, alerts.ok ? "" : alerts.error);
  assert.equal(alerts.value.length, 1);

  const rows = notified(h.audit, h.organizationId, "guard.alert.notify.failed");
  assert.equal(rows.length, 1);
  const detail = rows[0]?.detail as { transport?: string; error?: string };
  assert.equal(detail.transport, "pager");
  assert.match(String(detail.error), /pager is down/);
  assert.equal(notified(h.audit, h.organizationId, "guard.alert.notified").length, 0);
});

test("a transport that throws is held to the same answer as one that refuses", async () => {
  const notifier = new StubNotifier("broken", async () => {
    throw new Error("the adapter is broken");
  });
  const h = await harness(notifier);

  const ingested = await h.detection.ingest(h.organizationId, "SYSLOG", credentialStuffing(), {
    sensor: "idp-collector",
  });
  assert.ok(ingested.ok, ingested.ok ? "" : ingested.error);

  const alerts = await h.detection.alerts(h.actor);
  assert.ok(alerts.ok, alerts.ok ? "" : alerts.error);
  assert.equal(alerts.value.length, 1, "the detection is unaffected by the transport");

  const rows = notified(h.audit, h.organizationId, "guard.alert.notify.failed");
  assert.equal(rows.length, 1);
  assert.match(String((rows[0]?.detail as { error?: string }).error), /the adapter is broken/);
});

test("no transport means nothing is claimed", async () => {
  const h = await harness(null);
  const ingested = await h.detection.ingest(h.organizationId, "SYSLOG", credentialStuffing(), {
    sensor: "idp-collector",
  });
  assert.ok(ingested.ok, ingested.ok ? "" : ingested.error);

  // The alert is raised and queued exactly as before the seam existed, and the chain does
  // not pretend anybody was told.
  assert.equal(ingested.value.alerts.length, 1);
  assert.equal(notified(h.audit, h.organizationId, "guard.alert.notified").length, 0);
  assert.equal(notified(h.audit, h.organizationId, "guard.alert.notify.failed").length, 0);
});

/* -------------------------------------------------------------------------- */
/*  The projection and the HTTP transport                                     */
/* -------------------------------------------------------------------------- */

test("the projection carries the summary and not the evidence", () => {
  const event = alertNotification({
    id: "a1",
    organizationId: "org_1",
    ruleId: "SG-BEH-002",
    ruleVersion: 3,
    ruleName: "Credential stuffing",
    severity: "HIGH",
    state: "NEW",
    dedupeKey: "k",
    groupKey: "g",
    sourceAddress: "203.0.113.7",
    identityId: "id_1",
    identityLabel: "ada@acme.test",
    device: "idp-01",
    asset: "auth-service",
    firstSeenAt: new Date(AT).toISOString(),
    lastSeenAt: new Date(AT).toISOString(),
    occurrences: 2,
    evidence: [{ note: "not for the wire" }] as never,
    threatIntel: [
      { indicator: { id: "i1" }, field: "sourceAddress" },
      { indicator: { id: "i2" }, field: "sourceAddress" },
    ] as never,
    note: null,
    assigneeId: null,
    assigneeLabel: null,
    assignedAt: null,
    createdAt: new Date(AT).toISOString(),
    updatedAt: new Date(AT).toISOString(),
  });

  assert.equal(event.ruleVersion, 3);
  assert.equal(event.identityLabel, "ada@acme.test");
  assert.equal(event.occurrences, 2);
  // The observations stay in the queue; what travels is how many indicators made it loud.
  assert.equal(event.threatIntel, 2);
  assert.equal("evidence" in event, false);
});

test("the HTTP transport posts the notification, and believes only a 2xx", async (t) => {
  await t.test("a 2xx is delivered, with the token when one is set", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const transport = new HttpAlertNotifier({
      url: "https://pager.example/hook",
      token: "secret-token",
      fetchImpl: (async (url: unknown, init: unknown) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return new Response("{}", { status: 202 });
      }) as unknown as typeof fetch,
    });

    assert.equal(transport.name, "http:pager.example");
    const outcome = await transport.notify(sampleNotification());
    assert.equal(outcome.ok, true);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://pager.example/hook");
    assert.equal(calls[0]!.init.method, "POST");
    const headers = new Headers(calls[0]!.init.headers);
    assert.equal(headers.get("authorization"), "Bearer secret-token");
    const body = JSON.parse(String(calls[0]!.init.body)) as AlertNotification;
    assert.equal(body.ruleId, "SG-BEH-002");
    assert.equal(body.severity, "CRITICAL");
  });

  await t.test("no token is no header", async () => {
    let headers: Headers | null = null;
    const transport = new HttpAlertNotifier({
      url: "https://pager.example/hook",
      fetchImpl: (async (_url: unknown, init: unknown) => {
        headers = new Headers((init as RequestInit).headers);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    await transport.notify(sampleNotification());
    assert.equal(headers!.get("authorization"), null);
  });

  await t.test("a refusal carries the transport's own words", async () => {
    const transport = new HttpAlertNotifier({
      url: "https://pager.example/hook",
      fetchImpl: (async () => new Response("no such channel", { status: 404 })) as unknown as typeof fetch,
    });
    const outcome = await transport.notify(sampleNotification());
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.error, /404: no such channel/);
  });

  await t.test("an unreachable transport is an outcome, not a throw", async () => {
    const transport = new HttpAlertNotifier({
      url: "https://pager.example/hook",
      fetchImpl: (async () => {
        throw new Error("getaddrinfo ENOTFOUND pager.example");
      }) as unknown as typeof fetch,
    });
    const outcome = await transport.notify(sampleNotification());
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.error, /unreachable/);
  });
});

test("no transport is the default, and a URL is how a deployment names one", () => {
  assert.equal(notifierFromEnv({}), null);
  assert.equal(notifierFromEnv({ SENTINEL_ALERT_WEBHOOK_URL: "   " }), null);

  const built = notifierFromEnv({ SENTINEL_ALERT_WEBHOOK_URL: "https://pager.example/hook" });
  assert.equal(built?.name, "http:pager.example");
});
