"use client";

/**
 * The dashboard.
 *
 * This is the page that answers "what needs attention?" without a click, so its
 * layout is the priority order: security updates, then everything else pending,
 * then the states that are NOT "fine" — unreachable hosts, targets that were never
 * inspected, and machines that are waiting for a reboot. Those sit in the same row
 * of cards as the pending count deliberately: a Network that reads "0 pending"
 * while several hosts are unreachable is the failure this tool exists to prevent, and
 * a number in a small grey font under a table is not enough to prevent it. So is a
 * Network that reads "0 pending" on a host whose kernel update is installed and not
 * yet running — which is why the reboot card appears only when it is non-zero:
 * every other number here is wrong at the same moment.
 *
 * ONE STEP, AND WHAT IT DID
 * -------------------------
 * Updating used to be two decisions in the header — approve, then apply — and the
 * operator had to know that the second button would not act until the first had.
 * The manual path is now one action, **Update everything**, which approves every
 * pending finding and applies them, and reports progress while it runs. The approval
 * is still recorded (the API is what writes it, and the audit trail is unchanged);
 * it is simply no longer a separate click. The timer's own policy is untouched: a
 * deployment in `detect` mode still does nothing until a person acts, and that person
 * acting here is the action.
 *
 * A FAILURE IS A WORKLIST, NOT A FOOTNOTE
 * ---------------------------------------
 * An apply that fails does not leave the failed findings as one more `Failed` card
 * counting itself. They are grouped by target below, with their reasons in full, and
 * **Retry all** re-approves and re-applies exactly that set. The alternative — a
 * number, and a log nobody opens — is how a failed update stays failed for a month
 * behind a green dashboard.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Empty, LoadError, ManagerTag, ReachablePill, RebootPill, When } from "@/components/bits";
import { api } from "@/lib/api";
import type { ApplyResult, Finding, Host, Run, ScanResult, Summary } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

/** The two phases of an update, so the progress bar can say which one is running. */
interface Progress {
  label: string;
  step: number;
  total: number;
}

export default function DashboardPage() {
  const summary = useAsync<Summary>(() => api.summary());
  const hosts = useAsync<{ hosts: Host[] }>(() => api.hosts());
  const runs = useAsync<{ runs: Run[] }>(() => api.runs(6));
  // Loaded on mount as well as after an apply: a failure that is already on record
  // is the first thing a returning operator needs to see, not only the ones this
  // session produced.
  const failed = useAsync<{ findings: Finding[]; count: number }>(
    () => api.findings({ status: "failed", limit: 5000 }),
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
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
      setProgress(null);
      setBusy(null);
    }
  }

  function refresh() {
    summary.reload();
    hosts.reload();
    runs.reload();
    failed.reload();
  }

  const data = summary.data;
  const hostRows = hosts.data?.hosts ?? [];
  const failedRows = failed.data?.findings ?? [];

  /** One action: approve every pending finding, then apply everything approved. */
  async function updateEverything() {
    const pending = data?.pending ?? 0;
    const approved = data?.approved ?? 0;
    await run("update", async () => {
      setApplyResult(null);
      setScanResult(null);
      if (pending > 0) {
        setProgress({ label: `Approving ${pending} pending update${pending === 1 ? "" : "s"}…`, step: 1, total: 2 });
        await api.approve({ all_pending: true });
      }
      if (pending > 0 || approved > 0) {
        setProgress({ label: "Applying approved updates…", step: 2, total: 2 });
        setApplyResult(await api.apply({ all_approved: true }));
      }
      refresh();
    });
  }

  /** Re-approve and re-apply exactly the findings that failed. */
  async function retryFailed() {
    const ids = failedRows.map((finding) => finding.id);
    if (ids.length === 0) return;
    await run("retry", async () => {
      setApplyResult(null);
      setProgress({ label: `Re-approving ${ids.length} failed update${ids.length === 1 ? "" : "s"}…`, step: 1, total: 2 });
      await api.approve({ ids });
      setProgress({ label: `Retrying ${ids.length} update${ids.length === 1 ? "" : "s"}…`, step: 2, total: 2 });
      setApplyResult(await api.apply({ ids }));
      refresh();
    });
  }

  const pending = data?.pending ?? 0;
  const approved = data?.approved ?? 0;
  const canUpdate = busy === null && (pending > 0 || approved > 0);
  const updateLabel = busy === "update"
    ? "Updating…"
    : pending > 0
      ? `Update everything (${pending} pending)`
      : `Apply ${approved} approved`;

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
          <button className="primary" disabled={!canUpdate} onClick={updateEverything}>
            {updateLabel}
          </button>
        </div>
      </div>

      {error ? <div className="note note--bad">{error}</div> : null}
      {progress ? <ProgressBar progress={progress} /> : null}

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

      {failedRows.length > 0 ? (
        <FailedPanel rows={failedRows} busy={busy} onRetry={retryFailed} />
      ) : null}

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
                                    packages={host.reboot_packages}
                                    since={host.reboot_since} scans={host.reboot_scans} />
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

/**
 * The progress of one update, for as long as it runs.
 *
 * The API answers in one response, so there is no per-package percentage to draw;
 * what is honest here is the *phase* — approving or applying — and that the work is
 * still going. The bar fills to where the phase sits in the two-step flow and
 * animates while it is live, and the elapsed seconds count so a long apt run looks
 * like work rather than a hang.
 */
function ProgressBar({ progress }: { progress: Progress }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [progress.label, progress.step]);

  const pct = Math.max(10, Math.min(95, Math.round(((progress.step - 0.5) / progress.total) * 100)));

  return (
    <div className="note note--warn" role="status" aria-live="polite">
      <div className="row-inline" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <span>{progress.label}</span>
        <span className="faint">step {progress.step} of {progress.total} · {seconds}s</span>
      </div>
      <div className="progress" aria-hidden="true">
        <div className="progress__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * Every failed finding, grouped by the target it belongs to, with one Retry all.
 *
 * Grouping is by host *and* target because that is the unit an apply is grouped in
 * on the server: one apt transaction per target, so a target whose transaction was
 * held back reads as one fact rather than as forty rows of the same complaint.
 */
function FailedPanel({ rows, busy, onRetry }: {
  rows: Finding[];
  busy: string | null;
  onRetry: () => void;
}) {
  const groups = useMemo(() => {
    const byKey = new Map<string, { host: string; target: string; items: Finding[] }>();
    for (const row of rows) {
      const key = `${row.host}\u0000${row.target}`;
      let group = byKey.get(key);
      if (!group) {
        group = { host: row.host, target: row.target, items: [] };
        byKey.set(key, group);
      }
      group.items.push(row);
    }
    return [...byKey.values()].sort(
      (a, b) => a.host.localeCompare(b.host) || a.target.localeCompare(b.target),
    );
  }, [rows]);

  return (
    <section className="panel panel--failed">
      <header>
        <h2>Failed updates</h2>
        <div className="actions">
          <span className="faint">
            {rows.length} finding{rows.length === 1 ? "" : "s"} across {groups.length} target{groups.length === 1 ? "" : "s"}
          </span>
          <button className="primary" disabled={busy !== null} onClick={onRetry}>
            {busy === "retry" ? "Retrying…" : `Retry all ${rows.length}`}
          </button>
        </div>
      </header>
      <div className="body">
        <p className="dim" style={{ marginTop: 0 }}>
          These were approved and the apply did not complete. Retrying re-approves them
          and runs the apply again for exactly this set.
        </p>
        {groups.map((group) => (
          <div className="failed-group" key={`${group.host}\u0000${group.target}`}>
            <div className="failed-group__head">
              <div>
                <Link href={`/hosts/${encodeURIComponent(group.host)}`}>{group.host}</Link>
                <span className="faint mono"> {group.target}</span>
              </div>
              <span className="pill pill--failed">{group.items.length} failed</span>
            </div>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Manager</th>
                    <th>Package</th>
                    <th>From → to</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((finding) => (
                    <tr key={finding.id}>
                      <td><ManagerTag manager={finding.manager} /></td>
                      <td className="mono">{finding.package}</td>
                      <td className="mono dim">
                        {finding.current || <span className="faint">—</span>} → {finding.candidate || "?"}
                      </td>
                      <td className="dim" style={{ maxWidth: 420 }}>
                        {finding.detail ?? finding.target_error ?? "no reason recorded"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </section>
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
        {result.failed ? (
          <p className="dim" style={{ marginBottom: 4 }}>
            The failures are grouped in <strong>Failed updates</strong> above, where{" "}
            <strong>Retry all</strong> re-approves and re-applies them.
          </p>
        ) : null}
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
