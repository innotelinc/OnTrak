/**
 * OnTrak Tix M4 tests: what each client's work came to, and the question their
 * own people answer.
 *
 * Two things are being proved here. That a per-client figure is built by the same
 * code as the desk-wide one — so a client's attainment can never disagree with
 * the report it was read off — and that the client-facing survey behaves like a
 * credential rather than a page: one question per period, one answer per link,
 * and an answer recorded on the audit chain that a stranger can reach without
 * being able to reach anything else.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m4-client-reporting.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import { ClientService, MemoryClientStore } from "../src/lib/client-service";
import {
  CLIENT_SURVEY_TTL_DAYS,
  clientSurveyAnswered,
  clientSurveyStatus,
  clientSurveySummary,
  surveyQuestion,
  validateCsatResponse,
  validateSurveyPeriod,
  type ClientSurveyRecord,
} from "../src/lib/client-survey-rules";
import {
  ClientSurveyService,
  MemoryClientSurveyStore,
  type ClientSurveyStore,
} from "../src/lib/client-survey-service";
import { buildClientCsv } from "../src/lib/report-csv";
import { clientScorecards, type ReportSurvey, type ReportTicket } from "../src/lib/report-rules";
import { weekdayCalendar, type SlaPolicy } from "../src/lib/sla-rules";
import {
  PrismaClientSurveyStore,
  toClientSurveyRecord,
  type ClientSurveyPrismaClient,
  type ClientSurveyRow,
} from "../src/lib/client-survey-store-prisma";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const ADMIN = { id: "admin-1", tenantId: "tenant-a", role: "ADMIN" as const };
const DISPATCHER = { id: "dispatcher-1", tenantId: "tenant-a", role: "DISPATCHER" as const };
const AGENT = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };
const REQUESTER = { id: "req-1", tenantId: "tenant-a", role: "REQUESTER" as const };
const NOW = "2026-09-20T12:00:00.000Z";
const TODAY = "2026-09-20";
/** The Monday and Tuesday the sample clocks run over. */
const MONDAY_9 = "2026-09-21T09:00:00.000Z";
const MONDAY_10 = "2026-09-21T10:00:00.000Z";
const MONDAY_12 = "2026-09-21T12:00:00.000Z";
const MONDAY_14 = "2026-09-21T14:00:00.000Z";
const TUESDAY_9 = "2026-09-22T09:00:00.000Z";

const CLIENTS = [
  { id: "client-1", name: "Northwind Logistics" },
  { id: "client-2", name: "Contoso Retail" },
];

function policy(overrides: Partial<SlaPolicy> = {}): SlaPolicy {
  return {
    id: "p-desk",
    name: "Desk default",
    responseMinutes: 240,
    resolutionMinutes: 1_440,
    calendar: weekdayCalendar("Weekdays"),
    warningFraction: 0.2,
    ...overrides,
  };
}

function ticket(overrides: Partial<ReportTicket> = {}): ReportTicket {
  return {
    id: "t1",
    ref: "TIX-000001",
    subject: "Printer",
    status: "RESOLVED",
    priority: "NORMAL",
    assigneeId: "agent-1",
    clientId: "client-1",
    createdAt: MONDAY_9,
    firstResponseAt: MONDAY_10,
    resolvedAt: MONDAY_12,
    ...overrides,
  };
}

/* -------------------------------------------------------------- the scorecards */

test("a client is judged against their own policy, and the figures are the report's own", () => {
  const policies: SlaPolicy[] = [
    policy({ id: "p-client-high", name: "Northwind HIGH", clientId: "client-1", priority: "HIGH", responseMinutes: 60, resolutionMinutes: 120 }),
    policy(),
  ];

  const tickets: ReportTicket[] = [
    // Northwind answered inside its hour and fixed inside its two: both met.
    ticket({ id: "n1", ref: "TIX-000001", priority: "HIGH", createdAt: MONDAY_9, firstResponseAt: "2026-09-21T09:30:00.000Z", resolvedAt: MONDAY_10 }),
    // …and one that blew both: answered five hours later, fixed the next morning.
    ticket({ id: "n2", ref: "TIX-000002", priority: "HIGH", createdAt: MONDAY_9, firstResponseAt: MONDAY_14, resolvedAt: TUESDAY_9 }),
    // Contoso has no policy of its own, so the desk's 4h/24h promise judges it — met.
    ticket({ id: "c1", ref: "TIX-000003", clientId: "client-2", createdAt: MONDAY_9, firstResponseAt: MONDAY_10, resolvedAt: MONDAY_12 }),
    // …and the desk's own work, which belongs to no client and still counts.
    ticket({ id: "d1", ref: "TIX-000004", clientId: null, createdAt: MONDAY_9, firstResponseAt: MONDAY_10, resolvedAt: "2026-09-21T11:00:00.000Z" }),
    // An open one, so "open" is a number somebody can act on.
    ticket({ id: "c2", ref: "TIX-000005", clientId: "client-2", status: "OPEN", createdAt: TUESDAY_9, firstResponseAt: null, resolvedAt: null }),
  ];

  const cards = clientScorecards(tickets, policies, CLIENTS, NOW);
  const byName = new Map(cards.map((card) => [card.name, card]));

  const northwind = byName.get("Northwind Logistics");
  assert.ok(northwind);
  assert.equal(northwind.total, 2);
  assert.equal(northwind.response.attainmentPercent, 50, "one of two answered inside the hour");
  assert.equal(northwind.resolution.attainmentPercent, 50);
  assert.equal(northwind.response.timing.measured, 2);

  const contoso = byName.get("Contoso Retail");
  assert.ok(contoso);
  assert.equal(contoso.total, 2);
  assert.equal(contoso.open, 1);
  assert.equal(contoso.response.attainmentPercent, 100);
  // The open ticket's clocks are running, so they are decided neither way: one
  // measurement, not two, and no verdict invented for the one still in flight.
  assert.equal(contoso.resolution.attainmentPercent, 100);
  assert.equal(contoso.resolution.timing.measured, 1);

  // The desk's own work is a bucket, not a rounding error: without it the client
  // figures would add up to less than the desk.
  const desk = byName.get("No client recorded");
  assert.ok(desk);
  assert.equal(desk.total, 1);
  assert.equal(desk.total + northwind.total + contoso.total, tickets.length);

  // Worst resolution attainment first, then name — "no data" sorts last, because
  // it is not the same as "doing badly".
  assert.deepEqual(cards.map((card) => card.name), ["Northwind Logistics", "Contoso Retail", "No client recorded"]);
});

test("per-client satisfaction counts both questions the desk asks, and a client that answers none says so", () => {
  const surveys: ReportSurvey[] = [
    // Two answers to the question on a resolved ticket…
    { clientId: "client-1", requestedAt: NOW, respondedAt: NOW, score: 5 },
    { clientId: "client-1", requestedAt: NOW, respondedAt: NOW, score: 3 },
    // …and one from the link their director answered.
    { clientId: "client-1", requestedAt: NOW, respondedAt: NOW, score: 4 },
    // Asked, never answered: that is information, not an absence of it.
    { clientId: "client-2", requestedAt: NOW, respondedAt: null, score: null },
  ];

  const tickets = [ticket({ id: "n1" }), ticket({ id: "c1", clientId: "client-2" })];
  const cards = clientScorecards(tickets, [policy()], CLIENTS, NOW, surveys);
  const northwind = cards.find((card) => card.clientId === "client-1");
  const contoso = cards.find((card) => card.clientId === "client-2");

  assert.equal(northwind?.csat.responses, 3);
  assert.equal(northwind?.csat.average, 4);
  assert.equal(northwind?.csat.positivePercent, 66.7);
  assert.equal(northwind?.csat.responseRatePercent, 100);

  assert.equal(contoso?.csat.responses, 0);
  assert.equal(contoso?.csat.average, null);
  assert.equal(contoso?.csat.pending, 1);
  assert.equal(contoso?.csat.responseRatePercent, 0, "one was offered and none came back — that is a zero, not a dash");
});

test("a client nothing measures is counted, not scored", () => {
  const cards = clientScorecards([ticket({ id: "n1" })], [], CLIENTS, NOW);
  const northwind = cards.find((card) => card.clientId === "client-1");
  assert.equal(northwind?.withoutPolicy, 1);
  assert.equal(northwind?.response.attainmentPercent, null, "no policy means no clock, not a perfect one");
  assert.equal(northwind?.resolution.attainmentPercent, null);
  // A client with no tickets at all is still a row, so "nothing happened" is visible.
  const contoso = cards.find((card) => card.clientId === "client-2");
  assert.equal(contoso?.total, 0);
  assert.equal(contoso?.csat.average, null);
});

test("the per-client CSV is a file an account manager can forward", () => {
  const cards = clientScorecards(
    [ticket({ id: "n1" }), ticket({ id: "c1", clientId: "client-2", status: "OPEN", resolvedAt: null, firstResponseAt: null })],
    [policy()],
    [...CLIENTS, { id: "client-3", name: 'East, "Ltd"' }],
    NOW,
    [{ clientId: "client-1", requestedAt: NOW, respondedAt: NOW, score: 5 }],
  );

  const csv = buildClientCsv(cards, { generatedAt: NOW });
  const rows = csv.trim().split("\r\n");
  assert.match(rows[0], /^OnTrak Tix report by client$/);
  assert.equal(
    rows[3],
    "Client,Tickets,Open,Breached,At risk,Without SLA policy,First response attainment %,First response median (business minutes),Resolution attainment %,Resolution median (business minutes),CSAT average,CSAT responses,CSAT positive %,CSAT response rate %",
  );
  // A client whose name has a comma and a quote in it survives the trip, and a
  // client with nothing measurable exports a dash rather than a zero.
  assert.ok(csv.includes('"East, ""Ltd""",0,0,0,0,0,,—,,—,,0,,'));
  assert.ok(csv.includes("Northwind Logistics,1,0,0,0,0,100,1h 0m,100,3h 0m,5,1,100,100"));
});

/* ------------------------------------------------------------------ the survey */

function survey(overrides: Partial<ClientSurveyRecord> = {}): ClientSurveyRecord {
  return {
    id: "survey-1",
    tenantId: "tenant-a",
    clientId: "client-1",
    token: "token-1",
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    requestedBy: "admin-1",
    requestedAt: NOW,
    score: null,
    comment: null,
    respondedAt: null,
    ...overrides,
  };
}

test("a period must have happened, or the answer means nothing", () => {
  assert.deepEqual(validateSurveyPeriod({ periodStart: "2026-08-01", periodEnd: "2026-08-31" }, TODAY), []);
  assert.match(validateSurveyPeriod({ periodStart: "August", periodEnd: "2026-08-31" }, TODAY)[0].message, /YYYY-MM-DD/);
  assert.match(validateSurveyPeriod({ periodStart: "2026-08-01", periodEnd: "2026-07-01" }, TODAY)[0].message, /cannot end before it starts/);
  assert.match(validateSurveyPeriod({ periodStart: "2026-09-01", periodEnd: "2026-09-30" }, TODAY)[0].message, /has not happened yet/);
  // The validator is the M1 one: the question is the same whoever answers it.
  assert.match(validateCsatResponse(9)[0].message, /Choose a rating from 1 to 5/);
});

test("a link is pending, answered or expired — and only counts once answered", () => {
  assert.equal(clientSurveyStatus(survey(), NOW), "pending");
  assert.equal(clientSurveyStatus(survey({ respondedAt: NOW, score: 4 }), NOW), "answered");
  assert.equal(clientSurveyStatus(survey({ requestedAt: "2026-07-01T00:00:00.000Z" }), NOW), "expired");
  assert.equal(CLIENT_SURVEY_TTL_DAYS, 45);

  assert.equal(clientSurveyAnswered(survey()), false);
  assert.equal(clientSurveyAnswered(survey({ respondedAt: NOW, score: null })), false);

  const summary = clientSurveySummary([
    survey({ id: "a", score: 5, respondedAt: NOW }),
    survey({ id: "b", score: 2, respondedAt: NOW }),
    survey({ id: "c" }),
  ]);
  assert.equal(summary.responses, 2);
  assert.equal(summary.pending, 1);
  assert.equal(summary.average, 3.5);
  assert.equal(summary.positivePercent, 50);
  assert.equal(summary.responseRatePercent, 66.7);

  assert.equal(surveyQuestion("Northwind", "2026-08-01", "2026-08-31"), "How was Northwind's support between 2026-08-01 and 2026-08-31?");
});

/* ----------------------------------------------------------- the survey service */

async function harness() {
  const audit = new AuditLog(sha256);
  const store = new MemoryClientSurveyStore();
  let clientN = 0;
  const clients = new ClientService(new MemoryClientStore(), audit, { id: () => `client-${++clientN}`, now: () => NOW });
  let n = 0;
  const service = new ClientSurveyService(store, clients, audit, {
    id: () => `id-${++n}`,
    token: () => `token-${n}`,
    now: () => NOW,
  });
  return { service, store, clients, audit };
}

test("asking is a manager's act, for a client in scope, once per period", async () => {
  const h = await harness();
  const northwind = await h.clients.create(ADMIN, { name: "Northwind" });
  assert.equal(northwind.ok, true);
  if (!northwind.ok) return;
  const clientId = northwind.value.id;

  // An agent may read a client's surveys but not send one.
  const agent = await h.service.request(AGENT, clientId, { periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  assert.equal(agent.ok, false);
  if (!agent.ok) assert.match(agent.error, /do not manage clients/);

  const refusedPeriod = await h.service.request(ADMIN, clientId, { periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  assert.equal(refusedPeriod.ok, false);
  if (!refusedPeriod.ok) assert.match(refusedPeriod.error, /has not happened yet/);

  const asked = await h.service.request(ADMIN, clientId, { periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  assert.equal(asked.ok, true);
  if (!asked.ok) return;
  assert.equal(asked.value.token, "token-1");
  assert.equal(asked.value.score, null);

  // Asking again for the same period returns the same link instead of a second one.
  const again = await h.service.request(ADMIN, clientId, { periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.value.id, asked.value.id);
  const all = await h.service.all(ADMIN);
  assert.equal(all.ok && all.value.length, 1);

  // A different period is a different question, and is allowed.
  const july = await h.service.request(ADMIN, clientId, { periodStart: "2026-07-01", periodEnd: "2026-07-31" });
  assert.equal(july.ok, true);
  assert.equal((await h.service.all(ADMIN)).ok && ((await h.service.all(ADMIN)) as { ok: true; value: unknown[] }).value.length, 2);

  // A dispatcher runs the desk, so the scope is everybody — but the client still
  // has to exist: a survey for nobody is a live public link to nothing.
  const madeUp = await h.service.request(DISPATCHER, "made-up", { periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  assert.equal(madeUp.ok, false);
  if (!madeUp.ok) assert.match(madeUp.error, /Client not found/);
  assert.equal((await h.service.list(REQUESTER, clientId)).ok, false);

  const events = h.audit.snapshot().events.filter((event) => event.action === "client.survey.request");
  assert.equal(events.length, 2);
  assert.equal(events[0].targetType, "client-survey");
  assert.equal(events[0].detail?.periodStart, "2026-08-01");
  assert.equal(events[0].actor, "admin-1");
});

test("answering takes only the link, once, and leaves the answer on the record", async () => {
  const h = await harness();
  const northwind = await h.clients.create(ADMIN, { name: "Northwind" });
  assert.equal(northwind.ok, true);
  if (!northwind.ok) return;

  const asked = await h.service.request(ADMIN, northwind.value.id, { periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  assert.equal(asked.ok, true);
  if (!asked.ok) return;

  // The public reads take no actor, because there is none to take.
  const opened = await h.service.open(asked.value.token);
  assert.equal(opened?.id, asked.value.id);
  assert.equal(await h.service.open("made-up"), null);

  const unknown = await h.service.submit("made-up", 5);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.error, /not valid/);

  // A score outside the scale is refused before anything is written.
  const nonsense = await h.service.submit(asked.value.token, 9);
  assert.equal(nonsense.ok, false);
  if (!nonsense.ok) assert.match(nonsense.error, /Choose a rating from 1 to 5/);
  assert.equal((await h.service.open(asked.value.token))?.respondedAt, null);

  const answered = await h.service.submit(asked.value.token, 4, "  quicker than usual  ");
  assert.equal(answered.ok, true);
  if (!answered.ok) return;
  assert.equal(answered.value.score, 4);
  assert.equal(answered.value.comment, "quicker than usual");
  assert.equal(answered.value.respondedAt, NOW);

  // One answer per link: a link that could be answered twice would let one person
  // move the average.
  const twice = await h.service.submit(asked.value.token, 1, "changed my mind");
  assert.equal(twice.ok, false);
  if (!twice.ok) assert.match(twice.error, /already been answered/);

  // An expired link is refused, and says so rather than pretending it is invalid.
  const stale = survey({ id: "survey-stale", token: "token-stale", requestedAt: "2026-01-01T00:00:00.000Z" });
  await h.store.insert(stale);
  const expired = await h.service.submit("token-stale", 5);
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.match(expired.error, /expired/);

  // Both halves are on the chain, and the answer is attributed to the link rather
  // than to a person — which is exactly who could have sent it.
  const events = h.audit.snapshot().events;
  const responds = events.filter((event) => event.action === "client.survey.respond");
  assert.equal(responds.length, 1);
  assert.equal(responds[0].actor, "client:survey");
  assert.equal(responds[0].detail?.score, 4);
  assert.equal(responds[0].detail?.hasComment, true);
  assert.equal(responds[0].targetId, asked.value.id);

  // The desk reads it back on the client's page, with the score and the words.
  const mine = await h.service.list(ADMIN, northwind.value.id);
  assert.equal(mine.ok, true);
  if (mine.ok) assert.equal(mine.value[0].score, 4);

  // A reader outside the client's scope is refused. The public page is the only
  // thing that answers to a token; the staff reads stay scoped.
  const outside = await h.service.list(AGENT, northwind.value.id);
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.match(outside.error, /not in your scope/);
});

/* ------------------------------------------------------------------- the adapter */

test("the Prisma store keeps a survey's period as days and narrows a hand-edited score", async () => {
  const row = (overrides: Partial<ClientSurveyRow> = {}): ClientSurveyRow => ({
    id: "survey-1",
    tenantId: "tenant-a",
    clientId: "client-1",
    token: "token-1",
    periodStart: new Date("2026-08-01T00:00:00.000Z"),
    periodEnd: new Date("2026-08-31T00:00:00.000Z"),
    requestedBy: "admin-1",
    requestedAt: new Date(NOW),
    score: null,
    comment: null,
    respondedAt: null,
    ...overrides,
  });

  const calls: unknown[] = [];
  const db = {
    clientSurvey: {
      findMany: async () => [row()],
      findFirst: async (args: unknown) => {
        calls.push(args);
        const where = (args as { where: { id?: string; score?: unknown } }).where;
        return "id" in where && where.id === "missing" ? null : row();
      },
      create: async (args: unknown) => {
        calls.push(args);
        return row();
      },
      update: async (args: unknown) => {
        calls.push(args);
        return row();
      },
    },
  } as unknown as ClientSurveyPrismaClient;

  const store: ClientSurveyStore = new PrismaClientSurveyStore(db);
  const found = await store.findForPeriod("tenant-a", "client-1", "2026-08-01", "2026-08-31");
  assert.equal(found?.periodStart, "2026-08-01");
  assert.equal(found?.periodEnd, "2026-08-31");
  assert.deepEqual((calls[0] as { where: unknown }).where, {
    tenantId: "tenant-a",
    clientId: "client-1",
    periodStart: new Date("2026-08-01T00:00:00.000Z"),
    periodEnd: new Date("2026-08-31T00:00:00.000Z"),
  });

  // A score a hand-edited row cannot mean reads as no answer rather than as a 9.
  assert.equal(toClientSurveyRecord(row({ score: 9 })).score, null);
  assert.equal(toClientSurveyRecord(row({ score: 5 })).score, 5);
  assert.equal(toClientSurveyRecord(row({ respondedAt: new Date(NOW) })).respondedAt, NOW);

  await store.insert(survey());
  const data = (calls[1] as { data: Record<string, unknown> }).data;
  assert.equal((data.periodStart as Date).toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(data.score, null, "an unanswered survey stores no score, not a zero");
  assert.equal(data.respondedAt, null);
});
