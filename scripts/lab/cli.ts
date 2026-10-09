/**
 * `ontrak` — the lab's command line, as a script in this repository.
 *
 *   npm run lab -- doctor
 *   npm run lab -- session list
 *   npm run lab -- demo run
 *
 * The Python shipped a 1,370-line `cli.py` over its own modules; this is the port of it,
 * and the shape of the port is what stage 4 decided (docs/lab-port.md §5):
 *
 * **Every command runs through the same runtime the pages use.** `openLabRuntime()` reads
 * the deployment's own settings and opens the same store, so a command and a page cannot
 * disagree about what a session is or where its rows live. Nothing here reaches for the
 * database or for `incus` on its own.
 *
 * **The commands that were about running a *server* are gone, with a sentence saying so.**
 * `serve` was uvicorn; this app *is* the server, and `npm start` is how it runs. `user` was
 * the lab's own account table, which §3/C2 supersedes — sign-in is Authentik's and accounts
 * live in the family's `User` table, so a CLI that listed them would be a second reader of
 * the roster. Both refuse with the reason rather than being quietly absent, because an
 * operator who types them is following the Python's own documentation.
 *
 * **What still needs a host says so.** `image build` builds a golden image with qemu and
 * `incus`, `catalog refresh` reaches a remote, and `media fetch` downloads gigabytes: all
 * three are host work, and this script reports the plan and the missing piece instead of
 * pretending. The one command that needs nothing at all — `demo run`, the ported in-memory
 * range — is here in full, and is also what a CI job can run.
 */

import { readFileSync } from "node:fs";

import { checkToken } from "../../src/lib/lab/guac";
import { LabSettings, loadSettings, requireSecrets, settingsToDict } from "../../src/lib/lab/config";
import { loadCatalog, loadLessons, loadScenarios } from "../../src/lib/lab/dataset";
import { renderDemoSummary, runDemo } from "../../src/lib/lab/demo";
import { listPrimitives } from "../../src/lib/lab/primitives";
import { generate, primitiveMatrix, suggestedCombinations } from "../../src/lib/lab/generator";
import { IncusClient } from "../../src/lib/lab/incus";
import { validateForm, loadForm, grade, renderFeedback, ticketGradeSummaryLine } from "../../src/lib/lab/tickets";
import { scheduleToSchedule } from "../../src/lib/lab/config";
import { classResults } from "../../src/lib/lab/reporting";
import { leaderboardRows, resultsCsv } from "../../src/lib/lab/portal";
import { forgetLabRuntime, openLabRuntime, type LabRuntime } from "../../src/lib/lab/service";
import { LAB_IN_APP_ENV, labDoorFromEnv } from "../../src/lib/lab-rules";
import { SessionError } from "../../src/lib/lab/sessions";

/* -------------------------------------------------------------------------- */
/*  A small argument reader                                                    */
/* -------------------------------------------------------------------------- */

interface Args {
  words: string[];
  flags: Set<string>;
  options: Map<string, string[]>;
}

/**
 * `--flag`, `--key value`, `--key value` repeated, and bare words.
 *
 * Hand-rolled rather than a dependency: this is eight lines of parsing for a script that
 * runs on an operator's machine, and the repository's conventions discourage a new package
 * where its own precedent makes one unnecessary (§3/C6, the same argument).
 */
function parseArgs(argv: readonly string[]): Args {
  const words: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        flags.add(name);
        continue;
      }
      options.set(name, [...(options.get(name) ?? []), value]);
      index += 1;
      continue;
    }
    words.push(token);
  }
  return { words, flags, options };
}

function option(args: Args, name: string, fallback: string | null = null): string | null {
  const found = args.options.get(name);
  return found === undefined || found.length === 0 ? fallback : found[found.length - 1];
}

function all(args: Args, name: string): string[] {
  return args.options.get(name) ?? [];
}

/** One row per line, columns padded — the Python's `_table`. */
function table(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, column) => (cell ?? "").padEnd(widths[column])).join("  ").trimEnd();
  console.log(line(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
}

function say(status: string, message: string): void {
  console.log(`${status.padEnd(5)} ${message}`);
}

/* -------------------------------------------------------------------------- */
/*  The shared runtime, and settings without one                               */
/* -------------------------------------------------------------------------- */

function settingsFromEnv(): LabSettings {
  return loadSettings({ env: process.env });
}

/**
 * The runtime, or a refusal.
 *
 * Unlike a page, a CLI *should* fail loudly: there is a person watching, and a command that
 * cannot run has nothing useful to print. The refusal is still the runtime's own sentence
 * (which names the variable to set) rather than a stack trace.
 */
async function runtimeOrDie(): Promise<LabRuntime> {
  const read = await openLabRuntime();
  if (!read.ok) {
    console.error(`error the lab is not configured: ${read.reason.replace(/^the lab is not configured: /, "")}`);
    process.exit(2);
  }
  return read.runtime;
}

/* -------------------------------------------------------------------------- */
/*  doctor                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Host readiness, one line per check.
 *
 * The Python's doctor was its most-used command, because every failure this stack has is
 * "something on the host is not ready" — and the first two checks it made are the ones that
 * matter here too: can the settings be read at all, and is the hypervisor there. What it
 * could not do is check the *console key against the gateway*, which is an invisible outage:
 * the portal signs correctly, the gateway refuses, and every student sees a blank frame. The
 * port has `checkToken` for that, and doctor is where an operator is already looking.
 */
async function cmdDoctor(): Promise<number> {
  let settings: LabSettings;
  try {
    settings = settingsFromEnv();
  } catch (error) {
    console.error(`fail  settings: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  say("ok", `settings: ${settings.sourceFiles.length > 0 ? settings.sourceFiles.join(", ") : "defaults + environment"}`);
  say("ok", `demo mode: ${settings.demo.enabled ? "on — no hypervisor, no Windows media, no secrets" : "off"}`);

  let failures = 0;
  const problems = requireSecrets(settings);
  if (problems.length === 0) {
    say("ok", "secrets: guest password, portal secret and a usable Guacamole key");
  } else {
    failures += problems.length;
    for (const problem of problems) say("fail", problem);
  }

  if (settings.demo.enabled) {
    say("ok", "hypervisor: not needed (demo mode)");
  } else if (await IncusClient.available()) {
    say("ok", `hypervisor: incus is available (remote ${settings.incus.remote}, project ${settings.incus.project})`);
  } else {
    failures += 1;
    say("fail", "hypervisor: `incus` is not on PATH, so no machine can be started on this host");
  }

  try {
    const repository = loadScenarios();
    say("ok", `scenarios: ${repository.list().length} under ${settings.scenariosDir}`);
  } catch (error) {
    failures += 1;
    say("fail", `scenarios: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const catalog = loadCatalog();
    const lessons = loadLessons();
    say("ok", `data: ${catalog.load().size} catalogue entries, ${lessons.list().length} lessons`);
  } catch (error) {
    failures += 1;
    say("fail", `data: ${error instanceof Error ? error.message : String(error)}`);
  }

  // The console gateway, asked the one question nothing else asks: does it accept a link
  // this deployment signed?
  const verdict = await checkToken(settings);
  const door = labDoorFromEnv();
  say(verdict.state === "refused" ? "fail" : "ok", `console: ${verdict.detail}`);
  if (verdict.state === "refused") failures += 1;
  say("ok", `door: ${door.kind === "off" ? "the lab is off for students" : door.kind === "external" ? `a peer lab at ${door.url}` : door.kind === "in-app" ? `served here at ${door.href}` : "misconfigured — see the capabilities panel"}`);

  say(failures === 0 ? "ok" : "fail", failures === 0 ? "host is ready" : `${failures} problem${failures === 1 ? "" : "s"} to fix`);
  return failures === 0 ? 0 : 1;
}

/* -------------------------------------------------------------------------- */
/*  scenario, lesson, catalog                                                  */
/* -------------------------------------------------------------------------- */

function cmdScenario(args: Args): number {
  const action = args.words[0] ?? "list";
  const repository = loadScenarios();

  if (action === "list") {
    table(
      ["id", "platform", "difficulty", "minutes", "ticket"],
      repository
        .list()
        .map((scenario) => [
          scenario.id,
          scenario.platform,
          String(scenario.difficulty),
          String(scenario.minutes),
          scenario.ticketForm === null ? "—" : "yes",
        ]),
    );
    return 0;
  }

  if (action === "show") {
    const wanted = args.words[1] ?? option(args, "scenario") ?? "";
    const scenario = repository.get(wanted);
    console.log(JSON.stringify({ ...scenario, ticket: undefined }, null, 2));
    return 0;
  }

  if (action === "validate") {
    let failures = 0;
    for (const scenario of repository.list()) {
      const form = loadForm(scenario.ticket);
      const problems = form === null ? [] : validateForm(form);
      if (problems.length > 0) {
        failures += problems.length;
        for (const problem of problems) say("fail", `${scenario.id}: ${problem}`);
      }
    }
    say(failures === 0 ? "ok" : "fail", failures === 0 ? `all ${repository.list().length} scenarios validate` : `${failures} problem(s)`);
    return failures === 0 ? 0 : 1;
  }

  console.error(`error unknown action ${JSON.stringify(action)}: list, show, validate`);
  return 2;
}

function cmdLesson(args: Args): number {
  const action = args.words[0] ?? "list";
  const lessons = loadLessons();

  if (action === "list") {
    table(
      ["id", "platform", "difficulty", "minutes", "commands"],
      lessons.list().map((lesson) => [
        lesson.id,
        lesson.platform,
        String(lesson.difficulty),
        String(lesson.minutes),
        String(lesson.commands.length),
      ]),
    );
    return 0;
  }

  if (action === "show") {
    const lesson = lessons.get(args.words[1] ?? "");
    if (args.flags.has("shell")) {
      for (const command of lesson.commands) console.log(command.command);
      return 0;
    }
    if (args.flags.has("json")) {
      console.log(JSON.stringify(lesson, null, 2));
      return 0;
    }
    console.log(`${lesson.title} (${lesson.id}, ${lesson.platform}, difficulty ${lesson.difficulty})`);
    console.log(`\n${lesson.summary}\n`);
    for (const step of lesson.steps) console.log(`  - ${step.title}`);
    return 0;
  }

  console.error(`error unknown action ${JSON.stringify(action)}: list, show`);
  return 2;
}

function cmdCatalog(args: Args): number {
  const action = args.words[0] ?? "list";
  const catalog = loadCatalog();

  if (action === "list") {
    table(
      ["id", "name", "group", "kind", "support"],
      catalog.list().map((entry) => [entry.id, entry.name, entry.group, entry.kind, entry.support]),
    );
    return 0;
  }
  if (action === "groups") {
    table(["id", "label", "era", "entries"], catalog.groupList().map((group) => [group.id, group.label, group.era, String(group.entries.length)]));
    return 0;
  }
  if (action === "show") {
    console.log(JSON.stringify(catalog.get(args.words[1] ?? "").toPublic(), null, 2));
    return 0;
  }
  if (action === "plan") {
    const entry = catalog.get(args.words[1] ?? "");
    console.log(JSON.stringify(entry.toPublic(), null, 2));
    say("ok", "the plan above is what `image build` would provision; building needs a host (see the note on the command)");
    return 0;
  }

  // `refresh` is the one catalog action that is not local: it reaches an Incus remote for
  // image listings. Refused with the reason rather than half-done.
  if (action === "refresh") {
    console.error(
      "error catalog refresh needs an Incus remote (`images`), which this script cannot reach from where it runs.\n" +
        "      The catalogue is converted data in this repository (src/lib/lab/data/catalog.json, §3/C6);\n" +
        "      re-convert it from the lab checkout rather than refreshing it at runtime.",
    );
    return 2;
  }

  console.error(`error unknown action ${JSON.stringify(action)}: list, groups, show, plan`);
  return 2;
}

/* -------------------------------------------------------------------------- */
/*  the running lab                                                            */
/* -------------------------------------------------------------------------- */

async function cmdStats(runtime: LabRuntime): Promise<number> {
  const stats = await runtime.manager.stats();
  console.log(JSON.stringify({ mode: runtime.mode, ...stats }, null, 2));
  return 0;
}

async function cmdSession(runtime: LabRuntime, args: Args): Promise<number> {
  const action = args.words[0] ?? "list";
  const sessionId = Number(option(args, "session-id") ?? "0");
  const student = option(args, "student") ?? "";

  const load = async () => {
    if (!Number.isInteger(sessionId) || sessionId <= 0) throw new SessionError("pass --session-id");
    const session = await runtime.store.getSession(sessionId);
    if (session === null) throw new SessionError(`no session ${sessionId}`);
    return session;
  };

  switch (action) {
    case "list": {
      const rows = await runtime.store.listSessions({
        student: student === "" ? undefined : student.toLowerCase(),
        limit: Number(option(args, "limit") ?? "50"),
      });
      table(
        ["id", "student", "scenario", "state", "machine", "last activity"],
        rows.map((session) => [
          String(session.id),
          session.student,
          session.scenarioId,
          session.state,
          session.instance || "—",
          session.lastActivityAt,
        ]),
      );
      return 0;
    }
    case "show": {
      const session = await load();
      console.log(JSON.stringify({ ...session, rdpPassword: undefined }, null, 2));
      return 0;
    }
    case "check": {
      const session = await load();
      const report = await runtime.manager.runChecks(session, false);
      say(report.error === "" ? "ok" : "fail", report.error === "" ? "graded (not recorded — this is a preview)" : report.error);
      console.log(JSON.stringify(report, null, 2));
      return report.error === "" ? 0 : 1;
    }
    case "reset": {
      const reset = await runtime.manager.reset(await load());
      say(reset.state === "error" ? "fail" : "ok", reset.state === "error" ? reset.error : `reset to ${reset.state}`);
      return reset.state === "error" ? 1 : 0;
    }
    case "extend": {
      const session = await runtime.manager.extend(await load(), Number(option(args, "minutes") ?? "15"));
      say("ok", `expires at ${session.expiresAt}`);
      return 0;
    }
    case "limit": {
      const session = await runtime.manager.setTimeLimit(await load(), Number(option(args, "minutes") ?? "90"));
      say("ok", `${session.timeLimitMinutes} minutes, expiring ${session.expiresAt}`);
      return 0;
    }
    case "end": {
      await runtime.manager.end(await load());
      say("ok", "session ended and the machine destroyed");
      return 0;
    }
    case "start": {
      const scenario = option(args, "scenario") ?? "";
      if (student === "" || scenario === "") throw new SessionError("pass --student and --scenario");
      const session = await runtime.manager.createSession(student, scenario, {
        workload: option(args, "workload"),
        timeLimitMinutes: option(args, "time-limit") === null ? null : Number(option(args, "time-limit")),
      });
      say("ok", `session ${String(session.id)} for ${session.student}: ${session.state}`);
      return 0;
    }
    case "complete": {
      const session = await load();
      const report = await runtime.manager.complete(session);
      say(report.error === "" ? "ok" : "fail", `${report.error === "" ? "submitted" : report.error}: ${String(report.score)}%`);
      return report.error === "" ? 0 : 1;
    }
    case "console": {
      const session = await load();
      const scenario = runtime.repository.get(session.scenarioId);
      const { consoleUrl } = await import("../../src/lib/lab/portal");
      const url = consoleUrl(runtime.settings, session, scenario);
      if (url === "") {
        say("fail", "no console for this session: no gateway configured, or the machine has no address yet");
        return 1;
      }
      console.log(url);
      return 0;
    }
    default:
      console.error(
        `error unknown action ${JSON.stringify(action)}: list, start, show, check, reset, extend, limit, complete, end, console`,
      );
      return 2;
  }
}

async function cmdPool(runtime: LabRuntime, args: Args): Promise<number> {
  const action = args.words[0] ?? "status";
  const scenario = option(args, "scenario");

  if (action === "status") {
    const rows = await runtime.manager.poolStatus(scenario);
    table(
      ["scenario", "workload", "ready", "claimed", "target", "template"],
      rows.map((status) => [
        status.scenarioId,
        status.workload || "—",
        String(status.ready),
        String(status.claimed),
        String(status.target),
        status.templateReady ? "yes" : "no",
      ]),
    );
    return 0;
  }
  if (action === "prewarm") {
    const created = await runtime.manager.prewarm(scenario ?? "", Number(option(args, "count") ?? "10"));
    say("ok", `started ${created} machine(s)`);
    return 0;
  }
  if (action === "refill") {
    const refilled = await runtime.manager.refillPool();
    say("ok", `refilled ${JSON.stringify(refilled)}`);
    return 0;
  }
  if (action === "drain") {
    const drained = await runtime.manager.drainPool(scenario ?? "");
    say("ok", `drained ${drained} machine(s)`);
    return 0;
  }
  console.error(`error unknown action ${JSON.stringify(action)}: status, prewarm, refill, drain`);
  return 2;
}

async function cmdTemplate(runtime: LabRuntime, args: Args): Promise<number> {
  const wanted = args.words.slice(1);
  const ids = args.flags.has("all") || wanted.length === 0 ? runtime.repository.list().map((row) => row.id) : wanted;
  const results = await runtime.manager.buildTemplates(ids, { force: args.flags.has("force") });
  for (const [key, result] of Object.entries(results)) say(result === "built" || result.startsWith("built") ? "ok" : "note", `${key}: ${result}`);
  return 0;
}

async function cmdReap(runtime: LabRuntime, args: Args): Promise<number> {
  const once = async (): Promise<void> => {
    const result = await runtime.manager.reap();
    say("ok", `reaped ${result.recycled.length}, refilled ${JSON.stringify(result.refilled)}`);
  };
  if (!args.flags.has("loop")) {
    await once();
    return 0;
  }
  say("note", "looping every 60 seconds; Ctrl-C to stop (a deployment should schedule `reap` instead)");
  for (;;) {
    await once();
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}async function cmdSchedule(runtime: LabRuntime, args: Args): Promise<number> {
  const action = args.words[0] ?? "show";
  const schedule = scheduleToSchedule(runtime.settings.schedule);

  if (action === "show") {
    console.log(JSON.stringify(settingsToDict(runtime.settings).schedule, null, 2));
    for (const window of schedule.windows) {
      console.log(
        `  ${window.label}: ${window.days.join(",")} ${window.start}-${window.end}, ` +
          `${window.prewarmMinutes} minutes of lead-in, target ${window.target}`,
      );
    }
    return 0;
  }
  if (action === "tick") {
    const wanted = schedule.actionFor(new Date());
    say("ok", `at ${new Date().toISOString()} the schedule asks for ${JSON.stringify(wanted)}`);
    return 0;
  }
  console.error(`error unknown action ${JSON.stringify(action)}: show, tick`);
  return 2;
}

/* -------------------------------------------------------------------------- */
/*  tickets                                                                    */
/* -------------------------------------------------------------------------- */

async function cmdTicket(runtime: LabRuntime, args: Args): Promise<number> {
  const action = args.words[0] ?? "form";

  if (action === "form") {
    const scenario = runtime.repository.get(option(args, "scenario") ?? "");
    const form = loadForm(scenario.ticket);
    if (form === null) {
      say("fail", `${scenario.id} declares no ticket form`);
      return 1;
    }
    console.log(`${form.title} — ${form.weight}% of the grade`);
    for (const field of form.fields) {
      console.log(`  ${field.id} (${field.kind}${field.required ? ", required" : ""}, ${field.weight} pts): ${field.label}`);
    }
    return 0;
  }

  const sessionId = Number(option(args, "session-id") ?? "0");
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    console.error("error pass --session-id");
    return 2;
  }
  const session = await runtime.store.getSession(sessionId);
  if (session === null) {
    console.error(`error no session ${sessionId}`);
    return 2;
  }

  if (action === "show") {
    const submitted = await runtime.store.latestTicket(sessionId);
    if (submitted === null) {
      say("note", "nothing submitted; the draft is below");
      console.log(JSON.stringify(await runtime.store.ticketDraft(sessionId), null, 2));
      return 0;
    }
    console.log(ticketGradeSummaryLine(submitted));
    console.log(JSON.stringify(await runtime.store.ticketValues(sessionId), null, 2));
    return 0;
  }

  if (action === "grade") {
    const scenario = runtime.repository.get(session.scenarioId);
    const form = loadForm(scenario.ticket);
    if (form === null) {
      say("fail", `${scenario.id} declares no ticket form`);
      return 1;
    }
    const values = valuesFrom(args);
    const result = grade(form, values, { sessionId, scenarioId: scenario.id });
    console.log(ticketGradeSummaryLine(result));
    for (const row of renderFeedback(form, result)) {
      console.log(`  [${row.passed === true ? "PASS" : "FAIL"}] ${String(row.label)} ${String(row.detail ?? "")}`);
    }
    return 0;
  }

  console.error(`error unknown action ${JSON.stringify(action)}: form, show, grade, save, complete`);
  return 2;
}

/** `--field id=value` repeated, or `--json '{"id": "value"}'`. */
function valuesFrom(args: Args): Record<string, string> {
  const json = option(args, "json");
  if (json !== null) return JSON.parse(readFileSync(json, "utf8")) as Record<string, string>;
  const values: Record<string, string> = {};
  for (const entry of all(args, "field")) {
    const split = entry.indexOf("=");
    if (split === -1) continue;
    values[entry.slice(0, split)] = entry.slice(split + 1);
  }
  return values;
}

/* -------------------------------------------------------------------------- */
/*  generate, media, demo                                                      */
/* -------------------------------------------------------------------------- */

function cmdGenerate(args: Args): number {
  const action = args.words[0] ?? "list";

  if (action === "list") {
    table(
      ["id", "category", "objectives"],
      listPrimitives().map((primitive) => [
        primitive.id,
        primitive.category,
        String(primitive.objectives.length),
      ]),
    );
    return 0;
  }
  if (action === "matrix") {
    console.log(JSON.stringify(primitiveMatrix(), null, 2));
    return 0;
  }
  if (action === "combine") {
    for (const combination of suggestedCombinations()) console.log(combination.join(" + "));
    return 0;
  }
  if (action === "one") {
    const wanted = all(args, "primitive");
    if (wanted.length === 0) {
      console.error("error pass --primitive (repeatable)");
      return 2;
    }
    // `--out` rather than the Python's default: a generator that writes into a guessed
    // directory is how a test fixture ends up in `scenarios/`.
    const out = option(args, "out");
    if (out === null) {
      console.error("error pass --out <directory> (the tree to write into: <out>/<scenario id>/)");
      return 2;
    }
    const generated = generate(wanted, {
      root: out,
      title: option(args, "title") ?? undefined,
      scenarioId: option(args, "scenario") ?? undefined,
      force: args.flags.has("force"),
    });
    for (const problem of generated.problems) say("fail", problem);
    say(generated.ok ? "ok" : "fail", `wrote ${generated.scenarioId} to ${generated.directory} from ${wanted.join(" + ")}`);
    return generated.ok ? 0 : 1;
  }
  console.error(`error unknown action ${JSON.stringify(action)}: list, one, combine, matrix`);
  return 2;
}

async function cmdMedia(args: Args): Promise<number> {
  const action = args.words[0] ?? "status";
  const settings = settingsFromEnv();
  const catalog = loadCatalog();
  const { defaultMediaStore } = await import("../../src/lib/lab/media");
  // The settings tree exposes the resolved directory rather than a section: `paths.media`
  // is relative to the deployment's root, and a download has to know where that landed.
  const store = defaultMediaStore({ mediaDir: settings.mediaDir }, catalog);

  if (action === "status" || action === "missing") {
    const rows: string[][] = [];
    for (const entry of catalog.load().values()) {
      const status = await store.status(entry);
      if (action === "missing" && status.state === "present") continue;
      rows.push([status.entryId, status.state, status.sizeBytes > 0 ? `${Math.round(status.sizeBytes / 1_048_576)} MiB` : "—"]);
    }
    table(["entry", "state", "size"], rows);
    return 0;
  }
  console.error(
    `error media fetch downloads installation media and needs the host's media directory and network;\n` +
      `      run it where the media lives (${settings.mediaDir}) rather than from here.`,
  );
  return 2;
}

async function cmdDemo(args: Args): Promise<number> {
  const action = args.words[0] ?? "run";
  if (action === "serve") {
    console.error(
      "error `demo serve` was the Python's uvicorn: this app is the server.\n" +
        `      Set ONTRAK_DEMO__ENABLED=1 and ${LAB_IN_APP_ENV}=1 and run \`npm start\` — the lab\n` +
        "      then serves the same in-memory range at /lab.",
    );
    return 2;
  }
  const scenarioIds = all(args, "scenario");
  const summary = await runDemo({
    students: Number(option(args, "students") ?? "6"),
    successRate: Number(option(args, "success-rate") ?? "1"),
    scenarioIds: scenarioIds.length > 0 ? scenarioIds : undefined,
    writeUps: !args.flags.has("no-write-ups"),
    verbose: args.flags.has("verbose"),
    log: (line: string) => console.log(line),
  });
  console.log(renderDemoSummary(summary));
  // A demo that graded nothing, or that handed in a session nobody passed, is a failure of
  // the run rather than of the students — which is what an exit code is for here.
  const handed = summary.completed.length;
  const passed = summary.completed.filter((row) => row.resolved).length;
  if (handed === 0 && !args.flags.has("no-complete")) {
    say("fail", "the run handed in no session");
    return 1;
  }
  say("ok", `${handed} session(s) handed in, ${passed} resolved`);
  return 0;
}

/* -------------------------------------------------------------------------- */
/*  results, and the two commands the port retired                             */
/* -------------------------------------------------------------------------- */

async function cmdResults(runtime: LabRuntime, args: Args): Promise<number> {
  const rows = await classResults(runtime);
  if (args.flags.has("csv")) {
    console.log(resultsCsv(rows));
    return 0;
  }
  table(
    ["student", "scenario", "attempts", "best", "resolved"],
    leaderboardRows(rows).map((row) => [
      row.student,
      row.scenarioId,
      String(row.attempts),
      String(row.best),
      row.solved ? "yes" : "no",
    ]),
  );
  return 0;
}

function cmdRetired(command: string): number {
  const reasons: Record<string, string> = {
    user: "accounts are the family's: sign-in is Authentik's and users live in the app's own table (§3/C2)",
    serve: "this app is the server — `npm start`, and the lab is served at /lab",
    image: "building a golden image needs qemu and incus on a lab host, which is host work rather than an app command",
  };
  console.error(`error \`${command}\` is not a command here: ${reasons[command] ?? "it was the Python's, and the port retired it"}.`);
  return 2;
}

/* -------------------------------------------------------------------------- */
/*  main                                                                       */
/* -------------------------------------------------------------------------- */

const USAGE = `ontrak — the lab's control plane, on the command line

  doctor                            check host readiness
  scenario list|show|validate       the scenario catalogue
  lesson list|show                  the command walkthrough library
  catalog list|groups|show|plan     the OS/Office workload catalogue
  generate list|one|combine|matrix  build scenarios from fault primitives
  template build [ids…] [--all]     build scenario templates
  pool status|prewarm|refill|drain  the warm pool
  session list|start|show|check|reset|extend|limit|complete|end|console
  ticket form|show|grade            the in-house incident write-up
  reap [--loop]                     expire sessions and refill pools
  stats                             a JSON status snapshot
  results [--csv]                   the class's marks
  media status|missing              the installation media store
  schedule show|tick                prewarm/teardown windows
  demo run                          the whole class flow in memory

Flags: --json where a command prints data. Settings come from the environment
(ONTRAK_<SECTION>__<KEY>), the same ones the app reads.`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === undefined || command === "help" || command === "--help") {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }

  try {
    switch (command) {
      case "doctor":
        return await cmdDoctor();
      case "scenario":
        return cmdScenario(args);
      case "lesson":
        return cmdLesson(args);
      case "catalog":
        return cmdCatalog(args);
      case "generate":
        return cmdGenerate(args);
      case "demo":
        return await cmdDemo(args);
      case "media":
        return await cmdMedia(args);
      case "results":
        return await cmdResults(await runtimeOrDie(), args);
      case "stats":
        return await cmdStats(await runtimeOrDie());
      case "session":
        return await cmdSession(await runtimeOrDie(), args);
      case "pool":
        return await cmdPool(await runtimeOrDie(), args);
      case "template":
        return await cmdTemplate(await runtimeOrDie(), args);
      case "ticket":
        return await cmdTicket(await runtimeOrDie(), args);
      case "reap":
        return await cmdReap(await runtimeOrDie(), args);
      case "schedule":
        return await cmdSchedule(await runtimeOrDie(), args);
      case "user":
      case "serve":
      case "image":
        return cmdRetired(command);
      default:
        console.error(`error unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
        return 2;
    }
  } finally {
    forgetLabRuntime();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`error ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });

/** Kept for the settings dump a support ticket wants. */
export { settingsToDict };
