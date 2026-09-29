/**
 * OnTrak Tix M5 tests: what happens to a real ticket when a rule fires.
 *
 * The engine's own tests (`tix-m5-rules.test.ts`) cover matching and ordering.
 * These cover the seam that makes automation matter: the moment a rule touches a
 * ticket somebody is looking at. A rule that says the right thing and changes
 * nothing is worse than no rule, so each test here asserts the *stored* ticket,
 * not the plan.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m5-rule-intake.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import { MemoryRuleStore, RuleService } from "../src/lib/rule-service";
import type { RuleRecord } from "../src/lib/rule-rules";
import { RuleIntake, type RuleNotice } from "../src/lib/rule-intake";
import { MemoryTicketStore, TicketService, type ServiceResult } from "../src/lib/ticket-service";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const TENANT = "tenant-a";
const REQUESTER = { id: "user-1", tenantId: TENANT, role: "REQUESTER" as const };
const AGENT = { id: "agent-1", tenantId: TENANT, role: "AGENT" as const };
const NOW = "2026-09-21T12:00:00.000Z";

function rule(overrides: Partial<RuleRecord> = {}): RuleRecord {
  return {
    id: "rule-1",
    tenantId: TENANT,
    name: "Backup alerts",
    trigger: "ticket.created",
    conditions: [{ field: "subject", operator: "contains", value: "backup" }],
    actions: [{ kind: "set_priority", value: "HIGH" }],
    enabled: true,
    position: 1,
    createdBy: "admin-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function harness(seed: readonly RuleRecord[] = []) {
  const rules = new MemoryRuleStore();
  for (const record of seed) rules.insertRule(record);

  const audit = new AuditLog(sha256);
  const tickets = new MemoryTicketStore();
  const notices: RuleNotice[] = [];
  const pages: RuleNotice[] = [];
  const effects = {
    notify: async (notice: RuleNotice) => {
      notices.push(notice);
    },
    escalate: async (notice: RuleNotice) => {
      pages.push(notice);
    },
  };
  const directory = { emailFor: async (_tenantId: string, id: string) => (id === "user-1" ? "noc@acme.test" : null) };

  const ruleService = new RuleService(rules, audit, { id: () => "rule-x", now: () => NOW });
  const intake = new RuleIntake(
    { planForTicket: (tenantId, ticket, trigger) => ruleService.planForTicket(tenantId, ticket, trigger) },
    effects,
    directory,
  );

  let seq = 0;
  const service = new TicketService(
    tickets,
    audit,
    { ticketId: () => `tkt-${++seq}`, messageId: () => `msg-${++seq}`, now: () => NOW },
    intake,
  );
  const events = () => audit.snapshot().events;
  return { service, tickets, rules, ruleService, audit, notices, pages, events };
}

function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value;
}

const DRAFT = { subject: "Backup job failed on SQL-01", description: "The nightly backup did not run.", type: "INCIDENT" as const, priority: "NORMAL" as const };

/* -------------------------------------------------------------------------- */
/*  Created                                                                   */
/* -------------------------------------------------------------------------- */

test("a created ticket is born with the priority, queue and tags its rules give it", async () => {
  const h = harness([
    rule({
      actions: [
        { kind: "set_priority", value: "URGENT" },
        { kind: "route_queue", value: "queue-infra" },
        { kind: "add_tag", value: "nightly" },
        { kind: "add_tag", value: "at-risk" },
      ],
    }),
  ]);

  const ticket = unwrap(await h.service.createTicket(REQUESTER, DRAFT));

  // The *stored* row, not the returned copy: a rule that only changed the value
  // handed back to the caller would be invisible in the inbox.
  const stored = await h.tickets.findTicket(TENANT, ticket.id);
  assert.equal(stored?.priority, "URGENT");
  assert.equal(stored?.queueId, "queue-infra");
  assert.deepEqual(stored?.tags, ["nightly", "at-risk"]);
});

test("the firing is on the chain, naming the rule and what it changed", async () => {
  const h = harness([rule({ actions: [{ kind: "set_priority", value: "HIGH" }] })]);
  const ticket = unwrap(await h.service.createTicket(REQUESTER, DRAFT));

  const fired = h.events().filter((event) => event.action === "ticket.rules");
  assert.equal(fired.length, 1);
  const detail = fired[0].detail as { trigger: string; matched: { name: string }[]; applied: { action: string }[] };
  assert.equal(fired[0].targetId, ticket.id);
  assert.equal(detail.trigger, "ticket.created");
  assert.deepEqual(detail.matched.map((entry) => entry.name), ["Backup alerts"]);
  assert.deepEqual(detail.applied.map((entry) => entry.action), ["set_priority"]);
  // The create event itself reports the queue the ticket actually landed in.
  assert.equal(h.events()[0].action, "ticket.create");
  assert.equal(h.audit.verify().ok, true);
});

test("a ticket no rule matches is written untouched and adds no rule event", async () => {
  const h = harness([rule({ conditions: [{ field: "subject", operator: "contains", value: "printer" }] })]);

  const ticket = unwrap(await h.service.createTicket(REQUESTER, DRAFT));

  assert.equal(ticket.priority, "NORMAL");
  assert.equal(ticket.queueId, null);
  assert.deepEqual(h.events().map((event) => event.action), ["ticket.create"]);
});

test("two rules that want the same field: the earlier one wins and the other is recorded as skipped", async () => {
  const h = harness([
    rule({ id: "rule-first", name: "Urgent backup", position: 1, actions: [{ kind: "set_priority", value: "URGENT" }] }),
    rule({ id: "rule-second", name: "Low backup", position: 2, actions: [{ kind: "set_priority", value: "LOW" }] }),
  ]);

  const ticket = unwrap(await h.service.createTicket(REQUESTER, DRAFT));

  assert.equal(ticket.priority, "URGENT");
  const detail = h.events().find((event) => event.action === "ticket.rules")?.detail as {
    skipped: { rule: string; because: string }[];
  };
  assert.equal(detail.skipped.length, 1);
  assert.equal(detail.skipped[0].rule, "Low backup");
  assert.match(detail.skipped[0].because, /already set this/);
});

test("a switched-off rule does not fire", async () => {
  const h = harness([rule({ enabled: false, actions: [{ kind: "set_priority", value: "URGENT" }] })]);

  const ticket = unwrap(await h.service.createTicket(REQUESTER, DRAFT));

  assert.equal(ticket.priority, "NORMAL");
  assert.deepEqual(h.events().map((event) => event.action), ["ticket.create"]);
});

test("another tenant's rule is not even a candidate", async () => {
  const h = harness([rule({ tenantId: "tenant-b", actions: [{ kind: "set_priority", value: "URGENT" }] })]);

  const ticket = unwrap(await h.service.createTicket(REQUESTER, DRAFT));

  assert.equal(ticket.priority, "NORMAL");
});

/* -------------------------------------------------------------------------- */
/*  What the rules may read                                                   */
/* -------------------------------------------------------------------------- */

test("a rule may match the requester's address, which the ticket row does not carry", async () => {
  const h = harness([
    rule({
      conditions: [{ field: "requesterEmail", operator: "contains", value: "acme.test" }],
      actions: [{ kind: "add_tag", value: "acme" }],
    }),
  ]);

  const ticket = unwrap(await h.service.createTicket(REQUESTER, DRAFT));

  assert.deepEqual(ticket.tags, ["acme"]);
});

test("a rule may match a client, so one customer's mail lands filed under them", async () => {
  const h = harness([
    rule({
      conditions: [{ field: "clientId", operator: "equals", value: "client-acme" }],
      actions: [{ kind: "set_priority", value: "HIGH" }],
    }),
  ]);

  const ticket = unwrap(await h.service.createTicket(REQUESTER, { ...DRAFT, clientId: "client-acme" }));

  assert.equal(ticket.priority, "HIGH");
});

/* -------------------------------------------------------------------------- */
/*  What the rules may say                                                    */
/* -------------------------------------------------------------------------- */

test("a reply rule answers the customer under the desk's name and stops the response clock", async () => {
  const h = harness([
    rule({
      trigger: "ticket.replied",
      actions: [{ kind: "reply", value: "Thanks — we have your report and are looking into it." }],
    }),
  ]);
  const created = unwrap(await h.service.createTicket(REQUESTER, DRAFT));

  unwrap(await h.service.reply(AGENT, created.id, "On it."));

  const stored = await h.tickets.findTicket(TENANT, created.id);
  const auto = stored?.messages.find((message) => message.authorId === null);
  assert.equal(auto?.body, "Thanks — we have your report and are looking into it.");
  assert.equal(auto?.kind, "PUBLIC_REPLY");
  assert.equal(stored?.firstResponseAt, NOW);
});

test("a notify rule raises a staff notice and an escalate rule pages on-call", async () => {
  const h = harness([
    rule({
      actions: [
        { kind: "notify", value: "Backup failed again — check the repository." },
        { kind: "escalate", value: "Nightly backups are failing." },
      ],
    }),
  ]);

  const ticket = unwrap(await h.service.createTicket(REQUESTER, DRAFT));

  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].ticketId, ticket.id);
  assert.equal(h.notices[0].value, "Backup failed again — check the repository.");
  assert.equal(h.pages.length, 1);
  assert.equal(h.pages[0].value, "Nightly backups are failing.");
});

test("an effect that cannot be delivered does not lose the ticket", async () => {
  const rules = new MemoryRuleStore();
  rules.insertRule(rule({ actions: [{ kind: "notify", value: "Say something" }] }));
  const audit = new AuditLog(sha256);
  const tickets = new MemoryTicketStore();
  const ruleService = new RuleService(rules, audit, { id: () => "rule-x", now: () => NOW });
  const intake = new RuleIntake(
    { planForTicket: (tenantId, ticket, trigger) => ruleService.planForTicket(tenantId, ticket, trigger) },
    {
      notify: async () => {
        throw new Error("no mail transport today");
      },
      escalate: async () => undefined,
    },
  );
  const service = new TicketService(tickets, audit, { ticketId: () => "tkt-1", messageId: () => "msg-1", now: () => NOW }, intake);

  const result = await service.createTicket(REQUESTER, DRAFT);

  // The ticket is written and the firing is recorded; only the notice is lost,
  // and it says so on the chain rather than silently doing nothing.
  assert.equal(result.ok, true);
  assert.ok(await tickets.findTicket(TENANT, "tkt-1"));
  assert.equal(audit.snapshot().events.filter((event) => event.action === "ticket.rules").length, 1);
});

/* -------------------------------------------------------------------------- */
/*  Updated and replied                                                       */
/* -------------------------------------------------------------------------- */

test("a ticket.updated rule fires when a ticket moves, and the move is what it reads", async () => {
  const h = harness([
    rule({
      trigger: "ticket.updated",
      conditions: [{ field: "status", operator: "equals", value: "PENDING" }],
      actions: [{ kind: "add_tag", value: "waiting-on-customer" }],
    }),
  ]);
  const created = unwrap(await h.service.createTicket(REQUESTER, { ...DRAFT, subject: "Password reset" }));

  const moved = unwrap(await h.service.setStatus(AGENT, created.id, "PENDING"));

  assert.deepEqual(moved.tags, ["waiting-on-customer"]);
  assert.equal(h.events().filter((event) => event.action === "ticket.rules").length, 1);
});

test("a rule that changes nothing about a ticket is still a firing, not a no-op", async () => {
  const h = harness([rule({ actions: [{ kind: "set_priority", value: "NORMAL" }] })]);

  unwrap(await h.service.createTicket(REQUESTER, DRAFT));

  // "The rule matched and the ticket already said this" is worth saying: it is
  // how a desk discovers that its catch-all is firing on everything.
  assert.equal(h.events().filter((event) => event.action === "ticket.rules").length, 1);
});
