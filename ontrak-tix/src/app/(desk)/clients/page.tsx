import { redirect } from "next/navigation";

import { requireActor } from "../../../lib/session";
import { hasPermission } from "../../../lib/access-rules";
import { clientServicesFor, prisma, slaPolicyStoreFor } from "../../../lib/db";
import { resolveSlaPolicy } from "../../../lib/sla-rules";
import type { TicketPriority } from "../../../lib/ticket-rules";
import {
  addContactAction,
  assignClientAction,
  createClientAction,
  endActAsAction,
  startActAsAction,
  unassignClientAction,
} from "../../actions/clients";

export const metadata = { title: "Clients" };

const inputClass = "mt-1 rounded-xl2 border border-line bg-surface px-3 py-1.5 text-sm text-ink";

/** The priorities a promise is stated at, so the ladder is visible at a glance. */
const SHOWN_PRIORITIES: readonly TicketPriority[] = ["URGENT", "HIGH", "NORMAL"];

/**
 * The multi-client console (M4): who the desk serves, who at the desk serves
 * them, and the promise each client has — with the scope that decides what a
 * reader sees, said out loud rather than left implicit.
 */
export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const actor = await requireActor();
  if (!hasPermission(actor.role, "ticket:read:any")) redirect("/portal");

  const { flash, error } = await searchParams;
  const service = clientServicesFor();
  const canManage = hasPermission(actor.role, "client:manage");

  const [overview, scope, policies, active, staff] = await Promise.all([
    service.list(actor),
    service.scope(actor),
    slaPolicyStoreFor().listForTenant(actor.tenantId),
    service.activeActAs(actor),
    canManage
      ? prisma.user.findMany({
          where: { tenantId: actor.tenantId, active: true, role: { in: ["ADMIN", "DISPATCHER", "AGENT"] } },
          select: { id: true, displayName: true, role: true },
          orderBy: { displayName: "asc" },
        })
      : Promise.resolve([]),
  ]);

  const clients = overview.ok ? overview.value : [];
  const staffNames = new Map(staff.map((person) => [person.id, person.displayName]));

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Clients</h1>
        <p className="text-sm text-ink-soft">
          {clients.length === 0
            ? "No clients yet."
            : `${clients.length} client${clients.length === 1 ? "" : "s"} in your scope — ${scope.because}.`}
        </p>
        {scope.kind === "assigned" ? (
          <p className="text-xs text-ink-faint">
            Work with no client recorded stays visible to everybody, because it belongs to the desk rather than to a client.
          </p>
        ) : null}
      </div>

      {flash ? (
        <p className="rounded-xl2 border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">{flash}</p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
          {error}
        </p>
      ) : null}

      {active ? (
        <section className="space-y-2 rounded-xl2 border border-amber/40 bg-amber/10 p-4">
          <h2 className="text-sm font-semibold text-amber">
            Acting as {clients.find((entry) => entry.client.id === active.clientId)?.client.name ?? active.clientId}
          </h2>
          <p className="text-xs text-ink-soft">
            Since {active.startedAt}, until {active.expiresAt} — because: {active.reason}. This window is on the record twice:
            as a row, and as an audit event with the reason.
          </p>
          <form action={endActAsAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="sessionId" value={active.id} />
            <label className="text-xs text-ink-soft">
              Why it is ending (optional)
              <input name="endReason" placeholder="done looking" className={`block ${inputClass}`} />
            </label>
            <button type="submit" className="rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-white">
              Stop acting as the client
            </button>
          </form>
        </section>
      ) : null}

      {clients.length > 0 ? (
        <ul className="space-y-3">
          {clients.map(({ client, contacts, assignments }) => (
            <li key={client.id} className="space-y-3 rounded-xl2 border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold text-ink">{client.name}</h2>
                <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
                  {contacts.length} contact{contacts.length === 1 ? "" : "s"}
                </span>
                <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
                  {assignments.length} assigned
                </span>
                <span className="ml-auto text-[11px] text-ink-faint">added {client.createdAt.slice(0, 10)}</span>
              </div>

              {/* The promise, and which rung of the ladder answered. */}
              <ul className="space-y-0.5">
                {SHOWN_PRIORITIES.map((priority) => {
                  const resolution = resolveSlaPolicy({ policies, priority, clientId: client.id });
                  return (
                    <li key={priority} className="text-xs text-ink-soft">
                      <span className="font-semibold text-ink">{priority}</span>{" "}
                      {resolution.policy ? (
                        <>
                          {resolution.policy.responseMinutes}m to respond · {resolution.policy.resolutionMinutes}m to resolve{" "}
                          <span className="text-ink-faint">
                            (because {resolution.because}
                            {resolution.policy.name ? `: ${resolution.policy.name}` : ""})
                          </span>
                        </>
                      ) : (
                        <span className="text-ink-faint">no policy covers this priority</span>
                      )}
                    </li>
                  );
                })}
              </ul>

              {contacts.length > 0 ? (
                <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line">
                  {contacts.map((contact) => (
                    <li key={contact.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
                      <span className="font-medium text-ink">{contact.name}</span>
                      <span className="text-ink-soft">{contact.email}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-ink-faint">No contact at this client yet — nothing to reply to.</p>
              )}

              {assignments.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-ink-faint">Served by:</span>
                  {assignments.map((assignment) => (
                    <span
                      key={assignment.id}
                      className="inline-flex items-center gap-2 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand"
                    >
                      {staffNames.get(assignment.userId) ?? assignment.userId}
                      {canManage ? (
                        <form action={unassignClientAction}>
                          <input type="hidden" name="clientId" value={client.id} />
                          <input type="hidden" name="userId" value={assignment.userId} />
                          <button type="submit" className="text-pink hover:underline">
                            remove
                          </button>
                        </form>
                      ) : null}
                    </span>
                  ))}
                </div>
              ) : null}

              {canManage ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <form action={addContactAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="clientId" value={client.id} />
                    <label className="text-xs text-ink-soft">
                      Contact name
                      <input name="name" required className={`block ${inputClass}`} />
                    </label>
                    <label className="text-xs text-ink-soft">
                      Email
                      <input name="email" type="email" required className={`block ${inputClass}`} />
                    </label>
                    <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
                      Add contact
                    </button>
                  </form>

                  <form action={assignClientAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="clientId" value={client.id} />
                    <label className="text-xs text-ink-soft">
                      Assign someone
                      <select name="userId" required defaultValue="" className={`block ${inputClass}`}>
                        <option value="">— choose a person —</option>
                        {staff.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.displayName} ({person.role})
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
                      Assign
                    </button>
                  </form>

                  <form action={startActAsAction} className="flex flex-wrap items-end gap-2 sm:col-span-2">
                    <input type="hidden" name="clientId" value={client.id} />
                    <label className="text-xs text-ink-soft">
                      Reason to act as this client
                      <input name="reason" required placeholder="e.g. reproduce the ticket they are complaining about" className={`block ${inputClass}`} />
                    </label>
                    <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
                      Act as client
                    </button>
                  </form>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {canManage ? (
        <form action={createClientAction} className="flex flex-wrap items-end gap-2 rounded-xl2 border border-line bg-surface p-4">
          <label className="text-sm font-medium text-ink">
            New client
            <input name="name" required placeholder="e.g. Northwind Logistics" className={`block ${inputClass}`} />
          </label>
          <button type="submit" className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white">
            Add client
          </button>
          <p className="w-full text-xs text-ink-faint">
            A client's own policies are picked up by the SLA ladder ahead of the queue's and the desk's, and being assigned to a
            client is what puts its work in scope.
          </p>
        </form>
      ) : (
        <p className="rounded-xl2 border border-line bg-surface p-4 text-sm text-ink-soft">
          You can see the clients in your scope but not change them.
        </p>
      )}
    </div>
  );
}
