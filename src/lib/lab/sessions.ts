/**
 * Session lifecycle — the TypeScript half of OnTrak-dev's `ontrak/sessions.py`, the
 * largest module in the lab (1,638 lines of Python) and the one every other moving
 * part goes through.
 *
 * The model is deliberately simple, and it is the reset policy: **a session is always
 * a fresh clone of a scenario template, and a reset throws the VM away and clones
 * again.** No in-place mutation, no drift, no "did the last student leave something
 * behind". On ZFS/btrfs the clone is copy-on-write, so throwing VMs away is cheaper
 * and far more reliable than trying to un-break a machine.
 *
 * Two kinds of instance exist:
 *
 * `tpl-<scenario>[-<workload>]`
 *     Booted once by a template build, fault injected, powered off, then snapshotted
 *     as `clean`. This is the source of truth for the scenario.
 * `ontrak-pool-<scenario>[-<workload>]-<n>`
 *     A pre-booted clone waiting to be claimed. Keeps handoff instant for a class of
 *     30 instead of making everyone wait a minute for Windows to boot.
 *
 * A claimed pool instance is recorded on the session row, and **availability is
 * derived** — a pool-named instance that no live session references — so the pool
 * needs no bookkeeping of its own and survives a control-plane restart. That is the
 * property that makes `poolStatus` a view rather than a state, and it is why there is
 * nothing here to reconcile after a crash.
 *
 * Four things the port changed on purpose, each of them forced by the stack rather
 * than chosen for taste; `docs/lab-port.md` §3 records them:
 *
 * **Everything is async.** The hypervisor client is async (§3/C4), so a "claim a pool
 * VM and wait for it to answer" is a chain of awaits rather than a blocking call —
 * and a blocking 120-second `incus list` inside a request handler would stall the app
 * for everyone else.
 *
 * **The settings are not mutated.** Python wrote the catalog's workload ids back onto
 * `settings.incus.known_workloads` so pool names could be parsed. `IncusConfig` here is
 * readonly, so the manager builds its own config carrying that list instead of
 * reaching into the shared one — the parsing rule is the same object, just not the same
 * instance.
 *
 * **The clock, the sleep and the drivers are injected.** A TTL sweep, an idle recycle
 * and a readiness wait are all "wait for time to pass", and a real clock makes those
 * tests take minutes. They take milliseconds here, which is what makes the sweeps
 * worth testing at all.
 *
 * **The ticket is marked here, and the two halves are blended.** `complete` is the one
 * place the write-up counts: a scenario with a form treats documentation as part of the
 * work, an unsubmitted write-up scores zero and the attempt cannot resolve, and a
 * scenario with no form grades exactly as it always did. The rubric itself lives in
 * `tickets.ts`; what is here is the policy — when to blend, what to log, and the one case
 * where blending would be dishonest (a machine that could not be graded at all).
 *
 * The audit trail is `store.logEvent`, and it fires at the same points with the same
 * kinds as the Python's, because that log is what an instructor reads when a class
 * goes wrong.
 */

import { join } from "node:path";

import { Catalog, CatalogError, type CatalogEntry } from "./catalog";
import {
  IncusConfig,
  defaultTimeLimit,
  poolTargetFor,
  type LabSettings,
} from "./config";
import {
  BaseDriver,
  GuestError,
  buildDriver,
  buildShellDriver,
  quotePs,
  quoteSh,
  type CommandResult,
  type GuestExecClient,
  type GuestSettings,
  type RunOptions,
} from "./guest";
import { IncusError, instanceRunning, type InstanceInfo } from "./incus";
import { InMemoryIncus } from "./memory";
import {
  iso,
  isTerminal,
  newLabSession,
  newScoreReport,
  parseIso,
  scoreReportBreakdown,
  scoreReportSummaryLine,
  secondsSince,
  sessionExtend,
  sessionIsExpired,
  sessionSetTimeLimit,
  type LabSession,
  type ScoreReport,
  type SessionState,
} from "./models";
import { applyForHost, TCG, type Accelerator, type QemuConfigClient } from "./qemu";
import {
  CHECK_NAMES,
  COMMON_LIB,
  LINUX,
  SETUP_NAMES,
  SETUP_OK_MARKER,
  SHELL_COMMON_LIB,
  WINDOWS,
  ScenarioError,
  ScenarioRepository,
  platformWorkloads,
  type Platform,
  type Scenario,
} from "./scenarios";
import { clearedPassMark } from "../score-rules";
import { evaluate, formatFixed, roundHalfEven } from "./scoring";
import {
  asText,
  blend,
  grade as markTicket,
  loadForm,
  ticketGradePassedCount,
  ticketGradeSummaryLine,
  ticketOutcomeToDict,
  type TicketForm,
  type TicketGrade,
} from "./tickets";
import type { LabStore } from "./store";
import type { LabEvent } from "./store";

export const POOL_SNAPSHOT = "clean";
export const TEMPLATE_PSEUDO_STUDENT = "<template>";
/** Printed by the console-transport provisioning script once sshd is listening. */
export const CONSOLE_SETUP_MARKER = "ontrak-console-ready";
/**
 * How many times a template build will ask a scenario to inject its fault.
 *
 * More than one, because a fault is allowed to cut the connection its own result
 * travels over — turning an adapter off DHCP does exactly that — and then the only way
 * to hear the result is to reconnect and ask again. Bounded, because each attempt is a
 * whole run.
 */
export const SETUP_ATTEMPTS = 3;
/** Time for the guest to settle the change that cut the last attempt, before the retry. */
export const SETUP_RETRY_DELAY_SECONDS = 5;
/** How long the dashboard's unavailability map is reused, in seconds. */
export const UNAVAILABLE_TTL_SECONDS = 30;
/** Workload id prefixes that mean "a Linux guest"; used only to label pool rows. */
export const LINUX_TAG_PREFIXES: readonly string[] = [
  "alpine",
  "almalinux",
  "archlinux",
  "arch",
  "centos",
  "debian",
  "fedora",
  "gentoo",
  "kali",
  "linuxmint",
  "nixos",
  "opensuse",
  "oracle",
  "raspios",
  "rhel",
  "rockylinux",
  "ubuntu",
  "void",
  "voidlinux",
  "ontrak-idp",
];

/** Raised when a session cannot be created, reset or graded. */
export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

/**
 * The hypervisor surface this module uses.
 *
 * Structural and narrow: every field here is one the manager actually reads. It
 * extends the guest drivers' own client shape, because a Linux template is built
 * through the Incus agent and those two transports therefore need the same client.
 * Returns are declared as wide as the callers can tolerate (`| null` where the client
 * may have nothing to say) so the real client and the in-memory one both satisfy it
 * without either being adapted.
 */
export interface SessionIncus extends GuestExecClient {
  exists(name: string): Promise<boolean>;
  hasSnapshot(instance: string, snapshot: string): Promise<boolean>;
  instanceStatus(name: string): Promise<string | null>;
  instanceIp(name: string): Promise<string | null>;
  imageExists(alias: string): Promise<boolean>;
  /** Every image alias the host holds — what the platforms page plans a catalogue entry against. */
  imageAliases(): Promise<string[]>;
  listInstances(): Promise<InstanceInfo[]>;
  getInstance(name: string): Promise<InstanceInfo | null>;
  createInstance(name: string, image: string, profiles?: readonly string[]): Promise<unknown>;
  // `instanceOnly` is positional here because the real client's is (`copyInstance(source,
  // name, instanceOnly = true)` in incus.ts), and the client is what decides whether the
  // flag is even legal: it refuses `--instance-only` for a snapshot source, which is
  // exactly what a pool clone passes.
  copyInstance(source: string, name: string, instanceOnly?: boolean): Promise<unknown>;
  startInstance(name: string): Promise<unknown>;
  stopInstance(name: string, options?: { force?: boolean; timeout?: number }): Promise<unknown>;
  deleteInstance(name: string, options?: { force?: boolean }): Promise<unknown>;
  createSnapshot(name: string, snapshot: string): Promise<unknown>;
  configGet(name: string, key: string): Promise<string | null>;
  setConfigs(name: string, values: Record<string, string>): Promise<unknown>;
  addDevice(
    name: string,
    type: string,
    deviceName: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  removeDevice(name: string, deviceName: string): Promise<unknown>;
}

/**
 * The guest transport surface the manager uses.
 *
 * `runShell` is optional because Windows guests have no shell to run: a Linux
 * scenario needs it and a Windows one must not be able to reach for it by accident.
 */
export interface GuestDriver {
  readonly name: string;
  runPowerShell(script: string, options?: RunOptions): Promise<CommandResult>;
  runScriptFile(remotePath: string, options?: RunOptions): Promise<CommandResult>;
  runShell?(script: string, options?: RunOptions): Promise<CommandResult>;
  uploadFile(
    localPath: string,
    remotePath: string,
    options?: RunOptions,
  ): Promise<CommandResult>;
  waitReady(target: { instance: string; hostIp: string }, timeoutSeconds?: number): Promise<boolean>;
}

/** One pool's status row, as the admin panel and the CLI print it. */
export class PoolStatus {
  readonly scenarioId: string;
  readonly target: number;
  readonly ready: number;
  readonly claimed: number;
  readonly total: number;
  readonly templateReady: boolean;
  /** Empty means the site's golden image, which is what scenarios without one use. */
  readonly workload: string;

  constructor(fields: {
    scenarioId: string;
    target: number;
    ready: number;
    claimed: number;
    total: number;
    templateReady: boolean;
    workload?: string;
  }) {
    this.scenarioId = fields.scenarioId;
    this.target = fields.target;
    this.ready = fields.ready;
    this.claimed = fields.claimed;
    this.total = fields.total;
    this.templateReady = fields.templateReady;
    this.workload = fields.workload ?? "";
  }

  get label(): string {
    return this.workload ? `${this.scenarioId}@${this.workload}` : this.scenarioId;
  }

  /** Which driver family this pool needs, inferred from the workload id. */
  get platform(): Platform {
    if (this.workload === "") return WINDOWS;
    const prefix = this.workload.split("-")[0] ?? "";
    return LINUX_TAG_PREFIXES.includes(prefix) ? LINUX : WINDOWS;
  }

  /**
   * How many instances to create to reach the target.
   *
   * Counted against *all* pool-named instances, including the ones students have
   * claimed: a claimed VM keeps its pool name, so a class where every student holds one
   * of 30 target VMs shows a deficit of 0 rather than asking the reaper to build 30
   * more and exhaust the host's memory.
   */
  get deficit(): number {
    return Math.max(0, this.target - this.total);
  }

  /** Unclaimed instances missing right now — handoff latency, not capacity. */
  get shortfall(): number {
    return Math.max(0, this.target - this.ready);
  }

  get healthy(): boolean {
    return this.deficit === 0;
  }

  /** The wire shape the admin `state.json` and the CLI print. */
  toDict(): Record<string, unknown> {
    return {
      scenario_id: this.scenarioId,
      workload: this.workload,
      target: this.target,
      ready: this.ready,
      claimed: this.claimed,
      total: this.total,
      template_ready: this.templateReady,
      deficit: this.deficit,
      shortfall: this.shortfall,
      healthy: this.healthy,
    };
  }
}

/** What a scenario's template build reports, one row per (scenario, workload). */
export interface TemplateStatus {
  scenarioId: string;
  workload: string;
  platform: Platform;
  name: string;
  exists: boolean;
  snapshot: boolean;
  running: boolean;
  ready: boolean;
}

/** What one `reap()` pass did. */
export interface ReapResult {
  recycled: number[];
  refilled: Record<string, number>;
}

/** Co-workers the manager takes by injection, so a test can drive it with no host. */
export interface SessionManagerOptions {
  settings: LabSettings;
  store: LabStore;
  incus?: SessionIncus | null;
  driver?: GuestDriver;
  shellDriver?: GuestDriver;
  repository?: ScenarioRepository;
  catalog?: Catalog | null;
  /** The clock, so a TTL or idle sweep is instant in a test. Defaults to the real one. */
  clock?: () => Date;
  /** The sleep, so a retry loop does not take five real seconds. Defaults to a timer. */
  sleep?: (seconds: number) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every value of a record as a string, which is what Incus accepts. */
function stringMap(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

/** A deterministic, if not cryptographic, choice — injected so a test can pin it. */
function randomPassword(length: number, pick: (limit: number) => number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#%*+=?";
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += alphabet.charAt(pick(alphabet.length));
  }
  return out;
}

/**
 * The shell that turns a Linux guest into one the browser console can open.
 *
 * Kept as a function over the guest settings so the exact text a template build runs is
 * text a test can read: this script is the difference between a console that works and
 * a page that says the remote desktop server is unreachable, and asserting on a string
 * is how it stays that way.
 *
 * `chpasswd` rather than `passwd` — it does not prompt, and it *unlocks* an account a
 * scenario locked, which is exactly why it runs last.
 */
export function consoleTransportScript(guest: GuestSettings): string {
  const password = guest.password;
  const user = guest.linuxUser || "root";
  const port = guest.sshPort;
  return [
    "set -e",
    "export DEBIAN_FRONTEND=noninteractive",
    // Only the daemon is needed; the client tools, docs and recommends are dead weight
    // carried by every clone of the image.
    "if ! command -v sshd >/dev/null 2>&1; then",
    "  (apt-get update -qq && apt-get install -y -qq --no-install-recommends" +
      " openssh-server) >/dev/null 2>&1 || apt-get install -y -qq" +
      " --no-install-recommends openssh-server >/dev/null 2>&1",
    "fi",
    "mkdir -p /run/sshd",
    `echo ${quoteSh(`${user}:${password}`)} | chpasswd`,
    "for key in PermitRootLogin PasswordAuthentication; do",
    '  if grep -qE "^#?$key" /etc/ssh/sshd_config; then',
    '    sed -i "s|^#*$key.*|$key yes|" /etc/ssh/sshd_config',
    "  else",
    '    echo "$key yes" >> /etc/ssh/sshd_config',
    "  fi",
    "done",
    // Ubuntu and Debian read `Include /etc/ssh/sshd_config.d/*.conf` from near the *top*
    // of sshd_config, and sshd keeps the **first** value it sees per keyword — so a
    // drop-in outranks the main file, and an image's own drop-in could outrank ours.
    // `00-` rather than `99-` is what puts our two lines first.
    "mkdir -p /etc/ssh/sshd_config.d",
    "printf '%s\\n' 'PermitRootLogin yes' 'PasswordAuthentication yes'" +
      " > /etc/ssh/sshd_config.d/00-ontrak-console.conf",
    "systemctl enable ssh >/dev/null 2>&1 || systemctl enable sshd" +
      " >/dev/null 2>&1 || true",
    "systemctl start ssh >/dev/null 2>&1 || systemctl start sshd" +
      " >/dev/null 2>&1 || service ssh start >/dev/null 2>&1 || /usr/sbin/sshd",
    `ss -ltn 2>/dev/null | grep -q ':${port} ' || sleep 2`,
    `ss -ltn 2>/dev/null | grep -q ':${port} '`,
    `printf '${CONSOLE_SETUP_MARKER}\\n'`,
  ].join("\n");
}

/**
 * One student's machine, from request to destruction.
 *
 * Constructed once per process and shared: the pool, the templates and the per-session
 * locks are all derivable from the store plus the hypervisor, so a restart loses
 * nothing that matters.
 */
export class SessionManager {
  readonly settings: LabSettings;
  readonly store: LabStore;
  /** Kept as an attribute as well as `repository`, because the scheduler and the portal ask for both names. */
  readonly repository: ScenarioRepository | null;
  readonly catalog: Catalog | null;
  /** The settings to build *names* from, with the catalog's workloads folded in. */
  readonly incusConfig: IncusConfig;

  private readonly incus: SessionIncus | null;
  private readonly driver: GuestDriver;
  private readonly shellDriver: GuestDriver | null;
  private readonly now: () => Date;
  private readonly sleep: (seconds: number) => Promise<void>;
  private readonly locks = new Map<number, Promise<unknown>>();
  private unavailableCache: { at: number; reasons: Record<string, string> } | null = null;

  constructor(options: SessionManagerOptions) {
    this.settings = options.settings;
    this.store = options.store;
    this.incus = options.incus ?? null;
    this.repository = options.repository ?? null;
    this.catalog = options.catalog ?? null;
    this.now = options.clock ?? ((): Date => new Date());
    this.sleep =
      options.sleep ??
      ((seconds: number): Promise<void> =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, seconds * 1_000);
        }));

    // The catalog's own ids are what a pool name may end with, so parsing an instance
    // name can tell `pool-a-1` from `pool-a-ubuntu-24.04-1`. Python wrote them onto the
    // shared settings; a readonly config means building one that carries them instead.
    const workloads = this.catalog === null ? [] : [...this.catalog.load().keys()];
    this.incusConfig = new IncusConfig({ ...options.settings.incus, knownWorkloads: workloads });

    // Both transports get the hypervisor, and the Windows one is the reason it matters:
    // `incus-exec` *is* the agent on the other end of the Incus socket, so a driver built
    // without a client cannot execute anything — every command comes back as a failure, and
    // a real Windows guest is ungradeable while every unit test still passes (the tests
    // inject their own drivers). The shell transport is built only when there is a client to
    // give it, because a scenario that names Linux is graded over the agent or SSH and a
    // manager with neither has no answer for it.
    this.driver =
      options.driver ??
      buildDriver(options.settings.guest, this.incus === null ? {} : { client: this.incus });
    this.shellDriver =
      options.shellDriver ??
      (this.incus === null
        ? null
        : buildShellDriver(options.settings.guest, { client: this.incus }));
  }

  /* ------------------------------------------------------------------ */
  /*  infrastructure                                                     */
  /* ------------------------------------------------------------------ */

  /** The hypervisor, or a refusal that names the repair rather than a null deref. */
  private requireIncus(): SessionIncus {
    if (this.incus === null) {
      throw new SessionError(
        "no Incus connection available: the `incus` binary is not on PATH. " +
          "Run infra/bootstrap-host.sh, then `ontrak doctor` to confirm.",
      );
    }
    return this.incus;
  }

  /** The scenario repository, or a refusal — a manager without one can do nothing. */
  private repo(): ScenarioRepository {
    if (this.repository === null) {
      throw new SessionError("this session manager was built without a scenario repository");
    }
    return this.repository;
  }

  /**
   * The image aliases the host holds, or none.
   *
   * The platforms page is the reader: `Catalog.plan` takes `imageReady` so a catalogue entry
   * whose image is not published reads as "not provisionable yet" with the reason, rather
   * than as a name and a hope. A manager with no hypervisor answers `[]` instead of throwing
   * — the Python's own guard (`manager.incus.image_aliases() if manager.incus is not None
   * else []`) — because the panel is exactly where an operator looks when Incus *is* the
   * problem, and a page that says "no images" tells them where to look while one that 500s
   * tells them nothing.
   */
  async imageAliases(): Promise<string[]> {
    if (this.incus === null) return [];
    return await this.incus.imageAliases();
  }

  /** Is this session manager able to reach a hypervisor at all? */
  hasHypervisor(): boolean {
    return this.incus !== null;
  }

  /** Windows guest path under the work directory. */
  private guestPath(...parts: string[]): string {
    const root = this.settings.guest.workDir.replace(/\\+$/, "");
    return [root, ...parts].join("\\");
  }

  /** Linux guest path under the work directory. */
  private posixPath(...parts: string[]): string {
    const root = this.settings.guest.linuxWorkDir.replace(/\/+$/, "");
    return [root, ...parts].join("/");
  }

  /** Path inside whichever guest platform the scenario targets. */
  private join(scenario: Scenario, ...parts: string[]): string {
    return scenario.platform === LINUX ? this.posixPath(...parts) : this.guestPath(...parts);
  }

  /** The transport this scenario's guest speaks. */
  private driverFor(scenario: Scenario): GuestDriver {
    if (scenario.platform === LINUX) {
      if (this.shellDriver === null) {
        throw new SessionError(
          `scenario ${scenario.id} runs on Linux, but no shell transport is available ` +
            "(the Incus agent or SSH). Pass `shellDriver`, or give the manager an Incus client.",
        );
      }
      return this.shellDriver;
    }
    return this.driver;
  }

  private guestArgs(session: LabSession): RunOptions {
    return { host: session.hostIp, instance: session.instance };
  }

  /** The shared library a scenario's scripts dot-source, on disk. */
  libSource(): string {
    return join(this.settings.scenariosDir, "_lib", COMMON_LIB);
  }

  shellLibSource(): string {
    return join(this.settings.scenariosDir, "_lib", SHELL_COMMON_LIB);
  }

  /** Where a scenario's scripts live on this host, once the data is unpacked. */
  scenarioScriptDir(scenario: Scenario): string {
    return join(this.settings.scenariosDir, scenario.id);
  }

  /* ------------------------------------------------------------------ */
  /*  templates and pools, keyed by (scenario, workload)                 */
  /* ------------------------------------------------------------------ */

  /**
   * Every (scenario, workload) pair the lab can offer.
   *
   * A scenario that names workloads is offered once per workload, each with its own
   * template and pool. A scenario that names none is offered once on the site's golden
   * image, which is what every pre-catalog scenario does.
   */
  workloadPairs(ids?: readonly string[] | null): { scenario: Scenario; workload: string }[] {
    const pairs: { scenario: Scenario; workload: string }[] = [];
    for (const scenario of this.repo().list()) {
      if (ids && ids.length > 0 && !ids.includes(scenario.id)) continue;
      const workloads = platformWorkloads(scenario);
      if (workloads.length === 0 || this.catalog === null) {
        pairs.push({ scenario, workload: "" });
        continue;
      }
      for (const workloadId of workloads) {
        try {
          this.catalog.get(workloadId);
        } catch (error) {
          if (!(error instanceof CatalogError)) throw error;
          void this.store.logEvent(
            "workload_unknown",
            `scenario ${scenario.id} names workload ${JSON.stringify(workloadId)}, not in the catalog`,
          );
          continue;
        }
        pairs.push({ scenario, workload: workloadId });
      }
    }
    return pairs;
  }

  /**
   * Whether anything on this range is built on the site's golden image.
   *
   * A scenario that names a catalog workload is built from that workload's own image;
   * one that names none falls back to `incus.imageAlias`, the Windows golden image. A
   * range whose scenarios all name a workload — a Linux-only range — runs perfectly well
   * without it, and reporting that image as *missing* there reads as a broken range when
   * nothing is broken. So the check is asked before the image is called absent.
   */
  goldenImageRequired(): boolean {
    return this.workloadPairs().some((pair) => pair.workload === "");
  }

  async templateStatus(): Promise<TemplateStatus[]> {
    const incus = this.incus;
    const rows: TemplateStatus[] = [];
    for (const { scenario, workload } of this.workloadPairs()) {
      const name = this.incusConfig.templateName(scenario.id, workload);
      const exists = incus === null ? false : await incus.exists(name);
      const snapshot = exists && incus !== null ? await incus.hasSnapshot(name, POOL_SNAPSHOT) : false;
      const status = exists && incus !== null ? await incus.instanceStatus(name) : null;
      rows.push({
        scenarioId: scenario.id,
        workload,
        platform: scenario.platform,
        name,
        exists,
        snapshot,
        running: (status ?? "").toUpperCase() === "RUNNING",
        ready: snapshot,
      });
    }
    return rows;
  }

  /**
   * Empty string when a session can start, otherwise the reason it cannot.
   *
   * Provisioning needs exactly one of two things: a booted machine in the pool to claim,
   * or the template's `clean` snapshot to clone. When neither exists the session is
   * doomed before it starts — which is how a student ended up holding a session whose
   * entire content was `template tpl-sw-app-crash is missing snapshot clean`. Asking
   * first means a scenario the range cannot run is refused before a session row exists.
   */
  async scenarioAvailability(scenarioId: string, workload?: string | null): Promise<string> {
    const scenario = this.repo().get(scenarioId); // raises for unknown ids
    const resolved = await this.resolveWorkload(scenarioId, workload ?? null);
    const incus = this.incus;
    if (incus === null) return ""; // demo / CI: there is nothing to probe
    const template = this.incusConfig.templateName(scenario.id, resolved);
    const label = resolved ? `${scenario.id}@${resolved}` : scenario.id;
    const baseImage = this.baseImage(scenario, resolved);
    try {
      if ((await incus.exists(template)) && (await incus.hasSnapshot(template, POOL_SNAPSHOT))) {
        return "";
      }
      if ((await this.availablePool(scenario.id, { workload: resolved })).length > 0) return "";
    } catch (error) {
      if (!(error instanceof IncusError)) throw error;
      // An unreachable hypervisor cannot tell us this scenario is *unrunnable*, only that
      // we cannot tell. Claiming a block here would refuse every scenario on the range
      // during an outage.
      return "";
    }
    let published: boolean;
    try {
      published = await incus.imageExists(baseImage);
    } catch (error) {
      if (!(error instanceof IncusError)) throw error;
      return "";
    }
    // Nothing can serve it: name the layer that is actually missing, because the two have
    // different repairs and only one of them is a template build.
    if (!published) {
      const entry = resolved ? this.workloadEntry(resolved) : this.workloadFor(scenario);
      if (entry !== null) {
        return (
          `${scenario.id} is not available on this range yet: the ${JSON.stringify(baseImage)} ` +
          `image it is built from has not been published. Ask an instructor to run ` +
          `\`ontrak image build ${entry.id}\`.`
        );
      }
      return (
        `${scenario.id} is not available on this range yet: the golden image ` +
        `${JSON.stringify(baseImage)} has not been built, so every scenario that runs on ` +
        "it is unavailable. Ask an instructor to run infra/build-golden-image.sh."
      );
    }
    return (
      `${scenario.id} is not available on this range yet: its template ${template} has not ` +
      `been built. Ask an instructor to run \`ontrak template build ${label}\`.`
    );
  }

  /**
   * `{scenarioId: reason}` for every scenario this range cannot start.
   *
   * Computed per *pair* — a scenario offered on more than one workload counts as
   * available when any of them can run — and cached briefly, because every probe behind
   * it is an Incus round trip and a template does not appear and vanish within half a
   * minute.
   */
  async unavailableScenarios(): Promise<Record<string, string>> {
    if (this.incus === null) return {};
    const now = this.now().getTime();
    const cached = this.unavailableCache;
    if (cached !== null && now - cached.at < UNAVAILABLE_TTL_SECONDS * 1_000) {
      return { ...cached.reasons };
    }
    try {
      const startable = new Set<string>();
      for (const row of await this.templateStatus()) {
        if (row.ready) startable.add(`${row.scenarioId}\u0000${row.workload}`);
      }
      for (const status of await this.poolStatus()) {
        if (status.ready > 0) startable.add(`${status.scenarioId}\u0000${status.workload}`);
      }
      const reasons: Record<string, string> = {};
      for (const { scenario, workload } of this.workloadPairs()) {
        if (startable.has(`${scenario.id}\u0000${workload}`)) continue;
        if (reasons[scenario.id] === undefined) {
          reasons[scenario.id] = await this.scenarioAvailability(scenario.id, workload);
        }
      }
      this.unavailableCache = { at: now, reasons };
      return { ...reasons };
    } catch (error) {
      if (!(error instanceof IncusError)) throw error;
      // Every probe behind this map is an Incus round trip, so an unreachable hypervisor
      // fails all of them. Refusing every scenario would turn an outage into "this range
      // has no scenarios". Not cached, so the map fills in as soon as Incus answers.
      await this.store.logEvent("unavailable_probe_failed", String(error));
      return {};
    }
  }

  /**
   * Drop the cached unavailability map after the pool or templates change.
   *
   * Without this the cache outlives the change that fixes it: an instructor who has just
   * built the template still reads "not available on this range yet" for the rest of the
   * TTL, on the page they are looking at.
   */
  forgetUnavailable(): void {
    this.unavailableCache = null;
  }

  /** Build/replace scenario templates. Returns `{"<scenario>@<workload>": status}`. */
  async buildTemplates(
    ids?: readonly string[] | null,
    options: { force?: boolean; workloads?: readonly string[] | null } = {},
  ): Promise<Record<string, string>> {
    const force = options.force ?? false;
    const results: Record<string, string> = {};
    // An id that matches no scenario used to filter the pairs down to nothing, so the CLI
    // printed no lines at all and exited 0: a typo read exactly like a successful build.
    for (const scenarioId of ids ?? []) {
      try {
        this.repo().get(scenarioId);
      } catch (error) {
        if (!(error instanceof ScenarioError)) throw error;
        results[scenarioId] = `failed: ${error.message}`;
      }
    }
    for (const { scenario, workload } of this.workloadPairs(ids)) {
      if (options.workloads && !options.workloads.includes(workload)) continue;
      const key = workload ? `${scenario.id}@${workload}` : scenario.id;
      try {
        await this.ensureTemplate(scenario.id, { force, workload });
        results[key] = "ready";
      } catch (error) {
        if (!(error instanceof SessionError) && !(error instanceof IncusError) && !(error instanceof GuestError)) {
          throw error;
        }
        results[key] = `failed: ${error.message}`;
        await this.store.logEvent("template_failed", `${key}: ${error.message}`);
      }
    }
    this.forgetUnavailable();
    return results;
  }

  /**
   * Create `tpl-<scenario>[-<workload>]` with a `clean` snapshot, idempotently.
   *
   * Boots a clone of the workload's image, applies the fault, shuts the guest down and
   * snapshots. Idempotent because re-running a template build is a normal operator move
   * after editing a scenario. One template per pair is what lets the same fault be
   * offered on Windows 11 and Ubuntu without the scenario being written twice.
   */
  async ensureTemplate(
    scenarioId: string,
    options: { force?: boolean; workload?: string } = {},
  ): Promise<string> {
    const force = options.force ?? false;
    const workload = options.workload ?? "";
    const incus = this.requireIncus();
    const scenario = this.repo().get(scenarioId);
    const offered = platformWorkloads(scenario);
    if (workload && offered.length > 0 && !offered.includes(workload)) {
      throw new SessionError(
        `scenario ${scenarioId} is not offered on workload ${JSON.stringify(workload)}; ` +
          `it declares ${offered.join(", ")}`,
      );
    }
    const name = this.incusConfig.templateName(scenarioId, workload);
    if (!force && (await incus.exists(name)) && (await incus.hasSnapshot(name, POOL_SNAPSHOT))) {
      return name;
    }

    const baseImage = this.baseImage(scenario, workload);
    if (!(await incus.imageExists(baseImage))) {
      const entry = this.workloadEntry(workload);
      if (entry !== null) {
        throw new SessionError(
          `workload image ${JSON.stringify(baseImage)} for scenario ${scenarioId} is not ` +
            `published yet; build it with \`ontrak image build ${entry.id}\` (media: ` +
            `${entry.media.source}/${entry.media.kind})`,
        );
      }
      throw new SessionError(
        `golden image ${JSON.stringify(baseImage)} not found; run ` +
          "infra/build-golden-image.sh first (or `ontrak doctor` for details)",
      );
    }

    if (await incus.exists(name)) {
      await incus.stopInstance(name, { force: true });
      await incus.deleteInstance(name, { force: true });
    }

    const profiles = ["default", this.settings.incus.profile].filter((profile) => profile !== "");
    await incus.createInstance(name, baseImage, profiles);
    // The workload decides the hardware profile (legacy guests cannot use VirtIO and need
    // different disks/NICs), then the scenario layers on any extra hardware it needs:
    // hardware cannot be added from inside the guest, so it has to exist before boot.
    const entry = await this.applyWorkload(name, scenario, workload);
    if (entry !== null) {
      await this.store.logEvent(
        "workload_applied",
        `${scenarioId}@${workload} -> ${entry.id} (profile ${entry.deviceProfile}, ` +
          `${entry.resources.cpu} CPU / ${entry.resources.memoryMib} MiB)`,
      );
    }
    await this.applyInstanceSpec(name, scenario);

    // Which accelerator this guest runs on is a property of the *host*, not of the
    // scenario, and this is where it is decided: the pool and every student's machine are
    // clones of this template, and a clone carries the instance's config with it. It has
    // to happen while the instance is stopped — Incus refuses `raw.qemu.conf` on a
    // running VM.
    const info = await incus.getInstance(name);
    if (info !== null && info.kind === "virtual-machine") {
      const chosen = await this.applyAcceleration(name);
      if (chosen === TCG) {
        await this.store.logEvent(
          "qemu_accel",
          `${name}: this host cannot give the guest KVM, so it runs on QEMU's software ` +
            "emulator (slower to boot; nothing else about it changes)",
        );
      }
    }

    const driver = this.driverFor(scenario);
    const session = {
      ...newLabSession({ student: TEMPLATE_PSEUDO_STUDENT, scenarioId, state: "provisioning" }),
      createdAt: iso(this.now()),
      lastActivityAt: iso(this.now()),
      instance: name,
      rdpUser: this.settings.guest.user,
      rdpPassword: this.settings.guest.password,
      workload,
    };
    await incus.startInstance(name);
    try {
      await this.awaitGuest(session, this.readyTimeout(scenario), driver);
      await this.uploadScenarioFiles(session, scenario, { includeSetup: true, driver });
      const setupName = SETUP_NAMES[scenario.platform];
      const { result, combined } = await this.runSetup(session, scenario, driver, setupName);
      if (!result.ok || !combined.includes(SETUP_OK_MARKER)) {
        throw new SessionError(
          `${setupName} for ${scenarioId} did not report ${SETUP_OK_MARKER} (exit ` +
            `${result.exitCode}). Output tail: ${combined.slice(-800).trim()}`,
        );
      }
      await this.provisionConsoleTransport(session, scenario, driver);
    } finally {
      // Fault injection may leave the guest unresponsive (broken NIC, runaway CPU).
      // Force-stop anyway: the snapshot must capture the fault, and a half-built template
      // is worse than a hard power-off.
      try {
        await this.requireIncus().stopInstance(name, { force: true, timeout: 60 });
      } catch (error) {
        if (!(error instanceof IncusError)) throw error;
      }
    }

    await incus.createSnapshot(name, POOL_SNAPSHOT);
    this.forgetUnavailable();
    const label = workload ? `${scenarioId}@${workload}` : scenarioId;
    await this.store.logEvent("template_built", `${label} -> ${name}/${POOL_SNAPSHOT}`);
    return name;
  }

  /**
   * Run the fault-injection script, tolerating a fault that cuts its own channel.
   *
   * Some faults deliberately break the guest's connectivity, and a template build reads
   * the script's result *over* that connectivity: switching an adapter off DHCP ends the
   * session mid-script, so the marker never arrives even though the fault applied
   * perfectly. So a first attempt that came back with nothing at all is retried, on a
   * fresh connection to wherever the guest now is. "Nothing at all" is the discriminator
   * that matters: a script that *ran* and failed reports why, and repeating it would not
   * help.
   */
  private async runSetup(
    session: LabSession,
    scenario: Scenario,
    driver: GuestDriver,
    setupName: string,
  ): Promise<{ result: CommandResult; combined: string }> {
    const remote = this.join(scenario, "scenarios", scenario.id, setupName);
    let result: CommandResult | null = null;
    let combined = "";
    for (let attempt = 1; attempt <= SETUP_ATTEMPTS; attempt += 1) {
      result = await driver.runScriptFile(remote, {
        timeoutSeconds: this.settings.session.checkTimeoutSeconds,
        ...this.guestArgs(session),
      });
      combined = (result.stdout ?? "") + (result.stderr ?? "");
      if (result.ok && combined.includes(SETUP_OK_MARKER)) return { result, combined };
      if (result.stdout !== "" || attempt === SETUP_ATTEMPTS) return { result, combined };
      // The guest may still be settling the change that cut the first attempt, and the
      // address it moved to is only known to Incus.
      await this.sleep(SETUP_RETRY_DELAY_SECONDS);
      const moved = (await this.requireIncus().instanceIp(session.instance)) ?? "";
      if (moved === "") return { result, combined };
      if (moved !== session.hostIp) {
        await this.store.logEvent(
          "setup_retry",
          `${scenario.id}: ${setupName} moved the guest to ${moved}; asking again`,
          session.id,
        );
        session.hostIp = moved;
      } else {
        await this.store.logEvent(
          "setup_retry",
          `${scenario.id}: ${setupName} lost its connection; asking again`,
          session.id,
        );
      }
    }
    // Unreachable: the loop returns on its last attempt. Kept for the type checker, not
    // for the reader — and it refuses rather than reporting a phantom success.
    if (result === null) {
      throw new SessionError(`${setupName} for ${scenario.id} never ran`);
    }
    return { result, combined };
  }

  /**
   * Put an sshd in this Linux template, so the browser console can be a shell.
   *
   * Guacamole speaks RDP and SSH. A Linux container answers no RDP at all, so an RDP
   * connection pointed at one produced the console's "the remote desktop server is
   * currently unreachable" — a page that blamed the student's machine for a transport
   * that was never going to exist.
   *
   * It runs *after* the fault is injected and *after* the setup script has verified it,
   * and is the last thing written before the snapshot: a fault that touches accounts or
   * permissions must not be able to take the console's credential with it, and
   * re-asserting it here is what makes that true rather than lucky.
   */
  private async provisionConsoleTransport(
    session: LabSession,
    scenario: Scenario,
    driver: GuestDriver,
  ): Promise<void> {
    if (scenario.platform !== LINUX) return;
    if (!this.settings.guac.linuxSsh) return;
    // An empty lab password would make `chpasswd` set an empty one — a console anyone on
    // the lab network can open as root. Refusing is the only reading of "this deployment
    // has no credential for the guest" that cannot become that.
    if (this.settings.guest.password === "") {
      throw new SessionError(
        "guac.linux_ssh is on but guest.password is empty, so there is nothing to " +
          "authenticate the console with. Set ONTRAK_GUEST__PASSWORD (or turn " +
          "guac.linux_ssh off).",
      );
    }
    const runShell = driver.runShell;
    if (runShell === undefined) {
      throw new SessionError(
        `the ${driver.name} transport cannot run shell, so a Linux console cannot be provisioned`,
      );
    }
    const script = consoleTransportScript(this.settings.guest);
    const user = this.settings.guest.linuxUser || "root";
    const result = await runShell.call(driver, script, {
      timeoutSeconds: this.settings.session.checkTimeoutSeconds,
      ...this.guestArgs(session),
    });
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    if (!result.ok || !combined.includes(CONSOLE_SETUP_MARKER)) {
      throw new SessionError(
        "the SSH console transport was not installed, so the template's console would " +
          `report the remote desktop server as unreachable (exit ${result.exitCode}). ` +
          `Output tail: ${combined.slice(-800).trim()}`,
      );
    }
    await this.store.logEvent(
      "console_transport",
      `${session.scenarioId}: sshd on port ${this.settings.guest.sshPort} as ${user} (guac.linux_ssh)`,
    );
  }

  /** How long to wait for the guest's transport. Longer under emulation. */
  private readyTimeout(scenario: Scenario): number {
    if (scenario.platform === LINUX) return this.settings.guest.linuxReadyTimeoutSeconds;
    return this.settings.guest.readyTimeoutSeconds * this.accelTimeoutScale();
  }

  /** What the host's accelerator costs a guest's boot, as a multiplier. */
  private accelTimeoutScale(): number {
    // Only the *chosen* accelerator matters here, and a host that cannot virtualise pays
    // four times the boot. `applyForHost` is not called: this is a policy number, not a
    // write, and probing the host for it would be a side effect inside a getter.
    return this.acceleratorChoice() === TCG ? 4 : 1;
  }

  /** This host's accelerator, honoured from the environment exactly as the Python did. */
  private acceleratorChoice(): Accelerator {
    const client = this.incus;
    if (client === null) return "kvm";
    const pending: Record<string, string> = {};
    const adapter: QemuConfigClient = {
      configGet: () => "",
      setConfigs: (_name, values) => {
        for (const [key, value] of Object.entries(values)) pending[key] = value;
      },
    };
    return applyForHost(adapter, "");
  }

  /**
   * Point a stopped guest at this host's accelerator, through an async client.
   *
   * `qemu.ts` takes a *synchronous* config view (`configGet`) because Python's client was
   * synchronous, and this port's client is not. So the two values are read once, handed
   * to the decision as a snapshot, and the writes it decides on are applied afterwards.
   * That keeps `qemu.ts` pure and untouched and still writes exactly what it returns.
   */
  private async applyAcceleration(instance: string): Promise<Accelerator> {
    const client = this.requireIncus();
    const read = async (key: string): Promise<string> => {
      try {
        return (await client.configGet(instance, key)) ?? "";
      } catch (error) {
        if (!(error instanceof IncusError)) throw error;
        return "";
      }
    };
    const rawQemu = await read("raw.qemu");
    const rawConf = await read("raw.qemu.conf");
    const pending: Record<string, string> = {};
    const adapter: QemuConfigClient = {
      configGet: (_name, key) =>
        key === "raw.qemu" ? rawQemu : key === "raw.qemu.conf" ? rawConf : "",
      setConfigs: (_name, values) => {
        for (const [key, value] of Object.entries(values)) pending[key] = value;
      },
    };
    const chosen = applyForHost(adapter, instance);
    if (Object.keys(pending).length > 0) await client.setConfigs(instance, pending);
    return chosen;
  }

  /* ------------------------------------------------------------------ */
  /*  workloads                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve the catalog entry a scenario declares, if any.
   *
   * A scenario may name a workload to say "build this fault on that platform". Without a
   * catalog, or without the field, we fall back to the site's golden image, which is what
   * older scenarios assume.
   */
  workloadFor(scenario: Scenario): CatalogEntry | null {
    const workloadId = scenario.workload;
    if (workloadId === "" || this.catalog === null) return null;
    try {
      return this.catalog.get(workloadId);
    } catch (error) {
      if (!(error instanceof CatalogError)) throw error;
      void this.store.logEvent(
        "workload_unknown",
        `scenario ${scenario.id} names workload ${JSON.stringify(workloadId)}, which is not in the catalog`,
      );
      return null;
    }
  }

  /** Resolve an explicit workload id through the catalog. */
  workloadEntry(workloadId: string): CatalogEntry | null {
    if (workloadId === "" || this.catalog === null) return null;
    try {
      return this.catalog.get(workloadId);
    } catch (error) {
      if (!(error instanceof CatalogError)) throw error;
      void this.store.logEvent(
        "workload_unknown",
        `workload ${JSON.stringify(workloadId)} is not in the catalog`,
      );
      return null;
    }
  }

  /**
   * The Incus image alias a template should be built from.
   *
   * The pair's workload wins when it has one; otherwise the scenario's own declared
   * workload, and otherwise the site's golden image.
   */
  private baseImage(scenario: Scenario, workload: string): string {
    const entry = workload !== "" ? this.workloadEntry(workload) : this.workloadFor(scenario);
    if (entry === null) return this.settings.incus.imageAlias;
    if (entry.media.kind === "image" || entry.recipe === "image-alias" || entry.recipe === "container-image") {
      return entry.imageAlias;
    }
    // An ISO-based workload is turned into an image once by `ontrak image build`, which
    // publishes it under this alias.
    return `ontrak-${entry.id}`;
  }

  /**
   * Apply a workload's device profile and resource limits to a new instance.
   *
   * This is what makes the legacy platforms work at all: Windows 95/98/ME cannot use
   * VirtIO and need an IDE disk, an emulated NIC and a chipset they recognise, and none
   * of that can be changed from inside the guest.
   */
  private async applyWorkload(
    name: string,
    scenario: Scenario,
    workload: string,
  ): Promise<CatalogEntry | null> {
    const entry = workload !== "" ? this.workloadEntry(workload) : this.workloadFor(scenario);
    if (entry === null) return null;
    const incus = this.requireIncus();
    for (const [deviceName, rawSpec] of Object.entries(entry.resolvedDevices())) {
      const spec = isRecord(rawSpec) ? rawSpec : {};
      const options = isRecord(spec.options) ? { ...spec.options } : {};
      const type = typeof spec.type === "string" ? spec.type : "disk";
      if (type === "nic") {
        const network = options.network;
        if (network === null || network === undefined || network === "lab") {
          options.network = this.settings.incus.network;
        }
      }
      await incus.removeDevice(name, deviceName);
      await incus.addDevice(name, type, deviceName, options);
    }
    await incus.setConfigs(name, stringMap(entry.resolvedConfig()));
    return entry;
  }

  /** Apply scenario-declared instance config and devices to a new instance. */
  private async applyInstanceSpec(name: string, scenario: Scenario): Promise<void> {
    const incus = this.requireIncus();
    if (Object.keys(scenario.instanceConfig).length > 0) {
      await incus.setConfigs(name, stringMap(scenario.instanceConfig));
    }
    for (const device of scenario.instanceDevices) {
      const deviceName = typeof device.name === "string" ? device.name : "";
      const deviceType = typeof device.type === "string" ? device.type : "";
      if (deviceName === "" || deviceType === "") continue;
      const options: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(device)) {
        if (key === "name" || key === "type") continue;
        options[key] = value;
      }
      // A nic device on a network name is the common case: resolve it to the configured
      // lab bridge so scenarios stay portable. A device that already says how it attaches
      // -- 'nictype' or 'parent', an unmanaged adapter -- is left exactly as declared.
      // Incus refuses the two together, and an extra adapter has to be unmanaged anyway:
      // a second NIC on the lab network is rejected over the instance's own DNS record.
      const attachesItself = options.nictype !== undefined || options.parent !== undefined;
      if (deviceType === "nic" && !attachesItself) {
        const network = options.network;
        if (network === null || network === undefined || network === "lab") {
          options.network = this.settings.incus.network;
        }
      }
      await incus.addDevice(name, deviceType, deviceName, options);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  warm pool                                                          */
  /* ------------------------------------------------------------------ */

  private async allInstances(): Promise<InstanceInfo[]> {
    return await this.requireIncus().listInstances();
  }

  /** Instances a session still owns — pool names that must not be handed to anyone else. */
  private async claimedInstances(): Promise<Set<string>> {
    const live = await this.store.listSessions({ limit: 2000 });
    const claimed = new Set<string>();
    for (const session of live) {
      if (session.instance !== "" && !isTerminal(session.state)) claimed.add(session.instance);
    }
    return claimed;
  }

  /**
   * Pool instances for exactly this (scenario, workload) pair.
   *
   * Matched by parsing the name against the known workloads rather than by prefix:
   * `pool-a-1` (no workload) and `pool-a-linux-1` would otherwise both look like pools
   * for the same scenario.
   */
  private async poolInstances(
    scenarioId: string,
    options: { instances?: readonly InstanceInfo[]; workload?: string } = {},
  ): Promise<InstanceInfo[]> {
    const instances = options.instances ?? (await this.allInstances());
    const workload = options.workload ?? "";
    const out: InstanceInfo[] = [];
    for (const instance of instances) {
      const parsed = this.incusConfig.parsePoolName(instance.name);
      if (parsed === null) continue;
      if (parsed.scenario === scenarioId && parsed.workload === workload) out.push(instance);
    }
    return out;
  }

  private async availablePool(
    scenarioId: string,
    options: { instances?: readonly InstanceInfo[]; workload?: string } = {},
  ): Promise<InstanceInfo[]> {
    const claimed = await this.claimedInstances();
    const pool = await this.poolInstances(scenarioId, options);
    return pool.filter(
      (instance) => instanceRunning(instance) && instance.ipv4 !== "" && !claimed.has(instance.name),
    );
  }

  private async nextPoolIndex(
    scenarioId: string,
    options: { instances?: readonly InstanceInfo[]; workload?: string } = {},
  ): Promise<number> {
    let highest = 0;
    for (const instance of await this.poolInstances(scenarioId, options)) {
      const parsed = this.incusConfig.parsePoolName(instance.name);
      if (parsed !== null) highest = Math.max(highest, parsed.index);
    }
    return highest + 1;
  }

  async poolStatus(scenarioId?: string | null, workload?: string | null): Promise<PoolStatus[]> {
    if (this.incus === null) return [];
    const instances = await this.allInstances();
    const claimed = await this.claimedInstances();
    const rows: PoolStatus[] = [];
    for (const { scenario, workload: pairWorkload } of this.workloadPairs()) {
      if (scenarioId !== undefined && scenarioId !== null && scenario.id !== scenarioId) continue;
      if (workload !== undefined && workload !== null && pairWorkload !== workload) continue;
      const pool = await this.poolInstances(scenario.id, { instances, workload: pairWorkload });
      const ready = pool.filter(
        (instance) => instanceRunning(instance) && instance.ipv4 !== "" && !claimed.has(instance.name),
      ).length;
      const owned = pool.filter((instance) => claimed.has(instance.name)).length;
      const template = this.incusConfig.templateName(scenario.id, pairWorkload);
      const templateReady =
        (await this.incus.exists(template)) &&
        (await this.incus.hasSnapshot(template, POOL_SNAPSHOT));
      rows.push(
        new PoolStatus({
          scenarioId: scenario.id,
          workload: pairWorkload,
          target: this.poolTarget(scenario.id, pairWorkload),
          ready,
          claimed: owned,
          total: pool.length,
          templateReady,
        }),
      );
    }
    return rows;
  }

  /** The configured target for one pool, or the site default. */
  poolTarget(scenarioId: string, workload: string): number {
    return poolTargetFor(this.settings.pool, scenarioId, workload);
  }

  /**
   * Create `count` booted, unclaimed VMs for a (scenario, workload) pair.
   *
   * Returns how many were actually created (bounded by `pool.maxTotal`).
   */
  async prewarm(scenarioId: string, count: number, workload = ""): Promise<number> {
    this.requireIncus();
    if (count <= 0) return 0;
    const instances = await this.allInstances();
    let poolTotal = 0;
    for (const { scenario, workload: pairWorkload } of this.workloadPairs()) {
      poolTotal += (await this.poolInstances(scenario.id, { instances, workload: pairWorkload })).length;
    }
    const budget = Math.max(0, this.settings.pool.maxTotal - poolTotal);
    const toCreate = Math.min(count, budget);
    if (toCreate === 0) {
      await this.store.logEvent(
        "prewarm_skipped",
        `${scenarioId}: pool at max_total=${this.settings.pool.maxTotal}`,
      );
      return 0;
    }
    let created = 0;
    let index = await this.nextPoolIndex(scenarioId, { instances, workload });
    for (let attempt = 0; attempt < toCreate; attempt += 1) {
      const name = this.incusConfig.poolName(scenarioId, index, workload);
      index += 1;
      try {
        await this.provisionPoolInstance(scenarioId, name, workload);
      } catch (error) {
        if (!(error instanceof SessionError) && !(error instanceof IncusError) && !(error instanceof GuestError)) {
          throw error;
        }
        await this.store.logEvent("prewarm_failed", `${scenarioId}@${workload} ${name}: ${error.message}`);
        break;
      }
      created += 1;
    }
    if (created > 0) {
      const label = workload ? `${scenarioId}@${workload}` : scenarioId;
      await this.store.logEvent("prewarmed", `${label}: ${created} VM(s)`);
    }
    this.forgetUnavailable();
    return created;
  }

  private async provisionPoolInstance(scenarioId: string, name: string, workload = ""): Promise<string> {
    const scenario = this.repo().get(scenarioId);
    this.requireIncus();
    await this.cloneFromTemplate(scenario, name, workload);
    const session = {
      ...newLabSession({ student: TEMPLATE_PSEUDO_STUDENT, scenarioId, state: "provisioning" }),
      createdAt: iso(this.now()),
      lastActivityAt: iso(this.now()),
      instance: name,
      rdpUser: this.settings.guest.user,
      rdpPassword: this.settings.guest.password,
      workload,
    };
    await this.awaitGuest(session, this.readyTimeout(scenario), this.driverFor(scenario));
    return name;
  }

  /** Top every pool back up to its configured target. */
  async refillPool(scenarioIds?: readonly string[] | null): Promise<Record<string, number>> {
    const created: Record<string, number> = {};
    for (const status of await this.poolStatus()) {
      if (scenarioIds && scenarioIds.length > 0 && !scenarioIds.includes(status.scenarioId)) continue;
      if (status.deficit > 0 && status.templateReady) {
        const made = await this.prewarm(status.scenarioId, status.deficit, status.workload);
        if (made > 0) created[status.label] = made;
      }
    }
    return created;
  }

  /** Throw the template's `clean` snapshot away and clone a fresh machine from it. */
  private async cloneFromTemplate(scenario: Scenario, targetName: string, workload = ""): Promise<string> {
    const incus = this.requireIncus();
    const template = this.incusConfig.templateName(scenario.id, workload);
    if (!(await incus.exists(template)) || !(await incus.hasSnapshot(template, POOL_SNAPSHOT))) {
      const label = workload ? `${scenario.id}@${workload}` : scenario.id;
      throw new SessionError(
        `template ${template} is missing snapshot ${POOL_SNAPSHOT}; run ` +
          `\`ontrak template build ${label}\``,
      );
    }
    await incus.copyInstance(`${template}/${POOL_SNAPSHOT}`, targetName, true);
    await incus.startInstance(targetName);
    return targetName;
  }

  /** Wait for an address, then for the guest transport to answer. */
  private async awaitGuest(
    session: LabSession,
    timeoutSeconds: number,
    driver: GuestDriver | null = null,
  ): Promise<string> {
    const transport = driver ?? this.driver;
    const incus = this.requireIncus();
    const deadline = this.now().getTime() + timeoutSeconds * 1_000;
    let ip = "";
    while (this.now().getTime() < deadline) {
      ip = (await incus.instanceIp(session.instance)) ?? "";
      if (ip !== "") break;
      await this.sleep(3);
    }
    if (ip === "") {
      throw new SessionError(
        `${session.instance} never obtained an address on ${this.settings.incus.network}`,
      );
    }
    session.hostIp = ip;
    const remaining = Math.max(30, Math.floor((deadline - this.now().getTime()) / 1_000));
    if (!(await transport.waitReady(session, remaining))) {
      throw new SessionError(
        `${session.instance} at ${ip} never became reachable over the ${transport.name} transport`,
      );
    }
    return ip;
  }

  /* ------------------------------------------------------------------ */
  /*  scenario files                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Copy the shared lib, the scenario scripts and any resources into the guest.
   *
   * The layout is identical on both platforms — `lib/` next to `scenarios/<id>/` — so a
   * script can find its library with the same relative path whether it is PowerShell or
   * shell. Only the files a scenario declares are uploaded rather than the whole
   * directory tree, because unlike the Python (which read them from the checkout) this
   * port reads them from disk by name, and a file it does not know about would be a
   * silent no-op.
   */
  private async uploadScenarioFiles(
    session: LabSession,
    scenario: Scenario,
    options: { includeSetup: boolean; driver?: GuestDriver },
  ): Promise<void> {
    const driver = options.driver ?? this.driverFor(scenario);
    const args = this.guestArgs(session);
    const linux = scenario.platform === LINUX;
    const lib = linux ? this.shellLibSource() : this.libSource();
    await driver.uploadFile(lib, this.join(scenario, "lib", linux ? SHELL_COMMON_LIB : COMMON_LIB), args);
    const scriptDir = this.scenarioScriptDir(scenario);
    if (options.includeSetup) {
      const setupName = SETUP_NAMES[scenario.platform];
      await driver.uploadFile(
        join(scriptDir, setupName),
        this.join(scenario, "scenarios", scenario.id, setupName),
        args,
      );
    }
    const checkName = CHECK_NAMES[scenario.platform];
    await driver.uploadFile(
      join(scriptDir, checkName),
      this.join(scenario, "scenarios", scenario.id, checkName),
      args,
    );
    for (const resource of scenario.resources) {
      const relative = linux ? resource : resource.replace(/\//g, "\\");
      await driver.uploadFile(
        join(scriptDir, resource),
        this.join(scenario, "scenarios", scenario.id, "resources", relative),
        args,
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /*  allocation                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Create the session row and return immediately.
   *
   * Split from `provision` so the portal can answer a browser instantly and do the slow
   * part (clone + boot + handshake) in the background while the page polls for progress.
   * Idempotent per (student, scenario): reloading a page or re-running the CLI will not
   * burn a second VM.
   *
   * `timeLimitMinutes` is the student's clock for this session; it defaults to
   * `session.ttlMinutes` and can be changed later, which is why it is stored on the row
   * rather than derived from config on read.
   */
  async createSession(
    student: string,
    scenarioId: string,
    options: { workload?: string | null; timeLimitMinutes?: number | null } = {},
  ): Promise<LabSession> {
    const who = student.trim().toLowerCase();
    this.repo().get(scenarioId); // raises if unknown
    if (options.workload && this.catalog !== null) {
      // A typo'd platform should read like every other user error, not leak a catalog
      // exception out of the session API.
      try {
        this.catalog.get(options.workload);
      } catch (error) {
        if (!(error instanceof CatalogError)) throw error;
        throw new SessionError(
          `unknown workload ${JSON.stringify(options.workload)}; see \`ontrak catalog list\``,
        );
      }
    }
    const limit = Math.trunc(options.timeLimitMinutes ?? defaultTimeLimit(this.settings.session));
    const workload = await this.resolveWorkload(scenarioId, options.workload ?? null);
    if (limit <= 0) {
      throw new SessionError("the time limit must be a positive number of minutes");
    }
    const live = await this.store.liveSessionsFor(who);
    for (const existing of live) {
      if (existing.scenarioId === scenarioId && existing.state !== "error") {
        await this.touch(existing);
        return existing;
      }
    }
    if (live.length >= this.settings.session.maxPerStudent) {
      const busy = [...new Set(live.map((session) => session.scenarioId))].sort().join(", ");
      throw new SessionError(
        `${who} already has a live session (${busy}); reset or end it first ` +
          "(session.max_per_student)",
      );
    }

    const now = this.now();
    const session = {
      ...newLabSession({ student: who, scenarioId, state: "requested" }),
      createdAt: iso(now),
      lastActivityAt: iso(now),
      expiresAt: iso(new Date(now.getTime() + limit * 60_000)),
      rdpUser: this.settings.guest.user,
      rdpPassword: this.settings.guest.password,
      workload: workload === "" ? "" : workload,
      timeLimitMinutes: limit,
    };
    const saved = await this.store.createSession(session);
    await this.store.logEvent(
      "requested",
      `${who} requested ${scenarioId}` +
        (workload !== "" ? ` on workload ${workload}` : "") +
        ` with a ${limit} minute limit`,
      saved.id,
    );
    return saved;
  }

  /**
   * Work out which platform a session should be built on.
   *
   * An explicit choice wins, but only if the scenario actually offers it; otherwise the
   * scenario's first declared workload is used, and a scenario that declares none falls
   * back to the site's golden image.
   */
  private async resolveWorkload(scenarioId: string, workload: string | null): Promise<string> {
    const scenario = this.repo().get(scenarioId);
    const offered = platformWorkloads(scenario);
    const wanted = (workload ?? "").trim();
    if (wanted !== "") {
      if (offered.length > 0 && !offered.includes(wanted)) {
        throw new SessionError(
          `scenario ${scenarioId} is not offered on workload ${JSON.stringify(wanted)}; ` +
            `it declares: ${offered.join(", ")}`,
        );
      }
      if (offered.length === 0 && this.catalog !== null) {
        // A scenario without declared workloads can still be asked for on a platform, as
        // long as that platform can host its family of fault.
        const entry = this.workloadEntry(wanted);
        if (entry === null) {
          throw new SessionError(`unknown workload ${JSON.stringify(wanted)}; see \`ontrak catalog list\``);
        }
        const families = entry.scenarioFamilies;
        if (families.length > 0 && !families.includes(scenario.category)) {
          throw new SessionError(
            `workload ${wanted} does not support ${scenario.category} scenarios`,
          );
        }
      }
      return wanted;
    }
    return offered.length > 0 ? (offered[0] ?? "") : "";
  }

  /** Set or change a student's time limit mid-session. */
  async setTimeLimit(session: LabSession, minutes: number): Promise<LabSession> {
    const value = Math.trunc(minutes);
    if (value <= 0) {
      throw new SessionError("the time limit must be a positive number of minutes");
    }
    const updated = sessionSetTimeLimit(session, value, this.now());
    await this.store.saveSession(updated);
    await this.store.logEvent("time_limit_set", `${value} min`, updated.id);
    return updated;
  }

  /** Grant extra time as a delta ("+15 minutes"). */
  async extendLimit(session: LabSession, minutes: number): Promise<LabSession> {
    return await this.extend(session, Math.trunc(minutes));
  }

  /**
   * One lock per session, so two callers cannot provision the same session twice.
   *
   * Python used a `threading.Lock` per session id; this is a promise chain per session id.
   * The guarantee is the one that matters: the second caller runs after the first has
   * finished, and then re-reads the session, so it returns the same machine instead of
   * cloning a second one and orphaning it.
   */
  private async withSessionLock<T>(key: number, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      key,
      previous.then(() => gate),
    );
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(key) === previous.then(() => gate)) this.locks.delete(key);
    }
  }

  /**
   * Bring a requested session up: claim a pooled VM or clone the template.
   *
   * The state is re-read from the store *inside* the lock, so a second caller (a page
   * reload, an instructor, the CLI) waits for the first to finish and then returns the
   * same session instead of cloning a second VM.
   */
  async provision(session: LabSession): Promise<LabSession> {
    const key = session.id ?? 0;
    return await this.withSessionLock(key, async () => {
      const fresh = session.id === null ? null : await this.store.getSession(session.id);
      const target = fresh ?? session;
      if (target.state !== "requested" && target.state !== "allocating") return target;
      return await this.provisionLocked(target);
    });
  }

  private async provisionLocked(session: LabSession): Promise<LabSession> {
    const scenario = this.repo().get(session.scenarioId);
    session.state = "allocating";
    await this.store.saveSession(session);

    const driver = this.driverFor(scenario);
    try {
      if ((await this.claimPool(session)) === null) {
        const name = this.incusConfig.sessionName(scenario.id, session.id ?? "x", session.workload);
        await this.cloneFromTemplate(scenario, name, session.workload);
        session.instance = name;
        await this.store.saveSession(session);
        await this.store.logEvent("cloned", name, session.id);
      }
      await this.awaitGuest(session, this.readyTimeout(scenario), driver);
      if (this.settings.session.randomizeCredentials && scenario.platform !== LINUX) {
        await this.rotateCredentials(session);
      }
      session.state = "ready";
      session.readyAt = iso(this.now());
      session.lastActivityAt = iso(this.now());
      await this.store.saveSession(session);
      await this.store.logEvent("ready", `${session.instance} at ${session.hostIp}`, session.id);
    } catch (error) {
      // Surfaced to the student verbatim: the row's `error` is what the page shows, and the
      // Python deliberately let the guest's own message through.
      const message = error instanceof Error ? error.message : String(error);
      session.state = "error";
      session.error = message;
      await this.store.saveSession(session);
      await this.store.logEvent("provision_failed", message, session.id);
    }
    return session;
  }

  /** Create and provision in one call. Returns a READY or ERROR session. */
  async allocate(
    student: string,
    scenarioId: string,
    options: { workload?: string | null; timeLimitMinutes?: number | null } = {},
  ): Promise<LabSession> {
    return await this.provision(await this.createSession(student, scenarioId, options));
  }

  private async claimPool(session: LabSession): Promise<string | null> {
    // A pool is per (scenario, workload): the same fault on Windows 11 and on Ubuntu are
    // different machines, so a Windows pool must never hand a student a machine for a
    // Linux scenario.
    const available = await this.availablePool(session.scenarioId, { workload: session.workload });
    if (available.length === 0) return null;
    // Lowest name first: it has been idle longest and its page cache is cold.
    const chosen = [...available].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))[0];
    if (chosen === undefined) return null;
    session.instance = chosen.name;
    session.hostIp = chosen.ipv4;
    session.state = "provisioning";
    await this.store.saveSession(session);
    await this.store.logEvent("claimed_pool", chosen.name, session.id);
    return chosen.name;
  }

  /**
   * Give a Windows session its own credential.
   *
   * Windows-only: a Linux guest is reached through the Incus agent or a key, so there is
   * no password to rotate for the student's login.
   */
  private async rotateCredentials(session: LabSession): Promise<void> {
    const password = randomPassword(20, (limit) => Math.floor(Math.random() * limit));
    const script =
      `$p = ConvertTo-SecureString ${quotePs(password)} -AsPlainText -Force;` +
      `Set-LocalUser -Name ${quotePs(this.settings.guest.user)} -Password $p;` +
      "'rotated'";
    const result = await this.driver.runPowerShell(script, {
      timeoutSeconds: 60,
      ...this.guestArgs(session),
    });
    if (result.ok) {
      session.rdpPassword = password;
    } else {
      await this.store.logEvent(
        "credential_rotation_failed",
        (result.stderr || result.stdout).slice(-400),
        session.id,
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /*  using a session                                                    */
  /* ------------------------------------------------------------------ */

  /** Mark a session in use (the student opened the console). */
  async claimForUse(session: LabSession): Promise<LabSession> {
    if (session.state === "ready" || session.state === "passed") session.state = "in_use";
    await this.touch(session);
    await this.store.saveSession(session);
    return session;
  }

  /** Record activity. Stored, because the idle sweep reads it back from the row. */
  async touch(session: LabSession): Promise<void> {
    session.lastActivityAt = iso(this.now());
    if (session.id !== null) {
      await this.store.saveSession(session);
    }
  }

  async extend(session: LabSession, minutes: number): Promise<LabSession> {
    const updated = sessionExtend(session, minutes, this.now());
    await this.store.saveSession(updated);
    await this.store.logEvent("extended", `+${minutes} min`, updated.id);
    return updated;
  }

  /** Reveal the next hint, and never more than the scenario has. */
  async revealHint(session: LabSession, scenario?: Scenario | null): Promise<LabSession> {
    const target = scenario ?? this.repo().get(session.scenarioId);
    if (session.hintLevel < target.hints.length) {
      session.hintLevel += 1;
      await this.store.saveSession(session);
      await this.store.logEvent("hint", `level ${session.hintLevel}`, session.id);
    }
    return session;
  }

  /* ------------------------------------------------------------------ */
  /*  the in-house ticket                                                */
  /* ------------------------------------------------------------------ */

  /**
   * The write-up rubric for a scenario, or `null` when it has no ticket.
   *
   * A form with no fields is treated as "no ticket" rather than as a rubric the student
   * can never satisfy — the Python's rule, and the reason a scenario written before the
   * ticket existed needs no change to keep grading as it always did.
   */
  ticketForm(scenario: Scenario): TicketForm | null {
    const form = loadForm(scenario.ticket);
    if (form === null) return null;
    return form.fields.length === 0 ? null : form;
  }

  ticketFormFor(session: LabSession): TicketForm | null {
    return this.ticketForm(this.repo().get(session.scenarioId));
  }

  /** Keep the student's work in progress so a page reload does not lose it. */
  async saveTicketDraft(
    session: LabSession,
    values: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    const stored = Object.fromEntries(
      Object.entries(values ?? {}).map(([key, value]) => [String(key), asText(value)]),
    );
    if (session.id !== null) await this.store.saveTicketDraft(session.id, stored);
    return stored;
  }

  /** What the student has typed so far, or `{}`. */
  async ticketAnswers(session: LabSession): Promise<Record<string, string>> {
    return await this.store.ticketDraft(session.id ?? 0);
  }

  /** Mark the write-up without recording it (the preview a student sees). */
  async gradeTicket(
    session: LabSession,
    values?: Record<string, unknown>,
  ): Promise<TicketGrade | null> {
    const scenario = this.repo().get(session.scenarioId);
    const form = this.ticketForm(scenario);
    if (form === null) return null;
    const answers = values !== undefined ? values : await this.ticketAnswers(session);
    return markTicket(form, answers, { sessionId: session.id ?? 0, scenarioId: scenario.id });
  }

  /* ------------------------------------------------------------------ */
  /*  grading                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Grade the current VM state against the scenario.
   *
   * `record` decides whether this attempt is written to the results table. By default it
   * follows `session.persistProgress`: a student may check their work as often as they
   * like, but only the grade they hand in at "Complete & End" is kept, so nothing is
   * scored on progress.
   */
  async runChecks(session: LabSession, record?: boolean): Promise<ScoreReport> {
    const shouldRecord = record ?? this.settings.session.persistProgress;
    const scenario = this.repo().get(session.scenarioId);
    if (session.instance === "") {
      return { ...newScoreReport({ sessionId: session.id ?? 0, scenarioId: session.scenarioId }), error: "session has no VM" };
    }

    session.state = "checking";
    await this.store.saveSession(session);
    const driver = this.driverFor(scenario);
    let report: ScoreReport;
    try {
      await this.uploadScenarioFiles(session, scenario, { includeSetup: false, driver });
      const result = await driver.runScriptFile(
        this.join(scenario, "scenarios", scenario.id, CHECK_NAMES[scenario.platform]),
        {
          timeoutSeconds: this.settings.session.checkTimeoutSeconds,
          ...this.guestArgs(session),
        },
      );
      report = evaluate(scenario, session.id ?? 0, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
      if (!result.ok && report.outcomes.length === 0) {
        report.notes.push(`check script exited ${result.exitCode}`);
      }
    } catch (error) {
      if (!(error instanceof GuestError) && !(error instanceof IncusError) && !(error instanceof SessionError)) {
        throw error;
      }
      report = {
        ...newScoreReport({ sessionId: session.id ?? 0, scenarioId: session.scenarioId }),
        error: `could not run checks: ${error.message}`,
      };
    }

    session.checksRun += 1;
    session.lastActivityAt = iso(this.now());
    if (report.error === "") {
      session.bestScore = Math.max(session.bestScore, report.score);
      if (report.resolved) session.resolved = true;
    }
    // The VM stays usable either way: a failed check is a coaching moment, not a dead end.
    // Resolution is sticky once earned.
    session.state = session.resolved ? "passed" : "in_use";
    await this.store.saveSession(session);
    if (session.id !== null) {
      if (shouldRecord) await this.store.addResult(report, session.student);
      await this.store.logEvent(
        shouldRecord ? "checked" : "checked_discarded",
        `${Math.round(report.score)}% (${report.outcomes.filter((outcome) => outcome.passed).length}/` +
          `${report.outcomes.length} objectives)`,
        session.id,
      );
    }
    session.lastReport = report;
    return report;
  }

  /**
   * The student's "Complete & End": grade once, keep the result, destroy the VM.
   *
   * This is the only grading run whose outcome is stored. It marks two things and blends
   * them: the **machine**, from the scenario's check script, and the **ticket**, from the
   * write-up the student handed in. A scenario with no form grades exactly as it always
   * did; one with a form treats documentation as part of the work — an unsubmitted
   * write-up scores zero and the attempt cannot be marked resolved, which is the honest
   * reading of "the fix nobody recorded".
   *
   * After it the session is terminal, the instance is gone, and the student gets a fresh
   * machine next time — which is also what makes a reset unnecessary to be perfectly clean.
   *
   * One case needs care and is therefore spelled out: when the machine could not be graded
   * at all, a good write-up must not manufacture a passing score for an unverified machine.
   * The ticket is still marked, stored and logged — the work happened — but it is left out
   * of the number and the report says so.
   */
  async complete(session: LabSession, values?: Record<string, unknown>): Promise<ScoreReport> {
    if (isTerminal(session.state)) {
      throw new SessionError(
        `session ${session.id} is already ${session.state}; there is nothing to complete`,
      );
    }
    // `passed` and `failed` are not terminal: a check that resolves leaves the machine in
    // the student's hands, so they sit in `passed` before the submission as well as after
    // it. `completedAt` is the fact that separates the two, and without this guard a double
    // submit — the portal's Complete button is a POST — would grade a VM that no longer
    // exists and store a second, 0% attempt over a pass.
    if (session.completedAt !== "") {
      throw new SessionError(
        `session ${session.id} was already completed at ${session.completedAt}; ` +
          "there is nothing to complete",
      );
    }
    const scenario = this.repo().get(session.scenarioId);

    // Machine first, not recorded yet: the grade that gets stored is the blend, and
    // storing the machine half separately would put two rows in the results table for one
    // submission.
    const report = await this.runChecks(session, false);
    if (values !== undefined) await this.saveTicketDraft(session, values);
    report.machineScore = report.machineScore || report.score;

    const form = this.ticketForm(scenario);
    let ticket: TicketGrade | null = null;

    // A machine that could not be graded: mark the write-up, keep it, log it, but leave the
    // attempt at zero. Blending a good write-up into an unverified machine would manufacture
    // a pass, which is the one thing the score must never do.
    if (form !== null && report.error !== "") {
      report.notes.push(
        "machine grading failed, so the write-up was marked but not blended into the score",
      );
      ticket = await this.gradeTicket(session);
      report.ticketScore = ticket === null ? 0 : ticket.score;
      report.ticketWeight = form.weight;
      report.ticketOutcomes = ticket === null ? [] : ticket.outcomes.map(ticketOutcomeToDict);
      report.resolved = false;
      return await this.finishSubmission(session, report, ticket);
    }

    if (form !== null) {
      ticket = await this.gradeTicket(session);
      report.ticketScore = ticket === null ? 0 : ticket.score;
      report.ticketWeight = form.weight;
      report.ticketOutcomes = ticket === null ? [] : ticket.outcomes.map(ticketOutcomeToDict);
      report.score = blend(report.machineScore, ticket, form.weight);
      if (ticket === null || !ticket.submitted) {
        report.notes.push(
          `no ticket was submitted; the write-up is ${formatFixed(form.weight, 0)}% of this ` +
            "grade and counts as zero",
        );
        report.resolved = false;
      } else if (
        // The write-up's own mark is judged by the app's one rule, the same way the machine
        // half is (§3/C5): a rubric's pass mark is a percentage, and asking the module that
        // owns "did this clear the bar" is what stops a lab verdict and a simulated one
        // from disagreeing about the same number. Its cost is the same as C5's — the verdict
        // is taken at the whole-percent boundary, so a 59.6% write-up clears a 60% mark
        // where the Python called it short.
        !clearedPassMark({ score: ticket.score, maxScore: 100, passScore: form.passScore })
      ) {
        report.notes.push(
          `the write-up scored ${formatFixed(ticket.score, 0)}% (pass mark ${formatFixed(form.passScore, 0)}%)`,
        );
        report.resolved = false;
      } else {
        report.notes.push(
          `write-up: ${formatFixed(ticket.score, 0)}% ` +
            `(${ticketGradePassedCount(ticket)}/${ticket.outcomes.length} fields)`,
        );
      }
    }

    report.resolved = Boolean(report.resolved);
    report.notes.push(`final submission judged against ${scenario.title}`);
    if (report.ticketScore !== null) report.notes.push(scoreReportBreakdown(report));
    return await this.finishSubmission(session, report, ticket);
  }

  /**
   * The half of `complete` both paths share: mark the session done, store the result, log
   * it, destroy the VM.
   *
   * Split out because the ticket branch and the machine-only branch differ only in the
   * report they arrive with — and a second copy of "set the state, save, add the result,
   * log the ticket, log completion, destroy" is where the two would drift apart.
   */
  private async finishSubmission(
    session: LabSession,
    report: ScoreReport,
    ticket: TicketGrade | null,
  ): Promise<ScoreReport> {
    session.state = report.resolved ? "passed" : "failed";
    session.resolved = Boolean(report.resolved);
    session.bestScore = Math.max(session.bestScore, report.score);
    session.completedAt = iso(this.now());
    session.notes = `${session.notes} [completed]`.trim();
    await this.store.saveSession(session);

    await this.store.addResult(report, session.student);
    if (ticket !== null) {
      await this.store.saveTicket(ticket, session.student);
      await this.store.clearTicketDraft(session.id ?? 0);
      await this.store.logEvent("ticket_graded", ticketGradeSummaryLine(ticket), session.id);
    }
    await this.store.logEvent("completed", scoreReportSummaryLine(report), session.id);

    if (this.settings.session.destroyOnComplete) {
      await this.destroyInstance(session.instance);
      session.instance = "";
      session.hostIp = "";
      await this.store.saveSession(session);
    }
    session.lastReport = report;
    return report;
  }

  /**
   * Delete unclaimed pooled VMs for a scenario (end of a class window).
   *
   * Only unclaimed instances go: a student still working keeps their machine.
   * `workload === null` drains every platform this scenario is offered on, which is what a
   * class-ending `ontrak pool drain --scenario X` means.
   */
  async drainPool(scenarioId: string, workload?: string | null): Promise<number> {
    if (this.incus === null) return 0;
    const pairs =
      workload === undefined || workload === null
        ? this.workloadPairs([scenarioId]).map((pair) => pair.workload)
        : [workload];
    const seen: string[] = [];
    for (const pair of pairs) {
      if (!seen.includes(pair)) seen.push(pair);
    }
    let removed = 0;
    for (const pair of seen) {
      for (const instance of await this.availablePool(scenarioId, { workload: pair })) {
        await this.destroyInstance(instance.name);
        removed += 1;
      }
    }
    if (removed > 0) {
      const label = workload === undefined || workload === null || workload === ""
        ? scenarioId
        : `${scenarioId}@${workload}`;
      await this.store.logEvent("pool_drained", `${label}: ${removed} VM(s)`);
    }
    return removed;
  }

  /* ------------------------------------------------------------------ */
  /*  reset / recycle                                                    */
  /* ------------------------------------------------------------------ */

  /** Throw the VM away and hand back a fresh clone of the clean snapshot. */
  async reset(session: LabSession): Promise<LabSession> {
    if (isTerminal(session.state)) {
      throw new SessionError(`session ${session.id} is ${session.state} and cannot be reset`);
    }
    const scenario = this.repo().get(session.scenarioId);
    session.state = "recycling";
    session.error = "";
    await this.store.saveSession(session);

    await this.destroyInstance(session.instance);
    session.instance = "";
    session.hostIp = "";
    await this.store.saveSession(session);

    try {
      if ((await this.claimPool(session)) === null) {
        const name = this.incusConfig.sessionName(
          session.scenarioId,
          session.id ?? "x",
          session.workload,
        );
        await this.cloneFromTemplate(scenario, name, session.workload);
        session.instance = name;
        await this.store.saveSession(session);
      }
      await this.awaitGuest(session, this.readyTimeout(scenario), this.driverFor(scenario));
      if (this.settings.session.randomizeCredentials && scenario.platform !== LINUX) {
        await this.rotateCredentials(session);
      }
      session.state = "ready";
      session.readyAt = iso(this.now());
      session.lastActivityAt = iso(this.now());
      await this.store.logEvent("reset", `${session.instance} at ${session.hostIp}`, session.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session.state = "error";
      session.error = `reset failed: ${message}`;
      await this.store.logEvent("reset_failed", message, session.id);
    }
    await this.store.saveSession(session);
    return session;
  }

  /** Destroy the VM and close the session (the student's time is up). */
  async recycle(session: LabSession, reason = "expired"): Promise<void> {
    session.state = "recycling";
    await this.store.saveSession(session);
    await this.destroyInstance(session.instance);
    session.state = "destroyed";
    session.hostIp = "";
    session.notes = `${session.notes} [${reason}]`.trim();
    session.lastActivityAt = iso(this.now());
    await this.store.saveSession(session);
    await this.store.logEvent("recycled", reason, session.id);
  }

  async end(session: LabSession, reason = "student quit"): Promise<void> {
    await this.recycle(session, reason);
  }

  private async destroyInstance(name: string): Promise<void> {
    if (name === "" || this.incus === null) return;
    try {
      if (await this.incus.exists(name)) {
        await this.incus.stopInstance(name, { force: true, timeout: 60 });
        await this.incus.deleteInstance(name, { force: true });
      }
    } catch (error) {
      if (!(error instanceof IncusError)) throw error;
      await this.store.logEvent("destroy_failed", `${name}: ${error.message}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  maintenance                                                        */
  /* ------------------------------------------------------------------ */

  /** Expire sessions and top the pool back up. Safe to run in a loop. */
  async reap(): Promise<ReapResult> {
    const recycled: number[] = [];
    const now = this.now();
    const watched: readonly SessionState[] = ["ready", "in_use", "passed", "failed", "checking"];
    for (const session of await this.store.listSessions({ states: watched })) {
      if (sessionIsExpired(session, now)) {
        await this.recycle(session, "ttl_expired");
        recycled.push(session.id ?? 0);
        continue;
      }
      // The lab measures idle against the clock the sessions were stamped with, and so
      // does this: the manager's clock is injected, so a test that moves time forward gets
      // an idle window that agrees with the stamps. Reading the real clock here would
      // compare a fabricated `lastActivityAt` against today and either recycle everything
      // or nothing, depending on which side of it the fixture's start happened to sit.
      const idleFor = secondsSince(session.lastActivityAt, now) ?? 0;
      if (idleFor > this.settings.session.idleRecycleMinutes * 60) {
        // Never reap a grading run in flight.
        if (session.state === "checking") continue;
        await this.recycle(session, `idle_${Math.floor(idleFor / 60)}m`);
        recycled.push(session.id ?? 0);
      }
    }

    // Stale ALLOCATING/PROVISIONING rows: surface them for the instructor but do not keep
    // half-built instances around forever.
    const stuck: readonly SessionState[] = ["allocating", "provisioning"];
    for (const session of await this.store.listSessions({ states: stuck })) {
      const created = parseIso(session.createdAt);
      const age = created === null ? 0 : (now.getTime() - created.getTime()) / 1000;
      if (age > this.settings.pool.claimTimeoutSeconds * 4) {
        await this.destroyInstance(session.instance);
        session.state = "error";
        session.error = session.error === "" ? "provisioning timed out" : session.error;
        session.instance = "";
        await this.store.saveSession(session);
      }
    }

    const refilled = this.settings.pool.enabled ? await this.refillPool() : {};
    return { recycled, refilled };
  }

  /**
   * Session counts by state, the pools, and the templates.
   *
   * The Python also counted students from its own `users` table; that table is superseded
   * by this app's identity (§3/C2), so there is no count of it here — a number derived from
   * a table the app no longer owns would be a lie with a plausible shape.
   */
  async stats(): Promise<Record<string, unknown>> {
    const sessionCounts: Record<string, number> = {};
    for (const state of [
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
    ] as const) {
      sessionCounts[state] = await this.store.countSessions([state]);
    }
    return {
      sessions: sessionCounts,
      events: await this.store.countEvents(),
      pool: (await this.poolStatus()).map((status) => status.toDict()),
      templates: await this.templateStatus(),
    };
  }

  /* ------------------------------------------------------------------ */
  /*  lookups                                                            */
  /* ------------------------------------------------------------------ */

  /** One session, refusing somebody else's unless the caller is an instructor. */
  async getOwnedSession(
    student: string,
    sessionId: number,
    allowInstructor = false,
  ): Promise<LabSession> {
    const session = await this.store.getSession(sessionId);
    if (session === null) throw new SessionError(`session ${sessionId} not found`);
    if (!allowInstructor && session.student !== student.trim().toLowerCase()) {
      throw new SessionError(`session ${sessionId} belongs to another student`);
    }
    return session;
  }

  /** How long a session has existed, from the moment it was ready (or created). */
  sessionAgeMinutes(session: LabSession): number {
    const started = parseIso(session.readyAt) ?? parseIso(session.createdAt) ?? this.now();
    return (this.now().getTime() - started.getTime()) / 60_000;
  }

  /** The events recorded against one session, newest last. */
  async sessionEvents(session: LabSession, limit = 50): Promise<LabEvent[]> {
    if (session.id === null) return [];
    return await this.store.eventsFor(session.id, limit);
  }
}

/**
 * A manager over an in-memory hypervisor and an in-memory store.
 *
 * Named because two callers want exactly this: demo mode (a whole class, no Incus, no
 * Windows image, no `/dev/kvm`) and the tests. It takes the same seams the real manager
 * does, so nothing about the flow it runs is special-cased — the only difference is what
 * is on the other end of them.
 */
export function demoSessionManager(options: {
  settings: LabSettings;
  store: LabStore;
  repository: ScenarioRepository;
  catalog?: Catalog | null;
  incus?: InMemoryIncus;
  driver?: GuestDriver;
  shellDriver?: GuestDriver;
  clock?: () => Date;
  sleep?: (seconds: number) => Promise<void>;
}): SessionManager {
  // Passed without a cast on purpose: if the in-memory client stops satisfying the
  // manager's client surface, this stops compiling, which is the only kind of reminder
  // that survives a refactor.
  const incus = options.incus ?? new InMemoryIncus(options.settings.incus.imageAlias, true);
  return new SessionManager({
    settings: options.settings,
    store: options.store,
    repository: options.repository,
    catalog: options.catalog ?? null,
    incus,
    driver: options.driver,
    shellDriver: options.shellDriver,
    clock: options.clock,
    sleep: options.sleep ?? ((): Promise<void> => Promise.resolve()),
  });
}

/**
 * A `SessionManager` whose guests are recorded rather than driven.
 *
 * The one thing a fake driver must not do is *pretend*: it records what it was asked to
 * run and answers only what it was told to. That is what makes a test's assertion about
 * the flow mean something, because the alternative — a stub that returns a plausible
 * grade — would pass whether or not the manager worked.
 */
export class RecordingDriver extends BaseDriver {
  readonly name = "null" as const;
  readonly scripts: { remotePath: string; instance: string }[] = [];
  readonly uploads: { localPath: string; remotePath: string; instance: string }[] = [];
  /** Answers, keyed by a substring of the script or remote path the manager asked for. */
  readonly answers = new Map<string, string>();
  ready = true;
  /** Which transport this fake stands in for. */
  readonly transport: "powershell" | "shell";

  /**
   * `transport` matters more than it looks.
   *
   * `BaseDriver.runScriptFile` runs PowerShell, so a single recording driver handed to the
   * manager as a *Linux* transport would answer with the Windows one — a test that believed
   * it was watching the shell path would be watching the PowerShell path and passing. A
   * fake has to be shaped like the thing it is standing in for.
   */
  constructor(settings: GuestSettings, transport: "powershell" | "shell" = "powershell") {
    super(settings);
    this.transport = transport;
  }

  override async runScriptFile(remotePath: string, options: RunOptions = {}): Promise<CommandResult> {
    if (this.transport === "shell") return await this.runShell(remotePath, options);
    return await super.runScriptFile(remotePath, options);
  }

  /** What this driver answers for one remote path, or empty. */
  answerFor(needle: string): string {
    for (const [key, value] of this.answers) {
      if (needle.includes(key)) return value;
    }
    return "";
  }

  async runPowerShell(script: string, options: RunOptions = {}): Promise<CommandResult> {
    const remote = options.instance === undefined ? "" : options.instance;
    this.scripts.push({ remotePath: script, instance: remote });
    return {
      ok: true,
      exitCode: 0,
      stdout: this.answerFor(script),
      stderr: "",
      duration: 0,
    };
  }

  async runShell(script: string, options: RunOptions = {}): Promise<CommandResult> {
    this.scripts.push({ remotePath: script, instance: options.instance ?? "" });
    return { ok: true, exitCode: 0, stdout: this.answerFor(script), stderr: "", duration: 0 };
  }

  async uploadFile(
    localPath: string,
    remotePath: string,
    options: RunOptions = {},
  ): Promise<CommandResult> {
    this.uploads.push({ localPath, remotePath, instance: options.instance ?? "" });
    return { ok: true, exitCode: 0, stdout: "", stderr: "", duration: 0 };
  }

  async waitReady(target: { instance: string; hostIp: string }): Promise<boolean> {
    void target;
    return this.ready;
  }
}

/** A clock a test can move, with a sleep that never really waits. */
export function testClock(start: Date = new Date("2026-10-09T09:00:00.000Z")): {
  clock: () => Date;
  sleep: (seconds: number) => Promise<void>;
  advance: (seconds: number) => void;
} {
  let current = start.getTime();
  return {
    clock: (): Date => new Date(current),
    sleep: (seconds: number): Promise<void> => {
      current += seconds * 1_000;
      return Promise.resolve();
    },
    advance: (seconds: number): void => {
      current += seconds * 1_000;
    },
  };
}

/** Re-exported so a caller that only has this module can still type an event. */
export type { LabEvent };
