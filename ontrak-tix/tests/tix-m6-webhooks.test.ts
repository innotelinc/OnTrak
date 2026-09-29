/**
 * OnTrak Tix M6 tests: webhook subscriptions, deliveries and the delivery log.
 *
 * A webhook is the one request this product makes *outward*, on its own
 * initiative, to an address a customer typed — so each test follows one of the
 * ways that goes wrong:
 *
 *  1. a destination we should never have registered (plain `http`, a fragment, a
 *     URL carrying credentials);
 *  2. a delivery a receiver cannot prove came from us, or cannot refuse as a
 *     replay;
 *  3. a failure that is retried forever, or dropped silently, instead of
 *     retrying on a schedule a person can read and then stopping;
 *  4. an attempt that happened but left no trace to reconcile against.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m6-webhooks.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AuditLog } from "../src/lib/audit-chain";
import type { Actor } from "../src/lib/access-rules";
import { sha256Hex } from "../src/lib/ticket-store-prisma";
import {
  DELIVERY_MAX_ATTEMPTS,
  applyDeliveryAttempt,
  deliveryDue,
  deliveryHeaders,
  endpointsFor,
  eventEnvelope,
  isDeliverySuccess,
  isRegistrableWebhookUrl,
  retryDelaySeconds,
  retrySchedule,
  signaturePayload,
  validateWebhookEndpoint,
  type WebhookDeliveryRecord,
} from "../src/lib/webhook-rules";
import {
  MemoryWebhookStore,
  WebhookService,
  webhookSignature,
  type TransportOutcome,
  type WebhookIds,
  type WebhookTransport,
} from "../src/lib/webhook-service";

const ADMIN: Actor = { id: "admin-1", tenantId: "tenant-a", role: "ADMIN" };
const URL_ONE = "https://hooks.example.test/ontrak";

/* -------------------------------------------------------------------------- */
/*  A harness                                                                 */
/* -------------------------------------------------------------------------- */

class FakeTransport implements WebhookTransport {
  readonly requests: { url: string; headers: Record<string, string>; body: string; timeoutMs: number }[] = [];

  constructor(private readonly reply: (attempt: number) => TransportOutcome = () => ({ statusCode: 200, error: null })) {}

  async send(request: { url: string; headers: Record<string, string>; body: string; timeoutMs: number }): Promise<TransportOutcome> {
    this.requests.push(request);
    return this.reply(this.requests.length);
  }
}

const CLOCK_START = Date.parse("2026-09-30T10:00:00.000Z");

function harness(reply?: (attempt: number) => TransportOutcome) {
  let clock = CLOCK_START;
  let n = 0;
  const ids: WebhookIds = {
    id: () => `delivery-${++n}`,
    secret: () => `whsec_secret-${++n}-bbbbbbbbbbbbbbbbbbbbbb`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };
  const audit = new AuditLog(sha256Hex);
  const store = new MemoryWebhookStore();
  const transport = new FakeTransport(reply);
  const service = new WebhookService(store, transport, audit, ids);
  return {
    service,
    store,
    audit,
    transport,
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
    nowMs: () => clock,
  };
}

function delivery(overrides: Partial<WebhookDeliveryRecord> = {}): WebhookDeliveryRecord {
  return {
    id: "d1",
    tenantId: "tenant-a",
    endpointId: "e1",
    event: "ticket.created",
    payload: "{}",
    status: "PENDING",
    attemptCount: 0,
    firstAttemptAt: null,
    lastAttemptAt: null,
    lastStatusCode: null,
    lastError: null,
    nextAttemptAt: null,
    deliveredAt: null,
    createdAt: CLOCK_START,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Rules                                                                     */
/* -------------------------------------------------------------------------- */

test("a webhook URL is only registered over https, or http on loopback", () => {
  assert.equal(isRegistrableWebhookUrl(URL_ONE), true);
  assert.equal(isRegistrableWebhookUrl("http://localhost:4000/hooks"), true, "a developer's tunnel is testable");
  assert.equal(isRegistrableWebhookUrl("http://hooks.example.test/ontrak"), false, "plain http puts ticket text on the wire");
  // A fragment is never sent to the server, so the payload would be signed and
  // then dropped on the floor.
  assert.equal(isRegistrableWebhookUrl(`${URL_ONE}#frag`), false);
  // An address carrying credentials is not somewhere a payload should be posted.
  assert.equal(isRegistrableWebhookUrl("https://user:pass@hooks.example.test/x"), false);
  assert.equal(isRegistrableWebhookUrl("not a url"), false);

  assert.deepEqual(validateWebhookEndpoint({ name: "Zabbix", url: URL_ONE, events: ["ticket.created"] }), []);
  assert.equal(validateWebhookEndpoint({ name: "", url: URL_ONE, events: ["ticket.created"] }).length, 1);
  assert.equal(validateWebhookEndpoint({ name: "x", url: "", events: ["ticket.created"] }).length, 1);
  assert.equal(validateWebhookEndpoint({ name: "x", url: URL_ONE, events: [] }).length, 1);
  assert.equal(validateWebhookEndpoint({ name: "x", url: URL_ONE, events: ["ticket.exploded"] }).length, 1);
  assert.equal(validateWebhookEndpoint({ name: "x", url: URL_ONE, events: ["ticket.created", "ticket.created"] }).length, 1);
});

test("a disabled endpoint asks for nothing, whatever it subscribed to", () => {
  const endpoint = {
    id: "e1",
    tenantId: "tenant-a",
    name: "one",
    url: URL_ONE,
    events: ["ticket.created" as const],
    secret: "whsec_x",
    enabled: true,
    createdBy: "admin-1",
    createdAt: "2026-09-30T00:00:00.000Z",
    disabledAt: null,
  };
  assert.equal(endpointsFor([endpoint], "ticket.created").length, 1);
  assert.equal(endpointsFor([endpoint], "ticket.replied").length, 0);
  assert.equal(endpointsFor([{ ...endpoint, enabled: false }], "ticket.created").length, 0);
});

test("a delivery is signed over the timestamp and the body, so a replay is refusable", () => {
  const body = '{"type":"ticket.created"}';
  // The timestamp comes first: a receiver checks it over bytes it has already
  // authenticated, and a replay carries the original timestamp it can refuse.
  assert.equal(signaturePayload(1_700_000_000, body), `1700000000.${body}`);
  assert.equal(signatureHeaderFor(webhookSignature("whsec_s", signaturePayload(1, body))), `v1=${webhookSignature("whsec_s", "1." + body)}`);

  const headers = deliveryHeaders({ event: "ticket.created", deliveryId: "d1", nowSeconds: 1_700_000_000, signatureHex: "abc" });
  assert.equal(headers["x-ontrak-event"], "ticket.created");
  assert.equal(headers["x-ontrak-timestamp"], "1700000000");
  assert.equal(headers["x-ontrak-delivery"], "d1");
  assert.equal(headers["x-ontrak-signature"], "v1=abc");

  // A different secret is a different signature, which is the whole point.
  assert.notEqual(webhookSignature("whsec_a", "1.x"), webhookSignature("whsec_b", "1.x"));
});

/** The `v1=` wrapper, imported lazily to keep this file's imports to one block. */
function signatureHeaderFor(digest: string): string {
  return `v1=${digest}`;
}

test("retries back off exponentially and then stop", () => {
  assert.deepEqual(retrySchedule(), [
    { attempt: 2, delaySeconds: 30 },
    { attempt: 3, delaySeconds: 60 },
    { attempt: 4, delaySeconds: 120 },
    { attempt: 5, delaySeconds: 240 },
  ]);
  assert.equal(retryDelaySeconds(1), 30);
  // Capped, so the fourth retry is not scheduled for next week.
  assert.equal(retryDelaySeconds(20), 6 * 60 * 60);
});

test("an attempt is folded into a delivery, and only five of them are tried", () => {
  const now = CLOCK_START;

  const delivered = applyDeliveryAttempt(delivery(), { statusCode: 204, error: null }, now);
  assert.equal(delivered.status, "DELIVERED");
  assert.equal(delivered.attemptCount, 1);
  assert.equal(delivered.deliveredAt, now);
  assert.equal(delivered.nextAttemptAt, null, "a delivered delivery is owed nothing");

  const retrying = applyDeliveryAttempt(delivery(), { statusCode: 500, error: null }, now);
  assert.equal(retrying.status, "RETRYING");
  assert.equal(retrying.nextAttemptAt, now + 30_000, "the first retry is thirty seconds away");
  assert.equal(retrying.lastStatusCode, 500);

  // A timeout is a failure with no status code — not a `0`, and not a success.
  const timedOut = applyDeliveryAttempt(delivery(), { statusCode: null, error: "the request timed out" }, now);
  assert.equal(timedOut.status, "RETRYING");
  assert.equal(timedOut.lastStatusCode, null);
  assert.match(timedOut.lastError ?? "", /timed out/);

  // The fifth failure is the last attempt: `EXHAUSTED` is a terminal state with a
  // count, not a silent drop.
  const final = applyDeliveryAttempt(delivery({ attemptCount: DELIVERY_MAX_ATTEMPTS - 1 }), { statusCode: 503, error: null }, now);
  assert.equal(final.status, "EXHAUSTED");
  assert.equal(final.attemptCount, DELIVERY_MAX_ATTEMPTS);
  assert.equal(final.nextAttemptAt, null);

  // 2xx is delivered and nothing else is.
  assert.equal(isDeliverySuccess(200), true);
  assert.equal(isDeliverySuccess(299), true);
  assert.equal(isDeliverySuccess(302), false, "a redirect is not a delivery we can call successful");
  assert.equal(isDeliverySuccess(429), false);
});

test("only what is due is attempted", () => {
  assert.equal(deliveryDue(delivery(), CLOCK_START), true, "a never-tried delivery is due immediately");
  assert.equal(deliveryDue(delivery({ status: "DELIVERED" }), CLOCK_START), false);
  assert.equal(deliveryDue(delivery({ status: "EXHAUSTED" }), CLOCK_START), false);
  assert.equal(deliveryDue(delivery({ status: "RETRYING", nextAttemptAt: CLOCK_START + 30_000 }), CLOCK_START), false);
  assert.equal(deliveryDue(delivery({ status: "RETRYING", nextAttemptAt: CLOCK_START + 30_000 }), CLOCK_START + 30_000), true);
});

test("the event envelope is self-describing and versioned", () => {
  const body = JSON.parse(
    eventEnvelope({ id: "e1", type: "ticket.created", tenantId: "tenant-a", at: "2026-09-30T10:00:00.000Z", data: { ref: "T-1" } }),
  );
  assert.equal(body.type, "ticket.created");
  assert.equal(body.api_version, "v1");
  assert.equal(body.tenant_id, "tenant-a");
  assert.equal(body.created_at, "2026-09-30T10:00:00.000Z");
  assert.deepEqual(body.data, { ref: "T-1" });
});

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

test("registering an endpoint needs tenant:manage, and its secret is shown once", async () => {
  const h = harness();
  const agent: Actor = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" };
  assert.equal((await h.service.register(agent, { name: "x", url: URL_ONE, events: ["ticket.created"] })).ok, false);

  const created = await h.service.register(ADMIN, { name: "Zabbix", url: URL_ONE, events: ["ticket.created"] });
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) throw new Error("unreachable");
  assert.match(created.value.secret, /^whsec_/);
  assert.equal(created.value.endpoint.secret, created.value.secret);

  // A second endpoint with the same name is refused: two "Zabbix" rows is a
  // console nobody can use.
  assert.equal((await h.service.register(ADMIN, { name: "zabbix", url: "https://other.test/x", events: ["ticket.created"] })).ok, false);
  // And another tenant is a different tenant.
  const other: Actor = { id: "admin-2", tenantId: "tenant-b", role: "ADMIN" };
  assert.equal((await h.service.register(other, { name: "Zabbix", url: "https://other.test/x", events: ["ticket.created"] })).ok, true);

  const listed = await h.service.list(ADMIN);
  assert.equal(listed.ok && listed.value.length, 1, "listing is scoped to the tenant");

  const rotated = await h.service.rotateSecret(ADMIN, created.value.endpoint.id);
  assert.equal(rotated.ok, true);
  assert.notEqual(rotated.ok && rotated.value.secret, created.value.secret, "rotation is a new secret");
});

test("a disabled endpoint is delivered to again when it is switched back on, and never while off", async () => {
  const h = harness();
  const created = await h.service.register(ADMIN, { name: "Zabbix", url: URL_ONE, events: ["ticket.created"] });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("unreachable");
  const id = created.value.endpoint.id;

  assert.equal((await h.service.setEnabled(ADMIN, id, false)).ok, true);
  const whileOff = await h.service.emit("tenant-a", "ticket.created", { ref: "T-1" });
  assert.equal(whileOff.endpoints, 0, "a disabled endpoint asked for nothing");
  assert.equal(h.transport.requests.length, 0);

  assert.equal((await h.service.setEnabled(ADMIN, id, true)).ok, true);
  const whileOn = await h.service.emit("tenant-a", "ticket.created", { ref: "T-2" });
  assert.equal(whileOn.endpoints, 1);
  assert.equal(h.transport.requests.length, 1);
});

test("one event reaches every subscribed endpoint, with its own signature", async () => {
  const h = harness();
  const one = await h.service.register(ADMIN, { name: "Zabbix", url: URL_ONE, events: ["ticket.created"] });
  const two = await h.service.register(ADMIN, { name: "Slack", url: "https://slack.example.test/hook", events: ["ticket.created"] });
  // A third endpoint that did not ask for this event gets nothing.
  await h.service.register(ADMIN, { name: "Other", url: "https://other.test/x", events: ["ticket.replied"] });
  assert.equal(one.ok && two.ok, true);
  if (!one.ok || !two.ok) throw new Error("unreachable");

  const result = await h.service.emit("tenant-a", "ticket.created", { ref: "T-9", subject: "Printer" });
  assert.equal(result.endpoints, 2);
  assert.equal(result.deliveries.length, 2);
  assert.equal(result.deliveries.every((entry) => entry.status === "DELIVERED"), true);
  assert.equal(result.deliveries.every((entry) => entry.statusCode === 200), true);

  // Each request is signed with *its own endpoint's* secret, so one customer's
  // leaked secret cannot be used to forge another's deliveries.
  const [first, second] = h.transport.requests;
  assert.equal(first.url, URL_ONE);
  assert.equal(second.url, "https://slack.example.test/hook");
  const firstTs = first.headers["x-ontrak-timestamp"];
  assert.equal(first.headers["x-ontrak-signature"], `v1=${webhookSignature(one.value.secret, `${firstTs}.${first.body}`)}`);
  assert.equal(second.headers["x-ontrak-signature"], `v1=${webhookSignature(two.value.secret, `${second.headers["x-ontrak-timestamp"]}.${second.body}`)}`);
  assert.deepEqual(JSON.parse(first.body).data, { ref: "T-9", subject: "Printer" });
  assert.equal(first.headers["x-ontrak-event"], "ticket.created");
  assert.equal(first.headers["x-ontrak-delivery"], result.deliveries[0].deliveryId);

  // Every attempt is on the chain, so "how many times did we tell them?" is
  // answered from the same history as the ticket.
  const actions = h.audit.snapshot().events.map((event) => event.action);
  assert.equal(actions.filter((action) => action === "webhook.delivered").length, 2);
});

test("a failed delivery retries on schedule, then stops, and the log says which", async () => {
  // The receiver fails until the fourth attempt, then accepts.
  const h = harness((attempt) => (attempt < 4 ? { statusCode: 502, error: null } : { statusCode: 200, error: null }));
  await h.service.register(ADMIN, { name: "Zabbix", url: URL_ONE, events: ["ticket.created"] });

  const emitted = await h.service.emit("tenant-a", "ticket.created", { ref: "T-1" });
  assert.equal(emitted.deliveries[0].status, "RETRYING");
  assert.equal(h.transport.requests.length, 1);

  // Nothing is due yet, so the sweep does nothing — running it twice must not
  // deliver twice.
  assert.deepEqual(await h.service.deliverDue("tenant-a"), { considered: 0, delivered: 0, retrying: 0, exhausted: 0 });

  h.advance(30);
  const second = await h.service.deliverDue("tenant-a");
  assert.equal(second.delivered, 0);
  assert.equal(second.retrying, 1);
  assert.equal(h.transport.requests.length, 2);

  h.advance(60);
  const third = await h.service.deliverDue("tenant-a");
  assert.equal(third.retrying, 1);

  h.advance(120);
  const fourth = await h.service.deliverDue("tenant-a");
  assert.equal(fourth.delivered, 1, "the fourth attempt is accepted");
  assert.equal(h.transport.requests.length, 4);

  // The log reads the way a person would narrate it.
  const log = await h.service.listDeliveries(ADMIN);
  assert.equal(log.ok, true);
  if (!log.ok) throw new Error("unreachable");
  assert.equal(log.value.length, 1);
  assert.equal(log.value[0].delivery.status, "DELIVERED");
  assert.equal(log.value[0].delivery.attemptCount, 4);
  assert.equal(log.value[0].endpointName, "Zabbix");
  assert.equal(log.value[0].delivery.payload.includes('"type":"ticket.created"'), true, "the exact bytes are kept");
});

test("a receiver that never answers is given up on, not retried forever", async () => {
  const h = harness(() => ({ statusCode: 500, error: null }));
  await h.service.register(ADMIN, { name: "Broken", url: URL_ONE, events: ["ticket.created"] });
  await h.service.emit("tenant-a", "ticket.created", { ref: "T-1" });

  // Walk the whole schedule: 30, 60, 120, 240 seconds.
  for (const seconds of [30, 60, 120, 240]) {
    h.advance(seconds);
    await h.service.deliverDue("tenant-a");
  }

  assert.equal(h.transport.requests.length, DELIVERY_MAX_ATTEMPTS);
  const log = await h.service.listDeliveries(ADMIN, { status: "EXHAUSTED" });
  assert.equal(log.ok && log.value.length, 1);
  // An exhausted delivery is not in the worklist again, however long we wait.
  h.advance(24 * 60 * 60);
  assert.equal((await h.service.deliverDue("tenant-a")).considered, 0);
  assert.equal(h.transport.requests.length, DELIVERY_MAX_ATTEMPTS);

  const actions = h.audit.snapshot().events.map((event) => event.action);
  assert.equal(actions.filter((action) => action === "webhook.delivery_failed").length, DELIVERY_MAX_ATTEMPTS);
});

test("removing an endpoint stops its deliveries but keeps the log that says we tried", async () => {
  const h = harness();
  const created = await h.service.register(ADMIN, { name: "Gone", url: URL_ONE, events: ["ticket.created"] });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("unreachable");

  await h.service.emit("tenant-a", "ticket.created", { ref: "T-1" });
  const removed = await h.service.remove(ADMIN, created.value.endpoint.id);
  assert.equal(removed.ok, true);

  // The delivery stays, so "did you tell us?" is still answerable about an
  // endpoint that no longer exists — which is exactly when somebody asks.
  const log = await h.service.listDeliveries(ADMIN);
  assert.equal(log.ok && log.value.length, 1);
  assert.equal(log.ok && log.value[0].endpointName, null);

  // And a later event is not delivered to it, nor retried into the void.
  assert.equal((await h.service.emit("tenant-a", "ticket.created", { ref: "T-2" })).endpoints, 0);
  assert.deepEqual(await h.service.deliverDue("tenant-a"), { considered: 0, delivered: 0, retrying: 0, exhausted: 0 });

  const actions = h.audit.snapshot().events.map((event) => event.action);
  assert.ok(actions.includes("webhook.endpoint.remove"));
});

test("the delivery log filters by endpoint and status, and is scoped to the tenant", async () => {
  const h = harness();
  const one = await h.service.register(ADMIN, { name: "One", url: URL_ONE, events: ["ticket.created"] });
  const two = await h.service.register(ADMIN, { name: "Two", url: "https://two.example.test/x", events: ["ticket.created"] });
  assert.equal(one.ok && two.ok, true);
  if (!one.ok || !two.ok) throw new Error("unreachable");

  // Another tenant has its own endpoint, and its own deliveries.
  const other: Actor = { id: "admin-2", tenantId: "tenant-b", role: "ADMIN" };
  const theirs = await h.service.register(other, { name: "Theirs", url: "https://theirs.example.test/x", events: ["ticket.created"] });
  assert.equal(theirs.ok, true, theirs.ok ? "" : theirs.error);

  await h.service.emit("tenant-a", "ticket.created", { ref: "T-1" });
  await h.service.emit("tenant-b", "ticket.created", { ref: "T-other" });

  const both = await h.service.listDeliveries(ADMIN);
  assert.equal(both.ok && both.value.length, 2);

  const onlyOne = await h.service.listDeliveries(ADMIN, { endpointId: one.value.endpoint.id });
  assert.equal(onlyOne.ok && onlyOne.value.length, 1);

  const noneRetrying = await h.service.listDeliveries(ADMIN, { status: "RETRYING" });
  assert.equal(noneRetrying.ok && noneRetrying.value.length, 0);

  // A delivery in another tenant is simply not there.
  const theirLog = await h.service.listDeliveries(other);
  assert.equal(theirLog.ok && theirLog.value.length, 1);
  assert.equal(theirLog.ok && theirLog.value[0].delivery.tenantId, "tenant-b");
});
