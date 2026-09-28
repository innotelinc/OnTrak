import { requireActor, getTixSession } from "../../../../lib/session";
import { sessionDisplayName } from "../../../../lib/session-rules";
import { hasPermission } from "../../../../lib/access-rules";
import { TICKET_PRIORITIES, TICKET_TYPES } from "../../../../lib/ticket-rules";
import { canUseTicketTemplates } from "../../../../lib/template-service";
import { clientServicesFor, templateServicesFor } from "../../../../lib/db";
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
  searchParams: Promise<{ error?: string; template?: string }>;
}) {
  const actor = await requireActor();
  const { error, template: templateId } = await searchParams;
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

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">New ticket</h1>
        <p className="text-sm text-ink-soft">Log a request or incident. It is audited the moment it is created.</p>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
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

      <form action={createTicketAction} className="space-y-4 rounded-xl2 border border-line bg-surface p-5">
        <label className="block text-sm font-medium text-ink">
          Subject
          <input
            name="subject"
            required
            maxLength={200}
            defaultValue={prefill?.subject ?? ""}
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

        {prefill?.queueId ? <input type="hidden" name="queueId" value={prefill.queueId} /> : null}

        {mayPickRequester ? (
          <label className="block text-sm font-medium text-ink">
            Requester id (leave blank to raise it for yourself)
            <input name="requesterId" className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink" />
          </label>
        ) : null}

        <button type="submit" className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white">
          Create ticket
        </button>
      </form>
    </div>
  );
}
