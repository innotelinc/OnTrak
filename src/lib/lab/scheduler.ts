/**
 * Scheduled prewarming and teardown.
 *
 * A class starts at 09:00. If every student's first action is "provision me a VM",
 * the first five minutes are spent watching a clone bar and the host takes a burst
 * of load. Both problems disappear if the pool is warm before the class and drained
 * after it.
 *
 * So a schedule is a list of windows, and each window drives three things:
 *
 * * **prewarm** — fill the pool for its scenarios so a student gets a VM in seconds,
 * * **drain** — when the window ends, delete unclaimed pool VMs and recycle idle
 *   sessions,
 * * **guard** — keep the pool at target while the window is open (and only then).
 *
 * This is the TypeScript half of OnTrak-dev's `ontrak/scheduler.py`. The arithmetic
 * is separated from the executor on purpose — `LabSchedule.actions` decides,
 * `LabScheduler` performs — so every decision is provable without a hypervisor, and
 * that separation is the reason this file can be ported and tested before the session
 * manager exists.
 *
 * Names are the Python names with a `Lab` prefix where the bare word would be too
 * generic to export from a Next.js module (`Action`, `Window`, `Schedule`), and the
 * methods keep the Python spelling (`covers`, `inPrewarm`, `justEnded`,
 * `actionFor`, `actions`, `tick`).
 *
 * Two behaviours worth stating, because they are what makes the arithmetic safe:
 *
 * **The prewarm fills a deficit, never a target.** `pool` is the count of *unclaimed*
 * (handout-ready) VMs per scenario, so a class mid-session — where the pool is empty
 * because the students are all holding one — does not trigger a second wave of VMs.
 * The manager's `poolStatus().ready` is what feeds this, not `.total`.
 *
 * **The clock is a parameter.** Python compares naive local `datetime`s, so the
 * schedule is wall-clock local time in a site's own timezone; a `Date` built from
 * local components here (`new Date(2026, 8, 14, 9, 30)`) means the same instant it
 * meant there. Nothing in this file calls `Date.now()` below `tick`'s default, so a
 * test can travel to any moment it likes.
 *
 * Pure computation plus a small executor interface: no database, no hypervisor, no
 * I/O.
 */

import { iso } from "./models";

/** Index 0 is Monday, because that is what Python's `weekday()` returns. */
export const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayName = (typeof DAY_NAMES)[number];

/**
 * The spellings an operator may write for a day.
 *
 * Deliberately forgiving: a schedule is hand-edited YAML, and "Wednesday" or "weds"
 * meaning the same day as "wed" costs nothing, while refusing it teaches the operator
 * nothing about the lab.
 */
export const DAY_ALIASES: Record<string, DayName> = {
  mon: "mon",
  monday: "mon",
  tue: "tue",
  tues: "tue",
  tuesday: "tue",
  wed: "wed",
  weds: "wed",
  wednesday: "wed",
  thu: "thu",
  thur: "thu",
  thurs: "thu",
  thursday: "thu",
  fri: "fri",
  friday: "fri",
  sat: "sat",
  saturday: "sat",
  sun: "sun",
  sunday: "sun",
};

/** The weekdays, which are a window's days when it does not name any. */
export const DEFAULT_WINDOW_DAYS: readonly DayName[] = DAY_NAMES.slice(0, 5);

/** Raised for a schedule that cannot mean what it says. */
export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

export function parseDay(value: string): DayName {
  const key = String(value).trim().toLowerCase();
  const found = DAY_ALIASES[key];
  if (found) return found;
  throw new ScheduleError(`unknown day '${value}'; use ${DAY_NAMES.join(", ")}`);
}

/** One time of day, with the second-precision total `daySeconds` every comparison uses. */
export interface ClockTime {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** Seconds since local midnight. Ordering on this matches ordering on the wall clock. */
  readonly daySeconds: number;
}

export function parseTime(value: string): ClockTime {
  const text = String(value).trim();
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  const hour = Number(match?.[1] ?? Number.NaN);
  const minute = Number(match?.[2] ?? Number.NaN);
  const second = Number(match?.[3] ?? "0");
  const sane = (part: number, max: number): boolean =>
    Number.isInteger(part) && part >= 0 && part <= max;
  if (!sane(hour, 23) || !sane(minute, 59) || !sane(second, 59)) {
    throw new ScheduleError(`time '${value}' must look like HH:MM`);
  }
  return { hour, minute, second, daySeconds: hour * 3600 + minute * 60 + second };
}

/** The day a local `Date` falls on, in Python's Monday-first spelling. */
function dayOf(when: Date): DayName {
  // JS counts Sunday as 0; Python counts Monday as 0, so the week is rotated.
  const index = (when.getDay() + 6) % 7;
  // `index` is always 0..6; the fallback exists only to satisfy the type checker.
  return DAY_NAMES[index] ?? "mon";
}

function startOfDay(when: Date): Date {
  return new Date(when.getFullYear(), when.getMonth(), when.getDate());
}

function secondsOfDay(when: Date): number {
  return when.getHours() * 3600 + when.getMinutes() * 60 + when.getSeconds();
}

export interface WindowInit {
  readonly start?: string;
  readonly end?: string;
  readonly days?: readonly string[];
  readonly label?: string;
  readonly prewarmMinutes?: number;
  readonly target?: number;
  readonly scenarios?: readonly string[];
}

/**
 * A period during which the lab is expected to be busy.
 *
 * Validated at construction, so a window that cannot mean what it says — an end
 * before its start, a negative lead-in — fails when the config is read rather than at
 * 08:30 on the morning of a class.
 */
export class LabWindow {
  readonly label: string;
  readonly days: readonly DayName[];
  readonly start: string;
  readonly end: string;
  readonly prewarmMinutes: number;
  readonly target: number;
  readonly scenarios: readonly string[];
  readonly startTime: ClockTime;
  readonly endTime: ClockTime;

  constructor(init: WindowInit = {}) {
    this.label = init.label ?? "class";
    this.days = (init.days && init.days.length > 0 ? init.days : DEFAULT_WINDOW_DAYS).map(parseDay);
    this.start = init.start ?? "09:00";
    this.end = init.end ?? "12:00";
    this.prewarmMinutes = init.prewarmMinutes ?? 30;
    this.target = init.target ?? 2;
    this.scenarios = [...(init.scenarios ?? [])];
    this.startTime = parseTime(this.start);
    this.endTime = parseTime(this.end);
    if (this.endTime.daySeconds <= this.startTime.daySeconds) {
      throw new ScheduleError(`window '${this.label}': end must be after start`);
    }
    if (this.prewarmMinutes < 0) {
      throw new ScheduleError(`window '${this.label}': prewarm_minutes cannot be negative`);
    }
  }

  /** Is the window open at this instant? */
  covers(when: Date): boolean {
    if (!this.days.includes(dayOf(when))) return false;
    const at = secondsOfDay(when);
    return at >= this.startTime.daySeconds && at < this.endTime.daySeconds;
  }

  /**
   * Are we inside the prewarm lead-in for a window starting later today?
   *
   * Computed against absolute instants rather than times of day, so a lead-in that
   * starts before midnight still means what it says.
   */
  inPrewarm(when: Date): boolean {
    if (!this.days.includes(dayOf(when))) return false;
    const opens = startOfDay(when).getTime() + this.startTime.daySeconds * 1000;
    const begins = opens - this.prewarmMinutes * 60_000;
    const at = when.getTime();
    return begins <= at && at < opens;
  }

  /**
   * Did the window close recently? Drives the drain, once per tick.
   *
   * A window rather than an instant because a tick is not scheduled to the second: a
   * drain that only fired exactly at closing time would never fire at all.
   */
  justEnded(when: Date, withinMinutes = 15): boolean {
    if (!this.days.includes(dayOf(when))) return false;
    const closes = startOfDay(when).getTime() + this.endTime.daySeconds * 1000;
    const since = when.getTime() - closes;
    return since >= 0 && since < withinMinutes * 60_000;
  }

  toDict(): Record<string, unknown> {
    return {
      label: this.label,
      days: [...this.days],
      start: this.start,
      end: this.end,
      prewarm_minutes: this.prewarmMinutes,
      target: this.target,
      scenarios: [...this.scenarios],
    };
  }
}

export const ACTION_KINDS = ["prewarm", "drain-pool", "recycle-idle"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface ActionInit {
  readonly scenarioId?: string;
  readonly count?: number;
  readonly reason?: string;
}

/** One thing the scheduler has decided should happen. */
export class LabAction {
  readonly kind: ActionKind;
  readonly scenarioId: string;
  readonly count: number;
  readonly reason: string;

  constructor(kind: ActionKind, init: ActionInit = {}) {
    this.kind = kind;
    this.scenarioId = init.scenarioId ?? "";
    this.count = init.count ?? 0;
    this.reason = init.reason ?? "";
  }

  toDict(): Record<string, unknown> {
    return {
      kind: this.kind,
      scenario_id: this.scenarioId,
      count: this.count,
      reason: this.reason,
    };
  }
}

/** One session the manager believes is sitting idle, and for how long. */
export interface IdleSession {
  readonly id: number | null;
  readonly scenarioId: string;
  readonly idleMinutes: number;
}

export interface ActionsOptions {
  readonly pool?: Record<string, number>;
  readonly idleSessions?: readonly IdleSession[];
  readonly scenarios?: readonly string[];
  readonly idleMinutes?: number;
}

/** Python's default idle threshold in `Schedule.actions`; a caller with settings overrides it. */
export const DEFAULT_IDLE_MINUTES = 20;

export interface ScheduleInit {
  readonly windows?: readonly LabWindow[];
  readonly enabled?: boolean;
}

/**
 * The parsed schedule: a list of windows, and whether it runs at all.
 *
 * `enabled: false` is the operator's off switch and it is honoured before anything
 * else — a schedule that is switched off must not prewarm, drain or even report a
 * phase, which is why `actions` returns an empty list rather than "no window matches".
 */
export class LabSchedule {
  readonly windows: readonly LabWindow[];
  readonly enabled: boolean;

  constructor(init: ScheduleInit = {}) {
    this.windows = [...(init.windows ?? [])];
    this.enabled = init.enabled ?? true;
  }

  /**
   * Read a schedule out of config.
   *
   * Unknown keys are ignored rather than refused: this config is hand-edited and
   * shared between versions, so a key a newer build added must not stop an older one
   * from starting a class. `enabled` follows Python's `bool(...)` — a YAML `true`/
   * `false` is what it is meant to be given.
   */
  static fromConfig(data: unknown): LabSchedule {
    const record = isRecord(data) ? data : {};
    const rawWindows = Array.isArray(record.windows) ? record.windows : [];
    const windows: LabWindow[] = [];
    for (const raw of rawWindows) {
      if (!isRecord(raw)) continue;
      windows.push(new LabWindow(windowInitFrom(raw)));
    }
    return new LabSchedule({
      windows,
      enabled: record.enabled === undefined ? true : Boolean(record.enabled),
    });
  }

  toDict(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      windows: this.windows.map((window) => window.toDict()),
    };
  }

  /** What phase this instant is in, for operator visibility. */
  actionFor(when: Date): string {
    for (const window of this.windows) {
      if (window.covers(when)) return `open: ${window.label}`;
      if (window.inPrewarm(when)) return `prewarming for ${window.label}`;
      if (window.justEnded(when)) return `just closed: ${window.label}`;
    }
    return "idle";
  }

  /**
   * Work out what should happen right now.
   *
   * `pool` maps scenario id to the number of *available* (claimable) VMs, so the
   * prewarm only fills a genuine deficit — a class mid-session does not trigger a
   * second wave of VMs. A window with no scenarios of its own falls back to every
   * scenario the site has, which is what makes an unconfigured window still useful.
   */
  actions(when: Date, options: ActionsOptions = {}): LabAction[] {
    if (!this.enabled || this.windows.length === 0) return [];
    const pool = options.pool ?? {};
    const scenarios = options.scenarios ?? [];
    const idleMinutes = options.idleMinutes ?? DEFAULT_IDLE_MINUTES;
    const actions: LabAction[] = [];

    for (const window of this.windows) {
      const open = window.covers(when);
      if (!open && !window.inPrewarm(when)) continue;
      const phase = open ? "open" : "prewarm";

      const wanted = window.scenarios.length > 0 ? window.scenarios : scenarios;
      for (const scenarioId of wanted) {
        const have = whole(pool[scenarioId]);
        const deficit = window.target - have;
        if (deficit > 0) {
          actions.push(
            new LabAction("prewarm", {
              scenarioId,
              count: deficit,
              reason: `${phase} window '${window.label}' wants ${window.target}, pool has ${have}`,
            }),
          );
        }
      }

      if (open) {
        for (const session of options.idleSessions ?? []) {
          if (session.idleMinutes >= idleMinutes) {
            actions.push(
              new LabAction("recycle-idle", {
                scenarioId: session.scenarioId,
                count: 1,
                reason: `session ${session.id} idle ${session.idleMinutes} min during '${window.label}'`,
              }),
            );
          }
        }
      }
    }

    // The drain is separate from the window loop and runs even when no window is open
    // or prewarming: the whole point is that it fires in the minutes *after* a class,
    // when nothing else is true any more.
    if (this.windows.some((window) => window.justEnded(when))) {
      for (const scenarioId of Object.keys(pool).sort()) {
        const have = whole(pool[scenarioId]);
        if (have > 0) {
          actions.push(
            new LabAction("drain-pool", {
              scenarioId,
              count: have,
              reason: "class window closed; pooling VMs idle wastes host memory",
            }),
          );
        }
      }
    }

    return actions;
  }
}

/** Python's `int(...)`: a count from config, with anything unusable read as zero. */
function whole(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `Window` fields a config entry may set, read from its snake_case spelling.
 *
 * Only the keys the window actually has are copied — Python filters against
 * `Window.__dataclass_fields__` for the same reason.
 */
function windowInitFrom(raw: Record<string, unknown>): WindowInit {
  const init: {
    start?: string;
    end?: string;
    days?: readonly string[];
    label?: string;
    prewarmMinutes?: number;
    target?: number;
    scenarios?: readonly string[];
  } = {};
  if (typeof raw.label === "string") init.label = raw.label;
  if (typeof raw.start === "string") init.start = raw.start;
  if (typeof raw.end === "string") init.end = raw.end;
  if (Array.isArray(raw.days)) init.days = raw.days.map((day) => String(day));
  if (typeof raw.prewarm_minutes === "number") init.prewarmMinutes = raw.prewarm_minutes;
  if (typeof raw.target === "number") init.target = raw.target;
  if (Array.isArray(raw.scenarios)) init.scenarios = raw.scenarios.map((id) => String(id));
  return init;
}

/** Unclaimed (handout-ready) VMs per scenario, as the manager reports them. */
export interface PoolStatus {
  readonly scenarioId: string;
  readonly ready: number;
  readonly total: number;
}

/** The session a manager reports as a candidate for recycling. */
export interface ManagedSession {
  readonly id: number | null;
  readonly scenarioId: string;
}

/**
 * What the executor needs from a live session manager.
 *
 * Narrow on purpose: the scheduler decides *what* to do and this is the whole surface
 * it may reach through, so the decisions stay testable against a double and the
 * scheduler cannot quietly grow a second responsibility.
 *
 * `listInUseSessions` is the manager's filter, not this file's: the Python scheduler
 * asked the store for `SessionState.IN_USE` rows, and which states count as
 * recyclable remains the manager's rule.
 */
export interface SchedulerManager {
  readonly settings?: { readonly idleRecycleMinutes?: number } | undefined;
  poolStatus(): readonly PoolStatus[];
  prewarm(scenarioId: string, count: number): number;
  drainPool(scenarioId: string): number;
  listInUseSessions(): readonly ManagedSession[];
  sessionAgeMinutes(session: ManagedSession): number;
  scenarioIds?(): readonly string[];
}

export interface TickResult {
  /** When the tick thought it was, as an instant. */
  readonly when: string;
  readonly phase: string;
  readonly planned: Record<string, unknown>[];
  readonly performed: Record<string, unknown>[];
}

/** The lab's own default, used only when neither the caller nor the manager states one. */
export const DEFAULT_IDLE_RECYCLE_MINUTES = 20;

/**
 * Executes `LabSchedule.actions` against a live session manager.
 *
 * One tick is one decision plus its execution, and a step that throws does not stop
 * the rest: a host whose prewarm fails for one scenario still drains what the closed
 * window asked it to, and the failure comes back in the same result the operator is
 * already reading.
 */
export class LabScheduler {
  private readonly manager: SchedulerManager;
  private readonly schedule: LabSchedule;

  constructor(manager: SchedulerManager, schedule: LabSchedule) {
    this.manager = manager;
    this.schedule = schedule;
  }

  /**
   * Unclaimed (handout-ready) VMs per scenario.
   *
   * `ready` rather than `total`: VMs a student is currently using must not count
   * towards a window's target, or the prewarm would build a second wave and the drain
   * would try to delete a machine someone is working on.
   */
  private poolMap(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const status of this.manager.poolStatus()) {
      out[status.scenarioId] = Math.trunc(status.ready);
    }
    return out;
  }

  tick(when: Date = new Date(), options: { readonly idleMinutes?: number } = {}): TickResult {
    const idleMinutes =
      options.idleMinutes ??
      this.manager.settings?.idleRecycleMinutes ??
      DEFAULT_IDLE_RECYCLE_MINUTES;

    const available = this.poolMap();
    const scenarios = this.manager.scenarioIds ? [...this.manager.scenarioIds()] : [];
    const idle: IdleSession[] = this.manager.listInUseSessions().map((session) => ({
      id: session.id,
      scenarioId: session.scenarioId,
      idleMinutes: this.manager.sessionAgeMinutes(session),
    }));

    const plan = this.schedule.actions(when, {
      pool: available,
      idleSessions: idle,
      scenarios,
      idleMinutes,
    });

    const performed: Record<string, unknown>[] = [];
    for (const action of plan) {
      try {
        if (action.kind === "prewarm") {
          performed.push({
            ...action.toDict(),
            created: this.manager.prewarm(action.scenarioId, action.count),
          });
        } else if (action.kind === "drain-pool") {
          performed.push({
            ...action.toDict(),
            removed: this.manager.drainPool(action.scenarioId),
          });
        } else {
          performed.push({ ...action.toDict(), performed: true });
        }
      } catch (error) {
        // Keep going and report at the end: one scenario's failure is not the rest's.
        performed.push({
          ...action.toDict(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      when: iso(when),
      phase: this.schedule.actionFor(when),
      planned: plan.map((action) => action.toDict()),
      performed,
    };
  }
}
