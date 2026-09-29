import { redirect } from "next/navigation";

import { requireActor } from "../../../lib/session";
import { hasPermission } from "../../../lib/access-rules";
import { prisma, rotaServicesFor } from "../../../lib/db";
import { formatLoggedMinutes } from "../../../lib/time-rules";
import { coverageSummary } from "../../../lib/rota-rules";
import { addShiftAction, recordHandoffAction, removeShiftAction } from "../../actions/rota";

export const metadata = { title: "Handoff" };

const inputClass = "mt-1 rounded-xl2 border border-line bg-surface px-3 py-1.5 text-sm text-ink";

/**
 * The rota and the handover (M4).
 *
 * Three questions on one page, because they are the same question asked at
 * different times: who is on now, where nobody is on at all, and what the last
 * person told the next one. The gaps list is deliberately the loudest element —
 * an uncovered hour is the thing a rota exists to make visible, and it is
 * invisible in a list of shifts, which is what every desk has instead.
 *
 * The window defaults to a fortnight from today: long enough to see the next
 * weekend's cover, short enough that the gap list stays readable.
 */
export default async function HandoffPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string; from?: string; to?: string }>;
}) {
  const actor = await requireActor();
  if (!hasPermission(actor.role, "ticket:read:any")) redirect("/portal");

  const { flash, error, from, to } = await searchParams;
  const canManage = hasPermission(actor.role, "queue:manage");

  const today = new Date().toISOString().slice(0, 10);
  const windowFrom = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : today;
  const windowTo =
    to && /^\d{4}-\d{2}-\d{2}$/.test(to)
      ? to
      : new Date(Date.parse(`${windowFrom}T00:00:00.000Z`) + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [view, staff, queues] = await Promise.all([
    rotaServicesFor().view(actor, { from: windowFrom, to: windowTo }),
    prisma.user.findMany({
      where: { tenantId: actor.tenantId, active: true, role: { in: ["ADMIN", "DISPATCHER", "AGENT"] } },
      select: { id: true, displayName: true },
      orderBy: { displayName: "asc" },
    }),
    prisma.queue.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const nameOf = new Map(staff.map((person) => [person.id, person.displayName]));
  const queueName = new Map(queues.map((queue) => [queue.id, queue.name]));

  if (!view.ok) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <h1 className="font-display text-xl font-semibold text-ink">Handoff</h1>
        <p role="alert" className="rounded-xl2 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          {view.error}
        </p>
      </div>
    );
  }

  const rota = view.value;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Handoff</h1>
        <p className="text-sm text-ink-soft">
          {rota.shifts.length} rota entr{rota.shifts.length === 1 ? "y" : "ies"} between {rota.from} and {rota.to}
          {rota.queueId ? ` for ${queueName.get(rota.queueId) ?? rota.queueId}` : " across the desk"}.
        </p>
      </div>

      {flash ? <p className="rounded-xl2 border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-ok">{flash}</p> : null}
      {error ? (
        <p role="alert" className="rounded-xl2 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          {error}
        </p>
      ) : null}

      <form method="get" className="flex flex-wrap items-end gap-2 rounded-xl2 border border-line bg-surface p-4">
        <label className="text-xs text-ink-soft">
          From
          <input name="from" type="date" defaultValue={windowFrom} className={`block ${inputClass}`} />
        </label>
        <label className="text-xs text-ink-soft">
          To
          <input name="to" type="date" defaultValue={windowTo} className={`block ${inputClass}`} />
        </label>
        <button type="submit" className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft">
          Show this window
        </button>
      </form>

      {/* Right now, then where nobody is — the two things the page is for. */}
      <section aria-label="Cover now" className="space-y-1 rounded-xl2 border border-line bg-surface p-4">
        <h2 className="font-display text-sm font-semibold text-ink">Cover right now</h2>
        <p className="text-sm text-ink-soft">{coverageSummary(rota.now)}</p>
        {rota.now.reachable.length > 0 ? (
          <p className="text-xs text-ink-faint">
            Reachable: {rota.now.reachable.map((id) => nameOf.get(id) ?? id).join(", ")}
          </p>
        ) : null}
      </section>

      <section
        aria-label="Coverage gaps"
        className={`space-y-1 rounded-xl2 border p-4 ${rota.gaps.length > 0 ? "border-bad/40 bg-bad/10" : "border-line bg-surface"}`}
      >
        <h2 className={`font-display text-sm font-semibold ${rota.gaps.length > 0 ? "text-bad" : "text-ink"}`}>
          {rota.gaps.length === 0 ? "Every hour in this window has somebody on call" : `${rota.gaps.length} uncovered window${rota.gaps.length === 1 ? "" : "s"}`}
        </h2>
        {rota.gaps.length > 0 ? (
          <ul className="space-y-0.5">
            {rota.gaps.slice(0, 12).map((gap) => (
              <li key={`${gap.from}-${gap.to}`} className="text-xs text-ink-soft">
                {gap.from} → {gap.to} ({formatLoggedMinutes(gap.minutes)} with nobody on call)
              </li>
            ))}
          </ul>
        ) : null}
        {rota.gaps.length > 12 ? <p className="text-xs text-ink-faint">…and {rota.gaps.length - 12} more.</p> : null}
      </section>

      <section aria-label="The rota" className="space-y-2 rounded-xl2 border border-line bg-surface p-4">
        <h2 className="font-display text-sm font-semibold text-ink">The rota</h2>
        {rota.shifts.length === 0 ? (
          <p className="text-xs text-ink-faint">Nothing is published for this window yet.</p>
        ) : (
          <ul className="space-y-1">
            {rota.shifts.map((shift) => (
              <li key={shift.id} className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                <span className="rounded-full bg-surface-muted px-2 py-0.5 font-semibold text-ink-soft">
                  {shift.kind === "ON_CALL" ? "on call" : "shift"}
                </span>
                <span className="font-semibold text-ink">{nameOf.get(shift.userId) ?? shift.userId}</span>
                <span>
                  {shift.startsAt} → {shift.endsAt}
                </span>
                {shift.queueId ? <span className="text-ink-faint">{queueName.get(shift.queueId) ?? shift.queueId}</span> : null}
                {shift.note ? <span className="text-ink-faint">· {shift.note}</span> : null}
                {canManage ? (
                  <form action={removeShiftAction} className="ml-auto">
                    <input type="hidden" name="shiftId" value={shift.id} />
                    <button type="submit" className="text-[11px] text-bad hover:underline">
                      Remove
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {/* Who carries the on-call hours. A single name on every window is
            obvious here and invisible in the list above, which is the point. */}
        {rota.load.length > 0 ? (
          <div className="space-y-0.5 border-t border-line pt-2">
            <p className="text-[11px] font-semibold text-ink-soft">On-call load in this window</p>
            {rota.load.map((load) => (
              <p key={load.userId} className={`text-xs ${load.overloaded ? "text-attention" : "text-ink-soft"}`}>
                {nameOf.get(load.userId) ?? load.userId}: {formatLoggedMinutes(load.onCallMinutes)} on call,{" "}
                {formatLoggedMinutes(load.shiftMinutes)} on shift
                {load.overloaded ? " — more than half of the window's on-call hours" : ""}
              </p>
            ))}
          </div>
        ) : null}

        {canManage ? (
          <form action={addShiftAction} className="flex flex-wrap items-end gap-2 border-t border-line pt-2">
            <label className="text-xs text-ink-soft">
              Person
              <select name="userId" required className={`block ${inputClass}`}>
                {staff.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-soft">
              Queue
              <select name="queueId" className={`block ${inputClass}`}>
                <option value="">the whole desk</option>
                {queues.map((queue) => (
                  <option key={queue.id} value={queue.id}>
                    {queue.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-soft">
              Kind
              <select name="kind" className={`block ${inputClass}`}>
                <option value="SHIFT">shift</option>
                <option value="ON_CALL">on call</option>
              </select>
            </label>
            <label className="text-xs text-ink-soft">
              Starts
              <input name="startsAt" type="datetime-local" required className={`block ${inputClass}`} />
            </label>
            <label className="text-xs text-ink-soft">
              Ends
              <input name="endsAt" type="datetime-local" required className={`block ${inputClass}`} />
            </label>
            <label className="text-xs text-ink-soft">
              Note
              <input name="note" placeholder="e.g. covering the Thursday release" className={`block ${inputClass}`} />
            </label>
            <button type="submit" className="rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-brand-ink">
              Publish on the rota
            </button>
          </form>
        ) : null}
        <p className="text-[11px] text-ink-faint">
          Overlapping windows for the same person are refused — being on call twice is being on call neither time — and a
          &quot;shift&quot; longer than a day is a mis-typed week, so it is refused too.
        </p>
      </section>

      <section aria-label="Hand over" className="space-y-2 rounded-xl2 border border-line bg-surface p-4">
        <h2 className="font-display text-sm font-semibold text-ink">Hand the shift over</h2>
        <p className="text-xs text-ink-faint">
          Write it down and it survives the shift. The work still open is named by reference, so the next person opens each one
          instead of guessing what &quot;the usual&quot; meant.
        </p>
        <form action={recordHandoffAction} className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-ink-soft">
            Queue
            <select name="queueId" className={`block ${inputClass}`}>
              <option value="">the whole desk</option>
              {queues.map((queue) => (
                <option key={queue.id} value={queue.id}>
                  {queue.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-soft">
            To
            <select name="toUserId" className={`block ${inputClass}`}>
              <option value="">whoever is on next</option>
              {staff.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-soft">
            What the next person needs to know
            <textarea
              name="note"
              rows={3}
              required
              placeholder="e.g. Northwind's VPN ticket is waiting on their firewall vendor; everything else is either answered or parked."
              className={`block w-96 ${inputClass}`}
            />
          </label>
          <label className="text-xs text-ink-soft">
            Still open (references, one per line)
            <textarea name="openTicketRefs" rows={3} placeholder={"TIX-000123\nTIX-000131"} className={`block w-48 font-mono ${inputClass}`} />
          </label>
          <button type="submit" className="rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-brand-ink">
            Record the handoff
          </button>
        </form>

        {rota.handoffs.length > 0 ? (
          <ul className="space-y-2 border-t border-line pt-2">
            {rota.handoffs.slice(0, 5).map((handoff) => (
              <li key={handoff.id} className="text-xs text-ink-soft">
                <span className="font-semibold text-ink">{nameOf.get(handoff.fromUserId) ?? handoff.fromUserId}</span>
                {handoff.toUserId ? <> → {nameOf.get(handoff.toUserId) ?? handoff.toUserId}</> : null} at {handoff.at}
                <p className="mt-0.5 whitespace-pre-line text-ink-soft">{handoff.note}</p>
                {handoff.openTicketRefs.length > 0 ? (
                  <p className="mt-0.5 font-mono text-[11px] text-ink-faint">
                    open: {handoff.openTicketRefs.join(", ")}
                  </p>
                ) : (
                  <p className="mt-0.5 text-[11px] text-ink-faint">nothing was left open</p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-faint">No handoff has been written for this window yet.</p>
        )}
      </section>
    </div>
  );
}
