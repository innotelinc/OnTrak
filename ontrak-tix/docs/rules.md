# Automation rules

M5 starts with the one feature that acts on *every* ticket rather than on one:
a rule. This guide covers what a rule may be, what it may do, when it runs, and
the two places it can be read — the console at [`/rules`](../src/app/(desk)/rules/page.tsx)
and the audit chain.

## The model

| Model | What it is |
| --- | --- |
| `Rule` | a trigger, the conditions that narrow it, and the actions it takes |
| `RuleTrigger` | `ticket.created`, `ticket.updated` or `ticket.replied` |
| `RuleCondition` | one field, one comparison, one value — **all** conditions must hold |
| `RuleAction` | one of eight things to do: set a field, route, assign, tag, notify, reply, escalate |
| `RulePlan` | what the matched rules would do to one ticket, and what outvoted what |
| `Ticket.tags` | tags applied by hand or by `add_tag`; a scoring axis, not a classification |

The decisions are pure and framework-free in
[`src/lib/rule-rules.ts`](../src/lib/rule-rules.ts); the service that stores them
is [`src/lib/rule-service.ts`](../src/lib/rule-service.ts), its Prisma adapter is
[`src/lib/rule-store-prisma.ts`](../src/lib/rule-store-prisma.ts), and the part
that touches real tickets is [`src/lib/rule-intake.ts`](../src/lib/rule-intake.ts).

## What a rule may not be

Four refusals carry the design, and each one exists because the alternative is
a failure nobody sees until it has hit every ticket:

- **No OR.** Conditions are ANDed. "Which rule did this?" should have one
  answer, so a rule that wants an alternative is two rules — cheaper to read than
  an expression language nobody can predict.
- **No regex.** A pattern is a small program. A rule is only worth anything if a
  person reading it can say what it will do to the ticket in front of them.
- **No duplicated names.** Names are unique case-insensitively, the same rule the
  SLA policies follow: two rules called "Monitoring alerts" are a support ticket
  of their own, because nobody can tell which one fired.
- **No silent outvoting.** Rules run in `position` order and the **first** rule to
  set a field owns it; a later rule that wanted the same field is recorded as
  *skipped, with the reason* and named on the chain. Tags accumulate, and so do
  the outward-facing actions, because dropping one quietly is the failure
  automation exists to prevent.

Any rule that cannot be evaluated is refused at the point of writing — an
unknown field, an unknown comparison, a missing value — rather than tolerated at
evaluation time, where it would look like automation while quietly doing nothing.

## When a rule runs

The engine is wired into [`TicketService`](../src/lib/ticket-service.ts), which
every intake path already goes through, so a rule fires wherever a ticket is:

| Trigger | Fires from |
| --- | --- |
| `ticket.created` | quick-create (`/inbox/new`), the requester portal, inbound email, alert promotion |
| `ticket.updated` | a status move or an assignment |
| `ticket.replied` | a reply on the thread, including an inbound email appended to an existing ticket |

On creation the rules run **before the row is written**, so a ticket is born with
the priority, queue, assignee and tags the desk asked for: one insert, and no
window in which the inbox shows work the rules have not seen.

Each firing appends one `ticket.rules` event naming the rules that matched, every
action that took effect and every action an earlier rule outvoted. "Why did this
arrive urgent?" is then answerable months later, after the rule has been edited
or deleted.

An `add_tag`, `set_priority`, `set_type`, `route_queue` or `assign_agent` action
changes the ticket. A `reply` action appends a public message from the desk
(`authorId: null`) and stops the response clock — the customer *has* been
answered. `notify` raises an in-app staff notice; `escalate` pages the on-call
audience. An effect that cannot be delivered is recorded as attempted and never
loses the ticket: the write and the chain entry come first.

## The console

[`/rules`](../src/app/(desk)/rules/page.tsx) is the one place a rule can be
written, moved, switched off or removed.

- Reading needs `ticket:read:any` — an agent who cannot see why a ticket arrived
  urgent cannot explain it to the customer. Writing, moving, switching and
  removing need `rule:manage`.
- Every rule is rendered as sentences rather than as the rows it was typed in,
  and its **hazards are said out loud**: a rule with no conditions matches
  everything, an automatic reply leaves the desk without an agent reading the
  thread, an escalation pages whoever is on call.
- **A preview of a switched-off rule runs it as if it were on**, because that is
  the moment the question is asked. The dry run is the same `evaluateRules` +
  `planTicketChanges` the live path uses, over the last 50 tickets with their
  requester addresses resolved, so the answer cannot drift from what switching
  the rule on will do. Nothing is written.
- **The order is visible and changeable.** The first rule to set a field owns it,
  so the position *is* the policy; a console that could write rules but not
  reorder them would leave a desk retyping everything to fix one. A new rule
  always runs last, so adding one cannot change what the rules already in place
  do.

## Who decided that

Every write is on the audit chain with the rule's *whole body*, not just the
field that moved:

| Action | Meaning |
| --- | --- |
| `rule.create` | a rule was written, with its conditions and actions |
| `rule.update` | a rule changed; the body recorded is the one *after* the change |
| `rule.enable` / `rule.disable` | it was switched on or off |
| `rule.move` | its position changed — a policy change, since position decides who wins |
| `rule.delete` | it was removed; the body is kept on the chain after the row is gone |
| `ticket.rules` | a firing: the rules that matched, what they applied, what they skipped |

So "who made the desk reply to everything from that address?" has an answer, and
so does "which rule made this urgent?" — even after both have been changed.

## Tests

```bash
npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m5-rules.test.ts
npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m5-rule-intake.test.ts
```

`tix-m5-rules.test.ts` covers the engine, the service, the console's two
questions (a switched-off rule previewed as if on, and a reorder) and reading a
rule form back in; `tix-m5-rule-intake.test.ts` covers what a rule does to a
stored ticket — the priority it was born with, the firing on the chain, the reply
that stopped the clock and the effect that failed without losing the ticket.
