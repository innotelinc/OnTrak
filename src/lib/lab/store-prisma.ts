/**
 * The lab's persistence on the database this deployment already runs (docs/lab-port.md
 * §3/C3).
 *
 * `store.ts` is the contract and the in-memory reference implementation; this is the one
 * a real installation uses. The Python shipped a SQLite file per lab host and migrated it
 * by hand; a port that did the same would give a deployment two databases, two backup
 * stories and two ways to lose a student's results — so the tables live in the app's
 * database (see `prisma/schema.prisma`, `LabSession`/`LabResult`/`LabEvent`/`LabMeta`) and
 * a student's lab work sits beside the attempts it belongs to.
 *
 * Three choices, each of which is a place this kind of adapter normally goes wrong.
 *
 * **The client is described structurally, not imported.** `LabPrismaClient` names the four
 * delegates and the handful of methods used. That keeps this file free of a generated
 * client, so the conversions below are unit-tested against a fake with no database, and
 * the one call site that owns a real `PrismaClient` does the cast — the same split
 * `ontrak-tix` uses for its own Prisma adapters.
 *
 * **Timestamps cross the boundary in one place.** The domain speaks ISO strings (a session
 * survives a JSON round-trip and a `sessionToDict` export unchanged) and Postgres speaks
 * `timestamp(3)`. Every conversion is a named function with the empty-string case spelled
 * out, because "" means "no such moment" for `readyAt`/`expiresAt`/`completedAt` and must
 * become NULL, not 1970.
 *
 * **A stored report is read back through the lab's own coercion.** `reportToDict`/
 * `reportFromDict` are the Python's `to_dict`/`from_dict`, field by field, so a JSONB
 * column written by an older version degrades one field at a time instead of throwing
 * where a results page is being rendered — and a report this port stores is one the lab's
 * own tools can read.
 */

import {
  type LabSession,
  type ScoreReport,
  type SessionState,
  isLive,
  parseIso,
  reportFromDict,
  reportToDict,
} from "./models";
import {
  draftFrom,
  ticketDraftKey,
  type EventQuery,
  type LabEvent,
  type LabStore,
  type LabTicketRow,
  type SessionQuery,
} from "./store";
import { roundHalfEven } from "./scoring";
import { ticketGradeFromDict, ticketGradeToDict, type TicketGrade } from "./tickets";

/* -------------------------------------------------------------------------- */
/*  Row shapes                                                                */
/* -------------------------------------------------------------------------- */

/** A `LabSession` row as Prisma returns it. Prisma hands back `Date` objects. */
export interface LabSessionRow {
  id: number;
  student: string;
  scenarioId: string;
  state: string;
  instance: string;
  hostIp: string;
  rdpUser: string;
  rdpPassword: string;
  hintLevel: number;
  checksRun: number;
  bestScore: number;
  resolved: boolean;
  notes: string;
  error: string;
  workload: string;
  timeLimitMinutes: number;
  createdAt: Date;
  readyAt: Date | null;
  expiresAt: Date | null;
  lastActivityAt: Date;
  completedAt: Date | null;
}

/** A `LabResult` row. `report` is the stored JSONB, coerced on the way out. */
export interface LabResultRow {
  id: number;
  sessionId: number;
  student: string;
  scenarioId: string;
  score: number;
  resolved: boolean;
  report: unknown;
  createdAt: Date;
}

export interface LabEventRow {
  id: number;
  kind: string;
  detail: string;
  sessionId: number | null;
  createdAt: Date;
}

/**
 * A `LabTicket` row as Prisma returns it.
 *
 * Named `…DbRow` rather than `LabTicketRow` because the store's contract has a
 * `LabTicketRow` of its own: that one is the trimmed view a list page draws, and this one
 * is the whole table row. Two shapes with one name is how a list ends up loading every
 * answer and every outcome it will not render.
 */
export interface LabTicketDbRow {
  id: number;
  sessionId: number;
  student: string;
  scenarioId: string;
  grade: unknown;
  values: unknown;
  score: number;
  submitted: boolean;
  createdAt: Date;
}

export interface LabMetaRow {
  key: string;
  value: unknown;
  updatedAt: Date;
}

/**
 * The Prisma surface this store needs, described rather than imported.
 *
 * Arguments are typed `unknown` on purpose: the real delegates take generated
 * `Prisma.*Args` types that no test should have to reproduce, and this store's contract is
 * the `where`/`orderBy`/`take`/`data` subset it actually passes.
 */
export interface LabPrismaClient {
  labSession: {
    create(args: { data: unknown }): Promise<LabSessionRow>;
    findUnique(args: { where: { id: number } }): Promise<LabSessionRow | null>;
    findMany(args: unknown): Promise<LabSessionRow[]>;
    updateMany(args: { where: { id: number }; data: unknown }): Promise<{ count: number }>;
    count(args?: unknown): Promise<number>;
  };
  labResult: {
    create(args: { data: unknown }): Promise<LabResultRow>;
    findFirst(args: unknown): Promise<LabResultRow | null>;
    findMany(args: unknown): Promise<LabResultRow[]>;
    count(args?: unknown): Promise<number>;
  };
  labEvent: {
    create(args: { data: unknown }): Promise<LabEventRow>;
    findMany(args: unknown): Promise<LabEventRow[]>;
    count(args?: unknown): Promise<number>;
  };
  labTicket: {
    create(args: { data: unknown }): Promise<LabTicketDbRow>;
    findFirst(args: unknown): Promise<LabTicketDbRow | null>;
    findMany(args: unknown): Promise<LabTicketDbRow[]>;
    count(args?: unknown): Promise<number>;
    /**
     * The ticket statistics, as one query rather than a scan of every row.
     *
     * COUNT and AVG, which is what the Python's `count_tickets` asked SQLite for; the
     * submitted half is a `count({ where: { submitted: true } })` because Prisma will not
     * SUM a boolean the way SQLite summed an INTEGER column.
     */
    aggregate(args: unknown): Promise<{ _count: number; _avg: { score: number | null } }>;
  };
  labMeta: {
    findUnique(args: { where: { key: string } }): Promise<LabMetaRow | null>;
    upsert(args: { where: { key: string }; create: unknown; update: unknown }): Promise<LabMetaRow>;
  };
}

/* -------------------------------------------------------------------------- */
/*  Conversions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The port's states and the database's enum differ only in case, and the mapping is
 * explicit rather than a `toUpperCase()`: an enum value added to the schema and forgotten
 * here has to be a type error, not a runtime surprise in the middle of a sweep.
 */
const STATE_TO_DB: Record<SessionState, string> = {
  requested: "REQUESTED",
  allocating: "ALLOCATING",
  provisioning: "PROVISIONING",
  ready: "READY",
  in_use: "IN_USE",
  checking: "CHECKING",
  passed: "PASSED",
  failed: "FAILED",
  recycling: "RECYCLING",
  destroyed: "DESTROYED",
  error: "ERROR",
};

const DB_TO_STATE: Record<string, SessionState> = Object.fromEntries(
  Object.entries(STATE_TO_DB).map(([state, stored]) => [stored, state as SessionState]),
);

export function stateToDb(state: SessionState): string {
  return STATE_TO_DB[state];
}

/**
 * A state read back from the column.
 *
 * A value the port does not know means the enum and this file have diverged — an operator
 * added a state, or a row was hand-edited — and the honest failure is to say so rather
 * than to guess a state, because every guess would be a session the sweeps then treat as
 * something it is not.
 */
export function stateFromDb(value: string): SessionState {
  const state = DB_TO_STATE[value];
  if (state === undefined) {
    throw new Error(
      `LabSession.state ${JSON.stringify(value)} is not a state this port knows; ` +
        "the enum and src/lib/lab/store-prisma.ts have diverged",
    );
  }
  return state;
}

/** A moment as the domain carries it: an ISO string, or "" for "never". */
export function dateToIso(value: Date | null): string {
  return value === null ? "" : value.toISOString();
}

/** A moment the column allows to be absent. "" and an unparseable value both mean absent. */
export function nullableIsoToDate(value: string): Date | null {
  if (value === "") return null;
  return parseIso(value);
}

/**
 * A moment the column requires.
 *
 * `createdAt` and `lastActivityAt` cannot be absent in the schema — every session has both
 * by construction — so an empty string here is a caller that built a `LabSession` by hand
 * and left the default in place. Substituting the current time rather than failing keeps
 * the row writable; the alternative (a NOT NULL error from Postgres) would surface at the
 * point of saving instead of where the session was assembled.
 */
export function requiredIsoToDate(value: string, now: Date = new Date()): Date {
  return parseIso(value) ?? now;
}

/** The session as a row: the domain's ISO strings to columns, `lastReport` left out. */
export function toSessionData(session: LabSession): Record<string, unknown> {
  return {
    student: session.student,
    scenarioId: session.scenarioId,
    state: stateToDb(session.state),
    instance: session.instance,
    hostIp: session.hostIp,
    rdpUser: session.rdpUser,
    rdpPassword: session.rdpPassword,
    hintLevel: session.hintLevel,
    checksRun: session.checksRun,
    bestScore: session.bestScore,
    resolved: session.resolved,
    notes: session.notes,
    error: session.error,
    workload: session.workload,
    timeLimitMinutes: session.timeLimitMinutes,
    createdAt: requiredIsoToDate(session.createdAt),
    readyAt: nullableIsoToDate(session.readyAt),
    expiresAt: nullableIsoToDate(session.expiresAt),
    lastActivityAt: requiredIsoToDate(session.lastActivityAt),
    completedAt: nullableIsoToDate(session.completedAt),
  };
}

/**
 * A row as the domain's session.
 *
 * `lastReport` comes back `null` and is not a column: the Python kept it as a transient
 * field too, and the report a caller wants is the one that was *stored* — `latestReport`
 * reads it, which also means a session loaded from the database cannot show a grade that
 * was never recorded.
 */
export function fromSessionRow(row: LabSessionRow): LabSession {
  return {
    id: row.id,
    student: row.student,
    scenarioId: row.scenarioId,
    state: stateFromDb(row.state),
    instance: row.instance,
    hostIp: row.hostIp,
    rdpUser: row.rdpUser,
    rdpPassword: row.rdpPassword,
    hintLevel: row.hintLevel,
    checksRun: row.checksRun,
    bestScore: row.bestScore,
    resolved: row.resolved,
    notes: row.notes,
    error: row.error,
    workload: row.workload,
    timeLimitMinutes: row.timeLimitMinutes,
    createdAt: dateToIso(row.createdAt),
    readyAt: dateToIso(row.readyAt),
    expiresAt: dateToIso(row.expiresAt),
    lastActivityAt: dateToIso(row.lastActivityAt),
    completedAt: dateToIso(row.completedAt),
    lastReport: null,
  };
}

export function fromEventRow(row: LabEventRow): LabEvent {
  return {
    id: row.id,
    kind: row.kind,
    detail: row.detail,
    sessionId: row.sessionId,
    createdAt: dateToIso(row.createdAt),
  };
}

export function fromResultRow(row: LabResultRow): ScoreReport {
  return reportFromDict(row.report);
}

/**
 * A ticket row as the domain's grade.
 *
 * Read through the lab's own `from_dict`, so a `grade` column written by an older version
 * (or by the lab's tools) degrades a field at a time instead of throwing where a student's
 * own words are being rendered — the same reason `fromResultRow` goes through
 * `reportFromDict`.
 */
export function fromTicketRow(row: LabTicketDbRow): TicketGrade {
  const grade = asJsonRecord(row.grade);
  return ticketGradeFromDict(grade);
}

/** `LabTicket.values`: the answers, as the form reads them back. */
export function valuesFromTicketRow(row: LabTicketDbRow): Record<string, string> {
  return draftFrom(row.values);
}

/** A JSONB column arrives as `unknown`; a value that is not a record reads as `{}`. */
function asJsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

export class PrismaLabStore implements LabStore {
  constructor(private readonly db: LabPrismaClient) {}

  async createSession(session: LabSession): Promise<LabSession> {
    const row = await this.db.labSession.create({ data: toSessionData(session) });
    return fromSessionRow(row);
  }

  async getSession(id: number): Promise<LabSession | null> {
    const row = await this.db.labSession.findUnique({ where: { id } });
    return row === null ? null : fromSessionRow(row);
  }

  /**
   * Persist a session that has an id.
   *
   * `updateMany` rather than `update` so a row that is not there is this store's own error
   * message instead of a generated Prisma one, and so the check is one statement rather
   * than a read followed by a write. The contract's rule stands: a session without an id is
   * a caller bug, not a row to invent.
   */
  async saveSession(session: LabSession): Promise<void> {
    if (session.id === null) {
      throw new Error("saveSession needs a session with an id; use createSession for a new one");
    }
    const result = await this.db.labSession.updateMany({
      where: { id: session.id },
      data: toSessionData(session),
    });
    if (result.count === 0) {
      throw new Error(`no session ${session.id} to save`);
    }
  }

  async listSessions(query: SessionQuery = {}): Promise<LabSession[]> {
    const where: Record<string, unknown> = {};
    if (query.student !== undefined) where.student = query.student;
    if (query.states !== undefined) where.state = { in: query.states.map(stateToDb) };
    if (query.live === true) where.state = { in: LIVE_STATES.map(stateToDb) };
    const rows = await this.db.labSession.findMany({
      where,
      // Newest first by default: the lab's readers order by `id DESC`, and `take` with
      // that order selects the newest N — which is the half a caller wants (a page of the
      // most recent sessions), not the oldest N of a reversed list.
      orderBy: { id: query.order === "oldest" ? "asc" : "desc" },
      ...(query.limit === undefined ? {} : { take: Math.max(0, query.limit) }),
    });
    return rows.map(fromSessionRow);
  }

  async liveSessionsFor(student: string): Promise<LabSession[]> {
    return await this.listSessions({ student, live: true });
  }

  async countSessions(states?: readonly SessionState[]): Promise<number> {
    if (states === undefined) return await this.db.labSession.count();
    return await this.db.labSession.count({ where: { state: { in: states.map(stateToDb) } } });
  }

  async addResult(report: ScoreReport, student: string): Promise<void> {
    await this.db.labResult.create({
      data: {
        sessionId: report.sessionId,
        student,
        scenarioId: report.scenarioId,
        score: report.score,
        resolved: report.resolved,
        report: reportToDict(report),
      },
    });
  }

  async latestReport(sessionId: number): Promise<ScoreReport | null> {
    const row = await this.db.labResult.findFirst({
      where: { sessionId },
      orderBy: { id: "desc" },
    });
    return row === null ? null : fromResultRow(row);
  }

  async resultsForStudent(student: string): Promise<ScoreReport[]> {
    const rows = await this.db.labResult.findMany({
      where: { student },
      orderBy: { id: "asc" },
    });
    return rows.map(fromResultRow);
  }

  async attemptCounts(sessionId: number): Promise<number> {
    return await this.db.labResult.count({ where: { sessionId } });
  }

  /* ---------------------------------------------------------------- */
  /*  the in-house ticket                                             */
  /* ---------------------------------------------------------------- */

  async saveTicket(grade: TicketGrade, student: string): Promise<void> {
    await this.db.labTicket.create({
      data: {
        sessionId: grade.sessionId,
        student,
        scenarioId: grade.scenarioId,
        grade: ticketGradeToDict(grade),
        // Stored beside the grade rather than derived from it: the session page shows the
        // student what they wrote, and a read of the answers should not have to unpack a
        // mark to find them.
        values: { ...grade.values },
        score: grade.score,
        submitted: grade.submitted,
      },
    });
  }

  async latestTicket(sessionId: number): Promise<TicketGrade | null> {
    const row = await this.db.labTicket.findFirst({
      where: { sessionId },
      orderBy: { id: "desc" },
    });
    return row === null ? null : fromTicketRow(row);
  }

  async ticketValues(sessionId: number): Promise<Record<string, string>> {
    const row = await this.db.labTicket.findFirst({
      where: { sessionId },
      orderBy: { id: "desc" },
    });
    return row === null ? {} : valuesFromTicketRow(row);
  }

  /**
   * A draft is a meta row, not a ticket row.
   *
   * That is the lab's own split and it is load-bearing: `LabTicket` means "a marked
   * submission", so a half-written write-up cannot appear in a marking record. The key is
   * the lab's (`ticket_draft:<sessionId>`), in the lab's own namespace in `LabMeta`.
   */
  async saveTicketDraft(sessionId: number, values: Record<string, string>): Promise<void> {
    await this.setMeta(ticketDraftKey(sessionId), { ...values });
  }

  async ticketDraft(sessionId: number): Promise<Record<string, string>> {
    return draftFrom(await this.getMeta(ticketDraftKey(sessionId), {}));
  }

  async clearTicketDraft(sessionId: number): Promise<void> {
    await this.setMeta(ticketDraftKey(sessionId), {});
  }

  async ticketsForSession(sessionId: number): Promise<TicketGrade[]> {
    const rows = await this.db.labTicket.findMany({
      where: { sessionId },
      orderBy: { id: "asc" },
    });
    return rows.map(fromTicketRow);
  }

  async ticketsForStudent(student: string, limit = 50): Promise<TicketGrade[]> {
    if (limit <= 0) return [];
    const rows = await this.db.labTicket.findMany({
      where: { student },
      orderBy: { id: "desc" },
      take: limit,
    });
    return rows.map(fromTicketRow);
  }

  async listTickets(limit = 200): Promise<LabTicketRow[]> {
    if (limit <= 0) return [];
    const rows = await this.db.labTicket.findMany({ orderBy: { id: "desc" }, take: limit });
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      student: row.student,
      scenarioId: row.scenarioId,
      score: row.score,
      submitted: row.submitted,
      createdAt: dateToIso(row.createdAt),
    }));
  }

  async countTickets(): Promise<{ count: number; average: number; submitted: number }> {
    const stats = await this.db.labTicket.aggregate({ _count: true, _avg: { score: true } });
    const submitted = await this.db.labTicket.count({ where: { submitted: true } });
    return {
      count: stats._count,
      // Rounded the way the Python rounded it (`round(avg, 1)`), so a stats page and the
      // lab that used to serve it agree about an average.
      average: roundHalfEven(stats._avg.score ?? 0, 1),
      submitted,
    };
  }

  async logEvent(kind: string, detail = "", sessionId: number | null = null): Promise<void> {
    await this.db.labEvent.create({ data: { kind, detail, sessionId } });
  }

  async eventsFor(sessionId: number, limit = 50): Promise<LabEvent[]> {
    // `take: 0` is an empty page, the same fact `LIMIT 0` was; the in-memory store had to
    // special-case it because `slice(-0)` returns everything, and this is the version of
    // that bug that cannot happen.
    if (limit <= 0) return [];
    const rows = await this.db.labEvent.findMany({
      where: { sessionId },
      orderBy: { id: "desc" },
      take: limit,
    });
    return rows.map(fromEventRow);
  }

  async recentEvents(limit = 100): Promise<LabEvent[]> {
    if (limit <= 0) return [];
    const rows = await this.db.labEvent.findMany({ orderBy: { id: "desc" }, take: limit });
    return rows.map(fromEventRow);
  }

  /** The audit trail, newest first, narrowed by kind — the same claim `recentEvents` makes. */
  async listEvents(query: EventQuery = {}): Promise<LabEvent[]> {
    const limit = query.limit ?? 300;
    if (limit <= 0) return [];
    const rows = await this.db.labEvent.findMany({
      where: query.kind ? { kind: query.kind } : undefined,
      orderBy: { id: "desc" },
      take: limit,
    });
    return rows.map(fromEventRow);
  }

  /**
   * Every distinct kind in the log, sorted.
   *
   * Prisma's `distinct` narrows *rows*, not fields, so each row still carries every
   * column and `kind` is read off the same row shape the other readers map.
   */
  async eventKinds(): Promise<string[]> {
    const rows = await this.db.labEvent.findMany({ distinct: ["kind"], orderBy: { kind: "asc" } });
    return rows.map((row) => row.kind);
  }

  async countEvents(): Promise<number> {
    return await this.db.labEvent.count();
  }

  async getMeta(key: string, fallback: unknown = null): Promise<unknown> {
    const row = await this.db.labMeta.findUnique({ where: { key } });
    return row === null ? fallback : row.value;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.db.labMeta.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
}

/**
 * The states a student could still be handed, as the store's `live` filter.
 *
 * Kept as the list the model's own `isLive` reads rather than derived from it, because a
 * `where` clause needs the set up front; `tests/lab-store-prisma.test.ts` asserts the two
 * agree, so a change to one that misses the other fails a test instead of quietly hiding a
 * live session from the guard that stops a student starting a second machine.
 */
export const LIVE_STATES: readonly SessionState[] = [
  "requested",
  "allocating",
  "provisioning",
  "ready",
  "in_use",
  "checking",
];

/** Whether `LIVE_STATES` and `isLive` still describe the same set. */
export function liveStatesMatch(): boolean {
  const all: SessionState[] = [
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
  return all.every((state) => LIVE_STATES.includes(state) === isLive(state));
}

/**
 * The lab's store over the app's Prisma client.
 *
 * The cast lives here rather than at every call site: the real client's delegate methods
 * take generated argument types, and `LabPrismaClient` describes the subset this store
 * uses. `ontrak-tix` makes the same allowance for its adapters.
 */
export function prismaLabStore(db: unknown): PrismaLabStore {
  return new PrismaLabStore(db as LabPrismaClient);
}
