/**
 * OnTrak Tix M5 tests: the shortcuts an agent runs on one ticket.
 *
 * A macro is the deliberate counterpart to a rule — the same actions, applied
 * because a person asked rather than because a trigger fired. These cover the
 * parts that decide what happens: that a macro is validated by the engine's own
 * rules, that it is planned by the same planner, that running one is attributed
 * to the agent and changes the *stored* ticket, and that it neither re-runs the
 * rules nor escapes its tenant.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m5-macros.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import { macroHazards, planMacro, validateMacro, type MacroRecord } from "../src/lib/macro-rules";
import { MemoryMacroStore, MacroService } from "../src/lib/macro-service";
import { MacroIntake } from "../src/lib/macro-intake";
import { toMacroRecord, type MacroRow } from "../src/lib/macro-store-prisma";
import type { RuleRecord } from "../src/lib/rule-rules";
import { MemoryRuleStore, RuleService } from "../src/lib/rule-service";
import { RuleIntake, type RuleNotice } from "../src/lib/rule-intake";
import { MemoryTicketStore, TicketService, type ServiceResult } from "../src/lib/ticket-service";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const TENANT = "tenant-a";
const REQUESTER = { id: "user-1", tenantId: TENANT, role: "REQUESTER" as const };
const AGENT = { id: "agent-1", tenantId: TENANT, role: "AGENT" as const };
const DISPATCHER = { id: "dispatcher-1", tenantId: TENANT, role: "DISPATCHER" as const };
const NOW = "2026-09-21T12:00:00.000Z";

const DRAFT = {
  subject: "Backup job failed on SQL-01",
  description: "The nightly backup did not run.",
  type: "INCIDENT" as const,
  priority: "NORMAL" as const,
};

function macro(overrides: Partial<MacroRecord> = {}): MacroRecord {
  return {
    id: "macro-1",
    tenantId: TENANT,
    name: "Escalate to L2",
    description: "Hand the ticket to the second line.",
    actions: [{ kind: "set_priority", value: "URGENT" }],
    enabled: true,
    createdBy: "admin-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function rule(overrides: Partial<RuleRecord> = {}): RuleRecord {
  return {
    id: "rule-1",
    tenantId: TENANT,
    name: "On update",
    trigger: "ticket.updated",
    conditions: [],
    actions: [{ kind: "add_tag", value: "by-a-rule" }],
    enabled: true,
    position: 1,
    createdBy: "admin-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value;
}

/**
 * A full stack: the rules engine *and* the macro intake, because the point of
 * one test is that running a macro does not run the rules.
 */
function harness(seedRules: readonly RuleRecord[] = [], seedMacros: readonly MacroRecord[] = []) {
  const ruleStore = new MemoryRuleStore();
  for (const record of seedRules) ruleStore.insertRule(record);
  const macroStore = new MemoryMacroStore();
  for (const record of seedMacros) macroStore.insertMacro(record);

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

  const ruleService = new RuleService(ruleStore, audit, { id: () => "rule-x", now: () => NOW });
  const ruleIntake = new RuleIntake(
    { planForTicket: (tenantId, ticket, trigger) => ruleService.planForTicket(tenantId, ticket, trigger) },
    effects,
    { emailFor: async () => null },
  );

  let macroSeq = 0;
  const macroService = new MacroService(macroStore, audit, { id: () => `macro-${++macroSeq}`, now: () => NOW });
  const macroIntake = new MacroIntake({ findMacro: (tenantId, id) => macroService.find(tenantId, id) }, effects);

  let seq = 0;
  const service = new TicketService(
    tickets,
    audit,
    { ticketId: () => `tkt-${++seq}`, messageId: () => `msg-${++seq}`, now: () => NOW },
    ruleIntake,
    macroIntake,
  );
  const events = () => audit.snapshot().events;
  return { service, tickets, macroStore, macroService, ruleStore, audit, notices, pages, events };
}

/* -------------------------------------------------------------------------- */
/*  What a macro may be                                                       */
/* -------------------------------------------------------------------------- */

test("a macro without a name or an action is refused", () => {
  assert.equal(validateMacro({ actions: [{ kind: "set_priority", value: "HIGH" }] })[0].field, "name");
  assert.match(validateMacro({ name: "Escalate", actions: [] })[0].message, /has to do something/);
});

test("a macro's actions are judged by the rule engine's own rules", () => {
  const badPriority = validateMacro({ name: "M", actions: [{ kind: "set_priority", value: "SOON" }] });
  assert.match(badPriority[0].message, /is not a priority/);

  const unknown = validateMacro({ name: "M", actions: [{ kind: "send_sms" as never }] });
  assert.match(unknown[0].message, /not something a macro can do/);

  const silentReply = validateMacro({ name: "M", actions: [{ kind: "reply", value: "  " }] });
  assert.match(silentReply[0].message, /needs something to say/);
});

test("a macro description has a ceiling, so it stays a label", () => {
  const long = validateMacro({ name: "M", description: "x".repeat(400), actions: [{ kind: "escalate" }] });
  assert.equal(long[0].field, "description");
});

/* -------------------------------------------------------------------------- */
/*  What a macro would do                                                     */
/* -------------------------------------------------------------------------- */

test("a macro is planned by the same engine a rule uses", () => {
  const plan = planMacro(
    macro({
      actions: [
        { kind: "set_priority", value: "URGENT" },
        { kind: "set_priority", value: "LOW" },
        { kind: "add_tag", value: "vip" },
        { kind: "add_tag", value: "vip" },
        { kind: "reply", value: "We are on it." },
      ],
    }),
  );

  assert.equal(plan.priority, "URGENT", "the first action to set a field owns it");
  assert.deepEqual(plan.addTags, ["vip"], "a tag is not added twice");
  assert.equal(plan.reply.length, 1);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].because, /already set this/);
});

test("a macro has no catch-all hazard, but its outward actions are named", () => {
  const hazards = macroHazards(macro({ actions: [{ kind: "reply", value: "hi" }, { kind: "escalate" }] }));
  assert.ok(hazards.some((hazard) => /replies to the customer/.test(hazard)));
  assert.ok(hazards.some((hazard) => /raise an escalation/.test(hazard)));
  assert.ok(!hazards.some((hazard) => /matches every ticket/.test(hazard)), "a macro has no conditions to catch everything with");
});

test("a retired macro says so", () => {
  assert.ok(macroHazards(macro({ enabled: false })).some((hazard) => /switched off/.test(hazard)));
});

/* -------------------------------------------------------------------------- */
/*  Who may write one                                                         */
/* -------------------------------------------------------------------------- */

test("managing macros is a manager's job; reading them is an agent's", async () => {
  const h = harness();

  const denied = await h.macroService.create(AGENT, { name: "M", actions: [{ kind: "add_tag", value: "x" }] });
  assert.equal(denied.ok, false);

  const created = await h.macroService.create(DISPATCHER, { name: "M", actions: [{ kind: "add_tag", value: "x" }] });
  assert.ok(created.ok);

  assert.equal((await h.macroService.list(REQUESTER)).ok, false);
  assert.ok((await h.macroService.list(AGENT)).ok);
});

test("two macros cannot share a name, whatever the case", async () => {
  const h = harness();
  unwrap(await h.macroService.create(DISPATCHER, { name: "Escalate to L2", actions: [{ kind: "escalate" }] }));
  const clash = await h.macroService.create(DISPATCHER, { name: "escalate TO l2", actions: [{ kind: "escalate" }] });
  assert.equal(clash.ok, false);
});

test("every macro write is on the audit chain with its whole body", async () => {
  const h = harness();
  const created = unwrap(
    await h.macroService.create(DISPATCHER, { name: "Reset", actions: [{ kind: "set_priority", value: "LOW" }] }),
  );
  unwrap(await h.macroService.setEnabled(DISPATCHER, created.id, false));
  unwrap(await h.macroService.remove(DISPATCHER, created.id));

  assert.deepEqual(h.events().map((event) => event.action), ["macro.create", "macro.disable", "macro.delete"]);
  assert.equal(h.audit.verify().ok, true);
});

/* -------------------------------------------------------------------------- */
/*  Running one                                                               */
/* -------------------------------------------------------------------------- */

test("running a macro rewrites the stored ticket and names the agent on the chain", async () => {
  const seeded = macro({ actions: [{ kind: "set_priority", value: "URGENT" }, { kind: "add_tag", value: "vip" }] });
  const h = harness([], [seeded]);
  const ticket = unwrap(await h.service.createTicket(REQUESTER, DRAFT));

  const run = unwrap(await h.service.applyMacro(AGENT, ticket.id, seeded.id));

  assert.equal(run.priority, "URGENT");
  assert.deepEqual(run.tags, ["vip"]);
  // The *stored* row, not the returned copy.
  const stored = await h.tickets.findTicket(TENANT, ticket.id);
  assert.equal(stored?.priority, "URGENT");
  assert.deepEqual(stored?.tags, ["vip"]);

  const fired = h.events().find((event) => event.action === "ticket.macro");
  assert.ok(fired);
  assert.equal(fired?.actor, AGENT.id, "a macro is attributed to the person who ran it");
  assert.equal(fired?.targetId, ticket.id);
  assert.equal((fired?.detail as { macro: { name: string } }).macro.name, seeded.name);
  assert.equal(h.audit.verify().ok, true);
});

test("a macro's reply answers the customer and stops the response clock", async () => {
  const seeded = macro({ actions: [{ kind: "reply", value: "We are looking into this now." }] });
  const h = harness([], [seeded]);
  const ticket = unwrap(await h.service.createTicket(REQUESTER, DRAFT));
  assert.equal(ticket.firstResponseAt, null);

  const run = unwrap(await h.service.applyMacro(AGENT, ticket.id, seeded.id));

  assert.equal(run.firstResponseAt, NOW);
  assert.equal(run.messages.length, 1);
  assert.equal(run.messages[0].kind, "PUBLIC_REPLY");
  assert.equal(run.messages[0].authorId, null, "it leaves the desk under its own name, not the agent's");
});

test("a macro's notify and escalate reach the same staff sink a rule uses", async () => {
  const seeded = macro({
    actions: [{ kind: "notify", value: "Worth a look" }, { kind: "escalate", value: "Customer is down" }],
  });
  const h = harness([], [seeded]);
  const ticket = unwrap(await h.service.createTicket(REQUESTER, DRAFT));

  unwrap(await h.service.applyMacro(AGENT, ticket.id, seeded.id));

  assert.equal(h.notices.length, 1);
  assert.equal(h.pages.length, 1);
  assert.equal(h.notices[0].value, "Worth a look");
  assert.equal(h.notices[0].ruleName, seeded.name);
  assert.equal(h.notices[0].source, "macro", "the notice names the shortcut, not a rule");
  assert.equal(h.pages[0].source, "macro");
});

test("running a macro does not run the rules", async () => {
  // A rule that would fire on any update, and a macro that changes a field.
  const h = harness([rule({ actions: [{ kind: "add_tag", value: "by-a-rule" }] })], [
    macro({ actions: [{ kind: "set_priority", value: "HIGH" }] }),
  ]);
  const ticket = unwrap(await h.service.createTicket(REQUESTER, DRAFT));

  const run = unwrap(await h.service.applyMacro(AGENT, ticket.id, "macro-1"));

  assert.equal(run.priority, "HIGH");
  assert.deepEqual(run.tags, [], "the agent's instruction was not outvoted by automation");
  assert.equal(h.events().some((event) => event.action === "ticket.rules"), false);
});

test("a retired macro cannot be run", async () => {
  const h = harness([], [macro({ enabled: false })]);
  const ticket = unwrap(await h.service.createTicket(REQUESTER, DRAFT));

  const run = await h.service.applyMacro(AGENT, ticket.id, "macro-1");

  assert.equal(run.ok, false);
  if (!run.ok) assert.match(run.error, /switched off/);
});

test("a requester has no shortcut that reassigns work", async () => {
  const h = harness([], [macro()]);
  const ticket = unwrap(await h.service.createTicket(REQUESTER, DRAFT));

  const run = await h.service.applyMacro(REQUESTER, ticket.id, "macro-1");
  assert.equal(run.ok, false);
});

test("a macro from another tenant is simply absent", async () => {
  const h = harness([], [macro({ tenantId: "tenant-b" })]);
  const ticket = unwrap(await h.service.createTicket(REQUESTER, DRAFT));

  const run = await h.service.applyMacro(AGENT, ticket.id, "macro-1");
  assert.equal(run.ok, false);
  if (!run.ok) assert.match(run.error, /does not exist/);
});

/* -------------------------------------------------------------------------- */
/*  The stored row                                                            */
/* -------------------------------------------------------------------------- */

test("the Prisma row maps to a domain record with its actions intact", () => {
  const row: MacroRow = {
    id: "macro-1",
    tenantId: TENANT,
    name: "Escalate to L2",
    description: "Hand it over.",
    actions: [{ kind: "assign_agent", value: "agent-2" }],
    enabled: true,
    createdBy: "admin-1",
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  };
  const record = toMacroRecord(row);
  assert.equal(record.createdAt, NOW);
  assert.deepEqual(record.actions, [{ kind: "assign_agent", value: "agent-2" }]);
  assert.equal(record.description, "Hand it over.");

  // A column that is not an array is treated as no actions rather than crashing.
  assert.deepEqual(toMacroRecord({ ...row, actions: null }).actions, []);
});
