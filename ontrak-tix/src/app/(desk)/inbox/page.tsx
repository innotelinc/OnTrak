import { redirect } from "next/navigation";

import { requireActor } from "../../../lib/session";
import { hasPermission } from "../../../lib/access-rules";
import {
  clientServicesFor,
  ticketServicesFor,
  slaPolicyStoreFor,
  linkServicesFor,
  savedViewServicesFor,
} from "../../../lib/db";
import { scopeByClient } from "../../../lib/client-rules";
import { bulkAction, deleteViewAction, saveViewAction } from "../../actions/tickets";
import { buildInboxView, parseInboxFilter, selectedTicket, type InboxSearchParams } from "../../../lib/inbox-view";
import { slaFlagsByTicket, slaStatusFor } from "../../../lib/report-rules";
import { AgentInbox } from "../../../components/AgentInbox";
import { SavedViews } from "../../../components/SavedViews";
import { TicketDetail } from "../../../components/TicketDetail";

export const metadata = { title: "Inbox" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The agent inbox: the filtered worklist on the left, the selected ticket on the right. */
export default async function InboxPage({ searchParams }: { searchParams: Promise<InboxSearchParams> }) {
  const actor = await requireActor();
  // The worklist is tenant-wide, so it is a staff view; a requester belongs in
  // the portal, which scopes every ticket through `canReadTicket`.
  if (!hasPermission(actor.role, "ticket:read:any")) redirect("/portal");

  const params = await searchParams;
  const clients = clientServicesFor();
  const [everything, policies, views, scope] = await Promise.all([
    ticketServicesFor().store.listTickets(actor.tenantId),
    slaPolicyStoreFor().listForTenant(actor.tenantId),
    savedViewServicesFor().list(actor),
    clients.scope(actor),
  ]);
  // One desk serving many clients means the worklist is scoped before it is
  // rendered: an agent sees their clients' work and the work that names no
  // client, never a third client's. Filtering here (rather than in the list
  // component) keeps every rung below — SLA flags, saved views, counts — computed
  // over exactly the rows the reader may see. When the scope is the whole desk,
  // this is the identity filter and nothing changes.
  const all = scopeByClient(scope, everything);
  const filter = parseInboxFilter(params);
  const now = new Date().toISOString();
  const sla = slaFlagsByTicket(all, policies, now);
  const view = buildInboxView(all, filter, sla);
  const selected = selectedTicket(view, first(params.ticket));
  const links = selected ? await linkServicesFor().linkedTickets(actor.tenantId, selected.id) : [];

  const flash = first(params.flash);
  const error = first(params.error);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Inbox</h1>
        <p className="text-sm text-ink-soft">
          Open work first, most urgent first — resolved tickets never bury live ones.
        </p>
        {scope.kind === "assigned" ? (
          <p className="text-sm text-ink-soft">
            Scoped to your clients: this desk {scope.because}. Work that names no client stays visible.
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

      <SavedViews
        views={views}
        activeFilter={filter}
        actorId={actor.id}
        canShare={hasPermission(actor.role, "ticket:update")}
        saveAction={saveViewAction}
        deleteAction={deleteViewAction}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <AgentInbox
          all={all}
          filter={filter}
          basePath="/inbox"
          selectedId={selected?.id ?? null}
          sla={sla}
          bulk={hasPermission(actor.role, "ticket:update") ? { action: bulkAction } : undefined}
        />
        {selected ? (
          <TicketDetail ticket={selected} sla={slaStatusFor(selected, policies, now)} links={links} />
        ) : (
          <p className="rounded-xl2 border border-line bg-surface p-5 text-sm text-ink-soft">
            Select a ticket to see its conversation.
          </p>
        )}
      </div>
    </div>
  );
}
