/**
 * Saved views (M0/M1): the chip strip above the worklist.
 *
 * Presentational and no-JS: each chip is a link to the filter it stores, and
 * "save this view" posts the filter currently on screen as JSON. The service
 * re-sanitizes and re-checks access, so nothing here is a control.
 */

import { inboxFilterQuery } from "../lib/inbox-view";
import type { InboxFilter } from "../lib/inbox-rules";
import { describeInboxFilter, sameFilter, type SavedView } from "../lib/saved-view-rules";

export interface SavedViewsProps {
  views: SavedView[];
  activeFilter: InboxFilter;
  /** The caller's id, so only their own views get a remove button. */
  actorId: string;
  /** Whether the caller may share a view with the desk. */
  canShare: boolean;
  basePath?: string;
  saveAction: (formData: FormData) => Promise<void>;
  deleteAction: (formData: FormData) => Promise<void>;
}

function viewHref(basePath: string, filter: InboxFilter): string {
  const qs = inboxFilterQuery(filter);
  return qs ? `${basePath}?${qs}` : basePath;
}

export function SavedViews({ views, activeFilter, actorId, canShare, basePath = "/inbox", saveAction, deleteAction }: SavedViewsProps) {
  return (
    <section aria-label="Saved views" className="flex flex-wrap items-center gap-2">
      {views.map((view) => {
        const active = sameFilter(view.filter, activeFilter);
        return (
          <span key={view.id} className="inline-flex items-center overflow-hidden rounded-full border border-line">
            <a
              href={viewHref(basePath, view.filter)}
              aria-current={active ? "true" : undefined}
              title={describeInboxFilter(view.filter)}
              className={`px-3 py-1 text-xs font-semibold ${active ? "bg-brand text-brand-ink" : "bg-surface text-ink-soft hover:text-brand"}`}
            >
              {view.name}
              {view.shared ? <span className="ml-1">· shared</span> : null}
            </a>
            {view.ownerId === actorId ? (
              <form action={deleteAction}>
                <input type="hidden" name="id" value={view.id} />
                <button
                  type="submit"
                  aria-label={`Remove view ${view.name}`}
                  className="px-2 py-1 text-xs text-ink-faint hover:text-pink"
                >
                  ✕
                </button>
              </form>
            ) : null}
          </span>
        );
      })}

      <form action={saveAction} className="ml-auto flex flex-wrap items-center gap-2">
        <input type="hidden" name="filter" value={JSON.stringify(activeFilter)} />
        <input
          name="name"
          required
          placeholder="Save this view as…"
          aria-label="New view name"
          className="rounded-xl2 border border-line bg-surface px-3 py-1.5 text-xs text-ink"
        />
        {canShare ? (
          <label className="flex items-center gap-1 text-xs text-ink-soft">
            <input type="checkbox" name="shared" className="size-3.5 accent-brand" />
            Shared
          </label>
        ) : null}
        <button type="submit" className="rounded-full bg-surface-muted px-3 py-1.5 text-xs font-semibold text-ink-soft">
          Save view
        </button>
      </form>
    </section>
  );
}
