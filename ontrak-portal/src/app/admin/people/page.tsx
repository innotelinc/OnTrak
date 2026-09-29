import { redirect } from "next/navigation";

import { setActive, setRole } from "./actions";

import { portalConfig } from "@/lib/config";
import { ROLES } from "@/lib/portal-rules";
import { readSession } from "@/lib/session";
import { listSyncUsers } from "@/lib/sync-client";

/**
 * People and roles.
 *
 * WHERE A ROLE COMES FROM, AND WHY THIS PAGE DOES NOT PRETEND OTHERWISE
 * --------------------------------------------------------------------
 * There are two sources of a role in this family, and conflating them is how an
 * administrator ends up changing something that has no effect:
 *
 *   1. **The directory** — the group somebody is in at {provider}. This is what
 *      decides the role on every sign-in, in every product, and it is changed in
 *      the provider, not here. The mapping is listed below so there is no guessing
 *      about which group means what.
 *   2. **OnTrak Sync's account table** — the family's *local* accounts. This is
 *      what a person signs in with when the directory is not the way in, what the
 *      Sync API authenticates, and what the dashboards read. It is editable here.
 *
 * So: this page changes (2), and shows (1). An account that exists only because
 * somebody signed in through the directory will have its role overwritten by the
 * next sign-in — the page says so on the row rather than letting an administrator
 * discover it later.
 */

export const dynamic = "force-dynamic";

export default async function PeoplePage({ searchParams }: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const session = await readSession();
  if (!session) redirect("/login");

  const config = portalConfig();
  const params = await searchParams;

  if (session.role !== "ADMIN") {
    return (
      <div className="panel">
        <header><h2>People and roles</h2></header>
        <div className="body">
          <p className="dim" style={{ margin: 0 }}>
            This page is for administrators. Your role is <strong>{session.role}</strong> —
            ask an administrator in {config.providerName} to change it.
          </p>
        </div>
      </div>
    );
  }

  const { users, reason } = await listSyncUsers();

  return (
    <>
      <div className="head">
        <div>
          <h1>People and roles</h1>
          <p>
            The account table OnTrak Sync holds for the family. Roles that arrive with
            a {config.providerName} sign-in come from the directory groups below and are
            rewritten on every sign-in; anything else is set here.
          </p>
        </div>
        <div className="who">
          <a className="chip" href="/">← Back to the dashboard</a>
        </div>
      </div>

      {params.error ? <div className="note note--bad toast" role="alert">{params.error}</div> : null}
      {params.notice ? <div className="note note--ok toast" role="status">{params.notice}</div> : null}
      {reason ? <div className="note note--warn" role="status">{reason}</div> : null}

      <section className="panel people">
        <header>
          <h2>Accounts</h2>
          <span className="faint">{users.length} on record</span>
        </header>
      {users.length === 0 ? (
        <div className="body">
          <p className="dim" style={{ margin: 0 }}>
            Nothing to list. {reason ? "See the note above." : "The account table is empty."}
          </p>
        </div>
      ) : (
          <div className="body" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>E-mail</th>
                  <th>Role</th>
                  <th>State</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  // Matched on the directory address, which is the one fact the
                  // session and the account table both hold: a display name can be
                  // changed by the person it belongs to.
                  const isSelf = Boolean(session.email) &&
                    session.email.toLowerCase() === (user.email || "").toLowerCase();
                  return (
                    <tr key={user.id}>
                      <td>
                        <span className="who-cell">
                          <strong>{user.display_name || user.username}</strong>
                          <span className="mono">{user.username}</span>
                        </span>
                      </td>
                      <td className="dim">{user.email || "—"}</td>
                      <td className="role">
                        <form action={setRole} className="row-actions">
                          <input type="hidden" name="id" value={user.id} />
                          <input type="hidden" name="username" value={user.username} />
                          <input type="hidden" name="email" value={user.email} />
                          <select name="role" defaultValue={user.role} aria-label={`Role for ${user.username}`}
                                  disabled={isSelf}>
                            {ROLES.map((role) => (
                              <option key={role} value={role}>{role}</option>
                            ))}
                          </select>
                          <button type="submit" disabled={isSelf}
                                  title={isSelf ? "Ask another administrator to change your own role" : "Save the role"}>
                            Save
                          </button>
                        </form>
                      </td>
                      <td>
                        {user.active
                          ? <span className="status status--up"><span className="status__dot" />active</span>
                          : <span className="status status--unknown"><span className="status__dot" />switched off</span>}
                      </td>
                      <td>
                        <form action={setActive} className="row-actions">
                          <input type="hidden" name="id" value={user.id} />
                          <input type="hidden" name="username" value={user.username} />
                          <input type="hidden" name="email" value={user.email} />
                          <input type="hidden" name="active" value={user.active ? "false" : "true"} />
                          <button type="submit" className="ghost" disabled={isSelf}>
                            {user.active ? "Switch off" : "Switch on"}
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <header>
          <h2>Where a {config.providerName} role comes from</h2>
          <span className="faint">read-only — changed in {config.providerName}</span>
        </header>
        <div className="body" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>Group</th><th>Role</th><th>Sees</th></tr>
            </thead>
            <tbody>
              {Object.entries(config.roleMappings).map(([group, role]) => (
                <tr key={group}>
                  <td className="mono">{group}</td>
                  <td><span className="chip chip--role">{role}</span></td>
                  <td className="dim">
                    {role === "ADMIN" ? "every product, and this page"
                      : role === "SYSADMIN" ? "OnTrak Sync, the desk, Sentinel"
                      : role === "ANALYST" ? "Sentinel and the desk"
                      : role === "TECHNICIAN" ? "the desk"
                      : "the training range"}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="mono">{config.providerName} (no mapped group)</td>
                <td><span className="chip">{config.defaultRole}</span></td>
                <td className="dim">the default — the least privileged role</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="body">
          <p className="dim" style={{ margin: 0 }}>
            Add somebody to a group in {config.providerName} and their role follows at
            their next sign-in — nothing is copied into a product, which is why there is
            no second place to update.
          </p>
        </div>
      </section>
    </>
  );
}
