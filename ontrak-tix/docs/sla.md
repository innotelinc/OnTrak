# SLA engine & escalation sweep

OnTrak Tix measures every ticket against an **SLA policy** and raises an
**escalation** before a target is missed, not after. This guide covers how the
pieces fit and how to schedule the sweep.

## The model

- **`SlaPolicy`** — a response target and a resolution target, in *business*
  minutes, scoped to one priority (`priority` null = the fallback for every
  other priority). `calendar` holds the business-hours definition as JSON and
  `warningFraction` sets where the "warning" state begins (default `0.2`).
- **`Ticket.firstResponseAt`** — set the moment an **agent** posts the first
  *public* reply. A requester's own reply, or an internal note, never stops the
  response clock.
- Two clocks per ticket, both derived (never stored) so a policy edit applies
  immediately: **response** and **resolution**.

The pure engine lives in [`src/lib/sla-rules.ts`](../src/lib/sla-rules.ts):
business-minute arithmetic over a fixed-UTC-offset calendar (with holidays),
deadline computation, and the `met` / `on-track` / `warning` / `breached` states.

> **Calendar note.** A calendar carries a fixed `utcOffsetMinutes`, which is exact
> for zones without DST and a deliberate approximation otherwise. Real DST
> handling is a backlog item.

### Closures: the days the desk is shut

A weekly pattern says "we work 09:00–17:00". It does not say *which* of those days
the desk does not work at all, and every promise runs through that question: a
four-hour first-response target issued on Christmas Eve is not a four-hour promise
if nobody is back until the 27th. Each promise therefore carries a list of
**closures**, edited in the same form as its hours — one date per line, `#` for a
comment, and a label after the date (`2026-12-25 Christmas Day`) is read and
discarded, because the calendar stores dates and a clock has no use for a name.

The rules are [`src/lib/holiday-rules.ts`](../src/lib/holiday-rules.ts), and they
are all about a hand-typed date being able to break a promise:

- **A date must be a day that exists.** `2026-02-30` is refused rather than rolled
  forward to the 2nd of March — a closure nobody meant is a target calculated
  against a day the desk was open.
- **The list is normalised, not stored as typed.** Sorted, de-duplicated and
  capped at 200, so two equal lists are one list and the cost is the same number
  twice.
- **A refused list saves nothing.** A half-applied closure is a clock that keeps
  running through a day the desk meant to be shut, so the write is refused whole
  with the reason.
- **A save that says nothing about closures keeps them.** The form carries them,
  but a programmatic edit that only renames a promise must not clear the desk's
  shutdown days — the field is `undefined` when it has nothing to say.

The console states the consequence rather than the count: `2 closures · 16
business hours off every promise · next 2026-12-25 (in 24 days)`. A closure on a
day the desk is shut anyway costs zero, and the console says so rather than
hiding it: a desk that lists every Saturday has bought itself no time at all.

On read, the list is re-normalised: the `calendar` column is JSON, so a date
typed straight into the database, or written by an older build, must not put a
closure the clock cannot interpret in front of a running promise. A holiday that
does not survive normalisation is dropped, which fails towards the desk being
**open** — the safe direction, since the alternative is a promise that silently
never falls due.

A ticket with no matching policy has no clock. The report counts those tickets
explicitly rather than scoring them, because "no SLA" must be visible.

## The escalation ladder

[`src/lib/escalation-rules.ts`](../src/lib/escalation-rules.ts) defines a ladder.
A running clock climbs it as it consumes its target, and each rung widens the
audience:

| Level | When | Audience |
| --- | --- | --- |
| 1 | 50% of the window used | `AGENT` |
| 2 | 80% — approaching the deadline | `DISPATCHER` |
| 3 | Deadline passed | `MANAGER` |

Level 2 is the point of the feature: a dispatcher learns about a ticket *before*
it breaches.

## The sweep

`POST /api/sla/sweep` walks every open ticket's clocks and raises each rung that
has not been raised yet. Every rung carries a `dedupeKey` of
`<ticketId>:<kind>:<level>` and is unique per tenant, so **the sweep is
idempotent** — run it as often as you like; a redelivery never double-fires.

```bash
# one tenant
curl -X POST -H "Authorization: Bearer $ONTRAK_TIX_CRON_SECRET" \
  "http://localhost:3000/api/sla/sweep?tenant=acme"

# every tenant
curl -X POST -H "Authorization: Bearer $ONTRAK_TIX_CRON_SECRET" \
  "http://localhost:3000/api/sla/sweep"
```

Response:

```json
{ "status": "ok", "raised": 2, "tenants": [{ "tenant": "acme", "tickets": 12, "raised": 2 }] }
```

Each raised rung writes an `SlaEscalation` row (visible in the UI and on
`/reports`) **and** an `sla.escalate` audit event, so the notice is part of the
tamper-evident history.

### Authentication

Set `ONTRAK_TIX_CRON_SECRET` to a long random string; the caller sends it as
`Authorization: Bearer …` (or `x-ontrak-secret`). It falls back to
`ONTRAK_TIX_WEBHOOK_SECRET`, and **fails closed** (401) when neither is set.

### Scheduling

Run it on a short interval — every minute or two is fine given the idempotency.
Any scheduler works:

```bash
# crontab: every two minutes
*/2 * * * * curl -fsS -X POST -H "Authorization: Bearer $ONTRAK_TIX_CRON_SECRET" \
  https://tix.example.com/api/sla/sweep > /dev/null
```

A managed scheduler (a platform cron, a Kubernetes `CronJob`, a GitHub Actions
schedule) is equivalent — it is one authenticated POST.

## Reporting

`/reports` (staff only) renders the numbers a lead runs the desk on, all derived
from the same clocks by [`src/lib/report-rules.ts`](../src/lib/report-rules.ts):
open/closed/unassigned, response and resolution **attainment**, median and p90
business-minute timings, the **breached** and **at-risk** lists, the open
escalations, and the CSAT roll-up.
