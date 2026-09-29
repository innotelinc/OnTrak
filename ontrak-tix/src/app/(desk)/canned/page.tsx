import { requireActor } from "../../../lib/session";
import { cannedServicesFor } from "../../../lib/db";
import { hasPermission } from "../../../lib/access-rules";
import { createCannedAction, deleteCannedAction } from "../../actions/tickets";

export const metadata = { title: "Canned responses" };

/**
 * The desk's shared reply library. Any staff member with `ticket:update` can add
 * or remove a response; the service re-checks that server-side.
 */
export default async function CannedPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const actor = await requireActor();
  const { flash, error } = await searchParams;
  const responses = await cannedServicesFor().list(actor.tenantId);
  const canManage = hasPermission(actor.role, "ticket:update");

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Canned responses</h1>
        <p className="text-sm text-ink-soft">
          Reusable replies offered as one-click fills in the ticket composer. Bodies may use{" "}
          <code className="font-mono text-xs">{"{{ref}}"}</code>, <code className="font-mono text-xs">{"{{subject}}"}</code>,{" "}
          <code className="font-mono text-xs">{"{{requester}}"}</code> and <code className="font-mono text-xs">{"{{agent}}"}</code>.
        </p>
      </div>

      {flash ? (
        <p className="rounded-xl2 border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-ok">{flash}</p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl2 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          {error}
        </p>
      ) : null}

      {responses.length === 0 ? (
        <p className="rounded-xl2 border border-line bg-surface p-5 text-sm text-ink-soft">No canned responses yet.</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-surface">
          {responses.map((response) => (
            <li key={response.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{response.title}</span>
                {response.shortcut ? (
                  <code className="rounded-full bg-brand-soft px-2 py-0.5 font-mono text-[11px] font-semibold text-brand">
                    /{response.shortcut}
                  </code>
                ) : null}
                {canManage ? (
                  <form action={deleteCannedAction} className="ml-auto">
                    <input type="hidden" name="id" value={response.id} />
                    <button type="submit" className="text-xs font-semibold text-bad hover:underline">
                      Remove
                    </button>
                  </form>
                ) : null}
              </div>
              <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-ink-soft">{response.body}</pre>
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <form action={createCannedAction} className="space-y-3 rounded-xl2 border border-line bg-surface p-4">
          <h2 className="font-display text-sm font-semibold tracking-wide text-ink uppercase">Add a response</h2>
          <label className="block text-sm">
            <span className="mb-1 block font-semibold text-ink">Title</span>
            <input
              name="title"
              required
              className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-semibold text-ink">Shortcut (optional)</span>
            <input
              name="shortcut"
              placeholder="reset"
              className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-semibold text-ink">Body</span>
            <textarea
              name="body"
              required
              rows={5}
              className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 font-mono text-sm text-ink"
            />
          </label>
          <button type="submit" className="rounded-full bg-brand px-4 py-2 text-xs font-semibold text-brand-ink">
            Save response
          </button>
        </form>
      ) : null}
    </div>
  );
}
