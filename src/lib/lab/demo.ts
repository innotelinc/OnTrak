/**
 * Demo mode: the whole student flow, with no hypervisor and no Windows.
 *
 * Why this exists, in the Python's own words and unchanged: every question about the lab
 * ("what does a student actually see?", "does grading work?", "can we show this to the
 * training team on Thursday?") otherwise needs a Linux host with KVM, Incus and a 40-minute
 * Windows image build. Demo mode replaces the hypervisor with the in-memory one
 * (`memory.ts`) and the guest with a driver that reports plausible grading results, so the
 * lifecycle, the scoring and the instructor view can be exercised in seconds — and it is
 * the only end-to-end proof of the port available in this repository (see docs/lab-port.md
 * §4: there is no hypervisor here, which is exactly why the lab itself ships a demo mode).
 *
 * What it deliberately does **not** do: prove the Windows path works. That needs real
 * hardware, and a run of this is not evidence about a real VM booting or being graded.
 *
 * FOUR DIVERGENCES from `demo.py`, each because the port's own decisions require it:
 *
 * - **The store is in memory by default.** The Python wrote a SQLite file in a state
 *   directory (`state/ontrak.sqlite3`). This port has no SQLite: the store is either the
 *   in-memory one (default here) or the deployment's Postgres one, which a caller can pass.
 *   Demo mode's promise is "nothing to install", so the default has to be the one that
 *   needs no database — and `reset_state` disappears with the file it used to delete.
 * - **There is no lab user table to seed.** `seed_accounts` wrote rows into the lab's own
 *   `users` table; this app's identity supersedes it (§3/C2), and a second account table is
 *   a second place to revoke someone from. `demoAccounts` returns the roster of names the
 *   demo's students are, and creating real accounts is the app's own business (stage 3).
 * - **Write-ups are not synthesised yet.** `synthesise_ticket` reads a scenario's ticket
 *   rubric with `tickets.py`, which is stage 3's module; `complete` already says in the
 *   report that the write-up was not blended, so the demo runs the machine half honestly
 *   and the summary says so rather than inventing a blended score.
 * - **The guest's dice are deterministic, but they are not the Python's.** `random.Random`
 *   seeded with a string cannot be reproduced from TypeScript, so the demo uses its own
 *   small PRNG seeded with `(seed, scenario id)`. Same property that matters — a run is
 *   reproducible, and `success_rate` is what decides pass or partial credit — without
 *   pretending the sequence matches.
 */

import { BaseDriver, type CommandResult, type DriverOptions, type GuestSettings, type RunOptions } from "./guest";
import type { Catalog } from "./catalog";
import { defaultTimeLimit, loadSettings, type LabSettings } from "./config";
import { loadCatalog, loadScenarios } from "./dataset";
import { InMemoryIncus } from "./memory";
import { JSON_BEGIN, JSON_END, type ScoreReport } from "./models";
import { SETUP_OK_MARKER, type Scenario, type ScenarioRepository } from "./scenarios";
import { choose } from "./selection";
import { CONSOLE_SETUP_MARKER, SessionManager } from "./sessions";
import { InMemoryLabStore, type LabStore } from "./store";

/** The lab's demo roster. Six is what the Python shipped and what the portal offers. */
export const DEMO_STUDENTS: readonly string[] = [
  "student1",
  "student2",
  "student3",
  "student4",
  "student5",
  "student6",
];
export const DEMO_INSTRUCTOR = "instructor";

/* -------------------------------------------------------------------------- */
/*  The simulated guest                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A guest that answers plausibly instead of doing anything.
 *
 * Setup scripts report the success marker; check scripts report every objective the
 * scenario declares, passing with probability `successRate` — so a demo shows either a
 * clean pass or realistic partial credit, without a machine.
 */
export class DemoDriver extends BaseDriver {
  /**
   * The `null` transport's name, which is what this is at the transport layer: a guest that
   * answers without doing anything.
   *
   * `demo` is deliberately *not* added to the driver vocabulary: that list is what a
   * deployment may name in `guest.driver`, and a demo guest answers from a scenario
   * repository that configuration has no way to supply (see `buildDemoEnvironment`).
   */
  readonly name = "null" as const;

  /** Every call it was asked for, in order — what the tests assert against. */
  readonly calls: { instance: string; script: string }[] = [];
  readonly successRate: number;
  readonly seed: number;

  constructor(
    settings: GuestSettings,
    private readonly repository: ScenarioRepository,
    options: { successRate?: number; seed?: number } & DriverOptions = {},
  ) {
    super(settings, options);
    this.successRate = Math.max(0, Math.min(1, options.successRate ?? 1));
    this.seed = options.seed ?? 0;
  }

  /** The scenario a remote path belongs to, matched on the id inside the path. */
  private scenarioFor(remotePath: string): Scenario | null {
    for (const scenario of this.repository.list()) {
      if (remotePath.includes(scenario.id)) return scenario;
    }
    return null;
  }

  /** A check script's answer: the payload the grader reads, one outcome per objective. */
  private report(remotePath: string): CommandResult {
    const scenario = this.scenarioFor(remotePath);
    if (scenario === null) return ok("");
    const random = seededRandom(`${this.seed}:${scenario.id}`);
    const checks = scenario.objectives.map((objective) => {
      const passed = random() < this.successRate;
      return {
        objective: objective.id,
        passed,
        detail:
          `demo mode simulated ${passed ? "a correct fix" : "an incomplete fix"} ` +
          `(${objective.text.toLowerCase()})`,
      };
    });
    return ok(`${JSON_BEGIN}\n${JSON.stringify({ checks })}\n${JSON_END}`);
  }

  async runPowerShell(script: string, options: RunOptions = {}): Promise<CommandResult> {
    this.calls.push({ instance: options.instance ?? "", script: script.slice(0, 200) });
    if (script.includes("setup.ps1")) return ok(`demo setup applied\n${SETUP_OK_MARKER}`);
    if (script.includes("check.ps1")) return this.report(script);
    return ok("ok");
  }

  /**
   * The shell transport, for the Linux half of the catalogue.
   *
   * A demo that only spoke PowerShell could not exercise Linux at all — and Linux is where
   * the CLI lessons live, so the simulated guest answers both. The console-transport reply
   * stands in for the template build's sshd installer, without which a demo with
   * `guac.linux_ssh` on would die at the first snapshot instead of running.
   */
  async runShell(script: string, options: RunOptions = {}): Promise<CommandResult> {
    this.calls.push({ instance: options.instance ?? "", script: script.slice(0, 200) });
    if (script.includes("setup.sh")) return ok(`demo setup applied\n${SETUP_OK_MARKER}`);
    if (script.includes("check.sh")) return this.report(script);
    if (script.includes(CONSOLE_SETUP_MARKER)) {
      return ok(`demo console transport installed\n${CONSOLE_SETUP_MARKER}`);
    }
    return ok("ok");
  }

  /** Both platforms' scripts by file name, so one demo drives PowerShell and shell. */
  override async runScriptFile(remotePath: string, options: RunOptions = {}): Promise<CommandResult> {
    this.calls.push({ instance: options.instance ?? "", script: `run:${remotePath}` });
    if (/setup\.(ps1|sh)$/.test(remotePath)) return ok(`demo setup applied\n${SETUP_OK_MARKER}`);
    if (/check\.(ps1|sh)$/.test(remotePath)) return this.report(remotePath);
    return ok("ok");
  }

  /** Nothing to wait for: the simulated guest is up the moment it is asked. */
  async waitReady(): Promise<boolean> {
    return true;
  }

  /** An upload that is recorded rather than performed, as the Python's `_write_bytes` was. */
  override async uploadFile(
    localPath: string,
    remotePath: string,
    options: RunOptions = {},
  ): Promise<CommandResult> {
    this.calls.push({ instance: options.instance ?? "", script: `upload:${localPath}->${remotePath}` });
    return ok("demo upload");
  }
}

/** A result that succeeded and says nothing, which is most of what a simulated guest says. */
function ok(stdout: string): CommandResult {
  return { ok: true, exitCode: 0, stdout, stderr: "", duration: 0 };
}

/**
 * A small deterministic PRNG (mulberry32 seeded by FNV-1a over the label).
 *
 * Deliberately not `Math.random`: a demo run has to be reproducible so a class can be
 * shown twice and the numbers match, and so a test can assert what `successRate` did.
 */
function seededRandom(label: string): () => number {
  let state = 2166136261;
  for (const character of label) {
    state ^= character.codePointAt(0) ?? 0;
    state = Math.imul(state, 16777619);
  }
  state >>>= 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/* -------------------------------------------------------------------------- */
/*  The environment                                                           */
/* -------------------------------------------------------------------------- */

export interface DemoEnvironment {
  settings: LabSettings;
  store: LabStore;
  catalog: Catalog;
  repository: ScenarioRepository;
  incus: InMemoryIncus;
  driver: DemoDriver;
  manager: SessionManager;
}

export interface DemoOptions {
  settings?: LabSettings;
  /** The store. Defaults to the in-memory one: demo mode needs no database. */
  store?: LabStore;
  /** The scenario tree. Defaults to the shipped `scenarios/`. */
  scenarioDir?: string;
  /** The ported catalogue/lesson JSON. Defaults to `src/lib/lab/data`. */
  dataDir?: string;
  successRate?: number;
  seed?: number;
  students?: number;
  clock?: () => Date;
  sleep?: (seconds: number) => Promise<void>;
}

/** Wire a manager that runs entirely in memory (no hypervisor, no database, no Windows). */
export function buildDemoEnvironment(options: DemoOptions = {}): DemoEnvironment {
  const settings = options.settings ?? loadSettings({ env: { ...process.env, ONTRAK_DEMO__ENABLED: "true" } });
  const repository = loadScenarios(options.scenarioDir);
  const catalog = loadCatalog(options.dataDir);
  const store = options.store ?? new InMemoryLabStore();

  const incus = new InMemoryIncus(settings.incus.imageAlias, true);
  // Pretend the images a scenario names are published on this host. Standing in for the
  // infrastructure is the whole job: an alias that exists is exactly what a real host has
  // after `ontrak image build`, and without it every catalogue-backed scenario would fail a
  // host check the demo has no way to satisfy.
  for (const entry of catalog.load().values()) {
    incus.addImage(entry.imageAlias);
  }
  // `addImage` also moves the "current" alias, which would leave the site's golden image
  // unpublished; put it back so scenarios with no declared platform still find theirs.
  incus.addImage(settings.incus.imageAlias);
  incus.imageAlias = settings.incus.imageAlias;

  const driver = new DemoDriver(settings.guest, repository, {
    successRate: options.successRate ?? settings.demo.successRate,
    seed: options.seed ?? settings.selection.seed,
  });
  const manager = new SessionManager({
    settings,
    store,
    repository,
    catalog,
    incus,
    driver,
    // The same simulated guest answers shell and PowerShell, so a Linux scenario runs
    // through the real manager, scoring and grading path in demo mode too.
    shellDriver: driver,
    clock: options.clock,
    sleep: options.sleep,
  });
  return { settings, store, catalog, repository, incus, driver, manager };
}

/**
 * The names a demo sign-in may choose from: the students, then the instructor.
 *
 * Shared by the roster's owner (this module) and the portal's demo door (stage 3), so the
 * two cannot disagree about who exists — and computed from the settings the same way the
 * Python's `account_names` was, including the clamp to the six the lab shipped.
 */
export function demoAccounts(settings: LabSettings, students?: number): string[] {
  const wanted = students ?? settings.demo.students;
  const count = Math.max(1, Math.min(Math.trunc(wanted), DEMO_STUDENTS.length));
  return [...DEMO_STUDENTS.slice(0, count), DEMO_INSTRUCTOR];
}

/**
 * Make every scenario startable, the way `runDemo` makes the class's own.
 *
 * The portal refuses a scenario whose template has no `clean` snapshot and whose pool is
 * empty, which is every scenario on a freshly built demo environment — so building the
 * templates up front is what keeps a demo portal honest about the flow it exists to show.
 * Goes through `buildTemplates` rather than `seedPool` so one pair the simulated guest
 * cannot build is reported as that scenario's own failure, which the dashboard then
 * explains, instead of taking the whole portal down before it serves a page.
 */
export async function seedRange(
  env: DemoEnvironment,
  scenarioIds?: readonly string[],
): Promise<Record<string, string>> {
  const ids = scenarioIds ?? env.repository.list().map((scenario) => scenario.id);
  return await env.manager.buildTemplates(ids);
}

/**
 * Build a template for every (scenario, workload) pair, prewarming only some.
 *
 * Templates are per pair because the same fault on Windows 11 and on Ubuntu are different
 * machines. Every pair is built because automatic assignment can hand a student any
 * scenario; only the nominated scenarios get warm VMs, which is what a real lab does to
 * keep host memory under control. Returns `{"<scenario>[@<workload>]": warmCount}`.
 */
export async function seedPool(
  env: DemoEnvironment,
  scenarioIds: readonly string[],
  options: { perScenario?: number; prewarmIds?: readonly string[] | null } = {},
): Promise<Record<string, number>> {
  const perScenario = options.perScenario ?? 2;
  const warm = new Set(options.prewarmIds ?? scenarioIds);
  const built: Record<string, number> = {};
  for (const { scenario, workload } of env.manager.workloadPairs(scenarioIds)) {
    const key = workload ? `${scenario.id}@${workload}` : scenario.id;
    await env.manager.ensureTemplate(scenario.id, { workload });
    built[key] = warm.has(scenario.id)
      ? await env.manager.prewarm(scenario.id, perScenario, workload)
      : 0;
  }
  return built;
}

/* -------------------------------------------------------------------------- */
/*  The run                                                                   */
/* -------------------------------------------------------------------------- */

export interface DemoRosterRow {
  student: string;
  scenarioId: string;
  reason: string;
  instance: string;
  state: string;
  error: string;
  minutes: number;
}

export interface DemoCompletedRow {
  student: string;
  scenarioId: string;
  score: number;
  machineScore: number;
  ticketScore: number | null;
  resolved: boolean;
  state: string;
}

export interface DemoGradedRow {
  student: string;
  scenarioId: string;
  previewScore: number;
  previewResolved: boolean;
}

export interface DemoSummary {
  students: DemoRosterRow[];
  scenarios: string[];
  pool: Record<string, number>;
  graded: DemoGradedRow[];
  completed: DemoCompletedRow[];
  stats: Record<string, unknown>;
  /** Each demo student's stored results, which is what a results page would show. */
  results: { student: string; reports: ScoreReport[] }[];
  /** What this run did *not* do, said out loud rather than left to be inferred. */
  notes: string[];
}

export interface RunDemoOptions extends DemoOptions {
  scenarioIds?: readonly string[];
  /** Check every session, then hand it in. `false` stops after the preview check. */
  completeSessions?: boolean;
  /** Synthesising a write-up needs the ticket module (stage 3); see the header. */
  writeUps?: boolean;
  verbose?: boolean;
  /** Where the rendered summary goes. Defaults to `process.stdout`. */
  log?: (line: string) => void;
}

/**
 * Drive a complete class: assign, provision, grade, hand in, tear down.
 *
 * Returns a summary rather than only printing one, so the caller — a CLI script, a test, a
 * notebook — does not have to scrape stdout. `completeSessions: false` is the Python's
 * shape for "show me provisioning without burning the class's machines".
 */
export async function runDemo(options: RunDemoOptions = {}): Promise<DemoSummary> {
  const env = buildDemoEnvironment(options);
  const repository = env.repository;
  const chosen = options.scenarioIds ? [...options.scenarioIds] : repository.list().slice(0, 3).map((s) => s.id);
  if (chosen.length === 0) {
    throw new Error("no scenarios found; nothing to demonstrate");
  }

  const names = demoAccounts(env.settings, options.students);
  // The instructor is not a demo student: handing them a machine would put a session in the
  // roster that no student ever had, which is the sort of thing a demo should not show.
  const students = names.filter((name) => name !== DEMO_INSTRUCTOR);

  const completeSessions = options.completeSessions ?? true;
  const summary: DemoSummary = {
    students: [],
    scenarios: chosen,
    pool: await seedPool(env, repository.list().map((scenario) => scenario.id), {
      perScenario: 2,
      prewarmIds: chosen,
    }),
    graded: [],
    completed: [],
    stats: {},
    results: [],
    notes: [],
  };

  // An explicit scenario list means "use these"; automatic assignment is only for when the
  // caller does not care which ticket a student gets.
  const autoAssign = env.settings.selection.autoAssign && options.scenarioIds === undefined;
  const history: string[] = [];
  for (const [index, student] of students.entries()) {
    let scenarioId: string;
    let reason: string;
    if (autoAssign) {
      const choice = choose(
        repository.list(),
        null,
        history,
        env.settings.selection.strategy,
        env.settings.selection.maxDifficulty,
        env.settings.selection.seed + index,
      );
      scenarioId = choice.scenario.id;
      reason = choice.explain();
    } else {
      scenarioId = chosen[index % chosen.length] ?? "";
      reason = "rotated from the requested list";
    }
    history.push(scenarioId);

    const session = await env.manager.allocate(student, scenarioId, {
      timeLimitMinutes: defaultTimeLimit(env.settings.session),
    });
    summary.students.push({
      student,
      scenarioId,
      reason,
      instance: session.instance,
      state: session.state,
      error: session.error,
      minutes: session.timeLimitMinutes,
    });
    if (session.state === "error") continue;

    // A student checks their work (not recorded), then hands it in (recorded). The write-up
    // is not synthesised yet (stage 3), so the submitted grade is the machine half and the
    // report says so — see the header.
    const preview = await env.manager.runChecks(session);
    if (completeSessions) {
      const final = await env.manager.complete(session);
      summary.completed.push({
        student,
        scenarioId,
        score: final.score,
        machineScore: final.machineScore,
        ticketScore: final.ticketScore,
        resolved: final.resolved,
        state: session.state,
      });
    }
    summary.graded.push({
      student,
      scenarioId,
      previewScore: preview.score,
      previewResolved: preview.resolved,
    });
  }

  summary.stats = await env.manager.stats();
  // The Python read its store's leaderboard. The port's store contract has no such read
  // (nothing has needed one yet), and inventing an interface method for the demo's last
  // line would be a shape nobody asked for — so this asks per student, which is also what a
  // results page does.
  summary.results = [];
  for (const student of students) {
    summary.results.push({ student, reports: await env.store.resultsForStudent(student) });
  }
  summary.notes.push(
    completeSessions
      ? "write-ups were not synthesised (the ticket module is stage 3), so each submitted grade is the machine half"
      : "sessions were checked but not handed in; only a submission is stored",
  );

  if ((options.verbose ?? true) === true) {
    const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
    log(renderDemoSummary(summary));
  }
  return summary;
}

/** The run as a text report, laid out the way the Python's did. */
export function renderDemoSummary(summary: DemoSummary): string {
  const lines = ["", "OnTrak demo run", "=".repeat(60)];
  lines.push(`scenarios: ${summary.scenarios.join(", ")}`);
  const pool = Object.entries(summary.pool ?? {}).filter(([, count]) => count > 0);
  if (pool.length > 0) {
    lines.push(`warm pool: ${pool.map(([key, count]) => `${key} x${count}`).join(", ")}`);
  }
  lines.push("");
  lines.push(`${"student".padEnd(10)} ${"scenario".padEnd(24)} ${"instance".padEnd(28)} state`);
  for (const row of summary.students) {
    lines.push(
      `${row.student.padEnd(10)} ${row.scenarioId.padEnd(24)} ` +
        `${(row.instance || "-").padEnd(28)} ${row.state}` +
        (row.error ? `  ERROR: ${row.error}` : ""),
    );
  }
  if (summary.completed.length > 0) {
    lines.push("");
    lines.push(`${"student".padEnd(10)} ${"scenario".padEnd(24)} ${"score".padStart(6)}  outcome`);
    for (const row of summary.completed) {
      const outcome = row.resolved ? "passed" : "not resolved";
      lines.push(
        `${row.student.padEnd(10)} ${row.scenarioId.padEnd(24)} ` +
          `${Math.round(row.score).toString().padStart(5)}%  ${outcome}`,
      );
    }
  }
  lines.push("", "Only the submitted grade is stored; the preview check was discarded.");
  for (const note of summary.notes) lines.push(`note: ${note}`);
  lines.push("");
  return lines.join("\n");
}
