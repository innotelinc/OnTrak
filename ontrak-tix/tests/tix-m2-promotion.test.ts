/**
 * OnTrak Tix M2 tests: alert → ticket promotion, suppression and false-positive
 * tracking, and the vendor telemetry connector.
 *
 * Covers the pure decisions — when an alert is worth a ticket, when it is
 * suppressed or merely observed, and what the ticket says — plus the service's
 * idempotency (one alert becomes one ticket) and the connector's parsing and
 * webhook/poll seam.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m2-promotion.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import {
  DEFAULT_PROMOTION_POLICY,
  activeSuppression,
  decidePromotion,
  falsePositiveCount,
  matchesSuppression,
  promotionDraft,
  promotionKey,
  promotionPriority,
  promotionSubject,
  severityRank,
  type PromotionCandidate,
  type SuppressionRule,
} from "../src/lib/alert-promotion-rules";
import {
  AlertPromotionService,
  MemoryPromotionStore,
  promotionActor,
  type PromotionStore,
} from "../src/lib/alert-promotion-service";
import {
  PrismaPromotionStore,
  toPromotionData,
  toPromotionRecord,
  toSuppressionData,
  toSuppressionRecord,
  toVerdictData,
  toVerdictRecord,
  type AlertPromotionPrismaClient,
  type AlertPromotionRow,
  type AlertSuppressionRow,
  type AlertVerdictRow,
} from "../src/lib/alert-promotion-store-prisma";
import {
  MemorySecurityAlertStore,
  SecurityAlertService,
} from "../src/lib/security-alert-service";
import { MemoryTicketStore, TicketService } from "../src/lib/ticket-service";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const ACTOR = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };

function candidate(overrides: Partial<PromotionCandidate> = {}): PromotionCandidate {
  return {
    id: "alert-1",
    source: "IDS",
    severity: "HIGH",
    triageSeverity: "HIGH",
    signature: "ET SCAN Potential SSH Scan",
    description: "Possible SSH scan from an external host",
    asset: "web-01",
    assetCriticality: null,
    assetOwner: null,
    identity: null,
    identityPrivileged: false,
    sourceIp: "203.0.113.9",
    occurredAt: "2026-09-01T12:00:00.000Z",
    occurrences: 1,
    ticketId: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------ policy mapping */

test("a triage severity maps to a ticket priority", () => {
  assert.equal(promotionPriority("CRITICAL"), "URGENT");
  assert.equal(promotionPriority("HIGH"), "HIGH");
  assert.equal(promotionPriority("MEDIUM"), "NORMAL");
  assert.equal(promotionPriority("LOW"), "LOW");
  assert.equal(promotionPriority("INFO"), "LOW");
  assert.ok(severityRank("CRITICAL") > severityRank("INFO"));
});

/* -------------------------------------------------------------- suppression */

test("a rule suppresses on its field, case-insensitively", () => {
  const alert = candidate({ signature: "Vulnerability Scan - Internal", asset: "scanner-01" });
  assert.equal(matchesSuppression(alert, { field: "signature", match: "vulnerability scan", reason: "known scanner" }, "2026-09-01T12:00:00.000Z"), true);
  assert.equal(matchesSuppression(alert, { field: "asset", match: "SCANNER", reason: "known scanner" }, "2026-09-01T12:00:00.000Z"), true);
  assert.equal(matchesSuppression(alert, { field: "identity", match: "svc", reason: "x" }, "2026-09-01T12:00:00.000Z"), false);
  assert.equal(matchesSuppression(alert, { field: "source", match: "EDR", reason: "x" }, "2026-09-01T12:00:00.000Z"), false);
});

test("a lapsed rule never matches and an empty match is ignored", () => {
  const alert = candidate();
  const now = "2026-09-15T00:00:00.000Z";
  assert.equal(matchesSuppression(alert, { field: "signature", match: "ET SCAN", reason: "x", until: "2026-09-01T00:00:00.000Z" }, now), false);
  assert.equal(matchesSuppression(alert, { field: "signature", match: "ET SCAN", reason: "x", until: "2026-10-01T00:00:00.000Z" }, now), true);
  assert.equal(matchesSuppression(alert, { field: "signature", match: "   ", reason: "x" }, now), false);
});

test("activeSuppression returns the first covering rule", () => {
  const alert = candidate();
  const rules: SuppressionRule[] = [
    { field: "asset", match: "db-99", reason: "not this one" },
    { field: "signature", match: "ET SCAN", reason: "known noisy scan" },
  ];
  assert.equal(activeSuppression(alert, rules, "2026-09-01T12:00:00.000Z")?.reason, "known noisy scan");
  assert.equal(activeSuppression(alert, [], "2026-09-01T12:00:00.000Z"), null);
});

/* -------------------------------------------------------- false positives */

test("false-positive verdicts are counted per signature and window", () => {
  const alert = candidate();
  const now = "2026-09-15T00:00:00.000Z";
  const verdicts = [
    { signature: "ET SCAN Potential SSH Scan", verdict: "FALSE_POSITIVE" as const, at: "2026-09-10T00:00:00.000Z" },
    { signature: "et scan potential ssh scan", verdict: "BENIGN" as const, at: "2026-09-12T00:00:00.000Z" },
    // A true positive is history, not suppression.
    { signature: "ET SCAN Potential SSH Scan", verdict: "TRUE_POSITIVE" as const, at: "2026-09-13T00:00:00.000Z" },
    // Another signature does not count.
    { signature: "Different detection", verdict: "FALSE_POSITIVE" as const, at: "2026-09-13T00:00:00.000Z" },
    // Outside the 30-day window.
    { signature: "ET SCAN Potential SSH Scan", verdict: "FALSE_POSITIVE" as const, at: "2026-07-01T00:00:00.000Z" },
  ];
  assert.equal(falsePositiveCount(alert, verdicts, now, 30), 2);
});

/* ---------------------------------------------------------------- decisions */

test("an alert at or above the bar promotes on sight", () => {
  const decision = decidePromotion(candidate({ triageSeverity: "HIGH" }), DEFAULT_PROMOTION_POLICY, { now: "2026-09-01T12:00:00.000Z" });
  assert.equal(decision.outcome, "PROMOTE");
  assert.equal(decision.priority, "HIGH");
  assert.match(decision.reason, /promotion bar/);

  const critical = decidePromotion(candidate({ triageSeverity: "CRITICAL" }), DEFAULT_PROMOTION_POLICY, { now: "2026-09-01T12:00:00.000Z" });
  assert.equal(critical.outcome, "PROMOTE");
  assert.equal(critical.priority, "URGENT");
});

test("a sub-threshold alert is observed until it repeats", () => {
  const once = decidePromotion(candidate({ triageSeverity: "MEDIUM" }), DEFAULT_PROMOTION_POLICY, { now: "2026-09-01T12:00:00.000Z" });
  assert.equal(once.outcome, "OBSERVE");

  const repeated = decidePromotion(candidate({ triageSeverity: "MEDIUM", occurrences: 5 }), DEFAULT_PROMOTION_POLICY, { now: "2026-09-01T12:00:00.000Z" });
  assert.equal(repeated.outcome, "PROMOTE");
  assert.match(repeated.reason, /repeated 5 times/);
});

test("suppression and false-positive history outrank severity", () => {
  const suppressed = decidePromotion(
    candidate({ triageSeverity: "CRITICAL", asset: "scanner-01" }),
    { ...DEFAULT_PROMOTION_POLICY, suppressionRules: [{ field: "asset", match: "scanner", reason: "internal scanner" }] },
    { now: "2026-09-01T12:00:00.000Z" },
  );
  assert.equal(suppressed.outcome, "SUPPRESS");
  assert.match(suppressed.reason, /internal scanner/);

  const falsePositive = decidePromotion(candidate({ triageSeverity: "CRITICAL" }), DEFAULT_PROMOTION_POLICY, {
    now: "2026-09-15T00:00:00.000Z",
    verdicts: [
      { signature: "ET SCAN Potential SSH Scan", verdict: "FALSE_POSITIVE", at: "2026-09-10T00:00:00.000Z" },
      { signature: "ET SCAN Potential SSH Scan", verdict: "FALSE_POSITIVE", at: "2026-09-11T00:00:00.000Z" },
    ],
  });
  assert.equal(falsePositive.outcome, "SUPPRESS");
  assert.match(falsePositive.reason, /false-positive verdict/);
});

test("an already-promoted alert is never promoted twice", () => {
  const decision = decidePromotion(candidate({ ticketId: "ticket-1" }), DEFAULT_PROMOTION_POLICY, { now: "2026-09-01T12:00:00.000Z" });
  assert.equal(decision.outcome, "SUPPRESS");
  assert.match(decision.reason, /already been promoted/);
});

test("promotionKey is stable per alert", () => {
  assert.equal(promotionKey("alert-1"), "alert:alert-1");
});

/* ------------------------------------------------------------------- draft */

test("the ticket draft carries the detection and its subject stays bounded", () => {
  const alert = candidate({ identity: "svc_backup", identityPrivileged: true, assetCriticality: "CRITICAL", assetOwner: "platform", occurrences: 3 });
  const draft = promotionDraft(alert, DEFAULT_PROMOTION_POLICY);
  assert.equal(draft.type, "INCIDENT");
  assert.equal(draft.priority, "HIGH");
  assert.match(draft.subject, /web-01/);
  assert.match(draft.description, /Detection: ET SCAN/);
  assert.match(draft.description, /Asset: web-01 \(CRITICAL\), owner platform/);
  assert.match(draft.description, /Identity: svc_backup \(privileged\)/);
  assert.match(draft.description, /Source IP: 203.0.113.9/);

  const long = promotionSubject(candidate({ signature: "X".repeat(500) }));
  assert.ok(long.length <= 200);
});

/* ----------------------------------------------------------------- service */

interface Harness {
  promotions: MemoryPromotionStore;
  ticketStore: MemoryTicketStore;
  tickets: TicketService;
  alerts: SecurityAlertService;
  audit: AuditLog;
  service: AlertPromotionService;
}

function harness(): Harness {
  const audit = new AuditLog(sha256);
  const alerts = new SecurityAlertService(new MemorySecurityAlertStore(), audit);
  const ticketStore = new MemoryTicketStore();
  const tickets = new TicketService(ticketStore, audit);
  const promotions = new MemoryPromotionStore();
  const service = new AlertPromotionService(
    {
      alerts,
      tickets: {
        createTicket: (actor, input) => tickets.createTicket(actor, input),
        findTicket: (tenantId, ticketId) => ticketStore.findTicket(tenantId, ticketId),
      },
    },
    promotions,
    audit,
  );
  return { promotions, ticketStore, tickets, alerts, audit, service };
}

/** The audit actions recorded so far, in order. */
function auditActions(h: Harness): string[] {
  return h.audit.snapshot().events.map((entry) => entry.action);
}

async function seedAlert(alerts: SecurityAlertService, overrides: Record<string, unknown> = {}) {
  const { alert } = await alerts.ingest("tenant-a", {
    vendor: "Snort",
    severity: "high",
    signature: "ET SCAN Potential SSH Scan",
    description: "Possible SSH scan",
    occurredAt: "2026-09-01T12:00:00.000Z",
    asset: "web-01",
    ...overrides,
  });
  return alert;
}

test("a high alert promotes to a ticket through the normal lifecycle", async () => {
  const h = harness();
  const alert = await seedAlert(h.alerts);

  const result = await h.service.promote(ACTOR, alert.id, { requesterId: "user-7" });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.decision.outcome, "PROMOTE");
  assert.ok(result.value.ticket);
  assert.equal(result.value.ticket?.requesterId, "user-7");
  assert.equal(result.value.ticket?.type, "INCIDENT");
  assert.equal(result.value.ticket?.priority, "HIGH");

  // The alert now points at the ticket.
  const linked = await h.alerts.get("tenant-a", alert.id);
  assert.equal(linked?.ticketId, result.value.ticket?.id);

  const records = await h.service.listPromotions("tenant-a");
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, "PROMOTE");
  assert.equal(records[0].ticketId, result.value.ticket?.id);

  // One ingest event + one ticket.create + one promotion event.
  const actions = auditActions(h);
  assert.equal(actions.filter((action) => action === "security.alert.promote").length, 1);
  assert.equal(actions.filter((action) => action === "ticket.create").length, 1);
});

test("promotion is idempotent — one alert, one ticket", async () => {
  const h = harness();
  const alert = await seedAlert(h.alerts);

  const first = await h.service.promote(ACTOR, alert.id, { requesterId: "user-7" });
  assert.equal(first.ok, true);
  const second = await h.service.promote(ACTOR, alert.id, { requesterId: "user-7" });
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  assert.equal(second.value.alreadyPromoted, true);
  assert.equal(second.value.ticket?.id, first.value.ticket?.id);
  assert.equal((await h.ticketStore.listTickets("tenant-a")).length, 1);
  assert.equal((await h.service.listPromotions("tenant-a")).length, 1);
  assert.equal(auditActions(h).filter((action) => action === "security.alert.promote").length, 1);
});

test("a false-positive history suppresses promotion and is recorded", async () => {
  const h = harness();
  const alert = await seedAlert(h.alerts, { severity: "critical", signature: "Noisy detection" });

  await h.service.recordVerdict(ACTOR, { signature: "Noisy detection", verdict: "FALSE_POSITIVE" });
  await h.service.recordVerdict(ACTOR, { signature: "Noisy detection", verdict: "BENIGN" });

  const result = await h.service.promote(ACTOR, alert.id, { requesterId: "user-7" });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.decision.outcome, "SUPPRESS");
  assert.equal(result.value.ticket, null);
  assert.equal((await h.ticketStore.listTickets("tenant-a")).length, 0);

  const records = await h.service.listPromotions("tenant-a");
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, "SUPPRESS");
  assert.equal(auditActions(h).filter((action) => action === "security.alert.suppress").length, 1);
  assert.equal(auditActions(h).filter((action) => action === "security.alert.verdict").length, 2);
});

test("a configured suppression keeps a critical alert out of the queue", async () => {
  const h = harness();
  const alert = await seedAlert(h.alerts, { severity: "critical", asset: "scanner-01" });
  await h.service.addSuppression(ACTOR, { field: "asset", match: "scanner", reason: "internal vulnerability scanner" });

  const result = await h.service.promote(ACTOR, alert.id, { requesterId: "user-7" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.decision.outcome, "SUPPRESS");
  assert.match(result.value.decision.reason, /internal vulnerability scanner/);
  assert.equal(auditActions(h).filter((action) => action === "security.alert.suppression").length, 1);
});

test("a quiet alert is observed without writing anything", async () => {
  const h = harness();
  const alert = await seedAlert(h.alerts, { severity: "low" });

  const result = await h.service.promote(ACTOR, alert.id, { requesterId: "user-7" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.decision.outcome, "OBSERVE");
  assert.equal((await h.service.listPromotions("tenant-a")).length, 0);
  assert.equal((await h.ticketStore.listTickets("tenant-a")).length, 0);
});

test("evaluate explains the decision without writing", async () => {
  const h = harness();
  const alert = await seedAlert(h.alerts);
  const evaluated = await h.service.evaluate("tenant-a", alert.id);
  assert.equal(evaluated.ok, true);
  if (!evaluated.ok) return;
  assert.equal(evaluated.value.decision.outcome, "PROMOTE");
  assert.equal((await h.service.listPromotions("tenant-a")).length, 0);
});

test("promotion is tenant-scoped", async () => {
  const h = harness();
  const alert = await seedAlert(h.alerts); // tenant-a
  const foreign = await h.service.promote({ ...ACTOR, tenantId: "tenant-b" }, alert.id, { requesterId: "user-7" });
  assert.equal(foreign.ok, false);
});

/* --------------------------------------------------------- prisma adapter */

const verdictRow: AlertVerdictRow = {
  id: "v1",
  tenantId: "tenant-a",
  signature: "ET SCAN",
  verdict: "FALSE_POSITIVE",
  note: "scanner",
  by: "agent-1",
  at: new Date("2026-09-10T00:00:00Z"),
};

const suppressionRow: AlertSuppressionRow = {
  id: "s1",
  tenantId: "tenant-a",
  field: "asset",
  match: "scanner",
  reason: "internal scanner",
  until: null,
  createdBy: "agent-1",
  createdAt: new Date("2026-09-10T00:00:00Z"),
};

const promotionRow: AlertPromotionRow = {
  id: "p1",
  tenantId: "tenant-a",
  alertId: "alert-1",
  decision: "PROMOTE",
  reason: "HIGH alert at or above the bar.",
  ticketId: "ticket-1",
  ticketRef: "TIX-000001",
  at: new Date("2026-09-10T00:00:00Z"),
};

test("the promotion row mappers round-trip and narrow out-of-vocabulary values", () => {
  const verdict = toVerdictRecord(verdictRow);
  assert.equal(verdict.verdict, "FALSE_POSITIVE");
  assert.equal(verdict.at, "2026-09-10T00:00:00.000Z");
  assert.equal((toVerdictData(verdict) as Record<string, unknown>).signature, "ET SCAN");
  assert.equal(toVerdictRecord({ ...verdictRow, verdict: "WAT" }).verdict, "TRUE_POSITIVE");

  const suppression = toSuppressionRecord(suppressionRow);
  assert.equal(suppression.field, "asset");
  assert.equal(suppression.until, null);
  assert.equal(toSuppressionRecord({ ...suppressionRow, field: "???" }).field, "signature");
  assert.ok(toSuppressionData(suppression).createdAt instanceof Date);

  const promotion = toPromotionRecord(promotionRow);
  assert.equal(promotion.decision, "PROMOTE");
  assert.equal(promotion.ticketId, "ticket-1");
  assert.equal(toPromotionRecord({ ...promotionRow, decision: "nonsense" }).decision, "SUPPRESS");
});

test("the Prisma promotion store writes and lists through its client", async () => {
  const created: string[] = [];
  const client: AlertPromotionPrismaClient = {
    alertVerdict: {
      findMany: async () => [verdictRow],
      create: async () => {
        created.push("verdict");
        return {};
      },
    },
    alertSuppression: {
      findMany: async () => [suppressionRow],
      create: async () => {
        created.push("suppression");
        return {};
      },
    },
    alertPromotion: {
      findMany: async () => [promotionRow],
      create: async () => {
        created.push("promotion");
        return {};
      },
    },
  };
  const store: PromotionStore = new PrismaPromotionStore(client);

  assert.equal((await store.listVerdicts("tenant-a"))[0].signature, "ET SCAN");
  assert.equal((await store.listSuppressions("tenant-a"))[0].match, "scanner");
  assert.equal((await store.listPromotions("tenant-a"))[0].decision, "PROMOTE");

  await store.recordVerdict(toVerdictRecord(verdictRow));
  await store.recordSuppression(toSuppressionRecord(suppressionRow));
  await store.recordPromotion(toPromotionRecord(promotionRow));
  assert.deepEqual(created, ["verdict", "suppression", "promotion"]);
});

test("the system promotion actor is a normal admin in the tenant", () => {
  const actor = promotionActor("tenant-a");
  assert.equal(actor.tenantId, "tenant-a");
  assert.equal(actor.role, "ADMIN");
});
