/**
 * What the lab's pages read, as data.
 *
 * The Python portal mixed three jobs in one file: reading a session, deciding what a page
 * should show, and rendering Jinja. The port keeps them apart — this module is the middle
 * one, and it is **pure**: no database, no request, no clock of its own. The pages call it
 * with what they have fetched, and the route handlers call it to build a body, so a rule
 * about what a student sees is a value a test can assert rather than a template nobody can
 * reach.
 *
 * Everything here is a port of a helper in `ontrak/portal/app.py` or `admin.py`, and the
 * things worth stating out loud are the two that were bug fixes in the Python:
 *
 * **The address says where it works.** The guests live on the lab's own bridge, so
 * `10.20.0.x` is unroutable from a student's own network. The portal used to hand that
 * address over as "still yours to connect to directly", which told a remote student to ssh
 * somewhere their laptop cannot go; every form of the address now carries the network it
 * belongs to, and the console is named as the way in.
 *
 * **A Linux guest is a shell, not a desktop.** With no sshd in the image the console cannot
 * connect at all (`guac.linux_ssh` is off), so the page offers the guest's own console
 * rather than an iframe that will never open.
 */

import { Catalog } from "./catalog";
import { LabSettings } from "./config";
import { GuacError, buildLink } from "./guac";
import { Lesson, LessonRepository } from "./lessons";
import {
  type LabSession,
  type SessionState,
  isUsable,
  sessionSecondsRemaining,
} from "./models";
import { LINUX, type Scenario, ScenarioRepository, publicView } from "./scenarios";
import { formatFixed } from "./scoring";

/** The lab's own bridge. Nothing routes to a guest from outside it. */
export const LAB_NETWORK = "the lab's internal network";

/**
 * What carries a student to a machine: the address, the command, and where it works.
 *
 * `transport` is `RDP` for a Windows guest, `SSH` when the Linux image runs an sshd, and
 * `shell` when it does not — in which case `target` is the address itself, because the
 * console is the guest's own shell and there is no socket to dial.
 */
export interface MachineAddress {
  host: string;
  target: string;
  user: string;
  transport: "" | "RDP" | "SSH" | "shell";
  reach: string;
}

export function machineAddress(
  settings: LabSettings,
  scenario: Pick<Scenario, "platform"> | null,
  session: Pick<LabSession, "hostIp" | "rdpUser">,
): MachineAddress {
  const host = session.hostIp;
  if (!host) {
    return { host: "", target: "", user: "", transport: "", reach: LAB_NETWORK };
  }
  if (scenario !== null && scenario.platform === LINUX) {
    const user = settings.guest.linuxUser || "root";
    if (settings.guac.linuxSsh) {
      return {
        host,
        target: `ssh ${user}@${host} -p ${settings.guest.sshPort}`,
        user,
        transport: "SSH",
        reach: LAB_NETWORK,
      };
    }
    // No sshd in the image: the shell is the guest's own console, not a socket.
    return { host, target: host, user, transport: "shell", reach: LAB_NETWORK };
  }
  return {
    host,
    target: `${host}:${settings.guest.rdpPort}`,
    user: session.rdpUser || settings.guest.user,
    transport: "RDP",
    reach: LAB_NETWORK,
  };
}

/**
 * One session, as the page's poller reads it.
 *
 * Field names are the Python's, deliberately: this is the JSON a browser polls while a
 * machine boots, and the same body is the shape an operator's script already parses.
 * `ready` is the portal's word for "usable" — the machine exists and can be touched — and
 * it is not the same question as `state === "ready"`, which is one state among several.
 */
export interface SessionStatus {
  id: number | null;
  state: SessionState;
  ready: boolean;
  hostIp: string;
  error: string;
  checksRun: number;
  bestScore: number;
  resolved: boolean;
  secondsRemaining: number | null;
  timeLimitMinutes: number;
  workload: string;
  consoleAvailable: boolean;
  /**
   * How far along the preparation is, as an indication rather than a measurement.
   *
   * The lab's own states are the whole truth — requested, allocating, provisioning, ready
   * — and a progress bar needs a number, so this is the state's position on that path.
   * It is deliberately *not* a guess at seconds remaining: a clone that takes forty
   * seconds on a busy host is still the same step, and a bar that pretends otherwise is a
   * bar that lies twice per boot.
   */
  progress: number;
}

/** Where each state sits on the way to a usable machine. */
const PROGRESS_BY_STATE: Record<SessionState, number> = {
  requested: 10,
  allocating: 35,
  provisioning: 70,
  ready: 100,
  in_use: 100,
  // A finished session's bar is full whatever it ended as: the preparation it was drawn
  // for is over, and the state badge is what tells a student how it went.
  checking: 100,
  passed: 100,
  failed: 100,
  recycling: 20,
  error: 100,
  destroyed: 100,
};

export function sessionStatus(
  session: LabSession,
  consoleAvailable: boolean,
  now: Date = new Date(),
): SessionStatus {
  return {
    id: session.id,
    state: session.state,
    ready: isUsable(session.state),
    hostIp: session.hostIp,
    error: session.error,
    checksRun: session.checksRun,
    bestScore: session.bestScore,
    resolved: session.resolved,
    secondsRemaining: sessionSecondsRemaining(session, now),
    timeLimitMinutes: session.timeLimitMinutes,
    workload: session.workload,
    consoleAvailable,
    progress: PROGRESS_BY_STATE[session.state] ?? 0,
  };
}

/** A catalogue group, as the workload picker draws it. Empty groups are dropped. */
export interface WorkloadGroup {
  id: string;
  label: string;
  era: string;
  entries: Record<string, unknown>[];
}

export function workloadGroups(catalog: Catalog): WorkloadGroup[] {
  const groups: WorkloadGroup[] = [];
  for (const group of catalog.groupList()) {
    const entries = group.entries.map((entry) => entry.toPublic());
    if (entries.length > 0) {
      groups.push({ id: group.id, label: group.label, era: group.era, entries });
    }
  }
  return groups;
}

/** The catalogue as the dashboard's scenario picker draws it, grouped by category. */
export interface CatalogueGroup {
  category: string;
  label: string;
  scenarios: Record<string, unknown>[];
}

/**
 * The lab's scenarios, grouped, at the hint level a student has earned.
 *
 * The grouping comes from the tree (`byCategory`), and the label from the first scenario
 * in each group — which is what the Python did, and is safe because a category's label is
 * derived from the category rather than stored per scenario.
 */
export function catalogueByCategory(
  repository: ScenarioRepository,
  hintLevel = 0,
): CatalogueGroup[] {
  const groups: CatalogueGroup[] = [];
  for (const [category, scenarios] of repository.byCategory()) {
    const first = scenarios[0];
    if (first === undefined) continue;
    groups.push({
      category,
      label: first.categoryLabel,
      scenarios: scenarios.map((scenario) => publicView(scenario, hintLevel)),
    });
  }
  return groups;
}

/** A lesson, as the index lists it. */
export interface LessonSummary {
  id: string;
  title: string;
  summary: string;
  platform: string;
  category: string;
  difficulty: number;
  minutes: number;
  commands: number;
  exercises: number;
  tags: string[];
  prerequisites: string[];
}

export function lessonIndex(lessons: LessonRepository, platform: string | null = null): LessonSummary[] {
  const out: LessonSummary[] = [];
  for (const lesson of lessons.list()) {
    if (platform && lesson.platform !== platform) continue;
    out.push(lessonSummary(lesson));
  }
  return out;
}

function lessonSummary(lesson: Lesson): LessonSummary {
  return {
    id: lesson.id,
    title: lesson.title,
    summary: lesson.summary,
    platform: lesson.platform,
    category: lesson.category,
    difficulty: lesson.difficulty,
    minutes: lesson.minutes,
    commands: lesson.commands.length,
    exercises: lesson.exercises.length,
    tags: [...lesson.tags],
    prerequisites: [...lesson.prerequisites],
  };
}

/* -------------------------------------------------------------------------- */
/*  The signed console link                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The signed Guacamole URL for one session, or `""` when there is none.
 *
 * Two ways to have none, and both are ordinary: the machine has no address yet (it is
 * still cloning), and the deployment has no gateway configured. The Python returned `""`
 * for both — never a link that goes nowhere — and so does this.
 */
export function consoleUrl(
  settings: LabSettings,
  session: Pick<LabSession, "id" | "student" | "scenarioId" | "hostIp" | "rdpUser" | "rdpPassword">,
  scenario: Pick<Scenario, "id" | "title" | "platform"> | null,
  nowSeconds?: number,
): string {
  if (!session.hostIp || !settings.guac.secretKey) return "";
  // `isLinux` is derived rather than read: the port's `Scenario` carries a platform, and
  // `guac.ts` asks for the fact that platform implies.
  const consoleScenario =
    scenario === null
      ? null
      : { id: scenario.id, title: scenario.title, isLinux: scenario.platform === LINUX };
  try {
    return buildLink(settings, session, consoleScenario, nowSeconds);
  } catch (error) {
    // A Linux guest with no sshd, or a key that cannot be read. Both are answered with no
    // console and an explanation on the page rather than a broken iframe.
    if (error instanceof GuacError) return "";
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/*  Results                                                                    */
/* -------------------------------------------------------------------------- */

/** One (student, scenario) line of the leaderboard, as the Python's SQL produced it. */
export interface LeaderboardRow {
  student: string;
  scenarioId: string;
  attempts: number;
  best: number;
  solved: boolean;
}

/** One stored result, with the student who submitted it. */
export interface ResultRow {
  student: string;
  scenarioId: string;
  score: number;
  machineScore: number;
  ticketScore: number | null;
  ticketWeight: number;
  resolved: boolean;
  createdAt: string;
}

/**
 * Best score per (student, scenario).
 *
 * The Python grouped in SQL (`GROUP BY student, scenario_id ORDER BY student,
 * scenario_id`); the port aggregates here because the store's contract returns results per
 * student rather than a grouped view, and one rule in one place beats a second query shape
 * per store implementation. The ordering is the SQL's, so an export and a page agree.
 */
export function leaderboardRows(
  results: readonly Pick<ResultRow, "student" | "scenarioId" | "score" | "resolved">[],
): LeaderboardRow[] {
  const byKey = new Map<string, LeaderboardRow>();
  for (const result of results) {
    const key = `${result.student}\u0000${result.scenarioId}`;
    const row = byKey.get(key);
    if (row === undefined) {
      byKey.set(key, {
        student: result.student,
        scenarioId: result.scenarioId,
        attempts: 1,
        best: result.score,
        solved: result.resolved,
      });
      continue;
    }
    row.attempts += 1;
    row.best = Math.max(row.best, result.score);
    row.solved = row.solved || result.resolved;
  }
  return [...byKey.values()].sort((left, right) =>
    left.student === right.student
      ? left.scenarioId.localeCompare(right.scenarioId)
      : left.student.localeCompare(right.student),
  );
}

/** The name both exports download as. Operators and the family's portal know it. */
export const RESULTS_CSV_FILENAME = "ontrak-results.csv";

/**
 * One CSV field, quoted the way Python's `csv.writer` quotes.
 *
 * Minimal quoting, not "always quote": a comma, a quote or a newline forces quotes, and an
 * embedded quote is doubled. Getting this wrong is how a student's name with a comma in it
 * becomes two columns in a spreadsheet an auditor is reading.
 */
export function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function csvRow(fields: readonly string[]): string {
  return `${fields.map(csvField).join(",")}\r\n`;
}

/** The per-student export: one line per (student, scenario). */
export function leaderboardCsv(rows: readonly LeaderboardRow[]): string {
  let body = csvRow(["student", "scenario_id", "attempts", "best_score", "resolved"]);
  for (const row of rows) {
    body += csvRow([
      row.student,
      row.scenarioId,
      String(row.attempts),
      formatFixed(row.best, 1),
      row.solved ? "yes" : "no",
    ]);
  }
  return body;
}

/**
 * The per-result export, which is the one that shows the blend.
 *
 * Stage 3a made a grade two halves; this is where that is visible to an instructor without
 * opening the database — machine score, write-up score, the write-up's weight, and the
 * final mark the student saw. A write-up that was never submitted is an empty field rather
 * than a zero, because zero is a mark a student can earn and "not submitted" is not.
 */
export function resultsCsv(rows: readonly ResultRow[]): string {
  let body = csvRow([
    "student",
    "scenario_id",
    "machine_score",
    "ticket_score",
    "ticket_weight",
    "final_score",
    "resolved",
    "submitted_at",
  ]);
  for (const row of rows) {
    body += csvRow([
      row.student,
      row.scenarioId,
      formatFixed(row.machineScore, 1),
      row.ticketScore === null ? "" : formatFixed(row.ticketScore, 1),
      formatFixed(row.ticketWeight, 0),
      formatFixed(row.score, 1),
      row.resolved ? "yes" : "no",
      row.createdAt,
    ]);
  }
  return body;
}

/** A CSV response body's headers, so both exports cannot disagree about them. */
export function csvHeaders(filename = RESULTS_CSV_FILENAME): Record<string, string> {
  return {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename=${filename}`,
    "cache-control": "no-store",
  };
}
