/**
 * OnTrak Tix M1 tests: the exportable / scheduled SLA report.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m1-report-export.test.ts
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ALWAYS_OPEN_CALENDAR, type SlaPolicy } from '../src/lib/sla-rules';
import { buildSlaReport, reportSnapshot, type ReportTicket } from '../src/lib/report-rules';
import { buildSlaCsv, csvEscape, csvRow } from '../src/lib/report-csv';

const urgentPolicy: SlaPolicy = {
  id: 'p-urgent',
  name: 'Urgent',
  priority: 'URGENT',
  responseMinutes: 60,
  resolutionMinutes: 240,
  calendar: ALWAYS_OPEN_CALENDAR,
  warningFraction: 0.5,
};

function reportTicket(overrides: Partial<ReportTicket> = {}): ReportTicket {
  return {
    id: 't',
    ref: 'TIX-000000',
    subject: 's',
    status: 'OPEN',
    priority: 'URGENT',
    assigneeId: null,
    createdAt: '2026-01-01T09:00:00.000Z',
    firstResponseAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

test('csv: cells are quoted only when they must be', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('has, comma'), '"has, comma"');
  assert.equal(csvEscape('has "quote"'), '"has ""quote"""');
  assert.equal(csvEscape('line\nbreak'), '"line\nbreak"');
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(42), '42');
  assert.equal(csvRow(['a', 'b,c']), 'a,"b,c"');
});

test('csv: the report exports a summary block and a ticket table', () => {
  const tickets: ReportTicket[] = [
    reportTicket({ id: 'a', ref: 'TIX-000001', subject: 'VPN, broken' }),
    reportTicket({ id: 'b', ref: 'TIX-000002', firstResponseAt: '2026-01-01T09:30:00.000Z' }),
    reportTicket({ id: 'c', ref: 'TIX-000003', createdAt: '2026-01-01T08:00:00.000Z' }),
  ];
  const report = buildSlaReport(tickets, [urgentPolicy], '2026-01-01T09:55:00.000Z');
  const csv = buildSlaCsv(report, { generatedAt: '2026-01-01T10:00:00.000Z' });

  assert.match(csv, /OnTrak Tix SLA report/);
  assert.match(csv, /Generated,2026-01-01T10:00:00.000Z/);
  assert.match(csv, /Tickets,3/);
  assert.match(csv, /First response attainment %,100/);
  assert.match(csv, /Breached,1/);
  assert.match(csv, /Ref,Subject,Status,Priority,Assignee,SLA state/);
  // A comma in the subject forces quoting, and the breached ticket comes first.
  assert.ok(csv.indexOf('TIX-000003') < csv.indexOf('TIX-000001'), 'breached tickets lead the table');
  assert.ok(csv.includes('"VPN, broken"'), 'a comma in a subject is quoted');
  assert.ok(csv.endsWith('\r\n'), 'rows are CRLF-terminated, per RFC 4180');
});

test('snapshot: a report reduces to headline numbers and ref lists', () => {
  const tickets: ReportTicket[] = [
    reportTicket({ id: 'a', ref: 'TIX-000001', firstResponseAt: '2026-01-01T09:30:00.000Z' }),
    reportTicket({ id: 'c', ref: 'TIX-000003', createdAt: '2026-01-01T08:00:00.000Z' }),
    reportTicket({ id: 'e', ref: 'TIX-000005', priority: 'NORMAL' }),
  ];
  const report = buildSlaReport(tickets, [urgentPolicy], '2026-01-01T09:55:00.000Z');
  const snapshot = reportSnapshot(report, '2026-01-01T10:00:00.000Z');

  assert.equal(snapshot.totals.total, 3);
  assert.equal(snapshot.totals.withoutPolicy, 1);
  assert.equal(snapshot.responseAttainmentPercent, 100);
  assert.equal(snapshot.responseMedianMinutes, 30);
  assert.deepEqual(snapshot.breached, ['TIX-000003']);
  assert.deepEqual(snapshot.atRisk, ['TIX-000003']);
});
