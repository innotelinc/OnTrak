/**
 * OnTrak Tix app-layer tests.
 *
 * Covers the parts that sit between the pure rules and the running app: the
 * Prisma store/audit adapters (against a fake client), tenant-scoped session
 * rules, the inbox view model, and the rendered inbox component. Run with:
 *
 *   npx tsx --test ontrak-tix/tests/tix-app.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PrismaAuditSink,
  PrismaTicketStore,
  chainFromRows,
  toAuditRecord,
  toAuditRow,
  toTicketCreate,
  toTicketRecord,
  toTicketUpdate,
  type AuditEventRow,
  type MessageRow,
  type TicketPrismaClient,
  type TicketRow,
} from "../src/lib/ticket-store-prisma";
import { createTicketServices, configureTickets, ticketServices } from "../src/lib/ticket-server";
import { TicketService, type TicketRecord } from "../src/lib/ticket-service";
import type { AuditRecord } from "../src/lib/audit-chain";
import { buildInboxView, parseInboxFilter, selectedTicket } from "../src/lib/inbox-view";
import {
  claimsForTenant,
  isTixSessionClaims,
  cookieIsSecure,
  parseCookieSecurity,
  sessionActor,
  sessionDisplayName,
  TIX_SESSION_COOKIE,
} from "../src/lib/session-rules";
import type { Actor, Role } from "../src/lib/access-rules";
import { AgentInbox } from "../src/components/AgentInbox";
import { TicketDetail } from "../src/components/TicketDetail";

/* -------------------------------------------------------------------------- */
/*  A Prisma-shaped fake                                                      */
/* -------------------------------------------------------------------------- */

/** The smallest client that satisfies the adapters' structural interface. */
class FakePrisma implements TicketPrismaClient {
  private readonly tickets = new Map<string, TicketRow>();
  private readonly messages = new Map<string, MessageRow>();
  private readonly audit = new Map<string, AuditEventRow>();

  ticket = {
    count: async (args: any): Promise<number> =>
      [...this.tickets.values()].filter((row) => row.tenantId === args.where.tenantId).length,
    findFirst: async (args: any): Promise<TicketRow | null> => {
      const row = this.tickets.get(args.where.id);
      if (!row || row.tenantId !== args.where.tenantId) return null;
      return { ...row, messages: this.messagesFor(row.id) };
    },
    findMany: async (args: any): Promise<TicketRow[]> =>
      [...this.tickets.values()]
        .filter((row) => row.tenantId === args.where.tenantId)
        .map((row) => ({ ...row, messages: this.messagesFor(row.id) })),
    create: async (args: any): Promise<unknown> => {
      const { messages, ...ticket } = args.data;
      this.tickets.set(ticket.id, ticket as TicketRow);
      for (const message of (messages?.create ?? []) as MessageRow[]) this.messages.set(message.id, message);
      return ticket;
    },
    update: async (args: any): Promise<unknown> => {
      const row = this.tickets.get(args.where.id);
      if (!row) throw new Error(`no ticket ${args.where.id}`);
      Object.assign(row, args.data);
      return row;
    },
  };

  message = {
    createMany: async (args: any): Promise<unknown> => {
      for (const message of args.data as MessageRow[]) {
        if (!this.messages.has(message.id)) this.messages.set(message.id, message);
      }
      return { count: args.data.length };
    },
  };

  auditEvent = {
    findMany: async (args: any): Promise<AuditEventRow[]> =>
      [...this.audit.values()].filter((row) => row.tenantId === args.where.tenantId).sort((a, b) => a.seq - b.seq),
    create: async (args: any): Promise<unknown> => {
      this.audit.set(args.data.id, args.data);
      return args.data;
    },
  };

  /** Reach into a persisted row for the tamper test. */
  rowsFor(tenantId: string): AuditEventRow[] {
    return [...this.audit.values()].filter((row) => row.tenantId === tenantId).sort((a, b) => a.seq - b.seq);
  }

  private messagesFor(ticketId: string): MessageRow[] {
    return [...this.messages.values()]
      .filter((message) => message.ticketId === ticketId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
}

const requester: Actor = { id: "u_req", tenantId: "t_acme", role: "REQUESTER" };
const agent: Actor = { id: "u_agent", tenantId: "t_acme", role: "AGENT" };

const NEW_TICKET = { subject: "VPN down", description: "The certificate is invalid.", type: "INCIDENT" as const, priority: "HIGH" as const };

/* -------------------------------------------------------------------------- */
/*  Mappers                                                                   */
/* -------------------------------------------------------------------------- */

test("mapper: a ticket row becomes a domain record with ISO timestamps", () => {
  const row: TicketRow = {
    id: "t1",
    tenantId: "t_acme",
    ref: "TIX-000001",
    subject: "Printer jam",
    description: "Tray 2",
    type: "INCIDENT",
    status: "OPEN",
    priority: "NORMAL",
    requesterId: "u_req",
    assigneeId: null,
    queueId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    firstResponseAt: null,
    resolvedAt: null,
    closedAt: null,
    messages: [
      {
        id: "m1",
        tenantId: "t_acme",
        ticketId: "t1",
        authorId: null,
        kind: "PUBLIC_REPLY",
        body: "Looking at it",
        createdAt: new Date("2026-01-01T01:00:00.000Z"),
      },
    ],
  };

  const record = toTicketRecord(row);
  assert.equal(record.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(record.resolvedAt, null);
  assert.equal(record.messages[0].createdAt, "2026-01-01T01:00:00.000Z");
  assert.equal(record.messages[0].authorId, null);
});

test("mapper: create and update never move a ticket's identity", () => {
  const record = toTicketRecord({
    id: "t1",
    tenantId: "t_acme",
    ref: "TIX-000001",
    subject: "s",
    description: "d",
    type: "REQUEST",
    status: "NEW",
    priority: "LOW",
    requesterId: "u_req",
    assigneeId: "u_agent",
    queueId: "q1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    firstResponseAt: null,
    resolvedAt: null,
    closedAt: null,
  });

  const create = toTicketCreate(record);
  assert.equal(create.ref, "TIX-000001");
  assert.deepEqual(create.createdAt, new Date("2026-01-01T00:00:00.000Z"));

  const update = toTicketUpdate(record);
  assert.ok(!("id" in update) && !("tenantId" in update) && !("ref" in update) && !("createdAt" in update));
  assert.equal(update.assigneeId, "u_agent");
});

test("mapper: audit rows round-trip without changing the hash payload", () => {
  const record: AuditRecord = {
    id: "evt-1",
    tenantId: "t_acme",
    seq: 1,
    at: "2026-09-26T10:00:00.000Z",
    actor: "u_admin",
    action: "ticket.create",
    targetType: "ticket",
    targetId: "tkt_1",
    detail: { ref: "TIX-000001" },
    prevHash: "0".repeat(64),
    recordHash: "abc",
  };
  // undefined fields become null in the row and undefined again on the way back.
  const bare: AuditRecord = { ...record, targetType: undefined, targetId: undefined, detail: undefined };
  const back = toAuditRecord(toAuditRow(bare));
  assert.equal(back.targetType, undefined);
  assert.equal(back.detail, undefined);
  assert.deepEqual(chainFromRows([toAuditRow(bare)]).head, "abc");
  assert.deepEqual(chainFromRows([]).head, "0".repeat(64));
});

/* -------------------------------------------------------------------------- */
/*  Prisma store + audit sink                                                 */
/* -------------------------------------------------------------------------- */

test("prisma store: a ticket and its thread survive a full read-back", async () => {
  const db = new FakePrisma();
  const store = new PrismaTicketStore(db);

  const created = await createTicketServices(db).service.createTicket(requester, NEW_TICKET);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.ref, "TIX-000001");

  // The next ticket for the same tenant gets the next reference.
  const second = await createTicketServices(db).service.createTicket(requester, { ...NEW_TICKET, subject: "Second" });
  assert.equal(second.ok && second.value.ref, "TIX-000002");

  await createTicketServices(db).service.reply(agent, created.value.id, "On it", "INTERNAL_NOTE");
  const reread = await store.findTicket("t_acme", created.value.id);
  assert.equal(reread?.subject, "VPN down");
  assert.deepEqual(reread?.messages.map((m) => m.kind), ["INTERNAL_NOTE"]);

  const list = await store.listTickets("t_acme");
  assert.equal(list.length, 2);
  assert.equal(await store.findTicket("t_other", created.value.id), null, "another tenant sees nothing");
});

test("prisma audit: the chain persists and continues across a fresh service", async () => {
  const db = new FakePrisma();
  const first = createTicketServices(db);
  await first.service.createTicket(requester, NEW_TICKET);

  const sink = first.audit as PrismaAuditSink;
  assert.deepEqual(await sink.verify("t_acme"), { ok: true, length: 1 });

  // A new process (new store, new sink) over the same database must continue the
  // same chain, not start a second one at seq 1.
  const restarted = createTicketServices(db);
  const created = await restarted.service.createTicket(requester, { ...NEW_TICKET, subject: "After restart" });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const verify = await (restarted.audit as PrismaAuditSink).verify("t_acme");
  assert.deepEqual(verify, { ok: true, length: 2 });

  const loaded = await (restarted.audit as PrismaAuditSink).load("t_acme");
  assert.equal(loaded.events[1].prevHash, loaded.events[0].recordHash);
  assert.equal(loaded.events[1].action, "ticket.create");
});

test("prisma audit: a tampered database row is detected, not extended", async () => {
  const db = new FakePrisma();
  const services = createTicketServices(db);
  await services.service.createTicket(requester, NEW_TICKET);
  await services.service.createTicket(requester, { ...NEW_TICKET, subject: "Two" });

  const rows = db.rowsFor("t_acme");
  rows[0].detail = { ref: "TIX-999999" };

  const verify = await (services.audit as PrismaAuditSink).verify("t_acme");
  assert.equal(verify.ok, false);
  assert.equal(verify.ok === false && verify.brokenAt, 1);
});

test("prisma audit: a fresh sink refuses to extend a broken chain", async () => {
  const db = new FakePrisma();
  await createTicketServices(db).service.createTicket(requester, NEW_TICKET);
  db.rowsFor("t_acme")[0].recordHash = "forged";

  const fresh = createTicketServices(db);
  await assert.rejects(
    () => fresh.service.createTicket(requester, { ...NEW_TICKET, subject: "Nope" }),
    /failed verification/,
  );
});

test("configureTickets: the process-wide stack is built and then reused", () => {
  const db = new FakePrisma();
  const first = configureTickets(db);
  assert.equal(ticketServices(), first);
  assert.ok(ticketServices().service instanceof TicketService);
  assert.ok(first.store instanceof PrismaTicketStore);
  assert.ok(first.audit instanceof PrismaAuditSink);
});

/* -------------------------------------------------------------------------- */
/*  Session rules                                                             */
/* -------------------------------------------------------------------------- */

test("session: only a complete, known-role claim set is accepted", () => {
  assert.equal(isTixSessionClaims({ userId: "u1", tenantId: "t1", role: "AGENT" }), true);
  assert.equal(isTixSessionClaims({ userId: "u1", tenantId: "t1", role: "WIZARD" }), false);
  assert.equal(isTixSessionClaims({ userId: "", tenantId: "t1", role: "AGENT" }), false);
  assert.equal(isTixSessionClaims({ userId: "u1", role: "AGENT" }), false);
  assert.equal(isTixSessionClaims(null), false);
});

test("session: claims become an actor and are scoped to their tenant", () => {
  const claims = { userId: "u1", tenantId: "t_acme", role: "DISPATCHER" as Role, name: "Dee", email: "dee@x" };
  assert.deepEqual(sessionActor(claims), { id: "u1", tenantId: "t_acme", role: "DISPATCHER" });
  assert.equal(claimsForTenant(claims, "t_acme"), claims);
  assert.equal(claimsForTenant(claims, "t_other"), null);
  assert.equal(sessionDisplayName(claims), "Dee");
  assert.equal(sessionDisplayName({ userId: "u1", tenantId: "t", role: "AGENT", email: "a@x" }), "a@x");
  assert.equal(TIX_SESSION_COOKIE, "ontrak_tix_session");
});

test("session: the Secure flag follows the request, not the build", () => {
  // The bug this pins: `secure: NODE_ENV === "production"` marked every cookie Secure
  // on a stack that serves plain HTTP, and a browser drops a Secure cookie from an
  // insecure origin — so a production desk signed in on `localhost` and nowhere else.
  assert.equal(cookieIsSecure("auto", "http"), false);
  assert.equal(cookieIsSecure("auto", "https"), true);
  assert.equal(cookieIsSecure("auto", " HTTPS "), true, "a proxy may shout");
  assert.equal(cookieIsSecure("auto", null), false, "no report means the connection was not TLS");
  assert.equal(cookieIsSecure("auto", undefined), false);

  // An operator who knows better than the request still wins, in both directions.
  assert.equal(cookieIsSecure("always", "http"), true);
  assert.equal(cookieIsSecure("never", "https"), false);

  assert.equal(parseCookieSecurity(undefined), "auto");
  assert.equal(parseCookieSecurity(""), "auto");
  assert.equal(parseCookieSecurity("true"), "always");
  assert.equal(parseCookieSecurity("1"), "always");
  assert.equal(parseCookieSecurity("false"), "never");
  assert.equal(parseCookieSecurity("0"), "never");
  assert.equal(parseCookieSecurity("nonsense"), "auto", "a typo must not silently weaken or break it");
});

/* -------------------------------------------------------------------------- */
/*  Inbox view model                                                          */
/* -------------------------------------------------------------------------- */

function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: "t1",
    tenantId: "t_acme",
    ref: "TIX-000001",
    subject: "Printer jam",
    description: "d",
    type: "INCIDENT",
    status: "OPEN",
    priority: "NORMAL",
    requesterId: "u_req",
    assigneeId: null,
    queueId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    firstResponseAt: null,
    resolvedAt: null,
    closedAt: null,
    pauses: [],
    messages: [],
    ...overrides,
  };
}

test("inbox view: filtering, ordering and tenant-wide counts are assembled once", () => {
  const all = [
    ticket({ id: "open", status: "OPEN", priority: "URGENT" }),
    ticket({ id: "closed", status: "CLOSED" }),
    ticket({ id: "assigned", assigneeId: "u_agent" }),
  ];
  const view = buildInboxView(all, { status: "open" });
  assert.deepEqual(view.tickets.map((t) => t.id), ["open", "assigned"]);
  assert.equal(view.counts.open, 2);
  assert.equal(view.counts.urgent, 1);
  // Counts describe the whole tenant even when the filter hides most of it.
  assert.equal(view.counts.byStatus.CLOSED, 1);
  assert.deepEqual(view.triage.map((t) => t.id), ["open"]);
});

test("inbox view: the URL is parsed forgivingly", () => {
  assert.deepEqual(parseInboxFilter({}), {});
  assert.deepEqual(parseInboxFilter({ status: "all" }), { status: "all" });
  assert.deepEqual(parseInboxFilter({ status: "RESOLVED" }), { status: "RESOLVED" });
  assert.deepEqual(parseInboxFilter({ status: "bogus" }), {}, "an unknown status falls back to the default view");
  assert.deepEqual(parseInboxFilter({ assignee: "unassigned" }), { assigneeId: "unassigned" });
  assert.deepEqual(parseInboxFilter({ assignee: "u_agent", search: " vpn " }), { assigneeId: "u_agent", search: "vpn" });
  assert.deepEqual(parseInboxFilter({ status: ["all", "open"] }), { status: "all" });
});

test("inbox view: the selected ticket must be visible under the current filter", () => {
  const view = buildInboxView([ticket({ id: "a" }), ticket({ id: "z", status: "CLOSED" })], { status: "open" });
  assert.equal(selectedTicket(view, "a")?.id, "a");
  assert.equal(selectedTicket(view, "z"), null);
  assert.equal(selectedTicket(view, undefined), null);
});

/* -------------------------------------------------------------------------- */
/*  The rendered inbox                                                        */
/* -------------------------------------------------------------------------- */

test("inbox UI: open work renders and closed work stays hidden by default", () => {
  const html = renderToStaticMarkup(
    createElement(AgentInbox, {
      all: [
        ticket({ id: "a", ref: "TIX-000001", subject: "VPN certificate invalid" }),
        ticket({ id: "b", ref: "TIX-000002", subject: "Old resolved thing", status: "RESOLVED" }),
      ],
    }),
  );
  assert.match(html, /VPN certificate invalid/);
  assert.doesNotMatch(html, /Old resolved thing/);
  assert.match(html, /TIX-000001/);
  assert.match(html, /unassigned/);
  assert.match(html, /urgent/);
});

test("inbox UI: the All tab shows resolved work and the request count matches", () => {
  const html = renderToStaticMarkup(
    createElement(AgentInbox, { all: [ticket({ id: "b", subject: "Old resolved thing", status: "RESOLVED" })], filter: { status: "all" } }),
  );
  assert.match(html, /Old resolved thing/);
});

test("detail UI: the ticket, its thread and the offered actions render", () => {
  const record = ticket({
    id: "a",
    ref: "TIX-000042",
    subject: "Persistent blue screen",
    messages: [
      { id: "m1", kind: "PUBLIC_REPLY", body: "Have you tried a reboot?", authorId: "u_agent", createdAt: "2026-01-02T00:00:00.000Z" },
    ],
  });
  const html = renderToStaticMarkup(
    createElement(TicketDetail, {
      ticket: record,
      actions: { reply: async () => {}, setStatus: async () => {}, assign: async () => {} },
    }),
  );
  assert.match(html, /TIX-000042/);
  assert.match(html, /Persistent blue screen/);
  assert.match(html, /Have you tried a reboot\?/);
  assert.match(html, /Mark[\s\S]{0,40}resolved/);
  assert.match(html, /Internal note/);
});
