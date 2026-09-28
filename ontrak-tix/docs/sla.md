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
