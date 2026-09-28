/**
 * OnTrak Tix M0 tests.
 *
 * Covers the three pure foundations the intake pipeline is built on: tenant
 * isolation + RBAC, the ticket lifecycle and append-only conversation, and the
 * email-to-ticket decision. Run with:
 *
 *   npx tsx --test ontrak-tix/tests/tix.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  appendAuditEvent,
  AuditLog,
  createAuditChain,
  GENESIS_HASH,
  stableStringify,
  verifyAuditChain,
  type AuditEventInput,
} from "../src/lib/audit-chain";
import { MemoryTicketStore, TicketService, type TicketRecord } from "../src/lib/ticket-service";
import { inboxCounts, matchesFilter, sortForInbox, triageQueue } from "../src/lib/inbox-rules";
import {
  INGESTION_FLAG,
  isIngestionEnabled,
  planIngestion,
  ticketInputFromDraft,
  type IngestionState,
} from "../src/lib/intake-service";
import {
  accessDenial,
  canAssignTicket,
  canReadTicket,
  canReplyToTicket,
  canUpdateTicket,
  hasPermission,
  isSameTenant,
  permissionsFor,
  ROLES,
  type Actor,
} from "../src/lib/access-rules";
import {
  canMutateMessage,
  canTransition,
  highestPriority,
  isOpen,
  isTerminal,
  priorityRank,
  ticketRef,
  transition,
  validateTicketInput,
} from "../src/lib/ticket-rules";
import {
  classifyType,
  dedupeKey,
  extractEmailAddress,
  inferPriority,
  isAutoReply,
  isEmailAddress,
  normalizeMessageId,
  normalizeSubject,
  parseInboundEmail,
  resolveThreadParent,
  type InboundEmail,
} from "../src/lib/intake-rules";

/* -------------------------------------------------------------------------- */
/*  Access & tenant isolation                                                 */
/* -------------------------------------------------------------------------- */

const admin: Actor = { id: "u_admin", tenantId: "t_acme", role: "ADMIN" };
const dispatcher: Actor = { id: "u_disp", tenantId: "t_acme", role: "DISPATCHER" };
const agent: Actor = { id: "u_agent", tenantId: "t_acme", role: "AGENT" };
const requester: Actor = { id: "u_req", tenantId: "t_acme", role: "REQUESTER" };
const outsider: Actor = { id: "u_out", tenantId: "t_other", role: "ADMIN" };

const ownTicket = { tenantId: "t_acme", requesterId: "u_req", assigneeId: null };
const someoneElsesTicket = { tenantId: "t_acme", requesterId: "u_other", assigneeId: "u_agent" };

test("access: every role is a known role", () => {
  assert.deepEqual([...ROLES], ["ADMIN", "DISPATCHER", "AGENT", "REQUESTER"]);
  assert.ok(permissionsFor("ADMIN").includes("tenant:manage"));
  assert.ok(!permissionsFor("AGENT").includes("ticket:delete"));
  assert.ok(!permissionsFor("REQUESTER").includes("ticket:assign"));
});

test("access: a requester may read only their own ticket", () => {
  assert.equal(canReadTicket(requester, ownTicket), true);
  assert.equal(canReadTicket(requester, someoneElsesTicket), false);
  // Staff with ticket:read:any can read any ticket in the tenant.
  assert.equal(canReadTicket(agent, someoneElsesTicket), true);
  assert.equal(canReadTicket(dispatcher, someoneElsesTicket), true);
});

test("access: tenant isolation is absolute, even for an admin", () => {
  const foreignTicket = { tenantId: "t_other", requesterId: "u_out", assigneeId: null };
  assert.equal(isSameTenant(outsider, "t_acme"), false);
  assert.equal(canReadTicket(outsider, ownTicket), false);
  assert.equal(canUpdateTicket(admin, foreignTicket), false);
  assert.equal(canAssignTicket(outsider, ownTicket), false);
  assert.equal(canReplyToTicket(outsider, ownTicket), false);
});

test("access: requesters reply but never update or assign", () => {
  assert.equal(canReplyToTicket(requester, ownTicket), true);
  assert.equal(canReplyToTicket(requester, someoneElsesTicket), false);
  assert.equal(canUpdateTicket(requester, ownTicket), false);
  assert.equal(canAssignTicket(requester, ownTicket), false);
  assert.equal(canAssignTicket(agent, ownTicket), false);
  assert.equal(canAssignTicket(dispatcher, ownTicket), true);
});

test("access: denials describe the action without leaking tenant detail", () => {
  assert.equal(accessDenial(agent, "read", someoneElsesTicket), null);
  assert.match(accessDenial(outsider, "read", ownTicket) ?? "", /do not have access/);
  assert.match(accessDenial(requester, "update", ownTicket) ?? "", /cannot update/);
  assert.equal(permissionsFor("ADMIN").includes("audit:read"), hasPermission("ADMIN", "audit:read"));
});

/* -------------------------------------------------------------------------- */
/*  Ticket lifecycle                                                          */
/* -------------------------------------------------------------------------- */

test("ticket: the status machine allows only real moves", () => {
  assert.equal(canTransition("NEW", "OPEN"), true);
  assert.equal(canTransition("OPEN", "RESOLVED"), true);
  assert.equal(canTransition("OPEN", "PENDING"), true);
  assert.equal(canTransition("RESOLVED", "OPEN"), true, "a resolved ticket can be reopened");
  assert.equal(canTransition("CLOSED", "OPEN"), true, "a closed ticket can be reopened");

  // No skipping straight from intake to done.
  assert.equal(canTransition("NEW", "RESOLVED"), false);
  assert.equal(canTransition("NEW", "CLOSED"), false);
  // A move to the state you are already in is not a move.
  assert.equal(canTransition("OPEN", "OPEN"), false);
});

test("ticket: transition reports a readable refusal", () => {
  assert.deepEqual(transition("NEW", "OPEN"), { ok: true, status: "OPEN" });
  const refused = transition("NEW", "RESOLVED");
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.reason : "", /cannot move straight/);
});

test("ticket: open and terminal states are classified correctly", () => {
  assert.equal(isOpen("NEW"), true);
  assert.equal(isOpen("PENDING"), true);
  assert.equal(isOpen("RESOLVED"), false);
  assert.equal(isTerminal("CLOSED"), true);
  assert.equal(isTerminal("RESOLVED"), false);
});

test("ticket: validation reports every problem at once", () => {
  assert.deepEqual(validateTicketInput({ subject: "Printer jam", description: "Tray 2", type: "INCIDENT", priority: "HIGH", requesterId: "u_1" }), []);

  const issues = validateTicketInput({ subject: "   ", description: "", requesterId: "" });
  const fields = issues.map((issue) => issue.field).sort();
  assert.deepEqual(fields, ["description", "requesterId", "subject"]);

  const unknown = validateTicketInput({ subject: "x", description: "y", requesterId: "u_1", type: "PROBLEM" as never });
  assert.ok(unknown.some((issue) => issue.field === "type"));
});

test("ticket: a subject may not exceed its limit", () => {
  const issues = validateTicketInput({ subject: "a".repeat(201), description: "y", requesterId: "u_1" });
  assert.ok(issues.some((issue) => issue.field === "subject"));
});

test("ticket: priority ranks and merges toward the more urgent", () => {
  assert.ok(priorityRank("URGENT") > priorityRank("HIGH"));
  assert.equal(highestPriority("LOW", "HIGH"), "HIGH");
  assert.equal(highestPriority("URGENT", "LOW"), "URGENT");
});

test("ticket: the conversation is append-only", () => {
  const decision = canMutateMessage({ id: "msg_1", kind: "PUBLIC_REPLY", createdAt: 0 });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /append-only/);
});

test("ticket: references are stable and zero-padded", () => {
  assert.equal(ticketRef(1), "TIX-000001");
  assert.equal(ticketRef(123), "TIX-000123");
  assert.equal(ticketRef(0, "ACME"), "ACME-000001");
});

/* -------------------------------------------------------------------------- */
/*  Email intake                                                              */
/* -------------------------------------------------------------------------- */

function mail(overrides: Partial<InboundEmail> = {}): InboundEmail {
  return {
    from: "Ada Lovelace <ada@client.example>",
    to: ["support@ontrak.local"],
    subject: "Cannot log in to the VPN",
    body: "Since this morning the VPN client says the certificate is invalid.",
    messageId: "<abc-123@client.example>",
    ...overrides,
  };
}

test("intake: addresses and message ids are normalized", () => {
  assert.equal(extractEmailAddress("Ada Lovelace <ada@client.example>"), "ada@client.example");
  assert.equal(extractEmailAddress("ada@client.example"), "ada@client.example");
  assert.equal(isEmailAddress("ada@client.example"), true);
  assert.equal(isEmailAddress("not an email"), false);
  assert.equal(normalizeMessageId("<abc-123@x>"), "abc-123@x");
  assert.equal(normalizeMessageId(""), undefined);
});

test("intake: subject prefixes are stripped so replies share a subject", () => {
  assert.equal(normalizeSubject("Re: Cannot log in"), "Cannot log in");
  assert.equal(normalizeSubject("RE: Fwd: Cannot log in"), "Cannot log in");
  assert.equal(normalizeSubject("Cannot log in"), "Cannot log in");
});

test("intake: machine-generated mail is refused", () => {
  assert.equal(isAutoReply(mail({ autoSubmitted: "auto-generated" })), true);
  assert.equal(isAutoReply(mail({ precedence: "bulk" })), true);
  assert.equal(isAutoReply(mail({ subject: "Automatic reply: Out of office" })), true);
  assert.equal(isAutoReply(mail({ autoSubmitted: "no" })), false);

  const refused = parseInboundEmail(mail({ autoSubmitted: "auto-replied" }));
  assert.equal(refused.accept, false);
  assert.match(refused.reason ?? "", /machine-generated/);
});

test("intake: a mail with no usable sender is refused", () => {
  const refused = parseInboundEmail(mail({ from: "Undisclosed recipients:;" }));
  assert.equal(refused.accept, false);
  assert.match(refused.reason ?? "", /sender address/);
});

test("intake: type and priority are inferred from the wording", () => {
  assert.equal(classifyType("Please create a new account for the intern"), "REQUEST");
  assert.equal(classifyType("The server is down"), "INCIDENT");
  assert.equal(inferPriority("URGENT: production outage"), "URGENT");
  assert.equal(inferPriority("Blocking issue, cannot work"), "HIGH");
  assert.equal(inferPriority("Question about printers"), "NORMAL");
});

test("intake: a brand-new mail becomes a ticket with a clean subject", () => {
  const result = parseInboundEmail(mail({ subject: "Re: Cannot log in to the VPN" }));
  assert.equal(result.accept, true);
  assert.equal(result.threadParent, undefined);
  assert.equal(result.newTicket?.requesterEmail, "ada@client.example");
  assert.equal(result.newTicket?.subject, "Cannot log in to the VPN");
  assert.equal(result.newTicket?.type, "INCIDENT");
  assert.equal(result.newTicket?.priority, "NORMAL");
  assert.equal(result.dedupeKey, "mid:abc-123@client.example");
});

test("intake: a reply is threaded onto the parent rather than opening a ticket", () => {
  const parent = "<parent-777@ontrak.local>";
  assert.equal(resolveThreadParent(mail({ inReplyTo: parent })), "parent-777@ontrak.local");
  assert.equal(resolveThreadParent(mail({ references: ["<root-1@x>", "<root-2@x>"] })), "root-1@x");

  const result = parseInboundEmail(mail({ inReplyTo: parent }));
  assert.equal(result.accept, true);
  assert.equal(result.threadParent, "parent-777@ontrak.local");
  assert.equal(result.newTicket, undefined);
});

test("intake: dedupe falls back to a content fingerprint without a Message-ID", () => {
  const email = mail({ messageId: undefined });
  const key = dedupeKey(email);
  assert.match(key, /^fp:ada@client\.example\|cannot log in to the vpn\|/);
  // Whitespace-only differences in the body do not change the fingerprint.
  assert.equal(key, dedupeKey(mail({ messageId: undefined, body: `  ${email.body.replace(/ /g, "   ")}  ` })));
});

test("intake: a subjectless mail still produces a usable ticket", () => {
  const result = parseInboundEmail(mail({ subject: "Re:", body: "The plotter is offline." }));
  assert.equal(result.newTicket?.subject, "(no subject)");
  assert.equal(result.newTicket?.description, "The plotter is offline.");
});

/* -------------------------------------------------------------------------- */
/*  The audit spine                                                           */
/* -------------------------------------------------------------------------- */

const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

function event(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    id: "evt-1",
    tenantId: "t_acme",
    at: "2026-09-26T10:00:00.000Z",
    actor: "u_admin",
    action: "ticket.create",
    targetType: "ticket",
    targetId: "tkt_1",
    detail: { ref: "TIX-000001" },
    ...overrides,
  };
}

test("audit: the first record links to genesis and each record links to the last", () => {
  let chain = createAuditChain();
  chain = appendAuditEvent(chain, event({ id: "evt-1" }), sha256);
  chain = appendAuditEvent(chain, event({ id: "evt-2", action: "ticket.reply" }), sha256);

  assert.equal(chain.events[0].seq, 1);
  assert.equal(chain.events[0].prevHash, GENESIS_HASH);
  assert.equal(chain.events[1].seq, 2);
  assert.equal(chain.events[1].prevHash, chain.events[0].recordHash);
  assert.equal(chain.head, chain.events[1].recordHash);
});

test("audit: a well-formed chain verifies and appending never mutates the old chain", () => {
  const log = new AuditLog(sha256);
  log.append(event({ id: "evt-1" }));
  log.append(event({ id: "evt-2" }));
  log.append(event({ id: "evt-3" }));
  assert.deepEqual(log.verify(), { ok: true, length: 3 });

  const first = appendAuditEvent(createAuditChain(), event({ id: "evt-1" }), sha256);
  const second = appendAuditEvent(first, event({ id: "evt-2" }), sha256);
  assert.equal(first.events.length, 1);
  assert.equal(second.events.length, 2);
  assert.notEqual(first.head, second.head);
});

test("audit: editing or deleting a record, or forging the head, is detected", () => {
  const log = new AuditLog(sha256);
  log.append(event({ id: "evt-1" }));
  log.append(event({ id: "evt-2" }));
  log.append(event({ id: "evt-3" }));

  const edited = log.snapshot();
  edited.events[1] = { ...edited.events[1], detail: { ref: "TIX-999999" } };
  const editResult = verifyAuditChain(edited, sha256);
  assert.equal(editResult.ok, false);
  assert.equal(editResult.ok === false && editResult.brokenAt, 2);

  const deleted = log.snapshot();
  deleted.events.splice(1, 1);
  assert.equal(verifyAuditChain(deleted, sha256).ok, false);

  const forged = log.snapshot();
  forged.head = sha256("something else");
  const forgedResult = verifyAuditChain(forged, sha256);
  assert.equal(forgedResult.ok, false);
  assert.match(forgedResult.ok === false ? forgedResult.reason : "", /head/);
});

test("audit: canonical hashing is order-independent", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(stableStringify({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(stableStringify([1, undefined, 3]), "[1,null,3]");

  const a = appendAuditEvent(createAuditChain(), event({ detail: { role: "AGENT", site: "hq" } }), sha256);
  const b = appendAuditEvent(createAuditChain(), event({ detail: { site: "hq", role: "AGENT" } }), sha256);
  assert.equal(a.events[0].recordHash, b.events[0].recordHash);
});

/* -------------------------------------------------------------------------- */
/*  Persistence + audit emission                                              */
/* -------------------------------------------------------------------------- */

function makeService() {
  const store = new MemoryTicketStore();
  const audit = new AuditLog(sha256);
  return { store, audit, service: new TicketService(store, audit) };
}

const NEW_TICKET = { subject: "VPN down", description: "The certificate is invalid.", type: "INCIDENT" as const, priority: "HIGH" as const };

test("service: creating a ticket persists it, assigns a ref and audits it", async () => {
  const { store, audit, service } = makeService();
  const result = await service.createTicket(requester, NEW_TICKET);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.ref, "TIX-000001");
  assert.equal(result.value.requesterId, requester.id, "a requester creates for themselves");
  assert.equal(result.value.status, "NEW");
  assert.equal(audit.length, 1);
  assert.deepEqual(audit.verify(), { ok: true, length: 1 });
  assert.equal((await store.findTicket("t_acme", result.value.id))?.subject, "VPN down");
});

test("service: an invalid ticket is refused and nothing is audited", async () => {
  const { audit, service } = makeService();
  const result = await service.createTicket(requester, { ...NEW_TICKET, subject: "   " });
  assert.equal(result.ok, false);
  assert.equal(audit.length, 0);
});

test("service: replies append to the thread; only staff may write internal notes", async () => {
  const { store, service } = makeService();
  const created = await service.createTicket(requester, NEW_TICKET);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  assert.equal((await service.reply(requester, created.value.id, "Still failing.")).ok, true);
  assert.equal((await service.reply(requester, created.value.id, "internal only", "INTERNAL_NOTE")).ok, false);
  assert.equal((await service.reply(agent, created.value.id, "internal only", "INTERNAL_NOTE")).ok, true);

  const stored = await store.findTicket("t_acme", created.value.id);
  assert.equal(stored?.messages.length, 2);
  assert.deepEqual(stored?.messages.map((m) => m.kind), ["PUBLIC_REPLY", "INTERNAL_NOTE"]);
});

test("service: status changes follow the lifecycle and set the close timestamps", async () => {
  const { store, service } = makeService();
  const created = await service.createTicket(requester, NEW_TICKET);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  assert.equal((await service.setStatus(agent, created.value.id, "RESOLVED")).ok, false, "no skipping straight to resolved");
  assert.equal((await service.setStatus(agent, created.value.id, "OPEN")).ok, true);
  assert.equal((await service.setStatus(agent, created.value.id, "RESOLVED")).ok, true);

  const stored = await store.findTicket("t_acme", created.value.id);
  assert.equal(stored?.status, "RESOLVED");
  assert.ok(stored?.resolvedAt);
  assert.equal(stored?.closedAt, null);
});

test("service: only assigners assign, and another tenant sees nothing", async () => {
  const { service } = makeService();
  const created = await service.createTicket(dispatcher, NEW_TICKET);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  assert.equal((await service.assign(agent, created.value.id, agent.id)).ok, false);
  assert.equal((await service.assign(dispatcher, created.value.id, agent.id)).ok, true);

  const foreign: Actor = { id: "u_out", tenantId: "t_other", role: "ADMIN" };
  const reply = await service.reply(foreign, created.value.id, "hello");
  assert.equal(reply.ok, false);
  assert.match(reply.ok === false ? reply.error : "", /not found/);
});

/* -------------------------------------------------------------------------- */
/*  The agent inbox                                                           */
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

test("inbox: open work sorts above closed, urgent first, then oldest-touched", () => {
  const list = [
    ticket({ id: "closed", status: "CLOSED", updatedAt: "2025-01-01T00:00:00.000Z" }),
    ticket({ id: "low", priority: "LOW", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ticket({ id: "urgent", priority: "URGENT", updatedAt: "2026-01-03T00:00:00.000Z" }),
    ticket({ id: "older", priority: "NORMAL", updatedAt: "2025-06-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(sortForInbox(list).map((t) => t.id), ["urgent", "older", "low", "closed"]);
});

test("inbox: filters cover status, search and the unassigned pile", () => {
  const list = [
    ticket({ id: "a", ref: "TIX-000001", subject: "Printer jam", assigneeId: null }),
    ticket({ id: "b", ref: "TIX-000002", subject: "VPN", assigneeId: "u_agent", status: "RESOLVED" }),
  ];
  assert.deepEqual(list.filter((t) => matchesFilter(t, { status: "open" })).map((t) => t.id), ["a"]);
  assert.deepEqual(list.filter((t) => matchesFilter(t, { status: "all" })).map((t) => t.id), ["a", "b"]);
  assert.deepEqual(list.filter((t) => matchesFilter(t, { status: "all", search: "vpn" })).map((t) => t.id), ["b"]);
  assert.deepEqual(list.filter((t) => matchesFilter(t, { search: "tix-000001" })).map((t) => t.id), ["a"]);
  assert.deepEqual(list.filter((t) => matchesFilter(t, { assigneeId: "unassigned" })).map((t) => t.id), ["a"]);
});

test("inbox: counts summarise the worklist and triage hides assigned work", () => {
  const list = [
    ticket({ id: "a" }),
    ticket({ id: "b", assigneeId: "u_agent", priority: "URGENT" }),
    ticket({ id: "c", status: "RESOLVED" }),
  ];
  const counts = inboxCounts(list);
  assert.equal(counts.open, 2);
  assert.equal(counts.unassigned, 1);
  assert.equal(counts.urgent, 1);
  assert.equal(counts.byStatus.RESOLVED, 1);
  assert.deepEqual(triageQueue(list).map((t) => t.id), ["a"]);
});

/* -------------------------------------------------------------------------- */
/*  Email ingestion                                                           */
/* -------------------------------------------------------------------------- */

const ON = { [INGESTION_FLAG]: "true" };

function ingestState(overrides: Partial<IngestionState> = {}): IngestionState {
  return { processed: new Set(), threads: new Map(), ...overrides };
}

test("ingestion: the feature flag gates the whole pipeline", () => {
  assert.equal(isIngestionEnabled({}), false);
  assert.equal(isIngestionEnabled({ [INGESTION_FLAG]: "TRUE" }), true);
  assert.deepEqual(planIngestion(mail(), {}, ingestState()), { kind: "disabled" });
});

test("ingestion: an already-processed message is a duplicate on retry", () => {
  const email = mail();
  const plan = planIngestion(email, ON, ingestState({ processed: new Set([dedupeKey(email)]) }));
  assert.equal(plan.kind, "duplicate");
});

test("ingestion: a new mail becomes a ticket draft", () => {
  const plan = planIngestion(mail({ subject: "URGENT: VPN down" }), ON, ingestState());
  assert.equal(plan.kind, "create");
  if (plan.kind !== "create") return;
  assert.equal(plan.draft.subject, "URGENT: VPN down");
  assert.equal(plan.draft.priority, "URGENT");
  assert.equal(plan.draft.requesterEmail, "ada@client.example");
});

test("ingestion: a reply to a known thread appends instead of opening a ticket", () => {
  const plan = planIngestion(mail({ inReplyTo: "<parent@x>" }), ON, ingestState({ threads: new Map([["parent@x", "tkt_1"]]) }));
  assert.equal(plan.kind, "append");
  if (plan.kind !== "append") return;
  assert.equal(plan.ticketId, "tkt_1");
  assert.equal(plan.inReplyTo, "parent@x");
  assert.equal(plan.messageId, "abc-123@client.example");
});

test("ingestion: a reply to an unknown thread still opens a ticket", () => {
  assert.equal(planIngestion(mail({ inReplyTo: "<stranger@x>" }), ON, ingestState()).kind, "create");
});

test("ingestion: machine-generated mail is rejected", () => {
  assert.equal(planIngestion(mail({ autoSubmitted: "auto-replied" }), ON, ingestState()).kind, "reject");
});

test("ingestion: a draft maps to ticket input for a resolved requester", () => {
  const draft = { requesterEmail: "ada@client.example", subject: "VPN", description: "d", type: "INCIDENT" as const, priority: "NORMAL" as const };
  assert.deepEqual(ticketInputFromDraft(draft, "u_req"), {
    subject: "VPN",
    description: "d",
    type: "INCIDENT",
    priority: "NORMAL",
    requesterId: "u_req",
  });
});
