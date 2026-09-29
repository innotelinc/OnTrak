"use client";

/**
 * People — who may sign in, and what they may do.
 *
 * This page is the whole local account table. It is administrator-only, and the
 * server refuses every one of these calls for anybody else, so the page exists
 * because an administrator needs a form and not because the page is the control.
 *
 * Two rules the interface has to make visible rather than enforce silently:
 *
 *  * **The last active administrator cannot be demoted or deactivated.** The API
 *    answers 409 and the reason is shown here. A deployment with no administrator
 *    left has to be repaired by hand on the host, which is a bad afternoon and
 *    not a security property worth having.
 *  * **An account with no password is SSO-only.** It is shown as such, and
 *    "clear the password" is an explicit action with its own consequence stated,
 *    because it is the strongest way to tell somebody "you come in through
 *    Cerulean, not through this form".
 */

import { useCallback, useEffect, useState } from "react";

import { LoadError, When } from "@/components/bits";
import { ApiError, api } from "@/lib/api";
import { can, useSession } from "@/lib/session";
import type { AppUser, Meta } from "@/lib/types";

interface Draft {
  username: string;
  email: string;
  display_name: string;
  role: string;
  password: string;
}

const EMPTY: Draft = { username: "", email: "", display_name: "", role: "STUDENT", password: "" };

export default function UsersPage() {
  const { identity } = useSession();
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [people, configuration] = await Promise.all([api.users(), api.meta()]);
      setUsers(people.users);
      setMeta(configuration);
      setError(null);
    } catch (cause) {
      setError(cause);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(label: string, run: () => Promise<string | void>) {
    setBusy(label);
    setNotice(null);
    setError(null);
    try {
      const message = await run();
      if (typeof message === "string") setNotice(message);
      await load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 422) {
        setNotice(null);
        setError(new Error(cause.problems.join("; ")));
      } else {
        setError(cause);
      }
    } finally {
      setBusy(null);
    }
  }

  const roles = meta?.roles ?? [];
  const allowed = can(identity, "users:manage");
  const admins = (users ?? []).filter((user) => user.role === "ADMIN" && user.active).length;

  if (!allowed) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>People</h1>
            <p>Accounts for this deployment.</p>
          </div>
        </div>
        <div className="note note--warn" role="alert">
          Your role ({identity?.role}) cannot manage accounts. Changing who may sign in
          is an administrator action; ask one, or sign in with an administrator account.
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>People</h1>
          <p>
            The accounts that may sign in to this deployment, and the role each one
            holds. A role decides both what a person can do here and which product the
            portal sends them to.
          </p>
        </div>
      </div>

      {notice ? <div className="note note--ok">{notice}</div> : null}
      {error ? <LoadError error={error} /> : null}

      <section className="panel">
        <header>
          <h2>Add someone</h2>
        </header>
        <div className="body">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act("create", async () => {
                await api.createUser({
                  username: draft.username.trim(),
                  email: draft.email.trim(),
                  display_name: draft.display_name.trim() || draft.username.trim(),
                  role: draft.role,
                  password: draft.password ? draft.password : undefined,
                });
                setDraft(EMPTY);
                return `Created ${draft.username.trim()}.`;
              });
            }}
          >
            <div className="row-inline">
              <label className="field" style={{ flex: "1 1 180px" }}>
                <span>Username</span>
                <input
                  type="text" value={draft.username} required autoCapitalize="none"
                  onChange={(event) => setDraft({ ...draft, username: event.target.value })}
                />
              </label>
              <label className="field" style={{ flex: "1 1 220px" }}>
                <span>Email</span>
                <input
                  type="text" value={draft.email}
                  onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                />
              </label>
              <label className="field" style={{ flex: "1 1 180px" }}>
                <span>Display name</span>
                <input
                  type="text" value={draft.display_name}
                  onChange={(event) => setDraft({ ...draft, display_name: event.target.value })}
                />
              </label>
              <label className="field" style={{ flex: "0 1 240px" }}>
                <span>Role</span>
                <select
                  value={draft.role}
                  onChange={(event) => setDraft({ ...draft, role: event.target.value })}
                >
                  {roles.map((role) => (
                    <option key={role.name} value={role.name}>{role.label}</option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ flex: "1 1 220px" }}>
                <span>Password</span>
                <input
                  type="password" value={draft.password} autoComplete="new-password"
                  onChange={(event) => setDraft({ ...draft, password: event.target.value })}
                />
                <small>
                  At least 12 characters. Leave empty for an SSO-only account that can
                  only sign in through {meta?.sso.provider ?? "Cerulean"}.
                </small>
              </label>
            </div>
            <div className="actions">
              <button className="primary" type="submit" disabled={busy !== null
                || !draft.username.trim()}>
                {busy === "create" ? "Creating…" : "Create account"}
              </button>
            </div>
          </form>
        </div>
      </section>

      <section className="panel">
        <header>
          <h2>Accounts</h2>
          <span className="faint">
            {admins} active administrator{admins === 1 ? "" : "s"}
          </span>
        </header>
        <div className="body body--flush">
          {users === null ? (
            <div className="empty">Loading accounts…</div>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Username</th>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Sign-in</th>
                    <th>State</th>
                    <th>Last seen</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id}>
                      <td>
                        <strong>{user.username}</strong>
                        {user.email ? <div className="faint">{user.email}</div> : null}
                      </td>
                      <td className="dim">{user.display_name}</td>
                      <td>
                        <select
                          value={user.role}
                          disabled={busy !== null}
                          aria-label={`role for ${user.username}`}
                          onChange={(event) => {
                            const role = event.target.value;
                            void act(`role:${user.id}`, async () => {
                              await api.updateUser(user.id, { role });
                              return `${user.username} is now ${role}.`;
                            });
                          }}
                        >
                          {roles.map((role) => (
                            <option key={role.name} value={role.name}>{role.name}</option>
                          ))}
                        </select>
                        <div className="faint">{user.products.join(" · ") || "no products"}</div>
                      </td>
                      <td>
                        {user.external ? (
                          <span className="pill pill--sso">SSO</span>
                        ) : (
                          <span className="pill pill--local">password</span>
                        )}
                      </td>
                      <td>
                        {user.active
                          ? <span className="pill pill--ok">active</span>
                          : <span className="pill pill--bad">disabled</span>}
                      </td>
                      <td><When value={user.last_login_at} /></td>
                      <td className="tight">
                        <div className="actions">
                          <button
                            className="ghost"
                            disabled={busy !== null}
                            onClick={() => {
                              const next = window.prompt(
                                `New password for ${user.username} (leave empty to make the account SSO-only)`);
                              if (next === null) return;
                              void act(`password:${user.id}`, async () => {
                                await api.updateUser(user.id, { password: next });
                                return next === ""
                                  ? `${user.username} now signs in only through Cerulean.`
                                  : `Password reset for ${user.username}.`;
                              });
                            }}
                          >
                            Reset password
                          </button>
                          <button
                            className="ghost"
                            disabled={busy !== null}
                            onClick={() =>
                              void act(`active:${user.id}`, async () => {
                                await api.updateUser(user.id, { active: !user.active });
                                return `${user.username} is now ${user.active ? "disabled" : "active"}.`;
                              })
                            }
                          >
                            {user.active ? "Disable" : "Enable"}
                          </button>
                          <button
                            className="danger"
                            disabled={busy !== null || user.id === identity?.id}
                            onClick={() => {
                              if (!window.confirm(
                                `Delete ${user.username}? Their sessions are revoked immediately.`)) return;
                              void act(`delete:${user.id}`, async () => {
                                await api.deleteUser(user.id);
                                return `${user.username} was deleted.`;
                              });
                            }}
                          >
                            Delete
                          </button>
                        </div>
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
