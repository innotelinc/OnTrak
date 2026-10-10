/**
 * The lab's store on Postgres.
 *
 * Two halves in one file because they are the same contract at two levels, and both are
 * needed. The first runs the store against a fake client that speaks the four delegates it
 * uses, so every conversion, ordering rule and refusal is checked with no database at all —
 * the way the rest of this repository's suites run. The second runs the *same* store
 * against a *real* Postgres, which is the only thing that can prove the migration, the
 * enum, the timestamp precision and the foreign keys agree with the TypeScript; it skips
 * (not fails) when no database is reachable, so `npm test` stays green on a machine without
 * one, and the two are written so neither can drift from the other unnoticed.
 *
 * The contract itself is asserted once for *both* implementations: a table test runs the
 * same script against `InMemoryLabStore` and `PrismaLabStore`, because the promise `store.ts`
 * makes is that nothing above it knows which one it holds.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-store-prisma.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PrismaClient } from "@prisma/client";

import {
  newCheckOutcome,
  newLabSession,
  newScoreReport,
  type LabSession,
  type ScoreReport,
  type SessionState,
} from "../src/lib/lab/models";
import { InMemoryLabStore } from "../src/lib/lab/store";
import {
  LIVE_STATES,
  PrismaLabStore,
  dateToIso,
  liveStatesMatch,
  nullableIsoToDate,
  stateFromDb,
  stateToDb,
  type LabEventRow,
  type LabMetaRow,
  type LabPrismaClient,
  type LabResultRow,
  type LabSessionRow,
  type LabTicketDbRow,
} from "../src/lib/lab/store-prisma";
import { grade as markTicket, loadForm, type TicketGrade } from "../src/lib/lab/tickets";

const ALL_STATES: readonly SessionState[] = [
  "requested",
  "allocating",
  "provisioning",
  "ready",
  "in_use",
  "checking",
  "passed",
  "failed",
  "recycling",
  "destroyed",
  "error",
];

/* -------------------------------------------------------------------------- */
/*  A fake Prisma client                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The four delegates, in memory.
 *
 * It is deliberately *not* a stub that returns what a test tells it: it stores rows, applies
 * the `where`/`orderBy`/`take` the store passes, and assigns ids from a sequence, so the
 * store's behaviour (ordering, limits, refusals, round-trips) is what the assertions are
 * about. It also enforces the foreign key on results, because that is a fact the migration
 * creates and a fake that ignored it would let the store disagree with the real database.
 */
class FakeLabDb implements LabPrismaClient {
  private nextSessionId = 1;
  private nextResultId = 1;
  private nextEventId = 1;
  private nextTicketId = 1;
  readonly sessions = new Map<number, LabSessionRow>();
  readonly results: LabResultRow[] = [];
  readonly events: LabEventRow[] = [];
  readonly tickets: LabTicketDbRow[] = [];
  readonly meta = new Map<string, LabMetaRow>();
  /** Set to make the next `create` on a delegate throw, for error-path tests. */
  failNextCreate: Error | null = null;

  private guard(): void {
    if (this.failNextCreate !== null) {
      const error = this.failNextCreate;
      this.failNextCreate = null;
      throw error;
    }
  }

  /** The `where` subset the store builds: student, and state as a set. */
  private matches(row: LabSessionRow, where: Record<string, unknown>): boolean {
    if (typeof where.student === "string" && row.student !== where.student) return false;
    const state = where.state as { in?: string[] } | undefined;
    if (state?.in !== undefined && !state.in.includes(row.state)) return false;
    return true;
  }

  labSession = {
    create: async (args: { data: unknown }): Promise<LabSessionRow> => {
      this.guard();
      const data = args.data as Record<string, unknown>;
      const id = this.nextSessionId++;
      const row = { ...(data as object), id } as LabSessionRow;
      this.sessions.set(id, row);
      return row;
    },
    findUnique: async (args: { where: { id: number } }): Promise<LabSessionRow | null> => {
      return this.sessions.get(args.where.id) ?? null;
    },
    findMany: async (args: unknown): Promise<LabSessionRow[]> => {
      const query = (args ?? {}) as {
        where?: Record<string, unknown>;
        orderBy?: { id?: "asc" | "desc" };
        take?: number;
      };
      const where = query.where ?? {};
      let rows = [...this.sessions.values()].filter((row) => this.matches(row, where));
      rows.sort((left, right) =>
        query.orderBy?.id === "asc" ? left.id - right.id : right.id - left.id,
      );
      if (query.take !== undefined) rows = rows.slice(0, Math.max(0, query.take));
      return rows;
    },
    updateMany: async (args: {
      where: { id: number };
      data: unknown;
    }): Promise<{ count: number }> => {
      const existing = this.sessions.get(args.where.id);
      if (existing === undefined) return { count: 0 };
      this.sessions.set(args.where.id, { ...existing, ...(args.data as object) } as LabSessionRow);
      return { count: 1 };
    },
    count: async (args?: unknown): Promise<number> => {
      const where = ((args ?? {}) as { where?: Record<string, unknown> }).where ?? {};
      return [...this.sessions.values()].filter((row) => this.matches(row, where)).length;
    },
  };

  labResult = {
    create: async (args: { data: unknown }): Promise<LabResultRow> => {
      this.guard();
      const data = args.data as Record<string, unknown>;
      const sessionId = Number(data.sessionId);
      if (!this.sessions.has(sessionId)) {
        // The migration's foreign key, which the real database enforces.
        throw new Error("foreign key violated: LabResult_sessionId_fkey");
      }
      const row = {
        id: this.nextResultId++,
        sessionId,
        student: String(data.student),
        scenarioId: String(data.scenarioId),
        score: Number(data.score),
        resolved: Boolean(data.resolved),
        report: data.report,
        createdAt: new Date(),
      } satisfies LabResultRow;
      this.results.push(row);
      return row;
    },
    findFirst: async (args: unknown): Promise<LabResultRow | null> => {
      const where = ((args ?? {}) as { where?: { sessionId?: number } }).where ?? {};
      const mine = this.results
        .filter((row) => row.sessionId === where.sessionId)
        .sort((left, right) => right.id - left.id);
      return mine[0] ?? null;
    },
    findMany: async (args: unknown): Promise<LabResultRow[]> => {
      const where = ((args ?? {}) as { where?: { student?: string } }).where ?? {};
      return this.results
        .filter((row) => where.student === undefined || row.student === where.student)
        .sort((left, right) => left.id - right.id);
    },
    count: async (args?: unknown): Promise<number> => {
      const where = ((args ?? {}) as { where?: { sessionId?: number } }).where ?? {};
      return this.results.filter((row) => where.sessionId === undefined || row.sessionId === where.sessionId)
        .length;
    },
  };

  labTicket = {
    create: async (args: { data: unknown }): Promise<LabTicketDbRow> => {
      this.guard();
      const data = args.data as Record<string, unknown>;
      const sessionId = Number(data.sessionId);
      if (!this.sessions.has(sessionId)) {
        // The migration's foreign key, which the real database enforces.
        throw new Error("foreign key violated: LabTicket_sessionId_fkey");
      }
      const row: LabTicketDbRow = {
        id: this.nextTicketId++,
        sessionId,
        student: String(data.student),
        scenarioId: String(data.scenarioId),
        grade: data.grade,
        values: data.values,
        score: Number(data.score),
        submitted: Boolean(data.submitted),
        createdAt: new Date(),
      };
      this.tickets.push(row);
      return row;
    },
    findFirst: async (args: unknown): Promise<LabTicketDbRow | null> => {
      const where = ((args ?? {}) as { where?: { sessionId?: number } }).where ?? {};
      const mine = this.tickets
        .filter((row) => row.sessionId === where.sessionId)
        .sort((left, right) => right.id - left.id);
      return mine[0] ?? null;
    },
    findMany: async (args: unknown): Promise<LabTicketDbRow[]> => {
      const query = (args ?? {}) as {
        where?: { sessionId?: number; student?: string };
        orderBy?: { id?: "asc" | "desc" };
        take?: number;
      };
      const where = query.where ?? {};
      let rows = this.tickets.filter(
        (row) =>
          (where.sessionId === undefined || row.sessionId === where.sessionId) &&
          (where.student === undefined || row.student === where.student),
      );
      rows = [...rows].sort((left, right) =>
        query.orderBy?.id === "asc" ? left.id - right.id : right.id - left.id,
      );
      if (query.take !== undefined) rows = rows.slice(0, Math.max(0, query.take));
      return rows;
    },
    count: async (args?: unknown): Promise<number> => {
      const where = ((args ?? {}) as { where?: { submitted?: boolean } }).where ?? {};
      return this.tickets.filter((row) => where.submitted === undefined || row.submitted === where.submitted)
        .length;
    },
    aggregate: async (): Promise<{ _count: number; _avg: { score: number | null } }> => {
      const total = this.tickets.reduce((sum, row) => sum + row.score, 0);
      return {
        _count: this.tickets.length,
        _avg: { score: this.tickets.length === 0 ? null : total / this.tickets.length },
      };
    },
  };

  labEvent = {
    create: async (args: { data: unknown }): Promise<LabEventRow> => {
      this.guard();
      const data = args.data as Record<string, unknown>;
      const row: LabEventRow = {
        id: this.nextEventId++,
        kind: String(data.kind),
        detail: String(data.detail ?? ""),
        sessionId: data.sessionId === null || data.sessionId === undefined ? null : Number(data.sessionId),
        createdAt: new Date(),
      };
      this.events.push(row);
      return row;
    },
    findMany: async (args: unknown): Promise<LabEventRow[]> => {
      const query = (args ?? {}) as {
        where?: { sessionId?: number; kind?: string };
        orderBy?: { id?: "asc" | "desc"; kind?: "asc" | "desc" };
        take?: number;
        distinct?: string[];
      };
      let rows = this.events.filter(
        (row) =>
          (query.where?.sessionId === undefined || row.sessionId === query.where.sessionId) &&
          (query.where?.kind === undefined || row.kind === query.where.kind),
      );
      if (query.orderBy?.kind !== undefined) {
        const direction = query.orderBy.kind;
        rows = [...rows].sort((left, right) =>
          direction === "asc"
            ? left.kind.localeCompare(right.kind)
            : right.kind.localeCompare(left.kind),
        );
        // `distinct: ["kind"]` keeps one row per kind, as Prisma's does.
        if (query.distinct?.includes("kind")) {
          const seen = new Set<string>();
          rows = rows.filter((row) => {
            if (seen.has(row.kind)) return false;
            seen.add(row.kind);
            return true;
          });
        }
      } else {
        rows = [...rows].sort((left, right) =>
          query.orderBy?.id === "asc" ? left.id - right.id : right.id - left.id,
        );
      }
      if (query.take !== undefined) rows = rows.slice(0, Math.max(0, query.take));
      return rows;
    },
    count: async (): Promise<number> => this.events.length,
  };

  labMeta = {
    findUnique: async (args: { where: { key: string } }): Promise<LabMetaRow | null> => {
      return this.meta.get(args.where.key) ?? null;
    },
    upsert: async (args: {
      where: { key: string };
      create: unknown;
      update: unknown;
    }): Promise<LabMetaRow> => {
      this.guard();
      const create = args.create as { key: string; value: unknown };
      const update = args.update as { value: unknown };
      const row: LabMetaRow = {
        key: args.where.key,
        value: this.meta.has(args.where.key) ? update.value : create.value,
        updatedAt: new Date(),
      };
      this.meta.set(args.where.key, row);
      return row;
    },
  };
}

/** A session with every field set to a fact a round-trip could lose. */
function populatedSession(student: string, index: number): LabSession {
  const session = newLabSession({ student, scenarioId: "net-dns-failure" });
  session.state = "passed";
  session.instance = `ontrak-sess-net-dns-failure-${index}`;
  session.hostIp = "10.20.0.42";
  session.rdpUser = "Student";
  session.rdpPassword = "TrainMe-1";
  session.hintLevel = 2;
  session.checksRun = 3;
  session.bestScore = 87.5;
  session.resolved = true;
  session.notes = "worked it out [completed]";
  session.workload = "ubuntu-24.04";
  session.timeLimitMinutes = 45;
  session.createdAt = "2026-10-09T09:00:00.000Z";
  session.readyAt = "2026-10-09T09:01:30.500Z";
  session.expiresAt = "2026-10-09T09:45:00.000Z";
  session.lastActivityAt = "2026-10-09T09:30:00.000Z";
  session.completedAt = "2026-10-09T09:31:00.000Z";
  return session;
}

/**
 * A marked write-up, built by the real ticket module rather than typed out.
 *
 * A fixture written by hand would let the store's round-trip pass against a shape nothing
 * produces; grading a real rubric means the JSONB this test stores is the JSONB a session
 * stores.
 */
function ticketGrade(sessionId: number): TicketGrade {
  const form = loadForm({
    form: {
      weight: 30,
      pass_score: 60,
      fields: [
        { id: "cause", label: "Root cause", weight: 60, min_words: 3, any_of: ["dns", "resolver"] },
        {
          id: "class",
          label: "Classification",
          kind: "select",
          weight: 40,
          options: ["Network", "Permissions"],
          expected: "Network",
        },
      ],
    },
  });
  if (form === null) throw new Error("the fixture rubric must load");
  return markTicket(
    form,
    { cause: "the dns resolver address was set by hand", class: "Network" },
    { sessionId, scenarioId: "net-dns-failure" },
  );
}

function fullReport(sessionId: number): ScoreReport {
  const report = newScoreReport({ sessionId, scenarioId: "net-dns-failure" });
  report.score = 87.5;
  report.resolved = true;
  report.error = "";
  report.notes = ["final submission judged against DNS failure", "the write-up was not blended"];
  report.machineScore = 87.5;
  report.ticketScore = 70;
  report.ticketWeight = 20;
  report.ticketOutcomes = [{ field: "resolution", passed: true }];
  report.outcomes = [
    newCheckOutcome({ objectiveId: "dns-resolves", passed: true, weight: 30, critical: true }),
    newCheckOutcome({ objectiveId: "suffix-search", passed: false, detail: "still broken", weight: 10 }),
  ];
  return report;
}

/* -------------------------------------------------------------------------- */
/*  The contract, held against both implementations                            */
/* -------------------------------------------------------------------------- */

test("store-prisma: both implementations satisfy the same contract", async () => {
  const stores: [string, InMemoryLabStore | PrismaLabStore][] = [
    ["in-memory", new InMemoryLabStore()],
    ["prisma(fake)", new PrismaLabStore(new FakeLabDb())],
  ];

  for (const [name, store] of stores) {
    const created = await store.createSession(populatedSession("ada", 1));
    assert.equal(typeof created.id, "number", `${name}: the store assigns the id`);
    assert.equal(
      await store.getSession(created.id ?? 0).then((session) => session?.student),
      "ada",
      `${name}: the session is readable by id`,
    );

    // A save round-trips every field, including the three optional moments and the one
    // that tells a submitted session from a resolved one.
    const edited = created;
    edited.state = "in_use";
    edited.completedAt = "";
    edited.readyAt = "";
    await store.saveSession(edited);
    const reloaded = await store.getSession(created.id ?? 0);
    assert.equal(reloaded?.state, "in_use", `${name}: the state is saved`);
    assert.equal(reloaded?.completedAt, "", `${name}: a cleared moment stays cleared`);
    assert.equal(reloaded?.readyAt, "", `${name}: "" is absence, not 1970`);
    assert.equal(reloaded?.expiresAt, "2026-10-09T09:45:00.000Z", `${name}: a set moment survives`);

    // The stored report comes back whole, and `latestReport` is the newest attempt.
    await store.addResult(fullReport(created.id ?? 0), "ada");
    const report = await store.latestReport(created.id ?? 0);
    assert.equal(report?.score, 87.5, `${name}: the score is stored`);
    assert.equal(report?.outcomes.length, 2, `${name}: every outcome is stored`);
    assert.equal(report?.outcomes[0]?.critical, true, `${name}: and its criticality`);
    assert.equal(report?.ticketScore, 70, `${name}: the ticket half is stored apart`);
    assert.equal(await store.attemptCounts(created.id ?? 0), 1, `${name}: one attempt`);
    assert.equal((await store.resultsForStudent("ada")).length, 1, `${name}: one result for ada`);
    assert.deepEqual(await store.resultsForStudent("grace"), [], `${name}: and none for grace`);

    // Events read newest-first, and a page of zero is a page of zero.
    await store.logEvent("requested", "asked for a machine", created.id ?? 0);
    await store.logEvent("ready", "running", created.id ?? 0);
    const events = await store.eventsFor(created.id ?? 0, 10);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["ready", "requested"],
      `${name}: newest first`,
    );
    assert.deepEqual(await store.eventsFor(created.id ?? 0, 0), [], `${name}: limit 0 is empty`);
    assert.equal(await store.countEvents(), 2, `${name}: both events are counted`);

    // The admin audit reader: the same trail, narrowed *in the store* rather than in the
    // page, and the kind list the filter is drawn from.
    assert.deepEqual(
      (await store.listEvents({ kind: "ready" })).map((event) => event.kind),
      ["ready"],
      `${name}: the audit trail narrows by kind`,
    );
    assert.deepEqual(
      (await store.listEvents()).map((event) => event.kind),
      ["ready", "requested"],
      `${name}: unfiltered it is the whole trail, newest first`,
    );
    assert.deepEqual(await store.listEvents({ limit: 0 }), [], `${name}: a page of zero is empty`);
    assert.deepEqual(await store.eventKinds(), ["ready", "requested"], `${name}: the kinds, sorted`);

    // Meta: a missing key falls back, a written one is read back, and a write replaces.
    assert.equal(await store.getMeta("ticket_draft:1", "none"), "none", `${name}: the fallback`);
    await store.setMeta("ticket_draft:1", { steps: "flush the cache" });
    assert.deepEqual(
      await store.getMeta("ticket_draft:1"),
      { steps: "flush the cache" },
      `${name}: meta round-trips`,
    );
    await store.setMeta("ticket_draft:1", { steps: "and restart" });
    assert.deepEqual(await store.getMeta("ticket_draft:1"), { steps: "and restart" }, `${name}: upsert`);

    // The ticket: a marked write-up is a row, and it round-trips whole — the marks, the
    // feedback the student saw, and the answers they typed.
    const marked = ticketGrade(created.id ?? 0);
    await store.saveTicket(marked, "ada");
    const latest = await store.latestTicket(created.id ?? 0);
    assert.equal(latest?.score, 100, `${name}: the write-up score is stored`);
    assert.equal(latest?.outcomes.length, 2, `${name}: every field's outcome is stored`);
    assert.equal(latest?.outcomes[1]?.fieldId, "class", `${name}: and which field it was`);
    assert.equal(
      latest?.values.cause,
      "the dns resolver address was set by hand",
      `${name}: the answers are stored with the grade`,
    );
    assert.deepEqual(
      await store.ticketValues(created.id ?? 0),
      latest?.values,
      `${name}: and are readable on their own`,
    );
    assert.equal((await store.ticketsForSession(created.id ?? 0)).length, 1, `${name}: one attempt`);
    assert.equal((await store.ticketsForStudent("ada")).length, 1, `${name}: one for ada`);
    assert.deepEqual(await store.ticketsForStudent("grace"), [], `${name}: none for grace`);

    // The admin list: the facts a table draws, and not the whole grade.
    const ticketRows = await store.listTickets();
    assert.equal(ticketRows.length, 1, `${name}: the admin list sees it`);
    assert.equal(ticketRows[0]?.student, "ada", `${name}: with its author`);
    assert.equal(ticketRows[0]?.sessionId, created.id, `${name}: and the session it belongs to`);
    assert.equal(ticketRows[0]?.submitted, true, `${name}: and that it was handed in`);
    assert.deepEqual(await store.listTickets(0), [], `${name}: a page of zero is empty`);
    assert.deepEqual(
      await store.countTickets(),
      { count: 1, average: 100, submitted: 1 },
      `${name}: the statistics`,
    );

    // A draft is not a grade: it lives in meta and never becomes a ticket row.
    await store.saveTicketDraft(created.id ?? 0, { cause: "half a thought" });
    assert.deepEqual(
      await store.ticketDraft(created.id ?? 0),
      { cause: "half a thought" },
      `${name}: the draft round-trips`,
    );
    assert.equal((await store.listTickets()).length, 1, `${name}: and is not a marked ticket`);
    await store.clearTicketDraft(created.id ?? 0);
    assert.deepEqual(await store.ticketDraft(created.id ?? 0), {}, `${name}: clearing forgets it`);
  }
});

/* -------------------------------------------------------------------------- */
/*  Refusals and edge cases                                                   */
/* -------------------------------------------------------------------------- */

test("store-prisma: a session without an id, or without a row, cannot be saved", async () => {
  const store = new PrismaLabStore(new FakeLabDb());
  await assert.rejects(
    () => store.saveSession(newLabSession({ student: "ada", scenarioId: "net-dns-failure" })),
    /saveSession needs a session with an id/,
  );

  const orphan = populatedSession("ada", 9);
  orphan.id = 404;
  await assert.rejects(() => store.saveSession(orphan), /no session 404 to save/);
});

test("store-prisma: listing takes the newest N, orders both ways, and filters by state", async () => {
  const store = new PrismaLabStore(new FakeLabDb());
  const first = await store.createSession(newLabSession({ student: "ada", scenarioId: "a" }));
  const second = await store.createSession(newLabSession({ student: "ada", scenarioId: "b" }));
  const third = await store.createSession(newLabSession({ student: "grace", scenarioId: "c" }));
  second.state = "ready";
  await store.saveSession(second);

  assert.deepEqual(
    (await store.listSessions()).map((session) => session.id),
    [third.id, second.id, first.id],
    "newest first by default — the lab's own reader order",
  );
  assert.deepEqual(
    (await store.listSessions({ order: "oldest" })).map((session) => session.id),
    [first.id, second.id, third.id],
  );
  assert.deepEqual(
    (await store.listSessions({ limit: 2 })).map((session) => session.id),
    [third.id, second.id],
    "`limit` selects the newest two, not the oldest two",
  );
  assert.deepEqual(await store.listSessions({ limit: 0 }), [], "a page of zero is empty");
  assert.deepEqual(
    (await store.listSessions({ student: "ada" })).map((session) => session.id),
    [second.id, first.id],
  );
  assert.deepEqual(
    (await store.listSessions({ states: ["ready"] })).map((session) => session.id),
    [second.id],
  );
  assert.equal(await store.countSessions(), 3);
  assert.equal(await store.countSessions(["ready"]), 1);
});

test("store-prisma: the live filter is the model's own idea of live", async () => {
  assert.equal(liveStatesMatch(), true, "LIVE_STATES and isLive must agree");

  const store = new PrismaLabStore(new FakeLabDb());
  for (const state of ALL_STATES) {
    const session = await store.createSession(newLabSession({ student: state, scenarioId: "x" }));
    session.state = state;
    await store.saveSession(session);
  }
  const live = (await store.listSessions({ live: true })).map((session) => session.state).sort();
  assert.deepEqual(
    live,
    [...LIVE_STATES].sort(),
    "a state a student could still be handed is exactly what the list returns",
  );
  assert.equal(
    (await store.liveSessionsFor("ready")).length,
    1,
    "one student's live sessions are theirs alone",
  );
});

test("store-prisma: the state vocabulary maps to the column and back", () => {
  for (const state of ALL_STATES) {
    assert.equal(stateFromDb(stateToDb(state)), state, `${state} survives the round trip`);
  }
  assert.equal(stateToDb("in_use"), "IN_USE", "the column is the enum's spelling");
  assert.throws(
    () => stateFromDb("readyy"),
    /is not a state this port knows/,
    "a state from a newer schema is loud, not guessed",
  );
});

test("store-prisma: the timestamp conversions treat \"\" as absence", () => {
  assert.equal(dateToIso(null), "");
  assert.equal(dateToIso(new Date("2026-10-09T09:00:00.000Z")), "2026-10-09T09:00:00.000Z");
  assert.equal(nullableIsoToDate(""), null);
  assert.equal(nullableIsoToDate("rubbish"), null);
  assert.equal(
    nullableIsoToDate("2026-10-09T09:00:00.500Z")?.toISOString(),
    "2026-10-09T09:00:00.500Z",
    "milliseconds survive, which is why the column is timestamp(3)",
  );
});

test("store-prisma: a report written before the ticket blend still has a machine score", async () => {
  // The lab's `from_dict` falls back from `machine_score` to `score`; without that, every
  // result stored before tickets existed would read back as a zero.
  const db = new FakeLabDb();
  const store = new PrismaLabStore(db);
  const session = await store.createSession(newLabSession({ student: "ada", scenarioId: "x" }));
  db.results.push({
    id: 1,
    sessionId: session.id ?? 0,
    student: "ada",
    scenarioId: "x",
    score: 90,
    resolved: true,
    report: { session_id: session.id, scenario_id: "x", score: 90, resolved: true },
    createdAt: new Date(),
  });
  const report = await store.latestReport(session.id ?? 0);
  assert.equal(report?.machineScore, 90, "the machine half falls back to the score");
  assert.equal(report?.ticketScore, null, "and no write-up is not a zero write-up");
  assert.deepEqual(report?.outcomes, [], "a report with no outcomes is empty, not an error");
});

test("store-prisma: a result cannot name a session that does not exist", async () => {
  const store = new PrismaLabStore(new FakeLabDb());
  await assert.rejects(
    () => store.addResult(fullReport(1234), "ada"),
    /foreign key/,
    "the migration's key is the thing that keeps results attached to a session",
  );
});

test("store-prisma: a ticket cannot name a session that does not exist either", async () => {
  const store = new PrismaLabStore(new FakeLabDb());
  await assert.rejects(
    () => store.saveTicket(ticketGrade(1234), "ada"),
    /foreign key/,
    "a write-up belongs to a session, and the migration is what enforces it",
  );
});

/* -------------------------------------------------------------------------- */
/*  The real database                                                         */
/* -------------------------------------------------------------------------- */

/** Connect, or return null so the test can skip cleanly. */
async function connect(): Promise<PrismaClient | null> {
  const db = new PrismaClient();
  try {
    await db.$queryRaw`SELECT 1`;
    return db;
  } catch {
    await db.$disconnect().catch(() => undefined);
    return null;
  }
}

/** Whether this database has been migrated to the lab runtime. */
async function hasLabTables(db: PrismaClient): Promise<boolean> {
  try {
    await db.$queryRaw`SELECT 1 FROM "LabSession" LIMIT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * The store against a real Postgres.
 *
 * This is the only test that can prove the things the fake cannot: that the migration's
 * tables, enum, `timestamp(3)` columns and foreign keys are the shape this file assumes.
 * It writes only rows belonging to a unique student key of its own and removes them in
 * `finally`, so it never touches a deployment's seeded data.
 */
test("postgres: the lab store round-trips a session, a result, a write-up and its events", async (t) => {
  const db = await connect();
  if (db === null) {
    t.skip("no Postgres reachable — set DATABASE_URL and run npm run db:deploy");
    return;
  }
  if (!(await hasLabTables(db))) {
    await db.$disconnect();
    t.skip("the database has no lab tables — run npm run db:deploy for 20261109000000_add_lab_runtime");
    return;
  }

  const student = `itest-lab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const metaKey = `ticket_draft:${student}`;
  const store = new PrismaLabStore(db as unknown as LabPrismaClient);
  let sessionId = 0;

  try {
    const created = await store.createSession(populatedSession(student, 1));
    sessionId = created.id ?? 0;
    assert.ok(sessionId > 0, "the sequence assigned an id");

    // Read it back with nothing lost on the way through timestamp(3).
    const reloaded = await store.getSession(sessionId);
    assert.equal(reloaded?.state, "passed", "the state survived the enum");
    assert.equal(reloaded?.readyAt, "2026-10-09T09:01:30.500Z", "milliseconds survived");
    assert.equal(reloaded?.completedAt, "2026-10-09T09:31:00.000Z", "the submission moment survived");
    assert.equal(reloaded?.expiresAt, "2026-10-09T09:45:00.000Z");
    assert.equal(reloaded?.bestScore, 87.5);
    assert.equal(reloaded?.rdpPassword, "TrainMe-1", "the console credential is stored with the row");
    assert.equal(reloaded?.lastReport, null, "a loaded session carries no report of its own");

    // A real update, and the two facts that keep a second submit out.
    const edited = { ...(reloaded as LabSession), state: "destroyed" as SessionState };
    await store.saveSession(edited);
    assert.equal((await store.getSession(sessionId))?.state, "destroyed");
    await assert.rejects(() => store.saveSession({ ...edited, id: 2_000_000_000 }), /no session/);

    // The report goes into JSONB and comes back with its outcomes and both halves.
    await store.addResult(fullReport(sessionId), student);
    const report = await store.latestReport(sessionId);
    assert.equal(report?.score, 87.5);
    assert.deepEqual(report?.notes, [
      "final submission judged against DNS failure",
      "the write-up was not blended",
    ]);
    assert.equal(report?.outcomes[1]?.detail, "still broken", "outcome detail survives JSONB");
    assert.equal(report?.ticketOutcomes.length, 1);
    assert.equal(await store.attemptCounts(sessionId), 1);
    assert.equal((await store.resultsForStudent(student)).length, 1);

    // The write-up: JSONB in, the lab's own shape out, and the answers beside it.
    await store.saveTicket(ticketGrade(sessionId), student);
    const storedTicket = await store.latestTicket(sessionId);
    assert.equal(storedTicket?.score, 100, "the marked write-up survives JSONB");
    assert.equal(storedTicket?.outcomes[1]?.fieldId, "class", "its outcomes come back whole");
    assert.equal(
      storedTicket?.values.cause,
      "the dns resolver address was set by hand",
      "and so do the answers the student typed",
    );
    assert.equal((await store.ticketsForSession(sessionId)).length, 1);
    assert.equal((await store.countTickets()).submitted, 1);
    await store.saveTicketDraft(sessionId, { cause: "still typing" });
    assert.deepEqual(await store.ticketDraft(sessionId), { cause: "still typing" });
    await store.clearTicketDraft(sessionId);
    assert.deepEqual(await store.ticketDraft(sessionId), {}, "clearing a draft forgets it");

    // Events, newest first, scoped to this session.
    await store.logEvent("requested", "asked for a machine", sessionId);
    await store.logEvent("ready", "running", sessionId);
    assert.deepEqual(
      (await store.eventsFor(sessionId, 10)).map((event) => event.kind),
      ["ready", "requested"],
      "the audit trail reads newest first, as the lab reads it",
    );
    assert.equal((await store.recentEvents(1)).length, 1, "the newest one, and only one");

    // Meta, in the lab's own namespace.
    await store.setMeta(metaKey, { steps: "flush the cache" });
    assert.deepEqual(await store.getMeta(metaKey), { steps: "flush the cache" });
    await store.setMeta(metaKey, { steps: "and restart" });
    assert.deepEqual(await store.getMeta(metaKey), { steps: "and restart" }, "upsert replaces");
    assert.equal(await store.getMeta(`${metaKey}:missing`, "none"), "none");

    // The two `ON DELETE` clauses the migration chose, checked against a second session:
    // results go with their session, and its events stay behind naming no session — the
    // ones an operator needs after a botched teardown are exactly those.
    const doomed = await store.createSession(populatedSession(student, 2));
    await store.addResult(fullReport(doomed.id ?? 0), student);
    await store.saveTicket(ticketGrade(doomed.id ?? 0), student);
    await store.logEvent("destroy_failed", "the instance would not stop", doomed.id ?? 0);
    await db.labSession.delete({ where: { id: doomed.id ?? 0 } });
    assert.equal(await store.attemptCounts(doomed.id ?? 0), 0, "the results went with the session");
    assert.equal(
      (await store.ticketsForSession(doomed.id ?? 0)).length,
      0,
      "and so did the write-up it was handed with",
    );
    const orphaned = await db.labEvent.findMany({
      where: { kind: "destroy_failed", detail: "the instance would not stop" },
    });
    assert.equal(orphaned.length, 1, "the event survived");
    assert.equal(orphaned[0]?.sessionId, null, "and is left naming no session");
    await db.labEvent.deleteMany({ where: { id: { in: orphaned.map((row) => row.id) } } });
  } finally {
    // Ordered so the foreign keys are satisfied whatever the test did before it failed.
    await db.labTicket.deleteMany({ where: { student } });
    await db.labResult.deleteMany({ where: { student } });
    await db.labEvent.deleteMany({ where: { sessionId } });
    await db.labSession.deleteMany({ where: { student } });
    await db.labMeta.deleteMany({ where: { key: metaKey } });
    await db.$disconnect();
  }
});
