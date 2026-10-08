/**
 * The results feed's filters, including the grading-mode one.
 *
 * A bad filter must be described rather than ignored, and a good one must become
 * the clause it claims to. The mode filter is the interesting case: `simulated`
 * has to match an attempt with no mode recorded (those were graded by the
 * simulator), and it must coexist with the cohort filter, which is the other
 * clause that needs an `OR` of its own.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/result-filters.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  RESULT_STATUSES,
  readResultFilters,
  resultWhere,
} from "../src/lib/result-filters";

function read(query: string) {
  return readResultFilters(new URL(`https://ontrak.test/api/v1/results${query}`));
}

test("result filters: defaults are everything that finished, both modes, one page", () => {
  const read0 = read("");
  assert.equal(read0.ok, true);
  if (!read0.ok) return;
  assert.deepEqual(read0.filters.status, [...RESULT_STATUSES]);
  assert.deepEqual(read0.filters.mode, ["simulated", "lab"]);
  assert.equal(read0.filters.limit, DEFAULT_LIMIT);
  assert.equal(read0.filters.since, null);
  assert.equal(read0.filters.cursor, null);
  // Both modes means no mode clause at all.
  assert.deepEqual(resultWhere(read0.filters), { status: { in: [...RESULT_STATUSES] } });
});

test("result filters: mode narrows to one grader, and simulated includes the unrecorded", () => {
  const lab = read("?mode=lab");
  assert.equal(lab.ok, true);
  if (lab.ok) {
    assert.deepEqual(lab.filters.mode, ["lab"]);
    assert.deepEqual(resultWhere(lab.filters), {
      AND: [{ status: { in: [...RESULT_STATUSES] } }, { gradingMode: "lab" }],
    });
  }

  const simulated = read("?mode=simulated");
  assert.equal(simulated.ok, true);
  if (simulated.ok) {
    assert.deepEqual(simulated.filters.mode, ["simulated"]);
    // A stored `simulated` and a null column are the same fact.
    assert.deepEqual(resultWhere(simulated.filters), {
      AND: [
        { status: { in: [...RESULT_STATUSES] } },
        { OR: [{ gradingMode: null }, { gradingMode: "simulated" }] },
      ],
    });
  }

  // Naming both is the same as naming neither.
  const both = read("?mode=simulated,lab");
  assert.equal(both.ok, true);
  if (both.ok) {
    assert.deepEqual(both.filters.mode, ["simulated", "lab"]);
    assert.deepEqual(resultWhere(both.filters), { status: { in: [...RESULT_STATUSES] } });
  }

  // A repeated value collapses rather than counting twice.
  const repeated = read("?mode=lab,lab");
  assert.equal(repeated.ok, true);
  if (repeated.ok) assert.deepEqual(repeated.filters.mode, ["lab"]);
});

test("result filters: an unknown mode is refused, not ignored", () => {
  const bad = read("?mode=container");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /unknown mode container; expected simulated, lab/);
});

test("result filters: the cohort and mode clauses survive being combined", () => {
  const read0 = read("?cohortId=c1&mode=simulated");
  assert.equal(read0.ok, true);
  if (!read0.ok) return;
  assert.deepEqual(resultWhere(read0.filters), {
    AND: [
      { status: { in: [...RESULT_STATUSES] } },
      {
        OR: [
          { assignment: { cohortId: "c1" } },
          { user: { memberships: { some: { cohortId: "c1" } } } },
        ],
      },
      { OR: [{ gradingMode: null }, { gradingMode: "simulated" }] },
    ],
  });
});

test("result filters: status and since are validated and normalised", () => {
  const bad = read("?since=not-a-date");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /`since` must be an ISO-8601 date-time/);

  const badStatus = read("?status=GRADED,NOPE");
  assert.equal(badStatus.ok, false);
  if (!badStatus.ok) assert.match(badStatus.reason, /unknown status NOPE/);

  const ok = read("?since=2026-10-01T00:00:00Z&status=graded&scenarioId=s1&limit=99999");
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.filters.since?.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.deepEqual(ok.filters.status, ["GRADED"]);
  assert.equal(ok.filters.scenarioId, "s1");
  assert.equal(ok.filters.limit, MAX_LIMIT, "a limit past the cap is the cap");
});

test("result filters: blank and whitespace-only values are absent, not empty filters", () => {
  const read0 = read("?scenarioId=%20%20&cohortId=&cursor=%20");
  assert.equal(read0.ok, true);
  if (!read0.ok) return;
  assert.equal(read0.filters.scenarioId, null);
  assert.equal(read0.filters.cohortId, null);
  assert.equal(read0.filters.cursor, null);
});
