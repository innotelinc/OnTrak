/**
 * The M7 load rehearsal: does one tenant the size of the stated target answer
 * inside the stated latency?
 *
 *   npm run load-test                          # the target: 10,000 agents / 1,000,000 tickets
 *   npm run load-test -- --agents 500 --tickets 50000 --seconds 5
 *   npm run load-test -- --concurrency 16 --inbox-reads 5
 *   npm run load-test -- --keep --json /tmp/load.json
 *
 * The targets are §10 of the roadmap — **p95 ticket read < 300 ms**, **p95 write
 * < 500 ms**, at **10,000 agents / 1,000,000 tickets per tenant** — and the open
 * M7 item was a *recorded* result at them. This is that rehearsal. It is a script
 * and not a test because it seeds a million rows: the suite has to stay runnable
 * in seconds on a machine with no database, so nothing here is in `tests/`.
 *
 * What it measures is the app's own paths, not a bench of the rules:
 *
 *  - **inbox read** — `store.listTickets(tenantId)`, which is what the inbox, the
 *    dashboard, `/reports`, the portal and `GET /api/v1/tickets` all call. It is
 *    the worklist the desk sees, whole.
 *  - **detail read** — `store.findTicket(tenantId, id)` with its thread.
 *  - **write: create** — `service.createTicket(actor, input)`: the reference, the
 *    row and the hash-chained audit event.
 *  - **write: reply** — `service.reply(actor, id, body)`: the append-only message
 *    and its audit event.
 *
 * Every read and write goes through the real Prisma-backed stores over a real
 * Postgres, so a number here is the number the deployment would get. A stage that
 * cannot keep up is reported as the run it was — errors counted, not swallowed.
 *
 * The seeded tenant is named `loadtest-<stamp>` and deleted at the end (unless
 * `--keep`), so the rehearsal does not touch a desk's own data.
 *
 * Exit codes: `0` every target met · `1` a target missed · `2` usage.
 */

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

/* The environment is loaded before anything builds a Prisma client, and this is
 * a side-effect import because import order *is* evaluation order — which is
 * also why the app's own modules are imported statically below it. */
import "./env";

import { prisma } from "../src/lib/db";
import { createTicketServices } from "../src/lib/ticket-server";

import type { Actor } from "../src/lib/access-rules";
import type { TicketPrismaClient } from "../src/lib/ticket-store-prisma";
import type { TicketPriority, TicketType } from "../src/lib/ticket-rules";

/* -------------------------------------------------------------------------- */
/*  Arguments                                                                 */
/* -------------------------------------------------------------------------- */

interface Options {
  agents: number;
  tickets: number;
  /** Every Nth ticket gets a three-message thread. `0` seeds no messages. */
  messagesEvery: number;
  concurrency: number;
  /** Seconds each concurrent stage runs for. */
  seconds: number;
  inboxReads: number;
  keep: boolean;
  json: string | null;
  label: string;
  targetReadMs: number;
  targetWriteMs: number;
}

const USAGE = `Usage: npm run load-test -- [options]

  --agents N          staff accounts to seed            (default 10000)
  --tickets N         tickets to seed                   (default 1000000)
  --messages-every N  one ticket in N gets a 3-message thread (default 5, 0 = none)
  --concurrency N     parallel workers per stage        (default 8)
  --seconds N         seconds each stage runs for       (default 10)
  --inbox-reads N     whole-worklist reads to time      (default 3)
  --target-read-ms N  the read target to judge against  (default 300)
  --target-write-ms N the write target                  (default 500)
  --label TEXT        what this run is, for the record  (default "local")
  --json PATH         write the raw result as JSON
  --keep              leave the seeded tenant behind
  --help              this text`;

function parseArgs(argv: string[]): Options | null {
  const options: Options = {
    agents: 10_000,
    tickets: 1_000_000,
    messagesEvery: 5,
    concurrency: 8,
    seconds: 10,
    inboxReads: 3,
    keep: false,
    json: null,
    label: "local",
    targetReadMs: 300,
    targetWriteMs: 500,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      i += 1;
      return value;
    };
    const count = (): number => {
      const value = Number(next());
      if (!Number.isFinite(value) || value < 0) throw new Error(`${arg} needs a number.`);
      return Math.trunc(value);
    };

    switch (arg) {
      case "--agents": options.agents = count(); break;
      case "--tickets": options.tickets = count(); break;
      case "--messages-every": options.messagesEvery = count(); break;
      case "--concurrency": options.concurrency = Math.max(1, count()); break;
      case "--seconds": options.seconds = Math.max(1, count()); break;
      case "--inbox-reads": options.inboxReads = Math.max(1, count()); break;
      case "--target-read-ms": options.targetReadMs = count(); break;
      case "--target-write-ms": options.targetWriteMs = count(); break;
      case "--label": options.label = next(); break;
      case "--json": options.json = next(); break;
      case "--keep": options.keep = true; break;
      case "--help":
      case "-h": console.log(USAGE); return null;
      default: throw new Error(`Unknown option ${arg}.`);
    }
  }
  if (options.agents < 1 || options.tickets < 1) throw new Error("--agents and --tickets must be at least 1.");
  return options;
}

/* -------------------------------------------------------------------------- */
/*  Measurement                                                               */
/* -------------------------------------------------------------------------- */

interface StageResult {
  name: string;
  /** Of what was asked of it. */
  attempts: number;
  /** How many came back without throwing. */
  ok: number;
  errors: string[];
  /** Successful op latencies, in ms. */
  samples: number[];
  elapsedMs: number;
}

function summarise(stage: StageResult) {
  const sorted = [...stage.samples].sort((a, b) => a - b);
  const at = (q: number): number | null => {
    if (sorted.length === 0) return null;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return round(sorted[index]);
  };
  return {
    name: stage.name,
    attempts: stage.attempts,
    ok: stage.ok,
    failed: stage.attempts - stage.ok,
    errors: stage.errors,
    elapsedMs: round(stage.elapsedMs),
    throughput: stage.elapsedMs > 0 ? round((stage.ok / stage.elapsedMs) * 1000, 2) : 0,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.length ? round(sorted[sorted.length - 1]) : null,
  };
}

function round(value: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Run `op` from `concurrency` workers for `seconds`.
 *
 * Every worker loops until the deadline, so the latency is measured under
 * whatever parallelism that produces rather than in a queue. A failure is
 * counted and its message kept once — a stage that fails half its writes must
 * say so, not look like a fast stage with fewer samples.
 */
async function stage(
  name: string,
  seconds: number,
  concurrency: number,
  op: (worker: number, iteration: number) => Promise<void>,
  maxErrors = 20,
): Promise<StageResult> {
  const result: StageResult = { name, attempts: 0, ok: 0, errors: [], samples: [], elapsedMs: 0 };
  const deadline = performance.now() + seconds * 1000;
  const started = performance.now();

  await Promise.all(
    Array.from({ length: concurrency }, async (_unused, worker) => {
      let iteration = 0;
      while (performance.now() < deadline) {
        result.attempts += 1;
        const at = performance.now();
        try {
          await op(worker, iteration);
          result.samples.push(performance.now() - at);
          result.ok += 1;
        } catch (error) {
          if (result.errors.length < maxErrors) {
            result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        iteration += 1;
      }
    }),
  );

  result.elapsedMs = performance.now() - started;
  return result;
}

/* -------------------------------------------------------------------------- */
/*  Seeding                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A deterministic ticket id, so a stage can address a row without holding ids.
 *
 * Carries this run's own key: the seeded rows' primary keys are global (a
 * `Ticket.id` is unique across every tenant), so two rehearsals — or one that
 * failed before its cleanup — must never propose the same id for different
 * tenants. The first target-scale attempt learned that the hard way.
 */
function ticketId(key: string, n: number): string {
  return `lt-${key}-t-${n}`;
}

async function seed(options: Options, tenantId: string, key: string): Promise<Record<string, number>> {
  const timings: Record<string, number> = {};
  const time = async (key: string, run: () => Promise<unknown>): Promise<void> => {
    const at = performance.now();
    await run();
    timings[key] = round(performance.now() - at);
  };

  await time("agents", () =>
    prisma.$executeRaw`
      INSERT INTO "User" (id, "tenantId", email, "displayName", role, active, "createdAt", "updatedAt")
      SELECT
        'lt-' || ${key} || '-a-' || n,
        ${tenantId},
        'agent' || n || '@loadtest.example',
        'Load Agent ' || n,
        'AGENT',
        true,
        now(),
        now()
      FROM generate_series(1, ${options.agents}::int) AS n
    `,
  );

  // The reference is padded to *at least* six digits, matching `ticketRef`, which
  // uses `padStart`. Postgres `lpad` cannot be used for it: `lpad` *truncates* a
  // string longer than the width, so ticket 1000000 would fold onto the reference
  // of ticket 100000 — which is exactly what the first target-scale rehearsal did.
  await time("tickets", () =>
    prisma.$executeRaw`
      INSERT INTO "Ticket" (
        id, "tenantId", ref, subject, description, type, status, priority,
        "requesterId", "assigneeId", "createdAt", "updatedAt",
        "firstResponseAt", "resolvedAt", "closedAt", "slaPauses", tags
      )
      SELECT
        'lt-' || ${key} || '-t-' || n,
        ${tenantId},
        'TIX-' || repeat('0', GREATEST(0, 6 - length(n::text))) || n::text,
        'Load rehearsal ticket ' || n,
        'Seeded by npm run load-test at the M7 target scale.',
        (CASE WHEN n % 5 = 0 THEN 'REQUEST' ELSE 'INCIDENT' END)::"TicketType",
        -- A desk's mix, not all-open: 20% new, 20% open, 10% pending, 30% closed.
        (CASE
           WHEN n % 10 < 2 THEN 'NEW'
           WHEN n % 10 < 4 THEN 'OPEN'
           WHEN n % 10 < 5 THEN 'PENDING'
           WHEN n % 10 < 7 THEN 'RESOLVED'
           ELSE 'CLOSED'
         END)::"TicketStatus",
        (CASE
           WHEN n % 20 = 0 THEN 'URGENT'
           WHEN n % 5 = 0 THEN 'HIGH'
           WHEN n % 3 = 0 THEN 'LOW'
           ELSE 'NORMAL'
         END)::"TicketPriority",
        'lt-' || ${key} || '-a-' || (1 + (n % ${options.agents}::int)),
        'lt-' || ${key} || '-a-' || (1 + ((n * 7) % ${options.agents}::int)),
        now() - make_interval(days => (n % 365)),
        now() - make_interval(days => (n % 365), hours => -1),
        CASE WHEN n % 10 >= 4 THEN now() - make_interval(days => (n % 365), hours => -5) END,
        CASE WHEN n % 10 >= 6 THEN now() - make_interval(days => (n % 365), hours => -3) END,
        CASE WHEN n % 10 >= 6 THEN now() - make_interval(days => (n % 365), hours => -2) END,
        '[]'::jsonb,
        ARRAY[]::text[]
      FROM generate_series(1, ${options.tickets}::int) AS n
    `,
  );

  if (options.messagesEvery > 0) {
    await time("messages", () =>
      prisma.$executeRaw`
        INSERT INTO "Message" (id, "tenantId", "ticketId", "authorId", kind, body, "createdAt")
        SELECT
          'lt-' || ${key} || '-m-' || t.n || '-' || k.i,
          ${tenantId},
          'lt-' || ${key} || '-t-' || t.n,
          'lt-' || ${key} || '-a-' || (1 + (t.n % ${options.agents}::int)),
          'PUBLIC_REPLY',
          'Seeded reply ' || k.i || ' on load ticket ' || t.n,
          now() - make_interval(days => (t.n % 365), hours => -k.i)
        FROM generate_series(1, ${options.tickets}::int) AS t(n),
             generate_series(1, 3) AS k(i)
        WHERE t.n % ${options.messagesEvery}::int = 0
      `,
    );
  }

  // Statistics, so the row count the rehearsal reports is the one Postgres kept.
  const rows = await prisma.$queryRaw<{ tickets: bigint; messages: bigint; staff: bigint }[]>`
    SELECT
      (SELECT count(*) FROM "Ticket" WHERE "tenantId" = ${tenantId}) AS tickets,
      (SELECT count(*) FROM "Message" WHERE "tenantId" = ${tenantId}) AS messages,
      (SELECT count(*) FROM "User" WHERE "tenantId" = ${tenantId}) AS staff
  `;
  timings.seededTickets = Number(rows[0]?.tickets ?? 0);
  timings.seededMessages = Number(rows[0]?.messages ?? 0);
  timings.seededStaff = Number(rows[0]?.staff ?? 0);
  return timings;
}

/* -------------------------------------------------------------------------- */
/*  The run                                                                   */
/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  let options: Options;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed === null) return 0;
    options = parsed;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }

  const heapLimitMb = Math.round(getHeapStatistics().heap_size_limit / (1024 * 1024));

  console.log(
    `OnTrak Tix load rehearsal — ${options.label}\n` +
      `  target: ${options.agents.toLocaleString()} agents / ${options.tickets.toLocaleString()} tickets per tenant\n` +
      `  targets: p95 read < ${options.targetReadMs} ms, p95 write < ${options.targetWriteMs} ms\n` +
      `  stages: concurrency ${options.concurrency}, ${options.seconds}s each, ${options.inboxReads} inbox read(s)\n` +
      `  node heap limit: ${heapLimitMb} MB\n`,
  );

  const slug = `loadtest-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
  const tenant = await prisma.tenant.create({ data: { name: "Load Rehearsal", slug } });
  const tenantId = tenant.id;

  // The real client *is* the port's shape, but TypeScript cannot see through
  // Prisma's generated generics — `db.ts` casts for the same reason.
  const services = createTicketServices(prisma as unknown as TicketPrismaClient);
  // This run's own id prefix: primary keys are global across tenants, so a
  // rehearsal must never propose an id another run could already have used.
  const key = tenantId.slice(-6);
  const actor: Actor = { id: `lt-${key}-a-1`, tenantId, role: "AGENT" };

  const startedAt = new Date().toISOString();

  // The seed is inside the `try` on purpose: a rehearsal that fails while seeding
  // a million rows still has to take its tenant away with it.
  try {
    const seedTimings = await seed(options, tenantId, key);
    const seedMs = Object.entries(seedTimings)
      .filter(([entry]) => !entry.startsWith("seeded"))
      .reduce((total, [, value]) => total + value, 0);
    console.log(
      `seed: ${seedTimings.seededTickets.toLocaleString()} tickets, ` +
        `${seedTimings.seededMessages.toLocaleString()} messages, ` +
        `${seedTimings.seededStaff.toLocaleString()} staff in ${(seedMs / 1000).toFixed(1)}s`,
    );

    // Warm the pool and the caches: the first read of a cold connection is the
    // connection's latency, not the query's, and reporting it as the app's would
    // overstate the desk's experience of its own worklist.
    await services.store.findTicket(tenantId, ticketId(key, 1));

    const reads: StageResult[] = [];

    // The detail read: one ticket and its thread, the page an agent opens most.
    reads.push(
      await stage("read: ticket detail", options.seconds, options.concurrency, async (_worker, iteration) => {
        const id = ticketId(key, 1 + (iteration % options.tickets));
        const found = await services.store.findTicket(tenantId, id);
        if (!found) throw new Error(`ticket ${id} was not found`);
      }),
    );

    // The worklist read. Timed one call at a time on purpose: at target scale a
    // single call already returns the whole tenant's worklist, so running these
    // in parallel would measure memory pressure rather than the query.
    const wholelist: StageResult = {
      name: "read: inbox worklist",
      attempts: 0,
      ok: 0,
      errors: [],
      samples: [],
      elapsedMs: 0,
    };
    for (let i = 0; i < options.inboxReads; i += 1) {
      wholelist.attempts += 1;
      const at = performance.now();
      try {
        const all = await services.store.listTickets(tenantId);
        wholelist.elapsedMs += performance.now() - at;
        wholelist.samples.push(performance.now() - at);
        if (all.length === 0) throw new Error("the worklist came back empty");
        wholelist.ok += 1;
      } catch (error) {
        wholelist.errors.push(`read: inbox worklist: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    reads.push(wholelist);

    // Writes. A ticket per iteration is the heaviest write the desk has, and it
    // includes the audit event, so this is the number the target is about.
    const createStage = await stage(
      "write: create ticket",
      options.seconds,
      options.concurrency,
      async (_worker, iteration) => {
        const result = await services.service.createTicket(actor, {
          subject: `Load rehearsal ${iteration}`,
          description: "Written by the M7 load rehearsal.",
          type: "INCIDENT" as TicketType,
          priority: "NORMAL" as TicketPriority,
          requesterId: actor.id,
        });
        if (!result.ok) throw new Error(result.error);
      },
    );

    const replyStage = await stage(
      "write: reply",
      options.seconds,
      options.concurrency,
      async (_worker, iteration) => {
        const result = await services.service.reply(
          actor,
          ticketId(key, 1 + (iteration % options.tickets)),
          "A rehearsal reply.",
        );
        if (!result.ok) throw new Error(result.error);
      },
    );

    const summary = [...reads, createStage, replyStage].map(summarise);

    console.log("\nresults");
    const header = ["op", "ok", "fail", "ops/s", "p50", "p95", "p99", "max"];
    console.log("  " + header.join("\t"));
    for (const row of summary) {
      console.log(
        "  " +
          [row.name, row.ok, row.failed, row.throughput, row.p50, row.p95, row.p99, row.max].join("\t"),
      );
    }
    for (const row of summary) {
      for (const error of row.errors) console.log(`  ! ${error}`);
    }

    /* ---- Verdict ---------------------------------------------------------- */

    const detail = summary.find((row) => row.name === "read: ticket detail");
    const inbox = summary.find((row) => row.name === "read: inbox worklist");
    const create = summary.find((row) => row.name === "write: create ticket");
    const reply = summary.find((row) => row.name === "write: reply");

    const misses: string[] = [];
    const judge = (label: string, value: number | null, target: number): void => {
      if (value === null) {
        misses.push(`${label}: no successful sample`);
        return;
      }
      const verdict = value <= target ? "met" : "MISSED";
      if (value > target) misses.push(`${label}: ${value} ms > ${target} ms`);
      console.log(`  ${verdict}\t${label}\tp95 ${value} ms (target ${target} ms)`);
    };

    judge("read: ticket detail", detail?.p95 ?? null, options.targetReadMs);
    // The worklist read is reported against the same target, on the samples it got.
    judge("read: inbox worklist", inbox?.p95 ?? null, options.targetReadMs);
    judge("write: create ticket", create?.p95 ?? null, options.targetWriteMs);
    judge("write: reply", reply?.p95 ?? null, options.targetWriteMs);

    const record = {
      label: options.label,
      startedAt,
      finishedAt: new Date().toISOString(),
      host: {
        platform: `${process.platform} ${process.arch}`,
        node: process.version,
        cpus: cpus().length,
        memoryGb: round(totalmem() / 1024 ** 3, 1),
        heapLimitMb,
      },
      dataset: {
        agents: seedTimings.seededStaff,
        tickets: seedTimings.seededTickets,
        messages: seedTimings.seededMessages,
        seedMs: round(seedMs),
        seedStageMs: seedTimings,
      },
      options: {
        concurrency: options.concurrency,
        seconds: options.seconds,
        inboxReads: options.inboxReads,
      },
      targets: { readMs: options.targetReadMs, writeMs: options.targetWriteMs },
      stages: summary,
      met: misses.length === 0,
      misses,
    };

    if (options.json) {
      await writeFile(options.json, `${JSON.stringify(record, null, 2)}\n`);
      console.log(`\nwrote ${options.json}`);
    }

    console.log(`\n${misses.length === 0 ? "MET" : "MISSED"} — ${misses.length} target(s) missed`);
    return misses.length === 0 ? 0 : 1;
  } finally {
    if (options.keep) {
      console.log(`kept tenant ${slug} (${tenantId})`);
    } else {
      const at = performance.now();
      await prisma.$executeRaw`DELETE FROM "Message" WHERE "tenantId" = ${tenantId}`;
      await prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE "tenantId" = ${tenantId}`;
      await prisma.$executeRaw`DELETE FROM "Ticket" WHERE "tenantId" = ${tenantId}`;
      await prisma.$executeRaw`DELETE FROM "User" WHERE "tenantId" = ${tenantId}`;
      await prisma.tenant.delete({ where: { id: tenantId } });
      console.log(`cleaned up tenant ${slug} in ${((performance.now() - at) / 1000).toFixed(1)}s`);
    }
    await prisma.$disconnect();
  }
}

void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    return 1;
  })
  .then((code) => {
    process.exitCode = code;
  });
