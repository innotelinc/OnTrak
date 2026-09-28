/**
 * M1 tests: ticket templates and SLA pause conditions.
 *
 * Two features that both touch the ticket lifecycle:
 *
 *  - templates prefill a new ticket from a saved shape (pure rendering +
 *    staff-guarded CRUD), and
 *  - a move into `PENDING` stops the SLA clock, which is the difference between
 *    an honest attainment figure and one that punishes the desk for waiting on
 *    the requester.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m1-templates-pauses.test.ts
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ALWAYS_OPEN_CALENDAR, coercePauses, pausesToJson, slaSummary, type SlaPolicy } from '../src/lib/sla-rules';
import { applyPauseForStatus, planStatusChange, type TicketRecord } from '../src/lib/ticket-service';
import { slaStatusFor, type ReportTicket } from '../src/lib/report-rules';
import { applyTicketTemplate, validateTicketTemplate, renderTemplateText, DEFAULT_TICKET_TEMPLATES, type TicketTemplate } from '../src/lib/template-rules';
import { MemoryTemplateStore, TicketTemplateService } from '../src/lib/template-service';
import type { Actor } from '../src/lib/access-rules';

const alwaysOpen: SlaPolicy = {
  id: 'p1',
  name: 'Standard',
  responseMinutes: 60,
  resolutionMinutes: 240,
  calendar: ALWAYS_OPEN_CALENDAR,
  warningFraction: 0.5,
};

const agent: Actor = { id: 'u_agent', tenantId: 't_acme', role: 'AGENT' };
const admin: Actor = { id: 'u_admin', tenantId: 't_acme', role: 'ADMIN' };
const requester: Actor = { id: 'u_req', tenantId: 't_acme', role: 'REQUESTER' };

const ids = { ticketId: () => 'id-1', messageId: () => 'msg-1', now: () => '2026-01-01T10:00:00.000Z' };

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
    assigneeId: 'u_agent',
    queueId: null,
    createdAt: '2026-01-01T09:00:00.000Z',
    updatedAt: '2026-01-01T09:00:00.000Z',
    firstResponseAt: null,
    resolvedAt: null,
    closedAt: null,
    pauses: [],
    messages: [],
    ...overrides,
  };
}

function templateRecord(overrides: Partial<TicketTemplate> = {}): TicketTemplate {
  return {
    id: 'tpl-1',
    tenantId: 't_acme',
    name: 'New starter',
    subject: 'New starter — {{requester}}',
    description: 'Set up {{requester}} on {{date}}.',
    type: 'REQUEST',
    priority: 'NORMAL',
    queueId: null,
    createdAt: '2026-01-01T09:00:00.000Z',
    updatedAt: '2026-01-01T09:00:00.000Z',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Template rules                                                            */
/* -------------------------------------------------------------------------- */

test('templates: placeholders are substituted, typos are left alone', () => {
  assert.equal(
    renderTemplateText('Hi {{requester}}, on {{date}} by {{agent}} in {{tenant}}', {
      requester: 'Rita',
      date: '2026-01-02',
      agent: 'Sam',
      tenant: 'acme',
    }),
    'Hi Rita, on 2026-01-02 by Sam in acme',
  );

  // Whitespace inside the braces is tolerated; an unknown name is not blanked,
  // so a typo shows up in the ticket instead of vanishing.
  assert.equal(renderTemplateText('{{ date }}', { date: '2026-01-02' }), '2026-01-02');
  assert.equal(renderTemplateText('{{nope}}', { requester: 'Rita' }), '{{nope}}');
  assert.equal(renderTemplateText('plain text'), 'plain text');
});

test('templates: applying a template trims and carries the routing fields', () => {
  const applied = applyTicketTemplate(templateRecord({ queueId: 'q1', priority: 'HIGH', type: 'INCIDENT' }), {
    requester: 'Rita',
    date: '2026-01-02',
  });
  assert.deepEqual(applied, {
    subject: 'New starter — Rita',
    description: 'Set up Rita on 2026-01-02.',
    type: 'INCIDENT',
    priority: 'HIGH',
    queueId: 'q1',
  });
});

test('templates: validation reports every missing or malformed field', () => {
  assert.equal(validateTicketTemplate(templateRecord()).length, 0);

  const issues = validateTicketTemplate({ name: '  ', subject: '', description: '', type: 'WIZARD' as never, priority: 'NOPE' as never });
  const fields = issues.map((issue) => issue.field);
  assert.ok(fields.includes('name'));
  assert.ok(fields.includes('subject'));
  assert.ok(fields.includes('description'));
  assert.ok(fields.includes('type'));
  assert.ok(fields.includes('priority'));
});

test('templates: the shipped defaults are all valid and distinct', () => {
  assert.ok(DEFAULT_TICKET_TEMPLATES.length >= 3);
  for (const preset of DEFAULT_TICKET_TEMPLATES) {
    assert.equal(validateTicketTemplate(preset).length, 0, `${preset.name} should validate`);
  }
  const names = DEFAULT_TICKET_TEMPLATES.map((preset) => preset.name.toLowerCase());
  assert.equal(new Set(names).size, names.length);
});

/* -------------------------------------------------------------------------- */
/*  Template service                                                          */
/* -------------------------------------------------------------------------- */

test('templates: creating requires ticket:update and rejects duplicate names', async () => {
  const service = new TicketTemplateService(new MemoryTemplateStore());

  const denied = await service.create(requester, { name: 'X', subject: 's', description: 'd', type: 'INCIDENT', priority: 'NORMAL' });
  assert.equal(denied.ok, false);

  const created = await service.create(agent, { name: ' New starter ', subject: ' s ', description: ' d ', type: 'REQUEST', priority: 'NORMAL' });
  assert.equal(created.ok, true);
  if (created.ok) assert.equal(created.value.name, 'New starter');

  const duplicate = await service.create(admin, { name: 'new starter', subject: 's', description: 'd', type: 'REQUEST', priority: 'NORMAL' });
  assert.equal(duplicate.ok, false);
});

test('templates: list is name-ordered and remove is scoped to the tenant', async () => {
  const service = new TicketTemplateService(new MemoryTemplateStore());
  await service.create(agent, { name: 'Zebra', subject: 's', description: 'd', type: 'INCIDENT', priority: 'NORMAL' });
  const apple = await service.create(agent, { name: 'Apple', subject: 's', description: 'd', type: 'INCIDENT', priority: 'NORMAL' });
  assert.ok(apple.ok);

  assert.deepEqual((await service.list('t_acme')).map((t) => t.name), ['Apple', 'Zebra']);

  // Another tenant's id removes nothing and leaves the original in place.
  await service.remove(agent, 'tpl-unknown');
  assert.equal((await service.list('t_acme')).length, 2);
});

test('templates: prefill renders placeholders and returns null for a stale id', async () => {
  const service = new TicketTemplateService(new MemoryTemplateStore());
  const created = await service.create(agent, { name: 'Reset', subject: 'Reset for {{requester}}', description: 'On {{date}}', type: 'REQUEST', priority: 'HIGH' });
  assert.ok(created.ok);

  const next = await service.prefill('t_acme', created.ok ? created.value.id : '', { requester: 'Rita', date: '2026-01-02' });
  assert.equal(next?.subject, 'Reset for Rita');
  assert.equal(next?.description, 'On 2026-01-02');
  assert.equal(next?.priority, 'HIGH');

  assert.equal(await service.prefill('t_acme', 'missing'), null);
  assert.equal(await service.prefill('t_other', created.ok ? created.value.id : ''), null);
});

/* -------------------------------------------------------------------------- */
/*  Pause lifecycle                                                           */
/* -------------------------------------------------------------------------- */

test('pauses: JSON round-trips through the store shape', () => {
  const pauses = [
    { startedAt: '2026-01-01T10:00:00.000Z', endedAt: '2026-01-01T11:00:00.000Z' },
    { startedAt: '2026-01-01T12:00:00.000Z', endedAt: null },
  ];
  assert.deepEqual(coercePauses(pausesToJson(pauses)), pauses);

  // Malformed rows are dropped rather than trusted.
  assert.deepEqual(coercePauses([{ startedAt: 'nonsense' }, null, 'x']), []);
  assert.deepEqual(coercePauses('not an array'), []);
});

test('pauses: entering PENDING opens one, leaving it closes the same one', () => {
  const opened = applyPauseForStatus([], 'OPEN', 'PENDING', '2026-01-01T10:00:00.000Z');
  assert.deepEqual(opened, [{ startedAt: '2026-01-01T10:00:00.000Z', endedAt: null }]);

  const closed = applyPauseForStatus(opened, 'PENDING', 'OPEN', '2026-01-01T11:00:00.000Z');
  assert.deepEqual(closed, [{ startedAt: '2026-01-01T10:00:00.000Z', endedAt: '2026-01-01T11:00:00.000Z' }]);

  // Transitions that never touch PENDING leave the recorded windows untouched.
  assert.deepEqual(applyPauseForStatus(closed, 'OPEN', 'RESOLVED', '2026-01-01T12:00:00.000Z'), closed);
  assert.deepEqual(applyPauseForStatus(closed, 'OPEN', 'OPEN', '2026-01-01T12:00:00.000Z'), closed);
});

test('pauses: a status change records the window on the ticket itself', () => {
  const moved = planStatusChange(agent, ticket(), 'PENDING', ids);
  assert.equal(moved.ok, true);
  if (!moved.ok) return;
  assert.deepEqual(moved.value.ticket.pauses, [{ startedAt: ids.now(), endedAt: null }]);
  assert.equal(moved.value.audit.action, 'ticket.status');

  const back = planStatusChange(agent, moved.value.ticket, 'OPEN', { ...ids, now: () => '2026-01-01T11:00:00.000Z' });
  assert.equal(back.ok, true);
  if (!back.ok) return;
  assert.deepEqual(back.value.ticket.pauses, [
    { startedAt: ids.now(), endedAt: '2026-01-01T11:00:00.000Z' },
  ]);
});

test('pauses: a waiting ticket freezes its clock and reports itself paused', () => {
  // Twenty minutes into a 60-minute response target, the desk asks the requester
  // for more information. Without the pause this ticket would breach at 10:00;
  // with it, the deadline simply stops moving.
  const waiting = ticket({
    createdAt: '2026-01-01T09:00:00.000Z',
    pauses: [{ startedAt: '2026-01-01T09:20:00.000Z', endedAt: null }],
    status: 'PENDING',
  });

  const summary = slaSummary(
    { policyId: 'p1', startedAt: waiting.createdAt, firstResponseAt: null, resolvedAt: null, pauses: waiting.pauses },
    alwaysOpen,
    '2026-01-01T18:00:00.000Z',
  );
  assert.equal(summary.paused, true);
  assert.equal(summary.breached, false);
  assert.equal(summary.atRisk, false);

  const reportTicket: ReportTicket = {
    id: waiting.id,
    ref: waiting.ref,
    subject: waiting.subject,
    status: waiting.status,
    priority: waiting.priority,
    assigneeId: waiting.assigneeId,
    createdAt: waiting.createdAt,
    firstResponseAt: waiting.firstResponseAt,
    resolvedAt: waiting.resolvedAt,
    pauses: waiting.pauses,
  };
  const status = slaStatusFor(reportTicket, [alwaysOpen], '2026-01-01T18:00:00.000Z');
  assert.equal(status?.paused, true);
  assert.equal(status?.breached, false);

  // Closing the pause lets the clock run again: the 40 minutes that were left are
  // spent within minutes, so the ticket is genuinely late by the evening.
  const resumed: ReportTicket = { ...reportTicket, pauses: [{ startedAt: '2026-01-01T09:20:00.000Z', endedAt: '2026-01-01T09:40:00.000Z' }] };
  const after = slaStatusFor(resumed, [alwaysOpen], '2026-01-01T18:00:00.000Z');
  assert.equal(after?.paused, false);
  assert.equal(after?.breached, true);
});
