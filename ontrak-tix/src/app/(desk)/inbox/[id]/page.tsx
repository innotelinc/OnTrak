import { notFound, redirect } from "next/navigation";

import { requireActor } from "../../../../lib/session";
import {
  canAssignTicket,
  canDeleteTicket,
  canReplyToTicket,
  canUpdateTicket,
  actorHasPermission,
} from "../../../../lib/access-rules";
import { assigneeOptions, ASSIGNEE_ROLES } from "../../../../lib/assignee-rules";
import {
  prisma,
  ticketServicesFor,
  slaPolicyStoreFor,
  cannedServicesFor,
  clientServicesFor,
  linkServicesFor,
  macroServicesFor,
  timeServicesFor,
  assistServicesFor,
} from "../../../../lib/db";
import type { AssistResult } from "../../../../lib/assist-rules";
import type { AssistDecisionRecord } from "../../../../lib/assist-service";
import { scopeByClient, scopeRefusal } from "../../../../lib/client-rules";
import { slaStatusFor } from "../../../../lib/report-rules";
import {
  TicketDetail,
  type MacroChoice,
  type TicketActions,
  type TicketOption,
} from "../../../../components/TicketDetail";
import { TicketTime } from "../../../../components/TicketTime";
import {
  assignAction,
  deleteTicketAction,
  linkAction,
  mergeAction,
  replyAction,
  runMacroAction,
  setStatusAction,
} from "../../../actions/tickets";
import { logTimeAction, removeTimeAction } from "../../../actions/time";
import { applyAssistClassificationAction, recordAssistDecisionAction } from "../../../actions/assist";

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
  searchParams: Promise<{ flash?: string; error?: string; assist?: string }>;
}) {
  const actor = await requireActor();
  // Staff-only: a requester's own ticket lives in the portal, scoped by
  // `canReadTicket`, so this desk view must never expose the tenant worklist.
  if (!actorHasPermission(actor, "ticket:read:any")) redirect("/portal");
  const { id } = await params;
  const { flash, error, assist: assistAsked } = await searchParams;

  const [ticket, policies, everything, canned, time, scope, staff] = await Promise.all([
    ticketServicesFor().store.findTicket(actor.tenantId, id),
    slaPolicyStoreFor().listForTenant(actor.tenantId),
    ticketServicesFor().store.listTickets(actor.tenantId),
    cannedServicesFor().list(actor.tenantId),
    timeServicesFor().entries(actor, { ticketId: id }),
    clientServicesFor().scope(actor),
    // The desk's people, for the assignment picker. Read even when this caller may not
    // assign, because the same query feeds the header's "assigned to" name; the value
    // being present is not the permission — `actions.assign` is only set below.
    prisma.user.findMany({
      where: { tenantId: actor.tenantId, active: true, role: { in: [...ASSIGNEE_ROLES] } },
      select: { id: true, displayName: true, email: true },
      orderBy: { displayName: "asc" },
    }),
  ]);
  if (!ticket) notFound();
  const assignees = assigneeOptions(staff);
  // One desk serving many clients: a ticket is readable through the client its
  // work belongs to. Addressed by id it is *not* confirmed to exist, because
  // the worklist already refuses to show it — a filter on one page and an open
  // door on the next is not a scope. `notFound()` rather than a redirect, so a
  // guessed id learns nothing about whose work it is.
  if (scopeRefusal(scope, ticket.clientId)) notFound();

  const all = scopeByClient(scope, everything);
  const sla = slaStatusFor(ticket, policies, new Date().toISOString());

  // The M7 assistant (per-tenant opt-in). Suggestions are produced only when somebody
  // asked for them, so an ordinary page view costs nothing — no gateway call, and the
  // panel is a deliberate act rather than something that appears on every ticket the
  // desk opens. Whether this desk has an assistant at all is the tenant's own setting,
  // read per request so switching it off takes effect on the next page. A suggestion
  // that cannot be produced says why rather than vanishing.
  const assistant = assistServicesFor();
  const assistantOn = await assistant.enabledFor(actor.tenantId);
  const canDecide = canUpdateTicket(actor, ticket);
  let assistResult: AssistResult | undefined;
  let assistError: string | undefined;
  let assistHistory: AssistDecisionRecord[] = [];
  if (assistantOn && assistAsked === "1") {
    const suggestion = await assistant.suggest(actor, ticket.id);
    if (suggestion.ok) assistResult = suggestion.value;
    else assistError = suggestion.error;
    // What the desk already decided about this ticket's suggestions, read back off the
    // tenant's audit chain so a dismissal is visible as evidence, not forgotten.
    const prior = await assistant.history(actor, ticket.id);
    if (prior.ok) assistHistory = prior.value;
  }
  // The links and the picker are the same question asked twice: relating work to
  // a ticket you may not open would leak its reference and subject just as the
  // worklist would have.
  const visible = new Set(all.map((candidate) => candidate.id));
  const links = (await linkServicesFor().linkedTickets(actor.tenantId, ticket.id)).filter((link) =>
    visible.has(link.ticketId),
  );
  const linkOptions: TicketOption[] = all
    .filter((candidate) => candidate.id !== ticket.id)
    .map((candidate) => ({ id: candidate.id, ref: candidate.ref, subject: candidate.subject }))
    .sort((a, b) => a.ref.localeCompare(b.ref));

  const actions: TicketActions = {};
  // The shortcuts this agent may run on this ticket (M5). Only the enabled ones
  // are offered, and the action re-checks `ticket:update` server-side regardless.
  let macros: MacroChoice[] = [];
  if (canReplyToTicket(actor, ticket)) actions.reply = replyAction;
  if (canUpdateTicket(actor, ticket)) actions.setStatus = setStatusAction;
  if (canAssignTicket(actor, ticket)) actions.assign = assignAction;
  if (canDeleteTicket(actor, ticket)) actions.delete = deleteTicketAction;
  if (canUpdateTicket(actor, ticket)) {
    actions.link = linkAction;
    actions.merge = mergeAction;
    const listed = await macroServicesFor().list(actor);
    macros = listed.ok
      ? listed.value
          .filter((entry) => entry.macro.enabled)
          .map((entry) => ({ id: entry.macro.id, name: entry.macro.name }))
      : [];
    if (macros.length > 0) actions.applyMacro = runMacroAction;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {flash ? (
        <p className="rounded-xl2 border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-ok">{flash}</p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl2 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          {error}
        </p>
      ) : null}
      {assistantOn ? (
        <div className="flex items-center justify-between rounded-xl2 border border-line bg-surface px-4 py-2">
          <span className="text-xs text-ink-faint">
            The assistant proposes a classification, a summary, a draft reply and similar tickets. It never sends
            anything.
          </span>
          {assistResult ? (
            <a href={`/inbox/${ticket.id}`} className="text-xs font-semibold text-ink-faint hover:text-ink">
              Hide assistant
            </a>
          ) : (
            <a
              href={`/inbox/${ticket.id}?assist=1`}
              className="rounded-full bg-brand/12 px-3 py-1 text-xs font-semibold text-brand hover:bg-brand/20"
            >
              Ask the assistant
            </a>
          )}
        </div>
      ) : null}
      {assistError ? (
        <p role="alert" className="rounded-xl2 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          {assistError}
        </p>
      ) : null}
      <TicketDetail
        ticket={ticket}
        actions={actions}
        sla={sla}
        canned={canned}
        links={links}
        linkOptions={linkOptions}
        macros={macros}
        assignees={assignees}
        {...(assistResult
          ? {
              assist: {
                result: assistResult,
                canDecide,
                decisionAction: recordAssistDecisionAction,
                applyAction: applyAssistClassificationAction,
                history: assistHistory,
              },
            }
          : {})}
      />
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
