import { redirect } from "next/navigation";

import { requireActor } from "../../../../lib/session";
import { hasPermission } from "../../../../lib/access-rules";
import { commsTemplateServicesFor } from "../../../../lib/db";
import { COMMS_AUDIENCES, audienceLabel, authorableRegimes } from "../../../../lib/comms-rules";
import { createCommsTemplateAction, retireCommsTemplateAction } from "../../../actions/incidents";

export const metadata = { title: "Incident notice templates" };

const inputClass = "mt-1 rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink";

/**
 * The desk's own drafts for an incident's notification duties.
 *
 * The shipped templates say what a notice to a CSIRT has to contain; they cannot
 * say what *this* desk promises *this* client, which comes from the contract and
 * the last time somebody complained about the wording. So a draft authored here
 * is offered ahead of ours on the duty it names.
 */
export default async function IncidentTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const actor = await requireActor();
  if (!hasPermission(actor.role, "ticket:read:any")) redirect("/portal");

  const { flash, error } = await searchParams;
  const canManage = hasPermission(actor.role, "ticket:update");
  const templates = await commsTemplateServicesFor().list(actor.tenantId, { includeRetired: true });
  const live = templates.filter((template) => template.retiredAt === null);
  const retired = templates.filter((template) => template.retiredAt !== null);
  const regimes = authorableRegimes();

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Incident notice templates</h1>
        <p className="text-sm text-ink-soft">
          Drafts offered when an incident owes somebody a notice. Name the regimes a draft belongs to and it is offered first on
          those duties, ahead of the shipped defaults; leave them empty and it is offered as a generic draft for any duty.
        </p>
        <p className="mt-1 text-xs text-ink-faint">
          Placeholders are filled from the incident: <code className="font-mono">{"{{ref}}"}</code>,{" "}
          <code className="font-mono">{"{{title}}"}</code>, <code className="font-mono">{"{{severity}}"}</code>,{" "}
          <code className="font-mono">{"{{phase}}"}</code>, <code className="font-mono">{"{{impact}}"}</code>,{" "}
          <code className="font-mono">{"{{regime}}"}</code>, <code className="font-mono">{"{{authority}}"}</code>,{" "}
          <code className="font-mono">{"{{dueAt}}"}</code>, <code className="font-mono">{"{{detectedAt}}"}</code>,{" "}
          <code className="font-mono">{"{{declaredAt}}"}</code>, <code className="font-mono">{"{{tenant}}"}</code>,{" "}
          <code className="font-mono">{"{{author}}"}</code>. Anything else is refused when you save it — including the fields a
          person fills in on the duty (<code className="font-mono">{"{{dataCategories}}"}</code>,{" "}
          <code className="font-mono">{"{{subjectCount}}"}</code>, <code className="font-mono">{"{{consequences}}"}</code>,{" "}
          <code className="font-mono">{"{{servicesAffected}}"}</code>, <code className="font-mono">{"{{scope}}"}</code>,{" "}
          <code className="font-mono">{"{{materialImpact}}"}</code>, <code className="font-mono">{"{{informationInvolved}}"}</code>,{" "}
          <code className="font-mono">{"{{whatYouCanDo}}"}</code>), which are allowed and reported as unfinished until they are
          filled in.
        </p>
      </div>

      {flash ? (
        <p className="rounded-xl2 border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">{flash}</p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
          {error}
        </p>
      ) : null}

      {live.length === 0 ? (
        <p className="rounded-xl2 border border-line bg-surface p-5 text-sm text-ink-soft">
          No drafts of your own yet — an incident&apos;s duties offer the shipped templates until you write one.
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-surface">
          {live.map((template) => (
            <li key={template.id} className="space-y-1 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{template.label}</span>
                <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand">
                  {audienceLabel(template.audience)}
                </span>
                {template.regimes.length === 0 ? (
                  <span className="rounded-full bg-amber/10 px-2 py-0.5 text-[11px] font-semibold text-amber">
                    generic
                  </span>
                ) : (
                  template.regimes.map((key) => (
                    <span key={key} className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
                      {regimes.find((regime) => regime.key === key)?.label ?? key}
                    </span>
                  ))
                )}
                {canManage ? (
                  <form action={retireCommsTemplateAction} className="ml-auto">
                    <input type="hidden" name="templateId" value={template.id} />
                    <input type="hidden" name="retired" value="true" />
                    <button type="submit" className="text-xs font-semibold text-pink hover:underline">
                      Retire
                    </button>
                  </form>
                ) : null}
              </div>
              <p className="text-sm text-ink">{template.subject}</p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xl2 border border-line bg-surface-muted px-2 py-1.5 font-mono text-[11px] text-ink-soft">
                {template.body}
              </pre>
              {template.guidance ? <p className="text-[11px] text-ink-faint">{template.guidance}</p> : null}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <form action={createCommsTemplateAction} className="space-y-3 rounded-xl2 border border-line bg-surface p-4">
          <h2 className="font-display text-base font-semibold text-ink">Write a draft</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium text-ink">
              Name
              <input name="label" required placeholder="e.g. Client breach notice (contract)" className={`block w-full ${inputClass}`} />
            </label>
            <label className="text-sm font-medium text-ink">
              Who it goes to
              <select name="audience" defaultValue="CLIENT" className={`block w-full ${inputClass}`}>
                {COMMS_AUDIENCES.map((audience) => (
                  <option key={audience} value={audience}>
                    {audienceLabel(audience)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <fieldset className="rounded-xl2 border border-line p-3">
            <legend className="px-1 text-xs font-semibold text-ink-soft">Regimes this drafts (none = any duty)</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {regimes.map((regime) => (
                <label key={regime.key} className="flex items-center gap-2 text-xs text-ink-soft">
                  <input type="checkbox" name="regimes" value={regime.key} />
                  {regime.label}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="block text-sm font-medium text-ink">
            Subject
            <input name="subject" required placeholder="Early warning — {{ref}}" className={`w-full ${inputClass}`} />
          </label>
          <label className="block text-sm font-medium text-ink">
            Body
            <textarea name="body" required rows={10} className={`w-full font-mono text-xs ${inputClass}`} />
          </label>
          <label className="block text-sm font-medium text-ink">
            What it must not forget (optional, one line)
            <input name="guidance" className={`w-full ${inputClass}`} />
          </label>

          <button type="submit" className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white">
            Save draft
          </button>
        </form>
      ) : (
        <p className="rounded-xl2 border border-line bg-surface p-4 text-sm text-ink-soft">
          You can read the drafts but not change them.
        </p>
      )}

      {retired.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-ink">Retired</h2>
          <p className="text-xs text-ink-faint">
            Kept rather than deleted, so a notice that cited one stays explainable. A retired draft is not offered on a duty.
          </p>
          <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-surface">
            {retired.map((template) => (
              <li key={template.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
                <span className="text-sm text-ink-soft">{template.label}</span>
                <span className="text-[11px] text-ink-faint">retired {template.retiredAt?.slice(0, 10)}</span>
                {canManage ? (
                  <form action={retireCommsTemplateAction} className="ml-auto">
                    <input type="hidden" name="templateId" value={template.id} />
                    <input type="hidden" name="retired" value="false" />
                    <button type="submit" className="text-xs font-semibold text-brand hover:underline">
                      Offer again
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
