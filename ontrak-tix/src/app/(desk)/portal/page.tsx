import { requireActor } from "../../../lib/session";
import { ticketServicesFor } from "../../../lib/db";
import { canReadTicket } from "../../../lib/access-rules";
import { sortForInbox } from "../../../lib/inbox-rules";
import { TicketList } from "../../../components/TicketList";

export const metadata = { title: "My tickets" };

/**
 * The requester portal: the tickets this caller raised.
 *
 * `listTickets` returns the tenant's whole worklist, so the scoping happens
 * here through the same `canReadTicket` rule the server actions use — a
 * requester never sees a colleague's ticket, however the list is fetched.
 */
export default async function PortalPage({ searchParams }: { searchParams: Promise<{ flash?: string }> }) {
  const actor = await requireActor();
  const { flash } = await searchParams;

  const all = await ticketServicesFor().store.listTickets(actor.tenantId);
  const mine = sortForInbox(all.filter((ticket) => canReadTicket(actor, ticket)));

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-ink">My tickets</h1>
          <p className="text-sm text-ink-soft">Everything you have raised, and every reply on it.</p>
        </div>
        <a href="/portal/new" className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white">
          New request
        </a>
      </div>

      {flash ? (
        <p className="rounded-xl2 border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">{flash}</p>
      ) : null}

      <TicketList tickets={mine} basePath="/portal" emptyMessage="You have not raised a ticket yet." />
    </div>
  );
}
