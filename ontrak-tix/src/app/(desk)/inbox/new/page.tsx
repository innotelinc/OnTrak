import { requireActor, getTixSession } from "../../../../lib/session";
import { sessionDisplayName } from "../../../../lib/session-rules";
import { hasPermission } from "../../../../lib/access-rules";
import { TICKET_PRIORITIES, TICKET_TYPES } from "../../../../lib/ticket-rules";
import { canUseTicketTemplates } from "../../../../lib/template-service";
import { clientServicesFor, formServicesFor, knowledgeServicesFor, templateServicesFor } from "../../../../lib/db";
import { ArticleSuggestions } from "../../../../components/ArticleSuggestions";
import { CustomFieldInputs } from "../../../../components/CustomFieldInputs";
import { createTicketAction } from "../../../actions/tickets";

export const metadata = { title: "New ticket" };

/**
 * Agent quick-create. Staff may raise a ticket on behalf of a requester; everyone
 * else creates their own.
 *
 * `?template=<id>` prefills the form from a saved template. The template only
 * supplies *initial* values — every field stays editable, and a stale id simply
 * leaves the form blank rather than failing the page.
 */
export default async function NewTicketPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; template?: string; subject?: string }>;
}) {
  const actor = await requireActor();
  const { error, template: templateId, subject } = await searchParams;
  const mayPickRequester = actor.role !== "REQUESTER" && hasPermission(actor.role, "ticket:create");
  const mayUseTemplates = canUseTicketTemplates(actor);

  // The client the work is for, from the ones this actor serves. A desk that
  // serves one company still sees it; a desk that serves none renders no picker,
  // because a ticket with no client is the desk's own work and the default.
  const clients = mayPickRequester ? await clientServicesFor().list(actor) : null;
  const clientOptions = clients?.ok ? clients.value : [];

  const templates = mayUseTemplates ? await templateServicesFor().list(actor.tenantId) : [];
  const claims = mayUseTemplates ? await getTixSession() : null;
  const prefill = templateId
    ? await templateServicesFor().prefill(actor.tenantId, templateId, {
        requester: mayPickRequester ? "" : claims ? sessionDisplayName(claims) : "",
        agent: claims ? sessionDisplayName(claims) : "",
        date: new Date().toISOString().slice(0, 10),
        tenant: actor.tenantId,
      })
    : null;

  // Suggestions before the ticket is raised (M5). Staff see private articles too,
  // so an agent can find the desk's own note as well as a published answer.
  const query = subject?.trim() ?? "";
  const suggested = query ? await knowledgeServicesFor().suggestForStaff(actor, query) : null;
  const suggestions = suggested?.ok ? suggested.value : [];

  // The desk's own fields for the queue this ticket is landing in (M6). A template's queue
  // is the only queue the quick-create form knows before the ticket exists, so a ticket
  // with no template shows the default form — the same one the desk sees for its own work.
  const layout = await formServicesFor().layoutFor(actor, prefill?.queueId ?? null);
  const customFields = layout.ok ? layout.value : null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">New ticket</h1>
        <p className="text-sm text-ink-soft">Log a request or incident. It is audited the moment it is created.</p>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl2 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          {error}
        </p>
      ) : null}

      {templates.length > 0 ? (
        <nav aria-label="Ticket templates" className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Start from</span>
          {templates.map((template) => (
            <a
              key={template.id}
              href={`/inbox/new?template=${template.id}`}
              aria-current={template.id === templateId ? "true" : undefined}
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                template.id === templateId
                  ? "border-brand/40 bg-brand-soft text-brand"
                  : "border-line bg-surface text-ink-soft hover:border-brand/40"
              }`}
            >
              {template.name}
            </a>
          ))}
        </nav>
      ) : null}

      <form method="get" className="space-y-3 rounded-xl2 border border-line bg-surface p-5">
        <label className="block text-sm font-medium text-ink">
          Check the knowledge base first
          <input
            name="subject"
            defaultValue={query}
            maxLength={200}
            placeholder="e.g. printer queue stuck"
            className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>
        <button type="submit" className="rounded-full bg-surface-muted px-4 py-2 text-sm font-semibold text-ink-soft">
          Find articles
        </button>
      </form>

      <ArticleSuggestions
        suggestions={suggestions}
        title={`Articles for “${query}”`}
        note="The same search a requester gets in the portal, with the desk's staff-only articles included."
      />

      <form action={createTicketAction} className="space-y-4 rounded-xl2 border border-line bg-surface p-5">
        <label className="block text-sm font-medium text-ink">
          Subject
          <input
            name="subject"
            required
            maxLength={200}
            defaultValue={prefill?.subject ?? query}
            className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>

        <label className="block text-sm font-medium text-ink">
          Description
          <textarea
            name="description"
            required
            rows={8}
            defaultValue={prefill?.description ?? ""}
            className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium text-ink">
            Type
            <select
              name="type"
              defaultValue={prefill?.type ?? "INCIDENT"}
              className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
            >
              {TICKET_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type === "INCIDENT" ? "Incident" : "Request"}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm font-medium text-ink">
            Priority
            <select
              name="priority"
              defaultValue={prefill?.priority ?? "NORMAL"}
              className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
            >
              {TICKET_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {priority.charAt(0) + priority.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </label>
        </div>

        {clientOptions.length > 0 ? (
          <label className="block text-sm font-medium text-ink">
            Client
            <select
              name="clientId"
              defaultValue=""
              className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
            >
              <option value="">The desk&rsquo;s own work</option>
              {clientOptions.map(({ client }) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-ink-faint">
              Naming a client puts the ticket on their promise ladder and hides it from agents who do not serve them.
            </span>
          </label>
        ) : null}

        {customFields ? <CustomFieldInputs layout={customFields} /> : null}

        {prefill?.queueId ? <input type="hidden" name="queueId" value={prefill.queueId} /> : null}

        {mayPickRequester ? (
          <label className="block text-sm font-medium text-ink">
            Requester id (leave blank to raise it for yourself)
            <input name="requesterId" className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink" />
          </label>
        ) : null}

        <button type="submit" className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-ink">
          Create ticket
        </button>
      </form>
    </div>
  );
}
