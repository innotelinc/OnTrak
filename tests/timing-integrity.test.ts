/**
 * Timing integrity (2.2): the opt-in record of time away from an attempt.
 *
 * The control's whole value is that the record is honest — it cannot claim more
 * than the attempt's own window, cannot be inflated by a broken client, and
 * cannot be read as a score. These tests pin each of those, plus the validator's
 * decision that the control is off unless a scenario says otherwise.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_AWAY_SECONDS,
  readTimingRecord,
  timingRecordFor,
  mergeTimingRecord,
  describeTimingRecord,
  readTimingClaims,
  timingIntegrityEnabled,
  type TimingIntegrityRecord,
} from "../src/lib/timing-integrity-rules";
import { validateDefinition } from "../src/lib/validate";
import type { ScenarioDefinition } from "../src/lib/sim/types";

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

/** A fixed instant so an interval is a number, not a moving clock. */
const BASE = Date.UTC(2026, 0, 1, 9, 0, 0);
const at = (seconds: number) => new Date(BASE + seconds * 1000).toISOString();

/** A one-hour attempt, from BASE. */
const WINDOW = { start: at(0), end: at(3600) };

const SCENARIO: ScenarioDefinition = {
  version: 1,
  platform: "LINUX",
  engine: "bash",
  objective: "Harden SSH on the jump host.",
  brief: "Password sign-in is on. Turn it off, then record a case note.",
  tasks: ["Disable password authentication"],
  machine: { hostname: "jump01", user: "student", os: "Ubuntu 24.04.2 LTS", version: "24.04" },
  files: [{ path: "/home/student/ssh.conf", content: "PasswordAuthentication yes\n", mode: "644" }],
  checks: [
    {
      id: "password-off",
      label: "Password auth disabled",
      kind: "file_contains",
      path: "/home/student/ssh.conf",
      pattern: "PasswordAuthentication no",
      points: 4,
    },
  ],
};

/* -------------------------------------------------------------------------- */
/*  Merging                                                                   */
/* -------------------------------------------------------------------------- */

test("timing: overlapping and touching claims are one period away, not several events", () => {
  const record = timingRecordFor(
    [
      { hiddenAt: at(10), shownAt: at(40) },
      { hiddenAt: at(30), shownAt: at(60) }, // overlaps the first
      { hiddenAt: at(60), shownAt: at(90) }, // touches the second at 60
    ],
    WINDOW,
    BASE + 3600_000,
  );

  assert.equal(record.intervals, 1);
  assert.equal(record.awaySeconds, 80);
  assert.equal(record.longestSeconds, 80);
  assert.equal(record.firstHiddenAt, at(10));
  assert.deepEqual(record.spans, [{ start: at(10), end: at(90) }]);
});

test("timing: separate periods stay separate, and the longest is reported", () => {
  const record = timingRecordFor(
    [
      { hiddenAt: at(300), shownAt: at(400) },
      { hiddenAt: at(30), shownAt: at(45) },
    ],
    WINDOW,
    BASE + 3600_000,
  );

  assert.equal(record.intervals, 2);
  assert.equal(record.awaySeconds, 115);
  assert.equal(record.longestSeconds, 100);
  // Sorted by when they happened, so the record reads chronologically.
  assert.deepEqual(record.spans, [
    { start: at(30), end: at(45) },
    { start: at(300), end: at(400) },
  ]);
});

/* -------------------------------------------------------------------------- */
/*  What is refused                                                           */
/* -------------------------------------------------------------------------- */

test("timing: nonsense claims are dropped rather than recorded or refused", () => {
  const record = timingRecordFor(
    [
      { hiddenAt: at(20), shownAt: at(10) }, // ends before it begins
      { hiddenAt: "not a date", shownAt: at(30) },
      { hiddenAt: at(40), shownAt: at(40) }, // zero length
      { hiddenAt: at(50), shownAt: at(50.5) }, // a redraw, not time away
      { hiddenAt: at(60), shownAt: at(60 + 5 * 3600) }, // longer than a page can be hidden
    ],
    { start: at(0), end: at(30_000) },
    BASE + 3600_000,
  );

  assert.equal(record.intervals, 0);
  assert.equal(record.awaySeconds, 0);
  assert.deepEqual(record.spans, []);
});

test("timing: a claim is clamped to the attempt's own window", () => {
  // The browser says it was hidden before the attempt started and still hidden
  // after it ended: only the part inside the attempt is time away from it.
  const record = timingRecordFor(
    [{ hiddenAt: at(-600), shownAt: at(1500) }],
    { start: at(1000), end: at(2000) },
    BASE + 2000_000,
  );

  assert.equal(record.intervals, 1);
  assert.equal(record.awaySeconds, 500);
  assert.deepEqual(record.spans, [{ start: at(1000), end: at(1500) }]);
});

test("timing: a claim is trimmed to now while the attempt is still running", () => {
  const record = timingRecordFor([{ hiddenAt: at(100), shownAt: at(9_000) }], { start: at(0), end: null }, BASE + 400_000);

  assert.equal(record.intervals, 1);
  assert.equal(record.awaySeconds, 300);
});

test("timing: the total is capped and the record says so", () => {
  // Two four-hour intervals: each is readable, but together they are past any
  // honest sitting, so the total — not the spans — is what the cap limits.
  const record = timingRecordFor(
    [
      { hiddenAt: at(0), shownAt: at(4 * 3600) },
      { hiddenAt: at(5 * 3600), shownAt: at(9 * 3600) },
    ],
    { start: at(0), end: at(10 * 3600) },
    BASE + 10 * 3600_000,
  );

  assert.equal(record.intervals, 2);
  assert.equal(record.awaySeconds, MAX_AWAY_SECONDS);
  assert.equal(record.capped, true);
  assert.equal(record.spans.length, 2, "the periods stay readable; only the total is capped");
});

test("timing: merging a retried batch does not double the time", () => {
  const first = timingRecordFor([{ hiddenAt: at(10), shownAt: at(70) }], WINDOW, BASE + 3600_000);
  const same = mergeTimingRecord(first, [{ hiddenAt: at(10), shownAt: at(70) }], WINDOW, BASE + 3600_000);
  const later = mergeTimingRecord(first, [{ hiddenAt: at(120), shownAt: at(150) }], WINDOW, BASE + 3600_000);

  assert.equal(same.intervals, 1);
  assert.equal(same.awaySeconds, 60);
  assert.equal(later.intervals, 2);
  assert.equal(later.awaySeconds, 90);
});

/* -------------------------------------------------------------------------- */
/*  Reading back                                                              */
/* -------------------------------------------------------------------------- */

test("timing: a stored record is read from its spans, not its totals", () => {
  const stored = {
    source: "browser-reported",
    spans: [{ start: at(10), end: at(70) }],
    intervals: 99,
    awaySeconds: 99_999,
    longestSeconds: 99_999,
    firstHiddenAt: at(10),
    capped: false,
    reportedAt: at(80),
  };

  const record = readTimingRecord(stored);
  assert.ok(record);
  assert.equal(record.intervals, 1);
  assert.equal(record.awaySeconds, 60, "a hand-edited total cannot disagree with the periods");
  assert.equal(record.longestSeconds, 60);
});

test("timing: anything that is not a record reads back as null", () => {
  for (const junk of [null, undefined, {}, "record", [], { source: "server-observed", spans: [] }]) {
    assert.equal(readTimingRecord(junk), null);
  }
});

test("timing: a record with no spans is a record of nothing, not an error", () => {
  const record = readTimingRecord({
    source: "browser-reported",
    spans: [],
    reportedAt: at(10),
  });
  assert.ok(record);
  assert.equal(record.intervals, 0);
  assert.equal(record.firstHiddenAt, null);
});

/* -------------------------------------------------------------------------- */
/*  The sentence                                                              */
/* -------------------------------------------------------------------------- */

test("timing: the summary says what happened and what it is not", () => {
  const some = timingRecordFor([{ hiddenAt: at(10), shownAt: at(53) }], WINDOW, BASE + 3600_000);
  assert.equal(describeTimingRecord(some), "43 s away in 1 interval; recorded, not scored.");

  const two = timingRecordFor(
    [
      { hiddenAt: at(10), shownAt: at(53) },
      { hiddenAt: at(100), shownAt: at(190) },
    ],
    WINDOW,
    BASE + 3600_000,
  );
  assert.match(describeTimingRecord(two), /2 intervals; recorded, not scored\.$/);

  const none = timingRecordFor([], WINDOW, BASE + 3600_000);
  assert.equal(describeTimingRecord(none), "No time away was recorded.");
});

test("timing: the description never claims cheating, proctoring or a penalty", () => {
  const record = timingRecordFor(
    [
      { hiddenAt: at(0), shownAt: at(4 * 3600) },
      { hiddenAt: at(5 * 3600), shownAt: at(9 * 3600) },
    ],
    { start: at(0), end: at(10 * 3600) },
    BASE + 10 * 3600_000,
  );
  const sentence = describeTimingRecord(record);

  assert.doesNotMatch(sentence, /cheat|violat|proctor|penal|fail/i);
  assert.match(sentence, /capped/);
});

/* -------------------------------------------------------------------------- */
/*  The client's batch                                                        */
/* -------------------------------------------------------------------------- */

test("timing: a malformed batch is reduced, not refused", () => {
  const claims = readTimingClaims([
    { hiddenAt: at(1), shownAt: at(2) },
    { hiddenAt: 5, shownAt: at(6) },
    "nope",
    null,
    { hiddenAt: at(3) },
  ]);
  assert.deepEqual(claims, [{ hiddenAt: at(1), shownAt: at(2) }]);
  assert.deepEqual(readTimingClaims({}), []);
});

/* -------------------------------------------------------------------------- */
/*  Opt-in                                                                    */
/* -------------------------------------------------------------------------- */

test("timing: the control is off unless the definition says true", () => {
  assert.equal(timingIntegrityEnabled(SCENARIO), false);
  assert.equal(timingIntegrityEnabled({ ...SCENARIO, integrity: {} }), false);
  assert.equal(timingIntegrityEnabled({ ...SCENARIO, integrity: { recordFocusLoss: false } }), false);
  assert.equal(timingIntegrityEnabled({ ...SCENARIO, integrity: { recordFocusLoss: true } }), true);
  assert.equal(timingIntegrityEnabled(null), false);
});

test("timing: the validator accepts the opt-in and refuses a shape that would silently do nothing", () => {
  const enabled = validateDefinition({ ...SCENARIO, integrity: { recordFocusLoss: true } });
  assert.equal(enabled.ok, true, enabled.issues.map((issue) => issue.message).join(" / "));
  assert.equal(enabled.definition?.integrity?.recordFocusLoss, true);

  const wrongType = validateDefinition({ ...SCENARIO, integrity: { recordFocusLoss: "yes" } });
  assert.equal(wrongType.ok, false);
  assert.ok(wrongType.issues.some((issue) => issue.field?.startsWith("integrity")));

  // A misspelled key would be stripped by a non-strict object, and the scenario
  // would record nothing while its author believed the control was on.
  const misspelled = validateDefinition({ ...SCENARIO, integrity: { recordFocusloss: true } });
  assert.equal(misspelled.ok, false);

  const absent = validateDefinition(SCENARIO);
  assert.equal(absent.ok, true);
  assert.equal(absent.definition?.integrity, undefined);
});

test("timing: a capped record is still a record", () => {
  const record: TimingIntegrityRecord = timingRecordFor(
    [{ hiddenAt: at(0), shownAt: at(4 * 3600) }],
    { start: at(0), end: at(10 * 3600) },
    BASE + 10 * 3600_000,
  );
  const read = readTimingRecord(record);
  assert.ok(read);
  assert.equal(read.intervals, 1);
  assert.equal(read.awaySeconds, 4 * 3600);
});
