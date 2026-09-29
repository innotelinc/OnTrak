"use client";

/**
 * Hosts and the targets on them.
 *
 * The point of this page is coverage, not counts: it shows whether each target was
 * actually inspected, because a target that was never inspected contributes zero
 * findings and would otherwise be indistinguishable from a current one. The
 * `coverage` column is the number of targets per host that have been scanned at
 * least once, which is the honest denominator behind "0 pending".
 */

import Link from "next/link";

import { Empty, LoadError, ReachablePill, ScanPill, When } from "@/components/bits";
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
            how many of a host&apos;s targets have answered at least once.
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
 * Targets carry their counts as columns the API adds per request; this keeps the
 * table honest when a field is missing rather than rendering `undefined`.
 */
function countProperty(target: Target, key: string): string {
  const value = (target as unknown as Record<string, number | undefined>)[key];
  return value === undefined ? "·" : String(value);
}
