# The load rehearsal

M7's open item was a *recorded* result at the scale and latency §10 of the
roadmap states:

| Target | |
| --- | --- |
| Latency | p95 ticket read < **300 ms**, p95 write < **500 ms** |
| Scale | **10,000 agents / 1,000,000 tickets per tenant**, without re-platforming |

So there is a rehearsal for it — `npm run load-test` (`scripts/load-test.ts`) —
and this document is the record of the run. The raw result it wrote is beside this
file: [`load-test-2026-10-09.json`](./load-test-2026-10-09.json).

```
npm run load-test                     # the target: 10,000 agents / 1,000,000 tickets
npm run load-test -- --agents 500 --tickets 50000 --seconds 5
npm run load-test -- --concurrency 16 --keep --json /tmp/load.json
```

It is a script and not a test on purpose: it seeds a million rows, and the suite
has to stay runnable in seconds on a machine with no database. It creates a
tenant of its own (`loadtest-…`) and deletes it at the end, so a rehearsal never
touches a desk's data.

## What it measures, and where the boundary is

Four operations, each through the app's own Prisma-backed store and service —
not a hand-written query beside them:

| Operation | What it is | Why this one |
| --- | --- | --- |
| `read: ticket detail` | `store.findTicket(tenantId, id)` with its thread | the page an agent opens most |
| `read: inbox worklist` | `store.listTickets(tenantId)` | what the inbox, the dashboard, `/reports`, the portal and `GET /api/v1/tickets` all call |
| `write: create ticket` | `service.createTicket(actor, input)` | the heaviest write: reference, row, and the hash-chained audit event |
| `write: reply` | `service.reply(actor, id, body)` | the most frequent write: an append-only message and its audit event |

The reads and writes are issued concurrently (8 workers by default) for 20
seconds per stage, every call timed, so a number here is a p95 **under load**
rather than a single stopwatch reading. The inbox read is timed one call at a
time, because at target scale one call already *is* the whole worklist.

**The boundary, stated plainly:** this measures the data and service layer
in-process. It does not include HTTP, session handling or rendering, and it is one
process against one Postgres on one node — so it answers "can this layer serve a
tenant this size", not "what does a browser see". A number that passes here can
still be lost in a page that renders 20,000 rows.

## The recorded run — 2026-10-09

| | |
| --- | --- |
| Host | 16 CPUs, 22.9 GB RAM, Linux x64, Node v26.11.0 |
| Database | PostgreSQL 16 (`postgres:16-alpine`), the family stack's own container |
| Dataset seeded | **10,000 staff, 1,000,000 tickets, 600,000 messages** (one ticket in five carries a three-message thread) |
| Seeding | **92.4 s** (staff 0.5 s, tickets 63.4 s, messages 28.5 s) |
| Load | 8 concurrent workers, 20 s per stage, 3 whole-worklist reads |

| Operation | Samples | Throughput | p50 | **p95** | p99 | Target | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `read: ticket detail` | 64,901 | 3,245/s | 2.2 ms | **3.8 ms** | 7.0 ms | 300 ms | **met** |
| `write: reply` | 11,945 | 597/s | 12.4 ms | **18.9 ms** | 33.1 ms | 500 ms | **met** |
| `read: inbox worklist` | 0 of 3 | — | — | — | — | 300 ms | **not returned at all** |
| `write: create ticket` | 16 | 0.48/s | 15,118 ms | **18,707 ms** | 18,707 ms | 500 ms | **missed** |

**So the answer to "are §10's targets met?" is no — two of four operations, and
not marginal ones.** The two that pass pass comfortably. The two that fail fail
for the same reason, and it is a shape of bug rather than a slow query:

- **The whole-worklist read does not complete.** `listTickets` asks for every
  ticket in the tenant *with its messages included, unordered and unlimited*.
  At 1M tickets that is a result Prisma's engine will not hand to JavaScript at
  all — the call fails with `Failed to convert rust String into napi string`
  rather than returning slowly. There is no p95 to report because there is no
  successful sample, and that is the honest number: a desk this size cannot open
  its inbox.
- **A create is ~1.9 s per ticket, ~37× over target.** `nextTicketSeq` reads
  **every reference in the tenant** to find the highest and adds one. At 1M
  tickets that is a million-row read and a million strings moved into Node on
  every single create — before the row is written. This is why the write stage
  managed 16 creates in 33.5 s.

Both need the same kind of change, and neither is a tuning exercise: the worklist
read has to be **paged or filtered at the database** (the recall question needs
its own answer now that the list is not free), and the reference mark has to be
**held in a row and advanced**, rather than re-derived from a million refs.

## What the rehearsal found on the way — two real defects, fixed

The first run was not a formality. Under eight concurrent writers, writes to one
tenant failed twice over, and both were bugs a single-writer test cannot see:

1. **The audit chain lost its race.** Position in the chain is derived from the
   cached chain, so two appends racing for one tenant computed the *same* `seq`
   and one lost the insert to `@@unique([tenantId, seq])` — **after its ticket row
   had already been written**. The desk would see an error for work that had
   applied, with no evidence of it on the chain. `PrismaAuditSink` now appends one
   event at a time per tenant (keyed by tenant, so two desks never wait on each
   other) and re-reads the chain to retry a collision that came from another
   process.
2. **Reference allocation had the same shape.** `TIX-…` numbers come from the
   highest already issued, so 16 creates read the same mark, planned the same
   number and all but one were refused — with N writers the last needs N rounds,
   so no retry count is the answer. `TicketService` now serialises the
   allocation-and-insert per tenant, with the retry kept for another process.

Both are covered by
[`tests/tix-db.test.ts`](../tests/tix-db.test.ts) — *"concurrent writes to one
tenant are all accepted and all on the chain"*: 16 writers, three rounds, every
create accepted, one audit event per write, the chain verifying end to end, and no
reference issued twice. The write stage above (597 replies/s, zero failures) is
the same property under load.

## The follow-up run — 2026-10-24 (the reference mark)

The two fixes above were made, and this run measures the one that changes a
write: the reference mark is now a row (`TicketSequence`), bootstrapped once per
process from the highest existing ref and incremented atomically. The run is at
**500 agents / 50,000 tickets**, not the 1M target — the point was to check the
create path's shape after the fix without spending an hour seeding:

```
read: ticket detail   p95  44.6 ms   met   (target 300 ms)
write: create ticket  p95 408.2 ms   met   (target 500 ms)
write: reply          p95 188.8 ms   met   (target 500 ms)
read: inbox worklist  p95 20,795.6 ms  MISSED  (target 300 ms)
```

The create path is fixed: **408 ms p95** where the 2026-10-09 run had 18.7 s at a
million tickets, and the 50,000-ticket run before the fix had 2,238 ms because
every queued create waited behind the one-time bootstrap scan. The mark is now
seeded by the rehearsal itself (a real desk gets it from the first empty scan, or
from the row the migration creates), so the stage measures steady state.

The inbox read was **not** fixed in that run. `listTickets` still loaded every
ticket with its thread, and 50,000 rows already took twenty seconds.

The raw result is [load-test-2026-10-24.json](./load-test-2026-10-24.json).

## The inbox read, paged — 2026-10-24

Paging the inbox is now the code's shape rather than a plan:
`PrismaTicketStore.listInboxPage` takes the filter as a `WHERE`, the order as an
`ORDER BY` and the page as a `LIMIT`; `countInbox` is one `groupBy` plus the two
counts the header needs. "Open first" is not an enum order (`NEW` would sort above
an urgent `PENDING`), so `all` is read as two partitions — open, then closed — and
each partition's statuses are read separately and merged, so every read is served
by `Ticket_tenantId_status_priority_updatedAt_idx` handing back a sorted prefix
instead of Postgres sorting half the tenant.

The rehearsal was then run at the target again — **10,000 agents, 1,000,000
tickets, 600,000 messages**, host: 2 CPUs, 7.2 GB RAM, PostgreSQL 16 in a
container, seed 930.8 s — and this is what it recorded:

```
read: ticket detail   p95   28.2 ms   met     (target 300 ms, 5,466 samples)
write: create ticket  p95  357.0 ms   met     (target 500 ms,   432 samples)
write: reply          p95  204.8 ms   met     (target 500 ms,   907 samples)
read: inbox page      p95  464.8 ms   MISSED  (target 300 ms,     5 samples)
```

**Read that last row as a smoke test, not a p95.** The inbox stage times five
reads on purpose — at this size one page read is the expensive thing and the point
is its latency — so its "p95" is its slowest of five: p50 219.8 ms, max 464.8 ms.
The same two calls measured again on the same tenant with the writes finished gave
p50 116 ms and p95 235 ms, and the page read alone p50 59 ms. So the target is
**not settled** in either direction by that run, and this document does not claim
it is met.

What the numbers do say is where the cost sits: the page itself is a bounded read,
and the header counts (`groupBy` over the tenant, plus unassigned and urgent) are
the larger half of the request — one index-only scan per count over a million
rows. If the next run at 1M wants a verdict rather than an anecdote, it needs more
than five inbox samples (`--inbox-reads 60`) and, if it still misses, a count that
is maintained rather than counted.

The raw result is
[load-test-2026-10-24-inbox.json](./load-test-2026-10-24-inbox.json).

## The sixty-sample attempt — 2026-10-25

The next step named above was run, and it found a **defect in the rehearsal, not
in the inbox**. After seeding, `scripts/load-test.ts` ran
`VACUUM (ANALYZE)` on the million-row table. Postgres gives that statement
parallel maintenance workers by default, each asking for a shared-memory
segment, and the stock `postgres:16-alpine` container gives `/dev/shm` **64 MB**.
The ANALYZE died with code `53100` — `could not resize shared memory segment ...
No space left on device` — so the run stopped after the seed and never reached a
single read. The fix is `VACUUM (ANALYZE, PARALLEL 0)`: the statistics are the
same, only the ANALYZE's own wall clock changes, and that is not a number this
rehearsal reports.

The re-run was then started on the same host and stopped before it finished: two
CPUs carrying four retained million-row tenants from earlier rehearsals left the
machine at a load average in the forties, which measures the host's IO queue
rather than the inbox. Reporting a p95 from that would have been worse than
reporting none.

**The number was then taken without re-seeding.** `scripts/measure-inbox.ts`
times the same two shipped calls the inbox page makes — `listInboxPage` and
`countInbox` — 60 times, sequentially, against the tenant the earlier rehearsal
seeded (1,000,000 tickets, 600,000 messages, 10,000 staff), after three warm-up
reads. On 2026-10-25:

```
read: inbox page   p95   50.3 ms   (p50 42.9 ms, max 84.0)
read: header counts p95  79.5 ms   (p50 53.0 ms, max 90.8)
read: both          p95  132.7 ms  met   (target 300 ms, p50 96.3, max 144.4, 60 samples)
```

So the worklist read **meets its target** at a million tickets on this host, and
the header counts are the larger half of it exactly as predicted — but at 79.5 ms
p95 they are not the failure the five-sample run suggested. What changed between
the two readings is the tenant: this one had been through autovacuum and a warm
buffer cache, which is the steady state a real desk runs in, and the rehearsal's
`VACUUM (ANALYZE, PARALLEL 0)` is what makes a fresh tenant reach it.

The raw result is
[load-test-2026-10-25-inbox60.json](./load-test-2026-10-25-inbox60.json). What
this does not claim: it is one connection reading sequentially, not 16 workers
contending for the table, and it measures the read path rather than HTTP or
rendering.

## What this does not prove

- **One node.** No HA, no failover, no read replica — §10's availability claim
  (99.9%) is not touched by this rehearsal.
- **One database.** No connection pool tuning, no partitioning, no index review
  under real intake; the seeded data is written by bulk SQL, so it does not
  represent the write amplification of normal use (or of the rules engine, which
  the seeded rows never fired).
- **The service layer, not the app.** HTTP, sessions and rendering are outside
  it, as above.
- **A tenant four-fifths closed.** The seed is a desk's mix (20% new, 20% open,
  10% pending, 30% closed), not worst-case all-open work.

## Reproducing it

```
npm run setup                      # schema + seed, against the deployment's database
npm run load-test                  # the target: 10k agents / 1M tickets
npm run load-test -- --json out.json   # keep the raw result
```

`--keep` leaves the seeded tenant behind (useful for a query plan or an `EXPLAIN`
afterwards); without it the tenant is deleted. Expect the database to grow by
roughly 600 MB while the rehearsal runs, and expect **the cleanup to outlast the
rehearsal itself**: deleting a million tickets means a million deletes, each
checking the dozen tables that reference a ticket, and the rehearsal prints the
number itself: **587.5 s (9.8 minutes)** on the host above, after the last
measurement had been taken. That is not a bug in
the rehearsal — it is what removing a tenant that size costs in this schema, and
worth knowing before somebody schedules a job that does it.
