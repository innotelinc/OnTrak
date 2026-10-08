/**
 * Rosters and results as CSV — the interchange everybody already has.
 *
 * CSV exists here for the same reason the webhook does: the organisation that
 * needs this data usually keeps it somewhere this app will never integrate with,
 * and "export a file an administrator can open" is a lower bar to clear than any
 * API. It is also the only bulk *import* path, which is how a class arrives from
 * a spreadsheet somebody already maintains.
 *
 * Two rules make the format honest:
 *
 * * Writing is RFC 4180, so a title containing a comma or a quote survives the
 *   round trip instead of splitting a row into two columns of nonsense.
 * * Reading is total: a malformed file is described (which line, what was wrong)
 *   rather than throwing, because an import that half-applies and then dies is
 *   worse than one that refuses with a list of reasons.
 *
 * The parser is hand-written on purpose. A CSV library that guesses at dialect
 * is a dependency to audit for a format that is 40 lines of code.
 */

import type { Role } from "@prisma/client";

/* -------------------------------------------------------------------------- */
/*  Writing and parsing                                                       */
/* -------------------------------------------------------------------------- */

export type CsvCell = string | number | boolean | null | undefined;

/** RFC 4180 field: quote when the value contains a delimiter, a quote or a newline. */
export function csvField(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows of cells to a CRLF-terminated document (the Excel-safe line ending). */
export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

export type CsvParseResult = { ok: true; rows: string[][] } | { ok: false; reason: string };

/**
 * A CSV document to rows of cells.
 *
 * Unterminated quotes are refused rather than silently swallowing the rest of
 * the file: a truncated export and a file whose last field merely looks odd are
 * different problems, and only one of them should be imported.
 */
export function parseCsv(text: string): CsvParseResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      // A bare CRLF is one break, not two empty rows.
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }

  if (quoted) return { ok: false, reason: "the file ends inside a quoted field, so it is truncated" };

  // A trailing newline leaves an empty partial row; it is not a row.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return { ok: true, rows };
}

/* -------------------------------------------------------------------------- */
/*  Results                                                                   */
/* -------------------------------------------------------------------------- */

export const RESULTS_HEADERS = [
  "attempt_id",
  "learner_email",
  "learner_name",
  "scenario_id",
  "scenario_title",
  "platform",
  "status",
  "score",
  "max_score",
  "percent",
  "passed",
  "started_at",
  "graded_at",
  "time_spent_sec",
  "certificate_code",
  // Appended, never inserted, so a spreadsheet that reads by column name is
  // unaffected and one that reads by position only loses the new field's value.
  // A consumer sorting by score has to know which grader produced it (audit Q7).
  "mode",
] as const;

export interface ResultCsvRow {
  attemptId: string;
  learnerEmail: string;
  learnerName: string;
  scenarioId: string;
  scenarioTitle: string;
  platform: string;
  status: string;
  score: number;
  maxScore: number;
  passScore: number;
  startedAt: Date;
  gradedAt: Date | null;
  timeSpentSec: number;
  certificateCode: string | null;
  /** `simulated` | `lab` — who graded the attempt. See `grading-mode.ts`. */
  mode: string;
}

export function resultCells(row: ResultCsvRow): CsvCell[] {
  const percent = row.maxScore > 0 ? Math.round((row.score / row.maxScore) * 100) : 0;
  return [
    row.attemptId,
    row.learnerEmail,
    row.learnerName,
    row.scenarioId,
    row.scenarioTitle,
    row.platform,
    row.status,
    row.score,
    row.maxScore,
    percent,
    row.score >= row.passScore ? "yes" : "no",
    row.startedAt.toISOString(),
    row.gradedAt ? row.gradedAt.toISOString() : "",
    row.timeSpentSec,
    row.certificateCode ?? "",
    row.mode,
  ];
}

export function resultsCsv(rows: readonly ResultCsvRow[]): string {
  return toCsv([RESULTS_HEADERS as unknown as CsvCell[], ...rows.map(resultCells)]);
}

/** The filename a browser or a script sees, dated so two exports never collide. */
export function csvFileName(prefix: string, at: Date = new Date()): string {
  return `${prefix}-${at.toISOString().slice(0, 10)}.csv`;
}

/* -------------------------------------------------------------------------- */
/*  Roster                                                                    */
/* -------------------------------------------------------------------------- */

export const ROSTER_HEADERS = ["email", "name", "role", "cohorts", "active", "local_password"] as const;
export const ROSTER_ROLES: readonly Role[] = ["ADMIN", "INSTRUCTOR", "STUDENT"];
export const MAX_ROSTER_ROWS = 5_000;
/** The separator for the `cohorts` column, chosen because a class name may contain a comma. */
export const COHORT_SEPARATOR = ";";

export interface RosterCsvRow {
  email: string;
  name: string;
  role: string;
  cohorts: string[];
  active: boolean;
}

/**
 * One roster line.
 *
 * `localPassword` is written but never read: an export is the document an
 * administrator uses to decide who needs one, and an import must not be able to
 * create an account with a password — a credential carried in a spreadsheet is a
 * credential in an inbox.
 */
export function rosterCells(row: {
  email: string;
  name: string;
  role: string;
  cohorts: readonly string[];
  active: boolean;
  localPassword: boolean;
}): CsvCell[] {
  return [
    row.email,
    row.name,
    row.role,
    row.cohorts.join(COHORT_SEPARATOR),
    row.active ? "yes" : "no",
    row.localPassword ? "yes" : "no",
  ];
}

export function rosterCsv(rows: Parameters<typeof rosterCells>[0][]): string {
  return toCsv([ROSTER_HEADERS as unknown as CsvCell[], ...rows.map(rosterCells)]);
}

export interface RosterRefusal {
  /** 1-based line in the file, counting the header, so a person can find it. */
  line: number;
  reason: string;
}

export interface RosterImport {
  rows: (RosterCsvRow & { line: number })[];
  refused: RosterRefusal[];
}

export type RosterReadResult = ({ ok: true } & RosterImport) | { ok: false; reason: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 120;
const MAX_EMAIL = 254;
const MAX_COHORT = 80;

/**
 * A roster CSV to rows worth writing, with everything unusable named.
 *
 * The header is what identifies the columns, so a file pasted from a different
 * spreadsheet with the columns in another order imports correctly instead of
 * silently swapping names and roles. Missing columns are defaults, not errors —
 * a two-column `email,name` file is the common case — but a file with no header
 * this recognises is refused whole, because importing it would guess.
 */
export function readRosterCsv(text: string): RosterReadResult {
  const parsed = parseCsv(text.replace(/^\uFEFF/, ""));
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const rows = parsed.rows.filter((row) => row.some((cell) => cell.trim().length > 0));
  if (rows.length === 0) return { ok: false, reason: "the file had no rows" };
  if (rows.length - 1 > MAX_ROSTER_ROWS) {
    return { ok: false, reason: `the file has more than ${MAX_ROSTER_ROWS} rows; split it and import in parts` };
  }

  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const at = (name: string): number => header.indexOf(name);
  if (at("email") === -1) return { ok: false, reason: "the file needs a header row with an `email` column" };

  const refused: RosterRefusal[] = [];
  const imported: (RosterCsvRow & { line: number })[] = [];
  const seen = new Map<string, number>();

  for (let index = 1; index < rows.length; index += 1) {
    const line = index + 1;
    const cells = rows[index];
    const cell = (column: number): string => (column >= 0 ? (cells[column] ?? "").trim() : "");

    const email = cell(at("email")).toLowerCase();
    if (!email) {
      refused.push({ line, reason: "the row has no email" });
      continue;
    }
    if (email.length > MAX_EMAIL || !EMAIL.test(email)) {
      refused.push({ line, reason: `\`${email.slice(0, 60)}\` is not an email address` });
      continue;
    }
    const earlier = seen.get(email);
    if (earlier !== undefined) {
      refused.push({ line, reason: `${email} is already on line ${earlier}` });
      continue;
    }

    const name = cell(at("name")) || email.split("@")[0];
    if (name.length > MAX_NAME) {
      refused.push({ line, reason: `the name is longer than ${MAX_NAME} characters` });
      continue;
    }

    const roleText = cell(at("role")).toUpperCase();
    const role = roleText === "" ? "STUDENT" : roleText;
    if (!ROSTER_ROLES.includes(role as Role)) {
      refused.push({ line, reason: `role must be one of ${ROSTER_ROLES.join(", ")}` });
      continue;
    }

    const cohorts = cell(at("cohorts"))
      .split(COHORT_SEPARATOR)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (cohorts.some((entry) => entry.length > MAX_COHORT)) {
      refused.push({ line, reason: `a cohort name is longer than ${MAX_COHORT} characters` });
      continue;
    }

    const activeText = cell(at("active")).toLowerCase();
    if (activeText && !["yes", "no", "true", "false", "1", "0"].includes(activeText)) {
      refused.push({ line, reason: "`active` must be yes or no" });
      continue;
    }

    seen.set(email, line);
    imported.push({
      line,
      email,
      name,
      role,
      cohorts,
      active: !["no", "false", "0"].includes(activeText),
    });
  }

  return { ok: true, rows: imported, refused };
}
