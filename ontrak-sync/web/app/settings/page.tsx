"use client";

/**
 * The timer and the policy — the one page that changes how the service behaves.
 *
 * Two things here are worth the extra code:
 *
 * **The schedule is validated as it is typed, by the server.** The cron parser on
 * the backend is the same one the scheduler uses, so a schedule the preview accepts
 * is a schedule that will actually fire. Doing it in the browser would mean two
 * parsers, and the one in the browser would be the one that is wrong.
 *
 * **Automatic mode is behind a deliberate step.** Changing the mode to `auto`
 * requires confirming, because it is the difference between proposing a package
 * update and installing it on twenty-seven containers overnight. The confirmation
 * names the scope and the window it will run in, so the sentence says what will
 * actually happen.
 */

import { useEffect, useState } from "react";

import { LoadError } from "@/components/bits";
import { ApiError, api } from "@/lib/api";
import type { Manager, Policy } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

const PRESETS: { label: string; cron: string }[] = [
  { label: "Nightly 04:00", cron: "0 4 * * *" },
  { label: "Sundays 03:00", cron: "0 3 * * 0" },
  { label: "Weeknights 02:00", cron: "0 2 * * 1-5" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Hourly", cron: "@hourly" },
];

const MANAGERS: Manager[] = ["apt", "snap", "docker"];

export default function SettingsPage() {
  const policy = useAsync<Policy>(() => api.policy(), []);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [preview, setPreview] = useState<{ description: string; next_runs: string[]; valid: boolean } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (policy.data && !draft) {
      setDraft(policy.data);
      setPreview({
        description: policy.data.description,
        next_runs: policy.data.next_runs,
        valid: true,
      });
    }
  }, [policy.data, draft]);

  // Re-ask the server whenever the expression changes. Debounced so typing does not
  // produce a request per keystroke.
  useEffect(() => {
    if (!draft) return;
    const handle = setTimeout(async () => {
      try {
        const result = await api.previewPolicy({ schedule: draft.schedule });
        setPreview({
          description: result.description,
          next_runs: result.next_runs,
          valid: result.valid,
        });
      } catch {
        setPreview({ description: "could not reach the API", next_runs: [], valid: false });
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [draft?.schedule]); // eslint-disable-line react-hooks/exhaustive-deps

  if (policy.error) return <LoadError error={policy.error} />;
  if (!draft) return <div className="empty">Loading settings…</div>;

  function update<K extends keyof Policy>(key: K, value: Policy[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setSaved(false);
  }

  function toggleScope(scope: Manager) {
    update(
      "scopes",
      draft!.scopes.includes(scope)
        ? draft!.scopes.filter((entry) => entry !== scope)
        : [...draft!.scopes, scope],
    );
  }

  async function save() {
    setBusy(true);
    setProblems([]);
    try {
      const payload: Record<string, unknown> = {
        mode: draft!.mode,
        schedule: draft!.schedule,
        enabled: draft!.enabled,
        timezone: draft!.timezone,
        scopes: draft!.scopes,
        security_only: draft!.security_only,
        max_concurrent: draft!.max_concurrent,
        // Sent explicitly so clearing from the form clears on the server; an
        // omitted field means "leave alone", which is not what empty inputs mean.
        freeze_from: draft!.freeze_from ?? "",
        freeze_to: draft!.freeze_to ?? "",
      };
      if (draft!.window_start_hour === null || draft!.window_end_hour === null) {
        payload.clear_window = true;
      } else {
        payload.window_start_hour = draft!.window_start_hour;
        payload.window_end_hour = draft!.window_end_hour;
      }
      const result = await api.savePolicy(payload);
      setDraft(result);
      setPreview({ description: result.description, next_runs: result.next_runs, valid: true });
      setSaved(true);
    } catch (cause) {
      if (cause instanceof ApiError) setProblems(cause.problems);
      else setProblems([cause instanceof Error ? cause.message : String(cause)]);
    } finally {
      setBusy(false);
    }
  }

  const windowSet = draft.window_start_hour !== null && draft.window_end_hour !== null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Timer &amp; policy</h1>
          <p>
            When the Network is checked, and what the check is allowed to do. Changes
            take effect on the next tick of the running scheduler — no restart.
          </p>
        </div>
        <div className="actions">
          {saved ? <span className="pill pill--ok">saved</span> : null}
          <button className="primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {problems.length > 0 ? (
        <div className="note note--bad">
          <strong>Not saved.</strong> The service refused this because:
          <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
            {problems.map((problem) => <li key={problem}>{problem}</li>)}
          </ul>
        </div>
      ) : null}

      <section className="panel">
        <header><h2>Schedule</h2></header>
        <div className="body">
          <label className="checkline" style={{ marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => update("enabled", event.target.checked)}
            />
            Run on a schedule
          </label>

          <div className="row-inline" style={{ marginBottom: 10 }}>
            {PRESETS.map((preset) => (
              <button key={preset.cron} onClick={() => update("schedule", preset.cron)}>
                {preset.label}
              </button>
            ))}
          </div>

          <label className="field" style={{ maxWidth: 320 }}>
            <span>Cron expression (minute hour day month weekday)</span>
            <input
              className="mono"
              type="text"
              value={draft.schedule}
              onChange={(event) => update("schedule", event.target.value)}
            />
            <small>
              {preview
                ? preview.valid
                  ? preview.description
                  : <span style={{ color: "var(--bad)" }}>{preview.description}</span>
                : "checking…"}
            </small>
          </label>

          {preview && preview.next_runs.length > 0 ? (
            <>
              <div className="faint">Next five runs (UTC)</div>
              <ul className="sched-list">
                {preview.next_runs.map((entry) => (
                  <li key={entry}><strong>{entry.replace("T", " ")}</strong></li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <header><h2>What the timer may do</h2></header>
        <div className="body">
          <label className="field" style={{ maxWidth: 420 }}>
            <span>Mode</span>
            <select
              value={draft.mode}
              onChange={(event) => {
                const mode = event.target.value as Policy["mode"];
                if (
                  mode === "auto" &&
                  !window.confirm(
                    "Automatic mode will INSTALL updates without waiting for approval, " +
                      `for: ${draft.scopes.join(", ") || "no managers"}` +
                      (windowSet
                        ? `, between ${draft.window_start_hour}:00 and ${draft.window_end_hour}:00 UTC.`
                        : ", at whatever time the schedule fires.") +
                      " Continue?",
                  )
                ) {
                  return;
                }
                update("mode", mode);
              }}
            >
              <option value="detect">detect — find updates, never install them</option>
              <option value="auto">auto — install on the schedule</option>
            </select>
            <small>
              {draft.mode === "detect"
                ? "Findings accumulate for approval. This is the safe default and what the Network runs."
                : "Updates are installed when the timer fires. Approvals are no longer required — the security-only switch below still applies."}
            </small>
          </label>

          <div className="field">
            <span className="dim" style={{ fontSize: 12 }}>Managers the timer may act on</span>
            <div className="row-inline" style={{ marginTop: 6 }}>
              {MANAGERS.map((scope) => (
                <label className="checkline" key={scope}>
                  <input
                    type="checkbox"
                    checked={draft.scopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                  />
                  {scope}
                </label>
              ))}
            </div>
            <small className="faint">
              Docker recreation is included in <code>docker</code>. A container that is not
              compose-managed is pulled but never recreated automatically.
            </small>
          </div>

          <label className="checkline" style={{ marginBottom: 4 }}>
            <input
              type="checkbox"
              checked={draft.security_only}
              onChange={(event) => update("security_only", event.target.checked)}
            />
            Only act on security updates
          </label>
          <small className="faint">
            In automatic mode this is what keeps feature updates waiting for a person.
          </small>

          <div className="field" style={{ marginTop: 14 }}>
            <span className="dim" style={{ fontSize: 12 }}>Maintenance window (UTC hours)</span>
            <div className="row-inline" style={{ marginTop: 6 }}>
              <label className="checkline">
                <input
                  type="checkbox"
                  checked={windowSet}
                  onChange={(event) => {
                    // Both ends move together: a one-ended window is not a thing the
                    // API can represent, and the default 22→05 is the window this
                    // operation actually uses.
                    if (event.target.checked) {
                      setDraft((current) =>
                        current ? { ...current, window_start_hour: 22, window_end_hour: 5 } : current,
                      );
                    } else {
                      setDraft((current) =>
                        current ? { ...current, window_start_hour: null, window_end_hour: null } : current,
                      );
                    }
                    setSaved(false);
                  }}
                />
                restrict to a window
              </label>
              {windowSet ? (
                <>
                  <label className="checkline">
                    from
                    <input
                      type="number"
                      min={0}
                      max={23}
                      style={{ width: 70 }}
                      value={draft.window_start_hour ?? 0}
                      onChange={(event) => update("window_start_hour", Number(event.target.value))}
                    />
                  </label>
                  <label className="checkline">
                    to
                    <input
                      type="number"
                      min={0}
                      max={23}
                      style={{ width: 70 }}
                      value={draft.window_end_hour ?? 0}
                      onChange={(event) => update("window_end_hour", Number(event.target.value))}
                    />
                  </label>
                </>
              ) : null}
            </div>
            <small className="faint">
              A window that wraps midnight (22 → 5) is expected. Outside it, a scheduled
              run is skipped rather than deferred.
            </small>
          </div>

          <label className="field" style={{ maxWidth: 200, marginTop: 14 }}>
            <span>Hosts scanned at once</span>
            <input
              type="number"
              min={1}
              max={10}
              value={draft.max_concurrent}
              onChange={(event) => update("max_concurrent", Number(event.target.value))}
            />
            <small>Parallelism across hosts. One host is walked serially.</small>
          </label>

          <div className="field" style={{ marginTop: 14 }}>
            <span className="dim" style={{ fontSize: 12 }}>Change freeze (inclusive dates)</span>
            <div className="row-inline" style={{ marginTop: 6 }}>
              <label className="checkline">
                from
                <input
                  type="date"
                  value={draft.freeze_from ?? ""}
                  onChange={(event) => update("freeze_from", event.target.value)}
                />
              </label>
              <label className="checkline">
                to
                <input
                  type="date"
                  value={draft.freeze_to ?? ""}
                  onChange={(event) => update("freeze_to", event.target.value)}
                />
              </label>
              {draft.freeze_from || draft.freeze_to ? (
                <button
                  onClick={() => {
                    update("freeze_from", "");
                    update("freeze_to", "");
                  }}
                >
                  clear
                </button>
              ) : null}
            </div>
            <small className="faint">
              Nothing is applied between these dates — automatic mode included. Both ends are
              required and both are inclusive; leave them empty for no freeze.
            </small>
          </div>
        </div>
      </section>

      <section className="panel">
        <header><h2>Current policy</h2></header>
        <div className="body">
          <pre className="out">{JSON.stringify(
            {
              mode: draft.mode,
              schedule: draft.schedule,
              enabled: draft.enabled,
              description: preview?.description ?? draft.description,
              scopes: draft.scopes,
              security_only: draft.security_only,
              window: windowSet ? [draft.window_start_hour, draft.window_end_hour] : null,
              freeze: draft.freeze_from && draft.freeze_to ? [draft.freeze_from, draft.freeze_to] : null,
              max_concurrent: draft.max_concurrent,
              timezone: draft.timezone,
            },
            null,
            2,
          )}</pre>
        </div>
      </section>
    </>
  );
}
