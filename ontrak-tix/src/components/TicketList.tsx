/**
 * A compact ticket list (M0): the requester portal's "my tickets" view.
 *
 * Deliberately simpler than the agent inbox — no assignment or counts — because
 * a requester only ever sees their own raised work. Presentational: the caller
 * passes the tickets it has already scoped with the access rules.
 */

import type { TicketRecord } from "../lib/ticket-service";
import { TicketPriorityBadge, TicketStatusBadge, TicketTypeBadge } from "./TicketBadges";

export interface TicketListProps {
  tickets: TicketRecord[];
  basePath: string;
  selectedId?: string | null;
  emptyMessage?: string;
}

export function TicketList({ tickets, basePath, selectedId = null, emptyMessage }: TicketListProps) {
  if (tickets.length === 0) {
    return (
      <p className="rounded-xl2 border border-line bg-surface p-5 text-sm text-ink-soft">
        {emptyMessage ?? "Nothing here yet."}
      </p>
    );
  }

  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-surface">
      {tickets.map((ticket) => (
        <li key={ticket.id}>
          <a
            href={`${basePath}/${ticket.id}`}
            aria-current={ticket.id === selectedId ? "page" : undefined}
            className={`block px-4 py-3 ${ticket.id === selectedId ? "bg-surface-muted/70" : "hover:bg-surface-muted/50"}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] font-semibold text-ink-faint">{ticket.ref}</span>
              <TicketStatusBadge status={ticket.status} />
              <TicketPriorityBadge priority={ticket.priority} />
              <TicketTypeBadge type={ticket.type} />
            </div>
            <p className="mt-1 truncate text-sm font-semibold text-ink">{ticket.subject}</p>
            <p className="mt-0.5 text-xs text-ink-faint">
              {ticket.messages.length} {ticket.messages.length === 1 ? "message" : "messages"}
            </p>
          </a>
        </li>
      ))}
    </ul>
  );
}
