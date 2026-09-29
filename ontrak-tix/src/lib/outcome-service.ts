/**
 * The outcome service: closing the loop on solved work.
 *
 * WHAT IT DOES, IN ORDER
 * For every resolved ticket it has not seen before: read the transcript, ask the
 * author for a draft, write the article into the knowledge base, and hand the
 * scenario to OnTrak ITS. Then never do it again for that ticket.
 *
 * WHY IT IS A SWEEP RATHER THAN A HOOK ON "RESOLVE"
 * Tickets are resolved in five places — the desk's status form, the bulk action,
 * the public API, the e-mail intake, and Sentinel's alert promotion — and a hook in
 * each one is five places to forget. A sweep is one place that asks a single
 * question, "which resolved tickets have no article yet?", and it is idempotent by
 * construction, so running it twice, or on a schedule, costs nothing. It is the same
 * shape as the SLA sweep, the retention sweep and the SCIM sweep, for the same
 * reason.
 *
 * IDEMPOTENCY IS A TAG, NOT A TABLE
 * The marker is an article tag: `tix:<ref>`. An article that names the ticket it
 * came from is a fact the desk wants anyway — a reader can see what the article was
 * written from — and it means the loop needs no new table, no migration, and no
 * second place where "was this ticket processed?" can be wrong.
 *
 * Every dependency is injected, so the whole thing is exercised in tests without a
 * database, a model or a network.
 */

import type { Actor } from "./access-rules";
import { handOffScenario, type HandoffResult, type ItsConfig } from "./its-client";
import { itsConfig } from "./its-client";
import type { KnowledgeService } from "./knowledge-service";
import type { ArticleInput } from "./knowledge-service";
import {
  hasResolution,
  ticketMarker,
  MAX_TAGS,
  type ArticleVisibility,
  type OutcomeDraft,
  type OutcomeTranscript,
} from "./outcome-rules";

/** The prefix every loop-written article carries, so the sweep can find them. */
const MARKER_PREFIX = "from-ticket-";

/** What the service is allowed to do to the knowledge base. */
export type OutcomeKnowledge = Pick<KnowledgeService, "list" | "create">;

export interface OutcomeDeps {
  /** Who the article is attributed to. A system actor, not a person. */
  actor: Actor;
  knowledge: OutcomeKnowledge;
  /** How a draft is written. The author module, or a fake in a test. */
  author: (ticket: OutcomeTranscript) => Promise<OutcomeDraft>;
  /** Where the scenario goes. */
  its?: ItsConfig;
  fetchImpl?: typeof fetch;
  /** The visibility of every article this produces. Private unless asked otherwise. */
  visibility?: ArticleVisibility;
}

export type OutcomeStatus = "written" | "skipped" | "refused";

export interface OutcomeReport {
  ref: string;
  status: OutcomeStatus;
  /** Why it was skipped or refused, in words an operator can act on. */
  reason?: string;
  articleId?: string;
  /** Which author wrote it, and the reason when a model did not. */
  source?: OutcomeDraft["source"];
  note?: string;
  its?: HandoffResult;
  /**
   * The drafts themselves, on a dry run only.
   *
   * A preview that reports a title and nothing else cannot answer the question a
   * preview exists for — is this prose good enough to publish? — so the dry run
   * carries the article and the scenario in full and writes neither.
   */
  draft?: OutcomeDraft;
}

/**
 * Author what a sweep would write, and write nothing.
 *
 * The same refusals as the real pass, in the same order, so a preview is a preview
 * of *this* sweep and not of an idealised one: a ticket resolved without a public
 * reply is reported as skipped here too, rather than quietly missing from the
 * preview and then missing from the article count.
 */
export async function previewOutcomes(
  tickets: readonly OutcomeTranscript[],
  author: (ticket: OutcomeTranscript) => Promise<OutcomeDraft>,
): Promise<OutcomeReport[]> {
  const reports: OutcomeReport[] = [];
  for (const ticket of tickets) {
    if (!hasResolution(ticket)) {
      reports.push({
        ref: ticket.ref,
        status: "skipped",
        reason: "resolved with no public reply, so there is no resolution to write down",
      });
      continue;
    }
    const draft = await author(ticket);
    reports.push({
      ref: ticket.ref,
      status: "written",
      source: draft.source,
      note: draft.note,
      draft,
      reason: `would write “${draft.article.title}” and hand “${draft.scenario.title}” to OnTrak ITS`,
    });
  }
  return reports;
}

/**
 * Write down every resolved ticket that has not been written down yet.
 *
 * Called with a tenant's resolved tickets. Tickets with no resolution are skipped
 * with a reason rather than quietly dropped: "this was resolved without anybody
 * telling the customer anything" is worth seeing on a sweep report.
 */
export async function writeOutcomes(
  tickets: readonly OutcomeTranscript[],
  deps: OutcomeDeps,
): Promise<OutcomeReport[]> {
  const existing = await deps.knowledge.list(deps.actor);
  const tagged = new Set<string>();
  const titles = new Set<string>();
  if (existing.ok) {
    for (const { article } of existing.value) {
      titles.add(article.title.toLowerCase());
      for (const tag of article.tags) {
        if (tag.toLowerCase().startsWith(MARKER_PREFIX)) tagged.add(tag.toLowerCase());
      }
    }
  } else {
    // If the knowledge base cannot be read, nothing may be written: without the
    // list there is no way to tell a new article from a duplicate, and duplicates
    // are exactly what an idempotent sweep is for.
    return tickets.map((ticket) => ({
      ref: ticket.ref,
      status: "refused" as const,
      reason: `the knowledge base could not be read: ${existing.error}`,
    }));
  }

  const config = deps.its ?? itsConfig();
  const reports: OutcomeReport[] = [];

  for (const ticket of tickets) {
    if (!hasResolution(ticket)) {
      reports.push({
        ref: ticket.ref,
        status: "skipped",
        reason: "resolved with no public reply, so there is no resolution to write down",
      });
      continue;
    }

    const marker = ticketMarker(ticket.ref);
    if (tagged.has(marker)) {
      reports.push({ ref: ticket.ref, status: "skipped", reason: "already written down" });
      continue;
    }

    const draft = await deps.author(ticket);
    const title = availableTitle(draft.article.title, ticket.ref, titles);
    if (!title) {
      reports.push({
        ref: ticket.ref,
        status: "refused",
        reason: `an article called “${draft.article.title}” already exists and neither name was free`,
      });
      continue;
    }

    const input: ArticleInput = {
      title,
      body: draft.article.body,
      visibility: deps.visibility ?? draft.article.visibility,
      // The marker is added here rather than trusted from the author: it is this
      // service's idempotency key, and a model that omits it would make the sweep
      // write a second article on the next run. It goes first and the whole list is
      // bounded, so neither a long subject nor a chatty model can push it out or
      // push the count past what the knowledge base accepts.
      tags: dedupe([marker, ...draft.article.tags]).slice(0, MAX_TAGS),
    };

    const created = await deps.knowledge.create(deps.actor, input);
    if (!created.ok) {
      reports.push({ ref: ticket.ref, status: "refused", reason: created.error });
      continue;
    }

    tagged.add(marker);
    titles.add(title.toLowerCase());

    const its = await handOffScenario(ticket.ref, draft.scenario, { config, fetchImpl: deps.fetchImpl });

    reports.push({
      ref: ticket.ref,
      status: "written",
      articleId: created.value.id,
      source: draft.source,
      note: draft.note,
      its,
    });
  }

  return reports;
}

/**
 * A title that is not already taken.
 *
 * The knowledge base refuses a duplicate title, and two tickets about the same
 * broken thing legitimately have the same subject — so the second one is named after
 * the ticket it came from rather than refused. A third collision is refused, because
 * at that point something is generating tickets rather than solving them.
 */
export function availableTitle(title: string, ref: string, taken: ReadonlySet<string>): string | null {
  const base = title.trim().slice(0, 140);
  if (!taken.has(base.toLowerCase())) return base;
  const withRef = `${base} (${ref})`;
  if (!taken.has(withRef.toLowerCase())) return withRef;
  return null;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}

/**
 * The system actor the article is attributed to.
 *
 * Attribution matters: an article nobody wrote is one nobody is answerable for, so
 * these are attributed to a named, non-human actor that any reader can recognise in
 * the byline and that the audit chain can filter on.
 */
export function outcomeActor(tenantId: string): Actor {
  return { id: "system:outcome-author", tenantId, role: "ADMIN" };
}
