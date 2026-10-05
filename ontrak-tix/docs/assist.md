# AI assist

The M7 assistant: **it proposes, and a person decides.** On one ticket it offers a
classification, a summary, a draft reply and a short list of similar tickets — and
there is no path from any of them to a sent message.

## What it produces

| Suggestion | What it is | Where it comes from |
| --- | --- | --- |
| Classification | type (`INCIDENT`/`REQUEST`), priority, and a queue | the words in the ticket; the queue from the desk's own queue names |
| Summary | one paragraph — what was reported and the latest reply | the transcript, quoted rather than paraphrased |
| Draft reply | a starting point addressed to the requester | a template, or the model when one is configured |
| Similar tickets | up to three other tickets, scored on shared words | this desk's own history |

Annotations live in [`../src/lib/assist-rules.ts`](../src/lib/assist-rules.ts)
(the pure decisions), [`../src/lib/ai-assist.ts`](../src/lib/ai-assist.ts) (the
model, when there is one), and
[`../src/lib/assist-service.ts`](../src/lib/assist-service.ts) (the read paths and
the decision audit).

## Opt-in per desk, and off by default

Two layers, doing different jobs:

| Switch | Effect |
| --- | --- |
| the tenant's **AI assist** setting (Integrations → AI assist) | this desk shows suggestions at all |
| `ONTRAK_AI_ENABLED` / `ONTRAK_AI_API_KEY` / `ONTRAK_AI_BASE_URL` | the shared gateway decides whether the *prose* is a model's |

The feature opt-in is **per tenant**, not a deployment-wide environment variable:
on a deployment serving several desks, one desk asking for an assistant must not put
one in front of another's agents. It defaults to **off** — a tenant that has never
been to the screen has not opted in, and the safest reading of silence is the one
that puts no assistant in front of an agent. Turning it on is `tenant:manage`, the
same weight as configuring the desk's identity provider, and the change is recorded
on the per-tenant hash chain as `assist.settings`. The setting lives on the tenant
row (`Tenant.assistEnabled`) and is read per request, so switching it off takes
effect on the next page rather than at the next deploy.

With the feature on and **no gateway configured**, every suggestion still appears: it
is computed from the ticket in front of it, which is what makes this usable on an
air-gapped deployment rather than a demo of somebody else's API.

The gateway itself is the same one the M7 outcome author uses
([`../src/lib/ai-gateway.ts`](../src/lib/ai-gateway.ts)): a vendor-neutral
chat-completions call, defaulting to the self-hosted OmniRoute on localhost with no
account and no key.

## It never sends

The guarantee is structural, not procedural:

- `AssistService` has four verbs — ask whether this desk has an assistant (`enabledFor`),
  `suggest`, `decide`, and `applyClassification`. There is no method that replies,
  reassigns, resolves or moves a ticket between agents, so there is nothing to disable.
- `applyClassification` is the only write, and it applies exactly three fields — the
  ticket's type, its priority and its queue — by delegating to the ticket service's own
  `reclassify`. That runs `ticket:update` on the ticket and writes a `ticket.reclassify`
  event, so an accepted suggestion can never be broader than an agent editing the same
  three fields by hand. A queue that is not one of this desk's is refused, not written.
- The draft is offered in the reply composer the same way a canned response is: a
  button that **fills the textarea**. The agent still edits and presses Send.
- A model may not supply the similar-ticket list. Similarity is a fact about this
  desk — these are the other tickets, and this is how much their text overlaps — so it
  is computed locally every time. A model can be wrong about the words; it must not be
  able to point an agent at a ticket that does not exist.
- The console states it in words, on the panel: *"Nothing here has been sent — apply
  the classification if it is right, accept what is useful and carry on."*

## Measurable and reversible

Every suggestion carries an **Accept** / **Dismiss** pair. A decision is appended to
the tenant's hash-chained audit log as `assist.accept` or `assist.dismiss`, naming the
kind (`CLASSIFICATION` · `SUMMARY` · `DRAFT_REPLY` · `SIMILAR`) and the source
(`model` or `rules`). The accept rate is then a query over one tenant's history, and
because the chain is append-only a dismissal is never quietly turned into an
acceptance. The event carries *which* suggestion and *where it came from*, never the
prose itself — a draft reply is not copied onto the assurance chain.

Recording a decision needs `ticket:update` on the ticket, not merely the ability to
read it: "I accepted the queue suggestion" is only meaningful from somebody who could
have changed the queue. Asking for a suggestion needs only `ticket:read:any`, because
there is nothing in a suggestion that is not already on the ticket.

Applying the classification records the same `assist.accept` event, extended with the
values that were applied (`applied: true`, the type, the priority and the queue). The
accept rate therefore counts an applied classification once, and the change is readable
from the decision alone rather than by cross-referencing `ticket.reclassify`.

A ticket's own decisions are read back off the chain onto its assistant panel, newest
first, so **what the desk turned down is evidence rather than a forgotten click**: "we
dismissed an urgent classification twice, and it was right both times" is a question
with an answer. Reading needs only `ticket:read:any`, and a decision that was also an
applied classification says so.

## Where it is used

On a ticket, staff see an **Ask the assistant** control. The first press is the one
that costs something, so a suggestion is produced *when asked for* — a query parameter
on the page — rather than on every ticket anybody opens. The panel renders the four
suggestions and their buttons; nothing is generated until somebody wants it.

## What comes next

Summaries and draft replies are still prose only — nothing writes them anywhere, and
neither can be sent from this module. The remaining M7 work is scale and analytics, not
the assistant: the judgement is cheap, the person is in the loop, and every decision is
on the record. A model may improve the prose, but the assistant's only write is a
classification through the ticket service.
