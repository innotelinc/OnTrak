/** Temporary: check the database pager against the rules it replaced. */
import { randomUUID } from "node:crypto";
import "./env";
import { prisma } from "../src/lib/db";
import { createTicketServices } from "../src/lib/ticket-server";
import type { TicketPrismaClient } from "../src/lib/ticket-store-prisma";
import { buildInboxView } from "../src/lib/inbox-view";
import type { InboxFilter } from "../src/lib/inbox-rules";
import { scopeByClient, type ClientScope } from "../src/lib/client-rules";
import type { Actor } from "../src/lib/access-rules";
import type { TicketPriority, TicketStatus } from "../src/lib/ticket-rules";

const STAMP = randomUUID().slice(0, 6);
const TENANT = `inbox-verify-${STAMP}`;

async function main() {
  const tenant = await prisma.tenant.create({ data: { name: "Inbox verify", slug: TENANT } });
  const tenantId = tenant.id;
  const client = await prisma.client.create({ data: { tenantId, name: `Client ${STAMP}` } });
  const other = await prisma.client.create({ data: { tenantId, name: `Other ${STAMP}` } });
  const agents = [0, 1, 2, 3, 4].map((n) => `iv-agent-${n}`);
  await prisma.user.createMany({
    data: agents.map((id, n) => ({
      id,
      tenantId,
      email: `${id}-${STAMP}@example.test`,
      displayName: `Agent ${n}`,
      role: "AGENT" as const,
      active: true,
    })),
  });

  const services = createTicketServices(prisma as unknown as TicketPrismaClient);
  const statuses: TicketStatus[] = ["NEW", "OPEN", "PENDING", "RESOLVED", "CLOSED"];
  const priorities: TicketPriority[] = ["LOW", "NORMAL", "HIGH", "URGENT"];

  const rows = [];
  for (let i = 0; i < 240; i += 1) {
    rows.push({
      id: `iv-${STAMP}-${i}`,
      tenantId,
      ref: `TIX-${String(i + 1).padStart(6, "0")}`,
      subject: i % 7 === 0 ? `Printer offline ${i}` : `Ticket ${i}`,
      description: "verification",
      type: "INCIDENT" as const,
      status: statuses[i % statuses.length],
      priority: priorities[Math.floor(i / 5) % priorities.length],
      requesterId: agents[0],
      assigneeId: i % 3 === 0 ? null : agents[i % 4],
      queueId: null,
      clientId: i % 11 === 0 ? client.id : i % 13 === 0 ? other.id : null,
      createdAt: new Date(Date.now() - i * 60_000).toISOString(),
      updatedAt: new Date(Date.now() - i * 60_000).toISOString(),
      firstResponseAt: null,
      resolvedAt: null,
      closedAt: null,
      pauses: [],
      tags: [],
      messages: [],
    });
  }
  await prisma.ticket.createMany({
    data: rows.map(({ pauses, messages, ...row }) => ({
      ...row,
      slaPauses: pauses,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    })),
  });

  const all = await services.store.listTickets(tenantId);

  const scopeAll: ClientScope = { kind: "all", clientIds: [], because: "test" };
  const scopeOne: ClientScope = { kind: "assigned", clientIds: [client.id], because: "test" };
  const cases: { filter: InboxFilter; scope: ClientScope; label: string }[] = [
    { filter: {}, scope: scopeAll, label: "default open" },
    { filter: { status: "all" }, scope: scopeAll, label: "all statuses" },
    { filter: { status: "RESOLVED" }, scope: scopeAll, label: "resolved only" },
    { filter: { assigneeId: "unassigned" }, scope: scopeAll, label: "unassigned" },
    { filter: { assigneeId: "iv-agent-2" }, scope: scopeAll, label: "one assignee" },
    { filter: { priority: "URGENT" }, scope: scopeAll, label: "urgent" },
    { filter: { search: "printer" }, scope: scopeAll, label: "search" },
    { filter: {}, scope: scopeOne, label: "client scoped" },
    { filter: { status: "all" }, scope: scopeOne, label: "client scoped all" },
    { filter: { priority: "HIGH" }, scope: scopeOne, label: "client scoped high" },
  ];

  let checks = 0;
  for (const testCase of cases) {
    const clientIds = testCase.scope.kind === "assigned" ? testCase.scope.clientIds : null;
    const referenceRows = buildInboxView(scopeByClient(testCase.scope, all), testCase.filter).tickets;
    // The order contract is (open, priority, oldest-touched); ties are not part of
    // it, so compare the keys in order and the row set, not arbitrary tie order.
    const key = (t: { status: string; priority: string; updatedAt: string }) =>
      `${["NEW", "OPEN", "PENDING"].includes(t.status) ? 0 : 1}|${t.priority}|${t.updatedAt}`;
    const total = (await services.store.countInbox(tenantId, { clientIds })).open;
    if (clientIds === null && Object.keys(testCase.filter).length === 0) {
      const referenceOpen = referenceRows.length;
      if (total !== referenceOpen) throw new Error(`open count ${total} != ${referenceOpen}`);
    }
    for (const offset of [0, 7, 50, 200]) {
      const page = await services.store.listInboxPage(tenantId, { filter: testCase.filter, clientIds, offset, limit: 25 });
      const expected = referenceRows.slice(offset, offset + 25);
      const gotKeys = page.tickets.map(key);
      const expectedKeys = expected.map(key);
      if (page.total !== referenceRows.length) throw new Error(`${testCase.label}: total ${page.total} != ${referenceRows.length}`);
      if (JSON.stringify(gotKeys) !== JSON.stringify(expectedKeys)) {
        const at = gotKeys.findIndex((value, index) => value !== expectedKeys[index]);
        throw new Error(
          `${testCase.label} offset ${offset}: order differs at ${at}\n` +
            ` got ${gotKeys.slice(Math.max(0, at - 2), at + 3).join(" / ")}\n` +
            ` exp ${expectedKeys.slice(Math.max(0, at - 2), at + 3).join(" / ")}`
        );
      }
      const gotIds = page.tickets.map((t) => t.id).sort();
      const expectedIds = expected.map((t) => t.id).sort();
      if (JSON.stringify(gotIds) !== JSON.stringify(expectedIds)) {
        const missing = expectedIds.filter((id) => !gotIds.includes(id));
        const extra = gotIds.filter((id) => !expectedIds.includes(id));
        const detail = (id: string) => {
          const row = all.find((t) => t.id === id)!;
          return `${id} ${row.status}/${row.priority}/${row.updatedAt}`;
        };
        throw new Error(
          `${testCase.label} offset ${offset}: different rows\n missing ${missing.map(detail).join(", ")}\n extra ${extra.map(detail).join(", ")}`
        );
      }
      checks += 1;
    }
  }

  // SLA candidates: a policy on one ticket; the inbox counts it and no other.
  const policy = await prisma.slaPolicy.create({
    data: {
      tenantId,
      name: `Policy ${STAMP}`,
      priority: "URGENT",
      responseMinutes: 30,
      resolutionMinutes: 120,
      calendar: { timezone: "UTC", workdays: [1, 2, 3, 4, 5], startMinute: 0, endMinute: 1440 },
    },
  });
  const urgent = rows.find((row) => row.priority === "URGENT" && row.status === "NEW")!;
  await prisma.ticket.update({ where: { id: urgent.id }, data: { slaPolicyId: policy.id } });
  const candidates = await services.store.listSlaTickets(tenantId, { clientIds: null });
  if (candidates.length !== 1 || candidates[0]!.id !== urgent.id) {
    throw new Error(`SLA candidates wrong: ${JSON.stringify(candidates.map((c) => c.id))}`);
  }
  if (!candidates[0]!.updatedAt) throw new Error("SLA candidate has no updatedAt");

  const counts = await services.store.countInbox(tenantId, { clientIds: null });
  const expectedOpen = all.filter((t) => ["NEW", "OPEN", "PENDING"].includes(t.status)).length;
  if (counts.open !== expectedOpen) throw new Error(`counts.open ${counts.open} != ${expectedOpen}`);
  const expectedUnassigned = all.filter((t) => ["NEW", "OPEN", "PENDING"].includes(t.status) && t.assigneeId === null).length;
  if (counts.unassigned !== expectedUnassigned) throw new Error(`counts.unassigned ${counts.unassigned} != ${expectedUnassigned}`);

  // findTickets keeps the order it is given.
  const ids = [all[5]!.id, all[1]!.id, all[9]!.id];
  const found = await services.store.findTickets(tenantId, ids);
  if (JSON.stringify(found.map((t) => t.id)) !== JSON.stringify(ids)) throw new Error("findTickets lost the order");

  console.log(`ok: ${checks} page comparisons, counts and SLA candidates on ${all.length} tickets`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.tenant.deleteMany({ where: { slug: TENANT } });
    await prisma.$disconnect();
  });
