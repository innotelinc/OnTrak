"use client";

/**
 * The dashboard.
 *
 * This is the page that answers "what needs attention?" without a click, so its
 * layout is the priority order: security updates, then everything else pending,
 * then the states that are NOT "fine" — unreachable hosts, targets that were never
 * inspected, and machines that are waiting for a reboot. Those sit in the same row
 * of cards as the pending count deliberately: a Network that reads "0 pending"
 * while three hosts are unreachable is the failure this tool exists to prevent, and
 * a number in a small grey font under a table is not enough to prevent it. So is a
 * Network that reads "0 pending" on a host whose kernel update is installed and not
 * yet running — which is why the reboot card appears only when it is non-zero:
 * every other number here is wrong at the same moment.
 *
 * The three actions on this page are the whole manual workflow: scan, approve,
 * apply. Everything they do is also available per-item on the Findings page; these
 * are the bulk versions, and each reports what it did rather than just refreshing.
 */

import Link from "next/link";
import { useState } from "react";

import { Empty, LoadError, ReachablePill, RebootPill, When } from "@/components/bits";
import { api } from "@/lib/api";
import type { ApplyResult, Host, Run, ScanResult, Summary } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

export default function DashboardPage() {
  const summary = useAsync<Summary>(() => api.summary());
  const hosts = useAsync<{ hosts: Host[] }>(() => api.hosts());
  const runs = useAsync<{ runs: Run[] }>(() => api.runs(6));

  const [busy, setBusy] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  function refresh() {
    summary.reload();
    hosts.reload();
    runs.reload();
  }

  const data = summary.data;
  const hostRows = hosts.data?.hosts ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Network update state</h1>
          <p>
            Every incus host, every container inside it, and their apt, snap and Docker
            updates. Nothing is installed without an approval unless the timer is set to
            automatic.
          </p>
        </div>
        <div className="actions">
          <button
            disabled={busy !== null}
            onClick={() =>
              run("scan", async () => {
                const result = await api.scan();
                setScanResult(result);
                setApplyResult(null);
                refresh();
              })
            }
          >
            {busy === "scan" ? "Scanning…" : "Scan now"}
          </button>
          {data && data.security > 0 ? (
            <button
              disabled={busy !== null}
              onClick={() =>
                run("approve", async () => {
                  await api.approve({ all_pending: true, security_only: true });
                  refresh();
                })
              }
            >
              {busy === "approve" ? "Approving…" : `Approve all ${data.security} security`}
            </button>
          ) : null}
          {data && data.approved > 0 ? (
            <button
              className="primary"
              disabled={busy !== null}
              onClick={() =>
                run("apply", async () => {
                  const result = await api.apply({ all_approved: true });
                  setApplyResult(result);
                  setScanResult(null);
                  refresh();
                })
              }
            >
              {busy === "apply" ? "Applying…" : `Apply ${data.approved} approved`}
            </button>
          ) : null}
        </div>
      </div>

      {error ? <div className="note note--bad">{error}</div> : null}

      <div className="cards">
        <div className={`card ${data && data.security > 0 ? "card--security" : ""}`}>
          <div className="label">Security updates</div>
          <div className="value">{data ? data.security : "—"}</div>
          <div className="hint">from a <code>-security</code> pocket</div>
        </div>
        <div className="card">
          <div className="label">Pending</div>
          <div className="value">{data ? data.pending : "—"}</div>
          <div className="hint">awaiting a decision</div>
        </div>
        <div className={`card ${data && data.approved > 0 ? "card--attention" : ""}`}>
          <div className="label">Approved</div>
          <div className="value">{data ? data.approved : "—"}</div>
          <div className="hint">ready to apply</div>
        </div>
        <div className={`card ${data && data.unknown > 0 ? "card--unknown" : "card--ok"}`}>
          <div className="label">Unknown</div>
          <div className="value">{data ? data.unknown : "—"}</div>
          <div className="hint">never inspected, or unreachable</div>
        </div>
        <div className={`card ${data && data.failed > 0 ? "card--security" : ""}`}>
          <div className="label">Failed</div>
          <div className="value">{data ? data.failed : "—"}</div>
          <div className="hint">an apply did not complete</div>
        </div>
        {/* Only when it is somebody's problem. A permanent card reading 0 next to a
            permanent card reading 0 teaches an operator to stop reading the row. */}
        {data && data.reboot_required > 0 ? (
          <div className="card card--attention">
            <div className="label">Reboot required</div>
            <div className="value">{data.reboot_required}</div>
            <div className="hint">a new kernel is installed, not running</div>
          </div>
        ) : null}
        <div className="card">
          <div className="label">Hosts</div>
          <div className="value">
            {data ? `${data.reachable}/${data.hosts}` : "—"}
          </div>
          <div className="hint">{data ? `${data.targets} targets` : ""}</div>
        </div>
      </div>

      {scanResult ? <ScanReport result={scanResult} onDismiss={() => setScanResult(null)} /> : null}
      {applyResult ? <ApplyReport result={applyResult} onDismiss={() => setApplyResult(null)} /> : null}

      <section className="panel">
        <header>
          <h2>Hosts</h2>
          <Link href="/hosts">all targets →</Link>
        </header>
        <div className="body body--flush">
          {hosts.error ? <LoadError error={hosts.error} /> : null}
          {hosts.loading && !hostRows.length ? (
            <div className="empty">Loading hosts…</div>
          ) : hostRows.length === 0 ? (
            <Empty>
              No hosts have been recorded yet. Run a scan to inventory the Network.
            </Empty>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Host</th>
                    <th>State</th>
                    <th>OS</th>
                    <th>Reboot</th>
                    <th className="num">Containers</th>
                    <th className="num">Pending</th>
                    <th className="num">Security</th>
                    <th className="num">Unknown</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {hostRows.map((host) => (
                    <tr key={host.name}>
                      <td>
                        <Link href={`/hosts/${encodeURIComponent(host.name)}`}>{host.name}</Link>
                        <div className="faint mono">{host.address}</div>
                      </td>
                      <td><ReachablePill reachable={host.reachable} /></td>
                      <td className="dim">{host.os ?? <span className="faint">unknown</span>}</td>
                      <td className="tight">
                        <RebootPill known={host.reboot_known} required={host.reboot_required}
                                    packages={host.reboot_packages} />
                      </td>
                      <td className="num">{host.container_count}</td>
                      <td className="num">{host.pending || <span className="faint">0</span>}</td>
                      <td className="num">
                        {host.security
                          ? <span style={{ color: "var(--security)", fontWeight: 600 }}>{host.security}</span>
                          : <span className="faint">0</span>}
                      </td>
                      <td className="num">
                        {host.unscanned || !host.reachable
                          ? <span style={{ color: "var(--unknown)" }}>{host.unscanned || "—"}</span>
                          : <span className="faint">0</span>}
                      </td>
                      <td><When value={host.last_seen} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <header>
          <h2>Recent activity</h2>
          <Link href="/runs">all runs →</Link>
        </header>
        <div className="body body--flush">
          {(runs.data?.runs ?? []).length === 0 ? (
            <Empty>Nothing has run yet.</Empty>
          ) : (
            <table>
              <tbody>
                {(runs.data?.runs ?? []).map((entry) => (
                  <tr key={entry.id}>
                    <td className="tight">
                      <span className={`pill pill--${entry.status === "ok" ? "ok" : entry.status === "error" ? "bad" : "partial"}`}>
                        {entry.kind} · {entry.status}
                      </span>
                    </td>
                    <td className="dim">{entry.summary}</td>
                    <td className="tight faint">{entry.trigger}</td>
                    <td className="tight"><When value={entry.started_at} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}

function ScanReport({ result, onDismiss }: { result: ScanResult; onDismiss: () => void }) {
  const problems = result.hosts.filter((host) => !host.scanned || host.errors.length > 0);
  return (
    <section className="panel">
      <header>
        <h2>Scan result</h2>
        <button className="ghost" onClick={onDismiss}>dismiss</button>
      </header>
      <div className="body">
        <div className={`note ${result.status === "ok" ? "note--ok" : "note--bad"}`}>
          {result.summary} — {result.scanned} of {result.targets} targets inspected.
        </div>
        {problems.length > 0 ? (
          <>
            <p className="dim" style={{ marginBottom: 4 }}>
              These targets could not be fully inspected. They are NOT reported as up to
              date, and any finding already on record for them has been left alone:
            </p>
            <pre className="out">
              {problems
                .map((host) =>
                  `${host.host}/${host.target}  [${Object.entries(host.managers)
                    .map(([name, state]) => `${name}=${state}`)
                    .join(" ")}]\n  ${host.errors.join("\n  ") || "not inspected"}`,
                )
                .join("\n")}
            </pre>
          </>
        ) : (
          <p className="dim" style={{ margin: 0 }}>Every target answered.</p>
        )}
      </div>
    </section>
  );
}

function ApplyReport({ result, onDismiss }: { result: ApplyResult; onDismiss: () => void }) {
  return (
    <section className="panel">
      <header>
        <h2>Apply result</h2>
        <button className="ghost" onClick={onDismiss}>dismiss</button>
      </header>
      <div className="body">
        <div className={`note ${result.failed ? "note--warn" : "note--ok"}`}>{result.summary}</div>
        {result.manual.length > 0 ? (
          <>
            <p className="dim" style={{ marginBottom: 4 }}>
              These need a person. The image was pulled, but recreating the container
              from here would risk stopping something else, so it was left running:
            </p>
            <pre className="out">{result.manual.join("\n")}</pre>
          </>
        ) : null}
        {result.messages.length > 0 ? <pre className="out">{result.messages.join("\n")}</pre> : null}
      </div>
    </section>
  );
}
