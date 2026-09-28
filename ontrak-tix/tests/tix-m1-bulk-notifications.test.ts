/**
 * OnTrak Tix M1 tests: bulk inbox actions, per-user notification preferences and
 * the rendered worklist / notification list.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m1-bulk-notifications.test.ts
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Actor } from '../src/lib/access-rules';
import { MAX_BULK, bulkFlashMessage, normalizeBulkIds, summarizeBulk } from '../src/lib/bulk-rules';
import {
  NOTIFICATION_MAX_LEVEL,
  NOTIFICATION_MIN_LEVEL,
  clampMinLevel,
  defaultPreference,
  shouldDeliver,
  type NotificationRecord,
} from '../src/lib/notification-rules';
import {
  MemoryNotificationPreferenceStore,
  MemoryNotificationStore,
  NotificationService,
} from '../src/lib/notification-service';
import type { SlaEscalationRecord } from '../src/lib/escalation-service';
import { AgentInbox } from '../src/components/AgentInbox';
import { NotificationList } from '../src/components/NotificationList';
import type { TicketRecord } from '../src/lib/ticket-service';

/* -------------------------------------------------------------------------- */
/*  Bulk selection & summary                                                  */
/* -------------------------------------------------------------------------- */

test('bulk: the selection is trimmed, de-duplicated and capped', () => {
  assert.deepEqual(normalizeBulkIds([' a ', 'b', '', 'a', '   ', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(normalizeBulkIds([]), []);
  const many = Array.from({ length: MAX_BULK + 25 }, (_, i) => `t${i}`);
  assert.equal(normalizeBulkIds(many).length, MAX_BULK, 'a runaway select-all is capped');
  assert.deepEqual(normalizeBulkIds([null, 42, 'x']), ['x'], 'non-strings are ignored');
});

test('bulk: the summary counts applied and skipped with reasons', () => {
  const summary = summarizeBulk([
    { ticketId: 'a', ok: true },
    { ticketId: 'b', ok: false, error: 'A new ticket cannot move straight to resolved.' },
    { ticketId: 'c', ok: false, error: 'A new ticket cannot move straight to resolved.' },
    { ticketId: 'd', ok: false, error: 'You cannot update this ticket.' },
    { ticketId: 'e', ok: false },
  ]);
  assert.equal(summary.requested, 5);
  assert.equal(summary.applied, 1);
  assert.equal(summary.skipped, 4);
  assert.equal(summary.failures.length, 3, 'only the first few reasons are surfaced');
  assert.equal(summary.failures[3], undefined);
});

test('bulk: the flash reads honestly', () => {
  assert.equal(bulkFlashMessage({ requested: 3, applied: 3, skipped: 0, failures: [] }, 'updated'), '3 tickets updated');
  assert.equal(bulkFlashMessage({ requested: 1, applied: 1, skipped: 0, failures: [] }, 'reassigned'), '1 ticket reassigned');
  const partial = bulkFlashMessage(
    { requested: 2, applied: 1, skipped: 1, failures: [{ ticketId: 'b', error: 'Nope.' }] },
    'updated',
  );
  assert.match(partial, /1 ticket updated; 1 skipped \(Nope\.\)/);
});

/* -------------------------------------------------------------------------- */
/*  Per-user notification preferences                                         */
/* -------------------------------------------------------------------------- */

test('preferences: the minimum level is clamped to the ladder', () => {
  assert.equal(clampMinLevel('0'), NOTIFICATION_MIN_LEVEL);
  assert.equal(clampMinLevel('2'), 2);
  assert.equal(clampMinLevel(99), NOTIFICATION_MAX_LEVEL);
  assert.equal(clampMinLevel('nonsense'), NOTIFICATION_MIN_LEVEL);
  assert.equal(clampMinLevel(2.9), 2);
  assert.equal(clampMinLevel(undefined), NOTIFICATION_MIN_LEVEL);
});

test('preferences: a muted user sees nothing; a level floor filters rungs', () => {
  const notification = (level: number | null): Pick<NotificationRecord, 'level'> => ({ level });
  const base = defaultPreference('t', 'u', '2026-01-01T00:00:00.000Z');
  assert.equal(shouldDeliver(base, notification(1)), true);
  assert.equal(shouldDeliver({ ...base, minLevel: 2 }, notification(1)), false);
  assert.equal(shouldDeliver({ ...base, minLevel: 2 }, notification(3)), true);
  assert.equal(shouldDeliver({ ...base, muted: true }, notification(3)), false);
  assert.equal(shouldDeliver(base, notification(null)), true, 'a notice with no level is never filtered');
});

const agentActor: Actor = { id: 'u_agent', tenantId: 't_acme', role: 'AGENT' };

function rung(level: number, dedupeKey: string): SlaEscalationRecord {
  return {
    id: `e-${dedupeKey}`,
    tenantId: 't_acme',
    ticketId: 'tkt1',
    ticketRef: 'TIX-000001',
    kind: 'response',
    level,
    audience: 'AGENT',
    label: `Level ${level}`,
    reason: `TIX-000001 response SLA at level ${level}.`,
    dedupeKey,
    raisedAt: '2026-01-01T09:55:00.000Z',
    acknowledgedAt: null,
  };
}

test('preferences service: the minimum level and mute narrow the list, and unread follows', async () => {
  const service = new NotificationService(new MemoryNotificationStore(), null, undefined, new MemoryNotificationPreferenceStore());

  await service.notifyEscalation(rung(1, 'tkt1:response:1'));
  await service.notifyEscalation(rung(3, 'tkt1:response:3'));

  const all = await service.listFor(agentActor);
  assert.equal(all.notifications.length, 2);
  assert.equal(all.unread, 2);
  assert.equal(all.preference.minLevel, NOTIFICATION_MIN_LEVEL);

  await service.savePreference(agentActor, { minLevel: 3, muted: false });
  const filtered = await service.listFor(agentActor);
  assert.deepEqual(filtered.notifications.map((n) => n.level), [3]);
  assert.equal(filtered.unread, 1);
  assert.equal(filtered.preference.minLevel, 3);

  await service.savePreference(agentActor, { minLevel: 1, muted: true });
  const muted = await service.listFor(agentActor);
  assert.equal(muted.notifications.length, 0);
  assert.equal(muted.unread, 0, 'the badge stays down when muted');
  assert.equal(muted.preference.muted, true);
});

/* -------------------------------------------------------------------------- */
/*  The rendered worklist with bulk actions                                   */
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

test('inbox UI: the bulk toolbar and per-row checkboxes render', () => {
  const html = renderToStaticMarkup(
    createElement(AgentInbox, {
      all: [ticket({ id: 'a', ref: 'TIX-000001', subject: 'VPN certificate invalid' })],
      bulk: { action: async () => {} },
    }),
  );
  assert.match(html, /name="ticketIds"/);
  assert.match(html, /value="a"/);
  assert.match(html, /With selected:/);
  assert.match(html, /Set status/);
  assert.match(html, /Assign/);
  assert.match(html, /aria-label="Select TIX-000001"/);
});

test('inbox UI: without bulk there are no checkboxes or toolbar', () => {
  const html = renderToStaticMarkup(createElement(AgentInbox, { all: [ticket({ id: 'a' })] }));
  assert.doesNotMatch(html, /name="ticketIds"/);
  assert.doesNotMatch(html, /With selected:/);
});

/* -------------------------------------------------------------------------- */
/*  The rendered notification list                                            */
/* -------------------------------------------------------------------------- */

function notice(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: 'n1',
    tenantId: 't_acme',
    audience: 'DISPATCHER',
    kind: 'sla.escalation',
    title: 'Response at 80%: TIX-000001',
    body: 'TIX-000001 response SLA - 80% of the window used.',
    ticketId: 'tkt1',
    ticketRef: 'TIX-000001',
    dedupeKey: 'tkt1:response:2',
    level: 2,
    createdAt: '2026-01-01T09:55:00.000Z',
    readAt: null,
    ...overrides,
  };
}

test('notification UI: a notice renders its level, audience, ticket link and mark-read', () => {
  const html = renderToStaticMarkup(
    createElement(NotificationList, { notifications: [notice()], readAction: async () => {} }),
  );
  assert.match(html, /Response at 80%: TIX-000001/);
  assert.match(html, /DISPATCHER/);
  assert.match(html, /L2/);
  assert.match(html, /Unread/);
  assert.match(html, /Open TIX-000001/);
  assert.match(html, /Mark read/);
});

test('notification UI: a read notice loses the unread chip and the button', () => {
  const html = renderToStaticMarkup(
    createElement(NotificationList, {
      notifications: [notice({ readAt: '2026-01-02T00:00:00.000Z' })],
      readAction: async () => {},
    }),
  );
  assert.doesNotMatch(html, /Unread/);
  assert.doesNotMatch(html, /Mark read/);
});

test('notification UI: the empty state can be tailored to a muted user', () => {
  const html = renderToStaticMarkup(
    createElement(NotificationList, { notifications: [], emptyMessage: 'In-app notifications are muted.' }),
  );
  assert.match(html, /In-app notifications are muted\./);
});
