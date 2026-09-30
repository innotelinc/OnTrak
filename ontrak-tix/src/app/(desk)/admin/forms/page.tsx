import { redirect } from "next/navigation";

import { actorHasPermission } from "../../../../lib/access-rules";
import { formServicesFor, prisma } from "../../../../lib/db";
import { FIELD_TYPES } from "../../../../lib/form-rules";
import { requireActor } from "../../../../lib/session";
import { archiveFieldAction, removeLayoutAction, saveFieldAction, saveLayoutAction } from "../../../actions/forms";

export const metadata = { title: "Fields & forms" };

/**
 * Fields and forms (M6).
 *
 * One screen, because the two things are one question asked twice: *what does this desk
 * want to know about a ticket* (a field), and *which questions does this queue ask* (a form
 * layout). Splitting them would mean defining a field on one page and then hunting for the
 * other to make it appear — which is how a field ends up existing and never being shown.
 *
 * The screen is deliberately honest about three consequences:
 *
 *  - a field is **not** on any form until a layout names it, and the field list says how
 *    many layouts use it;
 *  - **a key cannot change** once a field exists, because answers are stored under it, so
 *    the edit form shows the key as read-only text;
 *  - **archiving is not deleting** — the field leaves new forms and every ticket that
 *    answered it still reads, and the button offers the way back.
 */

const inputClass = "rounded-xl2 border border-line bg-surface px-2 py-1 text-sm text-ink";
const MAX_SECTION_SLOTS = 4;

type Search = Promise<{ edit?: string; queue?: string; flash?: string; error?: string }>;

export default async function FormsPage({ searchParams }: { searchParams: Search }) {
  const actor = await requireActor();
  if (!actorHasPermission(actor, "tenant:manage")) redirect("/?error=You%20do%20not%20administer%20the%20desk%27s%20forms.");

  const query = await searchParams;
  const forms = formServicesFor();
  const [fields, layouts, queues] = await Promise.all([
    forms.fields(actor),
    forms.layouts(actor),
    prisma.queue.findMany({ where: { tenantId: actor.tenantId }, orderBy: { name: "asc" } }),
  ]);
  if (!fields.ok) redirect(`/?error=${encodeURIComponent(fields.error)}`);

  const editing = query.edit ? (fields.value.find((entry) => entry.field.id === query.edit)?.field ?? null) : null;
  const queueId = query.queue && query.queue.length > 0 ? query.queue : null;
  const layout = await forms.layoutFor(actor, queueId);
  if (!layout.ok) redirect(`/?error=${encodeURIComponent(layout.error)}`);

  const queueName = queues.find((queue) => queue.id === queueId)?.name ?? null;
  const activeFields = fields.value.filter((entry) => !entry.field.archived);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Fields &amp; forms</h1>
        <p className="text-sm text-ink-soft">
          Define what this desk asks about a ticket, then say which queues ask it. Values live on the ticket and
          are checked when it is raised — from the portal, the console or the API.
        </p>
      </div>

      {query.error ? <p className="rounded-xl2 border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">{query.error}</p> : null}
      {query.flash ? <p className="rounded-xl2 border border-ok/40 bg-ok/5 px-3 py-2 text-sm text-ok">{query.flash}</p> : null}

      {/* Defining a field. The key is only sent when creating: it is the name answers are
          stored under, so the service refuses to change it. */}
      <section className="rounded-xl2 border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold text-ink">{editing ? `Edit “${editing.label}”` : "Add a field"}</h2>
        <form action={saveFieldAction} className="mt-3 grid gap-2 sm:grid-cols-2">
          <input type="hidden" name="fieldId" value={editing?.id ?? ""} />
          {editing ? (
            <p className="text-xs text-ink-faint sm:col-span-2">
              Key <code className="text-ink">{editing.key}</code> — it cannot change, because every answer already
              recorded is stored under it. Change the label instead.
            </p>
          ) : (
            <label className="text-xs text-ink-soft">
              Key (lower-case letters, digits, underscores)
              <input className={`${inputClass} mt-1 w-full`} name="key" placeholder="change_window" required />
            </label>
          )}
          <label className="text-xs text-ink-soft">
            Label
            <input className={`${inputClass} mt-1 w-full`} name="label" defaultValue={editing?.label ?? ""} placeholder="Change window" required />
          </label>
          <label className="text-xs text-ink-soft">
            Type
            <select className={`${inputClass} mt-1 w-full`} name="type" defaultValue={editing?.type ?? "TEXT"}>
              {FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-soft">
            Options (comma-separated, for a choice field)
            <input className={`${inputClass} mt-1 w-full`} name="options" defaultValue={(editing?.options ?? []).join(", ")} />
          </label>
          <label className="text-xs text-ink-soft">
            Placeholder
            <input className={`${inputClass} mt-1 w-full`} name="placeholder" defaultValue={editing?.placeholder ?? ""} />
          </label>
          <label className="text-xs text-ink-soft">
            Help text
            <input className={`${inputClass} mt-1 w-full`} name="helpText" defaultValue={editing?.helpText ?? ""} />
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-soft">
            <input type="checkbox" name="requiredByDefault" defaultChecked={editing?.requiredByDefault ?? false} />
            Required on every form that shows it
          </label>
          <div className="sm:col-span-2">
            <button type="submit" className="rounded-xl2 bg-brand px-3 py-1.5 text-sm font-semibold text-white">
              {editing ? "Save the field" : "Add the field"}
            </button>
            {editing ? (
              <a href="/admin/forms" className="ml-3 text-sm text-ink-soft hover:text-brand">
                Cancel
              </a>
            ) : null}
          </div>
        </form>
      </section>

      {/* What exists, and whether it is on a form. */}
      <section className="rounded-xl2 border border-line bg-surface">
        <h2 className="px-4 pt-4 text-sm font-semibold text-ink">Fields</h2>
        {fields.value.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-faint">No custom fields yet. A ticket is what the lifecycle makes it.</p>
        ) : (
          <ul className="divide-y divide-line">
            {fields.value.map(({ field, usedByLayouts }) => (
              <li key={field.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                <span className="font-semibold text-ink">{field.label}</span>
                <code className="rounded bg-surface-muted px-1.5 py-0.5 text-xs text-ink-soft">{field.key}</code>
                <span className="text-xs text-ink-faint">{field.type}</span>
                {field.requiredByDefault ? <span className="text-xs text-ink-faint">required</span> : null}
                <span className="text-xs text-ink-faint">
                  {usedByLayouts === 0 ? "on no form yet" : `on ${usedByLayouts} form${usedByLayouts === 1 ? "" : "s"}`}
                </span>
                {field.archived ? (
                  <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-ink-faint">archived</span>
                ) : null}
                <span className="ml-auto flex items-center gap-3 text-xs font-semibold">
                  <a href={`/admin/forms?edit=${field.id}`} className="text-brand hover:underline">
                    Edit
                  </a>
                  <form action={archiveFieldAction}>
                    <input type="hidden" name="fieldId" value={field.id} />
                    <input type="hidden" name="archived" value={field.archived ? "false" : "true"} />
                    <button type="submit" className="text-ink-soft hover:text-brand">
                      {field.archived ? "Restore" : "Archive"}
                    </button>
                  </form>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* The layout editor: one queue at a time, because a form is one queue's answer. */}
      <section className="rounded-xl2 border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold text-ink">The form a queue shows</h2>
        <form method="get" action="/admin/forms" className="mt-2 flex flex-wrap items-end gap-2">
          <label className="text-xs text-ink-soft">
            Queue
            <select className={`${inputClass} mt-1`} name="queue" defaultValue={queueId ?? ""}>
              <option value="">Default (and tickets with no queue)</option>
              {queues.map((queue) => (
                <option key={queue.id} value={queue.id}>
                  {queue.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded-xl2 border border-line px-3 py-1.5 text-sm font-semibold text-ink">
            Show
          </button>
        </form>

        <p className="mt-2 text-xs text-ink-faint">
          {layout.value.inherited && queueId !== null
            ? `“${queueName ?? "That queue"}” has no form of its own, so it shows the default one. Saving below gives it its own.`
            : queueId === null
              ? "The default form, which every queue without one of its own shows."
              : `The form “${queueName ?? "that queue"}” shows.`}{" "}
          A field is required here if it is required everywhere, or if you tick “required” for it on this form.
        </p>

        <form action={saveLayoutAction} className="mt-3 space-y-3">
          <input type="hidden" name="queueId" value={queueId ?? ""} />
          {Array.from({ length: MAX_SECTION_SLOTS }, (_, index) => {
            const section = layout.value.sections[index];
            return (
              <fieldset key={index} className="rounded-xl2 border border-line p-3">
                <legend className="px-1 text-xs text-ink-faint">Section {index + 1}</legend>
                <label className="block text-xs text-ink-soft">
                  Title
                  <input className={`${inputClass} mt-1 w-full`} name={`section.${index}.title`} defaultValue={section?.title ?? ""} />
                </label>
                {activeFields.length === 0 ? (
                  <p className="mt-2 text-xs text-ink-faint">Add a field first.</p>
                ) : (
                  <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                    {activeFields.map(({ field }) => {
                      const shown = section?.fields.some((entry) => entry.key === field.key) ?? false;
                      return (
                        <li key={field.key} className="flex items-center gap-2 text-xs text-ink-soft">
                          <label className="flex items-center gap-1">
                            <input type="checkbox" name={`section.${index}.field`} value={field.key} defaultChecked={shown} />
                            {field.label}
                          </label>
                          <label className="flex items-center gap-1 text-ink-faint">
                            <input
                              type="checkbox"
                              name={`section.${index}.required`}
                              value={field.key}
                              defaultChecked={section?.fields.find((entry) => entry.key === field.key)?.required ?? false}
                            />
                            required
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </fieldset>
            );
          })}
          <div className="flex items-center gap-3">
            <button type="submit" className="rounded-xl2 bg-brand px-3 py-1.5 text-sm font-semibold text-white">
              Save this form
            </button>
            {layout.value.sections.length > 0 ? (
              <span className="text-xs text-ink-faint">
                {layout.value.fields.length} field{layout.value.fields.length === 1 ? "" : "s"} in {layout.value.sections.length} section
                {layout.value.sections.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
        </form>

        {queueId !== null && !layout.value.inherited ? (
          <form action={removeLayoutAction} className="mt-3">
            <input type="hidden" name="queueId" value={queueId} />
            <button type="submit" className="text-xs font-semibold text-ink-soft hover:text-brand">
              Forget this queue's form (go back to the default)
            </button>
          </form>
        ) : null}
      </section>

      <section className="rounded-xl2 border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold text-ink">Forms in use</h2>
        {layouts.ok && layouts.value.length > 0 ? (
          <ul className="mt-2 space-y-1 text-sm text-ink-soft">
            {layouts.value.map((entry) => (
              <li key={entry.id}>
                {entry.queueId ? (queues.find((queue) => queue.id === entry.queueId)?.name ?? entry.queueId) : "Default"}:{" "}
                {entry.sections.reduce((total, section) => total + section.fieldKeys.length, 0)} field(s), updated {entry.updatedAt}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-ink-faint">No form has been saved. Every ticket reads as it did before fields existed.</p>
        )}
      </section>
    </div>
  );
}
