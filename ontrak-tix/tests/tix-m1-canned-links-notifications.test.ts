/**
 * OnTrak Tix M1 tests: canned responses, ticket links/merge, notifications and
 * the SLA inbox filters.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m1-canned-links-notifications.test.ts
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { Actor } from '../src/lib/access-rules';
import { AuditLog, type HashFn } from '../src/lib/audit-chain';
import { DEFAULT_CANNED_RESPONSES, applyCannedTemplate, validateCannedResponse } from '../src/lib/canned-rules';
import { CannedResponseService, MemoryCannedStore } from '../src/lib/canned-service';
import { reciprocalKind, validateLink } from '../src/lib/link-rules';
import { MemoryLinkStore, TicketLinkService } from '../src/lib/link-service';
import { MemoryTicketStore, TicketService } from '../src/lib/ticket-service';
import { EscalationService, MemoryEscalationStore, type EscalationTicket } from '../src/lib/escalation-service';
import { MemoryNotificationStore, NotificationService, type EmailSender } from '../src/lib/notification-service';
import { renderNotificationDigest, visibleAudiencesFor, type NotificationRecord } from '../src/lib/notification-rules';
import { ALWAYS_OPEN_CALENDAR, type SlaPolicy } from '../src/lib/sla-rules';
import { buildInboxView, parseInboxFilter } from '../src/lib/inbox-view';
import { inboxCounts, matchesFilter, type InboxSlaFlags } from '../src/lib/inbox-rules';
import type { TicketRecord } from '../src/lib/ticket-service';

const sha256: HashFn = (input) => createHash('sha256').update(input).digest('hex');

const requester: Actor = { id: 'u_req', tenantId: 't_acme', role: 'REQUESTER' };
const agent: Actor = { id: 'u_agent', tenantId: 't_acme', role: 'AGENT' };
const admin: Actor = { id: 'u_admin', tenantId: 't_acme', role: 'ADMIN' };

const NEW_TICKET = { subject: 'VPN down', description: 'cert invalid', type: 'INCIDENT' as const, priority: 'HIGH' as const };

/* -------------------------------------------------------------------------- */
/*  Canned responses                                                          */
/* -------------------------------------------------------------------------- */

test('canned: templates substitute known placeholders and leave typos visible', () => {
  assert.equal(applyCannedTemplate('Hi {{requester}}, re {{ref}}', { requester: 'Rita', ref: 'TIX-000001' }), 'Hi Rita, re TIX-000001');
  assert.equal(applyCannedTemplate('Hi {{nope}}', { requester: 'Rita' }), 'Hi {{nope}}', 'an unknown var is left to be noticed');
  assert.equal(applyCannedTemplate('{{ REF }}', { ref: 'TIX-000002' }), 'TIX-000002', 'spacing and case are forgiven');
});

test('canned: validation covers title, body and shortcut', () => {
  assert.equal(validateCannedResponse({ title: 'Resolved', body: 'Hi' }).length, 0);
  assert.ok(validateCannedResponse({ title: '', body: '' }).some((issue) => issue.field === 'title'));
  assert.ok(validateCannedResponse({ title: 'X', body: '' }).some((issue) => issue.field === 'body'));
  assert.ok(validateCannedResponse({ title: 'X', body: 'y', shortcut: 'a b' }).some((issue) => issue.field === 'shortcut'));
});

test('canned service: staff manage the library, a requester cannot', async () => {
  const service = new CannedResponseService(new MemoryCannedStore());
  const created = await service.create(agent, { title: 'Acknowledge', body: 'Hi {{requester}}', shortcut: 'ack' });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.shortcut, 'ack');

  assert.equal((await service.create(agent, { title: 'Acknowledge', body: 'dup' })).ok, false, 'duplicate titles are refused');
  assert.equal((await service.create(requester, { title: 'Sneaky', body: 'x' })).ok, false, 'requesters cannot manage the library');

  assert.equal((await service.list('t_acme')).length, 1);
  assert.equal((await service.remove(requester, created.value.id)).ok, false);
  assert.equal((await service.remove(agent, created.value.id)).ok, true);
  assert.equal((await service.list('t_acme')).length, 0);
});

test('canned: the shipped defaults are valid and self-consistent', () => {
  assert.ok(DEFAULT_CANNED_RESPONSES.length >= 3);
  for (const response of DEFAULT_CANNED_RESPONSES) {
    assert.equal(validateCannedResponse(response).length, 0, `${response.title} is valid`);
    assert.match(response.body, /\{\{ref\}\}/, `${response.title} references the ticket`);
  }
});

/* -------------------------------------------------------------------------- */
/*  Links & merge                                                             */
/* -------------------------------------------------------------------------- */

test('link: kinds pair up and self/duplicate links are refused', () => {
  assert.equal(reciprocalKind('PARENT'), 'CHILD');
  assert.equal(reciprocalKind('CHILD'), 'PARENT');
  assert.equal(reciprocalKind('RELATED'), 'RELATED');
  assert.ok(validateLink('a', 'a').some((issue) => issue.field === 'toTicketId'));
  assert.ok(validateLink('a', 'b', [{ fromTicketId: 'a', toTicketId: 'b' }]).length > 0);
  assert.equal(validateLink('a', 'b').length, 0);
});

async function linkedStack() {
  const store = new MemoryTicketStore();
  const audit = new AuditLog(sha256);
  const tickets = new TicketService(store, audit);
  const links = new TicketLinkService(new MemoryLinkStore(), store, audit);
  const survivor = await tickets.createTicket(requester, { ...NEW_TICKET, subject: 'VPN down', priority: 'NORMAL' });
  const duplicate = await tickets.createTicket(requester, { ...NEW_TICKET, subject: 'VPN not working', priority: 'URGENT' });
  if (!survivor.ok || !duplicate.ok) throw new Error('setup failed');
  return { store, audit, tickets, links, survivor: survivor.value, duplicate: duplicate.value };
}

test('link service: a relation is written in both directions', async () => {
  const { links, survivor, duplicate } = await linkedStack();
  const result = await links.link(agent, survivor.id, duplicate.id, 'RELATED');
  assert.equal(result.ok, true);

  const survivorLinks = await links.linkedTickets('t_acme', survivor.id);
  const duplicateLinks = await links.linkedTickets('t_acme', duplicate.id);
  assert.equal(survivorLinks.length, 1);
  assert.equal(survivorLinks[0].ticketId, duplicate.id);
  assert.equal(survivorLinks[0].direction, 'outgoing');
  assert.equal(duplicateLinks[0].direction, 'incoming');
});

test('merge: messages move to the survivor, the duplicate closes, audit is written', async () => {
  const { store, audit, tickets, links, survivor, duplicate } = await linkedStack();
  await tickets.reply(requester, duplicate.id, 'Just checking in', 'PUBLIC_REPLY');

  const result = await links.merge(agent, survivor.id, duplicate.id);
  assert.equal(result.ok, true);

  const afterSurvivor = await store.findTicket('t_acme', survivor.id);
  const afterDuplicate = await store.findTicket('t_acme', duplicate.id);
  assert.equal(afterDuplicate?.status, 'CLOSED', 'the duplicate is closed, never deleted');
  assert.ok(afterDuplicate?.messages.length === 1, 'its own thread is left intact');
  assert.equal(afterSurvivor?.priority, 'URGENT', 'the more urgent priority wins');
  assert.equal(afterSurvivor?.messages.length, 2, 'the carried reply plus the merge note');
  assert.equal(afterSurvivor?.messages[1].kind, 'SYSTEM');
  assert.match(afterSurvivor!.messages[1].body, /TIX-000002/);

  const links2 = await links.linkedTickets('t_acme', survivor.id);
  assert.equal(links2[0].kind, 'DUPLICATE');
  assert.deepEqual(audit.verify(), { ok: true, length: 4 }, 'create, create, reply, merge');
});

test('merge: a ticket cannot be merged into itself', async () => {
  const { links, survivor } = await linkedStack();
  const result = await links.merge(agent, survivor.id, survivor.id);
  assert.equal(result.ok, false);
});

/* -------------------------------------------------------------------------- */
/*  Notifications                                                             */
/* -------------------------------------------------------------------------- */

class CapturingEmail implements EmailSender {
  readonly sent: { to: string; subject: string; text: string }[] = [];
  async send(message: { to: string; subject: string; text: string }): Promise<void> {
    this.sent.push(message);
  }
}

test('notification: audiences map to the roles that may see them', () => {
  assert.deepEqual(visibleAudiencesFor('ADMIN'), ['AGENT', 'DISPATCHER', 'MANAGER']);
  assert.deepEqual(visibleAudiencesFor('DISPATCHER'), ['DISPATCHER']);
  assert.deepEqual(visibleAudiencesFor('AGENT'), ['AGENT']);
  assert.deepEqual(visibleAudiencesFor('REQUESTER'), []);
});

test('notification service: an escalation notifies in-app and by email, once', async () => {
  const store = new MemoryNotificationStore();
  const email = new CapturingEmail();
  const service = new NotificationService(store, email);

  const rung = {
    id: 'e1',
    tenantId: 't_acme',
    ticketId: 'tkt1',
    ticketRef: 'TIX-000001',
    kind: 'response' as const,
    level: 2,
    audience: 'DISPATCHER' as const,
    label: 'Response at 80%',
    reason: 'TIX-000001 response SLA - 80% of the window used.',
    dedupeKey: 'tkt1:response:2',
    raisedAt: '2026-01-01T09:55:00.000Z',
    acknowledgedAt: null,
  };

  await service.notifyEscalation(rung);
  await service.notifyEscalation(rung); // a replay must not double-notify, nor re-mail

  const agents = await service.listFor({ ...agent, role: 'AGENT' });
  assert.equal(agents.notifications.length, 0, 'an agent does not see a dispatcher rung');

  const dispatchers = await service.listFor({ ...agent, role: 'DISPATCHER' });
  assert.equal(dispatchers.notifications.length, 1);
  assert.equal(dispatchers.unread, 1);
  assert.equal(email.sent.length, 1, 'the mail is sent once');
  assert.equal(email.sent[0].to, 'dispatcher@desk');
  assert.match(email.sent[0].subject, /TIX-000001/);

  await service.markAllRead({ ...agent, role: 'DISPATCHER' });
  assert.equal((await service.listFor({ ...agent, role: 'DISPATCHER' })).unread, 0);
});

test('notification: the admin oversees every rung; the digest groups them', () => {
  const notice = (audience: NotificationRecord['audience'], title: string): NotificationRecord => ({
    id: title,
    tenantId: 't_acme',
    audience,
    kind: 'sla.escalation',
    title,
    body: 'body',
    ticketId: 'tkt1',
    ticketRef: 'TIX-000001',
    dedupeKey: title,
    level: 2,
    createdAt: '2026-01-01T09:55:00.000Z',
    readAt: null,
  });
  const digest = renderNotificationDigest([notice('AGENT', 'A'), notice('MANAGER', 'B')]);
  assert.match(digest.subject, /2 SLA escalations/);
  assert.match(digest.text, /• A/);

  const single = renderNotificationDigest([notice('AGENT', 'Only one')]);
  assert.equal(single.subject, '[OnTrak Tix] Only one');
});

/* -------------------------------------------------------------------------- */
/*  The escalation sweep now notifies                                         */
/* -------------------------------------------------------------------------- */

const alwaysOpen: SlaPolicy = {
  id: 'p1',
  name: 'Standard',
  responseMinutes: 60,
  resolutionMinutes: 240,
  calendar: ALWAYS_OPEN_CALENDAR,
  warningFraction: 0.5,
};

const sweepTicket: EscalationTicket = {
  id: 't1',
  ref: 'TIX-000001',
  priority: 'NORMAL',
  createdAt: '2026-01-01T09:00:00.000Z',
  firstResponseAt: null,
  resolvedAt: null,
  status: 'OPEN',
};

test('escalation: each newly raised rung calls the notification hook exactly once', async () => {
  const notifications = new NotificationService(new MemoryNotificationStore(), null);
  const raised: string[] = [];
  const service = new EscalationService(new MemoryEscalationStore(), null, undefined, undefined, async (record) => {
    raised.push(record.dedupeKey);
    await notifications.notifyEscalation(record);
  });

  await service.sweep({ tenantId: 't_acme', tickets: [sweepTicket], policies: [alwaysOpen], now: '2026-01-01T09:40:00.000Z' });
  await service.sweep({ tenantId: 't_acme', tickets: [sweepTicket], policies: [alwaysOpen], now: '2026-01-01T09:40:00.000Z' });
  await service.sweep({ tenantId: 't_acme', tickets: [sweepTicket], policies: [alwaysOpen], now: '2026-01-01T10:10:00.000Z' });

  assert.deepEqual(raised, ['t1:response:1', 't1:response:3']);
  assert.equal((await notifications.listFor(admin)).notifications.length, 2);
});

/* -------------------------------------------------------------------------- */
/*  SLA inbox filters                                                         */
/* -------------------------------------------------------------------------- */

function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 't1',
    tenantId: 't_acme',
    ref: 'TIX-000001',
    subject: 'Printer jam',
    description: 'd',
    type: 'INCIDENT',
    status: 'OPEN',
    priority: 'NORMAL',
    requesterId: 'u_req',
    assigneeId: null,
    queueId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    firstResponseAt: null,
    resolvedAt: null,
    closedAt: null,
    pauses: [],
    messages: [],
    ...overrides,
  };
}

test('inbox: the SLA filter matches on the risk flags, never on a ticket without one', () => {
  const flags: InboxSlaFlags = { atRisk: true, breached: false };
  assert.equal(matchesFilter(ticket(), { sla: 'at-risk' }, flags), true);
  assert.equal(matchesFilter(ticket(), { sla: 'breached' }, flags), false);
  assert.equal(matchesFilter(ticket(), { sla: 'breached' }, { atRisk: true, breached: true }), true);
  assert.equal(matchesFilter(ticket(), { sla: 'at-risk' }, undefined), false, 'no policy means no SLA view');
});

test('inbox: the view builds and counts an SLA-scoped worklist from the flag map', () => {
  const all = [ticket({ id: 'a' }), ticket({ id: 'b' }), ticket({ id: 'c', status: 'RESOLVED' })];
  const map = new Map<string, InboxSlaFlags>([
    ['a', { atRisk: true, breached: true }],
    ['b', { atRisk: true, breached: false }],
  ]);

  const view = buildInboxView(all, { status: 'open', sla: 'breached' }, map);
  assert.deepEqual(view.tickets.map((t) => t.id), ['a']);
  assert.equal(view.counts.slaAtRisk, 2);
  assert.equal(view.counts.slaBreached, 1);

  const counts = inboxCounts(all, map);
  assert.equal(counts.slaAtRisk, 2);
});

test('inbox: the sla URL param is parsed forgivingly', () => {
  assert.deepEqual(parseInboxFilter({ sla: 'breached' }), { sla: 'breached' });
  assert.deepEqual(parseInboxFilter({ sla: 'at-risk' }), { sla: 'at-risk' });
  assert.deepEqual(parseInboxFilter({ sla: 'nonsense' }), {}, 'an unknown value degrades to the default view');
});
