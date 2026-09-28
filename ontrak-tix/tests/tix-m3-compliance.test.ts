/**
 * OnTrak Tix M3 tests: regulatory notification tracking and the post-incident
 * review.
 *
 * Covers the clocks (which instant a regime counts from, and when it is late),
 * the review's rules (an action needs an owner and a date; overdue is computed,
 * never stored), the service that tracks both against an incident with its
 * timeline and audit trail, the Prisma adapter's narrowing, and the two panels.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m3-compliance.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import {
  IncidentComplianceService,
  MemoryComplianceStore,
  type ComplianceStore,
} from "../src/lib/compliance-service";
import {
  PrismaComplianceStore,
  toActionStatus,
  toClock,
  toNotificationData,
  toNotificationObligation,
  toReviewActionData,
  toReviewActionRecord,
  toReviewRecord,
  type CompliancePrismaClient,
  type NotificationRow,
  type ReviewActionRow,
  type ReviewRow,
} from "../src/lib/compliance-store-prisma";
import { IncidentService, MemoryIncidentStore, type IncidentStore } from "../src/lib/incident-service";
import {
  actionState,
  canChangeAction,
  isActionClosed,
  reviewCompleteness,
  reviewSummary,
  validateReview,
  validateReviewAction,
  type ReviewActionInput,
  type ReviewActionRecord,
} from "../src/lib/review-rules";
import {
  buildObligation,
  canAcknowledge,
  canSend,
  canWaive,
  isRegimeKey,
  notificationDueAt,
  notificationLateness,
  notificationState,
  notificationSummary,
  regimeByKey,
  suggestedRegimes,
  validateNotification,
  type NotificationObligation,
} from "../src/lib/regulatory-rules";
import { NotificationPanel, ReviewPanel } from "../src/components/IncidentCompliance";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const AGENT = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };
const REQUESTER = { id: "req-1", tenantId: "tenant-a", role: "REQUESTER" as const };
const NOW = "2026-09-20T12:00:00.000Z";

/* -------------------------------------------------------------- applicability */

test("regimes are suggested from the incident's own facts, with the reason", () => {
  const sev1 = suggestedRegimes({ severity: "SEV1", impact: "EXTENSIVE" });
  const keys = sev1.map(({ regime }) => regime.key);
  assert.ok(keys.includes("nis2-early-warning"));
  assert.ok(keys.includes("nis2-incident"));
  assert.ok(keys.includes("sec-8k"));
  assert.ok(keys.includes("gdpr-breach"));
  assert.ok(keys.includes("contract-24h"));
  assert.ok(sev1.every(({ because }) => because.length > 0));

  // A SEV4 with limited impact owes nobody anything on these facts.
  assert.deepEqual(suggestedRegimes({ severity: "SEV4", impact: "MINOR" }), []);

  // NIS2 applies from SEV2 up; the SEC and contract duties are SEV1 only.
  const sev2 = suggestedRegimes({ severity: "SEV2", impact: "MODERATE" }).map(({ regime }) => regime.key);
  assert.ok(sev2.includes("nis2-incident"));
  assert.ok(!sev2.includes("sec-8k"));
  assert.ok(!sev2.includes("gdpr-breach"));
});

test("a regime's clock runs from the instant the regime names", () => {
  assert.equal(isRegimeKey("nis2-incident"), true);
  assert.equal(isRegimeKey("nonsense"), false);

  const early = regimeByKey("nis2-early-warning")!;
  const gdpr = regimeByKey("gdpr-breach")!;
  const incident = { detectedAt: "2026-09-20T09:00:00.000Z", declaredAt: "2026-09-20T09:30:00.000Z" };

  // The 24-hour early warning runs from when the desk was aware…
  assert.equal(early.clock, "declared");
  assert.equal(notificationDueAt(early, incident), "2026-09-21T09:30:00.000Z");
  // …and so does the 72-hour one, which lands three days later.
  assert.equal(gdpr.clock, "declared");
  assert.equal(notificationDueAt(gdpr, incident), "2026-09-23T09:30:00.000Z");

  // An hourly clock is the same arithmetic: HIPAA's 60 days is 1440 hours.
  const hipaa = regimeByKey("hipaa-breach")!;
  assert.equal(hipaa.hours, 1440);
  assert.equal(hipaa.clock, "declared");
});

test("a duty is pending, due soon, overdue — and then sent, late or not", () => {
  const base = buildObligation({
    id: "n1",
    tenantId: "tenant-a",
    incidentId: "inc-1",
    regime: regimeByKey("nis2-incident")!,
    incident: { detectedAt: "2026-09-20T09:00:00.000Z", declaredAt: "2026-09-20T09:00:00.000Z" },
    now: "2026-09-20T09:00:00.000Z",
  });
  // The 72-hour clock runs from the declaration: three days, to the minute.
  assert.equal(base.dueAt, "2026-09-23T09:00:00.000Z");
  assert.equal(base.status, "PENDING");
  assert.equal(base.requirement.length > 0, true);

  assert.equal(notificationState(base, "2026-09-20T09:00:00.000Z"), "PENDING");
  assert.equal(notificationState(base, "2026-09-22T21:30:00.000Z"), "DUE_SOON");
  assert.equal(notificationState(base, "2026-09-23T09:30:00.000Z"), "OVERDUE");

  const sent = { ...base, status: "SENT" as const, sentAt: "2026-09-23T08:00:00.000Z", sentBy: "agent-1" };
  assert.equal(notificationState(sent, "2026-09-23T13:00:00.000Z"), "SENT");
  assert.equal(notificationLateness(sent), -1);

  const late = { ...sent, sentAt: "2026-09-23T11:00:00.000Z" };
  assert.equal(notificationState(late, "2026-09-23T14:30:00.000Z"), "SENT_LATE");
  assert.equal(notificationLateness(late), 2);

  const acknowledged = { ...sent, status: "ACKNOWLEDGED" as const, acknowledgedAt: "2026-09-20T11:30:00.000Z" };
  assert.equal(notificationState(acknowledged, NOW), "ACKNOWLEDGED");
  const waived = { ...base, status: "WAIVED" as const, waiverReason: "No personal data involved" };
  assert.equal(notificationState(waived, "2027-01-01T00:00:00.000Z"), "WAIVED");

  // Which moves are legal from where.
  assert.equal(canSend(base), true);
  assert.equal(canSend(sent), false);
  assert.equal(canAcknowledge(sent), true);
  assert.equal(canAcknowledge(base), false);
  assert.equal(canWaive(base), true);
  assert.equal(canWaive(acknowledged), false);

  assert.deepEqual(notificationSummary([base, sent, late, acknowledged, waived], NOW), {
    total: 5,
    pending: 1,
    dueSoon: 0,
    overdue: 0,
    sent: 2,
    acknowledged: 1,
    waived: 1,
    nextDueAt: base.dueAt,
  });
});

test("an unknown regime or an over-long note is refused", () => {
  assert.deepEqual(validateNotification({ regime: "nis2-incident" }), []);
  assert.match(validateNotification({ regime: "made-up" })[0], /Unknown notification regime/);
  assert.match(validateNotification({})[0], /Choose a notification regime/);
  assert.equal(validateNotification({ regime: "nis2-incident", note: "x".repeat(2_001) }).length, 1);
});

/* ----------------------------------------------------------------- review rules */

function action(overrides: Partial<ReviewActionRecord> = {}): ReviewActionRecord {
  return {
    id: "act-1",
    tenantId: "tenant-a",
    incidentId: "inc-1",
    reviewId: "rev-1",
    title: "Patch the VPN gateway",
    ownerId: "user-2",
    dueAt: "2026-10-01T00:00:00.000Z",
    note: null,
    status: "OPEN",
    completedAt: null,
    completedBy: null,
    createdAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

test("an action must name an owner and a date, and late is computed, not stored", () => {
  assert.deepEqual(validateReviewAction({ title: "Do it", ownerId: "u1", dueAt: "2026-10-01" }), []);
  assert.match(validateReviewAction({ ownerId: "u1", dueAt: "2026-10-01" })[0], /needs a title/);
  assert.match(validateReviewAction({ title: "Do it", dueAt: "2026-10-01" })[0], /needs an owner/);
  assert.match(validateReviewAction({ title: "Do it", ownerId: "u1" })[0], /needs a due date/);
  assert.match(validateReviewAction({ title: "Do it", ownerId: "u1", dueAt: "whenever" })[0], /not a valid date/);

  assert.equal(actionState(action(), "2026-09-30T00:00:00.000Z"), "OPEN");
  assert.equal(actionState(action({ status: "IN_PROGRESS" }), "2026-09-30T00:00:00.000Z"), "IN_PROGRESS");
  // Nobody had to flag it: the date passed, so it is late.
  assert.equal(actionState(action(), "2026-10-02T00:00:00.000Z"), "OVERDUE");
  assert.equal(actionState(action({ status: "DONE", completedAt: "2026-10-05T00:00:00.000Z" }), "2026-10-06T00:00:00.000Z"), "DONE");
  assert.equal(isActionClosed(action({ status: "DROPPED" })), true);

  assert.equal(canChangeAction(action(), "DONE").ok, true);
  assert.equal(canChangeAction(action(), "OPEN").ok, false);
  const reopen = canChangeAction(action({ status: "DONE" }), "OPEN");
  assert.equal(reopen.ok, false);
  if (!reopen.ok) assert.match(reopen.reason, /reopened by adding a new one/);
});

test("a review without an owned action is not a review", () => {
  assert.match(validateReview({ findings: "", actions: [] })[0], /needs findings/);
  assert.ok(validateReview({ findings: "What happened", actions: [] }).some((issue) => /at least one action/.test(issue)));
  const bad = validateReview({ findings: "What happened", actions: [{ title: "Fix it", ownerId: "", dueAt: "2026-10-01" }] });
  assert.ok(bad.some((issue) => /Action 1: An action needs an owner/.test(issue)));
  assert.deepEqual(validateReview({ findings: "What happened", lessons: "Ship smaller", actions: [action()] }), []);

  const summary = reviewSummary([action(), action({ id: "act-2", status: "DONE" }), action({ id: "act-3", dueAt: "2026-09-01T00:00:00.000Z" })], NOW);
  assert.deepEqual(summary, { total: 3, open: 1, inProgress: 0, overdue: 1, done: 1, dropped: 0, closedShare: 1 / 3, settled: false });

  assert.deepEqual(reviewCompleteness(null, [], NOW).missing, ["the post-incident review has not been published"]);
  const complete = reviewCompleteness(
    { id: "rev-1", tenantId: "tenant-a", incidentId: "inc-1", findings: "f", lessons: null, publishedBy: "agent-1", publishedAt: NOW },
    [action({ status: "DONE" })],
    NOW,
  );
  assert.equal(complete.complete, true);
});

/* ------------------------------------------------------------------- service */

interface Harness {
  service: IncidentComplianceService;
  store: ComplianceStore;
  incidents: IncidentStore;
  audit: AuditLog;
  incidentsService: IncidentService;
}

function harness(): Harness {
  const audit = new AuditLog(sha256);
  const incidents = new MemoryIncidentStore();
  const store = new MemoryComplianceStore();
  // The incident service gets a fixed clock: "the declaration happened at 09:00"
  // is the fact every deadline in these tests is measured from.
  const incidentsService = new IncidentService(incidents, audit, {
    id: (() => {
      let n = 0;
      return () => `incident-id-${++n}`;
    })(),
    now: () => "2026-09-20T09:00:00.000Z",
  });
  const service = new IncidentComplianceService(store, incidents, audit, {
    id: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    // Two clocks so the sequence of events is deterministic but ordered.
    now: (() => {
      let n = 0;
      return () => new Date(Date.parse("2026-09-20T09:00:00.000Z") + ++n * 60_000).toISOString();
    })(),
  });
  return { service, store, incidents, audit, incidentsService };
}

async function declareIncident(h: Harness) {
  const result = await h.incidentsService.declare(AGENT, {
    title: "Suspicious SSH activity",
    summary: "Repeated scans against the bastion host.",
    impact: "EXTENSIVE",
    urgency: "CRITICAL",
    detectedAt: "2026-09-20T09:00:00.000Z",
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("declare failed");
  return result.value;
}

function auditActions(h: Harness): string[] {
  return h.audit.snapshot().events.map((event) => event.action);
}

test("tracking a regime starts its clock and records the deadline on the timeline", async () => {
  const h = harness();
  const incident = await declareIncident(h);

  const suggestions = await h.service.suggestions(AGENT, incident.id);
  assert.equal(suggestions.ok, true);
  if (!suggestions.ok) return;
  assert.ok(suggestions.value.some((entry) => entry.suggestion.regime.key === "gdpr-breach"));
  assert.ok(suggestions.value.every((entry) => entry.tracked === false));

  const tracked = await h.service.track(AGENT, incident.id, "gdpr-breach", "Provisional: personal data may be involved");
  assert.equal(tracked.ok, true);
  if (!tracked.ok) return;
  assert.equal(tracked.value.status, "PENDING");
  assert.equal(tracked.value.authority, "Supervisory authority (Art. 33)");
  assert.equal(tracked.value.dueAt, "2026-09-23T09:00:00.000Z");
  // The regime's own words are copied in, so the record stays readable.
  assert.equal(tracked.value.requirement, regimeByKey("gdpr-breach")!.requirement);

  // Adopting the same duty twice is refused rather than duplicated.
  const again = await h.service.track(AGENT, incident.id, "gdpr-breach");
  assert.equal(again.ok, false);
  // …and the suggestion now says it is tracked, so the panel stops offering it.
  const refreshed = await h.service.suggestions(AGENT, incident.id);
  assert.equal(refreshed.ok, true);
  if (refreshed.ok) assert.ok(refreshed.value.find((entry) => entry.suggestion.regime.key === "gdpr-breach")?.tracked);

  const events = await h.incidents.listEvents("tenant-a", incident.id);
  assert.ok(events.some((event) => event.kind === "notification" && /Tracking GDPR personal-data breach/.test(event.summary)));
  assert.ok(auditActions(h).includes("incident.notification.track"));

  // Unknown regimes and requesters are refused.
  assert.equal((await h.service.track(AGENT, incident.id, "made-up")).ok, false);
  assert.equal((await h.service.track(REQUESTER, incident.id, "nis2-incident")).ok, false);
  assert.equal((await h.service.suggestions({ ...AGENT, tenantId: "tenant-b" }, incident.id)).ok, false);
});

test("a notice is sent, acknowledged or waived — and a waiver needs a reason", async () => {
  const h = harness();
  const incident = await declareIncident(h);
  const tracked = await h.service.track(AGENT, incident.id, "nis2-early-warning");
  assert.equal(tracked.ok, true);
  if (!tracked.ok) return;

  // Acknowledging before anything was sent is refused.
  assert.equal((await h.service.acknowledge(AGENT, incident.id, tracked.value.id)).ok, false);

  const sent = await h.service.markSent(AGENT, incident.id, tracked.value.id, { reference: "CSIRT-2026-0042" });
  assert.equal(sent.ok, true);
  if (!sent.ok) return;
  assert.equal(sent.value.status, "SENT");
  assert.equal(sent.value.reference, "CSIRT-2026-0042");
  assert.ok(sent.value.sentAt);

  const acknowledged = await h.service.acknowledge(AGENT, incident.id, tracked.value.id);
  assert.equal(acknowledged.ok, true);
  if (!acknowledged.ok) return;
  assert.equal(acknowledged.value.status, "ACKNOWLEDGED");

  // A second send is refused, and so is waiving something already acknowledged.
  assert.equal((await h.service.markSent(AGENT, incident.id, tracked.value.id)).ok, false);
  assert.equal((await h.service.waive(AGENT, incident.id, tracked.value.id, "too late")).ok, false);

  const other = await h.service.track(AGENT, incident.id, "hipaa-breach");
  assert.equal(other.ok, true);
  if (!other.ok) return;
  assert.equal((await h.service.waive(AGENT, incident.id, other.value.id, "")).ok, false);
  const waived = await h.service.waive(AGENT, incident.id, other.value.id, "No protected health information involved");
  assert.equal(waived.ok, true);
  if (!waived.ok) return;
  assert.equal(waived.value.status, "WAIVED");
  assert.equal(waived.value.waiverReason, "No protected health information involved");

  // An obligation from another incident is not reachable through this one.
  const otherIncident = await declareIncident(h);
  assert.equal((await h.service.markSent(AGENT, otherIncident.id, tracked.value.id)).ok, false);

  const actions = auditActions(h);
  assert.ok(actions.includes("incident.notification.sent"));
  assert.ok(actions.includes("incident.notification.ack"));
  assert.ok(actions.includes("incident.notification.waive"));

  const overview = await h.service.overview("tenant-a", incident.id);
  assert.equal(overview.notifications.length, 2);
  assert.equal(overview.summary.total, 2);
  assert.equal(overview.summary.acknowledged, 1);
  assert.equal(overview.summary.waived, 1);
});

test("a review is published with its actions, and only once the incident is reviewed", async () => {
  const h = harness();
  const incident = await declareIncident(h);

  const early = await h.service.publish(AGENT, incident.id, {
    findings: "Nothing to see",
    actions: [{ title: "Do better", ownerId: "user-2", dueAt: "2026-10-01" }],
  });
  assert.equal(early.ok, false);
  if (!early.ok) assert.match(early.error, /reviewed before publishing/);

  // Walk it to REVIEWED, which is what a real response does.
  await h.incidentsService.assignRole(AGENT, incident.id, "COMMANDER", "user-1");
  await h.incidentsService.assignRole(AGENT, incident.id, "SCRIBE", "user-2");
  for (const phase of ["TRIAGED", "CONTAINED", "ERADICATED", "RECOVERED", "REVIEWED"] as const) {
    const moved = await h.incidentsService.advance(AGENT, incident.id, phase);
    assert.equal(moved.ok, true);
  }

  const noActions = await h.service.publish(AGENT, incident.id, { findings: "It happened", actions: [] });
  assert.equal(noActions.ok, false);
  if (!noActions.ok) assert.match(noActions.error, /at least one action/);

  const published = await h.service.publish(AGENT, incident.id, {
    findings: "A bastion host was scanned; nothing was accessed.",
    lessons: "Put the bastion behind the same alerting as the VPN.",
    actions: [
      { title: "Add the bastion to the SSH-scan rule", ownerId: "user-2", dueAt: "2026-10-01" },
      { title: "Rotate the bastion keys", ownerId: "user-3", dueAt: "2026-09-25" },
    ],
  });
  assert.equal(published.ok, true);
  if (!published.ok) return;
  assert.equal(published.value.actions.length, 2);
  assert.equal(published.value.review.publishedBy, "agent-1");

  // Publishing twice is refused: the record is append-only.
  assert.equal((await h.service.publish(AGENT, incident.id, { findings: "Again", actions: [action()] })).ok, false);

  const events = await h.incidents.listEvents("tenant-a", incident.id);
  assert.ok(events.some((event) => event.kind === "review" && /Post-incident review published \(2 actions\)/.test(event.summary)));
  assert.equal(events.filter((event) => event.kind === "action").length, 2);
  assert.ok(auditActions(h).includes("incident.review.publish"));

  // An action can be started, completed once, and dropped with a reason.
  const [first, second] = published.value.actions;
  const started = await h.service.startAction(AGENT, incident.id, first.id);
  assert.equal(started.ok, true);
  const completed = await h.service.completeAction(AGENT, incident.id, first.id, "Rule updated in the IDS console");
  assert.equal(completed.ok, true);
  if (!completed.ok) return;
  assert.equal(completed.value.status, "DONE");
  assert.equal(completed.value.note, "Rule updated in the IDS console");
  assert.equal((await h.service.completeAction(AGENT, incident.id, first.id)).ok, false);
  assert.equal((await h.service.dropAction(AGENT, incident.id, second.id, "")).ok, false);
  const dropped = await h.service.dropAction(AGENT, incident.id, second.id, "Keys were already rotated on 2026-09-19");
  assert.equal(dropped.ok, true);
  if (!dropped.ok) return;
  assert.equal(dropped.value.status, "DROPPED");

  assert.ok((await h.service.review("tenant-a", incident.id)).review);
  const overview = await h.service.overview("tenant-a", incident.id);
  assert.equal(overview.actions.length, 2);
  assert.equal(overview.reviewSummary.done, 1);
  assert.equal(overview.reviewSummary.dropped, 1);
  assert.equal(overview.reviewSummary.settled, true);
});

test("an action on somebody else's incident is out of reach", async () => {
  const h = harness();
  const incident = await declareIncident(h);
  await h.incidentsService.assignRole(AGENT, incident.id, "COMMANDER", "user-1");
  for (const phase of ["TRIAGED", "CONTAINED", "ERADICATED", "RECOVERED", "REVIEWED"] as const) {
    await h.incidentsService.advance(AGENT, incident.id, phase);
  }
  const published = await h.service.publish(AGENT, incident.id, {
    findings: "f",
    actions: [
      { title: "a", ownerId: "u1", dueAt: "2026-10-01" },
      { title: "b", ownerId: "u1", dueAt: "2026-10-02" },
    ],
  });
  assert.equal(published.ok, true);
  if (!published.ok) return;

  const other = await declareIncident(h);
  assert.equal((await h.service.completeAction(AGENT, other.id, published.value.actions[0].id)).ok, false);
  assert.equal((await h.service.addAction(AGENT, other.id, { title: "x", ownerId: "u1", dueAt: "2026-10-01" })).ok, false);
  assert.equal((await h.service.completeAction(REQUESTER, incident.id, published.value.actions[0].id)).ok, false);

  // A second review cannot be opened on the same incident by adding actions.
  assert.equal((await h.service.addAction(AGENT, incident.id, { title: "c", ownerId: "u1", dueAt: "2026-10-03" })).ok, true);
  assert.equal((await h.service.review("tenant-a", incident.id)).actions.length, 3);
});

test("a review published after the date shows its action as overdue", async () => {
  const h = harness();
  const incident = await declareIncident(h);
  await h.incidentsService.assignRole(AGENT, incident.id, "COMMANDER", "user-1");
  for (const phase of ["TRIAGED", "CONTAINED", "ERADICATED", "RECOVERED", "REVIEWED"] as const) {
    await h.incidentsService.advance(AGENT, incident.id, phase);
  }
  const published = await h.service.publish(AGENT, incident.id, {
    findings: "f",
    actions: [{ title: "Late one", ownerId: "u1", dueAt: "2026-09-21" }],
  });
  assert.equal(published.ok, true);
  if (!published.ok) return;

  const actions = (await h.service.review("tenant-a", incident.id)).actions;
  // The service's injected clock is well past the due date, so the check is real.
  assert.equal(actionState(actions[0], "2026-09-25T00:00:00.000Z"), "OVERDUE");
  assert.deepEqual(reviewCompleteness((await h.service.review("tenant-a", incident.id)).review, actions, "2026-09-25T00:00:00.000Z").missing, [
    "1 action is overdue",
    "some actions are still open",
  ]);
});

/* -------------------------------------------------------------- prisma adapter */

const NOTIFICATION_ROW: NotificationRow = {
  id: "n1",
  tenantId: "tenant-a",
  incidentId: "inc-1",
  regime: "gdpr-breach",
  label: "GDPR personal-data breach",
  authority: "Supervisory authority (Art. 33)",
  requirement: "Notify the supervisory authority.",
  clock: "detected",
  dueAt: new Date("2026-09-20T12:00:00.000Z"),
  status: "SENT",
  sentAt: new Date("2026-09-20T11:00:00.000Z"),
  sentBy: "agent-1",
  acknowledgedAt: null,
  acknowledgedBy: null,
  reference: "SA-42",
  note: null,
  waivedAt: null,
  waivedBy: null,
  waiverReason: null,
  createdAt: new Date("2026-09-20T09:00:00.000Z"),
};

const REVIEW_ROW: ReviewRow = {
  id: "rev-1",
  tenantId: "tenant-a",
  incidentId: "inc-1",
  findings: "What happened",
  lessons: "What changes",
  publishedBy: "agent-1",
  publishedAt: new Date("2026-09-20T13:00:00.000Z"),
};

const ACTION_ROW: ReviewActionRow = {
  id: "act-1",
  tenantId: "tenant-a",
  incidentId: "inc-1",
  reviewId: "rev-1",
  title: "Patch it",
  ownerId: "user-2",
  dueAt: new Date("2026-10-01T00:00:00.000Z"),
  status: "DONE",
  note: null,
  completedAt: new Date("2026-09-30T00:00:00.000Z"),
  completedBy: "user-2",
  createdAt: new Date("2026-09-20T13:00:00.000Z"),
};

test("the Prisma adapter narrows enums and dates, and writes back an ISO instant", () => {
  const obligation = toNotificationObligation(NOTIFICATION_ROW);
  assert.equal(obligation.status, "SENT");
  assert.equal(obligation.clock, "detected");
  assert.equal(obligation.dueAt, "2026-09-20T12:00:00.000Z");
  assert.equal(obligation.acknowledgedAt, null);

  const data = toNotificationData(obligation);
  assert.equal(data.dueAt instanceof Date, true);
  assert.equal(data.tenantId, "tenant-a");
  assert.equal(toNotificationData({ ...obligation, sentAt: null, waivedAt: null, acknowledgedAt: null }).sentAt, null);

  // A row written before a vocabulary change degrades instead of leaking `string`.
  assert.equal(toNotificationObligation({ ...NOTIFICATION_ROW, status: "GONE", clock: "somewhen" }).status, "PENDING");
  assert.equal(toNotificationObligation({ ...NOTIFICATION_ROW, status: "GONE", clock: "somewhen" }).clock, "declared");
  assert.equal(toActionStatus("IN_PROGRESS"), "IN_PROGRESS");
  assert.equal(toActionStatus("nonsense"), "OPEN");
  assert.equal(toClock("detected"), "detected");
  assert.equal(toClock("nonsense"), "declared");

  const review = toReviewRecord(REVIEW_ROW);
  assert.equal(review.publishedAt, "2026-09-20T13:00:00.000Z");
  const record = toReviewActionRecord(ACTION_ROW);
  assert.equal(record.status, "DONE");
  assert.equal(record.completedAt, "2026-09-30T00:00:00.000Z");
  assert.equal(toReviewActionData(record).dueAt instanceof Date, true);
});

test("the Prisma store asks the database the right questions", async () => {
  const calls: string[] = [];
  const db = {
    incidentNotification: {
      findFirst: async () => {
        calls.push("notification.findFirst");
        return NOTIFICATION_ROW;
      },
      findMany: async () => {
        calls.push("notification.findMany");
        return [NOTIFICATION_ROW];
      },
      create: async () => {
        calls.push("notification.create");
        return NOTIFICATION_ROW;
      },
      update: async () => {
        calls.push("notification.update");
        return NOTIFICATION_ROW;
      },
    },
    incidentReview: {
      findFirst: async () => REVIEW_ROW,
      create: async () => REVIEW_ROW,
    },
    incidentReviewAction: {
      findFirst: async () => ACTION_ROW,
      findMany: async () => [ACTION_ROW],
      createMany: async () => ({ count: 1 }),
      create: async () => ACTION_ROW,
      update: async () => ACTION_ROW,
    },
  } as unknown as CompliancePrismaClient;

  const store = new PrismaComplianceStore(db);
  assert.equal((await store.findNotification("tenant-a", "n1"))?.id, "n1");
  assert.equal((await store.findNotificationByRegime("tenant-a", "inc-1", "gdpr-breach"))?.regime, "gdpr-breach");
  assert.equal((await store.listNotifications("tenant-a", "inc-1")).length, 1);
  await store.insertNotification(toNotificationObligation(NOTIFICATION_ROW));
  await store.updateNotification(toNotificationObligation(NOTIFICATION_ROW));
  assert.equal((await store.findReview("tenant-a", "inc-1"))?.findings, "What happened");
  await store.insertReview(toReviewRecord(REVIEW_ROW));
  await store.insertActions([toReviewActionRecord(ACTION_ROW)]);
  await store.insertAction(toReviewActionRecord(ACTION_ROW));
  assert.equal((await store.findAction("tenant-a", "act-1"))?.title, "Patch it");
  assert.equal((await store.listActions("tenant-a", "inc-1")).length, 1);
  await store.updateAction(toReviewActionRecord(ACTION_ROW));
  assert.deepEqual(calls, [
    "notification.findFirst",
    "notification.findFirst",
    "notification.findMany",
    "notification.create",
    "notification.update",
  ]);
});

/* ------------------------------------------------------------------- renderer */

const OBLIGATION: NotificationObligation = {
  id: "n1",
  tenantId: "tenant-a",
  incidentId: "inc-1",
  regime: "nis2-early-warning",
  label: "NIS2 early warning",
  authority: "National CSIRT",
  requirement: "An early warning that a significant incident has occurred.",
  clock: "declared",
  dueAt: "2026-09-20T10:00:00.000Z",
  status: "PENDING",
  sentAt: null,
  sentBy: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  reference: null,
  note: null,
  waivedAt: null,
  waivedBy: null,
  waiverReason: null,
  createdAt: "2026-09-20T09:00:00.000Z",
};

const SUGGESTION = { suggestion: { regime: regimeByKey("gdpr-breach")!, because: "extensive impact" }, tracked: false };

test("the notification panel says overdue in words", () => {
  const html = renderToStaticMarkup(
    createElement(NotificationPanel, {
      incidentId: "inc-1",
      obligations: [OBLIGATION],
      suggestions: [SUGGESTION],
      now: "2026-09-20T12:00:00.000Z",
    }),
  );

  assert.match(html, /overdue/);
  assert.match(html, /NIS2 early warning/);
  assert.match(html, /National CSIRT/);
  assert.match(html, /due 2026-09-20T10:00:00.000Z/);
  assert.match(html, /clock: from declaration/);
  // Read-only without actions: no forms at all, and no suggestions to adopt.
  assert.equal(/<form/.test(html), false);
  assert.equal(/Track/.test(html), false);
});

test("the notification panel offers the legal moves and the suggested regimes", () => {
  const html = renderToStaticMarkup(
    createElement(NotificationPanel, {
      incidentId: "inc-1",
      obligations: [OBLIGATION],
      suggestions: [SUGGESTION],
      now: "2026-09-20T12:00:00.000Z",
      actions: { track: async () => {}, send: async () => {}, acknowledge: async () => {}, waive: async () => {} },
    }),
  );

  // Pending, so the moves offered are "mark sent" and "waive" — not acknowledge.
  assert.match(html, /Mark sent/);
  assert.match(html, /name="reason"/);
  assert.equal(/Mark acknowledged/.test(html), false);
  // A suggested regime is offered with its reason.
  assert.match(html, /Track GDPR personal-data breach/);
  assert.match(html, /because extensive impact/);
  // A regime with no suggestion is still adoptable by hand.
  assert.match(html, /Track another regime/);
});

test("the review panel shows a published review, its owners and an overdue action", () => {
  const actions: ReviewActionRecord[] = [
    {
      ...action(),
      dueAt: "2026-09-19T00:00:00.000Z",
    },
  ];
  const html = renderToStaticMarkup(
    createElement(ReviewPanel, {
      incidentId: "inc-1",
      review: { id: "rev-1", tenantId: "tenant-a", incidentId: "inc-1", findings: "A bastion host was scanned.", lessons: null, publishedBy: "agent-1", publishedAt: "2026-09-20T13:00:00.000Z" },
      actions,
      staff: [{ id: "user-2", displayName: "Linus Pratt", role: "AGENT" }],
      reviewable: true,
      now: "2026-09-20T13:05:00.000Z",
    }),
  );

  assert.match(html, /published/);
  assert.match(html, /A bastion host was scanned\./);
  assert.match(html, /Patch the VPN gateway/);
  assert.match(html, /owner Linus Pratt/);
  assert.match(html, /overdue/);
  assert.match(html, /1 overdue/);

  // Before the incident is reviewed, the panel says why publishing is not offered.
  const notYet = renderToStaticMarkup(
    createElement(ReviewPanel, {
      incidentId: "inc-1",
      review: null,
      actions: [],
      staff: [],
      reviewable: false,
      now: "2026-09-20T13:05:00.000Z",
    }),
  );
  assert.match(notYet, /Move the incident to reviewed to publish its post-incident review\./);
});

test("the publish form asks for an owner and a date for the action it creates", () => {
  const input: ReviewActionInput = { title: "x", ownerId: "u1", dueAt: "2026-10-01" };
  const html = renderToStaticMarkup(
    createElement(ReviewPanel, {
      incidentId: "inc-1",
      review: null,
      actions: [],
      staff: [{ id: "user-1", displayName: "Ada Mori", role: "ADMIN" }],
      reviewable: true,
      now: NOW,
      onAction: { publish: async () => {}, add: async () => {}, state: async () => {} },
    }),
  );
  // The incident is carried by the form itself — a publish action without it
  // cannot know which incident it is publishing for.
  assert.match(html, /name="incidentId" value="inc-1"/);
  assert.match(html, /name="findings"/);
  assert.match(html, /name="actionTitle-0"/);
  assert.match(html, /name="actionOwner-0"/);
  assert.match(html, /name="actionDue-0"/);
  assert.equal((html.match(/name="actionTitle-1"/g) ?? []).length, 1);
  assert.equal(input.ownerId, "u1");
});
