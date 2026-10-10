/**
 * The admin panel's read models — what each page shows, as data.
 *
 * `admin.py` in the lab was ~510 lines of FastAPI routes that fetched, decided and rendered
 * Jinja inside one function. The port splits those three jobs the way `portal.ts` does for
 * the student side: the pages fetch, this module decides, and the JSX renders. Everything
 * here is **pure** — no database, no request, no clock of its own — so a rule about what an
 * operator sees is a value a test asserts rather than a template nobody can reach.
 *
 * Four of these carry a rule rather than an arithmetic, and the rules are the point.
 *
 * **The panel renders when the host is unwell.** Every reading that shells out to `incus`
 * (`poolStatus`, `templateStatus`, `imageAliases`) is wrapped by the *page*, which collects
 * a failure line instead of throwing — the behaviour `instructor/lab/page.tsx` learned
 * first, from the Python's own 500 that said nothing. What this module adds is the
 * arithmetic over whatever came back: `readyTemplates` and `readyPool` count a list that may
 * be empty, so a page cannot divide by a reading it never got.
 *
 * **A catalogue entry is shown with its plan.** The platforms page is a list of
 * (entry, plan) pairs, and the plan is what `Catalog.plan` decides from the facts the host
 * reported — so an entry whose image is not published reads as "not provisionable yet" with
 * the reason, rather than as a name and a hope. A single broken entry must not fail the page
 * (the Python's own rule), so planning is guarded per entry.
 *
 * **An account is not a lab account.** `admin.py` had `/admin/users` over its own SQLite
 * `users` table; §3/C2 supersedes that table with the app's identity, so the panel's
 * Accounts page is a **read-only** view of the family's accounts, and the writable surface
 * stays the app's own `/admin/users`. A second place to change a person's role is the "two
 * sources of truth" the audit refuses, and the more dangerous of the two would be whichever
 * people trusted.
 *
 * **A state the port does not know is a state the count cannot hide.** `stateCounts` seeds
 * every state at zero and counts only what the store handed back; a session whose state is
 * not one of them is counted under its own key rather than dropped, because a dashboard that
 * silently omits a session is worse than one that shows a state somebody has to explain.
 */

// Only `models` is a runtime import: the rest are types this module decides *about* rather
// than constructs, so the panel's nav can be imported by a component without dragging the
// catalogue, the session manager and the scheduler into the same bundle.
import type { Catalog, CatalogEntry, CatalogGroup, ProvisionPlan } from "./catalog";
import type { LabSettings } from "./config";
import { type LabSession, SESSION_STATES, isLive } from "./models";
import type { LabSchedule } from "./scheduler";
import type { Scenario, ScenarioRepository } from "./scenarios";
import type { PoolStatus, TemplateStatus } from "./sessions";

/* -------------------------------------------------------------------------- */
/*  The panel's own shape                                                     */
/* -------------------------------------------------------------------------- */

/** One entry in the panel's navigation, and the page it names. */
export interface AdminSection {
  id: string;
  label: string;
  description: string;
  href: string;
}

/**
 * The panel's sections, in the order the nav draws them.
 *
 * Overview first because it is the landing page — the nav's first entry is where
 * `/lab/admin` already is, so a reader can tell which section they are in without a second
 * breadcrumb. The rest are the estate around a class rather than the class itself, which is
 * the split `admin.py`'s own docstring drew against the instructor page.
 */
export const ADMIN_SECTIONS: readonly AdminSection[] = [
  {
    id: "overview",
    label: "Overview",
    description: "The estate at a glance, and the range's own health",
    href: "/lab/admin",
  },
  {
    id: "users",
    label: "Accounts",
    description: "Who can sign in, and the role each account carries",
    href: "/lab/admin/users",
  },
  {
    id: "platforms",
    label: "Platforms",
    description: "The catalogue, the images the host holds, and the templates built from them",
    href: "/lab/admin/platforms",
  },
  {
    id: "tickets",
    label: "Tickets",
    description: "The write-ups students handed in, and how they were marked",
    href: "/lab/admin/tickets",
  },
  {
    id: "schedule",
    label: "Schedule",
    description: "Prewarm and teardown windows",
    href: "/lab/admin/schedule",
  },
  {
    id: "audit",
    label: "Audit",
    description: "Everything the control plane did, in order",
    href: "/lab/admin/audit",
  },
];

/** The section a path is on, or `undefined` for a path the panel does not own. */
export function sectionForPath(pathname: string): AdminSection | undefined {
  const trimmed = pathname.replace(/\/+$/, "");
  // Longest href first, so `/lab/admin/tickets/7` matches `tickets` and not `overview`'s
  // prefix; every href but the overview's is a strict extension of it.
  return [...ADMIN_SECTIONS]
    .sort((left, right) => right.href.length - left.href.length)
    .find((section) => trimmed === section.href || trimmed.startsWith(`${section.href}/`));
}

/* -------------------------------------------------------------------------- */
/*  The estate, counted                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Sessions per state, every state present.
 *
 * Seeded from `SESSION_STATES` rather than from the sessions handed in: a dashboard that
 * omits the states it has none of cannot tell "no machines failed" from "this panel does not
 * report failures", and `admin/state.json` in the Python carried all of them for the same
 * reason. A state the model does not know is counted under its own key rather than dropped.
 */
export function stateCounts(sessions: readonly Pick<LabSession, "state">[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(
    SESSION_STATES.map((state) => [state, 0]),
  );
  for (const session of sessions) {
    counts[session.state] = (counts[session.state] ?? 0) + 1;
  }
  return counts;
}

/** The states a student could still be handed, summed — the "live machines" figure. */
export function liveCount(counts: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const state of SESSION_STATES) {
    if (isLive(state)) total += counts[state] ?? 0;
  }
  return total;
}

/** How many templates are built and usable, out of however many the host reported. */
export function readyTemplates(templates: readonly Pick<TemplateStatus, "ready">[]): number {
  return templates.filter((status) => status.ready).length;
}

/** How many pooled machines are handout-ready across every scenario. */
export function readyPool(pool: readonly Pick<PoolStatus, "ready">[]): number {
  return pool.reduce((total, status) => total + status.ready, 0);
}

/**
 * Read something that may be unavailable, and report it rather than raise.
 *
 * The Python's `safe()`: `pool_status` and `template_status` shell out to `incus`, and the
 * panel is exactly where an operator looks when Incus *is* the problem — so a page that 500s
 * because it could not ask the hypervisor tells them nothing, and a line that says which read
 * failed tells them everything. The failure is pushed onto the caller's list and the fallback
 * is `[]`, which the counting helpers above are written to accept.
 *
 * One definition, used by every page that reads the host (the panel, and the instructor fleet
 * view that learned it first), because a second copy of "a report must not raise" is a second
 * place for it to stop being true.
 */
export async function guardedRead<T>(
  label: string,
  call: () => Promise<T>,
  problems: string[],
): Promise<T | []> {
  try {
    return await call();
  } catch (error) {
    problems.push(`could not read the ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * The Python's `scenario_key`: a scenario on one platform, as templates and pools name it.
 *
 * The separator is the lab's own (`net-dns-failure@ubuntu-24.04`), which is also the spelling
 * `config.ts` uses for a pool target, so a key this page prints is one an operator can grep
 * for in `.env`.
 */
export function scenarioKey(scenarioId: string, workload = ""): string {
  return workload ? `${scenarioId}@${workload}` : scenarioId;
}

/** The settings the panel prints, under the names a deployment's file uses. */
export interface SettingsSummary {
  ttlMinutes: number;
  defaultTarget: number;
  maxTotal: number;
  poolEnabled: boolean;
  persistProgress: boolean;
  destroyOnComplete: boolean;
}

export function settingsSummary(settings: LabSettings): SettingsSummary {
  return {
    ttlMinutes: settings.session.ttlMinutes,
    defaultTarget: settings.pool.defaultTarget,
    maxTotal: settings.pool.maxTotal,
    poolEnabled: settings.pool.enabled,
    persistProgress: settings.session.persistProgress,
    destroyOnComplete: settings.session.destroyOnComplete,
  };
}

/* -------------------------------------------------------------------------- */
/*  Platforms                                                                 */
/* -------------------------------------------------------------------------- */

/** One catalogue entry and the plan for it, or `null` when planning itself refused. */
export interface PlatformEntry {
  entry: CatalogEntry;
  plan: ProvisionPlan | null;
}

export interface PlatformGroup {
  group: CatalogGroup;
  entries: PlatformEntry[];
}

/**
 * The catalogue, grouped, each entry with the plan the host's facts imply.
 *
 * `imageAliases` is what the host actually holds; an entry whose image is not among them
 * plans as not-provisionable-yet with the command to publish it, which is the whole reason
 * a platforms page exists rather than a list of names. Planning is guarded per entry: one
 * entry with an impossible device profile must not blank the page an operator opened to find
 * out which entry that is.
 */
export function platformGroups(catalog: Catalog, imageAliases: readonly string[]): PlatformGroup[] {
  const aliases = new Set(imageAliases);
  const groups: PlatformGroup[] = [];
  for (const group of catalog.groupList()) {
    const entries: PlatformEntry[] = group.entries.map((entry) => {
      let plan: ProvisionPlan | null = null;
      try {
        plan = catalog.plan(entry, { imageReady: aliases.has(entry.imageAlias) });
      } catch {
        plan = null;
      }
      return { entry, plan };
    });
    groups.push({ group, entries });
  }
  return groups;
}

/* -------------------------------------------------------------------------- */
/*  Tickets                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The catalogue as the scenario validator reads it: the entry ids a record may reference.
 *
 * `CatalogFacts` asks for an `entries` iterable, which the `Catalog` class does not expose —
 * it holds a private map and hands it out through `load()` — so the adapter lives here, at
 * the one call site that needs it, rather than widening the catalogue's own surface for a
 * validator's convenience.
 */
export function catalogFacts(catalog: Catalog): { entries: Iterable<string> } {
  return { entries: catalog.load().keys() };
}

/** The scenarios that declare a write-up form — the ones a ticket can exist for. */
export function scenariosWithTicket(repository: ScenarioRepository): Scenario[] {
  return repository
    .list()
    .filter((scenario) => scenario.ticketForm !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** The scenarios by id, for the labels a ticket list prints. */
export function scenarioTitles(repository: ScenarioRepository): Map<string, string> {
  return new Map(repository.list().map((scenario) => [scenario.id, scenario.title]));
}

/* -------------------------------------------------------------------------- */
/*  Schedule                                                                  */
/* -------------------------------------------------------------------------- */

export interface ScheduleWindowView {
  label: string;
  days: readonly string[];
  start: string;
  end: string;
  prewarmMinutes: number;
  target: number;
  scenarios: readonly string[];
}

export interface ScheduleView {
  enabled: boolean;
  windows: ScheduleWindowView[];
  /** Which phase the clock is in: `prewarm`, `open`, `drain` or `closed`. */
  phase: string;
  /** What a tick now would plan, whether or not it is executed. */
  planned: Record<string, unknown>[];
}

/**
 * The schedule as a page reads it, at one instant.
 *
 * `planned` is the schedule's own `actions(now)` — the decisions, without executing them —
 * which is what makes the page useful before anything runs: an operator can see the prewarm
 * a window implies and the machines it would build, and then press the tick if they agree.
 * The clock is an argument, so "what does 08:50 do" is a test, not a wait.
 */
export function scheduleView(schedule: LabSchedule, now: Date): ScheduleView {
  return {
    enabled: schedule.enabled,
    windows: schedule.windows.map((window) => ({
      label: window.label,
      days: window.days,
      start: window.start,
      end: window.end,
      prewarmMinutes: window.prewarmMinutes,
      target: window.target,
      scenarios: window.scenarios,
    })),
    phase: schedule.actionFor(now),
    planned: schedule.actions(now).map((action) => action.toDict()),
  };
}

/* -------------------------------------------------------------------------- */
/*  Audit                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the audit page's filter offers, given the kinds the log holds.
 *
 * `""` first — the "everything" option — because a filter list whose first row is a real
 * kind reads as if that kind were selected when nothing is. The store sorts the kinds; this
 * only decides that the empty option leads.
 */
export function auditKindOptions(kinds: readonly string[]): { value: string; label: string }[] {
  return [
    { value: "", label: "Every kind" },
    ...kinds.map((kind) => ({ value: kind, label: kind })),
  ];
}
