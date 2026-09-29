import { redirect } from "next/navigation";

import { requireActor } from "../../../lib/session";
import { hasPermission } from "../../../lib/access-rules";
import { knowledgeServicesFor } from "../../../lib/db";
import { articleExcerpt } from "../../../lib/knowledge-rules";
import type { ArticleOverview } from "../../../lib/knowledge-service";
import { removeArticleAction, saveArticleAction, setArticleVisibilityAction } from "../../actions/knowledge";

export const metadata = { title: "Knowledge" };

/**
 * The knowledge console (M5).
 *
 * The point of the knowledge base is to answer a question *before* the ticket is
 * raised, so this screen is built around one distinction: an article is either
 * **public** — offered to requesters in the portal, before they submit — or
 * **staff-only**. That is the one thing an author must not get wrong, so it is a
 * badge on every article and its own toggle, and the service records a publish
 * as its own event.
 *
 * Reading needs `ticket:read:any`; writing, publishing and removing need
 * `ticket:update`, the same bar the desk's canned replies carry.
 */
const inputClass = "w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink";

/** One article: what it is, who can read it, and what can be done to it. */
function ArticleCard({ entry, canManage }: { entry: ArticleOverview; canManage: boolean }) {
  const { article, hazards } = entry;
  const isPublic = article.visibility === "PUBLIC";

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">{article.title}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            isPublic ? "bg-ok/10 text-ok" : "bg-surface-muted text-ink-faint"
          }`}
        >
          {isPublic ? "public" : "staff-only"}
        </span>
        {canManage ? (
          <span className="ml-auto flex flex-wrap items-center gap-2 text-xs font-semibold">
            <a href={`/knowledge?article=${article.id}`} className="text-brand hover:underline">
              Edit
            </a>
            <form action={setArticleVisibilityAction}>
              <input type="hidden" name="articleId" value={article.id} />
              <input type="hidden" name="visibility" value={isPublic ? "PRIVATE" : "PUBLIC"} />
              <button type="submit" className="text-ink-soft hover:text-brand">
                {isPublic ? "Make staff-only" : "Publish"}
              </button>
            </form>
            <form action={removeArticleAction}>
              <input type="hidden" name="articleId" value={article.id} />
              <button type="submit" className="text-bad hover:underline">
                Remove
              </button>
            </form>
          </span>
        ) : null}
      </div>

      {article.tags.length > 0 ? (
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {article.tags.map((tag) => (
            <li key={tag} className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] text-ink-soft">
              {tag}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-1.5 text-sm text-ink-soft">{articleExcerpt(article.body)}</p>

      {hazards.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-xs text-attention">
          {hazards.map((hazard) => (
            <li key={hazard}>⚠ {hazard}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string; article?: string }>;
}) {
  const actor = await requireActor();
  if (!hasPermission(actor.role, "ticket:read:any")) redirect("/portal");

  const { flash, error, article: articleId } = await searchParams;
  const canManage = hasPermission(actor.role, "ticket:update");

  const listed = await knowledgeServicesFor().list(actor);
  const articles = listed.ok ? listed.value : [];
  const listError = listed.ok ? null : listed.error;
  const editing = articleId ? (articles.find((entry) => entry.article.id === articleId)?.article ?? null) : null;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Knowledge</h1>
        <p className="text-sm text-ink-soft">
          Articles the desk can answer from. A <strong>public</strong> article is offered to requesters in the portal
          before they raise a ticket; a <strong>staff-only</strong> one is the desk&rsquo;s own notes. Suggestions are
          matched on the words in a title, its tags and its body.
        </p>
      </div>

      {flash ? <p className="rounded-xl2 border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-ok">{flash}</p> : null}
      {error ?? listError ? (
        <p role="alert" className="rounded-xl2 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          {error ?? listError}
        </p>
      ) : null}

      {articles.length === 0 ? (
        <p className="rounded-xl2 border border-line bg-surface p-5 text-sm text-ink-soft">
          No articles yet. Until one is written the desk answers every question by hand.
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-surface">
          {articles.map((entry) => (
            <ArticleCard key={entry.article.id} entry={entry} canManage={canManage} />
          ))}
        </ul>
      )}

      {canManage ? (
        <form action={saveArticleAction} className="space-y-3 rounded-xl2 border border-line bg-surface p-4">
          <h2 className="font-display text-sm font-semibold tracking-wide text-ink uppercase">
            {editing ? `Edit “${editing.title}”` : "Add an article"}
          </h2>
          {editing ? <input type="hidden" name="articleId" value={editing.id} /> : null}

          <label className="block text-sm">
            <span className="mb-1 block font-semibold text-ink">Title</span>
            <input name="title" required defaultValue={editing?.title ?? ""} className={inputClass} />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-semibold text-ink">Body</span>
            <textarea name="body" required rows={7} defaultValue={editing?.body ?? ""} className={`${inputClass} font-mono`} />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-ink">Who can read it</span>
              <select name="visibility" defaultValue={editing?.visibility ?? "PRIVATE"} className={inputClass}>
                <option value="PRIVATE">Staff-only</option>
                <option value="PUBLIC">Public — shown in the portal</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-ink">Tags (comma-separated)</span>
              <input name="tags" defaultValue={editing?.tags.join(", ") ?? ""} placeholder="vpn, network" className={inputClass} />
            </label>
          </div>

          <div className="flex items-center gap-3">
            <button type="submit" className="rounded-full bg-brand px-4 py-2 text-xs font-semibold text-brand-ink">
              {editing ? "Save article" : "Add article"}
            </button>
            {editing ? (
              <a href="/knowledge" className="text-xs font-semibold text-ink-soft hover:text-brand">
                Cancel
              </a>
            ) : null}
          </div>
        </form>
      ) : (
        <p className="text-xs text-ink-faint">
          You can read the desk&rsquo;s articles; writing and publishing them is a staff member&rsquo;s job.
        </p>
      )}
    </div>
  );
}
