/**
 * Domain models shared by the lab's session manager, graders and portal.
 *
 * This is the TypeScript half of OnTrak-dev's `ontrak/models.py`, and it keeps that
 * module's vocabulary deliberately: the state names, the category keys and the JSON
 * keys a record is stored under are the ones the Python control plane already uses,
 * because a lab host migrating to this stack has a database full of them and a
 * rename would be a data migration pretending to be a refactor.
 *
 * Two conventions worth stating, because every other ported module depends on them.
 *
 * **Code is camelCase; stored and emitted JSON is snake_case.** TypeScript reads
 * better as `objectiveId`, but `ScoreReport` rows are written into a store and read
 * back out by an admin export and a CLI, so `toDict`/`fromDict` are a real wire
 * format and keep the Python spelling (`objective_id`, `session_id`,
 * `machine_score`). Where a shape is only ever used inside this process, the two
 * agree and no conversion exists.
 *
 * **Timestamps are ISO-8601 strings, and parses are total.** The lab stores instants
 * as strings (its SQLite rows, its session JSON) and compares them by parsing. So
 * `iso()` always emits UTC with a `Z`, while `parseIso()` accepts what Python's
 * `datetime.isoformat()` emitted before it — `+00:00` as well as `Z` — and returns
 * `null` rather than throwing on anything it cannot read, so one corrupt row cannot
 * take down a page.
 *
 * Pure: no database, no clock beyond `Date`, no I/O.
 */

/** The marker pair `check.ps1` prints its grading JSON between. */
export const JSON_BEGIN = "###ONTRAK-JSON-BEGIN###";
export const JSON_END = "###ONTRAK-JSON-END###";

/** The grading instant, as this process writes it. UTC, millisecond precision. */
export function iso(when: Date = new Date()): string {
  return when.toISOString();
}

/** Now. Named for the Python helper it replaces, so ports read the same. */
export function utcNow(): Date {
  return new Date();
}

/**
 * One stored instant, or `null`.
 *
 * Accepts what Python wrote (`2026-10-09T12:00:00+00:00`, which `new Date` parses)
 * and what this process writes (`...Z`). A value it cannot read is `null` — the
 * caller decides what a missing instant means, which for an expiry is "no deadline
 * recorded" rather than "expired".
 */
export function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Seconds between a stored instant and now, or `null` when there is no instant. */
export function secondsSince(value: string | null | undefined, now: Date = new Date()): number | null {
  const parsed = parseIso(value);
  return parsed === null ? null : (now.getTime() - parsed.getTime()) / 1000;
}

/**
 * Lifecycle of one student's VM, in the lab's own spelling.
 *
 * Transitions (the session manager enforces these):
 *
 *     requested -> allocating -> provisioning -> ready -> in_use
 *     in_use -> checking -> in_use | passed | failed
 *     any -> recycling -> destroyed
 *     any -> error
 */
export const SESSION_STATES = [
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
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export function isSessionState(value: unknown): value is SessionState {
  return typeof value === "string" && (SESSION_STATES as readonly string[]).includes(value);
}

/** True while the student can still be handed this VM. */
const LIVE_STATES: readonly SessionState[] = [
  "requested",
  "allocating",
  "provisioning",
  "ready",
  "in_use",
  "checking",
];

/**
 * True once the machine is the student's to sit in front of.
 *
 * `ready` before they open the console, `in_use` while they work in it, and
 * `passed` after grading — the machine is still on screen, so the console link, the
 * check and the write-up stay reachable. The Python portal used to spell this set
 * out at each call site, and a test asserting bare `ready` raced the provisioning
 * thread for it; having one function is the fix that stuck.
 */
const USABLE_STATES: readonly SessionState[] = ["ready", "in_use", "passed"];

const TERMINAL_STATES: readonly SessionState[] = ["destroyed", "error"];

const NEEDS_INSTANCE_STATES: readonly SessionState[] = [
  "allocating",
  "provisioning",
  "ready",
  "in_use",
  "checking",
];

export function isLive(state: SessionState): boolean {
  return LIVE_STATES.includes(state);
}

export function isUsable(state: SessionState): boolean {
  return USABLE_STATES.includes(state);
}

export function isTerminal(state: SessionState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function needsInstance(state: SessionState): boolean {
  return NEEDS_INSTANCE_STATES.includes(state);
}

/** Scenario families. Mirrors the training-needs survey. */
export const CATEGORIES = [
  "hardware",
  "software",
  "network",
  "os",
  "security",
  "identity",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<string, string> = {
  hardware: "Hardware & drivers",
  software: "Applications & settings",
  network: "Network & connectivity",
  os: "Boot & performance",
  security: "Security incidents",
  identity: "Identity & access",
};

/** One gradeable goal inside a scenario. */
export interface Objective {
  id: string;
  text: string;
  weight: number;
  critical: boolean;
  hint: string;
}

/**
 * Read one objective from stored JSON.
 *
 * Defaults are the lab's: an objective with no `text` falls back to its id, weight
 * to 10 and critical to false, so a hand-written catalogue file that omits them is
 * still gradeable rather than rejected.
 */
export function objectiveFromDict(data: Record<string, unknown>): Objective {
  const id = String(data.id ?? "");
  return {
    id,
    text: String(data.text ?? id),
    weight: Number(data.weight ?? 10),
    critical: Boolean(data.critical ?? false),
    hint: String(data.hint ?? ""),
  };
}

export function objectiveToDict(objective: Objective): Record<string, unknown> {
  return {
    id: objective.id,
    text: objective.text,
    weight: objective.weight,
    critical: objective.critical,
    hint: objective.hint,
  };
}

/** The sum every objective's weight contributes to the report's denominator. */
export function scenarioTotalWeight(objectives: readonly Objective[]): number {
  return objectives.reduce((total, objective) => total + objective.weight, 0);
}

/** One objective by id, or `null` — the lookup the feedback rows and CLI both need. */
export function objectiveIn(objectives: readonly Objective[], id: string): Objective | null {
  return objectives.find((objective) => objective.id === id) ?? null;
}

/**
 * The scenario facts the grader reads.
 *
 * A structural subset of the full scenario (see the scenario loader), so the grader
 * can be proven against a fixture without loading a directory, and so nothing in the
 * grading path can reach for a field it does not need.
 */
export interface GradeableScenario {
  id: string;
  title: string;
  passScore: number;
  objectives: readonly Objective[];
}

/** What the guest reported for a single objective. */
export interface CheckOutcome {
  objectiveId: string;
  passed: boolean;
  detail: string;
  weight: number;
  critical: boolean;
  reported: boolean;
}

export function newCheckOutcome(
  fields: Partial<CheckOutcome> & { objectiveId: string },
): CheckOutcome {
  return {
    objectiveId: fields.objectiveId,
    passed: fields.passed ?? false,
    detail: fields.detail ?? "",
    weight: fields.weight ?? 0,
    critical: fields.critical ?? false,
    reported: fields.reported ?? true,
  };
}

export function checkOutcomeFromDict(data: Record<string, unknown>): CheckOutcome {
  return newCheckOutcome({
    objectiveId: String(data.objective_id ?? ""),
    passed: Boolean(data.passed ?? false),
    detail: String(data.detail ?? ""),
    weight: Number(data.weight ?? 0),
    critical: Boolean(data.critical ?? false),
    reported: Boolean(data.reported ?? true),
  });
}

export function checkOutcomeToDict(outcome: CheckOutcome): Record<string, unknown> {
  return {
    objective_id: outcome.objectiveId,
    passed: outcome.passed,
    detail: outcome.detail,
    weight: outcome.weight,
    critical: outcome.critical,
    reported: outcome.reported,
  };
}

/** Result of grading a session against its scenario. */
export interface ScoreReport {
  sessionId: number;
  scenarioId: string;
  score: number;
  resolved: boolean;
  outcomes: CheckOutcome[];
  createdAt: string;
  error: string;
  notes: string[];
  /**
   * The grade is a blend: the machine state checked in the guest, plus the ticket
   * the student wrote. They are kept apart as well as combined, so feedback can say
   * which half was weak and a report can be audited later.
   */
  machineScore: number;
  ticketScore: number | null;
  ticketWeight: number;
  ticketOutcomes: Record<string, unknown>[];
}

export function newScoreReport(fields: {
  sessionId: number;
  scenarioId: string;
  createdAt?: string;
}): ScoreReport {
  return {
    sessionId: fields.sessionId,
    scenarioId: fields.scenarioId,
    score: 0,
    resolved: false,
    outcomes: [],
    createdAt: fields.createdAt ?? iso(),
    error: "",
    notes: [],
    machineScore: 0,
    ticketScore: null,
    ticketWeight: 0,
    ticketOutcomes: [],
  };
}

export function scoreReportPassedCount(report: ScoreReport): number {
  return report.outcomes.filter((outcome) => outcome.passed).length;
}

export function scoreReportFailed(report: ScoreReport): CheckOutcome[] {
  return report.outcomes.filter((outcome) => !outcome.passed);
}

export function scoreReportSummaryLine(report: ScoreReport): string {
  if (report.error) return `grading failed: ${report.error}`;
  return `${Math.round(report.score)}% (${scoreReportPassedCount(report)}/${report.outcomes.length} objectives)`;
}

export function scoreReportHasTicket(report: ScoreReport): boolean {
  return report.ticketScore !== null;
}

/** One line naming each half of a blended grade. */
export function scoreReportBreakdown(report: ScoreReport): string {
  if (!scoreReportHasTicket(report)) return `machine ${Math.round(report.score)}%`;
  const ticket = report.ticketScore ?? 0;
  return (
    `machine ${Math.round(report.machineScore)}% x ${Math.round(100 - report.ticketWeight)}% ` +
    `+ ticket ${Math.round(ticket)}% x ${Math.round(report.ticketWeight)}% ` +
    `= ${Math.round(report.score)}%`
  );
}

/**
 * The stored shape, which is the Python `ScoreReport.to_dict()` byte for byte.
 *
 * This is a wire format, not a convenience: a results row written by the Python lab
 * is read back through `scoreReportFromDict`, and the CLI and the admin export emit
 * it. Renaming a key here would break a row that already exists.
 */
export function scoreReportToDict(report: ScoreReport): Record<string, unknown> {
  return {
    session_id: report.sessionId,
    scenario_id: report.scenarioId,
    score: report.score,
    resolved: report.resolved,
    created_at: report.createdAt,
    error: report.error,
    notes: [...report.notes],
    outcomes: report.outcomes.map(checkOutcomeToDict),
    machine_score: report.machineScore,
    ticket_score: report.ticketScore,
    ticket_weight: report.ticketWeight,
    ticket_outcomes: report.ticketOutcomes.map((outcome) => ({ ...outcome })),
  };
}

/**
 * Read a stored report back.
 *
 * `machine_score` defaults to `score` because a machine-only report written before
 * the ticket blend existed carried no separate machine score, and its single number
 * *was* the machine score.
 */
export function scoreReportFromDict(data: Record<string, unknown>): ScoreReport {
  const rawOutcomes = Array.isArray(data.outcomes) ? data.outcomes : [];
  const rawTicketOutcomes = Array.isArray(data.ticket_outcomes) ? data.ticket_outcomes : [];
  const ticketScore = data.ticket_score;
  return {
    sessionId: Number(data.session_id ?? 0),
    scenarioId: String(data.scenario_id ?? ""),
    score: Number(data.score ?? 0),
    resolved: Boolean(data.resolved ?? false),
    createdAt: String(data.created_at ?? iso()),
    error: String(data.error ?? ""),
    notes: Array.isArray(data.notes) ? data.notes.map((note) => String(note)) : [],
    outcomes: rawOutcomes
      .filter((outcome): outcome is Record<string, unknown> => typeof outcome === "object" && outcome !== null)
      .map(checkOutcomeFromDict),
    machineScore: Number(data.machine_score ?? data.score ?? 0),
    ticketScore: ticketScore === null || ticketScore === undefined ? null : Number(ticketScore),
    ticketWeight: Number(data.ticket_weight ?? 0),
    ticketOutcomes: rawTicketOutcomes.filter(
      (outcome): outcome is Record<string, unknown> => typeof outcome === "object" && outcome !== null,
    ),
  };
}

/** A student's claimed VM. */
export interface LabSession {
  id: number | null;
  student: string;
  scenarioId: string;
  state: SessionState;
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
  createdAt: string;
  readyAt: string;
  expiresAt: string;
  lastActivityAt: string;
  /**
   * When the student handed the work in ("Complete & End"), or empty while the session is
   * still open. `passed`/`failed` cannot carry this on their own: the machine stays usable
   * after a check that resolved — that is what makes resolution sticky — so a student sits
   * in `passed` both before and after the submission.
   */
  completedAt: string;
  lastReport: ScoreReport | null;
  /**
   * The catalog entry the student picked. Empty means "the scenario's own default",
   * which is how scenarios built before the catalog existed keep working.
   */
  workload: string;
  /**
   * The time limit the student was given, in minutes. 0 means the site default
   * (`session.ttl_minutes`) was used. Kept so the portal can show what was granted
   * and so extending a session is auditable.
   */
  timeLimitMinutes: number;
}

export function newLabSession(fields: {
  student: string;
  scenarioId: string;
  id?: number | null;
  state?: SessionState;
}): LabSession {
  const now = iso();
  return {
    id: fields.id ?? null,
    student: fields.student,
    scenarioId: fields.scenarioId,
    state: fields.state ?? "requested",
    instance: "",
    hostIp: "",
    rdpUser: "",
    rdpPassword: "",
    hintLevel: 0,
    checksRun: 0,
    bestScore: 0,
    resolved: false,
    notes: "",
    error: "",
    createdAt: now,
    readyAt: "",
    expiresAt: "",
    lastActivityAt: now,
    completedAt: "",
    lastReport: null,
    workload: "",
    timeLimitMinutes: 0,
  };
}

/** Whether the clock the session was granted has run out. */
export function sessionIsExpired(session: LabSession, now: Date = new Date()): boolean {
  const expires = parseIso(session.expiresAt);
  return expires !== null && now.getTime() > expires.getTime();
}

/** Seconds left, floored at zero, or `null` when no deadline was recorded. */
export function sessionSecondsRemaining(session: LabSession, now: Date = new Date()): number | null {
  const expires = parseIso(session.expiresAt);
  if (expires === null) return null;
  return Math.max(0, Math.floor((expires.getTime() - now.getTime()) / 1000));
}

/**
 * Push the deadline out by `minutes`.
 *
 * Measured from whichever is later, the recorded deadline or now: extending a
 * session that already expired gives the student the full extension rather than
 * swallowing it into the past.
 */
export function sessionExtend(session: LabSession, minutes: number, now: Date = new Date()): LabSession {
  const expires = parseIso(session.expiresAt);
  const base = expires && expires.getTime() > now.getTime() ? expires : now;
  return {
    ...session,
    expiresAt: iso(new Date(base.getTime() + minutes * 60_000)),
    timeLimitMinutes: session.timeLimitMinutes ? session.timeLimitMinutes + minutes : 0,
  };
}

/** Reset the clock to `minutes` from now, used when a limit is chosen. */
export function sessionSetTimeLimit(session: LabSession, minutes: number, now: Date = new Date()): LabSession {
  return {
    ...session,
    timeLimitMinutes: minutes,
    expiresAt: iso(new Date(now.getTime() + minutes * 60_000)),
    lastActivityAt: iso(now),
  };
}

/**
 * The session as the portal and the CLI show it.
 *
 * `rdpUser`/`rdpPassword` are the guest credentials and are only included when a
 * caller asks: the student-facing JSON and every log must not carry them, and the
 * only caller that does is the one minting a console link.
 */
export function sessionToDict(session: LabSession, includeSecrets = false): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: session.id,
    student: session.student,
    scenario_id: session.scenarioId,
    state: session.state,
    instance: session.instance,
    host_ip: session.hostIp,
    hint_level: session.hintLevel,
    checks_run: session.checksRun,
    best_score: session.bestScore,
    resolved: session.resolved,
    error: session.error,
    created_at: session.createdAt,
    ready_at: session.readyAt,
    expires_at: session.expiresAt,
    last_activity_at: session.lastActivityAt,
    completed_at: session.completedAt,
    seconds_remaining: sessionSecondsRemaining(session),
    workload: session.workload,
    time_limit_minutes: session.timeLimitMinutes,
  };
  if (includeSecrets) {
    data.rdp_user = session.rdpUser;
    data.rdp_password = session.rdpPassword;
  }
  return data;
}
