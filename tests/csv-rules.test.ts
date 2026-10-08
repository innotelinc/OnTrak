/**
 * The CSV rules, which exist to be boring.
 *
 * Two things are worth proving here. First that writing is RFC 4180, because a
 * scenario title containing a comma is the normal case and splitting a row over
 * it is how an export becomes a support ticket. Second that reading is total —
 * a bad roster is described line by line rather than throwing halfway through,
 * since an import that half-applies is worse than one that refuses.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/csv-rules.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RESULTS_HEADERS,
  ROSTER_HEADERS,
  csvField,
  csvFileName,
  parseCsv,
  readRosterCsv,
  resultCells,
  resultsCsv,
  rosterCsv,
  type ResultCsvRow,
} from "../src/lib/csv-rules";

test("csv: a field that needs quoting gets it, and a quote is doubled", () => {
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField("two\nlines"), '"two\nlines"');
  assert.equal(csvField(null), "");
  assert.equal(csvField(42), "42");
});

test("csv: writing ends every line with CRLF", () => {
  const text = resultsCsv([
    {
      attemptId: "att_1",
      learnerEmail: "ada@acme.test",
      learnerName: "Ada, Countess",
      scenarioId: "s1",
      scenarioTitle: 'Fix the "broken" NIC',
      platform: "LINUX",
      status: "GRADED",
      score: 8,
      maxScore: 10,
      passScore: 7,
      startedAt: new Date("2026-10-05T09:00:00.000Z"),
      gradedAt: new Date("2026-10-05T09:20:01.000Z"),
      timeSpentSec: 1200,
      certificateCode: "ONTRAK-ABCD-EF01-2345",
      mode: "simulated",
    } satisfies ResultCsvRow,
  ]);
  const lines = text.split("\r\n");
  assert.equal(lines[0], (RESULTS_HEADERS as unknown as string[]).join(","));
  assert.equal(lines[1], 'att_1,ada@acme.test,\"Ada, Countess\",s1,\"Fix the \"\"broken\"\" NIC\",LINUX,GRADED,8,10,80,yes,2026-10-05T09:00:00.000Z,2026-10-05T09:20:01.000Z,1200,ONTRAK-ABCD-EF01-2345,simulated');
  assert.equal((RESULTS_HEADERS as unknown as string[]).at(-1), "mode", "the mode is appended, never inserted");
  assert.equal(lines.at(-1), "");
  assert.equal(text.split("\n").length, 3, "a trailing newline, and no more");
});

test("csv: percent and the pass mark are computed, not copied", () => {
  const row: ResultCsvRow = {
    attemptId: "att_2",
    learnerEmail: "bob@acme.test",
    learnerName: "Bob",
    scenarioId: "s2",
    scenarioTitle: "Rotate a key",
    platform: "OFFICE",
    status: "GRADED",
    score: 1,
    maxScore: 3,
    passScore: 50,
    startedAt: new Date("2026-10-05T09:00:00.000Z"),
    gradedAt: null,
    timeSpentSec: 60,
    certificateCode: null,
    mode: "lab",
  };
  const cells = resultCells(row);
  assert.equal(cells[9], 33);
  // The pass mark is a percentage, so 33% fails a 50% mark and 67% clears it.
  assert.equal(cells[10], "no");
  assert.equal(resultCells({ ...row, score: 2 })[10], "yes");
  assert.equal(cells[12], "", "an unfinished attempt has no grading instant");
  assert.equal(cells[14], "");
  assert.equal(cells[15], "lab", "the export states which grader produced the row");
  assert.equal(cells.length, RESULTS_HEADERS.length);
  const zero: ResultCsvRow = { ...row, score: 0, maxScore: 0, passScore: 0 };
  assert.equal(resultCells(zero)[9], 0, "a scenario worth nothing is not 100%");
  assert.equal(resultCells(zero)[10], "no", "and it is not a pass at a 0% mark either");
});

test("csv: parsing round-trips what writing produced", () => {
  const source = [["a,b", 'q"q', "line\nbreak"], ["plain", "", "  spaced  "]];
  const parsed = parseCsv(source.map((row) => row.map(csvField).join(",")).join("\r\n"));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.rows : null, source);
});

test("csv: a truncated file is refused rather than guessed at", () => {
  const parsed = parseCsv('email,name\n"ada@acme.test,Ada');
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.reason, /truncated/);
});

test("csv: a roster reads columns by name, in any order, with defaults", () => {
  const read = readRosterCsv(
    [
      "name,email,role,cohorts,active",
      "Ada,ada@acme.test,STUDENT,Autumn;Spring,yes",
      "Bob,bob@acme.test,, ,no",
      ",carol@acme.test,INSTRUCTOR,Autumn,yes",
    ].join("\n"),
  );
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.rows.length, 3);
  assert.deepEqual(read.rows[0], {
    line: 2,
    email: "ada@acme.test",
    name: "Ada",
    role: "STUDENT",
    cohorts: ["Autumn", "Spring"],
    active: true,
  });
  assert.equal(read.rows[1].role, "STUDENT", "an empty role is a learner, not an error");
  assert.deepEqual(read.rows[1].cohorts, []);
  assert.equal(read.rows[1].active, false);
  assert.equal(read.rows[2].name, "carol", "a name is derived from the address when the column is blank");
  assert.deepEqual(read.refused, []);
});

test("csv: an email is lower-cased so a roster cannot fork an account", () => {
  const read = readRosterCsv("email\nAda@Acme.Test\n");
  assert.equal(read.ok && read.rows[0].email, "ada@acme.test");
});

test("csv: bad rows are named by line, and the good ones still import", () => {
  const read = readRosterCsv(
    [
      "email,name,role,cohorts,active",
      "ada@acme.test,Ada,STUDENT,,yes",
      "not-an-email,Bob,STUDENT,,yes",
      "bob@acme.test,Bob,WIZARD,,yes",
      "bob@acme.test,Bob,STUDENT,,yes",
      ",Nobody,STUDENT,,yes",
      "dan@acme.test,Dan,STUDENT,,maybe",
      "eve@acme.test,Eve,STUDENT,,",
    ].join("\r\n"),
  );
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(
    read.rows.map((row) => row.email),
    ["ada@acme.test", "bob@acme.test", "eve@acme.test"],
    "a row refused for its role does not block a correct row for the same address below it",
  );
  assert.deepEqual(
    read.refused.map((refusal) => refusal.line),
    [3, 4, 6, 7],
  );
  assert.match(read.refused[0].reason, /is not an email address/);
  assert.match(read.refused[1].reason, /role must be one of ADMIN, INSTRUCTOR, STUDENT/);
  assert.match(read.refused[2].reason, /has no email/);
  assert.match(read.refused[3].reason, /active/);
});

test("csv: the same address twice in one file is a mistake worth naming", () => {
  const read = readRosterCsv("email,name\nada@acme.test,Ada\nADA@acme.test,Ada again\n");
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.rows.length, 1);
  assert.deepEqual(read.refused, [
    { line: 3, reason: "ada@acme.test is already on line 2" },
  ]);
});

test("csv: a file this cannot place is refused whole, and says why", () => {
  const empty = readRosterCsv("");
  assert.equal(empty.ok, false);
  assert.match(empty.ok ? "" : empty.reason, /no rows/);
  const noEmail = readRosterCsv("name,role\nAda,STUDENT\n");
  assert.equal(noEmail.ok, false);
  assert.match(noEmail.ok ? "" : noEmail.reason, /email/);
  const truncated = readRosterCsv('email,name\n"ada@acme.test,Ada');
  assert.equal(truncated.ok, false);
});

test("csv: a byte-order mark does not become part of the first column's name", () => {
  const read = readRosterCsv("\uFEFFemail,name\nada@acme.test,Ada\n");
  assert.equal(read.ok, true);
  assert.equal(read.ok && read.rows.length, 1);
});

test("csv: an exported roster is the file the importer reads back", () => {
  const text = rosterCsv([
    { email: "ada@acme.test", name: "Ada", role: "STUDENT", cohorts: ["Autumn", "Spring"], active: true, localPassword: false },
  ]);
  assert.equal(text.split("\r\n")[0], (ROSTER_HEADERS as unknown as string[]).join(","));
  assert.match(text, /ada@acme\.test,Ada,STUDENT,Autumn;Spring,yes,no/);

  const read = readRosterCsv(text);
  assert.equal(read.ok, true);
  assert.equal(read.ok && read.rows[0].cohorts.length, 2);
  assert.equal(read.ok && read.rows[0].active, true);
});

test("csv: an export filename is dated so two exports never collide", () => {
  assert.equal(csvFileName("ontrak-results", new Date("2026-10-05T23:59:59Z")), "ontrak-results-2026-10-05.csv");
});
