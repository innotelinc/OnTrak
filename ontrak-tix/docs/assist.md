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

## Opt-in, and off by default

Two switches, doing different jobs:

| Switch | Effect |
| --- | --- |
| `ONTRAK_TIX_ASSIST_ENABLED=1` | this desk shows suggestions at all |
| `ONTRAK_AI_ENABLED` / `ONTRAK_AI_API_KEY` / `ONTRAK_AI_BASE_URL` | the shared gateway decides whether the *prose* is a model's |

Only a deliberate `1` turns the feature on — `yes` and `true` are ignored, because a
typo should not put an assistant in front of a desk. With the feature on and **no
gateway configured**, every suggestion still appears: it is computed from the ticket
in front of it, which is what makes this usable on an air-gapped deployment rather
than a demo of somebody else's API.

The gateway itself is the same one the M7 outcome author uses
([`../src/lib/ai-gateway.ts`](../src/lib/ai-gateway.ts)): a vendor-neutral
chat-completions call, defaulting to the self-hosted OmniRoute on localhost with no
account and no key.

## It never sends

The guarantee is structural, not procedural:

- `AssistService` has three verbs — read the switch, `suggest`, `decide`. There is no
  method that replies, reassigns, resolves or moves a queue, so there is nothing to
  disable.
- The draft is offered in the reply composer the same way a canned response is: a
  button that **fills the textarea**. The agent still edits and presses Send.
- A model may not supply the similar-ticket list. Similarity is a fact about this
  desk — these are the other tickets, and this is how much their text overlaps — so it
  is computed locally every time. A model can be wrong about the words; it must not be
  able to point an agent at a ticket that does not exist.
- The console states it in words, on the panel: *"Nothing here has been applied or
  sent."*

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

## Where it is used

On a ticket, staff see an **Ask the assistant** control. The first press is the one
that costs something, so a suggestion is produced *when asked for* — a query parameter
on the page — rather than on every ticket anybody opens. The panel renders the four
suggestions and their buttons; nothing is generated until somebody wants it.

## What comes next

Applying an accepted classification on the agent's behalf is a later M7 slice, and it
will go through the ticket service's own permission checks like every other write. The
assistant's job now is to make the judgement cheap and keep the person in the loop.
