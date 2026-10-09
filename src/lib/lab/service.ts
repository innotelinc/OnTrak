/**
 * The lab's control plane, as a running thing inside this app.
 *
 * Every ported module below this one is pure or takes its seams by injection, which is
 * what made 450-odd tests possible with no hypervisor and no database. This module is the
 * opposite end: it is the one place that reads the environment, opens the store, finds
 * the scenario tree and hands back a manager. Everything above it — the pages, the route
 * handlers, the CLI — asks *here*, so there is one answer to "what is the lab" per
 * process and no second copy of the wiring to drift from.
 *
 * THREE THINGS WORTH STATING OUT LOUD.
 *
 * **Two ways to exist, one shape.** A deployment with `ONTRAK_DEMO__ENABLED` gets the
 * ported in-memory range (§2d): no Incus, no Windows media, no secrets, and a whole class
 * runs. A real host gets the Prisma store and the `incus` binary. Both come back as the
 * same `LabRuntime`, so no page branches on which one it has — the only difference a
 * caller can see is `mode` and `hypervisor`, and those are facts about the deployment, not
 * about the flow.
 *
 * **A lab that will not open is a value, not a throw.** A page rendered from a request
 * must not 500 because an operator has not set `ONTRAK_GUEST__PASSWORD` yet: it must say
 * so. So opening returns `{ok: false, reason}` with a sentence naming what to fix —
 * `requireSecrets`' own words, which already name the variable.
 *
 * **The ported data lives with the code.** `dataset.ts` reads `scenarios/` and
 * `src/lib/lab/data/*.json`; §3/C6 is why there is no YAML parser and why the catalogue
 * and the lesson library are JSON in the app. `settings.paths` still exists (the CLI and
 * the doctor read it), but the server reads the tree that ships with it, because a
 * deployment's Next build has those files and may have nothing at `paths.catalog`.
 *
 * Cached per process: opening a runtime reads JSON off disk and probes for `incus`, and
 * neither answer changes while the process lives. `forgetLabRuntime()` is for tests.
 */

import { prisma } from "@/lib/db";

import { Catalog } from "./catalog";
import { LabSettings, loadSettings, requireSecrets } from "./config";
import { loadCatalog, loadLessons, loadScenarios } from "./dataset";
import { DemoEnvironment, buildDemoEnvironment, seedRange } from "./demo";
import { IncusClient } from "./incus";
import { LessonRepository } from "./lessons";
import { ScenarioRepository } from "./scenarios";
import { SessionManager } from "./sessions";
import { type LabStore, InMemoryLabStore } from "./store";
import { prismaLabStore } from "./store-prisma";

/** How this runtime stands machines up. A fact about the deployment, shown on the pages. */
export type LabMode = "demo" | "host";

export interface LabRuntime {
  mode: LabMode;
  /** False on a host with no `incus`: the lab exists and cannot start a machine. */
  hypervisor: boolean;
  settings: LabSettings;
  store: LabStore;
  repository: ScenarioRepository;
  catalog: Catalog;
  lessons: LessonRepository;
  manager: SessionManager;
}

export type LabRuntimeRead = { ok: true; runtime: LabRuntime } | { ok: false; reason: string };

/** The lab's settings, from the deployment's environment. One reader, like everything else. */
export function labSettingsFromEnv(env: Record<string, string | undefined> = process.env): LabSettings {
  return loadSettings({ env });
}

export interface OpenLabOptions {
  env?: Record<string, string | undefined>;
  settings?: LabSettings;
  /** The store, for a caller that already has one (the tests, and the demo). */
  store?: LabStore;
  /** `undefined` probes for `incus`; `null` says there is none. */
  incus?: IncusClient | null;
}

/** A failure message that names the variable, never a stack trace a page would show. */
function reasonFor(error: unknown, label: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `the lab could not read its ${label}: ${detail}`;
}

/**
 * Open the lab: settings, data, store, manager — or the reason it will not open.
 *
 * The order is deliberate. Settings first (a misconfigured section is refused by name),
 * then the secret preflight, then the data, then the store: a deployment with no password
 * should be told that, not told about a missing JSON file it also has.
 */
export async function openLabRuntime(options: OpenLabOptions = {}): Promise<LabRuntimeRead> {
  const env = options.env ?? process.env;
  const settings = options.settings ?? labSettingsFromEnv(env);

  const problems = requireSecrets(settings);
  if (problems.length > 0) {
    return { ok: false, reason: `the lab is not configured: ${problems.join("; ")}` };
  }

  let repository: ScenarioRepository;
  let catalog: Catalog;
  let lessons: LessonRepository;
  try {
    repository = loadScenarios();
    catalog = loadCatalog();
    lessons = loadLessons();
  } catch (error) {
    return { ok: false, reason: reasonFor(error, "scenario tree, catalogue or lessons") };
  }

  // Demo mode answers for both platforms from the simulated guest, so the shell driver is
  // the same object — which is what keeps a demo Linux session from being graded through
  // a real transport that is not there (§2d).
  if (settings.demo.enabled) {
    const environ: DemoEnvironment = buildDemoEnvironment({
      settings,
      store: options.store ?? new InMemoryLabStore(),
    });
    // Templates, so the dashboard's scenarios are startable rather than "not available on
    // this range yet" in the one mode whose whole job is to show the student flow. A
    // failure is not fatal: the dashboard explains the scenario it belongs to.
    await seedRange(environ);
    return {
      ok: true,
      runtime: {
        mode: "demo",
        hypervisor: true,
        settings,
        store: environ.store,
        repository: environ.repository,
        catalog: environ.catalog,
        lessons,
        manager: environ.manager,
      },
    };
  }

  const store = options.store ?? prismaLabStore(prisma);
  const incus =
    options.incus === undefined
      ? (await IncusClient.available())
        ? new IncusClient(settings.incus)
        : null
      : options.incus;

  const manager = new SessionManager({ settings, store, incus, repository, catalog });

  return {
    ok: true,
    runtime: {
      mode: "host",
      hypervisor: incus !== null,
      settings,
      store,
      repository,
      catalog,
      lessons,
      manager,
    },
  };
}

let cached: Promise<LabRuntimeRead> | null = null;

/**
 * The process's lab, opened once.
 *
 * The promise is cached rather than its result: two requests arriving together must not
 * both probe for `incus` and read the same JSON, and caching the promise is what makes
 * that true without a lock.
 */
export async function labRuntime(): Promise<LabRuntimeRead> {
  cached ??= openLabRuntime();
  return await cached;
}

/** Forget the cached runtime. For tests, and for a CLI script that re-reads its env. */
export function forgetLabRuntime(): void {
  cached = null;
}
