import { requireActor } from "../../../../lib/session";
import { TICKET_PRIORITIES, TICKET_TYPES } from "../../../../lib/ticket-rules";
import { createTicketAction } from "../../../actions/tickets";

export const metadata = { title: "New request" };

/** Raise a ticket. A requester is always the requester; no one can file on their behalf here. */
export default async function NewRequestPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireActor();
  const { error } = await searchParams;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">New request</h1>
        <p className="text-sm text-ink-soft">Tell us what is wrong or what you need. You will get a reference straight away.</p>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
          {error}
        </p>
      ) : null}

      <form action={createTicketAction} className="space-y-4 rounded-xl2 border border-line bg-surface p-5">
        <label className="block text-sm font-medium text-ink">
          What is it about?
          <input
            name="subject"
            required
            maxLength={200}
            className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>

        <label className="block text-sm font-medium text-ink">
          Describe the problem
          <textarea
            name="description"
            required
            rows={5}
            className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium text-ink">
            Kind
            <select name="type" className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink">
              {TICKET_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type === "INCIDENT" ? "Something is broken" : "I need something"}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm font-medium text-ink">
            How urgent?
            <select name="priority" className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink" defaultValue="NORMAL">
              {TICKET_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {priority.charAt(0) + priority.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </label>
        </div>

        <button type="submit" className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white">
          Submit request
        </button>
      </form>
    </div>
  );
}
