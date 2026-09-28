/**
 * OnTrak Tix M1 tests: the service-desk basics.
 *
 * Covers the three pure engines M1 adds — the SLA clock over business hours,
 * queue routing, and the CSAT / attachment rules — plus the one service change
 * they depend on: the first agent response stopping the response clock.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m1.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  ALWAYS_OPEN_CALENDAR,
  addBusinessMinutes,
  attainmentPercent,
  businessMinutesBetween,
  computeDeadlines,
  isOpenAt,
  nextOpen,
  pausesToJson,
  policyForPriority,
  resolutionClock,
  responseClock,
  slaInstanceFor,
  slaSummary,
  validateSlaPolicy,
  weekdayCalendar,
  type SlaInstance,
  type SlaPolicy,
} from "../src/lib/sla-rules";
import {
  DEFAULT_ESCALATION_LADDER,
  candidatesFor,
  consumedFraction,
  escalationKey,
  planEscalations,
  reachedThreshold,
} from "../src/lib/escalation-rules";
import { EscalationService, MemoryEscalationStore, type EscalationTicket } from "../src/lib/escalation-service";
import {
  buildSlaReport,
  formatMinutes,
  percentile,
  slaRemainingLabel,
  slaStatusFor,
  type ReportTicket,
} from "../src/lib/report-rules";
import { orderQueues, queueAccepts, routeTicket, type QueueDefinition } from "../src/lib/routing-rules";
import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import { MemoryTicketStore, TicketService } from "../src/lib/ticket-service";
import type { Actor } from "../src/lib/access-rules";
import {
  CSAT_SCALE,
  csatStatus,
  isPositive,
  isValidCsatScore,
  satisfactionLabel,
  shouldRequestSurvey,
  summariseCsat,
  validateCsatResponse,
  type CsatSurvey,
} from "../src/lib/csat-rules";
import {
  DEFAULT_ATTACHMENT_LIMITS,
  MemoryBlobStore,
  fileExtension,
  formatBytes,
  isAllowedType,
  sanitizeFilename,
  storageKeyFor,
  validateAttachment,
  validateAttachments,
} from "../src/lib/attachment-rules";
import { CsatService, MemoryCsatStore, planSurveyRequest, planSurveyResponse } from "../src/lib/csat-service";
import { AttachmentService, MemoryAttachmentStore } from "../src/lib/attachment-service";
import { FileBlobStore } from "../src/lib/attachment-blob-file";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");

/* -------------------------------------------------------------------------- */
/*  Business-hours calendar                                                   */
/* -------------------------------------------------------------------------- */

test("sla: a weekday calendar is open only inside its windows", () => {
  const calendar = weekdayCalendar("HQ", 0);
  // 2026-01-02 is a Friday, 2026-01-03 a Saturday.
  assert.equal(isOpenAt("2026-01-02T08:59:00.000Z", calendar), false);
  assert.equal(isOpenAt("2026-01-02T09:00:00.000Z", calendar), true);
  assert.equal(isOpenAt("2026-01-02T16:59:00.000Z", calendar), true);
  assert.equal(isOpenAt("2026-01-02T17:00:00.000Z", calendar), false, "the close is exclusive");
  assert.equal(isOpenAt("2026-01-03T10:00:00.000Z", calendar), false, "weekends are closed");
});

test("sla: nextOpen skips the weekend to Monday morning", () => {
  const calendar = weekdayCalendar("HQ", 0);
  assert.equal(nextOpen("2026-01-02T17:30:00.000Z", calendar).toISOString(), "2026-01-05T09:00:00.000Z");
});

test("sla: a holiday closes the calendar even on a weekday", () => {
  const calendar = { ...weekdayCalendar("HQ", 0), holidays: ["2026-01-05"] };
  assert.equal(isOpenAt("2026-01-05T10:00:00.000Z", calendar), false);
  // 120 business minutes from Friday 16:00 overshoots the holiday into Tuesday.
  assert.equal(addBusinessMinutes("2026-01-02T16:00:00.000Z", 120, calendar).toISOString(), "2026-01-06T10:00:00.000Z");
});

test("sla: business minutes only count open time", () => {
  const calendar = weekdayCalendar("HQ", 0);
  // 60 minutes of Friday, then the weekend, then 60 on Monday.
  assert.equal(
    businessMinutesBetween("2026-01-02T16:00:00.000Z", "2026-01-05T10:00:00.000Z", calendar),
    120,
  );
  assert.equal(businessMinutesBetween("2026-01-05T10:00:00.000Z", "2026-01-05T09:00:00.000Z", calendar), 0, "never negative");
});

test("sla: a 24x7 calendar is plain arithmetic", () => {
  assert.equal(
    addBusinessMinutes("2026-01-01T00:00:00.000Z", 90, ALWAYS_OPEN_CALENDAR).toISOString(),
    "2026-01-01T01:30:00.000Z",
  );
});

test("sla: the calendar zone shifts the open window", () => {
  const eastern = weekdayCalendar("East", -300);
  // 09:00 in UTC-5 is 14:00Z.
  assert.equal(isOpenAt("2026-01-02T13:59:00.000Z", eastern), false);
  assert.equal(isOpenAt("2026-01-02T14:00:00.000Z", eastern), true);
});

/* -------------------------------------------------------------------------- */
/*  Deadlines & clocks                                                        */
/* -------------------------------------------------------------------------- */

const alwaysOpen: SlaPolicy = {
  id: "p1",
  name: "Standard",
  responseMinutes: 60,
  resolutionMinutes: 240,
  calendar: ALWAYS_OPEN_CALENDAR,
  warningFraction: 0.5,
};

const started: SlaInstance = { policyId: "p1", startedAt: "2026-01-01T09:00:00.000Z", firstResponseAt: null, resolvedAt: null };

test("sla: deadlines are computed in business time", () => {
  const { responseDueAt, resolutionDueAt } = computeDeadlines(alwaysOpen, started.startedAt);
  assert.equal(responseDueAt.toISOString(), "2026-01-01T10:00:00.000Z");
  assert.equal(resolutionDueAt.toISOString(), "2026-01-01T13:00:00.000Z");
});

test("sla: the response clock moves on-track → warning → breached", () => {
  assert.equal(responseClock(started, alwaysOpen, "2026-01-01T09:20:00.000Z").state, "on-track");
  assert.equal(responseClock(started, alwaysOpen, "2026-01-01T09:40:00.000Z").state, "warning");
  assert.equal(responseClock(started, alwaysOpen, "2026-01-01T10:10:00.000Z").state, "breached");
});

test("sla: a first response met in time stops the clock as met", () => {
  const answered: SlaInstance = { ...started, firstResponseAt: "2026-01-01T09:30:00.000Z" };
  const clock = responseClock(answered, alwaysOpen, "2026-01-05T09:00:00.000Z");
  assert.equal(clock.state, "met");
  assert.equal(clock.elapsedMinutes, 30);
  assert.equal(clock.remainingMinutes, 30, "the remaining target is frozen once met");
});

test("sla: a late first response is breached, not warned", () => {
  const late: SlaInstance = { ...started, firstResponseAt: "2026-01-01T10:30:00.000Z" };
  assert.equal(responseClock(late, alwaysOpen, "2026-01-01T11:00:00.000Z").state, "breached");
});

test("sla: the resolution clock is met only on resolve", () => {
  const resolved: SlaInstance = { ...started, resolvedAt: "2026-01-01T12:00:00.000Z" };
  assert.equal(resolutionClock(resolved, alwaysOpen, "2026-01-01T14:00:00.000Z").state, "met");
  assert.equal(resolutionClock(started, alwaysOpen, "2026-01-01T13:30:00.000Z").state, "breached");
});

test("sla: the summary rolls both clocks into an at-risk flag", () => {
  const risky = slaSummary(started, alwaysOpen, "2026-01-01T09:40:00.000Z");
  assert.equal(risky.atRisk, true);
  assert.equal(risky.breached, false);
  assert.equal(risky.state, "warning");

  const breached = slaSummary(started, alwaysOpen, "2026-01-01T10:30:00.000Z");
  assert.equal(breached.breached, true);
  assert.equal(breached.state, "breached");
});

test("sla: attainment counts only decided clocks", () => {
  const met = responseClock({ ...started, firstResponseAt: "2026-01-01T09:30:00.000Z" }, alwaysOpen, "2026-01-01T12:00:00.000Z");
  const missed = responseClock({ ...started, firstResponseAt: "2026-01-01T11:30:00.000Z" }, alwaysOpen, "2026-01-01T12:00:00.000Z");
  const running = responseClock(started, alwaysOpen, "2026-01-01T09:10:00.000Z");
  assert.equal(attainmentPercent([met, missed, running]), 50);
  assert.equal(attainmentPercent([running]), null, "nothing decided means no percentage, not 100%");
});

/* -------------------------------------------------------------------------- */
/*  Policies                                                                  */
/* -------------------------------------------------------------------------- */

test("sla: the most specific policy wins, else the fallback", () => {
  const urgent = { ...alwaysOpen, id: "p-urgent", priority: "URGENT" as const };
  const fallback = { ...alwaysOpen, id: "p-any" };
  assert.equal(policyForPriority([fallback, urgent], "URGENT")?.id, "p-urgent");
  assert.equal(policyForPriority([fallback, urgent], "LOW")?.id, "p-any");
  assert.equal(policyForPriority([urgent], "LOW"), null);
});

test("sla: policy validation catches bad targets and calendars", () => {
  assert.equal(validateSlaPolicy(alwaysOpen).length, 0);
  const issues = validateSlaPolicy({
    name: "",
    responseMinutes: 120,
    resolutionMinutes: 60,
    warningFraction: 2,
    calendar: { ...weekdayCalendar("X", 0), week: [[{ startMinute: 600, endMinute: 0 }], [], [], [], [], [], []] },
  });
  const fields = issues.map((issue) => issue.field);
  assert.ok(fields.includes("name"));
  assert.ok(fields.includes("resolutionMinutes"), "resolution cannot precede the first response");
  assert.ok(fields.includes("warningFraction"));
  assert.ok(fields.includes("calendar"));
});

/* -------------------------------------------------------------------------- */
/*  Queue routing                                                             */
/* -------------------------------------------------------------------------- */

const queues: QueueDefinition[] = [
  { id: "q-urgent", slug: "urgent", name: "Urgent", order: 0, priorities: ["URGENT"] },
  { id: "q-net", slug: "network", name: "Network", order: 1, keywords: ["vpn", "network"] },
  { id: "q-general", slug: "general", name: "General", order: 99 },
];

test("routing: the first matching queue wins by order", () => {
  assert.equal(routeTicket({ type: "INCIDENT", priority: "URGENT", subject: "Email down", description: "" }, queues).queue?.id, "q-urgent");
  assert.equal(routeTicket({ type: "INCIDENT", priority: "NORMAL", subject: "VPN is broken", description: "" }, queues).queue?.id, "q-net");
});

test("routing: an unmatched ticket falls through to the catch-all", () => {
  const decision = routeTicket({ type: "REQUEST", priority: "LOW", subject: "New laptop", description: "" }, queues);
  assert.equal(decision.queue?.id, "q-general");
  assert.match(decision.reason, /catch-all|fell through/);
});

test("routing: no catch-all means nowhere to land", () => {
  const strict = queues.filter((queue) => queue.id !== "q-general");
  assert.equal(routeTicket({ type: "REQUEST", priority: "LOW", subject: "New laptop", description: "" }, strict).queue, null);
});

test("routing: queues order deterministically and criteria are ANDed", () => {
  assert.deepEqual(orderQueues(queues).map((queue) => queue.id), ["q-urgent", "q-net", "q-general"]);
  assert.equal(queueAccepts({ id: "x", slug: "x", name: "X", types: ["INCIDENT"], priorities: ["HIGH"] }, { type: "INCIDENT", priority: "HIGH", subject: "", description: "" }), true);
  assert.equal(queueAccepts({ id: "x", slug: "x", name: "X", types: ["INCIDENT"], priorities: ["HIGH"] }, { type: "REQUEST", priority: "HIGH", subject: "", description: "" }), false);
});

/* -------------------------------------------------------------------------- */
/*  CSAT                                                                      */
/* -------------------------------------------------------------------------- */

test("csat: a survey is offered only for a resolved, unasked ticket", () => {
  assert.equal(shouldRequestSurvey({ status: "RESOLVED", resolvedAt: "2026-01-02T00:00:00.000Z" }, false), true);
  assert.equal(shouldRequestSurvey({ status: "OPEN", resolvedAt: null }, false), false);
  assert.equal(shouldRequestSurvey({ status: "RESOLVED", resolvedAt: "2026-01-02T00:00:00.000Z" }, true), false, "never asked twice");
});

test("csat: scores are validated against the 1–5 scale", () => {
  assert.equal(isValidCsatScore(3), true);
  assert.equal(isValidCsatScore(0), false);
  assert.equal(isValidCsatScore(6), false);
  assert.equal(isValidCsatScore(3.5), false);
  assert.equal(validateCsatResponse(4).length, 0);
  assert.equal(validateCsatResponse("good").some((issue) => issue.field === "score"), true);
  assert.equal(validateCsatResponse(5, "x".repeat(2_001)).some((issue) => issue.field === "comment"), true);
});

test("csat: a survey expires after its window", () => {
  const survey: CsatSurvey = { token: "t", requestedAt: "2026-01-01T00:00:00.000Z", respondedAt: null, score: null, comment: null };
  assert.equal(csatStatus(survey, "2026-01-10T00:00:00.000Z"), "pending");
  assert.equal(csatStatus(survey, "2026-03-01T00:00:00.000Z"), "expired");
  assert.equal(csatStatus({ ...survey, respondedAt: "2026-01-02T00:00:00.000Z", score: 5 }, "2026-03-01T00:00:00.000Z"), "answered");
});

test("csat: the summary reports an honest response rate", () => {
  const surveys: CsatSurvey[] = [
    { token: "a", requestedAt: "2026-01-01T00:00:00.000Z", respondedAt: "2026-01-02T00:00:00.000Z", score: 5, comment: null },
    { token: "b", requestedAt: "2026-01-01T00:00:00.000Z", respondedAt: "2026-01-02T00:00:00.000Z", score: 2, comment: null },
    { token: "c", requestedAt: "2026-01-01T00:00:00.000Z", respondedAt: null, score: null, comment: null },
  ];
  const summary = summariseCsat(surveys, 4);
  assert.equal(summary.responses, 2);
  assert.equal(summary.average, 3.5);
  assert.equal(summary.positivePercent, 50);
  assert.equal(summary.responseRatePercent, 50);
  assert.equal(satisfactionLabel(5), "Very satisfied");
  assert.equal(isPositive(4), true);
  assert.equal(isPositive(3), false);
  assert.deepEqual(CSAT_SCALE, [1, 2, 3, 4, 5]);
});

/* -------------------------------------------------------------------------- */
/*  Attachments                                                               */
/* -------------------------------------------------------------------------- */

test("attachments: filenames cannot escape their directory", () => {
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("C:\\Users\\me\\report.pdf"), "report.pdf");
  assert.equal(sanitizeFilename("...hidden.txt"), "hidden.txt");
  assert.equal(sanitizeFilename(""), "file");
  assert.equal(fileExtension("REPORT.PDF"), ".pdf");
  assert.ok(sanitizeFilename(`${"x".repeat(300)}.png`).length <= 180);
});

test("attachments: only allow-listed types pass", () => {
  assert.equal(isAllowedType("image/png"), true);
  assert.equal(isAllowedType("IMAGE/PNG"), true);
  assert.equal(isAllowedType("text/plain; charset=utf-8"), true);
  assert.equal(isAllowedType("application/x-msdownload"), false);
  assert.equal(isAllowedType("text/html"), false);
});

test("attachments: size and count limits are enforced", () => {
  assert.equal(validateAttachment({ filename: "ok.png", contentType: "image/png", byteSize: 1024 }).length, 0);

  const tooBig = validateAttachment({ filename: "big.zip", contentType: "application/zip", byteSize: 11 * 1024 * 1024 });
  assert.ok(tooBig.some((issue) => issue.field === "byteSize"));

  const empty = validateAttachment({ filename: "empty.png", contentType: "image/png", byteSize: 0 });
  assert.ok(empty.some((issue) => issue.field === "byteSize"));

  const badType = validateAttachment({ filename: "run.exe", contentType: "application/x-msdownload", byteSize: 10 });
  assert.ok(badType.some((issue) => issue.field === "contentType"));

  const atLimit = validateAttachment({ filename: "ok.png", contentType: "image/png", byteSize: 10 }, DEFAULT_ATTACHMENT_LIMITS.maxCount);
  assert.ok(atLimit.some((issue) => issue.field === "count"));
});

test("attachments: a batch counts against the limit as it goes", () => {
  const batch = Array.from({ length: 3 }, (_, index) => ({ filename: `f${index}.png`, contentType: "image/png", byteSize: 1 }));
  const issues = validateAttachments(batch, DEFAULT_ATTACHMENT_LIMITS.maxCount - 1);
  assert.ok(issues.some((issue) => issue.field.startsWith("attachments[1]") || issue.field.startsWith("attachments[2]")));
});

test("attachments: storage keys are namespaced and never collide", () => {
  assert.equal(storageKeyFor("t1", "tkt1", "att1", "Shot.PNG"), "tix/t1/tkt1/att1.png");
  assert.notEqual(storageKeyFor("t1", "tkt1", "att1", "a.png"), storageKeyFor("t1", "tkt1", "att2", "a.png"));
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1_572_864), "1.5 MB");
});

test("attachments: the in-memory blob store round-trips and deletes", async () => {
  const store = new MemoryBlobStore();
  const bytes = new Uint8Array([1, 2, 3]);
  await store.put("k", bytes, "image/png");
  bytes[0] = 99;
  assert.deepEqual(await store.get("k"), new Uint8Array([1, 2, 3]), "stored bytes are not aliased");
  await store.delete("k");
  assert.equal(await store.get("k"), null);
});

/* -------------------------------------------------------------------------- */
/*  The service change M1 depends on                                          */
/* -------------------------------------------------------------------------- */

function buildService() {
  const store = new MemoryTicketStore();
  const audit = new AuditLog(sha256);
  return { store, audit, service: new TicketService(store, audit) };
}

const requester: Actor = { id: "u_req", tenantId: "t_acme", role: "REQUESTER" };
const agent: Actor = { id: "u_agent", tenantId: "t_acme", role: "AGENT" };

const NEW_TICKET = { subject: "VPN down", description: "cert invalid", type: "INCIDENT" as const, priority: "HIGH" as const };

test("service: a routed ticket is created directly in its queue", async () => {
  const { service } = buildService();
  const created = await service.createTicket(requester, { ...NEW_TICKET, queueId: "q-net" });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.queueId, "q-net");
  assert.equal(created.value.firstResponseAt, null);
});

test("service: the first public agent reply stamps the response clock", async () => {
  const { service, store } = buildService();
  const created = await service.createTicket(requester, NEW_TICKET);
  if (!created.ok) return;

  // A requester's own follow-up and an internal note must not stop the clock.
  await service.reply(requester, created.value.id, "Any update?", "PUBLIC_REPLY");
  let stored = await store.findTicket("t_acme", created.value.id);
  assert.equal(stored?.firstResponseAt, null);

  await service.reply(agent, created.value.id, "Looking now.", "INTERNAL_NOTE");
  stored = await store.findTicket("t_acme", created.value.id);
  assert.equal(stored?.firstResponseAt, null, "an internal note is not a response to the requester");

  await service.reply(agent, created.value.id, "Recreated the tunnel.", "PUBLIC_REPLY");
  const stamped = await store.findTicket("t_acme", created.value.id);
  assert.equal(stamped?.firstResponseAt, stamped?.messages[stamped.messages.length - 1].createdAt);
  assert.notEqual(stamped?.firstResponseAt, null);

  // A later public reply does not move the stopped clock.
  await service.reply(agent, created.value.id, "Still monitoring.", "PUBLIC_REPLY");
  const later = await store.findTicket("t_acme", created.value.id);
  assert.equal(later?.firstResponseAt, stamped?.firstResponseAt);
});

/* -------------------------------------------------------------------------- */
/*  CSAT service                                                              */
/* -------------------------------------------------------------------------- */

const csatTicket = {
  id: "tkt1",
  tenantId: "t_acme",
  status: "RESOLVED" as const,
  resolvedAt: "2026-01-02T00:00:00.000Z",
  requesterId: "u_req",
};

function fixedCsatService() {
  const store = new MemoryCsatStore();
  let n = 0;
  const ids = { id: () => `c${(n += 1)}`, token: () => `tok${n}`, now: () => "2026-01-03T00:00:00.000Z" };
  return { service: new CsatService(store, ids), store };
}

test("csat: a survey is only requested for a resolved ticket the actor can read", async () => {
  const { service } = fixedCsatService();
  const plan = planSurveyRequest(requester, csatTicket, null, { id: () => "c1", token: () => "tok", now: () => "2026-01-03T00:00:00.000Z" });
  assert.equal(plan.ok, true);

  const open = { ...csatTicket, status: "OPEN" as const, resolvedAt: null };
  assert.equal(planSurveyRequest(requester, open, null, { id: () => "c", token: () => "t", now: () => "x" }).ok, false);

  const outsider = { ...requester, id: "u_other" };
  assert.equal(planSurveyRequest(outsider, csatTicket, null, { id: () => "c", token: () => "t", now: () => "x" }).ok, false);

  const created = await service.requestSurvey(requester, csatTicket);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.token, "tok1");

  // Asking twice returns the same link, never a second one.
  const again = await service.requestSurvey(requester, csatTicket);
  assert.equal(again.ok && again.value.token, "tok1");
});

test("csat: a survey is answered once and then locked", async () => {
  const { service } = fixedCsatService();
  const survey = await service.requestSurvey(requester, csatTicket);
  if (!survey.ok) return;
  const token = survey.value.token;

  assert.equal((await service.submit(token, 6)).ok, false, "out-of-range scores are refused");
  const answered = await service.submit(token, 5, "Great service");
  assert.equal(answered.ok, true);
  if (!answered.ok) return;
  assert.equal(answered.value.score, 5);
  assert.equal(answered.value.respondedAt, "2026-01-03T00:00:00.000Z");

  assert.equal((await service.submit(token, 1)).ok, false, "a second answer is refused");
  assert.equal((await service.submit("nope", 5)).ok, false, "an unknown token is refused");
});

test("csat: an expired link cannot be answered", () => {
  const survey = {
    id: "c1",
    tenantId: "t_acme",
    ticketId: "tkt1",
    token: "tok",
    score: null,
    comment: null,
    requestedAt: "2026-01-01T00:00:00.000Z",
    respondedAt: null,
  };
  const plan = planSurveyResponse(survey, 5, undefined, "2026-03-01T00:00:00.000Z");
  assert.equal(plan.ok, false);
});

/* -------------------------------------------------------------------------- */
/*  Attachment service                                                        */
/* -------------------------------------------------------------------------- */

const attachTicket = { id: "tkt1", tenantId: "t_acme", requesterId: "u_req", assigneeId: null };

function attachmentService() {
  const store = new MemoryAttachmentStore();
  const blobs = new MemoryBlobStore();
  let n = 0;
  const ids = { id: () => `a${(n += 1)}`, now: () => "2026-01-03T00:00:00.000Z" };
  return { service: new AttachmentService(store, blobs, DEFAULT_ATTACHMENT_LIMITS, ids), store, blobs };
}

test("attachments: an accepted upload is validated, stored and listed", async () => {
  const { service, blobs } = attachmentService();
  const result = await service.attach(requester, attachTicket, [
    { filename: "../error.txt", contentType: "text/plain", data: new Uint8Array([1, 2, 3]) },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value[0].filename, "../error.txt", "metadata keeps the original name");
  assert.equal(result.value[0].storageKey, "tix/t_acme/tkt1/a1.txt");
  assert.deepEqual(await blobs.get("tix/t_acme/tkt1/a1.txt"), new Uint8Array([1, 2, 3]));

  const listed = await service.list(requester, attachTicket);
  assert.equal(listed.length, 1);
  assert.equal((await service.list({ ...requester, id: "someone" }, attachTicket)).length, 0, "another requester sees nothing");
});

test("attachments: a rejected batch writes nothing at all", async () => {
  const { service, store, blobs } = attachmentService();
  const result = await service.attach(requester, attachTicket, [
    { filename: "ok.png", contentType: "image/png", data: new Uint8Array([1]) },
    { filename: "run.exe", contentType: "application/x-msdownload", data: new Uint8Array([1]) },
  ]);
  assert.equal(result.ok, false);
  assert.equal(await store.countForTicket("t_acme", "tkt1"), 0, "no metadata is persisted");
  assert.equal(await blobs.get("tix/t_acme/tkt1/a1.png"), null, "no bytes are persisted");
});

/* -------------------------------------------------------------------------- */
/*  SLA escalations                                                           */
/* -------------------------------------------------------------------------- */

test("escalation: the ladder fires at half, near-deadline and passed", () => {
  const at = (now: string) => responseClock(started, alwaysOpen, now);

  assert.equal(consumedFraction(at("2026-01-01T09:20:00.000Z")), 20 / 60);
  assert.equal(reachedThreshold(at("2026-01-01T09:20:00.000Z")), null, "a fifth of the way in is not an escalation");
  assert.equal(reachedThreshold(at("2026-01-01T09:40:00.000Z"))?.level, 1);
  assert.equal(reachedThreshold(at("2026-01-01T09:55:00.000Z"))?.level, 2);
  assert.equal(reachedThreshold(at("2026-01-01T10:10:00.000Z"))?.level, 3, "a passed deadline is the top rung");
});

test("escalation: a clock met on time never escalates", () => {
  const met = responseClock({ ...started, firstResponseAt: "2026-01-01T09:30:00.000Z" }, alwaysOpen, "2026-01-05T00:00:00.000Z");
  assert.equal(reachedThreshold(met), null);
});

test("escalation: the ladder widens the audience as it rises", () => {
  assert.deepEqual(DEFAULT_ESCALATION_LADDER.map((rung) => rung.audience), ["AGENT", "DISPATCHER", "MANAGER"]);
  assert.equal(escalationKey("t1", "response", 2), "t1:response:2");
});

test("escalation: planning skips rungs already raised", () => {
  const view = responseClock(started, alwaysOpen, "2026-01-01T09:55:00.000Z"); // level 2
  const fresh = planEscalations(candidatesFor("t1", "TIX-000001", slaSummary(started, alwaysOpen, "2026-01-01T09:55:00.000Z")));
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].level, 2);
  assert.equal(fresh[0].audience, "DISPATCHER");
  assert.equal(fresh[0].dedupeKey, "t1:response:2");

  const again = planEscalations([{ ticketId: "t1", ticketRef: "TIX-000001", kind: "response", view, alreadyRaised: [2] }]);
  assert.equal(again.length, 0);
});

const sweepTicket: EscalationTicket = {
  id: "t1",
  ref: "TIX-000001",
  priority: "NORMAL",
  createdAt: "2026-01-01T09:00:00.000Z",
  firstResponseAt: null,
  resolvedAt: null,
  status: "OPEN",
};

function escalationService() {
  const store = new MemoryEscalationStore();
  const audit = new AuditLog(sha256);
  const service = new EscalationService(store, audit);
  return { service, store, audit };
}

test("sla sweep: a warning is raised once and never duplicated", async () => {
  const { service, audit } = escalationService();
  const policies: SlaPolicy[] = [alwaysOpen];

  const first = await service.sweep({ tenantId: "t_acme", tickets: [sweepTicket], policies, now: "2026-01-01T09:40:00.000Z" });
  assert.equal(first.length, 1);
  assert.equal(first[0].level, 1);
  assert.equal(first[0].kind, "response");
  assert.equal(first[0].reason, "TIX-000001 response SLA — half the window used.");

  // The same instant again is a no-op — this is what makes the cron safe.
  assert.equal((await service.sweep({ tenantId: "t_acme", tickets: [sweepTicket], policies, now: "2026-01-01T09:40:00.000Z" })).length, 0);

  // Time passes: the clock reaches the next rung.
  const later = await service.sweep({ tenantId: "t_acme", tickets: [sweepTicket], policies, now: "2026-01-01T10:10:00.000Z" });
  assert.equal(later.length, 1);
  assert.equal(later[0].level, 3);
  assert.equal(later[0].audience, "MANAGER");

  assert.equal((await service.list("t_acme")).length, 2);
  assert.deepEqual(audit.verify(), { ok: true, length: 2 });
});

test("sla sweep: closed work and unpolicied tickets are left alone", async () => {
  const { service } = escalationService();
  const resolved: EscalationTicket = { ...sweepTicket, id: "t2", status: "RESOLVED", resolvedAt: "2026-01-01T09:30:00.000Z" };
  const raised = await service.sweep({
    tenantId: "t_acme",
    tickets: [resolved, { ...sweepTicket, id: "t3", priority: "URGENT" }],
    policies: [alwaysOpen],
    now: "2026-01-01T09:55:00.000Z",
  });
  assert.equal(raised.length, 1, "only the open, policied ticket escalates");
  assert.equal(raised[0].ticketId, "t3");
});

test("report: percentiles use nearest-rank and handle an empty list", () => {
  assert.equal(percentile([4, 1, 3, 2], 50), 2);
  assert.equal(percentile([4, 1, 3, 2], 90), 4);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([], 50), null);
});

const urgentPolicy: SlaPolicy = { ...alwaysOpen, id: "p-urgent", priority: "URGENT" };

function reportTicket(overrides: Partial<ReportTicket>): ReportTicket {
  return {
    id: "t",
    ref: "TIX-000000",
    subject: "s",
    status: "OPEN",
    priority: "URGENT",
    assigneeId: null,
    createdAt: "2026-01-01T09:00:00.000Z",
    firstResponseAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

test("report: attainment, timings and the risk lists come from the clocks", () => {
  const tickets: ReportTicket[] = [
    reportTicket({ id: "a", ref: "TIX-000001", firstResponseAt: "2026-01-01T09:30:00.000Z" }),
    reportTicket({ id: "b", ref: "TIX-000002" }),
    reportTicket({ id: "c", ref: "TIX-000003", createdAt: "2026-01-01T08:00:00.000Z" }),
    reportTicket({
      id: "d",
      ref: "TIX-000004",
      status: "RESOLVED",
      firstResponseAt: "2026-01-01T09:30:00.000Z",
      resolvedAt: "2026-01-01T10:00:00.000Z",
    }),
    reportTicket({ id: "e", ref: "TIX-000005", priority: "NORMAL" }),
  ];

  const report = buildSlaReport(tickets, [urgentPolicy], "2026-01-01T09:55:00.000Z");

  assert.deepEqual(report.totals, { total: 5, open: 4, unassigned: 4, resolvedOrClosed: 1, withoutPolicy: 1 });
  assert.equal(report.response.attainmentPercent, 100, "only decided clocks count");
  assert.equal(report.resolution.attainmentPercent, 100);
  assert.equal(report.response.timing.medianMinutes, 30);
  assert.equal(report.resolution.timing.medianMinutes, 60);
  assert.deepEqual(report.breached.map((row) => row.ref), ["TIX-000003"]);
  assert.deepEqual(report.atRisk.map((row) => row.ref), ["TIX-000003", "TIX-000002"]);
  assert.equal(report.tickets.length, 4, "the unpolicied ticket has no status row");
});

test("report: a single ticket's SLA status is null without a policy", () => {
  assert.equal(slaStatusFor(reportTicket({ priority: "LOW" }), [urgentPolicy], "2026-01-01T09:10:00.000Z"), null);

  const breached = slaStatusFor(reportTicket({ createdAt: "2026-01-01T08:00:00.000Z" }), [urgentPolicy], "2026-01-01T09:55:00.000Z");
  assert.equal(breached?.breached, true);
  assert.equal(breached?.atRisk, true);
  assert.equal(slaRemainingLabel(breached!), "SLA breached");

  const running = slaStatusFor(reportTicket({}), [urgentPolicy], "2026-01-01T09:30:00.000Z");
  assert.equal(running?.breached, false);
  assert.equal(slaRemainingLabel(running!), "SLA in 30m");

  const met = slaStatusFor(
    reportTicket({ status: "RESOLVED", firstResponseAt: "2026-01-01T09:30:00.000Z", resolvedAt: "2026-01-01T10:00:00.000Z" }),
    [urgentPolicy],
    "2026-01-05T00:00:00.000Z",
  );
  assert.equal(met?.state, "met");
  assert.equal(slaRemainingLabel(met!), "SLA met");
});

test("report: minutes format as hours and minutes", () => {
  assert.equal(formatMinutes(null), "—");
  assert.equal(formatMinutes(0), "0m");
  assert.equal(formatMinutes(60), "1h 0m");
  assert.equal(formatMinutes(75), "1h 15m");
  assert.equal(formatMinutes(-5), "0m");
});

test("report: a ticket with no matching policy is counted, not scored", () => {
  const report = buildSlaReport([reportTicket({ priority: "LOW" })], [urgentPolicy], "2026-01-01T09:10:00.000Z");
  assert.equal(report.totals.withoutPolicy, 1);
  assert.equal(report.response.attainmentPercent, null);
  assert.equal(report.breached.length, 0);
});

test("sla instance: a ticket's timestamps project onto the clocks", () => {
  const instance = slaInstanceFor({ createdAt: "2026-01-01T09:00:00.000Z", firstResponseAt: null, resolvedAt: null }, "p1");
  assert.deepEqual(instance, {
    policyId: "p1",
    startedAt: "2026-01-01T09:00:00.000Z",
    firstResponseAt: null,
    resolvedAt: null,
    pauses: [],
  });

  // Pauses ride along with the instance so every clock sees the same stopped windows.
  const paused = slaInstanceFor(
    {
      createdAt: "2026-01-01T09:00:00.000Z",
      firstResponseAt: null,
      resolvedAt: null,
      pauses: [{ startedAt: "2026-01-01T10:00:00.000Z", endedAt: null }],
    },
    "p1",
  );
  assert.equal(paused.pauses?.length, 1);
  assert.deepEqual(pausesToJson(paused.pauses ?? []), [{ startedAt: "2026-01-01T10:00:00.000Z", endedAt: null }]);
});

test("attachments: the filesystem blob store refuses a key that escapes its root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ontrak-blobs-"));
  try {
    const store = new FileBlobStore(root);
    await store.put("tix/t1/att1.txt", new Uint8Array([7]));
    assert.deepEqual(await store.get("tix/t1/att1.txt"), new Uint8Array([7]));
    await assert.rejects(() => store.put("../escape.txt", new Uint8Array([1])), /unsafe blob key/);
    await assert.rejects(() => store.put("/etc/passwd", new Uint8Array([1])), /unsafe blob key/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
