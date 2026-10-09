/**
 * What the lab keeps between requests, and the one implementation that needs no
 * database.
 *
 * The TypeScript half of OnTrak-dev's `ontrak/store.py`, with one deliberate
 * difference of shape. The Python class **is** a SQLite database: 709 lines that open
 * a file, create six tables, run their own migrations and hand back `sqlite3.Row`s.
 * This port keeps the *contract* and replaces the engine, because the plan's C3 says a
 * lab host uses the database the family already runs rather than a second one beside
 * it — so `LabStore` is an interface, `InMemoryLabStore` below is the reference
 * implementation used by the tests and the demo, and the Postgres/Prisma one is stage
 * 2d.
 *
 * Three decisions worth stating, because each one is a place a port goes wrong.
 *
 * **It is async, and the callers know it.** A `pg`/Prisma implementation cannot be
 * synchronous, and pretending otherwise would make every call site wrong the day it
 * arrives. The in-memory store pays the same signature cost so nothing has to change
 * when the real one lands — the same choice the Incus client made (§3/C4).
 *
 * **Ids are assigned by the store, so nothing else invents one.** SQLite's
 * AUTOINCREMENT played that part; here `createSession` returns the saved session with
 * its id set, and `saveSession` refuses a session that has none. That is the rule the
 * Python relied on implicitly, and making it explicit is what stops two halves of the
 * app from disagreeing about which session a result belongs to.
 *
 * **The event log is append-only, and its readers return the newest first.** It is the
 * lab's audit trail — a template failed, a session was prewarmed, a time limit was
 * raised — and the Python reads it with `ORDER BY id DESC LIMIT ?`, so its own suite
 * asserts `["checked", "ready"]` for two events logged in the other order. Newest-first
 * is therefore the contract, not a preference: an admin page that showed the trail
 * backwards would be the first symptom of a store that had drifted. Nothing here
 * updates or deletes an event, and having no such verb is what keeps that true.
 *
 * Rows carry the lab's own vocabulary (`kind`, `detail`, `session_id`), because the
 * admin panel, the CLI's JSON and the CSV export all read those keys (§2's convention).
 */

import { type LabSession, type ScoreReport, type SessionState, isLive } from "./models";

/** One audit-trail entry. Append-only: nothing here is ever updated or removed. */
export interface LabEvent {
  readonly id: number;
  readonly kind: string;
  readonly detail: string;
  readonly sessionId: number | null;
  readonly createdAt: string;
}

/** How a caller asks for sessions. Every field is a narrowing, never a widening. */
export interface SessionQuery {
  /** One student's own sessions. */
  student?: string;
  /** Only these states. */
  states?: readonly SessionState[];
  /** Only states a student could still be handed (see `isLive`). */
  live?: boolean;
  /** Newest first by default, which is what every reader in the lab wants. */
  order?: "newest" | "oldest";
  limit?: number;
}

/**
 * The lab's persistence, as its callers use it.
 *
 * Scoped to the half the session manager and the demo need: sessions, results, events
 * and the small meta table. The lab's `users` and `tickets` tables are **not** here on
 * purpose — the user table is superseded by the app's identity (§3/C2) and tickets are
 * stage 3's, so declaring them now would be declaring a shape nobody has agreed to.
 */
export interface LabStore {
  /** Save a new session and return it with the id the store assigned. */
  createSession(session: LabSession): Promise<LabSession>;
  getSession(id: number): Promise<LabSession | null>;
  /** Persist a session that has an id. A session without one is a caller bug, not a row. */
  saveSession(session: LabSession): Promise<void>;
  listSessions(query?: SessionQuery): Promise<LabSession[]>;
  /** The sessions that block a student from starting another one. */
  liveSessionsFor(student: string): Promise<LabSession[]>;
  countSessions(states?: readonly SessionState[]): Promise<number>;

  /** One graded attempt. `student` is stored with it so a results page needs no join. */
  addResult(report: ScoreReport, student: string): Promise<void>;
  latestReport(sessionId: number): Promise<ScoreReport | null>;
  resultsForStudent(student: string): Promise<ScoreReport[]>;
  /** How many graded attempts a session has had — the lab's "attempt 2 of 3" fact. */
  attemptCounts(sessionId: number): Promise<number>;

  logEvent(kind: string, detail?: string, sessionId?: number | null): Promise<void>;
  eventsFor(sessionId: number, limit?: number): Promise<LabEvent[]>;
  recentEvents(limit?: number): Promise<LabEvent[]>;
  countEvents(): Promise<number>;

  getMeta(key: string, fallback?: unknown): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
}

/** One stored result: the report plus the facts a results list shows beside it. */
export interface StoredResult {
  readonly student: string;
  readonly report: ScoreReport;
}

/**
 * The reference implementation: everything in memory, nothing on disk.
 *
 * It exists for the reasons `memory.py` exists — the demo flow and the tests have to
 * run a whole class with no database, and a fake that is *easier* than the real thing
 * is how a port quietly loses its rules. So it is a real implementation: ids are
 * assigned in order, sessions are deep-copied in and out (a caller that mutates what it
 * got back cannot change what is stored, which is what a database does for free),
 * `listSessions` orders and limits the way the SQL did, and the event log appends.
 *
 * Deliberately *not* a cache with a database behind it: stage 2d's Prisma store
 * implements the same interface, and nothing else in the port may care which one it
 * holds.
 */
export class InMemoryLabStore implements LabStore {
  private readonly sessions = new Map<number, LabSession>();
  private readonly results: StoredResult[] = [];
  private readonly events: LabEvent[] = [];
  private readonly meta = new Map<string, unknown>();
  private nextSessionId = 1;
  private nextEventId = 1;
  /** Injected so a test can pin an instant; the store never reads the clock itself. */
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** The session as stored, copied in both directions so callers cannot alias it. */
  private copy(session: LabSession): LabSession {
    return {
      ...session,
      lastReport: session.lastReport === null ? null : { ...session.lastReport },
    };
  }

  async createSession(session: LabSession): Promise<LabSession> {
    const id = this.nextSessionId++;
    const stored = this.copy({ ...session, id });
    this.sessions.set(id, stored);
    return this.copy(stored);
  }

  async getSession(id: number): Promise<LabSession | null> {
    const found = this.sessions.get(id);
    return found ? this.copy(found) : null;
  }

  async saveSession(session: LabSession): Promise<void> {
    if (session.id === null) {
      throw new Error("saveSession needs a session with an id; use createSession for a new one");
    }
    if (!this.sessions.has(session.id)) {
      throw new Error(`no session ${session.id} to save`);
    }
    this.sessions.set(session.id, this.copy(session));
  }

  async listSessions(query: SessionQuery = {}): Promise<LabSession[]> {
    let rows = [...this.sessions.values()];
    if (query.student !== undefined) {
      rows = rows.filter((session) => session.student === query.student);
    }
    if (query.states !== undefined) {
      const wanted = new Set(query.states);
      rows = rows.filter((session) => wanted.has(session.state));
    }
    if (query.live === true) {
      rows = rows.filter((session) => isLive(session.state));
    }
    rows.sort((left, right) =>
      query.order === "oldest" ? (left.id ?? 0) - (right.id ?? 0) : (right.id ?? 0) - (left.id ?? 0),
    );
    if (query.limit !== undefined) rows = rows.slice(0, Math.max(0, query.limit));
    return rows.map((session) => this.copy(session));
  }

  async liveSessionsFor(student: string): Promise<LabSession[]> {
    return this.listSessions({ student, live: true });
  }

  async countSessions(states?: readonly SessionState[]): Promise<number> {
    if (states === undefined) return this.sessions.size;
    const wanted = new Set(states);
    return [...this.sessions.values()].filter((session) => wanted.has(session.state)).length;
  }

  async addResult(report: ScoreReport, student: string): Promise<void> {
    // Copied in, so a caller that keeps grading into the same object cannot rewrite
    // history — the one guarantee a stored report has to have.
    this.results.push({ student, report: { ...report, outcomes: report.outcomes.map((o) => ({ ...o })) } });
  }

  async latestReport(sessionId: number): Promise<ScoreReport | null> {
    for (let index = this.results.length - 1; index >= 0; index -= 1) {
      const stored = this.results[index];
      if (stored && stored.report.sessionId === sessionId) return { ...stored.report };
    }
    return null;
  }

  async resultsForStudent(student: string): Promise<ScoreReport[]> {
    return this.results
      .filter((stored) => stored.student === student)
      .map((stored) => ({ ...stored.report }));
  }

  async attemptCounts(sessionId: number): Promise<number> {
    return this.results.filter((stored) => stored.report.sessionId === sessionId).length;
  }

  async logEvent(kind: string, detail = "", sessionId: number | null = null): Promise<void> {
    this.events.push({
      id: this.nextEventId++,
      kind,
      detail,
      sessionId,
      createdAt: this.now().toISOString(),
    });
  }

  // Newest first, because that is what `ORDER BY id DESC LIMIT ?` returned and what the
  // lab's own tests assert. The `limit` selects the newest N and then the order is
  // reversed — doing it the other way round would return the *oldest* N of the newest.
  //
  // `limit <= 0` is handled before the slice, and it has to be: `slice(-0)` is
  // `slice(0)`, which returns the WHOLE array, so a caller asking for zero events would
  // have been handed every event ever logged. `LIMIT 0` in the SQL returned nothing.
  async eventsFor(sessionId: number, limit = 50): Promise<LabEvent[]> {
    if (limit <= 0) return [];
    return this.events
      .filter((event) => event.sessionId === sessionId)
      .slice(-limit)
      .reverse()
      .map((event) => ({ ...event }));
  }

  async recentEvents(limit = 100): Promise<LabEvent[]> {
    if (limit <= 0) return [];
    return this.events
      .slice(-limit)
      .reverse()
      .map((event) => ({ ...event }));
  }

  async countEvents(): Promise<number> {
    return this.events.length;
  }

  async getMeta(key: string, fallback: unknown = null): Promise<unknown> {
    return this.meta.has(key) ? this.meta.get(key) : fallback;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    this.meta.set(key, value);
  }
}
