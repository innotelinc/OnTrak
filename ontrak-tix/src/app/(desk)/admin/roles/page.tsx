import { redirect } from "next/navigation";

import { actorHasPermission, permissionsFor, ROLES, type Role } from "../../../../lib/access-rules";
import { roleServicesFor } from "../../../../lib/db";
import { ADMINISTRATION_PERMISSION } from "../../../../lib/role-rules";
import { requireActor } from "../../../../lib/session";
import { archiveRoleAction, assignRoleAction, saveRoleAction } from "../../../actions/roles";

export const metadata = { title: "Roles" };

/**
 * Roles (M6).
 *
 * One screen for the two halves of one question: *what may each role do*, and *who holds which
 * role*. Splitting them would let a role be defined on one page and never be given to anybody —
 * the same mistake the fields and forms screen already avoids.
 *
 * The screen is deliberately honest about four things:
 *
 *  - **a role narrows a built-in role and can never add to it**, so the permission list shows
 *    what the chosen base role *has* and lets a box be unticked, never ticked beyond it;
 *  - **the last administrator cannot be edited away** — the guard's own answer is printed at the
 *    top of the page rather than only appearing as a refusal after a submit;
 *  - **archiving is not deleting**, so the button says what happens to the people who held it;
 *  - **a built-in role is not editable here.** `ADMIN`, `DISPATCHER`, `AGENT` and `REQUESTER` are
 *    what the rest of the product (tenant isolation, API scopes, SCIM) already means by those
 *    words; a role written here is a *new* name that narrows one of them.
 */

const inputClass = "w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink";
const labelClass = "block text-xs font-semibold tracking-wide text-ink-faint uppercase";

type Search = Promise<{ edit?: string; base?: string; flash?: string; error?: string }>;

/**
 * The base role being authored against.
 *
 * A link rather than a radio, because the permission list has to be rendered for the base role
 * that is actually chosen and this product's screens are deliberately server-rendered with no
 * client JavaScript: state travels in the URL, so the list an author ticks is the list the
 * server will honour. Posting a base role the page did not render for would be a checklist that
 * quietly drops what was ticked.
 */
function draftBaseRole(query: { base?: string; edit?: string }, saved: Role | null): Role {
  const requested = query.base as Role | undefined;
  if (requested && ROLES.includes(requested)) return requested;
  if (saved && ROLES.includes(saved)) return saved;
  // The least powerful base role that is still staff, because defaulting to `ADMIN` would put a
  // permission nobody asked for in front of an author.
  return "AGENT";
}

const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrator",
  DISPATCHER: "Dispatcher",
  AGENT: "Agent",
  REQUESTER: "Requester",
};

export default async function RolesPage({ searchParams }: { searchParams: Search }) {
  const actor = await requireActor();
  if (!actorHasPermission(actor, "user:manage")) redirect("/?error=You%20cannot%20manage%20roles.");

  const query = await searchParams;
  const overview = await roleServicesFor().overview(actor);
  if (!overview.ok) redirect(`/?error=${encodeURIComponent(overview.error)}`);

  const { roles, members, catalogue, administered } = overview.value;
  const editing = query.edit ? (roles.find((role) => role.id === query.edit) ?? null) : null;
  const draftBase = draftBaseRole(query, editing?.baseRole ?? null);
  const baseLink = (role: Role) =>
    `/admin/roles?base=${role}${editing ? `&edit=${editing.id}` : ""}`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Roles</h1>
        <p className="text-sm text-ink-soft">
          Give this desk its own roles. A role is based on one of the four built-in roles and keeps
          a subset of that role’s permissions — it can take work away from somebody, never add it.
        </p>
      </div>

      {query.flash ? (
        <p className="rounded-xl2 border border-teal/30 bg-teal/10 px-3 py-2 text-sm text-ink-soft">{query.flash}</p>
      ) : null}
      {query.error ? (
        <p className="rounded-xl2 border border-pink/30 bg-pink/10 px-3 py-2 text-sm text-ink-soft">{query.error}</p>
      ) : null}

      {!administered ? (
        <p className="rounded-xl2 border border-amber/30 bg-amber/10 px-3 py-2 text-sm text-ink-soft">
          Nobody on this desk currently holds “Administer the desk”. No change here can take it away,
          because there is nothing left to keep.
        </p>
      ) : null}

      {/* ---------------------------------------------------------------- the roles */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-wide text-ink-faint uppercase">This desk’s roles</h2>
        {roles.length === 0 ? (
          <p className="text-sm text-ink-soft">
            No roles yet. Everybody is simply the built-in role on their account.
          </p>
        ) : (
          <ul className="space-y-2">
            {roles.map((role) => (
              <li
                key={role.id}
                className={`rounded-xl2 border border-line bg-surface px-3 py-2 ${role.archivedAt ? "opacity-60" : ""}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-ink-faint">{role.key}</span>
                  <span className="text-sm font-semibold text-ink">{role.name}</span>
                  <span className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-soft">
                    {ROLE_LABELS[role.baseRole] ?? role.baseRole}
                  </span>
                  {role.archivedAt ? (
                    <span className="rounded-full border border-amber/40 px-2 py-0.5 text-xs text-amber">Archived</span>
                  ) : null}
                  <span className="ml-auto text-xs text-ink-faint">
                    {role.holders} {role.holders === 1 ? "person" : "people"}
                  </span>
                </div>
                <p className="mt-1 text-sm text-ink-soft">{role.summary}</p>
                {role.description ? <p className="mt-1 text-xs text-ink-faint">{role.description}</p> : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  <a className="text-xs font-semibold text-brand hover:underline" href={`/admin/roles?edit=${role.id}`}>
                    Edit
                  </a>
                  {!role.archivedAt ? (
                    <form action={archiveRoleAction}>
                      <input type="hidden" name="roleId" value={role.id} />
                      <button type="submit" className="text-xs font-semibold text-ink-faint hover:text-ink">
                        Archive
                      </button>
                    </form>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------------------------------------------------------- define one */}
      <section className="rounded-xl2 border border-line bg-surface px-4 py-4">
        <h2 className="text-sm font-semibold tracking-wide text-ink-faint uppercase">
          {editing ? `Edit “${editing.name}”` : "Define a role"}
        </h2>
        {editing?.archivedAt ? (
          <p className="mt-2 text-sm text-ink-soft">
            This role is archived, so nobody is judged by it. Editing it does not bring it back
            <span className="text-ink-faint"> — a person has to be given it again.</span>
          </p>
        ) : null}

        <form action={saveRoleAction} className="mt-3 space-y-3">
          {editing ? <input type="hidden" name="roleId" value={editing.id} /> : null}

          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className={labelClass}>Name</span>
              <input name="name" className={inputClass} defaultValue={editing?.name ?? ""} required maxLength={60} />
            </label>
            <label className="space-y-1">
              <span className={labelClass}>Key</span>
              {editing ? (
                <>
                  <input type="hidden" name="key" value={editing.key} />
                  <p className="rounded-xl2 border border-line bg-surface-muted px-3 py-2 font-mono text-sm text-ink-soft">
                    {editing.key}
                  </p>
                  <span className="text-xs text-ink-faint">
                    Fixed: the audit trail names this role by its key.
                  </span>
                </>
              ) : (
                <input name="key" className={inputClass} placeholder="senior-agent" maxLength={40} />
              )}
            </label>
          </div>

          <label className="space-y-1 block">
            <span className={labelClass}>Description</span>
            <input
              name="description"
              className={inputClass}
              defaultValue={editing?.description ?? ""}
              maxLength={240}
              placeholder="What this role is for, in the desk’s own words."
            />
          </label>

          <fieldset className="space-y-2">
            <legend className={labelClass}>Based on</legend>
            <div className="flex flex-wrap items-center gap-2">
              {ROLES.map((role) => (
                <a
                  key={role}
                  href={baseLink(role)}
                  className={`rounded-xl2 border px-3 py-1 text-sm ${draftBase === role ? "border-brand/40 bg-brand/10 font-semibold text-brand" : "border-line text-ink-soft"}`}
                >
                  {ROLE_LABELS[role]}
                </a>
              ))}
            </div>
            {/* The chosen base role travels as a value, because the link above only decides
                which list is rendered. */}
            <input type="hidden" name="baseRole" value={draftBase} />
            <p className="text-xs text-ink-faint">
              A role can only keep permissions its base role already has, so the list below is
              what {ROLE_LABELS[draftBase]} may do. Changing the base role redraws the list.
            </p>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className={labelClass}>Keeps</legend>
            <div className="grid gap-2 md:grid-cols-2">
              {catalogue.map((entry) => {
                const held = entry.inBaseRole?.[draftBase] ?? false;
                // A kept permission is one the saved role holds, or — for a role being authored
                // — everything the base role has. Narrowing is the edit; keeping is the default.
                const kept = editing ? editing.permissions.includes(entry.permission) : held;
                return (
                  <label key={entry.permission} className="flex items-start gap-2 rounded-xl2 border border-line px-3 py-2">
                    <input type="checkbox" name="permissions" value={entry.permission} defaultChecked={kept && held} />
                    <span>
                      <span className="block text-sm text-ink">{entry.label}</span>
                      <span className="block text-xs text-ink-faint">{entry.hint}</span>
                      {held ? null : (
                        <span className="block text-xs text-ink-faint">
                          {ROLE_LABELS[draftBase]} does not hold this, so ticking it changes nothing.
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              className="rounded-xl2 border border-brand/40 bg-brand/10 px-3 py-2 text-sm font-semibold text-brand"
            >
              {editing ? "Save role" : "Create role"}
            </button>
            {editing ? (
              <a className="text-xs font-semibold text-ink-faint hover:text-ink" href="/admin/roles">
                Cancel
              </a>
            ) : null}
          </div>
        </form>
      </section>

      {/* ---------------------------------------------------------------- who holds what */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-wide text-ink-faint uppercase">Who holds what</h2>
        <p className="text-sm text-ink-soft">
          A person’s built-in role is what they are; a role of this desk’s own narrows it. Nothing
          here can take away the last way to administer this desk.
        </p>
        <ul className="space-y-2">
          {members.map((member) => (
            <li key={member.id} className="rounded-xl2 border border-line bg-surface px-3 py-2">
              <form action={assignRoleAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="userId" value={member.id} />
                <span className="text-sm text-ink">{member.displayName}</span>
                <span className="font-mono text-xs text-ink-faint">{member.email}</span>
                <span className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-soft">
                  {ROLE_LABELS[member.role]}
                </span>
                {!member.active ? <span className="text-xs text-amber">Deactivated</span> : null}
                <select name="roleId" defaultValue={member.tenantRoleId ?? ""} className="ml-auto rounded-xl2 border border-line bg-surface px-2 py-1 text-sm text-ink">
                  <option value="">— built-in role only —</option>
                  {roles
                    .filter((role) => !role.archivedAt)
                    .map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                </select>
                <button
                  type="submit"
                  className="rounded-xl2 border border-line px-3 py-1 text-xs font-semibold text-ink-soft"
                >
                  Apply
                </button>
              </form>
              {member.roleName ? (
                <p className="mt-1 text-xs text-ink-faint">Currently narrowed by “{member.roleName}”.</p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs text-ink-faint">
        The built-in roles are unchanged: {ROLES.map((role) => `${ROLE_LABELS[role]} (${permissionsFor(role).length})`).join(", ")}.
        Only a role that keeps “{catalogue.find((entry) => entry.permission === ADMINISTRATION_PERMISSION)?.label}”
        can open this page.
      </p>
    </div>
  );
}
