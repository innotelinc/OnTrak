import Link from "next/link";
import { notFound } from "next/navigation";

import { requireActor } from "../../../../lib/session";
import { ticketServicesFor, csatServicesFor, attachmentServicesFor, slaPolicyStoreFor } from "../../../../lib/db";
import { slaStatusFor } from "../../../../lib/report-rules";
import { canReadTicket, canReplyToTicket } from "../../../../lib/access-rules";
import { TicketDetail, type TicketActions } from "../../../../components/TicketDetail";
import { AttachmentList } from "../../../../components/AttachmentList";
import { SatisfactionSurvey } from "../../../../components/SatisfactionSurvey";
import { replyAction, attachAction, submitCsatAction } from "../../../actions/tickets";

export const metadata = { title: "Ticket" };

/**
 * One of the caller's own tickets.
 *
 * The read is scoped with `canReadTicket` and only a reply is offered; the
 * detail component hides nothing else because there is nothing else to hide.
 */
export default async function PortalTicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const actor = await requireActor();
  const { id } = await params;
  const { flash, error } = await searchParams;

  const ticket = await ticketServicesFor().store.findTicket(actor.tenantId, id);
  if (!ticket || !canReadTicket(actor, ticket)) notFound();

  const actions: TicketActions = {};
  const mayReply = canReplyToTicket(actor, ticket);
  if (mayReply) actions.reply = replyAction;

  const [attachments, survey, policies] = await Promise.all([
    attachmentServicesFor().list(actor, ticket),
    csatServicesFor().surveyFor(actor, ticket),
    slaPolicyStoreFor().listForTenant(actor.tenantId),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/portal" className="text-sm font-semibold text-brand hover:underline">
        ← My tickets
      </Link>
      {flash ? (
        <p className="rounded-xl2 border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">{flash}</p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
          {error}
        </p>
      ) : null}
      <TicketDetail ticket={ticket} actions={actions} sla={slaStatusFor(ticket, policies, new Date().toISOString())} />
      <AttachmentList attachments={attachments} ticketId={ticket.id} action={mayReply ? attachAction : undefined} />
      {survey ? (
        <SatisfactionSurvey survey={survey} action={mayReply && survey.respondedAt === null ? submitCsatAction : undefined} now={new Date().toISOString()} />
      ) : null}
    </div>
  );
}
