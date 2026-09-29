# Satisfaction dashboard & knowledge gaps

[`/reports`](../src/app/(desk)/reports/page.tsx) is the dispatcher's screen. It
began with SLA attainment and timings (M1), grew a per-client scorecard (M4),
and in M5 it gained the two views that answer *"how did this feel?"* and
*"what could we have answered ourselves?"*.

Both are pure reductions — computed in
[`csat-rules.ts`](../src/lib/csat-rules.ts) and
[`knowledge-rules.ts`](../src/lib/knowledge-rules.ts) from records the rest of
the product already writes — so a report can never disagree with the survey a
requester answered or the article the portal offered.

## The satisfaction dashboard

The ratings a desk collects live on resolved tickets, and the desk-wide *CSAT*
stat at the top of the report is only the average. The dashboard exists because
**an average hides the shape of the answers**: one person who scored 1 and one
who scored 5 also average 3, and they are not the same desk. So it carries four
things:

| Element | Why it is there |
| --- | --- |
| **Average, positive %, response rate** | The rate matters as much as the score: a 5 from four people out of fifty is a different finding from a 5 out of five. |
| **The distribution** | Every point on the scale, *including the ones nobody picked*. A missing 1 is visibly a zero rather than an absent row. |
| **By agent** | The same answers split by whoever earned them, worst first — so the first row is the one somebody can act on. A group with no answers yet sorts **last**: no data is not "doing badly". |
| **In their words** | The comments people actually typed. "The wait was fine but nobody explained" is the finding a bar chart cannot carry. |

`csatDashboard(surveys, offered)` builds the summary, the distribution and the
comments; `csatByGroup(entries, labelOf)` splits them by an attributed group
(an agent id on `/reports`, since a survey row names only its ticket). A group's
response rate is computed from the surveys *it* was offered, not from the desk's
total, so the per-agent figure is as honest as the desk-wide one.

## The knowledge-gap report

A ticket whose subject matches **no article at all** is one the desk answered by
hand. That is the article backlog, written by the desk's own tickets — so it is
worth reading, which is why the report does not stop at a count.

1. Each ticket's subject is run through the *same* pure suggestion engine the
   portal uses. Words shorter than three letters and stopwords are dropped, so
   a subject made entirely of stopwords is not a gap — there was no question to
   fail to answer.
2. The unmatched subjects are clustered by the words they share, **transitively**:
   "vpn drops" and "vpn certificate" join through `vpn` and become one question
   rather than two reports. A greedy pass in ticket order is deliberately
   deterministic — a report whose output changes with input order is not a
   report.
3. Clusters whose tickets come from **more requesters than tickets** — i.e. one
   person raised more than one — are marked `repeat` and sort **first**. A
   requester who keeps coming back with the same unanswered question is the
   loudest signal a desk gets that an article is missing.
4. The report also states how much of the desk ran through gaps at all
   (`unansweredPercent` over the tickets considered).

Two decisions are worth stating out loud:

- **A staff-only article counts as an answer.** The gate is whether *an* answer
  exists, not whether a requester could have found it — the desk could have
  replied from a `PRIVATE` article. So a match on private content is not a gap;
  the finding for it is "publish it", which is a different (and cheaper) job
  than writing one.
- **Nothing is computed twice.** `findKnowledgeGaps` and
  `buildKnowledgeGapReport` both call the same `unansweredTickets` helper, so
  adding a cluster view cannot change what "unanswered" means.

## Tests

```bash
npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m5-csat-knowledge-reporting.test.ts
```

`tix-m5-csat-knowledge-reporting.test.ts` covers the distribution over an empty
scale, comment filtering and ordering, the per-group response rate and the
null-average-last order, the word split and clustering (transitivity, ordering
and the repeat flag), the private-article rule, the empty-subject case and the
empty-report case.
