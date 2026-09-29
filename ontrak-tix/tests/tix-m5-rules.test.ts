/**
 * OnTrak Tix M5 tests: the rules a desk writes for itself.
 *
 * Automation is the one feature where a mistake happens to *every* ticket rather
 * than to one, so this covers the parts that decide the outcome rather than the
 * parts that store it: what a rule may not be, when two rules disagree about a
 * field, what a rule that matches everything is called, and who is allowed to
 * write one.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m5-rules.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import {
  dryRun,
  evaluateRules,
  planTicketChanges,
  ruleHazards,
  ruleMatches,
  validateRule,
  type RuleRecord,
  type RuleTicketView,
} from "../src/lib/rule-rules";
import { MemoryRuleStore, RuleService } from "../src/lib/rule-service";
import { PrismaRuleStore, toRuleRecord, type RulePrismaClient, type RuleRow } from "../src/lib/rule-store-prisma";
import { parseActions, parseConditions, ruleValueOptions } from "../src/lib/rule-form-rules";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const ADMIN = { id: "admin-1", tenantId: "tenant-a", role: "ADMIN" as const };
const DISPATCHER = { id: "dispatcher-1", tenantId: "tenant-a", role: "DISPATCHER" as const };
const AGENT = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };
const OTHER_ADMIN = { id: "admin-9", tenantId: "tenant-b", role: "ADMIN" as const };
const NOW = "2026-09-21T12:00:00.000Z";

const TICKET: RuleTicketView = {
  subject: "Backup job failed on SQL-01",
  description: "The nightly backup did not run.",
  type: "INCIDENT",
  priority: "NORMAL",
  status: "NEW",
  queueId: "queue-infra",
  clientId: "client-acme",
  requesterId: "user-1",
  requesterEmail: "noc@acme.test",
  tags: [],
};

function rule(overrides: Partial<RuleRecord> = {}): RuleRecord {
  return {
    id: "rule-1",
    tenantId: "tenant-a",
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

function harness() {
  const audit = new AuditLog(sha256);
  const store = new MemoryRuleStore();
  let n = 0;
  const service = new RuleService(store, audit, { id: () => `rule-${++n}`, now: () => NOW });
  return { service, store, audit };
}

/* -------------------------------------------------------------------------- */
/*  What a rule may not be                                                    */
/* -------------------------------------------------------------------------- */

test("a rule without a name, a trigger or an action is refused", () => {
  assert.equal(validateRule({ trigger: "ticket.created", actions: [{ kind: "add_tag", value: "x" }] })[0].field, "name");
  assert.equal(validateRule({ name: "R", trigger: "whenever", actions: [{ kind: "add_tag", value: "x" }] })[0].field, "trigger");
  const noActions = validateRule({ name: "R", trigger: "ticket.created", actions: [] });
  assert.match(noActions[0].message, /has to do something/);
});

test("an unknown field, operator or action is refused rather than ignored", () => {
  const unknownField = validateRule({
    name: "R",
    trigger: "ticket.created",
    conditions: [{ field: "assignee" as never, operator: "equals", value: "x" }],
    actions: [{ kind: "add_tag", value: "ok" }],
  });
  assert.match(unknownField[0].message, /not something a rule can look at/);

  const unknownOperator = validateRule({
    name: "R",
    trigger: "ticket.created",
    conditions: [{ field: "subject", operator: "regex" as never, value: "x" }],
    actions: [{ kind: "add_tag", value: "ok" }],
  });
  assert.match(unknownOperator[0].message, /not a comparison a rule can make/);

  const unknownAction = validateRule({ name: "R", trigger: "ticket.created", actions: [{ kind: "send_sms" as never }] });
  assert.match(unknownAction[0].message, /not something a rule can do/);
});

test("a comparison needs a value, unless the field's emptiness is the test", () => {
  const missing = validateRule({
    name: "R",
    trigger: "ticket.created",
    conditions: [{ field: "subject", operator: "contains", value: "   " }],
    actions: [{ kind: "add_tag", value: "ok" }],
  });
  assert.match(missing[0].message, /needs a value/);

  const empty = validateRule({
    name: "R",
    trigger: "ticket.created",
    conditions: [{ field: "clientId", operator: "is_empty" }],
    actions: [{ kind: "add_tag", value: "ok" }],
  });
  assert.deepEqual(empty, []);

  const noList = validateRule({
    name: "R",
    trigger: "ticket.created",
    conditions: [{ field: "priority", operator: "is_one_of", value: [] }],
    actions: [{ kind: "add_tag", value: "ok" }],
  });
  assert.match(noList[0].message, /at least one value/);
});

test("an action has to carry a value the engine can use", () => {
  const badPriority = validateRule({ name: "R", trigger: "ticket.created", actions: [{ kind: "set_priority", value: "SOON" }] });
  assert.match(badPriority[0].message, /is not a priority/);

  const noTag = validateRule({ name: "R", trigger: "ticket.created", actions: [{ kind: "add_tag", value: "  " }] });
  assert.match(noTag[0].message, /tag needs a name/);

  // A tag that would print badly in a worklist is refused at the point of writing.
  const oddTag = validateRule({ name: "R", trigger: "ticket.created", actions: [{ kind: "add_tag", value: "a,b;c" }] });
  assert.match(oddTag[0].message, /is not a tag/);

  const silentReply = validateRule({ name: "R", trigger: "ticket.created", actions: [{ kind: "reply", value: "" }] });
  assert.match(silentReply[0].message, /needs something to say/);
});

/* -------------------------------------------------------------------------- */
/*  Matching                                                                  */
/* -------------------------------------------------------------------------- */

test("conditions are all required: a rule is an AND, never an OR", () => {
  const both = rule({
    conditions: [
      { field: "subject", operator: "contains", value: "backup" },
      { field: "priority", operator: "equals", value: "URGENT" },
    ],
  });
  assert.equal(ruleMatches(both, TICKET), false, "one condition failing means no match");

  const matched = rule({
    conditions: [
      { field: "subject", operator: "contains", value: "BACKUP" },
      { field: "clientId", operator: "equals", value: "client-acme" },
    ],
  });
  assert.equal(ruleMatches(matched, TICKET), true, "matching is case-insensitive");
});

test("a switched-off rule never matches, whatever its trigger", () => {
  assert.equal(ruleMatches(rule({ enabled: false }), TICKET), false);
});

test("the trigger decides which moment a rule is eligible for", () => {
  const onReply = rule({ trigger: "ticket.replied" });
  assert.equal(ruleMatches(onReply, TICKET, "ticket.created"), false);
  assert.equal(ruleMatches(onReply, TICKET, "ticket.replied"), true);
  assert.equal(ruleMatches(onReply, TICKET), true, "with no trigger asked about, eligibility is not narrowed");
});

test("emptiness is a condition like any other", () => {
  const unassigned = rule({ conditions: [{ field: "clientId", operator: "is_empty" }] });
  assert.equal(ruleMatches(unassigned, TICKET), false);
  assert.equal(ruleMatches(unassigned, { ...TICKET, clientId: null }), true);
});

test("a tag condition asks about the set of tags, not one string", () => {
  const tagged = { ...TICKET, tags: ["vip", "nightly"] };
  assert.equal(ruleMatches(rule({ conditions: [{ field: "tag", operator: "equals", value: "vip" }] }), tagged), true);
  assert.equal(ruleMatches(rule({ conditions: [{ field: "tag", operator: "equals", value: "vip" }] }), TICKET), false);
  assert.equal(
    ruleMatches(rule({ conditions: [{ field: "tag", operator: "is_one_of", value: ["vip", "gold"] }] }), tagged),
    true,
  );
  // "none of" is about the whole set: a ticket carrying one of them fails it.
  assert.equal(
    ruleMatches(rule({ conditions: [{ field: "tag", operator: "is_not_one_of", value: ["vip", "gold"] }] }), tagged),
    false,
  );
});

test("rules are evaluated in position order, whatever order they arrive in", () => {
  const late = rule({ id: "late", position: 9, name: "Late" });
  const early = rule({ id: "early", position: 1, name: "Early" });
  assert.deepEqual(
    evaluateRules([late, early], TICKET).map((entry) => entry.id),
    ["early", "late"],
  );
});

/* -------------------------------------------------------------------------- */
/*  What happens when two rules want the same field                           */
/* -------------------------------------------------------------------------- */

test("the first rule to set a field owns it, and the loser is recorded", () => {
  const first = rule({ id: "a", name: "First", position: 1, actions: [{ kind: "set_priority", value: "URGENT" }] });
  const second = rule({ id: "b", name: "Second", position: 2, actions: [{ kind: "set_priority", value: "LOW" }] });

  const plan = planTicketChanges([first, second]);
  assert.equal(plan.priority, "URGENT");
  assert.deepEqual(
    plan.skipped.map((entry) => entry.ruleName),
    ["Second"],
  );
  assert.match(plan.skipped[0].because, /First/);
  assert.equal(plan.applied.length, 1);
});

test("tags accumulate while singular fields do not, and nobody is dropped quietly", () => {
  const tagging = rule({
    id: "a",
    name: "Tagger",
    position: 1,
    actions: [
      { kind: "add_tag", value: "backup" },
      { kind: "add_tag", value: "nightly" },
    ],
  });
  const routing = rule({ id: "b", name: "Router", position: 2, actions: [{ kind: "route_queue", value: "queue-infra" }] });

  const plan = planTicketChanges([tagging, routing]);
  assert.deepEqual(plan.addTags, ["backup", "nightly"]);
  assert.equal(plan.queueId, "queue-infra");
  assert.equal(plan.skipped.length, 0);
});

test("the same tag from two rules is one tag", () => {
  const a = rule({ id: "a", name: "A", position: 1, actions: [{ kind: "add_tag", value: "vip" }] });
  const b = rule({ id: "b", name: "B", position: 2, actions: [{ kind: "add_tag", value: "VIP" }] });
  assert.deepEqual(planTicketChanges([a, b]).addTags, ["vip"]);
});

test("outward-facing actions all accumulate, because missing one is the failure", () => {
  const a = rule({ id: "a", name: "Notify", position: 1, actions: [{ kind: "notify", value: "on-call" }] });
  const b = rule({ id: "b", name: "Reply", position: 2, actions: [{ kind: "reply", value: "We are on it." }] });
  const c = rule({ id: "c", name: "Escalate", position: 3, actions: [{ kind: "escalate", value: "page the manager" }] });

  const plan = planTicketChanges([a, b, c]);
  assert.deepEqual(plan.notify.map((entry) => entry.value), ["on-call"]);
  assert.deepEqual(plan.reply.map((entry) => entry.value), ["We are on it."]);
  assert.deepEqual(plan.escalate.map((entry) => entry.value), ["page the manager"]);
});

/* -------------------------------------------------------------------------- */
/*  Nothing matched, and the preview                                          */
/* -------------------------------------------------------------------------- */

test("an empty plan changes nothing at all", () => {
  const plan = planTicketChanges([]);
  assert.equal(plan.priority, null);
  assert.equal(plan.queueId, null);
  assert.deepEqual(plan.addTags, []);
  assert.deepEqual(plan.applied, []);
});

test("the dry run reports what it would touch and what it would leave alone", () => {
  const rules = [rule({ id: "a", name: "Backup alerts", conditions: [{ field: "subject", operator: "contains", value: "backup" }] })];
  const tickets = [
    { ...TICKET, id: "t-1" },
    { ...TICKET, id: "t-2", subject: "Password reset", description: "please reset" },
  ];

  const report = dryRun(rules, tickets, "ticket.created");
  assert.equal(report.touched, 1);
  assert.equal(report.untouched, 1);
  assert.equal(report.tickets[0].ticketId, "t-1");
  assert.deepEqual(report.tickets[0].matched.map((entry) => entry.ruleName), ["Backup alerts"]);
  assert.equal(report.tickets[0].plan.priority, "HIGH");
});

test("the preview is the same code the live path runs, so it cannot disagree", () => {
  const rules = [rule({ id: "a", name: "Backup alerts" })];
  const tickets = [{ ...TICKET, id: "t-1" }];
  const preview = dryRun(rules, tickets, "ticket.created").tickets[0].plan;
  const live = planTicketChanges(evaluateRules(rules, TICKET, "ticket.created"));
  assert.deepEqual(preview, live);
});

/* -------------------------------------------------------------------------- */
/*  Hazards                                                                   */
/* -------------------------------------------------------------------------- */

test("the two ways a desk automates something it did not mean to are named", () => {
  const catchAll = ruleHazards({ conditions: [], actions: [{ kind: "add_tag", value: "x" }] });
  assert.match(catchAll[0], /matches every ticket/);

  const autoReply = ruleHazards({ conditions: [], actions: [{ kind: "reply", value: "Thanks!" }] });
  assert.ok(autoReply.some((hazard) => /replies to the customer by itself/.test(hazard)));

  const dangerous = ruleHazards({
    conditions: [{ field: "subject", operator: "contains", value: "x" }],
    actions: [{ kind: "assign_agent", value: "user-1" }, { kind: "escalate" }],
  });
  assert.ok(dangerous.some((hazard) => /named person rather than a queue/.test(hazard)));
  assert.ok(dangerous.some((hazard) => /page whoever is on call/.test(hazard)));

  const quiet = ruleHazards({ conditions: [{ field: "type", operator: "equals", value: "INCIDENT" }], actions: [{ kind: "add_tag", value: "x" }] });
  assert.deepEqual(quiet, []);
});

/* -------------------------------------------------------------------------- */
/*  Writing one, and who may                                                 */
/* -------------------------------------------------------------------------- */

test("only a role that manages the desk may write a rule", async () => {
  const { service } = harness();

  const denied = await service.create(AGENT, { name: "R", trigger: "ticket.created", actions: [{ kind: "add_tag", value: "x" }] });
  assert.equal(denied.ok, false);
  assert.match(denied.ok === false ? denied.error : "", /do not manage/);

  // A dispatcher runs the desk, so writing a rule is theirs; an agent's is not.
  const allowed = await service.create(DISPATCHER, { name: "R", trigger: "ticket.created", actions: [{ kind: "add_tag", value: "x" }] });
  assert.equal(allowed.ok, true);

  const stillDenied = await service.setEnabled(AGENT, "rule-1", false);
  assert.equal(stillDenied.ok, false);
});

test("a new rule runs last, so adding one cannot change what the others do", async () => {
  const { service } = harness();
  const first = await service.create(ADMIN, { name: "First", trigger: "ticket.created", actions: [{ kind: "add_tag", value: "a" }] });
  const second = await service.create(ADMIN, { name: "Second", trigger: "ticket.created", actions: [{ kind: "add_tag", value: "b" }] });
  assert.equal(first.ok && first.value.position, 1);
  assert.equal(second.ok && second.value.position, 2);
});

test("two rules cannot share a name, whatever the case", async () => {
  const { service } = harness();
  await service.create(ADMIN, { name: "Monitoring alerts", trigger: "ticket.created", actions: [{ kind: "add_tag", value: "a" }] });
  const clash = await service.create(ADMIN, { name: "  monitoring ALERTS ", trigger: "ticket.created", actions: [{ kind: "add_tag", value: "b" }] });
  assert.equal(clash.ok, false);
  assert.match(clash.ok === false ? clash.error : "", /already exists/);
});

test("every write lands on the audit chain with the rule's whole body", async () => {
  const { service, audit } = harness();
  const created = await service.create(ADMIN, {
    name: "Backup alerts",
    trigger: "ticket.created",
    conditions: [{ field: "subject", operator: "contains", value: "backup" }],
    actions: [{ kind: "set_priority", value: "HIGH" }],
  });
  assert.equal(created.ok, true);
  const id = created.ok ? created.value.id : "";

  await service.setEnabled(ADMIN, id, false);
  await service.update(ADMIN, id, { name: "Backup alerts (revised)" });
  await service.remove(ADMIN, id);

  const actions = audit.snapshot().events.map((event) => event.action);
  assert.deepEqual(actions, ["rule.create", "rule.disable", "rule.update", "rule.delete"]);
  const create = audit.snapshot().events[0];
  assert.deepEqual(create.detail?.actions, [{ kind: "set_priority", value: "HIGH" }]);
  assert.equal(audit.verify().ok, true);
});

test("a rule that does not exist cannot be edited or removed", async () => {
  const { service } = harness();
  assert.equal((await service.update(ADMIN, "nope", { name: "x" })).ok, false);
  assert.equal((await service.setEnabled(ADMIN, "nope", true)).ok, false);
  assert.equal((await service.remove(ADMIN, "nope")).ok, false);
});

test("an edit that does not mention the conditions keeps them", async () => {
  const { service } = harness();
  const created = await service.create(ADMIN, {
    name: "Backup alerts",
    trigger: "ticket.created",
    conditions: [{ field: "subject", operator: "contains", value: "backup" }],
    actions: [{ kind: "set_priority", value: "HIGH" }],
  });
  assert.equal(created.ok, true);
  const id = created.ok ? created.value.id : "";

  // A form carrying only the actions must not be able to widen the rule.
  const updated = await service.update(ADMIN, id, { actions: [{ kind: "set_priority", value: "URGENT" }] });
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.ok ? updated.value.conditions : [], [{ field: "subject", operator: "contains", value: "backup" }]);
});

test("the plan for a ticket is scoped to the tenant it is asked about", async () => {
  const { service } = harness();
  await service.create(ADMIN, { name: "Acme only", trigger: "ticket.created", actions: [{ kind: "add_tag", value: "acme" }] });

  const mine = await service.planForTicket("tenant-a", TICKET, "ticket.created");
  assert.equal(mine.rules.length, 1);
  assert.deepEqual(mine.plan.addTags, ["acme"]);

  const theirs = await service.planForTicket("tenant-b", TICKET, "ticket.created");
  assert.equal(theirs.rules.length, 0);
  assert.deepEqual(theirs.plan.addTags, []);
});

test("a preview needs the same permission as a write", async () => {
  const { service } = harness();
  const denied = await service.preview(AGENT, [{ ...TICKET, id: "t-1" }], "ticket.created");
  assert.equal(denied.ok, false);
  const allowed = await service.preview(ADMIN, [{ ...TICKET, id: "t-1" }], "ticket.created");
  assert.equal(allowed.ok, true);
});

test("a tenant's rules are invisible to another tenant, even by id", async () => {
  const { service, store } = harness();
  const created = await service.create(ADMIN, { name: "Mine", trigger: "ticket.created", actions: [{ kind: "add_tag", value: "x" }] });
  const id = created.ok ? created.value.id : "";

  assert.equal(await store.findRule("tenant-b", id), null);
  assert.deepEqual(await store.listRules("tenant-b"), []);
  // A delete from the wrong tenant removes nothing.
  await store.removeRule("tenant-b", id);
  assert.notEqual(await store.findRule("tenant-a", id), null);
  assert.equal((await service.update(OTHER_ADMIN, id, { name: "Stolen" })).ok, false);
});

/* -------------------------------------------------------------------------- */
/*  The Prisma adapter                                                        */
/* -------------------------------------------------------------------------- */

/** A throwaway stand-in for the three queries the adapter makes. */
function fakePrisma(): RulePrismaClient & { rows: RuleRow[] } {
  const rows: RuleRow[] = [];
  return {
    rows,
    rule: {
      async findFirst(args: unknown) {
        const where = (args as { where: Record<string, unknown> }).where;
        return (
          rows.find((row) => {
            if (row.tenantId !== where.tenantId) return false;
            if (typeof where.id === "string" && row.id !== where.id) return false;
            const name = where.name as { equals?: string } | undefined;
            if (name?.equals && row.name.trim().toLowerCase() !== name.equals.trim().toLowerCase()) return false;
            return true;
          }) ?? null
        );
      },
      async findMany(args: unknown) {
        const where = (args as { where: Record<string, unknown> }).where;
        return rows.filter((row) => row.tenantId === where.tenantId).sort((a, b) => a.position - b.position);
      },
      async create(args: { data: unknown }) {
        rows.push({ ...(args.data as RuleRow) });
        return args.data;
      },
      async update(args: { where: unknown; data: unknown }) {
        const id = (args.where as { id: string }).id;
        const row = rows.find((entry) => entry.id === id);
        if (row) Object.assign(row, args.data as Partial<RuleRow>);
        return row ?? null;
      },
      async deleteMany(args: { where: unknown }) {
        const where = args.where as { tenantId: string; id: string };
        const before = rows.length;
        for (let index = rows.length - 1; index >= 0; index--) {
          if (rows[index].tenantId === where.tenantId && rows[index].id === where.id) rows.splice(index, 1);
        }
        return { count: before - rows.length };
      },
    },
  };
}

test("the adapter round-trips a rule, including the trigger's spelling", async () => {
  const db = fakePrisma();
  const store = new PrismaRuleStore(db);

  await store.insertRule(rule({ id: "r-1", trigger: "ticket.replied" }));
  const back = await store.findRule("tenant-a", "r-1");

  assert.equal(back?.trigger, "ticket.replied", "the column says TICKET_REPLIED, the domain says ticket.replied");
  assert.equal(db.rows[0].trigger, "TICKET_REPLIED");
  assert.deepEqual(back?.actions, [{ kind: "set_priority", value: "HIGH" }]);
  assert.equal(back?.createdAt, NOW, "timestamps come back as ISO strings, not Dates");
});

test("the adapter finds a rule by name without caring about case", async () => {
  const store = new PrismaRuleStore(fakePrisma());
  await store.insertRule(rule({ id: "r-1", name: "Monitoring alerts" }));
  assert.notEqual(await store.findRuleByName("tenant-a", "monitoring ALERTS"), null);
  assert.equal(await store.findRuleByName("tenant-b", "Monitoring alerts"), null);
});

test("an unknown trigger in the column falls back rather than throwing", () => {
  const row: RuleRow = {
    id: "r-1",
    tenantId: "tenant-a",
    name: "R",
    trigger: "TICKET_SOMETHING_NEW",
    conditions: [],
    actions: [],
    enabled: true,
    position: 1,
    createdBy: "admin-1",
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  };
  assert.equal(toRuleRecord(row).trigger, "ticket.created");
});

/* -------------------------------------------------------------------------- */
/*  The console's two questions                                               */
/* -------------------------------------------------------------------------- */

async function seeded(...rules: RuleRecord[]) {
  const store = new MemoryRuleStore();
  const audit = new AuditLog(sha256);
  let n = 0;
  const service = new RuleService(store, audit, { id: () => `rule-${++n}`, now: () => NOW });
  for (const record of rules) await store.insertRule(record);
  return { service, store, audit };
}

const TICKETS = [{ ...TICKET, id: "tkt-1" }];

test("a switched-off rule is previewed as if it were on, which the whole-ruleset dry run cannot do", async () => {
  const { service } = await seeded(rule({ enabled: false }));

  const whole = await service.preview(ADMIN, TICKETS);
  const single = await service.previewRule(ADMIN, "rule-1", TICKETS);

  assert.ok(whole.ok && single.ok);
  // The live engine is right to ignore a disabled rule; the console's question
  // is "what happens if I switch this on?", which needs the rule run anyway.
  assert.equal(whole.value.touched, 0);
  assert.equal(single.value.touched, 1);
  assert.equal(single.value.tickets[0].plan.priority, "HIGH");
});

test("a rule preview runs only the rule asked about", async () => {
  const { service } = await seeded(
    rule({ id: "r-a", name: "A", position: 1, actions: [{ kind: "set_priority", value: "URGENT" }] }),
    rule({ id: "r-b", name: "B", position: 2, conditions: [], actions: [{ kind: "add_tag", value: "all" }] }),
  );

  const result = await service.previewRule(ADMIN, "r-a", TICKETS);

  assert.ok(result.ok);
  assert.deepEqual(result.value.tickets[0].matched.map((entry) => entry.ruleName), ["A"]);
  assert.deepEqual(result.value.tickets[0].plan.addTags, []);
});

test("previewing is a manager's act, because it discloses the rules", async () => {
  const { service } = await seeded(rule());
  const denied = await service.previewRule(AGENT, "rule-1", TICKETS);
  assert.equal(denied.ok, false);
});

test("moving a rule rewrites a clean 1..n order", async () => {
  const { service, store, audit } = await seeded(
    rule({ id: "r-1", name: "First", position: 1 }),
    rule({ id: "r-2", name: "Second", position: 2 }),
    rule({ id: "r-3", name: "Third", position: 3 }),
  );

  const moved = await service.move(ADMIN, "r-3", "up");

  assert.ok(moved.ok);
  const ordered = (await store.listRules("tenant-a")).sort((a, b) => a.position - b.position);
  assert.deepEqual(ordered.map((entry) => entry.name), ["First", "Third", "Second"]);
  assert.deepEqual(ordered.map((entry) => entry.position), [1, 2, 3]);
  assert.ok(audit.snapshot().events.some((event) => event.action === "rule.move"));
});

test("a rule already at the end of the order cannot move further", async () => {
  const { service } = await seeded(rule({ id: "r-1", position: 1 }));

  const up = await service.move(ADMIN, "r-1", "up");
  const down = await service.move(ADMIN, "r-1", "down");

  assert.equal(up.ok, false);
  assert.equal(down.ok, false);
});

test("moving is a manager's act", async () => {
  const { service } = await seeded(rule({ id: "r-1", position: 1 }), rule({ id: "r-2", position: 2 }));
  assert.equal((await service.move(AGENT, "r-2", "up")).ok, false);
});

/* -------------------------------------------------------------------------- */
/*  Reading a rule form back in                                               */
/* -------------------------------------------------------------------------- */

test("a blank condition row is ignored, and a half-filled one is kept to be refused", () => {
  const conditions = parseConditions(
    ["subject", "priority", ""],
    ["contains", "", ""],
    ["backup", "URGENT", ""],
  );

  assert.deepEqual(conditions, [
    { field: "subject", operator: "contains", value: "backup" },
    // The priority row was never given a comparison. Dropping it would save a
    // rule with one condition fewer than its author counted on.
    { field: "priority", operator: "" as never, value: "URGENT" },
  ]);
  assert.ok(validateRule({ name: "R", trigger: "ticket.created", conditions, actions: [{ kind: "add_tag", value: "x" }] }).length > 0);
});

test("a list comparison reads a comma-separated value as a list", () => {
  const conditions = parseConditions(["priority"], ["is_one_of"], ["URGENT, HIGH ,"]);
  assert.deepEqual(conditions, [{ field: "priority", operator: "is_one_of", value: ["URGENT", "HIGH"] }]);
});

test("a valueless comparison carries no value, whatever was typed beside it", () => {
  const conditions = parseConditions(["queueId"], ["is_empty"], ["leftover"]);
  assert.deepEqual(conditions, [{ field: "queueId", operator: "is_empty" }]);
});

test("a blank action row is ignored and an escalate may carry no reason", () => {
  const actions = parseActions(["set_priority", "", "escalate"], ["HIGH", "", ""]);
  assert.deepEqual(actions, [{ kind: "set_priority", value: "HIGH" }, { kind: "escalate" }]);
});

test("the datalist offers the queues and agents by id, labelled by name", () => {
  const options = ruleValueOptions({
    queues: [{ id: "q-1", name: "Infrastructure" }],
    agents: [{ id: "u-1", displayName: "Ada Lovelace" }],
  });

  assert.ok(options.some((option) => option.value === "q-1" && option.label === "queue: Infrastructure"));
  assert.ok(options.some((option) => option.value === "u-1" && option.label === "agent: Ada Lovelace"));
  // The words a rule compares against are offered as themselves.
  assert.ok(options.some((option) => option.value === "URGENT"));
});
