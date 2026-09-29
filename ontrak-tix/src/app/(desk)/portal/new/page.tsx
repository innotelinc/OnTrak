import { requireActor } from "../../../../lib/session";
import { TICKET_PRIORITIES, TICKET_TYPES } from "../../../../lib/ticket-rules";
import { knowledgeServicesFor } from "../../../../lib/db";
import { ArticleSuggestions } from "../../../../components/ArticleSuggestions";
import { createTicketAction } from "../../../actions/tickets";

export const metadata = { title: "New request" };

/**
 * Raise a ticket. A requester is always the requester; no one can file on their
 * behalf here.
 *
 * **Self-service deflection (M5).** Typing a few words and pressing *Find help*
 * runs the same public-article search the desk's suggestions use, and anything
 * that matches is shown in full before the form. It is a plain `GET` form, so it
 * works with no JavaScript, and whatever was typed stays in the subject field —
 * if the articles do not help, nothing has been lost by looking.
 */
export default async function NewRequestPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; subject?: string }>;
}) {
  const actor = await requireActor();
  const { error, subject } = await searchParams;

  const query = subject?.trim() ?? "";
  // Public articles only: the search itself refuses to hand back a private one.
  const suggestions = query ? await knowledgeServicesFor().suggestPublic(actor.tenantId, query) : [];

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

      <form method="get" className="space-y-3 rounded-xl2 border border-line bg-surface p-5">
        <label className="block text-sm font-medium text-ink">
          Check our answers first
          <input
            name="subject"
            defaultValue={query}
            maxLength={200}
            placeholder="e.g. vpn keeps disconnecting"
            className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>
        <button type="submit" className="rounded-full bg-surface-muted px-4 py-2 text-sm font-semibold text-ink-soft">
          Find help
        </button>
      </form>

      <ArticleSuggestions
        suggestions={suggestions}
        title={`Answers for “${query}”`}
        note="Open one to read it. If none of these help, the form below is still the right place to ask."
      />

      <form action={createTicketAction} className="space-y-4 rounded-xl2 border border-line bg-surface p-5">
        <label className="block text-sm font-medium text-ink">
          What is it about?
          <input
            name="subject"
            required
            maxLength={200}
            defaultValue={query}
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
