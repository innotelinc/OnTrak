"use client";

/**
 * Findings — the worklist.
 *
 * This is where an operator decides. Every row is one package on one target with
 * one candidate version, and the three actions map to the three answers: approve
 * (install it), skip (not this time — a later scan will ask again), and apply
 * (install the ones already approved).
 *
 * Two deliberate choices in the UI:
 *
 * **Apply only ever sends approved ids.** The button counts approved findings and
 * says so. There is no "apply everything shown", because the filter is a view and
 * a view should never be the thing that authorized a change.
 *
 * **A selection survives a reload, not a filter change.** Cleared on every filter
 * change, because approving a package you can no longer see is how the wrong
 * version gets installed.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Empty, LoadError, ManagerTag, SecurityPill, StatusPill, When } from "@/components/bits";
import { api, asApplyResult } from "@/lib/api";
import type { ApplyResult, Finding } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

const STATUSES = ["", "pending", "approved", "applied", "failed", "skipped"];
const MANAGERS = ["", "apt", "snap", "docker"];

export default function FindingsPage() {
  const [status, setStatus] = useState("pending");
  const [manager, setManager] = useState("");
  const [host, setHost] = useState("");
  const [securityOnly, setSecurityOnly] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<ApplyResult | null>(null);

  const findings = useAsync(
    () => api.findings({ status, manager, host, security_only: securityOnly, limit: 5000 }),
    [status, manager, host, securityOnly],
  );
  const hosts = useAsync(() => api.hosts(), []);

  // A selection is cleared whenever the list it referred to changes.
  useEffect(() => {
    setSelected(new Set());
    setApplied(null);
  }, [status, manager, host, securityOnly]);

  const rows = findings.data?.findings ?? [];
  const approvedCount = useMemo(() => rows.filter((row) => row.status === "approved").length, [rows]);

  function toggle(id: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function act(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await action();
      findings.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  const ids = [...selected];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Findings</h1>
          <p>
            One row per package that is behind, per target. Security updates sort first.
            Nothing is installed until it is approved — unless the timer is set to
            automatic, in which case the security-only switch below is what the schedule
            honours.
          </p>
        </div>
        <div className="actions">
          <button
            disabled={busy !== null || ids.length === 0}
            onClick={() =>
              act("approve", async () => {
                // Approve and install in the same call — the button says "install
                // it", and the list is filtered to pending, so the approved rows
                // vanish and a separate Apply step would be out of reach.
                const result = await api.approve({ ids, apply: true });
                setSelected(new Set());
                const applied = asApplyResult(result);
                if (applied) setApplied(applied);
              })
            }
          >
            Approve selected ({ids.length})
          </button>
          <button
            disabled={busy !== null || ids.length === 0}
            onClick={() => act("skip", async () => { await api.skip({ ids }); setSelected(new Set()); })}
          >
            Skip selected
          </button>
          <button
            className="primary"
            disabled={busy !== null || approvedCount === 0}
            onClick={() =>
              act("apply", async () => {
                setApplied(await api.apply({ all_approved: true }));
              })
            }
          >
            {busy === "apply" ? "Applying…" : `Apply ${approvedCount} approved`}
          </button>
        </div>
      </div>

      <section className="panel">
        <header>
          <div className="row-inline">
            <label className="checkline">
              <span className="faint">status</span>
              <select value={status} onChange={(event) => setStatus(event.target.value)} style={{ width: 130 }}>
                {STATUSES.map((value) => (
                  <option key={value || "any"} value={value}>{value || "any"}</option>
                ))}
              </select>
            </label>
            <label className="checkline">
              <span className="faint">manager</span>
              <select value={manager} onChange={(event) => setManager(event.target.value)} style={{ width: 120 }}>
                {MANAGERS.map((value) => (
                  <option key={value || "any"} value={value}>{value || "any"}</option>
                ))}
              </select>
            </label>
            <label className="checkline">
              <span className="faint">host</span>
              <select value={host} onChange={(event) => setHost(event.target.value)} style={{ width: 130 }}>
                <option value="">any</option>
                {(hosts.data?.hosts ?? []).map((entry) => (
                  <option key={entry.name} value={entry.name}>{entry.name}</option>
                ))}
              </select>
            </label>
            <label className="checkline">
              <input
                type="checkbox"
                checked={securityOnly}
                onChange={(event) => setSecurityOnly(event.target.checked)}
              />
              security only
            </label>
          </div>
          <span className="faint">{rows.length} row(s)</span>
        </header>
        <div className="body body--flush">
          {error ? <div className="note note--bad">{error}</div> : null}
          {applied ? (
            <div className={`note ${applied.failed ? "note--warn" : "note--ok"}`} style={{ margin: 13 }}>
              {applied.summary}
              {applied.manual.length ? (
                <pre className="out">{applied.manual.join("\n")}</pre>
              ) : null}
            </div>
          ) : null}
          {findings.error ? <LoadError error={findings.error} /> : null}
          {findings.loading && !rows.length ? (
            <div className="empty">Loading findings…</div>
          ) : rows.length === 0 ? (
            <Empty>
              Nothing here. Either the Network is current, or nothing has been scanned
              yet — the Dashboard says which.
            </Empty>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>
                      <input
                        type="checkbox"
                        checked={rows.length > 0 && selected.size === rows.length}
                        onChange={(event) =>
                          setSelected(event.target.checked ? new Set(rows.map((row) => row.id)) : new Set())
                        }
                      />
                    </th>
                    <th>Target</th>
                    <th>Manager</th>
                    <th>Package</th>
                    <th>From → to</th>
                    <th>Flags</th>
                    <th>Status</th>
                    <th>First seen</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className={row.security ? "row--security" : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(row.id)}
                          onChange={() => toggle(row.id)}
                        />
                      </td>
                      <td className="tight">
                        <Link href={`/hosts/${encodeURIComponent(row.host)}`}>{row.host}</Link>
                        <div className="faint mono">{row.target}</div>
                      </td>
                      <td><ManagerTag manager={row.manager} /></td>
                      <td className="mono">{row.package}</td>
                      <td className="mono dim">
                        {row.current || <span className="faint">—</span>} → {row.candidate || "?"}
                      </td>
                      <td className="tight">{row.security ? <SecurityPill /> : null}</td>
                      <td className="tight"><StatusPill status={row.status} /></td>
                      <td className="tight"><When value={row.first_seen} /></td>
                      <td className="dim" style={{ maxWidth: 320 }}>
                        {row.detail ?? row.target_error ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
