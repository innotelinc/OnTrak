/**
 * SLA badge (M1): the running clock, on the ticket it belongs to.
 *
 * The escalation engine can raise all the rungs it likes, but an agent still
 * needs to *see* the deadline on the ticket. This renders the same status the
 * report and the sweep use, so the three can never disagree.
 */

import { slaRemainingLabel, type TicketSlaStatus } from "../lib/report-rules";

function toneClass(status: TicketSlaStatus): string {
  if (status.breached) return "border-pink/40 bg-pink/10 text-pink";
  if (status.atRisk) return "border-amber/40 bg-amber/10 text-amber";
  if (status.state === "met") return "border-teal/40 bg-teal/10 text-teal";
  // Paused sits between met and on-track: nothing is wrong, but the clock is not
  // actually moving, and an agent should be able to tell the two apart at a glance.
  if (status.paused) return "border-sky/40 bg-sky/10 text-sky";
  return "border-line bg-surface-muted text-ink-soft";
}

export function SlaBadge({ status }: { status: TicketSlaStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${toneClass(status)}`}
      title={`Response: ${status.response?.remainingMinutes ?? 0} business minutes left · Resolution: ${status.resolution?.remainingMinutes ?? 0} left`}
    >
      {slaRemainingLabel(status)}
    </span>
  );
}
