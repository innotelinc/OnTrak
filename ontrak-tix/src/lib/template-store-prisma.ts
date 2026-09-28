/**
 * Prisma adapter for the ticket-template store (M1). Structural, like the other
 * adapters, so the service is testable against a fake.
 */

import type { TicketTemplate } from "./template-rules";
import type { TemplateStore } from "./template-service";

export interface TicketTemplateRow {
  id: string;
  tenantId: string;
  name: string;
  subject: string;
  description: string;
  type: TicketTemplate["type"];
  priority: TicketTemplate["priority"];
  queueId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TemplatePrismaClient {
  ticketTemplate: {
    findMany(args: unknown): Promise<TicketTemplateRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    deleteMany(args: unknown): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toTemplateRecord(row: TicketTemplateRow): TicketTemplate {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    subject: row.subject,
    description: row.description,
    type: row.type,
    priority: row.priority,
    queueId: row.queueId,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toTemplateData(template: TicketTemplate) {
  return {
    id: template.id,
    tenantId: template.tenantId,
    name: template.name,
    subject: template.subject,
    description: template.description,
    type: template.type,
    priority: template.priority,
    queueId: template.queueId,
    createdAt: new Date(template.createdAt),
    updatedAt: new Date(template.updatedAt),
  };
}

export class PrismaTemplateStore implements TemplateStore {
  constructor(private readonly db: TemplatePrismaClient) {}

  async listForTenant(tenantId: string): Promise<TicketTemplate[]> {
    const rows = await this.db.ticketTemplate.findMany({ where: { tenantId } });
    return rows.map(toTemplateRecord);
  }

  async insert(template: TicketTemplate): Promise<void> {
    await this.db.ticketTemplate.create({ data: toTemplateData(template) });
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.db.ticketTemplate.deleteMany({ where: { tenantId, id } });
  }
}
