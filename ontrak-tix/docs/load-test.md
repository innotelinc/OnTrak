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
afterwards); without it the tenant is deleted, which takes as long as a
million-row delete does — budget a few minutes, and expect the database to grow
by roughly 600 MB while the rehearsal is running.
