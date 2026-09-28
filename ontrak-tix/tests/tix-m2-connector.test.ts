/**
 * OnTrak Tix M2 tests: the per-vendor telemetry connector.
 *
 * Covers the vendor-alias parsing, the webhook seam, the polling seam with its
 * acknowledge-only-on-success rule, and the HTTP policy the route layers on top.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m2-connector.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { RawSecurityAlert } from "../src/lib/security-alert-rules";
import {
  MemorySecurityAlertStore,
  SecurityAlertService,
} from "../src/lib/security-alert-service";
import {
  MemoryAlertSource,
  SecurityAlertConnector,
  VendorAlertPoller,
  connectorReply,
  parseVendorAlert,
} from "../src/lib/security-alert-connector";

/* ------------------------------------------------------------------ parsing */

test("a vendor payload is read through its field aliases", () => {
  const alert = parseVendorAlert({
    product: "CrowdStrike Falcon",
    severity: 4,
    ruleName: "Malicious process blocked",
    message: "A process tried to write to a protected path",
    eventTime: "2026-09-01T12:00:00Z",
    hostname: "web-01",
    userName: "svc_backup",
    srcIp: "203.0.113.9",
    eventId: "cs-1",
    rawUrl: "https://falcon.example/events/cs-1",
  });
  assert.ok(alert);
  assert.equal(alert?.vendor, "CrowdStrike Falcon");
  assert.equal(alert?.severity, 4);
  assert.equal(alert?.signature, "Malicious process blocked");
  assert.equal(alert?.description, "A process tried to write to a protected path");
  assert.equal(alert?.asset, "web-01");
  assert.equal(alert?.identity, "svc_backup");
  assert.equal(alert?.sourceIp, "203.0.113.9");
  assert.equal(alert?.externalId, "cs-1");
  assert.equal(alert?.rawRef, "https://falcon.example/events/cs-1");
});

test("a missing severity defaults to MEDIUM rather than dropping the alert", () => {
  const alert = parseVendorAlert({
    vendor: "Snort",
    signature: "ET SCAN Potential SSH Scan",
    timestamp: "2026-09-01T12:00:00Z",
  });
  assert.equal(alert?.severity, "MEDIUM");
});

test("a payload that is not an alert is refused", () => {
  assert.equal(parseVendorAlert(null), null);
  assert.equal(parseVendorAlert("nope"), null);
  assert.equal(parseVendorAlert({ severity: "high" }), null); // no vendor
  assert.equal(parseVendorAlert({ vendor: "Snort", severity: "high" }), null); // no time
  assert.equal(parseVendorAlert({ vendor: "Snort", severity: "high", timestamp: "not a date" }), null);
  assert.equal(parseVendorAlert({ vendor: "Snort", timestamp: "2026-09-01T12:00:00Z" }), null); // no detection
});

/* ---------------------------------------------------------------- webhook seam */

test("the connector ingests once and folds a retried payload as a duplicate", async () => {
  const service = new SecurityAlertService(new MemorySecurityAlertStore());
  const connector = new SecurityAlertConnector(service, "tenant-a");
  const payload = {
    vendor: "Snort",
    severity: "high",
    signature: "ET SCAN Potential SSH Scan",
    timestamp: "2026-09-01T12:00:00Z",
    id: "snort-77",
  };

  const first = await connector.receive(payload);
  assert.equal(first?.kind, "created");
  if (first?.kind === "created") {
    assert.equal(first.source, "IDS");
    assert.equal(first.severity, "HIGH");
    assert.equal(first.occurrences, 1);
  }

  const retry = await connector.receive(payload);
  assert.equal(retry?.kind, "duplicate");
  if (retry?.kind === "duplicate") assert.equal(retry.occurrences, 2);

  assert.equal((await service.list("tenant-a")).length, 1);
});

test("a payload that is not an alert returns null and writes nothing", async () => {
  const service = new SecurityAlertService(new MemorySecurityAlertStore());
  const connector = new SecurityAlertConnector(service, "tenant-a");
  assert.equal(await connector.receive({ hello: "world" }), null);
  assert.equal((await service.list("tenant-a")).length, 0);
});

test("an ingest failure is reported so the sender can retry", async () => {
  const failing = {
    ingest: async (_tenant: string, raw: RawSecurityAlert) => {
      if (raw.vendor === "Boom") throw new Error("vendor timed out");
      throw new Error("unexpected");
    },
  };
  const connector = new SecurityAlertConnector(failing, "tenant-a");
  const outcome = await connector.receive({ vendor: "Boom", signature: "x", timestamp: "2026-09-01T12:00:00Z" });
  assert.equal(outcome?.kind, "failed");
  if (outcome?.kind === "failed") assert.match(outcome.error, /vendor timed out/);
});

/* -------------------------------------------------------------- poll seam */

test("the poller acknowledges created and duplicate alerts", async () => {
  const service = new SecurityAlertService(new MemorySecurityAlertStore());
  const connector = new SecurityAlertConnector(service, "tenant-a");
  const source = new MemoryAlertSource();
  source.add({ vendor: "Snort", signature: "A", timestamp: "2026-09-01T12:00:00Z", id: "1" }, "d1");
  source.add({ vendor: "Snort", signature: "B", timestamp: "2026-09-01T12:00:00Z", id: "2" }, "d2");

  const poller = new VendorAlertPoller(connector, source);
  const result = await poller.poll();
  assert.equal(result.outcomes.length, 2);
  assert.equal(result.deferred, 0);
  assert.equal(source.size, 0);
});

test("the poller defers a failed alert and acknowledges a non-alert", async () => {
  const service = new SecurityAlertService(new MemorySecurityAlertStore());
  const connector = new SecurityAlertConnector(
    {
      ingest: (tenant: string, raw: RawSecurityAlert) => {
        if (raw.vendor === "Boom") throw new Error("down");
        return service.ingest(tenant, raw);
      },
    },
    "tenant-a",
  );
  const source = new MemoryAlertSource();
  source.add({ vendor: "Boom", signature: "X", timestamp: "2026-09-01T12:00:00Z" }, "fail");
  source.add({ nonsense: true }, "junk");

  const poller = new VendorAlertPoller(connector, source);
  const result = await poller.poll();
  assert.equal(result.deferred, 1);
  // The failed alert stays unseen for a retry; the junk payload does not.
  assert.equal(source.size, 1);
  assert.deepEqual(await source.fetchUnseen().then((d) => d.map((m) => m.id)), ["fail"]);
});

/* ------------------------------------------------------------- http policy */

test("connectorReply maps outcomes onto status codes", () => {
  assert.equal(connectorReply(null).status, 400);
  assert.equal(connectorReply({ kind: "failed", error: "x" }).status, 500);
  assert.equal(connectorReply({ kind: "duplicate", alertId: "a", occurrences: 2 }).status, 200);
  const created = connectorReply({ kind: "created", alertId: "a", source: "IDS", severity: "HIGH", occurrences: 1 });
  assert.equal(created.status, 202);
  assert.equal(created.body.source, "IDS");
});
