/**
 * A ticket table: the worklist, as a table.
 *
 * The same component renders the dashboard's queues and the agent inbox's worklist,
 * because an agent who has learned to read one of them should not have to learn a
 * second layout for the same rows. Presentational: the caller passes tickets it has
 * already scoped through the access rules, so this can never widen what is visible.
 *
 * It is a real table — header row, aligned columns, one row per ticket — rather than
 * the stack of chips the inbox used to be. Scanning a desk's work is a comparison
 * task, and a comparison task wants columns.
 */

import { slaStatusFor } from "../lib/report-rules";
import type { SlaPolicy } from "../lib/sla-rules";
import type { TicketRecord } from "../lib/ticket-service";
import { SlaBadge } from "./SlaBadge";
import { TicketPriorityBadge, TicketStatusBadge, TICKET_STATUS_LABELS, TICKET_PRIORITY_LABELS } from "./TicketBadges";

export interface TicketTableProps {
  tickets: readonly TicketRecord[];
  policies: readonly SlaPolicy[];
  now: string | Date;
  /** Display names by user id, so a row shows a person rather than a cuid. */
  names?: ReadonlyMap<string, string>;
  /** Where a row links. Defaults to the inbox with the ticket open. */
  hrefFor?: (ticket: TicketRecord) => string;
  /** Show the reference column. Off in a queue that is already one ticket's story. */
  showClient?: boolean;
  empty?: string;
  /** The row currently open in a detail pane, if any. */
  selectedId?: string | null;
}

/** `4m ago`, `3h ago`, `2d ago` — an age is easier to scan than a timestamp. */
function ago(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return iso.slice(0, 10);
}

export function TicketTable({
  tickets,
  policies,
  now,
  names,
  hrefFor,
  showClient = true,
  empty = "Nothing here.",
  selectedId = null,
}: TicketTableProps) {
  const at = now instanceof Date ? now : new Date(now);

  if (tickets.length === 0) {
    return <p className="ot-note">{empty}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="ot-table">
        <thead>
          <tr>
            <th scope="col">Ref</th>
            <th scope="col">Subject</th>
            {showClient ? <th scope="col">Requester</th> : null}
            <th scope="col">Status</th>
            <th scope="col">Priority</th>
            <th scope="col">Assignee</th>
            <th scope="col">SLA</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => {
            const sla = slaStatusFor(ticket, policies, at);
            const name = (id: string | null) => (id ? (names?.get(id) ?? id) : null);
            const selected = ticket.id === selectedId;
            return (
              <tr key={ticket.id} className={selected ? "bg-brand-soft" : undefined}>
                <td className="whitespace-nowrap font-mono text-[11px] font-semibold text-ink-faint">
                  <a href={hrefFor ? hrefFor(ticket) : `/inbox?ticket=${ticket.id}`} className="hover:text-brand">
                    {ticket.ref}
                  </a>
                </td>
                <td className="max-w-[26rem]">
                  <a
                    href={hrefFor ? hrefFor(ticket) : `/inbox?ticket=${ticket.id}`}
                    className="block truncate font-semibold text-ink hover:text-brand"
                    title={ticket.subject}
                  >
                    {ticket.subject}
                  </a>
                  <span className="sr-only">
                    {TICKET_STATUS_LABELS[ticket.status]} · {TICKET_PRIORITY_LABELS[ticket.priority]}
                  </span>
                </td>
                {showClient ? (
                  <td className="whitespace-nowrap text-ink-soft">{name(ticket.requesterId) ?? "—"}</td>
                ) : null}
                <td>
                  <TicketStatusBadge status={ticket.status} />
                </td>
                <td>
                  <TicketPriorityBadge priority={ticket.priority} />
                </td>
                <td className="whitespace-nowrap text-ink-soft">
                  {ticket.assigneeId ? (name(ticket.assigneeId) ?? "Assigned") : <span className="text-ink-faint">Unassigned</span>}
                </td>
                <td className="whitespace-nowrap">
                  {/* A ticket with no policy has no clock: say so rather than showing a
                      badge that implies one is running. */}
                  {sla ? <SlaBadge status={sla} /> : <span className="text-[11px] text-ink-faint">no policy</span>}
                </td>
                <td className="whitespace-nowrap text-[11px] text-ink-faint">{ago(ticket.updatedAt, at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
