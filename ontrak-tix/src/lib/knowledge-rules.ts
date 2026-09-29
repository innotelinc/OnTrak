/**
 * Knowledge rules (M5): the articles a desk keeps, and how one is found.
 *
 * A knowledge base only earns its keep if it answers the question *before* the
 * ticket is raised, so the interesting part is not storage — it is suggestion.
 * Two decisions carry the design:
 *
 *  - **There is no regex and no index; there are words.** A suggestion is
 *    computed from the words a person typed, matched against the article's
 *    title, its tags and its body, weighted in that order. It is pure, so the
 *    same query yields the same list wherever it runs, and a person reading the
 *    code can say why an article was offered.
 *  - **Public is a promise, not a label.** A `PRIVATE` article is staff-only; the
 *    portal's suggestion path is asked for public articles only and never sees
 *    the rest. That check lives here, in one place, rather than in each caller.
 *
 * Validation happens at the point of writing, the way rules and macros do it: an
 * article that cannot be found is a private note with a public label.
 */

export type ArticleVisibility = "PUBLIC" | "PRIVATE";

export const ARTICLE_VISIBILITIES: readonly ArticleVisibility[] = ["PUBLIC", "PRIVATE"];

export function isArticleVisibility(value: unknown): value is ArticleVisibility {
  return typeof value === "string" && (ARTICLE_VISIBILITIES as readonly string[]).includes(value);
}

export interface KnowledgeArticle {
  id: string;
  tenantId: string;
  title: string;
  body: string;
  /** Public: offered to requesters in the portal. Private: staff only. */
  visibility: ArticleVisibility;
  /** Words a search matches on, beyond the title and body. */
  tags: readonly string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const ARTICLE_TITLE_MAX = 160;
export const ARTICLE_BODY_MAX = 20_000;
export const ARTICLE_TAG_MAX = 40;
export const MAX_ARTICLE_TAGS = 12;
/** How many suggestions a page offers. More than this is a search engine. */
export const MAX_SUGGESTIONS = 5;

export interface KnowledgeIssue {
  field: string;
  message: string;
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Everything wrong with an article, before it is stored.
 *
 * A public article with an empty body is worse than no article: it answers the
 * deflection prompt with nothing, which teaches a requester to stop reading the
 * prompts. So the title and the body are both required, and the tags are checked
 * while somebody is looking at the form.
 */
export function validateArticle(input: {
  title?: string;
  body?: string;
  visibility?: string;
  tags?: readonly string[];
}): KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];

  const title = input.title?.trim() ?? "";
  if (!title) issues.push({ field: "title", message: "A title is required." });
  else if (title.length > ARTICLE_TITLE_MAX) {
    issues.push({ field: "title", message: `The title may be at most ${ARTICLE_TITLE_MAX} characters.` });
  }

  const body = input.body?.trim() ?? "";
  if (!body) issues.push({ field: "body", message: "An article needs a body." });
  else if (body.length > ARTICLE_BODY_MAX) {
    issues.push({ field: "body", message: `The body may be at most ${ARTICLE_BODY_MAX} characters.` });
  }

  if (!isArticleVisibility(input.visibility)) {
    issues.push({ field: "visibility", message: "Choose whether the article is public or staff-only." });
  }

  const tags = (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  if (tags.length > MAX_ARTICLE_TAGS) {
    issues.push({ field: "tags", message: `An article may carry at most ${MAX_ARTICLE_TAGS} tags.` });
  }
  tags.forEach((tag, index) => {
    if (tag.length > ARTICLE_TAG_MAX) {
      issues.push({ field: `tags.${index}`, message: `A tag may be at most ${ARTICLE_TAG_MAX} characters.` });
    } else if (!/^[a-z0-9][a-z0-9 _-]*$/i.test(tag)) {
      issues.push({ field: `tags.${index}`, message: `“${tag}” is not a tag: letters, digits, spaces, dashes and underscores.` });
    }
  });

  return issues;
}

/**
 * What is worth saying out loud about an article.
 *
 * Deliberately short: a tagless article is *findable* — by the words in its
 * title — it is just harder to find, which is the one thing a writer can fix
 * before it matters.
 */
export function articleHazards(article: { tags?: readonly string[] }): string[] {
  const hazards: string[] = [];
  if ((article.tags ?? []).length === 0) {
    hazards.push("It has no tags, so it is only found by the words in its title and body.");
  }
  return hazards;
}

/* -------------------------------------------------------------------------- */
/*  Suggestion                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Words too common to mean anything. Dropping them is why "the printer is
 * broken" searches for "printer" and "broken" rather than for "the" and "is".
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "cannot", "did", "do", "does",
  "for", "from", "get", "has", "have", "how", "i", "if", "in", "is", "it", "its", "me", "my",
  "no", "not", "of", "on", "or", "our", "out", "please", "so", "that", "the", "their", "them",
  "then", "there", "this", "to", "up", "us", "was", "we", "what", "when", "where", "which",
  "who", "why", "will", "with", "you", "your",
]);

/** The words a query is actually about. Short words and stopwords are dropped. */
export function searchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
    ),
  ];
}

export interface ArticleSuggestion {
  article: KnowledgeArticle;
  score: number;
  /** The words that matched, so a page can say why the article was offered. */
  matched: readonly string[];
}

/** Split the comma-separated tag field a console form posts. */
export function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

const TITLE_WEIGHT = 5;
const TAG_WEIGHT = 3;
const BODY_WEIGHT = 1;

/**
 * The articles worth showing for a query, most relevant first.
 *
 * Pure and deterministic: the same articles and the same query produce the same
 * list, so a deflection prompt cannot drift from what a test asserts. `PRIVATE`
 * articles are left out unless the caller asks for them, which is the staff path.
 */
export function suggestArticles(
  articles: readonly KnowledgeArticle[],
  query: string,
  options: { includePrivate?: boolean; limit?: number } = {},
): ArticleSuggestion[] {
  const includePrivate = options.includePrivate ?? false;
  const terms = searchTerms(query);
  if (terms.length === 0) return [];

  const suggestions: ArticleSuggestion[] = [];
  for (const article of articles) {
    if (!includePrivate && article.visibility !== "PUBLIC") continue;
    const title = article.title.toLowerCase();
    const body = article.body.toLowerCase();
    const tags = article.tags.map((tag) => tag.toLowerCase());

    let score = 0;
    const matched = new Set<string>();
    for (const term of terms) {
      if (title.includes(term)) {
        score += TITLE_WEIGHT;
        matched.add(term);
      }
      if (tags.some((tag) => tag.includes(term))) {
        score += TAG_WEIGHT;
        matched.add(term);
      }
      if (body.includes(term)) {
        score += BODY_WEIGHT;
        matched.add(term);
      }
    }
    if (score > 0) suggestions.push({ article, score, matched: [...matched] });
  }

  return suggestions
    .sort((a, b) => b.score - a.score || a.article.title.localeCompare(b.article.title))
    .slice(0, options.limit ?? MAX_SUGGESTIONS);
}

/** A page-sized cut of an article's body, so a suggestion is readable in place. */
export function articleExcerpt(body: string, max = 280): string {
  const collapsed = body.trim().replace(/\s+/g, " ");
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/* -------------------------------------------------------------------------- */
/*  The gaps (M5)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What a knowledge base *failed* to answer is more actionable than what it did.
 *
 * A ticket whose words match no article is one the desk had to handle by hand,
 * and a requester who filed several of them is the clearest possible signal
 * that an article is missing. Both are derived from the same suggestion engine
 * the portal uses, so "nobody could have found an answer" means exactly that and
 * not a second, gentler definition invented for the report.
 *
 * Staff-only articles count as answers: the desk *could* have replied from one,
 * even though a requester could not have found it. The gate is whether an
 * answer exists, not whether it was reachable — a private article still needs to
 * be published, and that is a different finding.
 */

/** The minimum a ticket must expose to be judged against the knowledge base. */
export interface GapTicket {
  id: string;
  ref: string;
  subject: string;
  requesterId: string;
  clientId?: string | null;
  status: string;
  createdAt: string;
}

/** A cluster of unanswered questions: the words, and who kept asking them. */
export interface KnowledgeGap {
  /** The words the tickets have in common, most common first. */
  terms: string[];
  tickets: GapTicket[];
  /** Distinct requesters behind the cluster. */
  requesters: string[];
  /** One requester raised more than one of these — the repeat signal. */
  repeat: boolean;
}

/** How many words a gap cluster names before it stops being readable. */
export const GAP_TERM_LIMIT = 6;
/** How many gap clusters a report shows before it is a haystack. */
export const MAX_GAPS = 20;

export interface KnowledgeGapReport {
  gaps: KnowledgeGap[];
  /** Tickets weighed against the knowledge base. */
  considered: number;
  /** Tickets whose words matched no article at all. */
  unanswered: number;
  /** Distinct requesters among the unanswered tickets. */
  requesters: number;
  /** Share of tickets that found nothing, to one decimal place. */
  unansweredPercent: number | null;
}

/** The tickets whose subject matched no article, public or private. */
function unansweredTickets(
  articles: readonly KnowledgeArticle[],
  tickets: readonly GapTicket[],
): GapTicket[] {
  return tickets.filter((ticket) => {
    const terms = searchTerms(ticket.subject);
    if (terms.length === 0) return false;
    return suggestArticles(articles, ticket.subject, { includePrivate: true, limit: 1 }).length === 0;
  });
}

/**
 * Group the unanswered tickets into the questions behind them.
 *
 * Two tickets are about the same thing when their words overlap, transitively:
 * "vpn drops" and "vpn certificate" join through "vpn". A greedy pass in ticket
 * order is enough — a report does not need a clustering algorithm whose output
 * changes when the input order does.
 */
function clusterGaps(unanswered: readonly GapTicket[], limit: number): KnowledgeGap[] {
  const clusters: { terms: Set<string>; tickets: GapTicket[] }[] = [];

  for (const ticket of unanswered) {
    const terms = searchTerms(ticket.subject);
    const matches = clusters.filter((cluster) => terms.some((term) => cluster.terms.has(term)));
    if (matches.length === 0) {
      clusters.push({ terms: new Set(terms), tickets: [ticket] });
      continue;
    }

    const [first, ...rest] = matches;
    for (const term of terms) first.terms.add(term);
    first.tickets.push(ticket);
    for (const other of rest) {
      for (const term of other.terms) first.terms.add(term);
      first.tickets.push(...other.tickets);
      clusters.splice(clusters.indexOf(other), 1);
    }
  }

  return clusters
    .map((cluster) => {
      const requesters = [...new Set(cluster.tickets.map((ticket) => ticket.requesterId))].sort();
      return {
        terms: orderTerms(cluster.terms, cluster.tickets),
        tickets: [...cluster.tickets].sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.ref.localeCompare(b.ref),
        ),
        requesters,
        // More tickets than requesters means somebody raised at least two.
        repeat: cluster.tickets.length > requesters.length,
      };
    })
    .sort(byGapSeverity)
    .slice(0, limit);
}

/** The questions the knowledge base could not answer, repeats first. */
export function findKnowledgeGaps(
  articles: readonly KnowledgeArticle[],
  tickets: readonly GapTicket[],
  options: { limit?: number } = {},
): KnowledgeGap[] {
  return clusterGaps(unansweredTickets(articles, tickets), options.limit ?? MAX_GAPS);
}

/** The gap report as a whole: the clusters, and how much of the desk ran through them. */
export function buildKnowledgeGapReport(
  articles: readonly KnowledgeArticle[],
  tickets: readonly GapTicket[],
  options: { limit?: number } = {},
): KnowledgeGapReport {
  const unanswered = unansweredTickets(articles, tickets);
  return {
    gaps: clusterGaps(unanswered, options.limit ?? MAX_GAPS),
    considered: tickets.length,
    unanswered: unanswered.length,
    requesters: new Set(unanswered.map((ticket) => ticket.requesterId)).size,
    unansweredPercent: tickets.length === 0 ? null : round1((unanswered.length / tickets.length) * 100),
  };
}

/** The words most shared by the cluster, most common first. */
function orderTerms(terms: ReadonlySet<string>, tickets: readonly GapTicket[]): string[] {
  const counts = new Map<string, number>();
  for (const ticket of tickets) {
    for (const term of new Set(searchTerms(ticket.subject))) {
      if (terms.has(term)) counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return [...terms]
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, GAP_TERM_LIMIT);
}

/** Repeats first, then the widest cluster, then by first word. */
function byGapSeverity(a: KnowledgeGap, b: KnowledgeGap): number {
  return (
    Number(b.repeat) - Number(a.repeat) ||
    b.tickets.length - a.tickets.length ||
    (a.terms[0] ?? "").localeCompare(b.terms[0] ?? "")
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The articles a new desk starts with. Shipped as defaults rather than empty,
 * because an empty knowledge base is never filled in — and because the first
 * ticket a desk raises is usually one of these.
 */
export const DEFAULT_KNOWLEDGE_ARTICLES: readonly {
  title: string;
  body: string;
  visibility: ArticleVisibility;
  tags: readonly string[];
}[] = [
  {
    title: "Reset your password",
    visibility: "PUBLIC",
    tags: ["password", "login", "account", "sign in"],
    body:
      "If you cannot sign in, use the “Forgot password” link on the sign-in screen and follow the emailed reset link.\n\n" +
      "The link is valid for one hour. If it has expired, request a new one. If the email does not arrive, check " +
      "your spam folder before raising a ticket — and say so in the ticket if you do.",
  },
  {
    title: "Connect to the VPN from home",
    visibility: "PUBLIC",
    tags: ["vpn", "remote", "network", "home"],
    body:
      "Install the company VPN client, sign in with your usual work account, and connect to the “office” profile " +
      "before opening any internal site.\n\n" +
      "If the connection drops every few minutes, note the exact time it last dropped when you raise a ticket — " +
      "the network team can look that up precisely.",
  },
  {
    title: "The printer will not print",
    visibility: "PUBLIC",
    tags: ["printer", "printing", "queue", "hardware"],
    body:
      "Check the printer is switched on and shows no error, then check your own print queue for a stuck job — " +
      "a paused job blocks everything behind it.\n\n" +
      "If the queue is clear and the printer is idle, raise a ticket with the printer's name and its location.",
  },
];
