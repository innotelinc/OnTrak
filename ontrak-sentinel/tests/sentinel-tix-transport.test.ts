/**
 * OnTrak Sentinel S5 tests: the delivery to OnTrak Tix.
 *
 * The seam (`alert-notify.ts`) is tested on its own terms elsewhere — one alert, one
 * notification, a transport never throws, a refusal is data. What these tests add is the part
 * that only exists because the two products are one family: the *contract*.
 *
 *  - **The payload is Tix's, and it carries what a desk needs.** Field names are the desk's,
 *    and the two facts the summary alone does not have — the corpus the alert was judged by and
 *    the rule's ATT&CK techniques — travel with it, derived from the rulebook this deployment
 *    runs rather than invented.
 *  - **A delivery is signed over its bytes.** `timestamp.body`, so an edited timestamp is a
 *    failed signature and a body captured from a log is unusable after the window; a test pins
 *    the exact bytes and the exact header, because a signature nobody can reproduce on the other
 *    side is a signature that stops working silently.
 *  - **A refusal is an outcome.** A `401` from the desk is recorded as the desk's own words, not
 *    raised as an exception that would take the detection down with it.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { alertNotification, type AlertNotification } from "../src/lib/alert-notify";
import { DETECTION_RULES, CREDENTIAL_STUFFING_RULE } from "../src/lib/detection-rules";
import type { AlertRecord } from "../src/lib/detection-service";
import {
  TIX_SENTINEL_VENDOR,
  TIX_SIGNATURE_HEADER,
  TIX_TIMESTAMP_HEADER,
  TIX_TRANSPORT_ENV,
  TixAlertTransport,
  sentinelSignature,
  tixAlertPayload,
  tixDeliveryPreview,
  tixTransportFromEnv,
} from "../src/lib/tix-alert-transport";

const AT = "2026-10-27T09:00:00.000Z";

function notification(over: Partial<AlertNotification> = {}): AlertNotification {
  return {
    alertId: "alert-1",
    organizationId: "org-1",
    ruleId: "SG-BEH-002",
    ruleName: "Failed sign-ins followed by a success from one address",
    ruleVersion: 1,
    severity: "CRITICAL",
    sourceAddress: "203.0.113.7",
    identityId: "id-1",
    identityLabel: "ada@acme.test",
    device: "idp-01",
    asset: "auth-service",
    firstSeenAt: AT,
    lastSeenAt: AT,
    occurrences: 6,
    dedupeKey: "SG-BEH-002@1|203.0.113.7|1",
    threatIntel: 2,
    ...over,
  };
}

test("tix transport: the payload is the desk's contract, and it keeps the corpus and the techniques", () => {
  const payload = tixAlertPayload(notification(), DETECTION_RULES);

  assert.equal(payload.vendor, TIX_SENTINEL_VENDOR, "the desk tells this apart from a third-party sensor");
  assert.equal(payload.alertId, "alert-1");
  assert.equal(payload.ruleId, "SG-BEH-002");
  // Derived from the rulebook this deployment runs, not sent by the sensor: the techniques are
  // a property of the rule, and the rule belongs to the corpus.
  assert.deepEqual(payload.techniques, ["T1110", "T1078"]);
  assert.equal(payload.ruleDescription, CREDENTIAL_STUFFING_RULE.description);
  assert.deepEqual(payload.ruleReferences, [...CREDENTIAL_STUFFING_RULE.references]);
  assert.equal(typeof payload.rulebookVersion, "string");
  assert.match(String(payload.rulebookVersion), /^[0-9a-f]{12}$/);
  assert.equal(payload.threatIntelCount, 2, "why the alert is louder than its rule");
  assert.equal(payload.firstSeenAt, AT);
  assert.equal(payload.occurrences, 6);
});

test("tix transport: a rule the deployment does not run still travels, with no invented techniques", () => {
  // A relay between two different deployments can carry a rule id this one has never heard of.
  // The delivery is still an alert; what it must not do is claim a technique, description or
  // reference it cannot read.
  const payload = tixAlertPayload(notification({ ruleId: "XX-000", ruleName: "Somebody else's rule" }), DETECTION_RULES);
  assert.deepEqual(payload.techniques, []);
  assert.deepEqual(payload.ruleReferences, []);
  assert.equal(payload.ruleDescription, null);
  assert.equal(payload.ruleName, "Somebody else's rule");
});

test("tix transport: the signature is over `timestamp.body` and is reproducible", () => {
  const body = JSON.stringify({ hello: "world" });
  const signature = sentinelSignature("secret", 1_700_000_000, body);

  // Pinned by hand, which is the point: the desk's verifier recomputes this, and a format change
  // that nobody notices is a webhook that silently 401s.
  assert.equal(
    signature,
    `sha256=${createHmac("sha256", "secret").update(`1700000000.${body}`).digest("hex")}`,
  );
  assert.notEqual(sentinelSignature("secret", 1_700_000_001, body), signature, "the timestamp is inside the signature");
  assert.notEqual(sentinelSignature("other", 1_700_000_000, body), signature);
});

test("tix transport: a delivery carries a bearer, a tenant and the signature pair", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const transport = new TixAlertTransport({
    url: "https://desk.example/api/security/ingest",
    tenant: "acme",
    token: "shared-secret",
    signingSecret: "signing-secret",
    nowSeconds: () => 1_700_000_000,
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), init: init! });
      return new Response("{}", { status: 202 });
    },
  });

  assert.equal(transport.name, "tix:desk.example");
  assert.equal(transport.signed, true);

  const outcome = await transport.notify(notification());
  assert.deepEqual(outcome, { ok: true, detail: "Tix answered 202" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://desk.example/api/security/ingest");

  const headers = seen[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer shared-secret");
  assert.equal(headers["x-ontrak-tenant"], "acme");
  const body = seen[0].init.body as string;
  assert.equal(headers[TIX_TIMESTAMP_HEADER], "1700000000");
  assert.equal(headers[TIX_SIGNATURE_HEADER], sentinelSignature("signing-secret", 1_700_000_000, body));
  assert.equal(JSON.parse(body).ruleId, "SG-BEH-002");
});

test("tix transport: no signing secret means no signature headers, not an unsigned-looking one", async () => {
  let headers: Record<string, string> = {};
  const transport = new TixAlertTransport({
    url: "https://desk.example/api/security/ingest",
    token: "shared-secret",
    fetchImpl: async (_url, init) => {
      headers = init!.headers as Record<string, string>;
      return new Response("{}", { status: 202 });
    },
  });
  assert.equal(transport.signed, false);
  await transport.notify(notification());
  assert.equal(TIX_SIGNATURE_HEADER in headers, false);
  assert.equal(TIX_TIMESTAMP_HEADER in headers, false);
  assert.equal("x-ontrak-tenant" in headers, false, "an unset tenant sends no header rather than an empty one");
});

test("tix transport: a refusal keeps the desk's own words", async () => {
  const rejected = new TixAlertTransport({
    url: "https://desk.example/api/security/ingest",
    fetchImpl: async () => new Response(JSON.stringify({ error: "Unknown tenant \"acme\"." }), { status: 404 }),
  });
  const outcome = await rejected.notify(notification());
  assert.equal(outcome.ok, false);
  // A `4xx` body is usually the only thing that says *why*; replacing it with "HTTP 404" would
  // throw away the answer the operator needs.
  assert.match((outcome as { error: string }).error, /Tix answered 404: \{"error":"Unknown tenant/);
});

test("tix transport: an unreachable desk is an outcome, never an exception", async () => {
  const broken = new TixAlertTransport({
    url: "https://desk.example/api/security/ingest",
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  const outcome = await broken.notify(notification());
  assert.deepEqual(outcome, { ok: false, error: "Tix unreachable: connect ECONNREFUSED" });

  // A transport whose fetch hangs is cut off by its own timeout rather than holding the ingest.
  const hanging = new TixAlertTransport({
    url: "https://desk.example/api/security/ingest",
    timeoutMs: 20,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
      }),
  });
  const timedOut = await hanging.notify(notification());
  assert.equal(timedOut.ok, false);
});

test("tix transport: the environment names the desk, and no URL means no transport", () => {
  assert.equal(tixTransportFromEnv({}), null);
  assert.equal(tixTransportFromEnv({ [TIX_TRANSPORT_ENV.url]: "   " }), null);

  const configured = tixTransportFromEnv({
    [TIX_TRANSPORT_ENV.url]: "https://desk.example/api/security/ingest",
    [TIX_TRANSPORT_ENV.tenant]: "acme",
    [TIX_TRANSPORT_ENV.token]: "t",
    [TIX_TRANSPORT_ENV.signingSecret]: "s",
  });
  assert.ok(configured instanceof TixAlertTransport);
  assert.equal(configured.signed, true);

  // A URL with no credential still yields a transport on purpose: the failure somebody needs to
  // see is Tix's own `401` on the evidence chain, not a silent no-op that looks configured.
  const credentialless = tixTransportFromEnv({ [TIX_TRANSPORT_ENV.url]: "https://desk.example/api/security/ingest" });
  assert.ok(credentialless instanceof TixAlertTransport);
  assert.equal(credentialless.signed, false);
});

test("tix transport: the preview is the same projection the delivery sends", () => {
  const record: AlertRecord = {
    id: "alert-1",
    organizationId: "org-1",
    ruleId: "SG-BEH-002",
    ruleVersion: 1,
    ruleName: "Failed sign-ins followed by a success from one address",
    severity: "CRITICAL",
    state: "NEW",
    dedupeKey: "SG-BEH-002@1|203.0.113.7|1",
    groupKey: "203.0.113.7",
    sourceAddress: "203.0.113.7",
    identityId: "id-1",
    identityLabel: "ada@acme.test",
    device: "idp-01",
    asset: "auth-service",
    firstSeenAt: AT,
    lastSeenAt: AT,
    occurrences: 6,
    evidence: [],
    threatIntel: [],
    note: null,
    assigneeId: null,
    assigneeLabel: null,
    assignedAt: null,
    createdAt: AT,
    updatedAt: AT,
  };
  assert.deepEqual(tixDeliveryPreview(record, DETECTION_RULES), tixAlertPayload(alertNotification(record), DETECTION_RULES));
});
