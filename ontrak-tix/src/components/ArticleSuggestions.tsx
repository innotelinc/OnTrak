/**
 * Article suggestions (M5): the knowledge base answering a question before the
 * ticket is raised.
 *
 * Presentational and server-rendered: each suggestion is a `<details>` element,
 * so a requester opens the article in place without a line of JavaScript. The
 * caller has already scoped the list — the portal is handed public articles only
 * — so this component never decides who may read what.
 */

import { articleExcerpt, type ArticleSuggestion } from "../lib/knowledge-rules";

export function ArticleSuggestions({
  suggestions,
  title,
  note,
}: {
  suggestions: readonly ArticleSuggestion[];
  title: string;
  note: string;
}) {
  if (suggestions.length === 0) return null;

  return (
    <section aria-label="Suggested articles" className="space-y-3 rounded-xl2 border border-brand/40 bg-brand-soft/30 p-4">
      <div>
        <h2 className="font-display text-sm font-semibold text-ink">{title}</h2>
        <p className="mt-0.5 text-xs text-ink-faint">{note}</p>
      </div>
      <ul className="space-y-2">
        {suggestions.map((suggestion) => (
          <li key={suggestion.article.id} className="rounded-xl2 border border-line bg-surface px-3 py-2">
            <details>
              <summary className="cursor-pointer text-sm font-semibold text-ink">
                {suggestion.article.title}
                {suggestion.matched.length > 0 ? (
                  <span className="ml-1 font-normal text-ink-faint">· matched “{suggestion.matched.join("”, “")}”</span>
                ) : null}
              </summary>
              <p className="mt-1.5 whitespace-pre-wrap text-sm text-ink-soft">{articleExcerpt(suggestion.article.body, 1200)}</p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
