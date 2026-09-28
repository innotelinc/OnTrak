/**
 * OnTrak Tix M2 tests: the security-telemetry pipeline.
 *
 * Covers the pure rules — vendor normalization, severity mapping, de-duplication
 * and enrichment — and the ingest service's idempotency, which is the exit
 * criterion's "an IDS/IPS alert lands once (deduped)".
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m2-telemetry.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import {
  coverageAgainst,
  enrichAlert,
  normalizeAlert,
  normalizeOccurredAt,
  normalizeSeverity,
  normalizeSource,
  summarizeAlerts,
  windowStart,
  type RawSecurityAlert,
} from "../src/lib/security-alert-rules";
import {
  MemorySecurityAlertStore,
  SecurityAlertService,
  type SecurityAlertRecord,
} from "../src/lib/security-alert-service";
import {
  PrismaSecurityAlertStore,
  toSecurityAlertData,
  toSecurityAlertRecord,
  type SecurityAlertPrismaClient,
  type SecurityAlertRow,
} from "../src/lib/security-alert-store-prisma";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");

function rawAlert(overrides: Partial<RawSecurityAlert> = {}): RawSecurityAlert {
  return {
    vendor: "Snort",
    severity: "high",
    signature: "ET SCAN Potential SSH Scan",
    description: "Possible SSH scan from an external host",
    occurredAt: "2026-09-01T12:00:00.000Z",
    asset: "web-01",
    ...overrides,
  };
}

/* ------------------------------------------------------------ normalization */

test("vendors map to a source class, most specific first", () => {
  assert.equal(normalizeSource("Snort"), "IDS");
  assert.equal(normalizeSource("Suricata 7"), "IDS");
  assert.equal(normalizeSource("CrowdStrike Falcon"), "EDR");
  assert.equal(normalizeSource("Microsoft Defender for Endpoint"), "EDR");
  // SentinelOne must not be mistaken for Microsoft Sentinel's SIEM class.
  assert.equal(normalizeSource("SentinelOne"), "EDR");
  assert.equal(normalizeSource("Microsoft Sentinel"), "SIEM");
  assert.equal(normalizeSource("Splunk Enterprise Security"), "SIEM");
  assert.equal(normalizeSource("Cisco Firepower IPS"), "IPS");
  assert.equal(normalizeSource("pfSense"), "NETWORK");
  // An unknown vendor still lands somewhere rather than being dropped.
  assert.equal(normalizeSource("Acme Threat Cloud"), "SIEM");
});

test("severity accepts words and both numeric scales", () => {
  assert.equal(normalizeSeverity("critical"), "CRITICAL");
  assert.equal(normalizeSeverity("SEVERE"), "CRITICAL");
  assert.equal(normalizeSeverity("High"), "HIGH");
  assert.equal(normalizeSeverity("warning"), "MEDIUM");
  assert.equal(normalizeSeverity("low"), "LOW");
  assert.equal(normalizeSeverity("informational"), "INFO");
  assert.equal(normalizeSeverity("debug"), "INFO");

  // A small level scale, low to high.
  assert.equal(normalizeSeverity(0), "INFO");
  assert.equal(normalizeSeverity(1), "LOW");
  assert.equal(normalizeSeverity(3), "MEDIUM");
  assert.equal(normalizeSeverity("4"), "HIGH");
  assert.equal(normalizeSeverity(5), "CRITICAL");

  // A score out of 100.
  assert.equal(normalizeSeverity(15), "INFO");
  assert.equal(normalizeSeverity(45), "MEDIUM");
  assert.equal(normalizeSeverity(95), "CRITICAL");

  // An unreadable value is treated as worth attention, never ignored.
  assert.equal(normalizeSeverity("banana"), "MEDIUM");
});

test("occurredAt is parsed to ISO and an unparseable value is refused", () => {
  assert.equal(normalizeOccurredAt("2026-09-01T12:00:00Z"), "2026-09-01T12:00:00.000Z");
  assert.equal(normalizeOccurredAt(Date.UTC(2026, 8, 1, 12, 0, 0)), "2026-09-01T12:00:00.000Z");
  assert.throws(() => normalizeOccurredAt("not a date"), /Unparseable alert timestamp/);
});

test("normalizeAlert returns one canonical record with a dedupe key", () => {
  const alert = normalizeAlert(rawAlert());
  assert.equal(alert.source, "IDS");
  assert.equal(alert.severity, "HIGH");
  assert.equal(alert.signature, "ET SCAN Potential SSH Scan");
  assert.equal(alert.asset, "web-01");
  assert.equal(alert.identity, null);
  assert.equal(alert.occurredAt, "2026-09-01T12:00:00.000Z");
  assert.match(alert.dedupeKey, /^fp:IDS\|et scan potential ssh scan\|web-01\|-\|/);
});

test("a missing signature falls back to the description", () => {
  const alert = normalizeAlert(rawAlert({ signature: undefined, description: "Beacon to unknown host" }));
  assert.equal(alert.signature, "Beacon to unknown host");
});

/* --------------------------------------------------------------- de-duplication */

test("the vendor id wins over the fingerprint when it is supplied", () => {
  const withId = normalizeAlert(rawAlert({ externalId: "snort-99" }));
  assert.equal(withId.dedupeKey, "IDS:id:snort-99");
});

test("repeats within the window share a key; a later window does not", () => {
  const a = normalizeAlert(rawAlert({ occurredAt: "2026-09-01T12:00:00.000Z" }));
  const b = normalizeAlert(rawAlert({ occurredAt: "2026-09-01T12:04:59.000Z" }));
  const c = normalizeAlert(rawAlert({ occurredAt: "2026-09-01T12:05:01.000Z" }));
  assert.equal(a.dedupeKey, b.dedupeKey);
  assert.notEqual(a.dedupeKey, c.dedupeKey);

  // A different subject is a different alert even inside the window.
  const otherAsset = normalizeAlert(rawAlert({ asset: "db-02" }));
  assert.notEqual(a.dedupeKey, otherAsset.dedupeKey);
});

test("windowStart floors to the five-minute boundary", () => {
  assert.equal(windowStart("2026-09-01T12:04:59.999Z"), "2026-09-01T12:00:00.000Z");
  assert.equal(windowStart("2026-09-01T12:05:00.000Z"), "2026-09-01T12:05:00.000Z");
});

/* ------------------------------------------------------------------ enrichment */

test("enrichment raises triage severity for critical assets and privileged identities", () => {
  const alert = normalizeAlert(rawAlert({ severity: "low" }));
  const enriched = enrichAlert(alert, {
    assets: [{ asset: "web-01", owner: "platform", clientId: "acme", criticality: "CRITICAL" }],
    identities: [{ identity: "domain\\svc_backup", displayName: "Backup service", privileged: true }],
  });
  assert.equal(enriched.assetKnown, true);
  assert.equal(enriched.assetOwner, "platform");
  assert.equal(enriched.clientId, "acme");
  assert.equal(enriched.assetCriticality, "CRITICAL");
  assert.equal(enriched.identityKnown, false); // the alert names no identity
  assert.equal(enriched.triageSeverity, "MEDIUM"); // one step above LOW
});

test("a privileged identity raises severity but never past CRITICAL", () => {
  const alert = normalizeAlert(rawAlert({ severity: "critical", identity: "svc_backup" }));
  const enriched = enrichAlert(alert, { identities: [{ identity: "svc_backup", privileged: true }] });
  assert.equal(enriched.identityKnown, true);
  assert.equal(enriched.identityPrivileged, true);
  assert.equal(enriched.triageSeverity, "CRITICAL");
});

test("an unknown asset or identity keeps the sensor's own severity", () => {
  const enriched = enrichAlert(normalizeAlert(rawAlert({ severity: "high" })), {});
  assert.equal(enriched.assetKnown, false);
  assert.equal(enriched.identityKnown, false);
  assert.equal(enriched.triageSeverity, "HIGH");
});

/* -------------------------------------------------------------------- coverage */

test("coverage reports a silent detection as uncovered", () => {
  const alerts = [
    normalizeAlert(rawAlert({ signature: "ET SCAN Potential SSH Scan" })),
    normalizeAlert(rawAlert({ signature: "ET SCAN Potential SSH Scan", externalId: "x1" })),
    normalizeAlert(rawAlert({ vendor: "CrowdStrike Falcon", signature: "Malicious process" })),
  ];
  const coverage = coverageAgainst(alerts, ["ET SCAN", "MALWARE"]);
  assert.deepEqual(coverage, [
    { detection: "ET SCAN", covered: true, alertCount: 2 },
    { detection: "MALWARE", covered: false, alertCount: 0 },
  ]);
});

test("summarizeAlerts rolls up by severity and source", () => {
  const summary = summarizeAlerts([
    normalizeAlert(rawAlert({ severity: "high" })),
    normalizeAlert(rawAlert({ severity: "high", externalId: "x1" })),
    normalizeAlert(rawAlert({ vendor: "CrowdStrike Falcon", severity: "low", signature: "Benign tool" })),
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.bySeverity.HIGH, 2);
  assert.equal(summary.bySeverity.LOW, 1);
  assert.equal(summary.bySource.IDS, 2);
  assert.equal(summary.bySource.EDR, 1);
  assert.equal(summary.uniqueDetections, 2);
});

/* -------------------------------------------------------------------- ingest */

test("a repeated alert bumps the occurrence count instead of inserting a row", async () => {
  const audit = new AuditLog(sha256);
  const store = new MemorySecurityAlertStore();
  const service = new SecurityAlertService(store, audit, { id: () => "alert-1" });

  const first = await service.ingest("tenant-a", rawAlert());
  assert.equal(first.duplicate, false);
  assert.equal(first.alert.occurrences, 1);

  const second = await service.ingest("tenant-a", rawAlert({ occurredAt: "2026-09-01T12:03:00.000Z" }));
  assert.equal(second.duplicate, true);
  assert.equal(second.alert.id, "alert-1");
  assert.equal(second.alert.occurrences, 2);
  assert.equal(second.alert.firstSeenAt, "2026-09-01T12:00:00.000Z");
  assert.equal(second.alert.lastSeenAt, "2026-09-01T12:03:00.000Z");

  const held = await service.list("tenant-a");
  assert.equal(held.length, 1);
  assert.equal(audit.length, 1); // only the first sighting is audited
});

test("linkTicket records the promotion link once and never rewrites it", async () => {
  const store = new MemorySecurityAlertStore();
  const service = new SecurityAlertService(store, null, { id: () => "alert-1" });
  await service.ingest("tenant-a", rawAlert());

  const linked = await service.linkTicket("tenant-a", "alert-1", "ticket-1");
  assert.equal(linked?.ticketId, "ticket-1");

  // A second link attempt is a no-op: the first write wins.
  const again = await service.linkTicket("tenant-a", "alert-1", "ticket-2");
  assert.equal(again?.ticketId, "ticket-1");

  // A repeated ingest must not forget the link.
  const repeat = await service.ingest("tenant-a", rawAlert({ occurredAt: "2026-09-01T12:02:00.000Z" }));
  assert.equal(repeat.alert.ticketId, "ticket-1");

  assert.equal(await service.linkTicket("tenant-b", "alert-1", "ticket-9"), null);
});

test("the same alert in another tenant is stored separately", async () => {
  const store = new MemorySecurityAlertStore();
  let n = 0;
  const service = new SecurityAlertService(store, null, { id: () => `alert-${++n}` });
  await service.ingest("tenant-a", rawAlert());
  await service.ingest("tenant-b", rawAlert());
  assert.equal((await service.list("tenant-a")).length, 1);
  assert.equal((await service.list("tenant-b")).length, 1);
});

/* ------------------------------------------------------------- prisma adapter */

const row: SecurityAlertRow = {
  id: "alert-1",
  tenantId: "tenant-a",
  source: "IDS",
  severity: "HIGH",
  triageSeverity: "CRITICAL",
  signature: "ET SCAN",
  description: "desc",
  externalId: null,
  asset: "web-01",
  assetKnown: true,
  assetOwner: "platform",
  assetCriticality: "CRITICAL",
  clientId: "acme",
  identity: null,
  identityKnown: false,
  identityName: null,
  identityPrivileged: false,
  sourceIp: "203.0.113.9",
  rawRef: "s3://raw/alert-1",
  dedupeKey: "fp:IDS|et scan|web-01|-|2026-09-01T12:00:00.000Z",
  occurredAt: new Date("2026-09-01T12:00:00Z"),
  firstSeenAt: new Date("2026-09-01T12:00:00Z"),
  lastSeenAt: new Date("2026-09-01T12:03:00Z"),
  occurrences: 2,
  ticketId: "ticket-7",
};

test("the row mapper narrows enums and hands back ISO timestamps", () => {
  const record = toSecurityAlertRecord(row);
  assert.equal(record.source, "IDS");
  assert.equal(record.triageSeverity, "CRITICAL");
  assert.equal(record.assetCriticality, "CRITICAL");
  assert.equal(record.lastSeenAt, "2026-09-01T12:03:00.000Z");
  assert.equal(record.occurrences, 2);
  assert.equal(record.ticketId, "ticket-7");
});

test("an out-of-vocabulary column degrades to a safe default", () => {
  const record = toSecurityAlertRecord({ ...row, source: "WAT", severity: "NOPE", triageSeverity: "NOPE", assetCriticality: "???" });
  assert.equal(record.source, "SIEM");
  assert.equal(record.severity, "MEDIUM");
  assert.equal(record.triageSeverity, "MEDIUM");
  assert.equal(record.assetCriticality, null);
});

test("the data mapper round-trips through the row mapper", () => {
  const record: SecurityAlertRecord = { ...toSecurityAlertRecord(row), id: "alert-2" };
  const data = toSecurityAlertData(record) as Record<string, unknown>;
  assert.equal(data.dedupeKey, record.dedupeKey);
  assert.ok(data.occurredAt instanceof Date);
});

test("the Prisma store finds, inserts, updates and lists through its client", async () => {
  const created: unknown[] = [];
  const client: SecurityAlertPrismaClient = {
    securityAlert: {
      findFirst: async (args) => {
        const where = (args as { where: { dedupeKey?: string; id?: string } }).where;
        if (where.id) return where.id === row.id ? row : null;
        return where.dedupeKey === row.dedupeKey ? row : null;
      },
      findMany: async () => [row],
      create: async (args) => {
        created.push(args.data);
        return args.data;
      },
      update: async () => undefined,
    },
  };
  const store = new PrismaSecurityAlertStore(client);
  const found = await store.findByDedupeKey("tenant-a", row.dedupeKey);
  assert.equal(found?.id, "alert-1");
  assert.equal(await store.findByDedupeKey("tenant-a", "missing"), null);
  assert.equal((await store.findById("tenant-a", "alert-1"))?.ticketId, "ticket-7");
  assert.equal(await store.findById("tenant-a", "nope"), null);
  await store.insert(toSecurityAlertRecord({ ...row, id: "alert-2" }));
  assert.equal(created.length, 1);
  assert.equal((await store.list("tenant-a")).length, 1);
});
