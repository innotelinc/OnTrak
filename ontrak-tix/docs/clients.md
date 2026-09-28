# Clients, scope, and acting as a client

M4 starts with the thing that changes when one desk serves many companies: the
promise is no longer one promise, and neither is the worklist. This guide covers
the client model, the SLA ladder it extends, the scope that keeps two clients
apart, and the most dangerous convenience in an MSP helpdesk — looking through a
client's eyes.

## The model

| Model | What it is |
| --- | --- |
| `Client` | a company the desk serves |
| `Contact` | a person at a client, with an address a reply can reach |
| `ClientAssignment` | which staff member serves which client — **the row is the scope** |
| `ClientActAsSession` | a recorded window in which somebody is looking through a client's eyes |
| `SlaPolicy.clientId` / `queueId` | which client (or queue) a promise belongs to, when it is not the desk's |

The rules are pure and framework-free in
[`src/lib/client-rules.ts`](../src/lib/client-rules.ts); the service that stores
what they decide is [`src/lib/client-service.ts`](../src/lib/client-service.ts)
with its Prisma adapter in
[`src/lib/client-store-prisma.ts`](../src/lib/client-store-prisma.ts).

Two decisions are worth stating out loud, because they are what the rest of the
design follows from:

- **Reading is scoped, writing is managed.** Any staff member may read the
  clients they are in scope for — that is what makes a worklist make sense.
  Creating a client, adding a contact, assigning an agent or starting an act-as
  window needs `client:manage` (ADMIN and DISPATCHER hold it; AGENT does not).
- **The assignment is the scope.** Scope is computed from the assignment rows on
  every call, by one function, so a page cannot forget to apply it and a stale
  cache cannot widen it.

## The SLA ladder

M1 resolved a promise by priority alone. M4 makes it a ladder, **most specific
first** (`resolveSlaPolicy` in
[`src/lib/sla-rules.ts`](../src/lib/sla-rules.ts)):

1. the **client's** policy for this priority,
2. the client's catch-all (a policy with no priority),
3. the **queue's** policy for this priority, then its catch-all,
4. the **desk's** policy for this priority, then its fallback,
5. and — for a deployment whose only policies are queue-scoped — the pre-M4
   behaviour, so adding clients to the ladder cannot leave an existing desk with
   no SLA at all.

The resolution reports `scope` (`client` | `queue` | `tenant` | `none`) **and a
sentence saying which rung answered**, because "which SLA applied, and why?" is
the first question asked when a client claims a breach. The console prints that
sentence next to each priority rather than paraphrasing it:

> URGENT — 30m to respond · 240m to resolve *(because the tenant's URGENT
> policy: Urgent)*

Scoping is by **match, not exclusion**: a policy that names no client applies to
every client (and a policy that names no queue to every queue). That is what
keeps the M1 policies — written before clients existed — working unchanged, and
it is why `resolveSlaPolicy({ policies, priority })` on a ticket with neither a
client nor a queue resolves exactly as it did before M4. The resolver's consumers
are the inbox SLA flags, the dispatcher report's attainment figures and the
escalation sweep, so all three agree about which promise is running: they call
one function.

### Writing a promise

A promise is authored on `/clients` — a form on each client for theirs, and a
"desk's own promises" section for the ones that apply to every client without
one. `SlaPolicyService` (`src/lib/sla-policy-service.ts`) is the only way in, and
it decides four things:

- **Who may write.** `queue:manage` (ADMIN, DISPATCHER). Reading the promises is
  any staff member's; promising is the desk's to make.
- **What is a promise at all.** A name, a first-response and a resolution target
  in minutes *of the chosen calendar*, a scope (this client, the desk, a
  priority or every priority), and a **warning fraction**. A blank field is not a
  zero and a zero is not a promise: both are refused by name. Resolution may not
  be due before the first response.
- **The hours.** Two presets — weekdays 09:00–17:00, or around the clock — rather
  than a free-form calendar nobody can be sure they authored correctly.
- **That it can be explained later.** Every write is an audit event
  (`sla.policy.create` / `.update` / `.delete`) carrying the scope, both targets
  and the calendar it was written on.

Two rules follow from the record rather than from taste. An **edit that does not
mention the scope keeps it**, so a form carrying only the numbers cannot quietly
turn a client's contract into the desk's default. And a promise that tickets are
measured against **cannot be deleted** — the refusal says how many tickets are
holding it — because their clocks are the record of what was promised, and a
deleted policy turns a defensible breach into an argument. Edit it instead.

Naming is unique per tenant, case-insensitively: two promises differing in case
are one argument about which applied.

## Scope: who sees which client's work

`clientScopeFor` answers that, and the answer is deliberately blunt:

- `queue:manage` means "runs the desk", so ADMIN and DISPATCHER see **every**
  client.
- An agent sees the clients they are **assigned to**.
- Work that records **no client** stays visible to everybody. It belongs to the
  desk rather than to a client, and a desk that only sometimes records the client
  would otherwise quietly hide its own work.

`scopeByClient` is the filter, and it returns the list rather than a predicate —
so a caller has to apply it to get rows back at all. The inbox worklist applies
it *before* anything else is computed (SLA flags, saved views, counts), which is
what makes every number on the page a number about the rows the reader may see.
An agent assigned to two clients never sees a third's work.

The client dimension is only one of the dimensions of visibility; a requester's
own-ticket scope and the queue filters are enforced where they always were.

## Acting as a client

"View the portal as the client" is the most dangerous convenience in the product:
done casually it is indistinguishable from the client acting. So
`actAsClientDecision` requires four things, each of which somebody had to argue
for:

- the **`client:manage`** permission — looking through a client's eyes is the
  strongest read there is;
- the client actually being **in the actor's scope**, so act-as is not a way
  around the scoping above;
- a **reason** of at least a few characters, because "why was this looked at?" is
  the question an audit asks, and a blank one is not an answer;
- **no window already open**, so two identities are never live in one session.

A window lasts `ACT_AS_TTL_MINUTES` (30) and is **recorded twice**: as a row the
console can show ("Acting as Northwind Logistics — since …, until …, because: …")
and as an audit event (`client.act_as.start`, with the reason; `client.act_as.end`
with the closing note). An act-as that only lived in a cookie would be invisible
to the record, which is exactly the failure mode to design out. An expired window
reads as closed without anybody having to tidy up, and a different administrator
cannot close somebody else's window — that belongs to the person who opened it.

## Per-client reporting

`/reports` carries a **By client** table, and `/reports/export?scope=clients`
exports it. Each row is one client's work — open, breached, at risk, first-response
and resolution attainment, and their satisfaction — plus a row for **work that
names no client**, which is the one every desk forgets and which is why the client
figures otherwise add up to less than the desk.

Two decisions worth naming:

- **The figures are built by `buildSlaReport`, once per client.** Not a second
  implementation of attainment: the same function, run over a client's tickets, so
  a client's number can never disagree with the report it was read off.
- **Worst first** — most breaches, then worst resolution attainment, then name,
  with "nothing measurable" last. A report whose first row is the client about to
  call is a report somebody can act on, and "no data" must not sort like "doing
  badly".

## Their own rating: the client-facing survey

The M1 survey asks the person whose ticket it was. That is the wrong person at an
MSP — the buyer is usually not the requester. So a client can also be asked
directly, on `/clients`:

1. **Ask for a rating** for a period (periods are `YYYY-MM-DD` and must have
   happened — a month that has not finished invites a rating of an unfinished
   story). Asking needs `client:manage`, for a client in the actor's scope, and
   **one survey per client per period**: asking again returns the same link, and
   the database enforces the same key, because asking twice for the same month is
   how a client learns to ignore the question.
2. **Send the link.** It opens a public page (`/survey/<token>`) that names the
   client, names the period, and takes a 1–5 rating and an optional comment. It
   needs **no account** — the token is the credential — because a survey behind a
   sign-in is answered by whoever happens to have one. The link answers **once**
   and expires after `CLIENT_SURVEY_TTL_DAYS` (45).
3. **Read it back** on the client's row (the score in words, the comment), and in
   the per-client CSAT on `/reports`, which counts both questions the desk asks —
   the ticket one and the client one — because a client's satisfaction is not
   "whichever survey they happened to use".

The page is the only write in the product a stranger can reach, so it does exactly
one thing: record the answer to the survey that token names. Both halves land on
the audit chain — `client.survey.request` (a person) and `client.survey.respond`
(attributed to `client:survey`, which is precisely who could have sent it).

## The console

`/clients` is staff-only (`ticket:read:any`) and shows, for each client in the
reader's scope: its promise per priority *with the rung that answered*, its
contacts, the staff assigned to it, and the forms to add a contact, assign or
remove somebody, and start or stop an act-as window. The forms appear only with
`client:manage`; without it the page says so instead of rendering controls that
would be refused.

Everything the service refuses is phrased for the person reading it in the
console — "That person already serves this client", "`dana@…` is already a
contact at another client", "Acting as a client needs a reason on the record" —
rather than as a stack trace.

## What is not here yet

- **Queue-scoped promises have no form.** The schema, the resolver and the
  ladder's queue rung all take one (`SlaPolicy.queueId`), and the console shows
  one in a client's ladder when it wins, but the authoring form only writes a
  client's promise or the desk's. Queue administration is its own screen.
- **Holidays and multiple concurrent SLAs.** A calendar carries fixed weekly
  windows and a UTC offset; holidays, DST and more than one promise running on a
  ticket at once are backlog.
- **Branding and portal identity.** A client's own logo, colours and portal
  greeting are M4 work that has not started; a requester's portal is still the
  desk's.
- **The rota and shift handoff** is the remaining M4 slice, and is untouched:
  there are no on-call schedules or coverage windows yet. (Time, rates and
  invoices are in [docs/billing.md](./docs/billing.md).)
- **Client-scoped queues.** A queue knows nothing about clients yet, so the same
  queue serves every client and the ladder's queue rung is shared.
