"use client";

/**
 * One host in full: its targets, what each one reported, and what could not be
 * inspected.
 *
 * The `errors` a scan records are shown here rather than only in the run log,
 * because they are the difference between "this host is clean" and "this host was
 * not read". A target with failed probes is rendered with a visible complaint even
 * when it has no findings, which is the case the dashboard would otherwise show as
 * a tidy row of zeroes.
 */

import Link from "next/link";
import { useState } from "react";

import { Empty, LoadError, ManagerTag, ReachablePill, RebootPill, ScanPill, SecurityPill, StatusPill, When } from "@/components/bits";
import { api } from "@/lib/api";
import type { Finding, Host, Target } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

type TargetWithFindings = Target & { findings: Finding[] };

export function HostDetail({ name }: { name: string }) {
  const host = useAsync<{ host: Host; targets: TargetWithFindings[] }>(() => api.host(name), [name]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(label: string, action: () => Promise<string>) {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      setMessage(await action());
      host.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  if (host.error) return <LoadError error={host.error} />;
  if (!host.data) return <div className="empty">Loading {name}…</div>;

  const record = host.data.host;
  const targets = host.data.targets;
  // One name per line, exactly as the host's own file listed them.
  const rebootPackages = (record.reboot_packages ?? "").split("\n").filter(Boolean);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {record.name} <span className="faint mono" style={{ fontSize: 14 }}>{record.address}</span>
          </h1>
          <p>
            {record.os ?? "OS unknown"} · kernel {record.kernel ?? "?"} ·{" "}
            {record.container_count} container(s) · last seen <When value={record.last_seen} />
            {record.error ? <> · <span style={{ color: "#ff9d95" }}>{record.error}</span></> : null}
          </p>
        </div>
        <div className="actions">
          <ReachablePill reachable={record.reachable} />
          <RebootPill known={record.reboot_known} required={record.reboot_required}
                      packages={record.reboot_packages} />
          <button
            disabled={busy !== null}
            onClick={() =>
              act("scan", async () => {
                const result = await api.scan([record.name]);
                return result.summary;
              })
            }
          >
            {busy === "scan" ? "Scanning…" : "Scan this host"}
          </button>
        </div>
      </div>

      {error ? <div className="note note--bad">{error}</div> : null}
      {message ? <div className="note note--ok">{message}</div> : null}

      {/* The one thing on this page that no target can report. Every table below
          can read zero and still be describing a machine that is running a kernel
          with the update installed and not in effect. */}
      {record.reboot_required ? (
        <div className="note note--warn">
          <strong>A reboot is pending.</strong> This host has a newer kernel installed and
          is still running the old one, so everything below reports as current while the
          fix is not in effect. Sync will not reboot it: that is a maintenance window with
          a person in it.
          {rebootPackages.length ? (
            <> Waiting on <span className="mono">{rebootPackages.join(", ")}</span>.</>
          ) : null}
        </div>
      ) : null}

      {targets.length === 0 ? (
        <Empty>No targets recorded for this host yet.</Empty>
      ) : (
        targets.map((target) => {
          const pending = target.findings.filter((finding) => finding.status === "pending");
          const approved = target.findings.filter((finding) => finding.status === "approved");
          const failed = target.findings.filter((finding) => finding.status === "failed");
          return (
            <section className="panel" key={target.id}>
              <header>
                <div>
                  <h2 style={{ textTransform: "none", fontSize: 14, color: "var(--text)" }}>
                    {target.name} <span className="faint" style={{ fontWeight: 400 }}>({target.kind})</span>
                  </h2>
                  <div className="faint" style={{ marginTop: 4 }}>
                    last inspected <When value={target.last_scanned_at} />
                  </div>
                </div>
                <div className="actions">
                  <ScanPill scanned={Boolean(target.last_scanned_at)} />
                  {pending.length ? <span className="pill pill--pending">{pending.length} pending</span> : null}
                  {approved.length ? <span className="pill pill--approved">{approved.length} approved</span> : null}
                  {failed.length ? <span className="pill pill--failed">{failed.length} failed</span> : null}
                  {approved.length ? (
                    <button
                      className="primary"
                      disabled={busy !== null}
                      onClick={() =>
                        act("apply", async () => {
                          const result = await api.apply({ ids: approved.map((finding) => finding.id) });
                          return result.summary;
                        })
                      }
                    >
                      {busy === "apply" ? "Applying…" : `Apply ${approved.length}`}
                    </button>
                  ) : null}
                  {pending.length ? (
                    <button
                      disabled={busy !== null}
                      onClick={() =>
                        act("approve", async () => {
                          const result = await api.approve({ ids: pending.map((finding) => finding.id) });
                          return `${result.approved} finding(s) approved — apply them from the Findings page or head of this panel.`;
                        })
                      }
                    >
                      Approve all
                    </button>
                  ) : null}
                </div>
              </header>
              <div className="body body--flush">
                {target.error ? <div className="note note--warn" style={{ margin: 13 }}>{target.error}</div> : null}
                {target.findings.length === 0 ? (
                  <div className="empty">
                    {target.last_scanned_at
                      ? "No updates reported by the probes that ran here."
                      : "Never inspected — this target contributes no findings, which is not the same as being current."}
                  </div>
                ) : (
                  <div className="scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Manager</th>
                          <th>Package</th>
                          <th>From → to</th>
                          <th>Flags</th>
                          <th>Status</th>
                          <th>Seen since</th>
                          <th>Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {target.findings.map((finding) => (
                          <tr key={finding.id} className={finding.security ? "row--security" : undefined}>
                            <td><ManagerTag manager={finding.manager} /></td>
                            <td className="mono">{finding.package}</td>
                            <td className="mono dim">
                              {finding.current ?? "—"} → {finding.candidate ?? "?"}
                            </td>
                            <td className="tight">{finding.security ? <SecurityPill /> : null}</td>
                            <td className="tight"><StatusPill status={finding.status} /></td>
                            <td className="tight"><When value={finding.first_seen} /></td>
                            <td className="dim" style={{ maxWidth: 280 }}>{finding.detail ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </section>
          );
        })
      )}

      <p className="faint">
        <Link href="/hosts">← all hosts</Link>
      </p>
    </>
  );
}
