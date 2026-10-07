import { redirect } from "next/navigation";

import { requireActor } from "../../../lib/session";
import {
  actorHasPermission,
  canAssignTicket,
  canDeleteTicket,
  canReplyToTicket,
  canUpdateTicket,
} from "../../../lib/access-rules";
import { assigneeOptions, ASSIGNEE_ROLES } from "../../../lib/assignee-rules";
import {
  prisma,
  clientServicesFor,
  ticketServicesFor,
  slaPolicyStoreFor,
  linkServicesFor,
  savedViewServicesFor,
} from "../../../lib/db";
import { scopeByClient } from "../../../lib/client-rules";
import {
  assignAction,
  bulkAction,
  deleteTicketAction,
  deleteViewAction,
  replyAction,
  saveViewAction,
  setStatusAction,
} from "../../actions/tickets";
import { buildInboxView, parseInboxFilter, selectedTicket, type InboxSearchParams } from "../../../lib/inbox-view";
import { slaFlagsByTicket, slaStatusFor } from "../../../lib/report-rules";
import { AgentInbox } from "../../../components/AgentInbox";
import { SavedViews } from "../../../components/SavedViews";
import { TicketDetail, type TicketActions } from "../../../components/TicketDetail";

export const metadata = { title: "Inbox" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The agent inbox: the filtered worklist on the left, the selected ticket on the right. */
export default async function InboxPage({ searchParams }: { searchParams: Promise<InboxSearchParams> }) {
  const actor = await requireActor();
  // The worklist is tenant-wide, so it is a staff view; a requester belongs in
  // the portal, which scopes every ticket through `canReadTicket`.
  if (!actorHasPermission(actor, "ticket:read:any")) redirect("/portal");

  const params = await searchParams;
  const clients = clientServicesFor();
  const [everything, policies, views, scope, staff] = await Promise.all([
    ticketServicesFor().store.listTickets(actor.tenantId),
    slaPolicyStoreFor().listForTenant(actor.tenantId),
    savedViewServicesFor().list(actor),
    clients.scope(actor),
    // The desk's people, once for the page: they fill the assignment picker in the
    // selection panel and the bulk toolbar alike, so one read answers both.
    prisma.user.findMany({
      where: { tenantId: actor.tenantId, active: true, role: { in: [...ASSIGNEE_ROLES] } },
      select: { id: true, displayName: true, email: true },
      orderBy: { displayName: "asc" },
    }),
  ]);
  const assignees = assigneeOptions(staff);
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

  // The actions the selected ticket offers. This is the pair view's whole point: an
  // agent working the list should be able to reply, resolve, reassign or delete the
  // ticket they just clicked without opening its page — and the controls are gated by
  // the same rules the ticket page uses. The service re-checks every one of them
  // server-side, so what is rendered here is a courtesy, not the control.
  const actions: TicketActions = {};
  if (selected) {
    if (canReplyToTicket(actor, selected)) actions.reply = replyAction;
    if (canUpdateTicket(actor, selected)) actions.setStatus = setStatusAction;
    if (canAssignTicket(actor, selected)) actions.assign = assignAction;
    if (canDeleteTicket(actor, selected)) actions.delete = deleteTicketAction;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
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
        <a
          href="/inbox/new"
          className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-ink hover:opacity-95"
        >
          New ticket
        </a>
      </div>

      {flash ? (
        <p className="rounded-xl2 border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-ok">{flash}</p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl2 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          {error}
        </p>
      ) : null}

      <SavedViews
        views={views}
        activeFilter={filter}
        actorId={actor.id}
        canShare={actorHasPermission(actor, "ticket:update")}
        saveAction={saveViewAction}
        deleteAction={deleteViewAction}
      />

      {/* The worklist is the page; the ticket opens beside it. Wide screens get the
          pair side by side, and anything narrower stacks them so neither is squeezed
          into an unreadable column. */}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <AgentInbox
          all={all}
          filter={filter}
          basePath="/inbox"
          selectedId={selected?.id ?? null}
          sla={sla}
          assignees={assignees}
          bulk={actorHasPermission(actor, "ticket:update") ? { action: bulkAction } : undefined}
        />
        {selected ? (
          <TicketDetail
            ticket={selected}
            actions={actions}
            sla={slaStatusFor(selected, policies, now)}
            links={links}
            assignees={assignees}
          />
        ) : (
          <p className="ot-note self-start">
            Select a ticket to see its conversation. The list on the left is every ticket in your scope, most urgent
            first.
          </p>
        )}
      </div>
    </div>
  );
}
