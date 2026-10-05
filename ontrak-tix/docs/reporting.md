# Satisfaction dashboard & knowledge gaps

[`/reports`](../src/app/(desk)/reports/page.tsx) is the dispatcher's screen. It
began with SLA attainment and timings (M1), grew a per-client scorecard (M4),
in M5 it gained the two views that answer *"how did this feel?"* and
*"what could we have answered ourselves?"*, and in M7 it gained the trend and
the agent/queue scorecards — *"which way are we going, and who is carrying it?"*.

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

## Trends, agents and queues (M7)

The report's M7 additions are in
[`analytics-rules.ts`](../src/lib/analytics-rules.ts), and they exist to answer two
questions a snapshot cannot: **which way the volume is going**, and **who is carrying
the work**.

`ticketTrends(tickets, now, days)` buckets *created* and *closed* work per UTC day and
reads off the backlog left behind. Two decisions are the point of it:

- **A day's backlog is recomputed from timestamps, not read off today's status.** A
  point for last week says what was open *then*; a chart that redrew its own history
  every time somebody closed a ticket would be worse than no chart. A ticket closed
  with no `closedAt` falls back to `resolvedAt`; one with neither is still open.
- **"Up from nothing" is not a percentage.** Each total is compared with the window
  immediately before it, and a previous window of zero reports `null` rather than a
  fake `+∞%`.

`agentScorecards` and `queueScorecards` are the same function with a different key.
Each bucket is scored by the *same* `buildSlaReport` the desk-wide figures come from,
so an agent's attainment cannot drift from the report it was drawn off. And the buckets
are built from the **records**, not from a supplied roster:

- A group with no work is **absent**, not a zero row that hides the ones that matter.
- Work with no group — an unassigned ticket, a ticket with no queue — is a row of its
  own, because the parts must add up to the whole.
- Work in a queue that has since been removed is still scored, under its id, rather
  than dropped.

The rows sort **most-breached first, then largest backlog, then worst resolution
attainment** — the order a dispatcher reads, so the group about to cost the desk a
promise is at the top and a big-but-healthy backlog does not outrank a breach. As
everywhere else, a bucket with no applicable SLA policy reports that count
(`withoutPolicy`) rather than a flattering `100%`.

### Forecasting the backlog (M7)

`forecastVolume(trend, { horizonDays, basisDays })` projects the backlog forward from
the trend above. It is deliberately a **straight line and not a model**: intake and
closures are held at their mean over the last `basisDays` (seven by default) and poured
into the backlog, and `outlook` names the result — `clearing`, `stable` or
`accumulating`. The question worth answering is "at this rate, is the desk falling
behind?", and a moving average answers it; a curve fitted to three weeks of a small
desk's data would only look more certain than it is. The daily figures are rounded for
reading, but the running backlog is carried at full precision, so fourteen days of
rounding cannot drift into a wrong total.

### SLA risk (M7)

`buildSlaReport` says what **is** breached and what is already in its warning window;
both are facts about the clocks as they stand. `slaRisk(tickets, policies, now,
horizonMinutes)` answers the question a lead acts on instead — **what will breach if
nobody touches it?** Every open ticket is placed on the running clock nearest its
deadline (a met response leaves the resolution clock driving) and banded by how much of
the horizon — `240` business minutes by default — is left:

| Band | Meaning |
| --- | --- |
| `critical` | past the target already |
| `high` | a breach is inside a quarter of the horizon |
| `medium` | a breach is inside the horizon |
| `low` | beyond the horizon |

A ticket three hours from its target is on no at-risk list yet, and is exactly the one
worth seeing while there is still time to answer it. The list is built on
`buildSlaReport`, so it can never disagree with the breach tables beside it; a ticket
whose clocks are both met contributes nothing, a paused clock is flagged rather than read
as safe, and a ticket with no policy is counted in `withoutPolicy` rather than dropped.

## Tests

```bash
npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m5-csat-knowledge-reporting.test.ts
npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m7-analytics.test.ts
```

`tix-m5-csat-knowledge-reporting.test.ts` covers the distribution over an empty
scale, comment filtering and ordering, the per-group response rate and the
null-average-last order, the word split and clustering (transitivity, ordering
and the repeat flag), the private-article rule, the empty-subject case and the
empty-report case.

`tix-m7-analytics.test.ts` covers the trend bucketing and backlog-at-day-end, the
prior-window change and the null-it-from-zero case, the per-assignee and per-queue
split (absent empty groups, removed queues kept, `withoutPolicy` surfaced, the sort
order), the projection's arithmetic and its four outlooks, and the risk bands — the
nearest running clock chosen, a met response leaving the resolution clock, an
accumulating desk, a paused clock flagged, and a resolved or policy-less ticket
excluded and counted.
