/**
 * The QEMU accelerator decision, and the instance config it writes.
 *
 * The rule is small enough to state in one line — use KVM unless this host's KVM is
 * nested on AMD, in which case QEMU has to emulate the CPU — but both halves of the
 * range depend on it and neither can be run in a test: the golden build wants two hours
 * and a Windows ISO, and a template build wants a guest that answers WinRM. So the
 * decision is a pure function of three facts (`choose`) and everything around it here is
 * exercised against those facts or against a recording client.
 *
 * What is worth pinning down is not "tcg was returned" but the two ways this can hurt a
 * range that was working:
 *
 * * it must not change a host where KVM works — including a nested *Intel* host, which
 *   is asserted to keep KVM because nothing here has measured it failing; and
 * * it must not silently disable anything the guest needs. The values it writes are an
 *   accelerator and a CPU model, and nothing in this file may touch
 *   `security.secureboot` or the `tpm` device.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-qemu.test.ts
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ACCEL_ENV,
  KVM,
  OVMF_DIRS,
  REQUIRED_PACKAGES,
  TCG,
  TCG_CPU_MODEL,
  TCG_MACHINE_SECTION,
  accelOverride,
  acceleratorFor,
  applyAcceleration,
  applyForHost,
  choose,
  host,
  missingPackages,
  ovmf,
  preflightProblems,
  qemuReport,
  reason,
  resetHostCache,
  tcgInstanceConfig,
  type HostFacts,
  type HostProbe,
  type PackageQuery,
  type QemuConfigClient,
} from "../src/lib/lab/qemu";

const BARE_METAL_AMD: HostFacts = { kvm: true, virt: "none", vendor: "AuthenticAMD" };
const BARE_METAL_INTEL: HostFacts = { kvm: true, virt: "none", vendor: "GenuineIntel" };
const WSL_AMD: HostFacts = { kvm: true, virt: "wsl", vendor: "AuthenticAMD" };
const WSL_INTEL: HostFacts = { kvm: true, virt: "wsl", vendor: "GenuineIntel" };
const NO_KVM: HostFacts = { kvm: false, virt: "wsl", vendor: "GenuineIntel" };

/**
 * A config client that records what it was asked to write.
 *
 * The Python's `FakeIncus` doubles as the hypervisor; this is only the two methods
 * `applyAcceleration` uses, which is the point — the module cannot reach past them.
 */
class RecordingClient implements QemuConfigClient {
  readonly configs: { instance: string; key: string; value: string }[] = [];
  readonly #store = new Map<string, string>();

  configGet(instance: string, key: string): string {
    return this.#store.get(`${instance}\u0000${key}`) ?? "";
  }

  setConfigs(instance: string, values: Record<string, string>): void {
    for (const [key, value] of Object.entries(values)) {
      this.#store.set(`${instance}\u0000${key}`, value);
      this.configs.push({ instance, key, value });
    }
  }

  /** Pretend something else already set these, the way a legacy workload does. */
  seed(instance: string, values: Record<string, string>): void {
    for (const [key, value] of Object.entries(values)) {
      this.#store.set(`${instance}\u0000${key}`, value);
    }
  }

  written(instance: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of this.configs) {
      if (entry.instance === instance) out[entry.key] = entry.value;
    }
    return out;
  }
}

function hasDpkgQuery(): boolean {
  try {
    return spawnSync("dpkg-query", ["--version"], { timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------- //
// the decision
// --------------------------------------------------------------------------- //

test("a host with usable KVM gets it", () => {
  assert.equal(choose(BARE_METAL_AMD), KVM);
  assert.equal(choose(BARE_METAL_INTEL), KVM);
});

test("nested AMD KVM falls back to software emulation", () => {
  // The measurement this exists for: WSL2/Hyper-V on a Ryzen.
  assert.equal(choose(WSL_AMD), TCG);
});

test("nested Intel KVM keeps KVM because nothing here measured otherwise", () => {
  // The rule is one measurement, not a theory about all nesting.
  assert.equal(choose(WSL_INTEL), KVM);
});

test("a host with no KVM cannot use it", () => {
  assert.equal(choose(NO_KVM), TCG);
});

test("the operator can settle it either way", () => {
  assert.equal(choose(WSL_AMD, "kvm"), KVM);
  assert.equal(choose(BARE_METAL_INTEL, "tcg"), TCG);
  assert.equal(choose(NO_KVM, "  TCG  "), TCG, "forgiving about how it is typed");
  assert.equal(choose(WSL_AMD, "banana"), TCG, "nonsense does not overrule the host");
});

test("the override is read from the environment, and a typo is not obeyed", () => {
  assert.equal(accelOverride({ [ACCEL_ENV]: "  TCG  " }), TCG);
  assert.equal(accelOverride({ [ACCEL_ENV]: "kvm" }), "kvm");
  assert.equal(accelOverride({ [ACCEL_ENV]: "banana" }), "", "a typo must not decide a class");
  assert.equal(accelOverride({ [ACCEL_ENV]: "" }), "");
  assert.equal(accelOverride({}), "");
  assert.equal(acceleratorFor(WSL_AMD, accelOverride({ [ACCEL_ENV]: "kvm" })), KVM);
  assert.equal(acceleratorFor(WSL_AMD, ""), TCG);
});

test("reason names the accelerator and says which host it is", () => {
  const fallback = reason(WSL_AMD, TCG);
  assert.match(fallback, /TCG/);
  assert.match(fallback, /wsl/);
  assert.match(fallback, /KVM\+SMM/);
  assert.match(reason(BARE_METAL_AMD, KVM), /hardware virtualisation/);
  assert.match(reason(NO_KVM, TCG), /no usable \/dev\/kvm/);
});

test("host facts come from an injectable probe, and the cache can be cleared", () => {
  const probe: HostProbe = {
    kvmUsable: () => true,
    virt: () => "wsl",
    cpuVendor: () => "AuthenticAMD",
  };
  assert.deepEqual(host(probe), WSL_AMD);
  resetHostCache();
  assert.deepEqual(host(probe), WSL_AMD, "a test's probe is never cached");

  const noKvm: HostProbe = {
    kvmUsable: () => false,
    virt: () => "unknown",
    cpuVendor: () => "unknown",
  };
  assert.deepEqual(host(noKvm), { kvm: false, virt: "unknown", vendor: "unknown" });
});

// --------------------------------------------------------------------------- //
// the instance config
// --------------------------------------------------------------------------- //

test("the config moves the accelerator and the CPU model", () => {
  const values = tcgInstanceConfig();
  assert.equal(values["raw.qemu.conf"], '[machine]\naccel = "tcg"\n');
  assert.equal(values["raw.qemu"], "-cpu max");
  assert.equal(TCG_MACHINE_SECTION, '[machine]\naccel = "tcg"\n');
});

test("applying it to what it already wrote changes nothing", () => {
  // A build re-run against the same checkout must not append again.
  const once = tcgInstanceConfig();
  assert.deepEqual(tcgInstanceConfig(once["raw.qemu"], once["raw.qemu.conf"]), {});
  assert.deepEqual(tcgInstanceConfig(once["raw.qemu"], once["raw.qemu.conf"]), {});
});

test("an existing raw.qemu keeps its arguments and gains the CPU", () => {
  // Legacy workloads set `-M pc -cpu pentium2` this way; it must survive. The CPU model
  // is appended rather than replaced, so QEMU's last-wins picks ours up.
  const values = tcgInstanceConfig("-M pc -cpu pentium2 -vga cirrus", "");
  assert.equal(values["raw.qemu"], `-M pc -cpu pentium2 -vga cirrus ${TCG_CPU_MODEL}`);
});

test("an accel somebody else set is left alone", () => {
  const values = tcgInstanceConfig("", '[machine]\naccel = "kvm"\n');
  assert.equal("raw.qemu.conf" in values, false, "an operator's own accel was overwritten");
});

test("nothing here touches secure boot or the TPM", () => {
  const keys = Object.keys(tcgInstanceConfig());
  assert.equal(keys.some((key) => key.toLowerCase().includes("secureboot")), false);
  assert.equal(keys.some((key) => key.toLowerCase().includes("tpm")), false);
});

// --------------------------------------------------------------------------- //
// applying it to an instance
// --------------------------------------------------------------------------- //

test("apply writes nothing where KVM works", () => {
  const client = new RecordingClient();
  assert.equal(applyAcceleration(client, "tpl-x", KVM), KVM);
  assert.deepEqual(client.configs, []);
});

test("apply points a guest at the emulator once", () => {
  const client = new RecordingClient();
  assert.equal(applyAcceleration(client, "tpl-x", TCG), TCG);
  const written = client.written("tpl-x");
  assert.equal(written["raw.qemu.conf"], '[machine]\naccel = "tcg"\n');
  assert.equal(written["raw.qemu"], "-cpu max");

  const before = client.configs.length;
  applyAcceleration(client, "tpl-x", TCG);
  assert.equal(client.configs.length, before, "a second apply rewrote the config");
});

test("apply resolves the accelerator from the host when it is not told one", () => {
  const client = new RecordingClient();
  assert.equal(applyAcceleration(client, "tpl-host", undefined, { facts: WSL_AMD }), TCG);
  assert.equal(client.written("tpl-host")["raw.qemu"], "-cpu max");

  const kvmClient = new RecordingClient();
  assert.equal(applyForHost(kvmClient, "tpl-kvm", { facts: BARE_METAL_INTEL }), KVM);
  assert.deepEqual(kvmClient.configs, []);
});

test("apply does not clobber a raw.qemu set somewhere else", () => {
  const client = new RecordingClient();
  client.seed("tpl-legacy", { "raw.qemu": "-M pc -cpu pentium2" });
  applyAcceleration(client, "tpl-legacy", TCG);
  assert.equal(client.written("tpl-legacy")["raw.qemu"], "-M pc -cpu pentium2 -cpu max");
});

// --------------------------------------------------------------------------- //
// what the software path needs on the host
// --------------------------------------------------------------------------- //

test("ovmf is detected wherever it is installed", () => {
  // Incus keeps its own copies and the ovmf package keeps the distro's, so the names
  // are searched for in both, and a differently-versioned one is still read correctly.
  const directory = mkdtempSync(join(tmpdir(), "ontrak-ovmf-"));
  try {
    writeFileSync(join(directory, "OVMF_CODE_4M.fd"), "code");
    writeFileSync(join(directory, "OVMF_VARS_4M.ms.fd"), "vars");
    writeFileSync(join(directory, "not-firmware.txt"), "");
    assert.deepEqual(ovmf([directory]), {
      code: join(directory, "OVMF_CODE_4M.fd"),
      vars: join(directory, "OVMF_VARS_4M.ms.fd"),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ovmf reports nothing rather than guessing", () => {
  assert.deepEqual(ovmf([join(tmpdir(), "ontrak-ovmf-absent")]), {});
});

test("a package query that cannot run reports nothing missing", () => {
  const unavailable: PackageQuery = { available: () => false, installed: () => false };
  assert.deepEqual(missingPackages(["bash"], unavailable), []);

  const fake: PackageQuery = { available: () => true, installed: (name) => name === "bash" };
  assert.deepEqual(missingPackages(["bash", "ontrak-no-such-package"], fake), [
    "ontrak-no-such-package",
  ]);
});

test("the real package manager names what is not installed", (t) => {
  if (!hasDpkgQuery()) {
    t.skip("no dpkg-query on this host");
    return;
  }
  assert.deepEqual(missingPackages(["ontrak-no-such-package"]), ["ontrak-no-such-package"]);
  assert.equal(missingPackages(["bash"]).includes("bash"), false);
});

test("the required package list is the software path's, unchanged", () => {
  assert.deepEqual([...REQUIRED_PACKAGES], [
    "qemu-system-x86",
    "qemu-utils",
    "ovmf",
    "swtpm",
    "swtpm-tools",
  ]);
});

test("the preflight names what a TCG host is missing, and is silent under KVM", () => {
  assert.deepEqual(preflightProblems(TCG, { code: "/c", vars: "/v" }, []), []);

  const problems = preflightProblems(TCG, {}, ["swtpm"]);
  assert.equal(problems.length, 2);
  assert.match(problems.join(" "), /swtpm/);
  assert.match(problems.join(" "), new RegExp(OVMF_DIRS[0] ?? "OVMF_DIRS"));

  // A KVM host needs neither the packages nor the firmware, so it is never told off.
  assert.deepEqual(preflightProblems(KVM, {}, ["swtpm"]), []);
});

test("the report carries the accelerator, the reason and the host facts", () => {
  const report = qemuReport(BARE_METAL_INTEL, "kvm");
  assert.equal(report.accel, KVM);
  assert.match(String(report.reason), /hardware virtualisation/);
  assert.equal(report.kvm, true);
  assert.equal(report.virt, "none");
  assert.equal(report.vendor, "GenuineIntel");
  assert.equal(typeof report.ovmf, "object");
  assert.equal(Array.isArray(report.missing_packages), true, "the report's keys are the Python's");
});

test("the fallback report says which host forced the emulator", () => {
  const report = qemuReport(WSL_AMD, "");
  assert.equal(report.accel, TCG);
  assert.match(String(report.reason), /wsl/);
});
