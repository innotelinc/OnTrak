/**
 * Ticket detail (M0): the header, the immutable conversation, and the actions
 * an agent can take.
 *
 * Presentational: it renders whatever record it is handed and posts to the
 * server actions it is given. No access decision is made here — the actions
 * re-derive the actor and the ticket service re-checks every rule, so a hidden
 * or forged form cannot widen what a caller may do.
 */

import type { TicketRecord } from "../lib/ticket-service";
import type { TicketSlaStatus } from "../lib/report-rules";
import type { CannedResponse } from "../lib/canned-rules";
import type { TicketLinkKind } from "../lib/link-rules";
import { MessageKindBadge, TicketPriorityBadge, TicketStatusBadge, TicketTypeBadge } from "./TicketBadges";
import { SlaBadge } from "./SlaBadge";
import { ReplyComposer } from "./ReplyComposer";

export interface TicketActions {
  reply?: (formData: FormData) => Promise<void>;
  setStatus?: (formData: FormData) => Promise<void>;
  assign?: (formData: FormData) => Promise<void>;
  link?: (formData: FormData) => Promise<void>;
  merge?: (formData: FormData) => Promise<void>;
  /** Run a saved shortcut (M5) on this ticket. */
  applyMacro?: (formData: FormData) => Promise<void>;
}

/** A saved macro, as the picker shows it. */
export interface MacroChoice {
  id: string;
  name: string;
}

/** A candidate ticket for the link/merge pickers. */
export interface TicketOption {
  id: string;
  ref: string;
  subject: string;
}

/** A ticket already linked to this one, from this ticket's point of view. */
export interface LinkedTicket {
  linkId: string;
  ticketId: string;
  ref: string;
  subject: string;
  kind: TicketLinkKind;
  direction: "outgoing" | "incoming";
}

const NEXT_STATUSES: Record<TicketRecord["status"], TicketRecord["status"][]> = {
  NEW: ["OPEN", "PENDING"],
  OPEN: ["PENDING", "RESOLVED", "CLOSED"],
  PENDING: ["OPEN", "RESOLVED", "CLOSED"],
  RESOLVED: ["CLOSED", "OPEN"],
  CLOSED: ["OPEN"],
};

export function TicketDetail({
  ticket,
  actions,
  sla = null,
  canned = [],
  links = [],
  linkOptions = [],
  macros = [],
}: {
  ticket: TicketRecord;
  actions?: TicketActions;
  /** The ticket's SLA status, when it has a policy. */
  sla?: TicketSlaStatus | null;
  /** The desk's canned responses, offered as quick-fills in the composer. */
  canned?: CannedResponse[];
  /** Tickets already related to this one. */
  links?: LinkedTicket[];
  /** Other tickets the caller may link or merge into this one. */
  linkOptions?: TicketOption[];
  /** The shortcuts the caller may run on this ticket (M5). */
  macros?: MacroChoice[];
}) {
  return (
    <section aria-label={`Ticket ${ticket.ref}`} className="rounded-xl2 border border-line bg-surface">
      <header className="border-b border-line px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs font-semibold text-ink-faint">{ticket.ref}</span>
          <TicketStatusBadge status={ticket.status} />
          <TicketPriorityBadge priority={ticket.priority} />
          <TicketTypeBadge type={ticket.type} />
          {sla ? <SlaBadge status={sla} /> : null}
          <span className="ml-auto text-xs text-ink-faint">
            {ticket.assigneeId ? `Assigned to ${ticket.assigneeId}` : "Unassigned"}
          </span>
        </div>
        <h2 className="mt-2 font-display text-lg font-semibold text-ink">{ticket.subject}</h2>
        <p className="mt-1 whitespace-pre-wrap text-sm text-ink-soft">{ticket.description}</p>
      </header>

      <ol className="divide-y divide-line">
        {ticket.messages.length === 0 ? (
          <li className="px-5 py-4 text-sm text-ink-faint">No replies yet.</li>
        ) : (
          ticket.messages.map((message) => (
            <li key={message.id} className="px-5 py-4">
              <div className="flex items-center gap-2">
                <MessageKindBadge kind={message.kind} />
                <span className="text-xs text-ink-faint">{message.authorId ?? "system"}</span>
                <time className="ml-auto text-[11px] text-ink-faint" dateTime={message.createdAt}>
                  {message.createdAt}
                </time>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{message.body}</p>
            </li>
          ))
        )}
      </ol>

      {links.length > 0 ? (
        <div className="border-t border-line px-5 py-4">
          <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Linked tickets</h3>
          <ul className="mt-2 space-y-1.5">
            {links.map((link) => (
              <li key={link.linkId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
                  {link.kind}
                  {link.direction === "incoming" ? " (from)" : " (to)"}
                </span>
                <a href={`/inbox/${link.ticketId}`} className="font-mono text-[11px] font-semibold text-brand">
                  {link.ref}
                </a>
                <span className="truncate text-ink-soft">{link.subject}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {actions ? (
        <div className="space-y-4 border-t border-line px-5 py-4">
          {actions.reply ? (
            <ReplyComposer
              action={actions.reply}
              ticketId={ticket.id}
              ticketRef={ticket.ref}
              requester={ticket.requesterId}
              agent={ticket.assigneeId ?? "the desk"}
              canned={canned}
            />
          ) : null}

          <div className="flex flex-wrap gap-3">
            {actions.setStatus
              ? NEXT_STATUSES[ticket.status].map((status) => (
                  <form key={status} action={actions.setStatus}>
                    <input type="hidden" name="ticketId" value={ticket.id} />
                    <input type="hidden" name="status" value={status} />
                    <button
                      type="submit"
                      className="rounded-full bg-surface-muted px-3 py-1.5 text-xs font-semibold text-ink-soft"
                    >
                      Mark {status.toLowerCase()}
                    </button>
                  </form>
                ))
              : null}
            {actions.assign ? (
              <form action={actions.assign} className="flex items-center gap-2">
                <input type="hidden" name="ticketId" value={ticket.id} />
                <input
                  name="assigneeId"
                  defaultValue={ticket.assigneeId ?? ""}
                  placeholder="Assignee id (blank to unassign)"
                  className="rounded-xl2 border border-line bg-surface px-3 py-1.5 text-xs text-ink"
                />
                <button type="submit" className="rounded-full bg-surface-muted px-3 py-1.5 text-xs font-semibold text-ink-soft">
                  Assign
                </button>
              </form>
            ) : null}
          </div>

          {actions.applyMacro && macros.length > 0 ? (
            <form action={actions.applyMacro} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="ticketId" value={ticket.id} />
              <label className="text-xs font-semibold text-ink-soft" htmlFor="macro-select">
                Shortcut
              </label>
              <select
                id="macro-select"
                name="macroId"
                required
                defaultValue=""
                className="rounded-xl2 border border-line bg-surface px-3 py-1.5 text-xs text-ink"
              >
                <option value="" disabled>
                  Run a macro…
                </option>
                {macros.map((macro) => (
                  <option key={macro.id} value={macro.id}>
                    {macro.name}
                  </option>
                ))}
              </select>
              <button type="submit" className="rounded-full bg-brand/12 px-3 py-1.5 text-xs font-semibold text-brand">
                Run macro
              </button>
            </form>
          ) : null}

          {linkOptions.length > 0 && (actions.link || actions.merge) ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {actions.link ? (
                <form action={actions.link} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="ticketId" value={ticket.id} />
                  <select name="toTicketId" required className="rounded-xl2 border border-line bg-surface px-3 py-1.5 text-xs text-ink">
                    {linkOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.ref} — {option.subject}
                      </option>
                    ))}
                  </select>
                  <select name="kind" defaultValue="RELATED" className="rounded-xl2 border border-line bg-surface px-3 py-1.5 text-xs text-ink">
                    <option value="RELATED">Related</option>
                    <option value="DUPLICATE">Duplicate</option>
                    <option value="PARENT">Parent</option>
                    <option value="CHILD">Child</option>
                  </select>
                  <button type="submit" className="rounded-full bg-surface-muted px-3 py-1.5 text-xs font-semibold text-ink-soft">
                    Link
                  </button>
                </form>
              ) : null}
              {actions.merge ? (
                <form action={actions.merge} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="ticketId" value={ticket.id} />
                  <select name="duplicateId" required className="rounded-xl2 border border-line bg-surface px-3 py-1.5 text-xs text-ink">
                    {linkOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.ref} — {option.subject}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="rounded-full bg-pink/12 px-3 py-1.5 text-xs font-semibold text-pink hover:bg-pink/20"
                  >
                    Merge into this ticket
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
