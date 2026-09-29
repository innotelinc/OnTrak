/**
 * OnTrak Tix seed (M0).
 *
 * Creates one tenant with a full set of roles, a queue and a few tickets so the
 * inbox and portal have something in them. Idempotent: every write is an upsert
 * or guarded by a count, so re-running does not duplicate anything.
 *
 * Run with `npm run db:seed` from `ontrak-tix/`.
 */

import { Prisma, PrismaClient } from "@prisma/client";

import type { Actor } from "../src/lib/access-rules";
import { hashPassword } from "../src/lib/password";
import { weekdayCalendar } from "../src/lib/sla-rules";
import { DEFAULT_CANNED_RESPONSES } from "../src/lib/canned-rules";
import { DEFAULT_TICKET_TEMPLATES } from "../src/lib/template-rules";
import { DEFAULT_KNOWLEDGE_ARTICLES } from "../src/lib/knowledge-rules";
import { createTicketServices } from "../src/lib/ticket-server";
import type { TicketPrismaClient } from "../src/lib/ticket-store-prisma";
import { SecurityAlertService } from "../src/lib/security-alert-service";
import { PrismaSecurityAlertStore, type SecurityAlertPrismaClient } from "../src/lib/security-alert-store-prisma";
import { AlertPromotionService } from "../src/lib/alert-promotion-service";
import { PrismaPromotionStore, type AlertPromotionPrismaClient } from "../src/lib/alert-promotion-store-prisma";

const DEMO_PASSWORD = "ChangeMe123";

/**
 * The subset of the generated client the seed uses. Declared structurally so
 * the file typechecks without depending on a generated client's exact shape —
 * the same reason the runtime adapters do.
 */
interface SeedDb {
  tenant: { upsert(args: unknown): Promise<{ id: string; slug: string }> };
  user: { upsert(args: unknown): Promise<{ id: string }> };
  queue: { upsert(args: unknown): Promise<{ id: string }> };
  client: { upsert(args: unknown): Promise<{ id: string }> };
  slaPolicy: { upsert(args: unknown): Promise<{ id: string }> };
  cannedResponse: { upsert(args: unknown): Promise<{ id: string }> };
  ticketTemplate: { upsert(args: unknown): Promise<{ id: string }> };
  knowledgeArticle: { upsert(args: unknown): Promise<{ id: string }> };
  ticket: { count(args: unknown): Promise<number> };
  securityAlert: { count(args: unknown): Promise<number> };
}

const ACCOUNTS: { email: string; displayName: string; role: Actor["role"] }[] = [
  { email: "admin@acme.test", displayName: "Ada Admin", role: "ADMIN" },
  { email: "dispatcher@acme.test", displayName: "Dee Dispatcher", role: "DISPATCHER" },
  { email: "agent@acme.test", displayName: "Sam Agent", role: "AGENT" },
  { email: "requester@acme.test", displayName: "Rita Requester", role: "REQUESTER" },
];

async function main(): Promise<void> {
  const db = new PrismaClient() as unknown as SeedDb & TicketPrismaClient;

  const tenant = await db.tenant.upsert({
    where: { slug: "acme" },
    update: {},
    create: { name: "Acme IT", slug: "acme" },
  });

  const passwordHash = hashPassword(DEMO_PASSWORD);
  const users: Record<string, { id: string }> = {};
  for (const account of ACCOUNTS) {
    users[account.role] = await db.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: account.email } },
      update: { displayName: account.displayName, role: account.role, active: true, passwordHash },
      create: {
        tenantId: tenant.id,
        email: account.email,
        displayName: account.displayName,
        role: account.role,
        passwordHash,
      },
    });
  }

  const queue = await db.queue.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: "service-desk" } },
    update: {},
    create: { tenantId: tenant.id, name: "Service desk", slug: "service-desk" },
  });

  await db.client.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: "Acme Corp" } },
    update: {},
    create: { tenantId: tenant.id, name: "Acme Corp" },
  });

  // SLA policies so every ticket gets a running clock: a tight one for URGENT,
  // a middle one for HIGH, and a standard fallback for everything else. Hours
  // are 09:00–17:00 on a fixed UTC offset.
  const calendar = weekdayCalendar("Service desk (9–5)", 0) as unknown as Prisma.InputJsonValue;
  const policies = [
    { priority: "URGENT" as const, name: "Urgent", responseMinutes: 30, resolutionMinutes: 240 },
    { priority: "HIGH" as const, name: "High", responseMinutes: 60, resolutionMinutes: 480 },
    { priority: null, name: "Standard", responseMinutes: 240, resolutionMinutes: 1440 },
  ];
  for (const policy of policies) {
    await db.slaPolicy.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name: policy.name } },
      update: { priority: policy.priority, responseMinutes: policy.responseMinutes, resolutionMinutes: policy.resolutionMinutes, calendar },
      create: { tenantId: tenant.id, name: policy.name, priority: policy.priority, responseMinutes: policy.responseMinutes, resolutionMinutes: policy.resolutionMinutes, calendar },
    });
  }

  // The desk's starter reply library, so the composer has quick-fills on a fresh
  // database instead of an empty picker nobody fills in.
  for (const response of DEFAULT_CANNED_RESPONSES) {
    await db.cannedResponse.upsert({
      where: { tenantId_title: { tenantId: tenant.id, title: response.title } },
      update: { body: response.body, shortcut: response.shortcut },
      create: { tenantId: tenant.id, title: response.title, body: response.body, shortcut: response.shortcut },
    });
  }

  // Starter ticket shapes, so the new-ticket form offers a template before the
  // desk has written one.
  for (const template of DEFAULT_TICKET_TEMPLATES) {
    await db.ticketTemplate.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name: template.name } },
      update: { subject: template.subject, description: template.description, type: template.type, priority: template.priority },
      create: {
        tenantId: tenant.id,
        name: template.name,
        subject: template.subject,
        description: template.description,
        type: template.type,
        priority: template.priority,
      },
    });
  }

  // Starter knowledge articles, so the portal's deflection prompt has something
  // to answer with on a fresh database — an empty knowledge base is never
  // filled in.
  for (const article of DEFAULT_KNOWLEDGE_ARTICLES) {
    await db.knowledgeArticle.upsert({
      where: { tenantId_title: { tenantId: tenant.id, title: article.title } },
      update: { body: article.body, visibility: article.visibility, tags: [...article.tags] },
      create: {
        tenantId: tenant.id,
        title: article.title,
        body: article.body,
        visibility: article.visibility,
        tags: [...article.tags],
        createdBy: users.ADMIN.id,
      },
    });
  }

  // One service stack for the whole seed: the audit sink caches the tenant's
  // chain head, so two sinks would race on `seq`.
  const services = createTicketServices(db);
  const dispatcher: Actor = { id: users.DISPATCHER.id, tenantId: tenant.id, role: "DISPATCHER" };

  // Demo security telemetry, so the console has a stream on first run: one alert
  // worth an incident, one quiet detection, and one an asset suppression keeps
  // out of the queue. Ingested through the real service, so the dedupe ledger
  // and the hash-chained audit log see them like any other alert.
  const alertCount = await db.securityAlert.count({ where: { tenantId: tenant.id } });
  if (alertCount === 0) {
    const alerts = new SecurityAlertService(
      new PrismaSecurityAlertStore(db as unknown as SecurityAlertPrismaClient),
      services.audit,
    );
    await alerts.ingest(tenant.id, {
      vendor: "Snort",
      severity: "high",
      signature: "ET SCAN Potential SSH Scan",
      description: "Possible SSH scan from an external host.",
      occurredAt: "2026-09-20T08:00:00Z",
      asset: "web-01",
      sourceIp: "203.0.113.9",
      externalId: "demo-scan-1",
    });
    await alerts.ingest(tenant.id, {
      vendor: "CrowdStrike Falcon",
      severity: "low",
      signature: "Unsigned tool launched",
      description: "An unsigned binary ran from a user profile.",
      occurredAt: "2026-09-20T08:10:00Z",
      asset: "db-01",
      identity: "acme\\j.rivera",
      externalId: "demo-edr-1",
    });

    const promotions = new AlertPromotionService(
      {
        alerts,
        tickets: {
          createTicket: (actor, input) => services.service.createTicket(actor, input),
          findTicket: (tenantId, ticketId) => services.store.findTicket(tenantId, ticketId),
        },
      },
      new PrismaPromotionStore(db as unknown as AlertPromotionPrismaClient),
      services.audit,
    );
    await promotions.addSuppression(dispatcher, {
      field: "asset",
      match: "scanner",
      reason: "Internal vulnerability scanner",
    });
    // A critical alert that the suppression above keeps out of the queue, so the
    // console demonstrates a recorded suppression rather than an empty list.
    const suppressed = await alerts.ingest(tenant.id, {
      vendor: "Nessus",
      severity: "critical",
      signature: "Unpatched service detected",
      description: "A service with a known vulnerability is exposed.",
      occurredAt: "2026-09-20T08:20:00Z",
      asset: "scanner-01",
      externalId: "demo-scan-2",
    });
    await promotions.promote(dispatcher, suppressed.alert.id, { requesterId: users.DISPATCHER.id });
  }

  // A couple of tickets so the inbox is not empty on first run. Created through
  // the real service, so they get refs and hash-chained audit events like any
  // other ticket.
  const existing = await db.ticket.count({ where: { tenantId: tenant.id } });
  if (existing === 0) {
    const { service } = services;
    const requesterId = users.REQUESTER.id;

    await service.createTicket(dispatcher, {
      subject: "VPN certificate rejected on the new laptop",
      description: "The VPN client says the certificate is invalid since this morning.",
      type: "INCIDENT",
      priority: "HIGH",
      requesterId,
      queueId: queue.id,
    });
    await service.createTicket(dispatcher, {
      subject: "New starter needs a mailbox and a phone",
      description: "Priya starts Monday and needs the standard onboarding kit.",
      type: "REQUEST",
      priority: "NORMAL",
      requesterId,
      queueId: queue.id,
    });
  }

  console.log(
    `Seeded tenant "${tenant.slug}" with ${ACCOUNTS.length} accounts (password: ${DEMO_PASSWORD}), ` +
      `a queue, ${policies.length} SLA policies, ${DEFAULT_CANNED_RESPONSES.length} canned responses, ` +
      `${DEFAULT_TICKET_TEMPLATES.length} ticket templates, ${DEFAULT_KNOWLEDGE_ARTICLES.length} knowledge articles, ` +
      `sample tickets and demo security alerts.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
