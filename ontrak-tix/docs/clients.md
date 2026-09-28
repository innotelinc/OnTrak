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

- **Authoring a client's own policies from the console.** The schema
  (`SlaPolicy.clientId`), the resolver and the display are ready, and the ladder
  is exercised on it; today a client policy is inserted directly rather than
  written on a form.
- **Branding and portal identity.** A client's own logo, colours and portal
  greeting are M4 work that has not started; a requester's portal is still the
  desk's.
- **Time tracking, rate cards and invoice exports**, the **rota and shift
  handoff**, and **per-client attainment and a client-facing CSAT survey** are
  the rest of M4 and are untouched.
- **Client-scoped queues.** A queue knows nothing about clients yet, so the same
  queue serves every client and the ladder's queue rung is shared.
