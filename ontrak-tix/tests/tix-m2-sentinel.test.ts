/**
 * OnTrak Tix M2/S5 tests: OnTrak Sentinel, in both directions.
 *
 * Tix's telemetry pipeline already has tests for the vendor-alias path (`tix-m2-telemetry`,
 * `tix-m2-connector`) and for promotion (`tix-m2-promotion`). This file covers what only exists
 * because Sentinel is the family's own product:
 *
 *  - **Inbound, read natively.** Sentinel's payload is *this repository's other half*, so it gets
 *    its own reader — and the three facts the alias path cannot recover (the corpus the alert was
 *    judged by, its ATT&CK techniques and its indicator count) have to survive into the row
 *    rather than being filed correctly and quietly dropped.
 *  - **The desk's deduplication is 1:1 with Sentinel's.** The Sentinel alert id is the external
 *    id, so an alert Sentinel folded into one row is one row here and a retried delivery changes
 *    nothing.
 *  - **Signing is a second credential, and it fails closed.** A signed delivery is judged as a
 *    signed delivery; an edited timestamp is a failed signature; a stale one is refused; and a
 *    deployment with no secrets configured still refuses everything, exactly as it did before.
 *  - **Containment is an ask.** The desk derives the target from the alert's own evidence, the
 *    outcome — applied, pending or refused — is written onto the alert *and* onto the hash chain,
 *    and a rail refusing is a sentence the operator reads rather than an error to retry.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m2-sentinel.test.ts
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import { parseVendorAlert, SecurityAlertConnector } from "../src/lib/security-alert-connector";
import {
  MemorySecurityAlertStore,
  SecurityAlertService,
  type SecurityAlertRecord,
} from "../src/lib/security-alert-service";
import { normalizeAlert, normalizeSource, normalizeTechniques } from "../src/lib/security-alert-rules";
import {
  SENTINEL_SIGNATURE_HEADER,
  SENTINEL_SIGNING_SECRET_ENV,
  SENTINEL_TIMESTAMP_HEADER,
  SENTINEL_VENDOR,
  authorizeIngest,
  isSentinelAlert,
  parseSentinelAlert,
  sentinelSignature,
} from "../src/lib/sentinel-ingest";
import {
  HttpSentinelContainment,
  SENTINEL_TARGET_ENV,
  SentinelContainmentService,
  containmentProposalFor,
  containmentRequestBody,
  describeOutcome,
  sentinelTargetFromEnv,
  sentinelTargetGaps,
  type ContainmentAnswer,
  type SentinelContainmentClient,
  type SentinelTarget,
} from "../src/lib/sentinel-containment";

const sha256: HashFn = (input) => createHmac("sha256", "test").update(input).digest("hex");
const NOW = 1_700_000_000;

/** The last event on a chain, asserted to exist — reading `events[0]` blind hides a missing row. */
function lastEvent(audit: AuditLog) {
  const events = audit.snapshot().events;
  assert.ok(events.length > 0, "nothing was appended to the chain");
  return events[events.length - 1]!;
}

/* -------------------------------------------------------------------------- */
/*  What Sentinel actually sends                                              */
/* -------------------------------------------------------------------------- */

/** One delivery, as `tix-alert-transport.ts` in ontrak-sentinel builds it. */
function delivery(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vendor: SENTINEL_VENDOR,
    alertId: "9f1c-alert",
    ruleId: "SG-BEH-002",
    ruleName: "Failed sign-ins followed by a success from one address",
    ruleVersion: 1,
    rulebookVersion: "ab12cd34ef56",
    ruleDescription: "Five authentication failures and then an accepted one from the same address.",
    ruleReferences: ["MITRE:T1110", "MITRE:T1078"],
    techniques: ["T1110", "T1078"],
    severity: "CRITICAL",
    dedupeKey: "SG-BEH-002@1|203.0.113.7|1",
    sourceAddress: "203.0.113.7",
    identityId: "id-1",
    identityLabel: "ada@acme.test",
    device: "idp-01",
    asset: "auth-service",
    firstSeenAt: "2026-10-27T09:00:00.000Z",
    lastSeenAt: "2026-10-27T09:04:00.000Z",
    occurrences: 6,
    threatIntelCount: 2,
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/*  Reading a Sentinel alert natively                                         */
/* -------------------------------------------------------------------------- */

test("sentinel: its own payload is recognised, and products whose names look like it are not", () => {
  assert.equal(isSentinelAlert(delivery()), true);
  assert.equal(isSentinelAlert({ vendor: "OnTrak-Sentinel" }), true);
  assert.equal(isSentinelAlert({ product: "Sentinel Guard" }), true);
  // The corpus digest beside a dedupe key is a pair no other sender produces, so a relay that
  // strips the vendor name still arrives as Sentinel...
  assert.equal(isSentinelAlert({ rulebookVersion: "abc123", dedupeKey: "k" }), true);
  // ...and a payload that *names* a vendor is judged on the name, so these stay where they were.
  assert.equal(isSentinelAlert({ vendor: "Microsoft Sentinel" }), false);
  assert.equal(isSentinelAlert({ vendor: "SentinelOne" }), false);
  assert.equal(isSentinelAlert({ vendor: "Acme Threat Cloud", rulebookVersion: "x", dedupeKey: "k" }), false);
  assert.equal(isSentinelAlert(null), false);
  assert.equal(isSentinelAlert("text"), false);

  assert.equal(normalizeSource("OnTrak Sentinel"), "SENTINEL");
  assert.equal(normalizeSource("Sentinel Guard"), "SENTINEL");
  // The three names that could be confused with each other, asserted together.
  assert.equal(normalizeSource("Microsoft Sentinel"), "SIEM");
  assert.equal(normalizeSource("SentinelOne"), "EDR");
});

test("sentinel: a delivery is read into the canonical record with nothing dropped", () => {
  const read = parseSentinelAlert(delivery());
  assert.ok(read);
  if (!read) return;

  assert.equal(read.vendor, SENTINEL_VENDOR);
  // The rule id is part of the signature, because that is what a desk suppresses on and counts
  // false-positive verdicts against: a renamed rule must not look like a new detection.
  assert.equal(read.signature, "SG-BEH-002 Failed sign-ins followed by a success from one address");
  assert.equal(read.severity, "CRITICAL");
  assert.equal(read.occurredAt, "2026-10-27T09:00:00.000Z");
  assert.equal(read.asset, "auth-service");
  assert.equal(read.identity, "ada@acme.test");
  assert.equal(read.sourceIp, "203.0.113.7");
  assert.equal(read.externalId, "9f1c-alert");
  assert.equal(read.rawRef, "sentinel://alerts/9f1c-alert");
  assert.equal(read.rulebookVersion, "ab12cd34ef56");
  assert.deepEqual(read.techniques, ["T1110", "T1078"]);
  assert.equal(read.threatIntelCount, 2);

  const normalized = normalizeAlert(read);
  assert.equal(normalized.source, "SENTINEL");
  assert.equal(normalized.rulebookVersion, "ab12cd34ef56");
  assert.deepEqual(normalized.techniques, ["T1110", "T1078"]);
  assert.equal(normalized.threatIntelCount, 2);
  // The Sentinel alert id is the dedupe identity, so the desk's folding is 1:1 with the
  // detector's own and a retried delivery is a no-op rather than a second row.
  assert.equal(normalized.dedupeKey, "SENTINEL:id:9f1c-alert");
});

test("sentinel: technique ids are canonicalised, and a shapeless payload is refused", () => {
  assert.deepEqual(normalizeTechniques(["t1110", "T1110", " T1078 ", ""]), ["T1110", "T1078"]);
  assert.deepEqual(normalizeTechniques(undefined), []);

  // No time is no alert: an invented timestamp is an alert whose place in a timeline is a lie.
  assert.equal(parseSentinelAlert(delivery({ firstSeenAt: undefined, lastSeenAt: undefined })), null);
  assert.equal(parseSentinelAlert(delivery({ firstSeenAt: "not a time", lastSeenAt: undefined })), null);
  assert.equal(parseSentinelAlert(delivery({ alertId: "", ruleId: "", ruleName: "" })), null);
  // A rule this deployment does not run still produces a usable record.
  const unknownRule = parseSentinelAlert(delivery({ ruleId: "XX-1", ruleName: "", techniques: [] }));
  assert.equal(unknownRule?.signature, "XX-1");
  assert.deepEqual(unknownRule?.techniques, []);
});

test("sentinel: the connector routes Sentinel natively and every other vendor unchanged", () => {
  const sentinel = parseVendorAlert(delivery());
  assert.equal(sentinel?.vendor, SENTINEL_VENDOR);
  assert.deepEqual(sentinel?.techniques, ["T1110", "T1078"], "the alias reader would have lost these");

  // A third-party sensor still goes through the alias path, including its `timestamp` field.
  const snort = parseVendorAlert({ vendor: "Snort", severity: "high", signature: "ET SCAN", timestamp: "2026-10-27T09:00:00Z" });
  assert.equal(snort?.vendor, "Snort");
  // The alias reader has no field for a corpus digest — a third-party vendor does not report one
  // — so the fact is absent rather than invented, and `normalizeAlert` turns it into `null`.
  assert.equal(snort?.rulebookVersion, undefined);
  assert.equal(normalizeAlert(snort!).rulebookVersion, null);

  // A payload with no identifiable vendor or time is still refused.
  assert.equal(parseVendorAlert({ hello: "world" }), null);
});

test("sentinel: an ingested delivery lands once, and a repeat folds in", async () => {
  const audit = new AuditLog(sha256);
  const store = new MemorySecurityAlertStore();
  const service = new SecurityAlertService(store, audit, { id: () => "alert-1" });
  const connector = new SecurityAlertConnector(service, "tenant-a");

  const first = await connector.receive(delivery());
  assert.equal(first?.kind, "created");
  const second = await connector.receive(delivery({ lastSeenAt: "2026-10-27T09:06:00.000Z" }));
  assert.equal(second?.kind, "duplicate");

  const held = await service.list("tenant-a");
  assert.equal(held.length, 1);
  assert.equal(held[0].source, "SENTINEL");
  assert.equal(held[0].rulebookVersion, "ab12cd34ef56");
  assert.deepEqual(held[0].techniques, ["T1110", "T1078"]);
  assert.equal(held[0].threatIntelCount, 2);
  assert.equal(held[0].containmentState, "NONE", "\"nothing was asked\" is a state, not an absence");
  assert.equal(audit.length, 1, "only the first sighting is audited");
});

/* -------------------------------------------------------------------------- */
/*  Signed ingest                                                             */
/* -------------------------------------------------------------------------- */

test("sentinel: a signed delivery verifies over its bytes, and an edited one does not", () => {
  const raw = JSON.stringify(delivery());
  const headers = (over: Record<string, string> = {}) => ({
    get: (name: string) => {
      const wanted = name.toLowerCase();
      const all: Record<string, string> = {
        [SENTINEL_SIGNATURE_HEADER]: sentinelSignature("sig-secret", NOW, raw),
        [SENTINEL_TIMESTAMP_HEADER]: String(NOW),
        ...over,
      };
      return all[wanted] ?? null;
    },
  });

  const ok = authorizeIngest({ headers: headers(), rawBody: raw, nowSeconds: NOW, sharedSecret: null, signingSecret: "sig-secret" });
  assert.deepEqual(ok, { ok: true, mode: "SIGNATURE" });

  // A signature is over the *bytes*, not over the object: the same fields in a different order
  // are the same JSON and different bytes, which is exactly what a signature is there to pin.
  // (A `parse`/`stringify` round trip is not a reliable way to demonstrate this — it preserves
  // insertion order — so the reordering is explicit.)
  const reordered = JSON.stringify(
    Object.fromEntries(Object.entries(JSON.parse(raw) as Record<string, unknown>).reverse()),
  );
  assert.notEqual(reordered, raw, "the reordered body really is different bytes");
  const overBytes = authorizeIngest({ headers: headers(), rawBody: reordered, nowSeconds: NOW, sharedSecret: null, signingSecret: "sig-secret" });
  assert.equal(overBytes.ok, false);

  const editedBody = authorizeIngest({ headers: headers(), rawBody: `${raw} `, nowSeconds: NOW, sharedSecret: null, signingSecret: "sig-secret" });
  assert.equal(editedBody.ok, false);
  // The timestamp is inside the signature, so it cannot be edited around a stale body.
  const editedTime = authorizeIngest({
    headers: headers({ [SENTINEL_TIMESTAMP_HEADER]: String(NOW + 1) }),
    rawBody: raw,
    nowSeconds: NOW,
    sharedSecret: null,
    signingSecret: "sig-secret",
  });
  assert.equal(editedTime.ok, false);
  assert.match(editedTime.ok ? "" : editedTime.error, /does not match its body/);
});

test("sentinel: the signing window is bounded, and a deployment with no secret refuses rather than allows", () => {
  const raw = JSON.stringify(delivery());
  const signed = (timestamp: number) => ({
    get: (name: string) => {
      const all: Record<string, string> = {
        [SENTINEL_SIGNATURE_HEADER]: sentinelSignature("sig-secret", timestamp, raw),
        [SENTINEL_TIMESTAMP_HEADER]: String(timestamp),
      };
      return all[name.toLowerCase()] ?? null;
    },
  });

  // Five minutes of drift is inside; an hour is a replayed body and is named as such.
  assert.equal(authorizeIngest({ headers: signed(NOW - 299), rawBody: raw, nowSeconds: NOW, sharedSecret: null, signingSecret: "sig-secret" }).ok, true);
  const stale = authorizeIngest({ headers: signed(NOW - 3_600), rawBody: raw, nowSeconds: NOW, sharedSecret: null, signingSecret: "sig-secret" });
  assert.equal(stale.ok, false);
  assert.match(stale.ok ? "" : stale.error, /outside the 300s signing window/);

  // A signed delivery reaching a deployment with no signing secret is refused, not let in on the
  // bearer: the bearer is the weaker credential and the one an attacker would already hold.
  const noSecret = authorizeIngest({ headers: signed(NOW), rawBody: raw, nowSeconds: NOW, sharedSecret: "shared", signingSecret: null });
  assert.equal(noSecret.ok, false);
  assert.match(noSecret.ok ? "" : noSecret.error, new RegExp(SENTINEL_SIGNING_SECRET_ENV));

  // Half a signature pair is refused rather than half-honoured.
  const half = authorizeIngest({
    headers: { get: (name: string) => (name.toLowerCase() === SENTINEL_TIMESTAMP_HEADER ? String(NOW) : null) },
    rawBody: raw,
    nowSeconds: NOW,
    sharedSecret: null,
    signingSecret: "sig-secret",
  });
  assert.equal(half.ok, false);
  assert.match(half.ok ? "" : half.error, /both x-ontrak-signature and x-ontrak-timestamp/);

  const notSeconds = authorizeIngest({
    headers: { get: (name: string) => ({ [SENTINEL_SIGNATURE_HEADER]: "sha256=x", [SENTINEL_TIMESTAMP_HEADER]: "yesterday" })[name.toLowerCase()] ?? null },
    rawBody: raw,
    nowSeconds: NOW,
    sharedSecret: null,
    signingSecret: "sig-secret",
  });
  assert.equal(notSeconds.ok, false);
});

test("sentinel: the bearer path is unchanged, and a deployment with neither secret fails closed", () => {
  const bearer = (value: string) => ({ get: (name: string) => (name.toLowerCase() === "authorization" ? value : null) });

  assert.deepEqual(
    authorizeIngest({ headers: bearer("Bearer shared"), rawBody: "{}", nowSeconds: NOW, sharedSecret: "shared", signingSecret: null }),
    { ok: true, mode: "SHARED_SECRET" },
  );
  assert.equal(authorizeIngest({ headers: bearer("Bearer wrong"), rawBody: "{}", nowSeconds: NOW, sharedSecret: "shared", signingSecret: null }).ok, false);
  // The same sentence the route has always answered with: which credential is missing is not a
  // thing a probe needs to learn.
  const nothing = authorizeIngest({ headers: bearer(""), rawBody: "{}", nowSeconds: NOW, sharedSecret: null, signingSecret: null });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.ok ? "" : nothing.error, "Unauthorized.");
});

/* -------------------------------------------------------------------------- */
/*  Containment: the desk asks                                               */
/* -------------------------------------------------------------------------- */

const alertRecord = (over: Partial<SecurityAlertRecord> = {}): SecurityAlertRecord => ({
  id: "alert-1",
  tenantId: "tenant-a",
  source: "SENTINEL",
  severity: "CRITICAL",
  triageSeverity: "CRITICAL",
  signature: "SG-BEH-002 stuffing",
  description: "desc",
  occurredAt: "2026-10-27T09:00:00.000Z",
  asset: "auth-service",
  assetKnown: false,
  assetOwner: null,
  assetCriticality: null,
  clientId: null,
  identity: "ada@acme.test",
  identityKnown: false,
  identityName: null,
  identityPrivileged: false,
  sourceIp: "203.0.113.7",
  externalId: "9f1c-alert",
  rawRef: "sentinel://alerts/9f1c-alert",
  rulebookVersion: "ab12cd34ef56",
  techniques: ["T1110"],
  threatIntelCount: 2,
  dedupeKey: "SENTINEL:id:9f1c-alert",
  firstSeenAt: "2026-10-27T09:00:00.000Z",
  lastSeenAt: "2026-10-27T09:04:00.000Z",
  occurrences: 1,
  ticketId: null,
  containmentState: "NONE",
  containmentActionId: null,
  ...over,
});

test("containment: the target comes from the alert's own evidence", () => {
  assert.deepEqual(containmentProposalFor(alertRecord()), {
    ok: true,
    action: "BLOCK",
    targets: [{ kind: "ADDRESS", value: "203.0.113.7", label: "detected source" }],
  });
  // An identity is quarantined rather than blocked, and an asset likewise: different verbs
  // because they are different acts.
  assert.deepEqual(containmentProposalFor(alertRecord({ sourceIp: null })), {
    ok: true,
    action: "QUARANTINE",
    targets: [{ kind: "IDENTITY", value: "ada@acme.test", label: "detected identity" }],
  });
  assert.deepEqual(containmentProposalFor(alertRecord({ sourceIp: null, identity: null })), {
    ok: true,
    action: "QUARANTINE",
    targets: [{ kind: "DEVICE", value: "auth-service", label: "detected asset" }],
  });

  const nothing = containmentProposalFor(alertRecord({ sourceIp: null, identity: null, asset: null }));
  assert.equal(nothing.ok, false);
  assert.match(nothing.ok ? "" : nothing.error, /nothing to contain/);

  const body = containmentRequestBody(alertRecord(), {
    reason: "  Credential stuffing.  ",
    requestedBy: { id: "u-1", label: "Ada", role: "ANALYST" },
  });
  assert.deepEqual(body, {
    ok: true,
    value: {
      alertId: "alert-1",
      action: "BLOCK",
      targets: [{ kind: "ADDRESS", value: "203.0.113.7", label: "detected source" }],
      reason: "Credential stuffing.",
      requestedBy: { id: "u-1", label: "Ada", role: "ANALYST" },
      detectedAt: "2026-10-27T09:00:00.000Z",
    },
  });
});

test("containment: the configuration is all-or-nothing, and a gap is named", () => {
  assert.equal(sentinelTargetFromEnv({}), null);
  assert.equal(
    sentinelTargetFromEnv({ [SENTINEL_TARGET_ENV.baseUrl]: "https://sentinel.test/", [SENTINEL_TARGET_ENV.token]: "t" }),
    null,
    "a half-configured target is not a target: an action that reached the wrong place is worse than one that refused",
  );
  assert.deepEqual(
    sentinelTargetFromEnv({
      [SENTINEL_TARGET_ENV.baseUrl]: "https://sentinel.test/",
      [SENTINEL_TARGET_ENV.token]: "t",
      [SENTINEL_TARGET_ENV.organization]: "acme",
    }),
    { baseUrl: "https://sentinel.test", token: "t", organization: "acme" },
    "the trailing slash is trimmed so the path can be appended",
  );
  assert.deepEqual(sentinelTargetGaps({ [SENTINEL_TARGET_ENV.token]: "t" }), [
    SENTINEL_TARGET_ENV.baseUrl,
    SENTINEL_TARGET_ENV.organization,
  ]);
  assert.deepEqual(sentinelTargetGaps({ [SENTINEL_TARGET_ENV.baseUrl]: "x", [SENTINEL_TARGET_ENV.token]: "t", [SENTINEL_TARGET_ENV.organization]: "o" }), []);
});

/** A client that answers with whatever the test tells it to, and records the body it was given. */
class FakeClient implements SentinelContainmentClient {
  readonly seen: Record<string, unknown>[] = [];
  constructor(private readonly answer: { ok: true; value: ContainmentAnswer } | { ok: false; error: string }) {}

  async request(body: Record<string, unknown>) {
    this.seen.push(body);
    return this.answer;
  }
}

async function containmentHarness(
  answer: { ok: true; value: ContainmentAnswer } | { ok: false; error: string },
) {
  const audit = new AuditLog(sha256);
  const store = new MemorySecurityAlertStore();
  const service = new SecurityAlertService(store, audit, { id: () => "alert-1" });
  await store.insert(alertRecord());
  const client = new FakeClient(answer);
  return { audit, store, service, client, containment: new SentinelContainmentService(service, client, audit) };
}

test("containment: applied and pending are written onto the alert and onto the chain", async () => {
  const applied = await containmentHarness({
    ok: true,
    value: { outcome: "APPLIED", actionId: "act-1", state: "ACTIVE", reason: null },
  });
  const result = await applied.containment.request({
    tenantId: "tenant-a",
    alertId: "alert-1",
    reason: "Credential stuffing.",
    requestedBy: { id: "u-1", label: "Ada", role: "ANALYST" },
  });
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(applied.client.seen.length, 1);
  assert.equal(applied.client.seen[0].alertId, "alert-1");

  const held = await applied.service.get("tenant-a", "alert-1");
  assert.equal(held?.containmentState, "APPLIED");
  assert.equal(held?.containmentActionId, "act-1");
  assert.equal(applied.audit.length, 1);
  assert.equal(lastEvent(applied.audit).action, "security.containment.applied");
  assert.equal(lastEvent(applied.audit).detail?.sentinelActionId, "act-1");

  // Pending is a *different* state from applied, and the sentence says so — a desk that read it
  // as blocked would stop watching a host nothing is blocking.
  const pending = await containmentHarness({
    ok: true,
    value: { outcome: "PENDING", actionId: "act-2", state: "PENDING", reason: null },
  });
  const asked = await pending.containment.request({
    tenantId: "tenant-a",
    alertId: "alert-1",
    reason: "Spray.",
    requestedBy: { id: "u-1", label: "Ada", role: "AGENT" },
  });
  assert.ok(asked.ok, asked.ok ? "" : asked.error);
  assert.equal(asked.ok && asked.value.state, "PENDING");
  assert.match(asked.ok ? asked.value.message : "", /waiting for a Sentinel administrator/);
  assert.equal((await pending.service.get("tenant-a", "alert-1"))?.containmentState, "PENDING");
});

test("containment: a rail refusing is an outcome, and an unreachable Sentinel does not block the alert", async () => {
  const refused = await containmentHarness({
    ok: true,
    value: { outcome: "REFUSED", actionId: null, state: null, reason: "Refused: 1 target is on the safe-list." },
  });
  const result = await refused.containment.request({
    tenantId: "tenant-a",
    alertId: "alert-1",
    reason: "Contain it.",
    requestedBy: { id: "u-1", label: "Ada", role: "ADMIN" },
  });
  assert.ok(result.ok, "a refusal is an outcome, not an error to retry");
  assert.equal(result.ok && result.value.state, "REFUSED");
  assert.match(result.ok ? result.value.message : "", /on the safe-list/);
  assert.equal((await refused.service.get("tenant-a", "alert-1"))?.containmentState, "REFUSED");
  assert.equal(lastEvent(refused.audit).action, "security.containment.refused");
  assert.equal(lastEvent(refused.audit).detail?.reason, "Refused: 1 target is on the safe-list.");

  // Sentinel being unreachable is recorded as `FAILED` and explained — nothing was blocked, and
  // the alert itself is untouched, which is what keeps a network problem out of the queue.
  const unreachable = await containmentHarness({ ok: false, error: "Sentinel unreachable: ECONNREFUSED" });
  const failed = await unreachable.containment.request({
    tenantId: "tenant-a",
    alertId: "alert-1",
    reason: "Contain it.",
    requestedBy: { id: "u-1", label: "Ada", role: "ADMIN" },
  });
  assert.ok(failed.ok);
  assert.equal(failed.ok && failed.value.state, "FAILED");
  assert.match(failed.ok ? failed.value.message : "", /Nothing was blocked/);
  assert.equal(lastEvent(unreachable.audit).action, "security.containment.failed");
  assert.equal((await unreachable.service.get("tenant-a", "alert-1"))?.containmentState, "FAILED");
});

test("containment: a reason is required, an unknown alert is refused, and no target is refused", async () => {
  const h = await containmentHarness({ ok: true, value: { outcome: "APPLIED", actionId: "a", state: "ACTIVE", reason: null } });

  const noReason = await h.containment.request({
    tenantId: "tenant-a",
    alertId: "alert-1",
    reason: "   ",
    requestedBy: { id: "u-1", label: "Ada", role: "ADMIN" },
  });
  assert.equal(noReason.ok, false);
  assert.match(noReason.ok ? "" : noReason.error, /needs a reason/);
  assert.equal(h.client.seen.length, 0, "nothing crossed the wire");

  const unknown = await h.containment.request({
    tenantId: "tenant-a",
    alertId: "nope",
    reason: "Contain it.",
    requestedBy: { id: "u-1", label: "Ada", role: "ADMIN" },
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok ? "" : unknown.error, "Alert not found.");

  // An alert that names nothing containable is refused *before* a request is sent, with a sentence
  // rather than Sentinel's version of the same refusal.
  await h.store.update(alertRecord({ sourceIp: null, identity: null, asset: null }));
  const nothing = await h.containment.request({
    tenantId: "tenant-a",
    alertId: "alert-1",
    reason: "Contain it.",
    requestedBy: { id: "u-1", label: "Ada", role: "ADMIN" },
  });
  assert.equal(nothing.ok, false);
  assert.match(nothing.ok ? "" : nothing.error, /nothing to contain/);
  assert.equal(h.client.seen.length, 0);
});

test("containment: the HTTP client reads a 409 as a decision and anything else as a fault", async () => {
  const target: SentinelTarget = { baseUrl: "https://sentinel.test", token: "ct", organization: "acme" };
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({ outcome: "REFUSED", actionId: null, state: null, reason: "safe-list" }), { status: 409 });
  };

  const client = new HttpSentinelContainment(target, fetchImpl);
  const answer = await client.request({ alertId: "alert-1" });
  assert.ok(answer.ok);
  assert.equal(answer.ok && answer.value.outcome, "REFUSED");
  assert.equal(calls[0].url, "https://sentinel.test/guard/v1/containment");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer ct");
  assert.equal(headers["x-sentinel-organization"], "acme");

  // A `202` is taken, and the body says which kind of taken: pending is not a failure.
  const pending = new HttpSentinelContainment(target, async () =>
    new Response(JSON.stringify({ outcome: "PENDING", actionId: "a-1", state: "PENDING", reason: null }), { status: 202 }),
  );
  const answered = await pending.request({});
  assert.deepEqual(answered, { ok: true, value: { outcome: "PENDING", actionId: "a-1", state: "PENDING", reason: null } });

  const unauthorized = new HttpSentinelContainment(target, async () =>
    new Response(JSON.stringify({ error: "The containment token is not valid." }), { status: 401 }),
  );
  const refused = await unauthorized.request({});
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /Sentinel answered 401: The containment token is not valid\./);

  const broken = new HttpSentinelContainment(target, async () => {
    throw new Error("connect ECONNREFUSED");
  });
  assert.equal((await broken.request({})).ok, false);
});

test("containment: the sentences read the same whichever side produced them", () => {
  assert.match(describeOutcome("APPLIED", null), /lifts on its own time limit/);
  assert.match(describeOutcome("PENDING", null), /Nothing is blocked yet/);
  assert.match(describeOutcome("REFUSED", "Refused: on the safe-list."), /on the safe-list/);
  assert.match(describeOutcome("FAILED", null), /could not be reached/);
  assert.equal(describeOutcome("NONE", null), "No containment has been asked for.");
});
