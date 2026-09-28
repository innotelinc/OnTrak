import { notFound, redirect } from "next/navigation";

import { requireActor } from "../../../../lib/session";
import { canAssignTicket, canReplyToTicket, canUpdateTicket, hasPermission } from "../../../../lib/access-rules";
import { ticketServicesFor, slaPolicyStoreFor, cannedServicesFor, linkServicesFor, timeServicesFor } from "../../../../lib/db";
import { slaStatusFor } from "../../../../lib/report-rules";
import { TicketDetail, type TicketActions, type TicketOption } from "../../../../components/TicketDetail";
import { TicketTime } from "../../../../components/TicketTime";
import { assignAction, linkAction, mergeAction, replyAction, setStatusAction } from "../../../actions/tickets";
import { logTimeAction, removeTimeAction } from "../../../actions/time";

export const metadata = { title: "Ticket" };

/**
 * One ticket. The actions offered in the UI mirror the access rules, but the
 * rules are re-checked server-side in the service — hiding a form is a courtesy,
 * not a control.
 */
export default async function TicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const actor = await requireActor();
  // Staff-only: a requester's own ticket lives in the portal, scoped by
  // `canReadTicket`, so this desk view must never expose the tenant worklist.
  if (!hasPermission(actor.role, "ticket:read:any")) redirect("/portal");
  const { id } = await params;
  const { flash, error } = await searchParams;

  const [ticket, policies, all, canned, time] = await Promise.all([
    ticketServicesFor().store.findTicket(actor.tenantId, id),
    slaPolicyStoreFor().listForTenant(actor.tenantId),
    ticketServicesFor().store.listTickets(actor.tenantId),
    cannedServicesFor().list(actor.tenantId),
    timeServicesFor().entries(actor, { ticketId: id }),
  ]);
  if (!ticket) notFound();
  const sla = slaStatusFor(ticket, policies, new Date().toISOString());
  const links = await linkServicesFor().linkedTickets(actor.tenantId, ticket.id);
  const linkOptions: TicketOption[] = all
    .filter((candidate) => candidate.id !== ticket.id)
    .map((candidate) => ({ id: candidate.id, ref: candidate.ref, subject: candidate.subject }))
    .sort((a, b) => a.ref.localeCompare(b.ref));

  const actions: TicketActions = {};
  if (canReplyToTicket(actor, ticket)) actions.reply = replyAction;
  if (canUpdateTicket(actor, ticket)) actions.setStatus = setStatusAction;
  if (canAssignTicket(actor, ticket)) actions.assign = assignAction;
  if (canUpdateTicket(actor, ticket)) {
    actions.link = linkAction;
    actions.merge = mergeAction;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {flash ? (
        <p className="rounded-xl2 border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">{flash}</p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
          {error}
        </p>
      ) : null}
      <TicketDetail ticket={ticket} actions={actions} sla={sla} canned={canned} links={links} linkOptions={linkOptions} />
      <TicketTime
        ticketId={ticket.id}
        entries={time.ok ? time.value : []}
        today={new Date().toISOString().slice(0, 10)}
        canLog={canUpdateTicket(actor, ticket)}
        {...(canUpdateTicket(actor, ticket) ? { logAction: logTimeAction, removeAction: removeTimeAction } : {})}
      />
    </div>
  );
}
