"use client";

/**
 * Account — your own password, and every session that is open in your name.
 *
 * The session list is the half of signing in that most tools leave out. A person
 * who thinks their credential has been used by somebody else needs to be able to
 * *see* the sessions and end them, not just change a password and hope. So every
 * session is listed with the device, the address and when it was last used, and
 * each one can be revoked individually.
 *
 * A change of password revokes everything here, including the session doing the
 * change. That is stated in the form rather than discovered afterwards: a
 * password change that left the old sessions alive would not evict anybody, and
 * one that silently signs you out of the page you are on looks like a bug.
 */

import { useCallback, useEffect, useState } from "react";

import { LoadError, When } from "@/components/bits";
import { ApiError, api } from "@/lib/api";
import { isService, useSession } from "@/lib/session";
import type { UserSession } from "@/lib/types";

export default function AccountPage() {
  const { identity, signOut } = useSession();
  const [sessions, setSessions] = useState<UserSession[] | null>(null);
  const [scope, setScope] = useState<"all" | "own" | "none">("own");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.sessions();
      setSessions(result.sessions);
      setScope(result.scope);
      setError(null);
    } catch (cause) {
      setError(cause);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (isService(identity)) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Account</h1>
            <p>This browser is using the deployment token, not a person&apos;s account.</p>
          </div>
        </div>
        <div className="note note--warn">
          There is no password to change and no session to list for a deployment token.
          It is a machine credential defined by <code>ONTRAK_API_TOKEN</code> on the
          host, revoked by changing that value and restarting the API.
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Account</h1>
          <p>
            {identity?.display_name || identity?.username} ·{" "}
            <span className="pill pill--role">{identity?.role}</span>
          </p>
        </div>
      </div>

      {notice ? <div className="note note--ok">{notice}</div> : null}
      {error ? <LoadError error={error} /> : null}

      <section className="panel">
        <header>
          <h2>Change password</h2>
        </header>
        <div className="body">
          <p className="dim" style={{ marginTop: 0 }}>
            At least 12 characters. Changing it signs out every session below,
            including this one — you will sign in again with the new password.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (next !== repeat) {
                setError(new Error("The two new passwords do not match."));
                return;
              }
              setBusy(true);
              setNotice(null);
              setError(null);
              api.changePassword(current, next)
                .then(async () => {
                  setCurrent("");
                  setNext("");
                  setRepeat("");
                  setNotice("Password changed. Every session was signed out — sign in again.");
                  await signOut();
                })
                .catch((cause) => {
                  setError(cause instanceof ApiError && cause.status === 422
                    ? new Error(cause.problems.join("; "))
                    : cause);
                })
                .finally(() => setBusy(false));
            }}
          >
            <div className="row-inline">
              <label className="field" style={{ flex: "1 1 240px" }}>
                <span>Current password</span>
                <input type="password" value={current} autoComplete="current-password" required
                       onChange={(event) => setCurrent(event.target.value)} />
              </label>
              <label className="field" style={{ flex: "1 1 240px" }}>
                <span>New password</span>
                <input type="password" value={next} autoComplete="new-password" required
                       minLength={12}
                       onChange={(event) => setNext(event.target.value)} />
              </label>
              <label className="field" style={{ flex: "1 1 240px" }}>
                <span>Repeat the new password</span>
                <input type="password" value={repeat} autoComplete="new-password" required
                       onChange={(event) => setRepeat(event.target.value)} />
              </label>
            </div>
            <div className="actions">
              <button className="primary" type="submit"
                      disabled={busy || !current || next.length < 12}>
                {busy ? "Changing…" : "Change password"}
              </button>
            </div>
          </form>
        </div>
      </section>

      <section className="panel">
        <header>
          <h2>Sessions</h2>
          <span className="faint">
            {scope === "all" ? "every session on this deployment" : "yours"}
          </span>
        </header>
        <div className="body body--flush">
          {sessions === null ? (
            <div className="empty">Loading sessions…</div>
          ) : sessions.length === 0 ? (
            <div className="empty">No open sessions.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  {scope === "all" ? <th>Who</th> : null}
                  <th>Device</th>
                  <th>Address</th>
                  <th>Started</th>
                  <th>Last used</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    {scope === "all" ? <td>{session.username}</td> : null}
                    <td className="dim">{describeAgent(session.user_agent)}</td>
                    <td className="faint mono">{session.address || "—"}</td>
                    <td><When value={session.created_at} /></td>
                    <td><When value={session.last_seen_at} /></td>
                    <td><When value={session.expires_at} /></td>
                    <td className="tight">
                      <button
                        className="ghost"
                        disabled={busy}
                        onClick={() => {
                          setBusy(true);
                          api.revokeSession(session.id)
                            .then(() => load())
                            .catch(setError)
                            .finally(() => setBusy(false));
                        }}
                      >
                        Revoke
                      </button>
                    </td>
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

/** A user-agent string reduced to the one word a person recognises. */
function describeAgent(agent: string | null): string {
  if (!agent) return "unknown device";
  if (/Firefox\//.test(agent)) return "Firefox";
  if (/Edg\//.test(agent)) return "Edge";
  if (/Chrome\//.test(agent)) return "Chrome";
  if (/Safari\//.test(agent)) return "Safari";
  if (/curl|python|wget|node/i.test(agent)) return "script";
  return agent.slice(0, 40);
}
