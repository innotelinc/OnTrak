/**
 * What a machine is.
 *
 * The Network is not made of incus containers. It is physical servers, VMware
 * guests, Proxmox nodes, LXC containers, QEMU/KVM machines and a few things nobody
 * wrote down, and a dashboard that labels them all "incus" is telling the operator
 * something untrue about the machine in front of them.
 *
 * This mirrors `MACHINE_KINDS` in the API's `config.py`, which is the source of
 * truth: `kind` is configuration, because the probes differ per platform and a
 * wrong guess costs a confusing empty result. A kind the dashboard does not know is
 * shown as unrecognised rather than hidden — an unrecognised kind means nothing will
 * be enumerated on that machine, and somebody should be told.
 */

export const MACHINE_KINDS: Record<string, string> = {
  incus: "incus containers",
  both: "incus + Docker",
  docker: "Docker",
  lxc: "LXC",
  proxmox: "Proxmox VE",
  vmware: "VMware ESXi",
  qemu: "QEMU/KVM",
  virtual: "virtual machine",
  physical: "bare metal",
};

/** Kinds whose guests the API can enumerate and scan in their own right. */
export const WORKLOAD_KINDS = new Set(["incus", "both", "docker"]);

/** A machine's kind in words. Unknown kinds are named as such, never hidden. */
export function machineKindLabel(kind: string | null | undefined): string {
  if (!kind) return "unknown machine";
  return MACHINE_KINDS[kind] ?? `${kind} (unrecognised)`;
}

/** Whether this machine's guests appear as their own rows. */
export function enumeratesWorkloads(kind: string | null | undefined): boolean {
  return kind != null && WORKLOAD_KINDS.has(kind);
}
