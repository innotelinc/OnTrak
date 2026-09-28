/**
 * Prisma adapter for the ticket-link store (M1). `kind` is a plain string in the
 * row and narrowed to the domain union on the way out.
 */

import { isLinkKind, type TicketLink } from "./link-rules";
import type { LinkStore } from "./link-service";

export interface TicketLinkRow {
  id: string;
  tenantId: string;
  fromTicketId: string;
  toTicketId: string;
  kind: string;
  createdBy: string | null;
  createdAt: Date;
}

export interface LinkPrismaClient {
  ticketLink: {
    findMany(args: unknown): Promise<TicketLinkRow[]>;
    createMany(args: { data: unknown[]; skipDuplicates?: boolean }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toLinkRecord(row: TicketLinkRow): TicketLink {
  return {
    id: row.id,
    tenantId: row.tenantId,
    fromTicketId: row.fromTicketId,
    toTicketId: row.toTicketId,
    kind: isLinkKind(row.kind) ? row.kind : "RELATED",
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
  };
}

export function toLinkData(link: TicketLink) {
  return {
    id: link.id,
    tenantId: link.tenantId,
    fromTicketId: link.fromTicketId,
    toTicketId: link.toTicketId,
    kind: link.kind,
    createdBy: link.createdBy,
    createdAt: new Date(link.createdAt),
  };
}

export class PrismaLinkStore implements LinkStore {
  constructor(private readonly db: LinkPrismaClient) {}

  async listForTenant(tenantId: string): Promise<TicketLink[]> {
    const rows = await this.db.ticketLink.findMany({ where: { tenantId } });
    return rows.map(toLinkRecord);
  }

  async insert(link: TicketLink): Promise<void> {
    await this.db.ticketLink.createMany({ data: [toLinkData(link)], skipDuplicates: true });
  }
}
