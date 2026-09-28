/**
 * OnTrak Tix tests: saved inbox views.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-saved-views.test.ts
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Actor } from '../src/lib/access-rules';
import {
  SAVED_VIEW_NAME_MAX,
  describeInboxFilter,
  parseFilterJson,
  sameFilter,
  sanitizeInboxFilter,
  validateSavedView,
  type SavedView,
} from '../src/lib/saved-view-rules';
import { MemorySavedViewStore, SavedViewService } from '../src/lib/saved-view-service';
import { inboxFilterQuery } from '../src/lib/inbox-view';
import { SavedViews } from '../src/components/SavedViews';

/* -------------------------------------------------------------------------- */
/*  Rules                                                                     */
/* -------------------------------------------------------------------------- */

test('saved views: a filter is sanitized, dropping anything unknown', () => {
  assert.deepEqual(sanitizeInboxFilter({ status: 'all', sla: 'breached', assigneeId: 'u1' }), {
    status: 'all',
    sla: 'breached',
    assigneeId: 'u1',
  });
  assert.deepEqual(sanitizeInboxFilter({ status: 'NONSENSE', sla: 'sort-of', evil: true }), {});
  assert.deepEqual(sanitizeInboxFilter(null), {});
  assert.deepEqual(sanitizeInboxFilter('not an object'), {});
  assert.deepEqual(sanitizeInboxFilter({ search: '  vpn  ' }), { search: 'vpn' });
  assert.equal(sanitizeInboxFilter({ search: 'x'.repeat(500) }).search?.length, 120, 'search is capped');
});

test('saved views: the filter JSON a form carries is parsed defensively', () => {
  assert.deepEqual(parseFilterJson(JSON.stringify({ status: 'OPEN', sla: 'at-risk' })), { status: 'OPEN', sla: 'at-risk' });
  assert.deepEqual(parseFilterJson('{not json'), {});
  assert.deepEqual(parseFilterJson(''), {});
  assert.deepEqual(parseFilterJson(42), {});
  assert.deepEqual(parseFilterJson(JSON.stringify({ status: 'bogus' })), {}, 'an unknown value is dropped, not kept');
});

test('saved views: the name is required and bounded', () => {
  assert.equal(validateSavedView({ name: 'SLA breached' }).length, 0);
  assert.ok(validateSavedView({ name: '   ' }).some((issue) => issue.field === 'name'));
  assert.ok(validateSavedView({ name: 'x'.repeat(SAVED_VIEW_NAME_MAX + 1) }).some((issue) => issue.field === 'name'));
});

test('saved views: a filter is described in words', () => {
  assert.equal(describeInboxFilter({}), 'Open');
  assert.equal(describeInboxFilter({ assigneeId: 'unassigned', sla: 'breached' }), 'Open · Unassigned · SLA breached');
  assert.equal(describeInboxFilter({ status: 'all', search: 'vpn' }), 'All · “vpn”');
  assert.equal(describeInboxFilter({ status: 'PENDING', queueId: 'q-net' }), 'Pending · Queue: q-net');
});

test('saved views: filters compare equal only when every field matches', () => {
  assert.equal(sameFilter({ status: 'open' }, { status: 'open' }), true);
  assert.equal(sameFilter({}, { status: 'open' }), false);
  assert.equal(sameFilter({ sla: 'breached' }, { sla: 'at-risk' }), false);
});

test('saved views: the chip link is the same query the inbox builds', () => {
  assert.equal(inboxFilterQuery({ status: 'open' }), '');
  assert.equal(inboxFilterQuery({ status: 'all', sla: 'breached' }), 'status=all&sla=breached');
});

/* -------------------------------------------------------------------------- */
/*  Service                                                                   */
/* -------------------------------------------------------------------------- */

const agent1: Actor = { id: 'u_agent1', tenantId: 't_acme', role: 'AGENT' };
const agent2: Actor = { id: 'u_agent2', tenantId: 't_acme', role: 'AGENT' };
const admin: Actor = { id: 'u_admin', tenantId: 't_acme', role: 'ADMIN' };
const requester: Actor = { id: 'u_req', tenantId: 't_acme', role: 'REQUESTER' };

function service() {
  return new SavedViewService(new MemorySavedViewStore());
}

test('saved views service: private views stay private, shared ones reach the desk', async () => {
  const views = service();
  const mine = await views.create(agent1, { name: 'Mine', filter: { sla: 'breached' } });
  const desk = await views.create(agent1, { name: 'Desk', filter: { status: 'all' }, shared: true });
  assert.equal(mine.ok, true);
  assert.equal(desk.ok, true);
  if (!mine.ok || !desk.ok) return;
  assert.equal(mine.value.shared, false);
  assert.equal(desk.value.shared, true);
  assert.deepEqual(mine.value.filter, { sla: 'breached' });

  assert.deepEqual((await views.list(agent1)).map((v) => v.name).sort(), ['Desk', 'Mine']);
  assert.deepEqual((await views.list(agent2)).map((v) => v.name), ['Desk'], 'another agent sees only the shared view');
});

test('saved views service: names are unique per owner and requesters cannot save', async () => {
  const views = service();
  await views.create(agent1, { name: 'Triaged', filter: {} });
  const duplicate = await views.create(agent1, { name: 'triaged', filter: {} });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.ok === false ? duplicate.error : '', /already have a view/i);

  // A different owner may reuse the name.
  assert.equal((await views.create(agent2, { name: 'Triaged', filter: {} })).ok, true);

  const denied = await views.create(requester, { name: 'Nope', filter: {} });
  assert.equal(denied.ok, false);
});

test('saved views service: only the owner or an admin removes a view', async () => {
  const views = service();
  const created = await views.create(agent1, { name: 'Mine', filter: {} });
  if (!created.ok) return;

  assert.equal((await views.remove(agent2, created.value.id)).ok, false);
  assert.equal((await views.remove(requester, created.value.id)).ok, false);
  assert.equal((await views.remove(admin, created.value.id)).ok, true);
  assert.equal((await views.list(agent1)).length, 0);
});

test('saved views service: a crafted filter is sanitized on the way in', async () => {
  const views = service();
  const created = await views.create(agent1, { name: 'Sneaky', filter: { status: 'bogus', sla: 'whatever', search: ' x ' } });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.deepEqual(created.value.filter, { search: 'x' });
});

/* -------------------------------------------------------------------------- */
/*  Rendered chips                                                            */
/* -------------------------------------------------------------------------- */

function view(overrides: Partial<SavedView> = {}): SavedView {
  return {
    id: 'v1',
    tenantId: 't_acme',
    ownerId: 'u_agent1',
    name: 'SLA breached',
    filter: { sla: 'breached' },
    shared: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('saved views UI: chips link to their filter and the save form renders', () => {
  const html = renderToStaticMarkup(
    createElement(SavedViews, {
      views: [view({ ownerId: 'u_agent1' }), view({ id: 'v2', name: 'Team triage', ownerId: 'u_admin', shared: true })],
      activeFilter: { sla: 'breached' },
      actorId: 'u_agent1',
      canShare: true,
      saveAction: async () => {},
      deleteAction: async () => {},
    }),
  );
  assert.match(html, /href="\/inbox\?sla=breached"/);
  assert.match(html, /aria-current="true"/, 'the active view is marked');
  assert.match(html, /SLA breached/);
  assert.match(html, /Team triage/);
  assert.match(html, /· shared/);
  // Only the caller's own view offers removal.
  assert.match(html, /Remove view SLA breached/);
  assert.doesNotMatch(html, /Remove view Team triage/);
  assert.match(html, /Save this view as/);
  assert.match(html, /name="filter"/);
});

test('saved views UI: a viewer without share rights gets no shared checkbox', () => {
  const html = renderToStaticMarkup(
    createElement(SavedViews, {
      views: [],
      activeFilter: {},
      actorId: 'u_agent1',
      canShare: false,
      saveAction: async () => {},
      deleteAction: async () => {},
    }),
  );
  assert.doesNotMatch(html, /name="shared"/);
  assert.match(html, /Save view/);
});
