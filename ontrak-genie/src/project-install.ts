import fs from "node:fs/promises";

import { config } from "./config.js";
import { backendLabel, runShellCommand, type ShellOptions, type ShellResult } from "./shell.js";

/**
 * Installing what a project needs, so it can actually be worked on.
 *
 * A project that arrives as an archive arrives *without its dependencies*: the
 * files are there, the `node_modules` — or the virtualenv, or the module cache —
 * is not. Telling somebody "here is your project, now work out how to build it"
 * is the point at which this console stops being useful, so the import runs the
 * install for them, visibly, step by step.
 *
 * TWO DECISIONS WORTH THE SPACE
 * -----------------------------
 *   1. **Everything installs *inside the project*.** A sandboxed command runs in a
 *      throwaway container with a read-only root filesystem (`src/sandbox.ts`): the
 *      workspace is the only writable thing in it, and the container is gone
 *      afterwards. So a `pip install` into the system interpreter, a `go mod
 *      download` into `$HOME/go`, or a `composer install` into a global cache is
 *      *lost the moment the step ends* — it looks like it worked and there is
 *      nothing there in the next command. Every step below therefore points its
 *      cache at the project: `node_modules`, `.venv`, `.gopath`, `.cargo`,
 *      `vendor/`, and the project's own `vendor/bundle`. That is also why the
 *      Python step builds a **virtualenv** rather than installing into the
 *      interpreter: a venv is a directory, and a directory in the project is the
 *      only place a dependency can live past the command that installed it.
 *   2. **The detection is a pure function of file names.** Which installer to run
 *      is decided from the marker files at the project root — `package.json`,
 *      `requirements.txt`, `go.mod` — and never from running something to ask. So
 *      the plan is knowable before it runs (the console shows it and the person can
 *      see what is about to happen), it is testable without a filesystem or a
 *      network, and a project with no recognisable marker reports "nothing to
 *      install" instead of guessing a command on somebody's behalf.
 *
 * WHAT IT DOES NOT DO: BUILD
 * -------------------------
 * Installing dependencies is not the same as building, and this module does only
 * the first. A build is the project's own business (`npm run build`, `make`,
 * `cargo build`) and running one unasked would execute a project's scripts before
 * anybody had looked at them — which for an archive somebody just uploaded is
 * exactly the wrong order. The agent has the project in front of it and runs the
 * build as ordinary work.
 */

/** One command that installs something, with a label a person can read. */
export interface InstallStep {
  /** What the step is for, in a person's words. */
  label: string;
  /** The command, as it will be run. Shown before it is run. */
  command: string;
  /** The ecosystem slug this step belongs to, for grouping in the console. */
  ecosystem: string;
}

export interface ProjectStack {
  /** Recognised ecosystems, e.g. `["node", "python"]`. */
  ecosystems: string[];
  /** The files that decided it, for the console to show. */
  markers: string[];
  /** What to run, in order. Empty when nothing recognisable was found. */
  steps: InstallStep[];
  /** Things a person should know: a missing toolchain, a sandbox with no network. */
  notes: string[];
}

const NO_STACK: ProjectStack = { ecosystems: [], markers: [], steps: [], notes: [] };

/**
 * The file names that decide an install.
 *
 * A set rather than a list used twice, because it answers two questions: which
 * marker is present, and whether a manifest is hiding in a *subdirectory* (a
 * monorepo package). The second is why a source file in a subdirectory —
 * `src/index.js`, which every project has — must not be mistaken for one.
 */
const MANIFESTS = [
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
] as const;

const MANIFEST_NAMES = new Set<string>(MANIFESTS);

/**
 * The directories an install step below puts in a project.
 *
 * Exported because the publisher has to know them: a project whose dependencies
 * were just installed is a project whose `node_modules` must not be committed, and
 * the file that says so is written from this list rather than from a second,
 * drifting copy of it (`src/remote.ts`, when it publishes a project to a forge).
 * Only directories that are *this deployment's* doing appear here — nothing a
 * person's own project would have had anyway.
 */
export const INSTALLED_PATHS = [
  "node_modules/",
  ".venv/",
  ".gopath/",
  ".cargo/",
  "vendor/",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
] as const;

/**
 * Read the stack off a project's root file names.
 *
 * `paths` may hold nested entries (an imported zip lists every file), and only the
 * root matters: an installer is run where its manifest is, and this console runs
 * one command at the project root rather than walking a monorepo looking for
 * package manifests. A nested `frontend/package.json` is therefore *named* as a
 * limitation rather than half-supported.
 */
export function detectProjectStack(paths: readonly string[]): ProjectStack {
  const root = new Set<string>();
  let nested = false;
  for (const raw of paths) {
    const rel = raw.replace(/^\.\//, "");
    if (rel === "" || rel.endsWith("/")) continue;
    if (rel.includes("/")) {
      // Only a *manifest* below the root is a package this step does not install.
      if (MANIFEST_NAMES.has(rel.slice(rel.lastIndexOf("/") + 1))) nested = true;
      continue;
    }
    root.add(rel);
  }

  if (root.size === 0) return NO_STACK;

  const has = (name: string): boolean => root.has(name);
  const ecosystems: string[] = [];
  const markers: string[] = [];
  const steps: InstallStep[] = [];
  const notes: string[] = [];

  const found = (...names: string[]): boolean => {
    let any = false;
    for (const name of names) {
      if (!has(name)) continue;
      markers.push(name);
      any = true;
    }
    return any;
  };

  /* ------------------------------------------------------------------ node -- */
  if (found("package.json")) {
    ecosystems.push("node");
    if (found("pnpm-lock.yaml")) {
      steps.push({
        label: "install dependencies with pnpm",
        command: "pnpm install --no-frozen-lockfile",
        ecosystem: "node",
      });
      notes.push("pnpm is not in the sandbox image, so this step needs pnpm available where commands run.");
    } else if (found("yarn.lock")) {
      steps.push({
        label: "install dependencies with yarn",
        command: "yarn install --no-immutable",
        ecosystem: "node",
      });
      notes.push("yarn is not in the sandbox image, so this step needs yarn available where commands run.");
    } else if (found("package-lock.json")) {
      steps.push({
        label: "install dependencies from package-lock.json",
        // `npm ci` is the lockfile-faithful install; a lockfile that has drifted
        // from package.json is then resolved by the plain install rather than
        // leaving the project with no dependencies at all and an exit code.
        command: "npm ci --no-audit --no-fund || npm install --no-audit --no-fund",
        ecosystem: "node",
      });
    } else {
      steps.push({ label: "install dependencies", command: "npm install --no-audit --no-fund", ecosystem: "node" });
    }
  }

  /* ---------------------------------------------------------------- python -- */
  const python = found("pyproject.toml", "requirements.txt");
  if (python) {
    ecosystems.push("python");
    steps.push({
      label: "create a virtual environment",
      command: "python3 -m venv .venv",
      ecosystem: "python",
    });
    if (has("requirements.txt")) {
      steps.push({
        label: "install requirements.txt",
        command: ".venv/bin/python -m pip install -r requirements.txt",
        ecosystem: "python",
      });
    }
    if (has("pyproject.toml")) {
      steps.push({
        label: "install this project as a Python package",
        command: ".venv/bin/python -m pip install -e .",
        ecosystem: "python",
      });
    }
    notes.push(
      "Python dependencies live in .venv inside the project, so they outlive the command that installed them: run the app with .venv/bin/python.",
    );
  }
  if (found("Pipfile")) {
    ecosystems.push("python");
    notes.push(
      "a Pipfile is present; this deployment installs from requirements.txt or pyproject.toml, so export one (`pipenv requirements > requirements.txt`) first.",
    );
  }

  /* ------------------------------------------------------------ other stacks -- */
  // Each of these installs into the project so the result survives the container
  // it ran in, and each is named with the toolchain the sandbox image lacks.
  if (found("go.mod")) {
    ecosystems.push("go");
    steps.push({
      label: "download Go modules into the project",
      command: 'GOPATH="$PWD/.gopath" GOFLAGS=-mod=mod go mod download',
      ecosystem: "go",
    });
    notes.push("the Go toolchain is not in the sandbox image; install it where commands run before this step will work.");
  }
  if (found("Cargo.toml")) {
    ecosystems.push("rust");
    steps.push({
      label: "fetch Rust crates into the project",
      command: 'CARGO_HOME="$PWD/.cargo" cargo fetch',
      ecosystem: "rust",
    });
    notes.push("the Rust toolchain is not in the sandbox image; install it where commands run before this step will work.");
  }
  if (found("composer.json")) {
    ecosystems.push("php");
    steps.push({
      label: "install PHP dependencies with Composer",
      command: "composer install --no-interaction --prefer-dist",
      ecosystem: "php",
    });
    notes.push("Composer is not in the sandbox image; install it where commands run before this step will work.");
  }
  if (found("Gemfile")) {
    ecosystems.push("ruby");
    steps.push({
      label: "install gems into the project",
      command: "bundle config set --local path vendor/bundle && bundle install",
      ecosystem: "ruby",
    });
    notes.push("Ruby and Bundler are not in the sandbox image; install them where commands run before this step will work.");
  }
  if (found("pom.xml", "build.gradle", "build.gradle.kts")) {
    ecosystems.push("java");
    notes.push(
      "this is a Java project; the JDK and Maven or Gradle are not in the sandbox image, so nothing is installed here — install them where commands run, then run the build the project documents.",
    );
  }

  if (nested) {
    notes.push(
      "only the project root is inspected, so a manifest in a subdirectory (a monorepo package) is not installed by this step.",
    );
  }

  return { ecosystems, markers, steps, notes };
}

/**
 * The file names at the root of a project's directory.
 *
 * The console calls this to *preview* the plan without running anything, and the
 * import calls it after writing the files, so the same detection serves a project
 * that came from an archive and one that was made by hand.
 */
export async function listProjectMarkers(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 500);
  } catch {
    return [];
  }
}

export interface InstallStepResult {
  label: string;
  command: string;
  ecosystem: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** Set when the command was refused before it ran (`src/shell.ts`). */
  refused?: string;
  output: string;
}

export interface InstallReport {
  /** True when every step that ran succeeded. */
  ok: boolean;
  /** How many steps ran. */
  ran: number;
  steps: InstallStepResult[];
  /** True when a failed step stopped the ones after it. */
  stopped: boolean;
  /** Where the commands ran: "container coding-agent-sandbox:latest" or "this host". */
  where: string;
  /** The plan, echoed back so a caller can render it beside the results. */
  stack: ProjectStack;
}

export interface InstallOptions {
  /** Absolute, already resolved: the project directory. */
  dir: string;
  stack: ProjectStack;
  /**
   * How long one step is given.
   *
   * Defaults to the executor's own ceiling (ten minutes), because installing a
   * dependency tree is the one command that legitimately takes minutes and the
   * ordinary `AGENT_COMMAND_TIMEOUT_MS` (two minutes) would kill it halfway
   * through — leaving a half-written `node_modules` and an error that says the
   * command timed out rather than that it was never given long enough.
   */
  timeoutMs?: number;
}

/** The port a test replaces. The real one is the sandboxed executor. */
export type InstallRunner = (options: ShellOptions) => Promise<ShellResult>;

/** The longest any install step may take, matching `src/shell.ts`'s own clamp. */
export const INSTALL_TIMEOUT_MS = 600_000;

/**
 * Run a stack's install steps, in order, stopping at the first failure.
 *
 * Stopping rather than pressing on is the honest behaviour: a failed `pip install`
 * makes the steps after it meaningless, and a report of four failures where the
 * first caused them is harder to act on than one. The output of every step is kept
 * whole, because the thing a person needs when an install fails is *the
 * installer's own words* — not a summary of them written by this module.
 */
export async function installProjectDependencies(
  options: InstallOptions,
  run: InstallRunner = runShellCommand,
): Promise<InstallReport> {
  const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS;
  const results: InstallStepResult[] = [];
  let where = "";
  let stopped = false;
  let ok = true;

  for (const step of options.stack.steps) {
    const result = await run({ command: step.command, cwd: options.dir, timeoutMs });
    where = backendLabel(result.backend);
    results.push({
      label: step.label,
      command: step.command,
      ecosystem: step.ecosystem,
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      ...(result.refused === undefined ? {} : { refused: result.refused }),
      output: result.output,
    });
    if (!result.ok) {
      ok = false;
      if (options.stack.steps.length > results.length) stopped = true;
      break;
    }
  }

  return { ok, ran: results.length, steps: results, stopped, where, stack: options.stack };
}

/**
 * What this deployment cannot do about an install, said before it is attempted.
 *
 * The sandbox has no network by default (`AGENT_SANDBOX_NETWORK=none`), which is
 * the shipped setting and a deliberate one: an agent that cannot reach the
 * network cannot exfiltrate anything. The cost is that no install can download
 * anything, so the plan says so *before* somebody watches a step fail —
 * the difference between a configuration decision and a mystery.
 */
export function installEnvironmentNotes(): string[] {
  const notes: string[] = [];
  if (config.sandbox !== "host" && config.sandboxNetwork === "none") {
    notes.push(
      "the sandbox has no network access (AGENT_SANDBOX_NETWORK=none), so any step that downloads packages will fail — set it to bridge or host to allow installs.",
    );
  }
  return notes;
}
