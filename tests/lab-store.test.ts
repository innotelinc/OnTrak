/**
 * The lab store's contract, and the in-memory implementation that stands in for it.
 *
 * `src/lib/lab/store.ts` replaces OnTrak-dev's SQLite class with an interface plus one
 * reference implementation (plan §3/C3 — a lab host uses the database the family already
 * runs). That shape only works if the stand-in is a *real* implementation: the session
 * manager and the demo flow are tested against it, so a fake that is easier than the
 * real thing is how the port quietly loses the lab's rules. These tests therefore pin
 * the guarantees a database gives for free and a `Map` does not:
 *
 *   - ids are assigned by the store and nothing else invents one;
 *   - a caller is handed a **copy**, so mutating what it got back cannot rewrite what is
 *     stored (and grading on into a `ScoreReport` after storing it cannot rewrite
 *     history);
 *   - `listSessions` narrows, orders and limits the way the SQL did;
 *   - the event log only ever grows, and is stamped by an injected clock rather than by
 *     whatever time the machine happens to say.
 *
 * ── ORDERING IS THE LAB'S, AND PINNED ──────────────────────────────────────────
 * OnTrak-dev reads its audit trail with `ORDER BY id DESC LIMIT ?`, and its own suite
 * asserts it (`test_store.py`: `[e["kind"] for e in events] == ["checked", "ready"]`,
 * and `recent_events()[0]` is the last event logged). This suite originally exposed the
 * port returning insertion order instead — the divergence was real, and the store was
 * fixed rather than the assertion, because an audit trail read backwards is a bug an
 * operator would find before we did.
 *
 * What this file deliberately does NOT cover is listed at the end.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-store.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { newCheckOutcome, newLabSession, newScoreReport, type LabSession, type ScoreReport } from "../src/lib/lab/models";
import { InMemoryLabStore } from "../src/lib/lab/store";

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

function sessionFor(student = "alice", scenarioId = "net-dns-failure"): LabSession {
  return newLabSession({ student, scenarioId, state: "requested" });
}

/** A report for one session, the way the grader hands one over. */
function reportFor(sessionId: number, score: number, resolved: boolean): ScoreReport {
  return {
    ...newScoreReport({ sessionId, scenarioId: "net-dns-failure" }),
    score,
    resolved,
    outcomes: [newCheckOutcome({ objectiveId: "a", passed: resolved, weight: 10 })],
  };
}

const PINNED = new Date("2026-10-09T12:00:00.000Z");

/* -------------------------------------------------------------------------- */
/*  Sessions                                                                  */
/* -------------------------------------------------------------------------- */

test("store: a new session comes back with the id the store assigned, and it round-trips", async () => {
  const store = new InMemoryLabStore();

  const created = await store.createSession(sessionFor());
  assert.ok(created.id !== null && created.id > 0, "the store assigned an id");

  await store.saveSession({
    ...created,
    state: "ready",
    instance: "tpl-x",
    hostIp: "10.20.0.5",
  });

  const loaded = await store.getSession(created.id);
  assert.ok(loaded, "the session is there");
  assert.equal(loaded.state, "ready");
  assert.equal(loaded.instance, "tpl-x");
  assert.equal(loaded.hostIp, "10.20.0.5");

  // An id that was never handed out is nothing, not a row.
  assert.equal(await store.getSession(9999), null);
});

test("store: saving refuses a session with no id, and one the store never had", async () => {
  const store = new InMemoryLabStore();

  // Python's `update_session` needed an id; here the same mistake is refused by name
  // rather than silently inserting a second row.
  await assert.rejects(
    () => store.saveSession(sessionFor()),
    /needs a session with an id/,
  );

  const created = await store.createSession(sessionFor());
  await assert.rejects(
    () => store.saveSession({ ...created, id: 4242 }),
    /no session 4242 to save/,
  );
});

test("store: live sessions and counts follow the state machine", async () => {
  const store = new InMemoryLabStore();
  await store.createSession(sessionFor("alice"));
  const done = await store.createSession(sessionFor("bob"));
  assert.ok(done.id !== null);
  await store.saveSession({ ...done, state: "destroyed" });

  assert.deepEqual(
    (await store.liveSessionsFor("alice")).map((session) => session.student),
    ["alice"],
  );
  assert.deepEqual(await store.liveSessionsFor("bob"), [], "a destroyed machine blocks nobody");

  assert.equal(await store.countSessions(["requested"]), 1);
  assert.equal(await store.countSessions(["destroyed"]), 1);
  assert.equal(await store.countSessions(), 2, "no filter is every session");
});

test("store: listing narrows by student and state, orders newest first, and limits", async () => {
  const store = new InMemoryLabStore();
  const first = await store.createSession(sessionFor("alice"));
  const second = await store.createSession(sessionFor("bob"));
  const third = await store.createSession(sessionFor("alice"));
  assert.ok(first.id !== null && second.id !== null && third.id !== null);
  await store.saveSession({ ...second, state: "destroyed" });

  const ids = (rows: LabSession[]): (number | null)[] => rows.map((session) => session.id);

  assert.deepEqual(ids(await store.listSessions()), [third.id, second.id, first.id], "newest first");
  assert.deepEqual(ids(await store.listSessions({ order: "oldest" })), [first.id, second.id, third.id]);
  assert.deepEqual(ids(await store.listSessions({ limit: 2 })), [third.id, second.id]);

  assert.deepEqual(ids(await store.listSessions({ student: "alice" })), [third.id, first.id]);
  assert.deepEqual(ids(await store.listSessions({ states: ["destroyed"] })), [second.id]);
  assert.deepEqual(
    ids(await store.listSessions({ live: true })),
    [third.id, first.id],
    "a destroyed session is not live",
  );
  assert.deepEqual(await store.listSessions({ student: "nobody" }), []);
  assert.deepEqual(await store.listSessions({ limit: 0 }), [], "a limit of zero is zero rows, not all of them");
});

/* -------------------------------------------------------------------------- */
/*  Results                                                                   */
/* -------------------------------------------------------------------------- */

test("store: the newest report is the latest, and attempts are counted per session", async () => {
  const store = new InMemoryLabStore();
  const session = await store.createSession(sessionFor());
  assert.ok(session.id !== null);
  const other = await store.createSession(sessionFor("bob"));
  assert.ok(other.id !== null);

  for (const [score, resolved] of [[40, false], [90, true], [75, false]] as const) {
    await store.addResult(reportFor(session.id, score, resolved), session.student);
  }

  const latest = await store.latestReport(session.id);
  assert.ok(latest, "there is a report");
  assert.equal(latest.score, 75, "the last one stored wins, not the best one");
  assert.equal(await store.attemptCounts(session.id), 3);

  assert.equal(await store.latestReport(other.id), null, "a session with no attempt has no report");
  assert.equal(await store.attemptCounts(other.id), 0);

  assert.equal((await store.resultsForStudent("alice")).length, 3);
  assert.deepEqual(await store.resultsForStudent("carol"), []);
});

test("store: a stored report cannot be rewritten by grading on into the same object", async () => {
  const store = new InMemoryLabStore();
  const session = await store.createSession(sessionFor());
  assert.ok(session.id !== null);

  const report = reportFor(session.id, 90, true);
  await store.addResult(report, session.student);

  // A grader that keeps the same report object and mutates it — or a caller that
  // reuses one for the next attempt — must not be able to revise history.
  report.score = 0;
  report.resolved = false;
  report.outcomes.push(newCheckOutcome({ objectiveId: "b", passed: true, weight: 5 }));

  const stored = await store.latestReport(session.id);
  assert.ok(stored);
  assert.equal(stored.score, 90);
  assert.equal(stored.resolved, true);
  assert.equal(stored.outcomes.length, 1);
});

/* -------------------------------------------------------------------------- */
/*  Events                                                                    */
/* -------------------------------------------------------------------------- */

test("store: an event is stamped by the injected clock, and the log only grows", async () => {
  const store = new InMemoryLabStore({ now: () => PINNED });
  const session = await store.createSession(sessionFor());
  assert.ok(session.id !== null);

  await store.logEvent("ready", "first", session.id);
  await store.logEvent("checked", "second", session.id);
  await store.logEvent("prewarmed", "no session", null);

  const forSession = await store.eventsFor(session.id);
  assert.equal(forSession.length, 2, "one session's events only");
  assert.equal(forSession[0]?.createdAt, PINNED.toISOString(), "the instant is the clock's, not the machine's");
  // Newest first: "second" was logged after "first".
  assert.equal(forSession[0]?.detail, "second");

  // There is no updateEvent and no deleteEvent on the contract, on purpose: the log is
  // the lab's audit trail, so "append-only" is enforced by having no other verb.
  assert.equal(await store.countEvents(), 3);
  assert.equal((await store.eventsFor(session.id, 1)).length, 1, "the bound is honoured");
  assert.equal((await store.eventsFor(session.id, 0)).length, 0);
});

test("store: the readers return the newest first, as the lab's SQL does", async () => {
  // See the header. OnTrak-dev's `test_store.py` asserts exactly this:
  //   events_for(session) -> ["checked", "ready"]      (newest first)
  //   recent_events()[0]  -> the last event logged
  const store = new InMemoryLabStore();
  const session = await store.createSession(sessionFor());
  assert.ok(session.id !== null);

  await store.logEvent("ready", "first", session.id);
  await store.logEvent("checked", "second", session.id);

  assert.deepEqual(
    (await store.eventsFor(session.id)).map((event) => event.kind),
    ["checked", "ready"],
  );
  assert.equal((await store.recentEvents())[0]?.kind, "checked", "the newest event is first");
});

test("store: the audit reader narrows by kind in the store, not in a page's window", async () => {
  // The claim this reader makes is "that kind's newest N", not "the newest N, filtered by
  // kind". Those differ as soon as enough other kinds exist to push one out of the window,
  // which is what this fixture arranges: 500 `prewarmed` events logged *after* the single
  // `checked` one, so a page-side filter over the newest 300 would show no `checked` event
  // while the store's own narrowing still finds it — the reason the reader is on the store.
  const store = new InMemoryLabStore();
  const session = await store.createSession(sessionFor());
  assert.ok(session.id !== null);

  await store.logEvent("checked", "buried", session.id);
  for (let index = 0; index < 500; index += 1) {
    await store.logEvent("prewarmed", `warm ${index}`, null);
  }

  assert.deepEqual(
    (await store.listEvents({ kind: "checked" })).map((event) => event.detail),
    ["buried"],
    "the kind's own newest, however far back it is",
  );
  assert.deepEqual(await store.listEvents({ kind: "checked", limit: 0 }), [], "zero is empty here too");
  assert.equal((await store.listEvents({ limit: 5 })).length, 5, "the whole trail is still bounded");
  assert.deepEqual(await store.eventKinds(), ["checked", "prewarmed"], "the kinds, sorted");
  assert.deepEqual(await store.listEvents({ kind: "no-such-kind" }), [], "an unknown kind is empty");
});

/* -------------------------------------------------------------------------- */
/*  Meta                                                                      */
/* -------------------------------------------------------------------------- */

test("store: meta round-trips, and a falsy value is not mistaken for an absent one", async () => {
  const store = new InMemoryLabStore();

  assert.equal(await store.getMeta("nothing", "fallback"), "fallback");
  assert.equal(await store.getMeta("nothing"), null, "the default fallback is nothing");

  await store.setMeta("schema", { version: 2 });
  assert.deepEqual(await store.getMeta("schema"), { version: 2 });
  await store.setMeta("schema", 3);
  assert.equal(await store.getMeta("schema"), 3);

  // The case a `??`/`||` implementation gets wrong: these were *stored*, so the
  // fallback must not be substituted no matter how falsy they are.
  await store.setMeta("zero", 0);
  await store.setMeta("empty", "");
  await store.setMeta("off", false);
  assert.equal(await store.getMeta("zero", "fallback"), 0);
  assert.equal(await store.getMeta("empty", "fallback"), "");
  assert.equal(await store.getMeta("off", "fallback"), false);
});

/* -------------------------------------------------------------------------- */
/*  Isolation                                                                 */
/* -------------------------------------------------------------------------- */

test("store: what a caller is handed is a copy, so it cannot rewrite stored state", async () => {
  const store = new InMemoryLabStore();
  const created = await store.createSession(sessionFor());
  assert.ok(created.id !== null);

  // A database hands back a fresh row; a `Map` hands back the object itself unless the
  // implementation copies. Mutate everything a caller could reach for.
  created.student = "mallory";
  created.state = "destroyed";
  created.instance = "somebody-elses-vm";
  created.rdpPassword = "changed";

  const loaded = await store.getSession(created.id);
  assert.ok(loaded);
  assert.equal(loaded.student, "alice");
  assert.equal(loaded.state, "requested");
  assert.equal(loaded.instance, "");
  assert.equal(loaded.rdpPassword, "");

  // The same through a list, which is where a shared reference would leak most easily.
  const rows = await store.listSessions();
  assert.ok(rows[0]);
  rows[0].student = "mallory";
  assert.equal((await store.getSession(created.id))?.student, "alice");
});

/*
 * NOT COVERED HERE, AND NOT COVERED BY THE SUITE PASSING:
 *
 * - The Python's SQLite behaviour: creating the database file, its self-migration, its
 *   indexes and `Store(path)` surviving a reopen (`test_store_survives_reopen`). There
 *   is no file to reopen: the engine is the app's Postgres and the Prisma implementation
 *   is stage 2d (plan §3/C3), which is why `store.ts` declares a contract rather than a
 *   schema.
 * - The `users` table and everything over it (`upsert_user`, `upsert_sso_user`,
 *   `deactivate_user`, the account sentinel, "an SSO sign-in does not undo a disable").
 *   Those tests are about a credential path that this port deliberately does not have:
 *   sign-in is the app's identity (§3/C2), so the lab's own user table is superseded
 *   rather than ported.
 * - `update_session(**fields)`'s runtime refusal of an unknown column
 *   (`test_update_rejects_unknown_columns`). The port replaced that method with
 *   `saveSession`, which takes a whole typed session, so an unknown field is a
 *   compile error rather than a runtime one — there is nothing for a runtime assertion
 *   to catch.
 * - `leaderboard()` (best score, attempts, solved per student) and the `tickets` table's
 *   surfaces. Both are reads and writes the stage-3 instructor views need; neither is on
 *   the contract I was given, so the coordinator should decide whether `leaderboard`
 *   belongs on `LabStore` or beside it as a read model over `resultsForStudent`.
 */
