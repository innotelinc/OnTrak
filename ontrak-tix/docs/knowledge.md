# Knowledge base & deflection

M5's rules and macros act once a ticket exists. The knowledge base is the other
half of the same idea: answer the question *before* the ticket exists. An article
is either **public** — offered to requesters in the portal — or **staff-only**,
and the desk's own search sees both.

The guide covers what an article may be, how one is found, where suggestions
appear, and who may write one. The decisions are pure in
[`knowledge-rules.ts`](../src/lib/knowledge-rules.ts); the service that stores
them is [`knowledge-service.ts`](../src/lib/knowledge-service.ts); the console is
[`/knowledge`](../src/app/(desk)/knowledge/page.tsx).

## The model

| Field | What it is |
| --- | --- |
| `title` | required, unique case-insensitively — it is what a suggestion line shows |
| `body` | required; what the reader gets when they open the article |
| `visibility` | `PUBLIC` (shown to requesters) or `PRIVATE` (the desk's own notes) |
| `tags` | search words beyond the title and body, e.g. `vpn`, `printer`, `password` |

## How an article is found

Suggestion is not a search engine; it is the words a person typed, matched in
one deterministic pass:

1. The query is split into words. Words shorter than three letters and common
   stopwords ("the", "is", "for", …) are dropped, so *"the VPN is not working"*
   searches for `vpn` and `working`, not for `the` and `is`.
2. Each remaining word is matched against the article's **title** (weight 5), its
   **tags** (weight 3) and its **body** (weight 1).
3. Articles that matched are ordered by score, then by title, and the top five
   are returned.

It is pure, so the same query always produces the same list — which is what lets
a test pin the behaviour and a page say *why* an article was offered (the matched
words are shown beside the title).

**`PRIVATE` is a promise, not a label.** The requester's path
(`suggestPublic`) is handed public articles only, and that check lives in the
rules function rather than at each call site: there is exactly one place that
decides who may see what. An article with an unrecognised visibility is treated
as private — the safe side of the boundary.

## Where suggestions appear

- **The portal, before submission.** [`/portal/new`](../src/app/(desk)/portal/new/page.tsx)
  has a *Check our answers first* box. Typing a few words and pressing **Find
  help** is a plain `GET` form, so it works with no JavaScript; the matching
  articles are rendered **in full** in place (each a `<details>` element), and
  whatever was typed stays in the subject field below. Looking costs the
  requester nothing: if the articles do not help, the form is still there.
- **Staff quick-create.** [`/inbox/new`](../src/app/(desk)/inbox/new/page.tsx)
  carries the same box, with `includePrivate` turned on, so an agent can find the
  desk's own note as well as a published answer.

## The console

[`/knowledge`](../src/app/(desk)/knowledge/page.tsx) is where an article is
written, edited, published, made staff-only or removed.

- Every article carries a **public / staff-only** badge, and the flip is its own
  control: it is the one edit that changes who can read the article.
- An article is rendered with its tags and a short excerpt, and its **hazards are
  said out loud** — a tagless article is still findable, by the words in its
  title, but the writer is the one who can tell before it matters.
- Reading the knowledge base is `ticket:read:any`; writing, publishing and
  removing it are `ticket:update`, the same bar the desk's canned replies carry.

## Who decided that

Every write is on the audit chain with the article's title, visibility and tags:

| Action | Meaning |
| --- | --- |
| `knowledge.create` | a staff-only article was written |
| `knowledge.publish` | an article became readable by requesters — on creation, or on a later flip |
| `knowledge.unpublish` | a public article was made staff-only |
| `knowledge.update` | an article changed without changing who can read it |
| `knowledge.remove` | it was removed; the body is kept on the chain after the row is gone |

So "who made this public?" and "what did it say when it was shown to that
customer?" both have answers — even after the article has been edited or removed.

## What the articles are *not* answering

The same rules module also answers the other half of the question: the subjects
that matched **no article at all**. `findKnowledgeGaps` clusters them by the
words they share and `buildKnowledgeGapReport` counts how much of the desk ran
through them — the *Knowledge gaps* section of
[`/reports`](../src/app/(desk)/reports/page.tsx). A **repeat requester** sorts
first, because somebody asking the same unanswered question twice is the
clearest signal there is that an article is missing.

Two details matter when reading it:

- A **staff-only article counts as an answer.** The question is whether an
  answer exists, not whether a requester could have found it — the desk could
  have replied from a `PRIVATE` article. So a cluster matched by private content
  is a *publish* job, not a writing one.
- It is the **same suggestion engine** the portal runs, so "nothing matched"
  cannot mean one thing to a requester and another to the report.

See [reporting.md](./reporting.md) for the full picture.

## Tests

```bash
npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m5-knowledge.test.ts
npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m5-csat-knowledge-reporting.test.ts
```

`tix-m5-knowledge.test.ts` covers validation, the word/stopword split, the
title→tag→body weighting, the public/private boundary on both suggestion paths,
who may write and read, the publish-versus-edit audit events, tenant scoping and
the Prisma mapping.
