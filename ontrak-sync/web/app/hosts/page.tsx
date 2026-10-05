"use client";

/**
 * Hosts and the targets on them.
 *
 * The point of this page is coverage, not counts: it shows whether each target was
 * actually inspected, because a target that was never inspected contributes zero
 * findings and would otherwise be indistinguishable from a current one. The
 * `coverage` column is the number of targets per host that have been scanned at
 * least once, which is the honest denominator behind "0 pending".
 *
 * Each host carries its own coverage of a second kind in the header: whether it is
 * waiting for a reboot. It belongs here rather than in the target table because it is
 * a fact about the machine and not about any target on it — the containers share the
 * host's kernel, so none of them can be the one that needs restarting.
 */

import Link from "next/link";

import { Empty, LoadError, ReachablePill, RebootPill, ScanPill, When } from "@/components/bits";
import { api } from "@/lib/api";
import { machineKindLabel } from "@/lib/machine-kinds";
import type { Host, Target } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

export default function HostsPage() {
  const hosts = useAsync<{ hosts: Host[] }>(() => api.hosts(), []);
  const targets = useAsync<{ targets: Target[] }>(() => api.targets(), []);

  const rows = hosts.data?.hosts ?? [];
  const byHost = new Map<string, Target[]>();
  for (const target of targets.data?.targets ?? []) {
    const list = byHost.get(target.host) ?? [];
    list.push(target);
    byHost.set(target.host, list);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Hosts &amp; targets</h1>
          <p>
            A target is anything that can be out of date: an incus host itself, a
            container inside one, or the Docker images those containers run. Coverage is
            how many of a host&apos;s targets have answered at least once — and a host
            that is waiting for a reboot says so in its header, because every target on
            it reports as current the moment the new kernel is merely installed.
          </p>
        </div>
        <Link href="/">← dashboard</Link>
      </div>

      {hosts.error ? <LoadError error={hosts.error} /> : null}
      {targets.error ? <LoadError error={targets.error} /> : null}

      {rows.map((host) => {
        const hostTargets = byHost.get(host.name) ?? [];
        const scanned = hostTargets.filter((target) => target.last_scanned_at).length;
        return (
          <section className="panel" key={host.name}>
            <header>
              <div>
                <h2 style={{ textTransform: "none", fontSize: 14, color: "var(--text)" }}>
                  <Link href={`/hosts/${encodeURIComponent(host.name)}`}>{host.name}</Link>
                  <span className="faint mono" style={{ marginLeft: 10 }}>{host.address}</span>
                </h2>
                <div className="faint" style={{ marginTop: 4 }}>
                  {/* What the machine *is*, in words: the Network is bare metal, VMware
                      guests, Proxmox nodes and containers, and a dashboard that calls
                      them all "incus" is telling the operator something untrue. */}
                  {host.os ?? "OS unknown"} · kernel {host.kernel ?? "?"} · {machineKindLabel(host.kind)}
                </div>
              </div>
              <div className="actions">
                <ReachablePill reachable={host.reachable} />
                <RebootPill known={host.reboot_known} required={host.reboot_required}
                            packages={host.reboot_packages} />
                <RegistryPill refusals={host.registry_refusals} />
                <span className="faint">
                  coverage {scanned}/{hostTargets.length || "—"}
                </span>
                {host.error ? <span className="pill pill--bad" title={host.error}>error</span> : null}
              </div>
            </header>
            <div className="body body--flush">
              {hostTargets.length === 0 ? (
                <Empty>No targets recorded — run a scan.</Empty>
              ) : (
                <div className="scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Target</th>
                        <th>Workload</th>
                        <th>Scanned</th>
                        <th>Pending</th>
                        <th>Security</th>
                        <th>Failed</th>
                        <th>Last inspected</th>
                        <th>Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hostTargets.map((target) => (
                        <tr key={target.id}>
                          <td className="mono">{target.name}</td>
                          <td className="faint">{target.kind}</td>
                          <td className="tight">
                            <ScanPill scanned={Boolean(target.last_scanned_at)} />
                          </td>
                          <td className="num">{countProperty(target, "pending")}</td>
                          <td className="num">{countProperty(target, "security")}</td>
                          <td className="num">{countProperty(target, "failed")}</td>
                          <td className="tight"><When value={target.last_scanned_at} /></td>
                          <td className="dim" style={{ maxWidth: 300 }}>{target.error ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        );
      })}

      {!hosts.loading && rows.length === 0 ? (
        <Empty>No hosts recorded yet. Run a scan from the dashboard.</Empty>
      ) : null}
    </>
  );
}

/**
 * What the registry would not judge on this host's newest scan, and how often that was a
 * throttle.
 *
 * Two facts in one pill because they are read together. A refusal is ordinary noise on a
 * host that runs locally built images — Docker Hub answers a 401 for a name it will not
 * confirm exists — while a *rate limit* recurring scan after scan is a capacity problem.
 * One scan cannot tell the two apart; the stored window can, so it is what the tooltip
 * reports when there is one.
 */
function RegistryPill({ refusals }: { refusals: Host["registry_refusals"] }) {
  if (!refusals || Object.keys(refusals.latest).length === 0) return null;
  const total = Object.values(refusals.latest).reduce((sum, count) => sum + count, 0);
  const throttled =
    (refusals.latest["rate-limited"] ?? 0) > 0 || refusals.rate_limited_runs > 0;
  const detail = [
    ...Object.entries(refusals.latest).map(([cause, count]) => `${cause}: ${count}`),
    refusals.rate_limited_runs > 0
      ? `rate-limited in ${refusals.rate_limited_runs} of the last ${refusals.window} scans`
      : "",
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
  return (
    <span className={`pill ${throttled ? "pill--partial" : "pill--absent"}`} title={detail}>
      registry {total} not judged
    </span>
  );
}

/**
 * Targets carry their counts as columns the API adds per request; this keeps the
 * table honest when a field is missing rather than rendering `undefined`.
 */
function countProperty(target: Target, key: string): string {
  const value = (target as unknown as Record<string, number | undefined>)[key];
  return value === undefined ? "·" : String(value);
}
