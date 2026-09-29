# Macros

M5's rules act on *every* ticket a trigger reaches, with nobody asking. This is
their deliberate counterpart: a **macro** is a saved sequence an agent runs on
the ticket in front of them. Same actions, same engine — applied because a person
decided.

The guide covers what a macro may be, what running one does, and the two places
it can be read: the console at [`/macros`](../src/app/(desk)/macros/page.tsx) and
the audit chain.

## A rule and a macro are two ends of one thing

| | Rule | Macro |
| --- | --- | --- |
| Who starts it | a trigger (`ticket.created`/`updated`/`replied`) | an agent, on one ticket |
| Conditions | the ones that narrow it | **none** — if it needs one, it is a rule |
| What it does | the eight actions in `rule-rules.ts` | the same eight actions |
| Who owns a field | the *first* rule to set it | the *first* action in the macro to set it |
| Permission to write | `rule:manage` | `rule:manage` |
| Permission to run | — (it fires by itself) | `ticket:update` |
| Audit action | `ticket.rules` (actor `rules:<trigger>`) | `ticket.macro` (actor is the agent) |

The actions are shared, not copied. A macro is planned by `planMacro`, which
folds its actions through the same `planTicketChanges` the live rule path uses,
and every action written is judged by the same `validateActions`. So "set the
priority, then tag it" cannot mean one thing when a rule says it and another when
a person does.

## What a macro may not be

- **No conditions and no trigger.** A person has already looked at the ticket;
  that is the whole point. If a shortcut needs to decide *whether* it applies, it
  is a rule.
- **No silent outvoting.** Two actions in one macro cannot both set the same
  field, so the first wins and the second is recorded as *skipped, with the
  reason* — rather than letting the last one win on a position nobody re-read.
- **No unknown actions.** An unknown kind, a bad priority, an empty tag or a
  reply with nothing to say is refused when the macro is written, not tolerated
  when it is run, where it would look like a shortcut while quietly doing nothing.
- **No duplicate names.** Names are unique case-insensitively, the same rule the
  rules and SLA policies follow: two macros called "Escalate to L2" are a support
  ticket of their own, because an agent cannot tell from the picker which they are
  running.

## What running one does

A macro is run from the ticket itself — the **Shortcut** picker on the ticket
detail offers the enabled macros the agent may run. One click applies every
action, in order:

- `set_priority`, `set_type`, `route_queue`, `assign_agent` and `add_tag` change
  the ticket. Tags accumulate; a tag already on the ticket is not added twice.
- `reply` appends a public message from the desk (`authorId: null`) and stops the
  response clock — the customer *has* been answered — exactly as an agent's own
  first public reply does.
- `notify` and `escalate` reach staff through the same sink the rules use, marked
  as the macro's, so the notice names the shortcut rather than a rule.

Two rules about the run itself:

- **The rules are not re-run.** An explicit instruction from an agent must not be
  silently outvoted by automation that fires on `ticket.updated` — the agent
  looked at the ticket and decided. The ticket's `updatedAt` still moves, so the
  work reads as recently touched.
- **The run is attributed to the agent.** A rule acts as `rules:<trigger>` because
  nobody was there; a macro acts as the person who chose it. The `ticket.macro`
  event names both the agent and the macro, so "who reassigned this?" and "what
  did the shortcut do?" are two facts on one line.

A retired macro (switched off) is kept, not deleted, and **cannot be run**; past
runs still read back against it.

## The console

[`/macros`](../src/app/(desk)/macros/page.tsx) is the one place a macro is
written, edited, retired or removed.

- Reading needs `ticket:read:any` — an agent who cannot see what a shortcut will
  do is an agent who cannot explain the ticket it changed. Writing, retiring and
  removing need `rule:manage`.
- Every macro is rendered as sentences rather than as the rows it was typed in,
  and its **hazards are said out loud**: an automatic reply leaves the desk under
  its own name without an agent reading the thread, an escalation pages whoever is
  on call. There is no catch-all warning, because a macro has no conditions to
  catch everything with.
- The form serves both add and edit: opening a macro's **Edit** link pre-fills the
  rows, and the same form saves it back.

## Who decided that

Every write is on the audit chain with the macro's *whole body*, and every run is
its own event:

| Action | Meaning |
| --- | --- |
| `macro.create` | a macro was written, with its actions |
| `macro.update` | a macro changed; the body recorded is the one *after* the change |
| `macro.enable` / `macro.disable` | it was made available or retired |
| `macro.delete` | it was removed; the body is kept on the chain after the row is gone |
| `ticket.macro` | a run: the agent, the macro, what it applied and what it skipped |

So "who made one click reassign this to the network team?" has an answer, and so
does "what did that shortcut do to this ticket?" — even after the macro has been
edited or removed.

## Tests

```bash
npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m5-macros.test.ts
```

`tix-m5-macros.test.ts` covers what a macro may be, that it is planned by the
rule engine's own planner, who may write one and who may read one, and what
running one does to a *stored* ticket — the priority and tags it applied, the
reply that stopped the clock, the notices it raised, the run on the chain, that
the rules did not re-run, that a retired macro is refused, and that another
tenant's macro is simply absent.
