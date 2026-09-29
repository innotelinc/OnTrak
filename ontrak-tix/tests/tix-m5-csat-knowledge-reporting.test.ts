/**
 * OnTrak Tix M5 tests: the satisfaction dashboard and the knowledge-gap report.
 *
 * Both are pure reductions over records the rest of the product already writes,
 * so what is worth pinning down is the *reading*: that an average never hides a
 * distribution (one 1 and one 5 also average 3), that a repeat requester sorts
 * to the top of the gap report, and that a staff-only article still counts as an
 * answer because the desk could have used it.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m5-csat-knowledge-reporting.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  csatByGroup,
  csatComments,
  csatDashboard,
  csatDistribution,
  type AttributedSurvey,
  type CsatScore,
  type CsatSurvey,
} from "../src/lib/csat-rules";
import {
  GAP_TERM_LIMIT,
  buildKnowledgeGapReport,
  findKnowledgeGaps,
  type GapTicket,
  type KnowledgeArticle,
} from "../src/lib/knowledge-rules";

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

function survey(overrides: Partial<CsatSurvey> = {}): CsatSurvey {
  return {
    token: "token",
    requestedAt: "2026-09-01T09:00:00.000Z",
    respondedAt: null,
    score: null,
    comment: null,
    ...overrides,
  };
}

function answered(score: CsatScore, respondedAt: string, comment: string | null = null): CsatSurvey {
  return survey({ score, respondedAt, comment });
}

function ticket(overrides: Partial<GapTicket> = {}): GapTicket {
  return {
    id: "t-1",
    ref: "T-1",
    subject: "Something is wrong",
    requesterId: "u1",
    clientId: null,
    status: "OPEN",
    createdAt: "2026-09-01T09:00:00.000Z",
    ...overrides,
  };
}

const PASSWORD_ARTICLE: KnowledgeArticle = {
  id: "kb-1",
  tenantId: "tenant-a",
  title: "Reset your password",
  body: "Use the forgot-password link on the sign-in screen.",
  visibility: "PUBLIC",
  tags: ["password", "login"],
  createdBy: "admin-1",
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T09:00:00.000Z",
};

/* -------------------------------------------------------------------------- */
/*  The satisfaction dashboard                                                */
/* -------------------------------------------------------------------------- */

test("csatDistribution shows every point on the scale, even an empty one", () => {
  const buckets = csatDistribution([
    answered(5, "2026-09-10T10:00:00.000Z"),
    answered(5, "2026-09-11T10:00:00.000Z"),
    answered(2, "2026-09-12T10:00:00.000Z"),
    answered(4, "2026-09-13T10:00:00.000Z"),
  ]);

  assert.deepEqual(
    buckets.map((bucket) => bucket.score),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    buckets.map((bucket) => bucket.count),
    [0, 1, 0, 1, 2],
  );
  // A score nobody gave is a visible zero, and its share is 0 rather than blank.
  assert.deepEqual(
    buckets.map((bucket) => bucket.percent),
    [0, 25, 0, 25, 50],
  );
  assert.equal(buckets[0].label, "Very dissatisfied");
  assert.equal(buckets[4].label, "Very satisfied");
});

test("csatDistribution reports no percentages before anybody answers", () => {
  const buckets = csatDistribution([survey(), survey()]);
  assert.deepEqual(
    buckets.map((bucket) => bucket.percent),
    [null, null, null, null, null],
  );
  assert.deepEqual(
    buckets.map((bucket) => bucket.count),
    [0, 0, 0, 0, 0],
  );
});

test("csatComments keeps only words, trimmed, newest first, and respects the limit", () => {
  const comments = csatComments(
    [
      answered(5, "2026-09-10T10:00:00.000Z", "  quick and clear  "),
      answered(2, "2026-09-11T10:00:00.000Z", null),
      answered(4, "2026-09-12T10:00:00.000Z", "   "),
      answered(5, "2026-09-13T10:00:00.000Z", "excellent"),
    ],
    2,
  );

  assert.equal(comments.length, 2);
  assert.deepEqual(comments[0], { score: 5, comment: "excellent", answeredAt: "2026-09-13T10:00:00.000Z" });
  assert.deepEqual(comments[1], { score: 5, comment: "quick and clear", answeredAt: "2026-09-10T10:00:00.000Z" });
});

test("csatDashboard rolls the summary, the shape and the words into one picture", () => {
  const surveys = [
    answered(5, "2026-09-10T10:00:00.000Z", "great"),
    answered(2, "2026-09-11T10:00:00.000Z"),
    answered(4, "2026-09-12T10:00:00.000Z", "fine"),
    answered(5, "2026-09-13T10:00:00.000Z"),
    survey(),
    survey(),
  ];

  const dashboard = csatDashboard(surveys, surveys.length);

  assert.deepEqual(dashboard.summary, {
    responses: 4,
    pending: 2,
    average: 4,
    positivePercent: 75,
    responseRatePercent: 66.7,
  });
  assert.equal(dashboard.distribution.find((bucket) => bucket.score === 3)?.count, 0);
  // Only the two answers that came with words, newest first.
  assert.deepEqual(dashboard.comments.map((comment) => comment.comment), ["fine", "great"]);
});

test("csatByGroup splits satisfaction by whoever earned it, worst first", () => {
  const entries: AttributedSurvey[] = [
    { survey: answered(5, "2026-09-10T10:00:00.000Z"), groupId: "agent-a" },
    { survey: answered(2, "2026-09-11T10:00:00.000Z"), groupId: "agent-b" },
    // A survey that was offered but never answered still counts against the rate.
    { survey: survey(), groupId: "agent-b" },
    { survey: answered(4, "2026-09-12T10:00:00.000Z"), groupId: null },
    { survey: answered(5, "2026-09-13T10:00:00.000Z"), groupId: "agent-a" },
    // No answers at all: not "doing badly", so it must sort last.
    { survey: survey(), groupId: "agent-c" },
  ];

  const rows = csatByGroup(entries, (groupId) => (groupId === null ? "Unassigned" : `Agent ${groupId}`));

  assert.deepEqual(
    rows.map((row) => row.label),
    ["Agent agent-b", "Unassigned", "Agent agent-a", "Agent agent-c"],
  );
  assert.equal(rows[0].summary.average, 2);
  assert.equal(rows[0].summary.responses, 1);
  // Offered twice, answered once, so the group's own response rate is honest.
  assert.equal(rows[0].summary.responseRatePercent, 50);
  assert.equal(rows[2].summary.average, 5);
  assert.equal(rows[2].summary.responseRatePercent, 100);
  assert.equal(rows[3].summary.average, null);
});

/* -------------------------------------------------------------------------- */
/*  Knowledge gaps                                                            */
/* -------------------------------------------------------------------------- */

test("a subject that finds an article is not a gap", () => {
  const matched = ticket({ ref: "T-9", subject: "Reset my password please" });
  assert.deepEqual(findKnowledgeGaps([PASSWORD_ARTICLE], [matched]), []);
});

test("a staff-only article still counts as an answer", () => {
  const privateArticle: KnowledgeArticle = { ...PASSWORD_ARTICLE, id: "kb-2", visibility: "PRIVATE" };
  const matched = ticket({ ref: "T-9", subject: "Reset my password" });
  // The desk could have replied from it, so the gap is "publish it", not "write it".
  assert.deepEqual(findKnowledgeGaps([privateArticle], [matched]), []);
});

test("subjects with overlapping words cluster into the one question behind them", () => {
  const tickets = [
    ticket({ id: "t-1", ref: "T-1", subject: "VPN drops every hour", requesterId: "u1", createdAt: "2026-09-01T09:00:00.000Z" }),
    ticket({ id: "t-2", ref: "T-2", subject: "VPN certificate expired", requesterId: "u2", createdAt: "2026-09-02T09:00:00.000Z" }),
    ticket({ id: "t-3", ref: "T-3", subject: "Printer jam floor two", requesterId: "u3", createdAt: "2026-09-03T09:00:00.000Z" }),
    ticket({ id: "t-4", ref: "T-4", subject: "VPN will not connect", requesterId: "u1", createdAt: "2026-09-04T09:00:00.000Z" }),
  ];

  const gaps = findKnowledgeGaps([PASSWORD_ARTICLE], tickets);

  assert.equal(gaps.length, 2);
  // A repeated requester is the loudest signal, so that cluster sorts first.
  assert.equal(gaps[0].terms[0], "vpn");
  assert.equal(gaps[0].repeat, true);
  assert.deepEqual(gaps[0].requesters, ["u1", "u2"]);
  assert.deepEqual(
    gaps[0].tickets.map((entry) => entry.ref),
    ["T-1", "T-2", "T-4"],
  );
  assert.equal(gaps[1].terms[0], "floor");
  assert.equal(gaps[1].repeat, false);
  assert.deepEqual(gaps[1].terms, ["floor", "jam", "printer", "two"]);
});

test("the terms of a cluster are the most shared ones, capped for readability", () => {
  const tickets = [
    ticket({ id: "t-1", ref: "T-1", subject: "laptop docking station flickers", requesterId: "u1", createdAt: "2026-09-01T09:00:00.000Z" }),
    ticket({ id: "t-2", ref: "T-2", subject: "laptop docking station dead", requesterId: "u1", createdAt: "2026-09-02T09:00:00.000Z" }),
    ticket({ id: "t-3", ref: "T-3", subject: "laptop docking station warm", requesterId: "u2", createdAt: "2026-09-03T09:00:00.000Z" }),
  ];

  const [gap] = findKnowledgeGaps([PASSWORD_ARTICLE], tickets);
  // The words all three tickets share come first; the unique ones trail them.
  assert.deepEqual([...gap.terms.slice(0, 3)].sort(), ["docking", "laptop", "station"]);
  assert.ok(gap.terms.indexOf("station") < gap.terms.indexOf("dead"));
  assert.ok(gap.terms.length <= GAP_TERM_LIMIT);
});

test("a subject with nothing searchable in it is not a gap", () => {
  // Every word is a stopword, so there was no question to fail to answer.
  const empty = ticket({ subject: "This is not so" });
  assert.deepEqual(findKnowledgeGaps([PASSWORD_ARTICLE], [empty]), []);
  assert.equal(buildKnowledgeGapReport([PASSWORD_ARTICLE], [empty]).unanswered, 0);
});

test("the gap report counts what could not be answered and how much of the desk that was", () => {
  const tickets = [
    ticket({ id: "t-1", ref: "T-1", subject: "Reset my password", requesterId: "u9" }),
    ticket({ id: "t-2", ref: "T-2", subject: "VPN drops every hour", requesterId: "u1" }),
    ticket({ id: "t-3", ref: "T-3", subject: "VPN certificate expired", requesterId: "u2" }),
    ticket({ id: "t-4", ref: "T-4", subject: "VPN will not connect", requesterId: "u1" }),
    ticket({ id: "t-5", ref: "T-5", subject: "Printer jam floor two", requesterId: "u3" }),
  ];

  const report = buildKnowledgeGapReport([PASSWORD_ARTICLE], tickets);

  assert.equal(report.considered, 5);
  assert.equal(report.unanswered, 4);
  assert.equal(report.requesters, 3);
  assert.equal(report.unansweredPercent, 80);
  assert.equal(report.gaps.length, 2);
  assert.equal(report.gaps[0].repeat, true);
});

test("an empty gap report is a valid answer, not a division by zero", () => {
  const report = buildKnowledgeGapReport([PASSWORD_ARTICLE], []);
  assert.equal(report.unansweredPercent, null);
  assert.deepEqual(report.gaps, []);
});

test("the gap limit keeps a report readable without dropping the worst cluster", () => {
  const tickets = [
    ticket({ id: "t-1", ref: "T-1", subject: "printer offline again", requesterId: "u1", createdAt: "2026-09-01T09:00:00.000Z" }),
    ticket({ id: "t-2", ref: "T-2", subject: "printer offline still", requesterId: "u1", createdAt: "2026-09-02T09:00:00.000Z" }),
    ticket({ id: "t-3", ref: "T-3", subject: "vpn keeps dropping", requesterId: "u2", createdAt: "2026-09-03T09:00:00.000Z" }),
  ];

  const gaps = findKnowledgeGaps([PASSWORD_ARTICLE], tickets, { limit: 1 });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].repeat, true);
  assert.ok(gaps[0].terms.includes("printer"));
});
