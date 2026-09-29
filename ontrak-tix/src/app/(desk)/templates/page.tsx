import { requireActor } from "../../../lib/session";
import { templateServicesFor } from "../../../lib/db";
import { hasPermission } from "../../../lib/access-rules";
import { TICKET_PRIORITIES, TICKET_TYPES } from "../../../lib/ticket-rules";
import { TEMPLATE_PLACEHOLDERS } from "../../../lib/template-rules";
import { createTemplateAction, deleteTemplateAction } from "../../actions/tickets";

export const metadata = { title: "Ticket templates" };

/**
 * The desk's reusable ticket shapes. Picking one on the new-ticket form prefills
 * the subject, description, type and priority; the agent still edits freely.
 *
 * Managing them is `ticket:update`; using one only needs `ticket:create`, so an
 * agent who cannot edit the library still sees the picker.
 */
export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const actor = await requireActor();
  const { flash, error } = await searchParams;
  const templates = await templateServicesFor().list(actor.tenantId);
  const canManage = hasPermission(actor.role, "ticket:update");

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Ticket templates</h1>
        <p className="text-sm text-ink-soft">
          Reusable starting points for a new ticket. Text may use{" "}
          {TEMPLATE_PLACEHOLDERS.map((placeholder, index) => (
            <span key={placeholder}>
              {index > 0 ? ", " : ""}
              <code className="font-mono text-xs">{`{{${placeholder}}}`}</code>
            </span>
          ))}
          .
        </p>
      </div>

      {flash ? <p className="rounded-xl2 border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">{flash}</p> : null}
      {error ? (
        <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
          {error}
        </p>
      ) : null}

      {templates.length === 0 ? (
        <p className="rounded-xl2 border border-line bg-surface p-5 text-sm text-ink-soft">No templates yet.</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-surface">
          {templates.map((template) => (
            <li key={template.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{template.name}</span>
                <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand">
                  {template.type === "INCIDENT" ? "Incident" : "Request"}
                </span>
                <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
                  {template.priority.charAt(0) + template.priority.slice(1).toLowerCase()}
                </span>
                <a
                  href={`/inbox/new?template=${template.id}`}
                  className="ml-auto text-xs font-semibold text-brand hover:underline"
                >
                  Use
                </a>
                {canManage ? (
                  <form action={deleteTemplateAction}>
                    <input type="hidden" name="id" value={template.id} />
                    <button type="submit" className="text-xs font-semibold text-pink hover:underline">
                      Remove
                    </button>
                  </form>
                ) : null}
              </div>
              <p className="mt-1 text-sm font-medium text-ink">{template.subject}</p>
              <pre className="mt-1 whitespace-pre-wrap font-sans text-sm text-ink-soft">{template.description}</pre>
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <form action={createTemplateAction} className="space-y-3 rounded-xl2 border border-line bg-surface p-4">
          <h2 className="font-display text-sm font-semibold tracking-wide text-ink uppercase">Add a template</h2>
          <label className="block text-sm">
            <span className="mb-1 block font-semibold text-ink">Name</span>
            <input name="name" required className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-semibold text-ink">Subject</span>
            <input
              name="subject"
              required
              className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-ink">Type</span>
              <select name="type" className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink">
                {TICKET_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type === "INCIDENT" ? "Incident" : "Request"}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-ink">Priority</span>
              <select
                name="priority"
                defaultValue="NORMAL"
                className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
              >
                {TICKET_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority.charAt(0) + priority.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block font-semibold text-ink">Description</span>
            <textarea
              name="description"
              required
              rows={6}
              className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 font-mono text-sm text-ink"
            />
          </label>
          <button type="submit" className="rounded-full bg-brand px-4 py-2 text-xs font-semibold text-brand-ink">
            Save template
          </button>
        </form>
      ) : null}
    </div>
  );
}
