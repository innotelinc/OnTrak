/**
 * Time the paged inbox against a tenant that is already at the target size.
 *
 * The rehearsal's own `--inbox-reads` path re-seeds a million rows and then tears
 * the tenant down, which is the right way to measure a *cold* desk and the wrong
 * way to settle one number twice. This measures the two shipped calls directly —
 * `listInboxPage` and `countInbox`, the same read the inbox page makes — on a
 * tenant a rehearsal already seeded (`--keep`), after a warm-up, and reports p50,
 * p95 and max for each half and for both together.
 *
 *   npx tsx scripts/measure-inbox.ts <tenantId> [samples]
 *
 * The result of the 2026-10-25 run is in `docs/load-test-2026-10-25-inbox60.json`.
 */
import { writeFile } from "node:fs/promises";
import "./env";
import { prisma } from "../src/lib/db";
import { createTicketServices } from "../src/lib/ticket-server";
import type { TicketPrismaClient } from "../src/lib/ticket-store-prisma";

const TENANT = process.argv[2] ?? "";
const SAMPLES = Number(process.argv[3] ?? "60");

function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return Math.round((sorted[index] ?? 0) * 10) / 10;
}

async function main(): Promise<void> {
  if (TENANT === "") throw new Error("usage: measure-inbox.ts <tenantId> [samples]");
  const services = createTicketServices(prisma as unknown as TicketPrismaClient);
  const count = await prisma.ticket.count({ where: { tenantId: TENANT } });
  if (count === 0) throw new Error(`tenant ${TENANT} has no tickets`);

  // Warm the pool and the caches, as the rehearsal's own warm-up does.
  for (let i = 0; i < 3; i += 1) {
    await services.store.listInboxPage(TENANT, { filter: {}, clientIds: null, offset: 0, limit: 50 });
    await services.store.countInbox(TENANT, { clientIds: null });
  }

  const combined: number[] = [];
  const pages: number[] = [];
  const counts: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const at = performance.now();
    const pageAt = performance.now();
    const page = await services.store.listInboxPage(TENANT, { filter: {}, clientIds: null, offset: 0, limit: 50 });
    pages.push(performance.now() - pageAt);
    const countAt = performance.now();
    const header = await services.store.countInbox(TENANT, { clientIds: null });
    counts.push(performance.now() - countAt);
    combined.push(performance.now() - at);
    if (page.tickets.length === 0 || page.total === 0 || header.open === 0) {
      throw new Error(`read ${i} came back empty`);
    }
  }

  const result = {
    label: "1M inbox, 60 samples, direct calls",
    measuredAt: new Date().toISOString(),
    tenantId: TENANT,
    tickets: count,
    samples: SAMPLES,
    page: { p50: percentile(pages, 0.5), p95: percentile(pages, 0.95), max: percentile(pages, 1) },
    counts: { p50: percentile(counts, 0.5), p95: percentile(counts, 0.95), max: percentile(counts, 1) },
    combined: { p50: percentile(combined, 0.5), p95: percentile(combined, 0.95), max: percentile(combined, 1) },
  };
  console.log(JSON.stringify(result, null, 2));
  await writeFile("docs/load-test-2026-10-25-inbox60.json", `${JSON.stringify(result, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
