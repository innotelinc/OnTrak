/**
 * Which QEMU accelerator a Windows guest gets, and what to do when KVM cannot give
 * it one.
 *
 * The TypeScript half of OnTrak-dev's `ontrak/qemu.py`. Every Windows guest in this
 * range — the golden image the builder produces, the scenario templates cloned from
 * it, the machines students sit in front of — is a QEMU virtual machine. Nothing
 * here writes a QEMU command line: `incusd` builds it from the instance's config, and
 * the only handle from outside is the two raw keys it appends.
 *
 *     raw.qemu.conf   extra sections for the generated config file
 *     raw.qemu        extra arguments, appended to the command line
 *
 * Both were checked against incusd rather than assumed. For a VM, incusd writes
 * `/run/incus/<instance>/qemu.conf` and runs
 *
 *     qemu-system-x86_64 ... -cpu host,hv_passthrough ... -readconfig /run/incus/<instance>/qemu.conf
 *
 * so the accelerator lives in the config file (`[machine] accel = "kvm"`) while the
 * CPU model is on the command line. `raw.qemu.conf` is merged into that file and does
 * override `[machine] accel`; `raw.qemu` is appended last, and QEMU takes the last
 * `-cpu`, so it overrides the hard-coded one. That is why the merge below adds rather
 * than replaces: the point is to run the same machine more slowly, not a lesser one.
 *
 * That matters because KVM is not always available to a Windows guest. Windows 11
 * needs Secure Boot, in OVMF Secure Boot means SMM, and a host whose own
 * virtualisation is *nested on AMD* cannot virtualise SMM at all. Measured on WSL2
 * (Hyper-V) on a Ryzen: the instance reports `RUNNING` and then goes `ERROR` ten to
 * twenty seconds later, and its qemu log ends
 *
 *     KVM: entry failed, hardware error 0xffffffff
 *     ... EIP=00008000 ... SMM=1 HLT=0
 *
 * Turning Secure Boot and the TPM off does not help — OVMF uses SMM for its runtime
 * services either way — `-machine smm=off` only trades the crash for a guest that
 * spins without writing a sector, and a legacy-BIOS build hangs the same way. The
 * host is not broken; there is one thing it cannot do.
 *
 * So this module decides whether KVM will serve and, when it will not, hands the
 * guest the two settings that move it to TCG:
 *
 *     [machine]
 *     accel = "tcg"
 *
 * and `-cpu max`, because incusd hard-codes `-cpu host,hv_passthrough` for a VM and
 * QEMU refuses that model without KVM:
 *
 *     qemu-system-x86_64: CPU model 'host' requires KVM or HVF
 *
 * `-accel tcg,thread=multi` is what a hand-written command line would say, and it
 * cannot be asked for here: QEMU refuses `-accel` beside the `-machine accel=` incusd
 * already emitted, and writing `accel = "tcg,thread=multi"` into the section is
 * rejected in turn because `accel` takes a name, not options. TCG's multi-threaded
 * mode is the default for x86_64 guests anyway.
 *
 * Two things are deliberately *not* touched: `security.secureboot` and the `tpm`
 * device. A guest that boots without them is not the guest this range teaches on, and
 * nothing here is a reason to drop them.
 *
 * **One deviation from the Python, stated rather than hidden.** The Python asks
 * `/dev/kvm` to report `KVM_GET_API_VERSION` through `ioctl`. Node has no `ioctl`
 * without a native binding, so the default probe opens the device read-write and
 * requires it to be a character device — which is what refuses a container or an
 * unprivileged user whose 660 node exists but cannot be opened — and the probe is
 * injectable for anything stronger. The decision itself (`choose`) is pure and never
 * touches the host, the filesystem or the environment.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, openSync, closeSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type Accelerator = "kvm" | "tcg";

export const KVM: Accelerator = "kvm";
export const TCG: Accelerator = "tcg";

/**
 * Where the builder's own VM lives: its pack script runs `incus init`/`incus start`
 * with no `--project` at all, and this range imports the image into its own project
 * afterwards.
 */
export const DEFAULT_PROJECT = "default";

/**
 * What the operator sets to settle a host this decision gets wrong in either
 * direction. Read by the caller (`accelOverride`), never inside `choose`.
 */
export const ACCEL_ENV = "ONTRAK_QEMU_ACCEL";

/** What incusd puts in the generated config, and what it appends to the command line. */
export const KVM_CPU_MODEL = "-cpu host,hv_passthrough";
export const TCG_CPU_MODEL = "-cpu max";

export const TCG_MACHINE_SECTION = '[machine]\naccel = "tcg"\n';

/**
 * Where OVMF's CODE and VARS images live. Incus ships its own under /opt/incus; the
 * ovmf package keeps the distribution's under /usr/share. Which one a guest boots
 * depends on how Incus was packaged, so both are searched and no file name is assumed.
 */
export const OVMF_DIRS: readonly string[] = [
  "/opt/incus/share/qemu",
  "/usr/share/OVMF",
  "/usr/share/edk2/ovmf",
  "/usr/share/qemu",
];

/**
 * What the software path needs. Incus uses OVMF for a VM's firmware and swtpm for its
 * TPM, but neither is a hard dependency of every Incus package, so a host can have
 * Incus and still be unable to start the guest this range builds. Asked of the package
 * manager rather than by looking for a binary, because `ovmf` and `swtpm-tools` install
 * files rather than commands and the package is `qemu-system-x86` while the binary is
 * `qemu-system-x86_64`.
 */
export const REQUIRED_PACKAGES: readonly string[] = [
  "qemu-system-x86",
  "qemu-utils",
  "ovmf",
  "swtpm",
  "swtpm-tools",
];

/** The one apt line the preflight prints, so an operator is told what to install. */
export const INSTALL_HINT =
  "apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils ovmf swtpm swtpm-tools";

/** The three facts the decision turns on. */
export interface HostFacts {
  kvm: boolean;
  virt: string;
  vendor: string;
}

/** What the module asks of the host, so a test can hand `host()` any machine. */
export interface HostProbe {
  kvmUsable(): boolean;
  virt(): string;
  cpuVendor(): string;
}

/** Find an executable on PATH, the way shutil.which does. */
function which(executable: string): string | null {
  const path = process.env.PATH ?? "";
  for (const directory of path.split(":")) {
    if (!directory) continue;
    const candidate = join(directory, executable);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Whether /dev/kvm is *usable*, not merely present.
 *
 * A node that exists but cannot be opened is what a container or an unprivileged user
 * sees, and treating that as KVM is how a build gets three hours in before noticing.
 * See the module header for why this is an open-plus-character-device check rather
 * than the Python's `ioctl`.
 */
export function kvmUsable(device = "/dev/kvm"): boolean {
  try {
    const fd = openSync(device, constants.O_RDWR);
    try {
      // The ioctl that would settle it needs a native binding; a char device we could
      // open read-write is the strongest answer Node can give on its own.
      return statSync(device).isCharacterDevice();
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * What systemd says this machine is running *inside*, if anything.
 *
 * "none" on bare metal. Ubuntu's systemd-detect-virt reports "wsl" under WSL2, which
 * is the case the TCG fallback exists for. Anything unexpected — no binary, a
 * timeout, empty output — is "unknown", which the decision treats as bare metal.
 */
export function detectVirt(): string {
  const exe = which("systemd-detect-virt");
  if (!exe) return "unknown";
  try {
    const stdout = execFileSync(exe, { encoding: "utf-8", timeout: 10_000 });
    return stdout.trim() || "none";
  } catch {
    return "unknown";
  }
}

/** The host's CPU vendor, as /proc/cpuinfo spells it ("AuthenticAMD"). */
export function cpuVendor(cpuinfo = "/proc/cpuinfo"): string {
  try {
    for (const line of readFileSync(cpuinfo, "utf-8").split("\n")) {
      if (line.startsWith("vendor_id")) {
        const value = line.split(":", 2)[1];
        return (value ?? "").trim() || "unknown";
      }
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

/** The real host, for a caller with no better probe to offer. */
export const systemProbe: HostProbe = {
  kvmUsable: () => kvmUsable(),
  virt: () => detectVirt(),
  cpuVendor: () => cpuVendor(),
};

let cachedHost: HostFacts | null = null;

/**
 * Read this host's facts.
 *
 * Cached for the life of the process when the real probe is used: a host does not
 * stop being nested while a range serves a class, and asking means running
 * systemd-detect-virt and reading /proc/cpuinfo, which the session path would
 * otherwise do once per guest. A test's own probe is never cached — a fixture that
 * lies twice in a row must be believed twice.
 */
export function host(probe: HostProbe = systemProbe): HostFacts {
  if (probe === systemProbe && cachedHost) return cachedHost;
  const facts: HostFacts = {
    kvm: probe.kvmUsable(),
    virt: probe.virt(),
    vendor: probe.cpuVendor(),
  };
  if (probe === systemProbe) cachedHost = facts;
  return facts;
}

/** Forget the cached host, so the next `host()` re-reads it. */
export function resetHostCache(): void {
  cachedHost = null;
}

/**
 * The accelerator override from the environment, or `""`.
 *
 * An unrecognised value is `""` rather than an error: the Python's `choose` refuses a
 * nonsense override and falls back to the host, and a typo must not be the reason a
 * class ran on the emulator.
 */
export function accelOverride(env: Record<string, string | undefined> = process.env): string {
  const raw = (env[ACCEL_ENV] ?? "").trim().toLowerCase();
  return raw === KVM || raw === TCG ? raw : "";
}

/**
 * Which accelerator to ask for. Pure, so a test can hand it any host.
 *
 * The nested-AMD rule is a measurement, not a preference: it is the one condition
 * under which KVM is known to fail here rather than merely be slow. Nothing about a
 * nested Intel host is asserted, so it keeps KVM until someone measures otherwise,
 * and `ONTRAK_QEMU_ACCEL` settles any host this gets wrong in either direction.
 */
export function choose(hostFacts: HostFacts, override = ""): Accelerator {
  const explicit = override.trim().toLowerCase();
  if (explicit === KVM || explicit === TCG) return explicit;
  if (!hostFacts.kvm) return TCG;
  if (!["", "none", "unknown"].includes(hostFacts.virt) && hostFacts.vendor === "AuthenticAMD") {
    return TCG;
  }
  return KVM;
}

/** The accelerator for this host, honouring `ONTRAK_QEMU_ACCEL=kvm|tcg`. */
export function acceleratorFor(
  facts: HostFacts = host(),
  override: string = accelOverride(),
): Accelerator {
  return choose(facts, override);
}

/** One line naming the accelerator and why, for a log. */
export function reason(hostFacts: HostFacts, accelName: Accelerator): string {
  if (accelName === KVM) return "accelerator: KVM (hardware virtualisation)";
  if (!hostFacts.kvm) {
    return (
      "accelerator: QEMU TCG (no usable /dev/kvm on this host, so the " +
      "software emulator is the only one available)"
    );
  }
  return (
    `KVM detected but KVM+SMM unavailable under ${hostFacts.virt}; ` +
    "using QEMU TCG fallback"
  );
}

/**
 * The instance config that moves a guest to software emulation.
 *
 * Both settings only ever *add*. An operator who has already set either key is keeping
 * something deliberate — a legacy workload's `-M pc -cpu pentium2` is set this way — so
 * an existing `accel` is left alone and the CPU model is appended rather than replaced.
 * Passing no current values is therefore the "start from nothing" case, and passing back
 * what a previous call set is the no-op case, which is what makes re-running a build
 * against the same checkout safe. An empty result means "there is nothing to write".
 */
export function tcgInstanceConfig(
  currentRawQemu = "",
  currentConf = "",
): Record<string, string> {
  const values: Record<string, string> = {};
  if (!(currentConf ?? "").includes("accel")) {
    values["raw.qemu.conf"] = TCG_MACHINE_SECTION;
  }
  const args = (currentRawQemu ?? "").trim();
  if (!args.includes(TCG_CPU_MODEL)) {
    values["raw.qemu"] = `${args} ${TCG_CPU_MODEL}`.trim();
  }
  return values;
}

/**
 * The slice of the Incus client this module needs.
 *
 * `configGet` is optional so a client that cannot be asked reads as "nothing set"
 * rather than throwing inside a build, which is what the Python's `getattr` guard
 * does. `setConfigs` mirrors the Python's `set_configs`.
 */
export interface QemuConfigClient {
  configGet?(instance: string, key: string): string;
  setConfigs(instance: string, values: Record<string, string>): void;
}

/**
 * Point a guest at this host's accelerator. Returns what was chosen.
 *
 * A no-op under KVM, on purpose: the config incusd writes is already right, and writing
 * the TCG values there would be read by the next person as a leftover. The facts and the
 * override are resolved lazily, so a caller that already knows the accelerator does not
 * cause the host to be probed at all.
 */
export function applyAcceleration(
  client: QemuConfigClient,
  instance: string,
  accelName?: string,
  options: { facts?: HostFacts; override?: string } = {},
): Accelerator {
  const name: Accelerator =
    accelName === KVM || accelName === TCG
      ? accelName
      : choose(options.facts ?? host(), options.override ?? accelOverride());
  if (name !== TCG) return name;

  const values = tcgInstanceConfig(
    client.configGet?.(instance, "raw.qemu") ?? "",
    client.configGet?.(instance, "raw.qemu.conf") ?? "",
  );
  if (Object.keys(values).length > 0) client.setConfigs(instance, values);
  return name;
}

/** `applyAcceleration` for a caller that has no opinion: decide from this host. */
export function applyForHost(
  client: QemuConfigClient,
  instance: string,
  options: { facts?: HostFacts; override?: string } = {},
): Accelerator {
  return applyAcceleration(client, instance, undefined, options);
}

/** Where this host keeps OVMF's CODE and VARS images, if anywhere. */
export interface OvmfImages {
  code?: string;
  vars?: string;
}

/**
 * Detect the firmware rather than naming it.
 *
 * This is for the preflight and for telling an operator what is installed — the
 * firmware a guest actually boots is incusd's choice and shows up in
 * `/run/incus/<instance>/qemu.conf`.
 */
export function ovmf(dirs: readonly string[] = OVMF_DIRS): OvmfImages {
  const found: OvmfImages = {};
  for (const directory of dirs) {
    let names: string[];
    try {
      names = readdirSync(directory).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const lower = name.toLowerCase();
      if (!(lower.startsWith("ovmf_") && lower.endsWith(".fd"))) continue;
      if (lower.includes("_code")) {
        if (found.code === undefined) found.code = join(directory, name);
      } else if (lower.includes("_vars")) {
        if (found.vars === undefined) found.vars = join(directory, name);
      }
    }
  }
  return found;
}

/** How the module asks whether a package is installed, injectable for tests. */
export interface PackageQuery {
  available(): boolean;
  installed(packageName: string): boolean;
}

/**
 * Ask dpkg. `-W -f=${Status}` is what distinguishes installed from merely known, and a
 * query that cannot run is reported as "not missing" rather than as every package
 * missing: a host without dpkg is not a host with nothing installed.
 */
export const dpkgQuery: PackageQuery = {
  available: () => which("dpkg-query") !== null,
  installed: (packageName: string) => {
    const result = spawnSync("dpkg-query", ["-W", "-f=${Status}", packageName], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    return (result.stdout ?? "").includes("install ok installed");
  },
};

/** Which of the packages the software path needs are not installed. */
export function missingPackages(
  packages: readonly string[] = REQUIRED_PACKAGES,
  query: PackageQuery = dpkgQuery,
): string[] {
  if (!query.available()) return [];
  return packages.filter((packageName) => !query.installed(packageName));
}

/**
 * What is wrong with this host for the software path, as `[problem, ...]`.
 *
 * The Python's preflight printed these and exited 1; the port returns them so the CLI
 * stage can decide how to say it. An empty list means the host can build.
 */
export function preflightProblems(
  accelName: Accelerator,
  firmware: OvmfImages = ovmf(),
  missing: readonly string[] = missingPackages(),
): string[] {
  if (accelName !== TCG) return [];
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`missing packages: ${missing.join(" ")}`);
  if (firmware.code === undefined || firmware.vars === undefined) {
    problems.push(`no OVMF CODE/VARS image found in ${OVMF_DIRS.join(", ")}`);
  }
  return problems;
}

/**
 * Everything an operator or a preflight wants to know about this host.
 *
 * Snake-case keys, like the Python's JSON report: this is the shape a preflight script
 * or a runbook already reads.
 */
export function qemuReport(
  facts: HostFacts = host(),
  override: string = accelOverride(),
): Record<string, unknown> {
  const name = choose(facts, override);
  return {
    accel: name,
    reason: reason(facts, name),
    kvm: facts.kvm,
    virt: facts.virt,
    vendor: facts.vendor,
    ovmf: ovmf(),
    missing_packages: missingPackages(),
  };
}
