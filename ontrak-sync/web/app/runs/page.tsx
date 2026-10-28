"use client";

/**
 * Runs and the event log.
 *
 * A monitoring tool that only shows current state cannot answer the question people
 * actually ask when something changed — "when did this happen, and what did it say
 * at the time?". So the runs table is every scan and apply with what it did, and the
 * log below is the raw events, warnings included: the unparsed-output complaints and
 * the registry refusals that never turn into findings live here, because they are
 * the early warning that a probe has stopped understanding a host.
 */

import { useState } from "react";

import { Empty, LoadError, When } from "@/components/bits";
import { api } from "@/lib/api";
import type { Event, Run } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

export default function RunsPage() {
  const [level, setLevel] = useState("");
  const [undoing, setUndoing] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const runs = useAsync<{ runs: Run[] }>(() => api.runs(60), []);
  const events = useAsync<{ events: Event[] }>(() => api.events(400), []);

  const rows = runs.data?.runs ?? [];
  const log = (events.data?.events ?? []).filter((entry) => !level || entry.level === level);

  /**
   * Put back what one apply run replaced.
   *
   * A run is the unit because the version to restore is a fact about that run, not
   * about the package (see `backend/ontrak/rollback.py`). The confirmation names
   * the count: an undo is a change to every machine the run touched.
   */
  async function rollBack(entry: Run) {
    if (!window.confirm(`Put back the ${entry.applied} package(s) run #${entry.id} replaced?`)) return;
    setUndoing(entry.id);
    setNotice(null);
    try {
      const result = await api.rollback(entry.id);
      const reasons = result.refusals.length ? ` — ${result.refusals.join("; ")}` : "";
      setNotice(`Run #${entry.id}: ${result.summary}${reasons}`);
      runs.reload();
      events.reload();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUndoing(null);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Runs &amp; log</h1>
          <p>
            Every scan and every apply, with what it changed. The log keeps the
            warnings that never become findings — output a parser did not recognise, a
            registry that refused a token — because those are what predict a host
            drifting unnoticed.
          </p>
        </div>
        <button
          onClick={() => {
            runs.reload();
            events.reload();
          }}
        >
          Refresh
        </button>
      </div>

      <section className="panel">
        <header><h2>Runs</h2><span className="faint">{rows.length}</span></header>
        <div className="body body--flush">
          {runs.error ? <LoadError error={runs.error} /> : null}
          {notice ? <p className="faint" style={{ padding: "0 16px" }}>{notice}</p> : null}
          {rows.length === 0 ? (
            <Empty>Nothing has run yet.</Empty>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Kind</th>
                    <th>Trigger</th>
                    <th>Status</th>
                    <th className="num">Findings</th>
                    <th className="num">Applied</th>
                    <th className="num">Failed</th>
                    <th>Started</th>
                    <th>Took</th>
                    <th>Summary</th>
                    <th>Undo</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((entry) => (
                    <tr key={entry.id}>
                      <td className="num">{entry.id}</td>
                      <td className="mono">{entry.kind}</td>
                      <td className="faint">{entry.trigger}</td>
                      <td className="tight">
                        <span className={`pill pill--${entry.status === "ok" ? "ok" : entry.status === "error" ? "bad" : "partial"}`}>
                          {entry.status}
                        </span>
                      </td>
                      <td className="num">{entry.findings}</td>
                      <td className="num">{entry.applied}</td>
                      <td className="num">{entry.failed || <span className="faint">0</span>}</td>
                      <td className="tight"><When value={entry.started_at} /></td>
                      <td className="tight faint">{duration(entry.started_at, entry.finished_at)}</td>
                      <td className="dim">{entry.summary ?? ""}</td>
                      <td className="tight">
                        {entry.kind === "apply" && entry.applied > 0 ? (
                          <button
                            onClick={() => rollBack(entry)}
                            disabled={undoing !== null}
                            title="Put back the versions this run replaced"
                          >
                            {undoing === entry.id ? "Rolling back…" : "Roll back"}
                          </button>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
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
          <h2>Event log</h2>
          <label className="checkline">
            <span className="faint">level</span>
            <select value={level} onChange={(event) => setLevel(event.target.value)} style={{ width: 120 }}>
              <option value="">all</option>
              <option value="error">error</option>
              <option value="warning">warning</option>
              <option value="info">info</option>
            </select>
          </label>
        </header>
        <div className="body body--flush">
          {events.error ? <LoadError error={events.error} /> : null}
          {log.length === 0 ? (
            <Empty>No events at this level.</Empty>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 130 }}>When</th>
                    <th style={{ width: 80 }}>Level</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {log.map((entry) => (
                    <tr key={entry.id}>
                      <td className="tight"><When value={entry.ts} /></td>
                      <td className="tight">
                        <span className={`pill pill--${entry.level === "error" ? "bad" : entry.level === "warning" ? "partial" : "skipped"}`}>
                          {entry.level}
                        </span>
                      </td>
                      <td className={entry.level === "info" ? "dim" : undefined}>{entry.message}</td>
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

/** Wall-clock duration, or "running" — a run that never finished must look like that. */
function duration(started: string, finished: string | null): string {
  if (!finished) return "running";
  const from = new Date(started.endsWith("Z") ? started : `${started}Z`).getTime();
  const to = new Date(finished.endsWith("Z") ? finished : `${finished}Z`).getTime();
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
