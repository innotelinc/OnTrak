/**
 * The lab's hypervisor, in memory — the TypeScript half of OnTrak-dev's
 * `ontrak/memory.py`.
 *
 * Two callers, one reason. Demo mode runs the whole student flow — request,
 * provision, console, grade, reset, complete — with no Incus, no Windows image and no
 * `/dev/kvm`, and the test suite needs the same thing. In *this* repository the second
 * caller matters more than it did in the Python: there is no hypervisor in the
 * environment the port is verified in (see `docs/lab-port.md` §4), so this class is
 * what will let the ported session manager and demo flow be exercised at all.
 *
 * What it models is deliberately narrow, and comes from the Python's own docstring:
 *
 *   * a template only exists once it has been built *and* snapshotted,
 *   * cloning requires that snapshot,
 *   * instances are gone after `deleteInstance`,
 *   * a machine only has an address while it is running.
 *
 * `KEEPING THE CONTRACT WITH THE REAL CLIENT` — the error types are *imported* from
 * `./incus` rather than re-declared, so `instanceof IncusNotFound` holds across the
 * two modules, and every method here returns a promise because the ported
 * `IncusClient` is async (plan §3/C4: `subprocess.run` has no blocking Node twin that
 * is safe inside a request handler). `tests/lab-memory.test.ts` walks the real
 * client's method list and fails if this class stops covering it, because a double
 * that quietly loses a method makes the demo pass while the real path fails — which
 * is exactly the failure the Python module was written to prevent.
 *
 * ONE THING IT CANNOT FAKE, ON PURPOSE: there is no guest agent, so `execIn` raises
 * naming that. A script run "through a fake hypervisor" would be grading nothing while
 * reporting success; the Python raises for the same reason and the message is kept.
 * `guestShell` is the one exception, and it is the honest one — it answers the
 * readiness probe ("the machine is up") and returns empty output for everything else,
 * so a grading call still fails with "no grading payload" rather than passing.
 */

import {
  IncusError,
  IncusNotFound,
  type CommandResult,
  type GuestExecOutput,
  type InstanceInfo,
} from "./incus";

const RUNNING = "RUNNING";
const STOPPED = "STOPPED";

/**
 * The client's own `RunOptions` is not exported, so its shape is restated here for the
 * one method that takes it. A caller's options object is accepted either way; the fake
 * ignores every field, because there is no process to time out or feed.
 */
interface FakeRunOptions {
  timeout?: number | undefined;
  check?: boolean | undefined;
  input?: string | undefined;
  project?: boolean | undefined;
}

/** What the fake stores per instance: the two facts the Python kept. */
interface FakeInstance {
  status: string;
  ip: string;
}

export class InMemoryIncus {
  /** The golden image alias, switched by `addImage` the way the demo's seeding does. */
  imageAlias: string;
  imagePresent: boolean;

  readonly instances = new Map<string, FakeInstance>();
  readonly snapshots = new Map<string, Set<string>>();
  /** Every operation asked of it, in order — the ported tests assert against this. */
  readonly calls: unknown[][] = [];
  /** `[instance, kind, name, options]`, as appended. */
  readonly devices: [string, string, string, Record<string, string | number | boolean>][] = [];
  /** `[instance, key, value]`, last write winning — `configGet` reads it backwards. */
  readonly configs: [string, string, string | number | boolean][] = [];
  readonly images = new Map<string, { alias: string; present: boolean }>();

  private ipCounter = 100;

  constructor(imageAlias = "ontrak-win-base", imagePresent = true) {
    this.imageAlias = imageAlias;
    this.imagePresent = imagePresent;
  }

  // ------------------------------------------------------------------
  // test and demo utilities (not part of the client's surface)
  // ------------------------------------------------------------------

  /**
   * Put an instance there without going through `createInstance`.
   *
   * The Python took positional `running`/`ip`/`snapshots`; an options object is used
   * here because three positionals of which two are defaulted read badly at the call
   * site. An address is always assigned and only *reported* while the machine is
   * running, exactly as the Python did.
   */
  addInstance(
    name: string,
    options: { running?: boolean; ip?: string; snapshots?: readonly string[] } = {},
  ): void {
    this.instances.set(name, {
      status: (options.running ?? true) ? RUNNING : STOPPED,
      ip: options.ip || this.nextIp(),
    });
    this.snapshots.set(name, new Set(options.snapshots ?? []));
  }

  /** Add an image alias; a *present* one becomes the golden alias, as the demo needs. */
  addImage(alias: string, present = true): void {
    this.images.set(alias, { alias, present });
    if (present) {
      this.imageAlias = alias;
      this.imagePresent = true;
    }
  }

  /** The instance names that exist, live or not. */
  liveNames(): Set<string> {
    return new Set(this.instances.keys());
  }

  private nextIp(): string {
    this.ipCounter += 1;
    return `10.20.0.${this.ipCounter}`;
  }

  // ------------------------------------------------------------------
  // the IncusClient surface
  // ------------------------------------------------------------------

  /**
   * Always true: the point of the fake is that there is nothing to install.
   *
   * Declared as *both* a static and an instance method because the ported client's is
   * static (`IncusClient.available()` — it answers by running the binary) while the
   * Python's was an instance method a caller wrote as `incus.available()`. Offering
   * both means neither call site needs to know which kind of client it holds, and
   * nothing here has to be adjusted if a later slice picks one spelling.
   */
  static async available(_binary = "incus"): Promise<boolean> {
    return true;
  }

  async available(_binary = "incus"): Promise<boolean> {
    return true;
  }

  async listInstances(): Promise<InstanceInfo[]> {
    const out: InstanceInfo[] = [];
    for (const [name, data] of this.instances) {
      out.push({
        name,
        status: data.status,
        kind: "virtual-machine",
        // A stopped machine has no address, which is what the manager waits on.
        ipv4: data.status === RUNNING ? data.ip : "",
        cpu: 0,
        memoryMb: 0,
        os: "",
        raw: null,
      });
    }
    return out;
  }

  async getInstance(name: string): Promise<InstanceInfo | null> {
    for (const info of await this.listInstances()) {
      if (info.name === name) return info;
    }
    return null;
  }

  async exists(name: string): Promise<boolean> {
    return this.instances.has(name);
  }

  async instanceStatus(name: string): Promise<string | null> {
    return this.instances.get(name)?.status ?? null;
  }

  async instanceIp(name: string): Promise<string | null> {
    const data = this.instances.get(name);
    if (!data || data.status !== RUNNING) return null;
    return data.ip;
  }

  async snapshotNames(instance: string): Promise<string[]> {
    return [...(this.snapshots.get(instance) ?? new Set<string>())].sort();
  }

  async hasSnapshot(instance: string, snapshot: string): Promise<boolean> {
    return (this.snapshots.get(instance) ?? new Set<string>()).has(snapshot);
  }

  async imageExists(alias: string): Promise<boolean> {
    const known = this.images.get(alias);
    if (known) return Boolean(known.present);
    return this.imagePresent && alias === this.imageAlias;
  }

  async imageAliases(): Promise<string[]> {
    const names = new Set(this.images.keys());
    names.add(this.imageAlias);
    return [...names].sort();
  }

  async createInstance(name: string, image: string, profiles?: readonly string[]): Promise<void> {
    this.calls.push(["create_instance", name, image, [...(profiles ?? [])]]);
    // A template only exists once its image does: the same refusal the daemon gives,
    // raised here so a template build fails in a test rather than at a class.
    if (!(await this.imageExists(image))) {
      throw new IncusNotFound(["init", image, name], 1, `image ${image} not found`);
    }
    this.instances.set(name, { status: STOPPED, ip: this.nextIp() });
    if (!this.snapshots.has(name)) this.snapshots.set(name, new Set());
  }

  /**
   * Clone an instance, or one of its snapshots (`tpl-x/clean`), to `name`.
   *
   * `instanceOnly` is accepted and ignored: the Python fake took it and never needed
   * it, because the only thing it decided was a CLI flag, and this class has no CLI.
   * The snapshot's existence *is* enforced, because that is the mistake the manager
   * makes when a template was never snapshotted.
   */
  async copyInstance(source: string, name: string, _instanceOnly = true): Promise<void> {
    this.calls.push(["copy_instance", source, name]);
    const slash = source.indexOf("/");
    const instance = slash === -1 ? source : source.slice(0, slash);
    const snapshot = slash === -1 ? "" : source.slice(slash + 1);
    if (!this.instances.has(instance)) {
      throw new IncusNotFound(["copy", source, name], 1, `instance ${instance} not found`);
    }
    if (snapshot && !(this.snapshots.get(instance) ?? new Set<string>()).has(snapshot)) {
      throw new IncusNotFound(["copy", source, name], 1, `snapshot ${snapshot} not found`);
    }
    this.instances.set(name, { status: STOPPED, ip: this.nextIp() });
    if (!this.snapshots.has(name)) this.snapshots.set(name, new Set());
  }

  async startInstance(
    name: string,
    _options: { wait?: boolean | undefined; timeout?: number | undefined } = {},
  ): Promise<void> {
    this.calls.push(["start_instance", name]);
    if (!this.instances.has(name)) {
      throw new IncusNotFound(["start", name], 1, "not found");
    }
    const data = this.instances.get(name);
    if (data) data.status = RUNNING;
  }

  async stopInstance(
    name: string,
    _options: { force?: boolean | undefined; timeout?: number | undefined } = {},
  ): Promise<void> {
    this.calls.push(["stop_instance", name]);
    // Stopping something that is gone is not an error, which is how the Python behaved
    // and how the daemon behaves with `--force`.
    const data = this.instances.get(name);
    if (data) data.status = STOPPED;
  }

  async deleteInstance(name: string, _options: { force?: boolean | undefined } = {}): Promise<void> {
    this.calls.push(["delete_instance", name]);
    this.instances.delete(name);
    this.snapshots.delete(name);
  }

  async createSnapshot(instance: string, snapshot: string): Promise<void> {
    this.calls.push(["create_snapshot", instance, snapshot]);
    if (!this.instances.has(instance)) {
      throw new IncusNotFound(["snapshot", "create", instance], 1, "instance not found");
    }
    const existing = this.snapshots.get(instance);
    if (existing) existing.add(snapshot);
    else this.snapshots.set(instance, new Set([snapshot]));
  }

  async deleteSnapshot(instance: string, snapshot: string): Promise<void> {
    this.snapshots.get(instance)?.delete(snapshot);
  }

  /**
   * Read one config key, last write winning.
   *
   * The value is stringified because the real client's answer comes back from stdout —
   * and that is what lets the QEMU accelerator fix *merge* rather than overwrite: it
   * reads what is already there and appends to it.
   */
  async configGet(instance: string, key: string): Promise<string> {
    for (let index = this.configs.length - 1; index >= 0; index -= 1) {
      const entry = this.configs[index];
      if (entry && entry[0] === instance && entry[1] === key) return String(entry[2]);
    }
    return "";
  }

  async setConfig(instance: string, key: string, value: string | number | boolean): Promise<void> {
    this.configs.push([instance, key, value]);
  }

  async setConfigs(instance: string, values: Record<string, string | number | boolean>): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      await this.setConfig(instance, key, value);
    }
  }

  async addDevice(
    instance: string,
    kind: string,
    name: string,
    options: Record<string, string | number | boolean> = {},
  ): Promise<void> {
    this.devices.push([instance, kind, name, options]);
  }

  async removeDevice(instance: string, name: string): Promise<void> {
    // The Python fake was silent here; the call is recorded because a ledger entry is
    // not state, and a test asserting "the extra NIC was removed" should not have to
    // infer it from an absence.
    this.calls.push(["remove_device", instance, name]);
  }

  async assignProfiles(instance: string, profiles: readonly string[]): Promise<void> {
    this.calls.push(["assign_profiles", instance, [...profiles]]);
  }

  async renameInstance(instance: string, newName: string): Promise<void> {
    this.calls.push(["rename_instance", instance, newName]);
    const data = this.instances.get(instance);
    if (!data) return;
    this.instances.delete(instance);
    this.instances.set(newName, data);
    const snapshots = this.snapshots.get(instance);
    if (snapshots) {
      this.snapshots.delete(instance);
      this.snapshots.set(newName, snapshots);
    }
  }

  async execIn(
    _instance: string,
    command: readonly string[],
    _options: {
      timeout?: number | undefined;
      detach?: boolean | undefined;
      check?: boolean | null | undefined;
      input?: string | undefined;
      user?: string | null | undefined;
    } = {},
  ): Promise<GuestExecOutput> {
    throw new IncusError([...command], 1, "the in-memory client has no guest agent");
  }

  /**
   * Answer the readiness probe, and nothing else.
   *
   * The in-memory client has no guest to run a script in, so it does the one thing the
   * lifecycle genuinely needs — report that the machine is up — and returns empty
   * output otherwise. Grading then fails honestly with "no grading payload", which is
   * what a test that reaches for this should see; demo mode uses its own driver.
   */
  async guestShell(
    instance: string,
    script: string,
    _options: { timeout?: number | undefined; user?: string | null | undefined } = {},
  ): Promise<GuestExecOutput> {
    this.calls.push(["guest_shell", instance, script.slice(0, 120)]);
    if (!this.instances.has(instance)) {
      throw new IncusNotFound(["exec", instance], 1, "instance not found");
    }
    return {
      returncode: 0,
      stdout: script.includes("ontrak-ready") ? "ontrak-ready\n" : "",
      stderr: "",
    };
  }

  /**
   * Whether the machine is in `status` now.
   *
   * One check, as the Python did: the fake's transitions are instantaneous, so a wait
   * loop would only be a sleep. The interval and timeout are accepted and ignored so
   * that a caller's options object is accepted unchanged.
   */
  async waitForStatus(
    instance: string,
    status: string,
    _options: { timeout?: number | undefined; interval?: number | undefined } = {},
  ): Promise<boolean> {
    return this.instances.get(instance)?.status === status;
  }

  async serverInfo(): Promise<Record<string, unknown>> {
    return { environment: { server_version: "in-memory" } };
  }

  async storageInfo(_pool?: string | undefined): Promise<Record<string, unknown>> {
    return { driver: "in-memory" };
  }

  /**
   * The client's low-level escape hatch, answered rather than refused.
   *
   * The Python's equivalent was private (`_run`) and so never had to be faked; the port
   * made it public, and a caller reaching past the named methods must not bring the demo
   * down. It records what it was asked and answers the one query the lab wrote by hand
   * (`network list`), empty otherwise — which is the same shape as `runJson` below.
   */
  async run(args: readonly string[], _options: FakeRunOptions = {}): Promise<CommandResult> {
    this.calls.push(["run", ...args]);
    if (args.slice(0, 2).join(" ") === "network list") {
      return {
        code: 0,
        stdout: JSON.stringify([{ name: "ontrak0", type: "bridge", managed: true }]),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  /**
   * The fake's own extras: the Python fake answered these two and the demo's reporting
   * read them. The *ported* client does not expose either, so nothing should depend on
   * them outside a test — they are kept so the ported test can still assert the
   * placeholder facts the Python asserted.
   */
  async networkNames(): Promise<string[]> {
    return ["ontrak0"];
  }

  async runJson<T = unknown>(args: readonly string[], _options: FakeRunOptions = {}): Promise<T | null> {
    // `as unknown as T` in both directions: the caller names the type it expects, and an
    // unconstrained type parameter is not a type a concrete value can be asserted to
    // directly.
    if (args.slice(0, 2).join(" ") === "network list") {
      return [{ name: "ontrak0", type: "bridge", managed: true }] as unknown as T;
    }
    return [] as unknown as T;
  }
}
