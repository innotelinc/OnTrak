/**
 * Prisma adapter for clients, contacts, assignments and act-as windows (M4).
 *
 * Same split as the other adapters: the port (`ClientStore`) speaks domain
 * records with ISO strings, this file owns the rows and the `Date` conversions,
 * and nothing here decides anything.
 */

import type {
  ClientActAsRecord,
  ClientAssignmentRecord,
  ClientRecord,
  ContactRecord,
} from "./client-rules";
import type { ClientStore } from "./client-service";

export interface ClientRow {
  id: string;
  tenantId: string;
  name: string;
  createdAt: Date;
}

export interface ContactRow {
  id: string;
  tenantId: string;
  clientId: string;
  name: string;
  email: string;
  createdAt: Date;
}

export interface ClientAssignmentRow {
  id: string;
  tenantId: string;
  clientId: string;
  userId: string;
  assignedBy: string;
  assignedAt: Date;
}

export interface ClientActAsRow {
  id: string;
  tenantId: string;
  clientId: string;
  actorId: string;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endReason: string | null;
}

export interface ClientPrismaClient {
  client: {
    findFirst(args: unknown): Promise<ClientRow | null>;
    findMany(args: unknown): Promise<ClientRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
  };
  contact: {
    findFirst(args: unknown): Promise<ContactRow | null>;
    findMany(args: unknown): Promise<ContactRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
  };
  clientAssignment: {
    findFirst(args: unknown): Promise<ClientAssignmentRow | null>;
    findMany(args: unknown): Promise<ClientAssignmentRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    deleteMany(args: { where: unknown }): Promise<unknown>;
  };
  clientActAsSession: {
    findFirst(args: unknown): Promise<ClientActAsRow | null>;
    findMany(args: unknown): Promise<ClientActAsRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

export function toClientRecord(row: ClientRow): ClientRecord {
  return { id: row.id, tenantId: row.tenantId, name: row.name, createdAt: toIso(row.createdAt) };
}

export function toContactRecord(row: ContactRow): ContactRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    clientId: row.clientId,
    name: row.name,
    email: row.email,
    createdAt: toIso(row.createdAt),
  };
}

export function toAssignmentRecord(row: ClientAssignmentRow): ClientAssignmentRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    clientId: row.clientId,
    userId: row.userId,
    assignedBy: row.assignedBy,
    assignedAt: toIso(row.assignedAt),
  };
}

export function toActAsRecord(row: ClientActAsRow): ClientActAsRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    clientId: row.clientId,
    actorId: row.actorId,
    reason: row.reason,
    startedAt: toIso(row.startedAt),
    expiresAt: toIso(row.expiresAt),
    endedAt: toIsoOrNull(row.endedAt),
    endReason: row.endReason,
  };
}

export class PrismaClientStore implements ClientStore {
  constructor(private readonly db: ClientPrismaClient) {}

  async listClients(tenantId: string): Promise<ClientRecord[]> {
    const rows = await this.db.client.findMany({ where: { tenantId }, orderBy: { name: "asc" } });
    return rows.map(toClientRecord);
  }

  async findClient(tenantId: string, clientId: string): Promise<ClientRecord | null> {
    const row = await this.db.client.findFirst({ where: { tenantId, id: clientId } });
    return row ? toClientRecord(row) : null;
  }

  async findClientByName(tenantId: string, name: string): Promise<ClientRecord | null> {
    const row = await this.db.client.findFirst({ where: { tenantId, name } });
    return row ? toClientRecord(row) : null;
  }

  async insertClient(record: ClientRecord): Promise<void> {
    await this.db.client.create({
      data: { id: record.id, tenantId: record.tenantId, name: record.name, createdAt: new Date(record.createdAt) },
    });
  }

  async listContacts(tenantId: string, clientId?: string): Promise<ContactRecord[]> {
    const rows = await this.db.contact.findMany({
      where: clientId === undefined ? { tenantId } : { tenantId, clientId },
      orderBy: { email: "asc" },
    });
    return rows.map(toContactRecord);
  }

  async findContactByEmail(tenantId: string, email: string): Promise<ContactRecord | null> {
    const row = await this.db.contact.findFirst({ where: { tenantId, email } });
    return row ? toContactRecord(row) : null;
  }

  async insertContact(record: ContactRecord): Promise<void> {
    await this.db.contact.create({
      data: {
        id: record.id,
        tenantId: record.tenantId,
        clientId: record.clientId,
        name: record.name,
        email: record.email,
        createdAt: new Date(record.createdAt),
      },
    });
  }

  async listAssignments(tenantId: string, clientId?: string): Promise<ClientAssignmentRecord[]> {
    const rows = await this.db.clientAssignment.findMany({
      where: clientId === undefined ? { tenantId } : { tenantId, clientId },
      orderBy: { assignedAt: "asc" },
    });
    return rows.map(toAssignmentRecord);
  }

  async findAssignment(tenantId: string, clientId: string, userId: string): Promise<ClientAssignmentRecord | null> {
    const row = await this.db.clientAssignment.findFirst({ where: { tenantId, clientId, userId } });
    return row ? toAssignmentRecord(row) : null;
  }

  async insertAssignment(record: ClientAssignmentRecord): Promise<void> {
    await this.db.clientAssignment.create({
      data: {
        id: record.id,
        tenantId: record.tenantId,
        clientId: record.clientId,
        userId: record.userId,
        assignedBy: record.assignedBy,
        assignedAt: new Date(record.assignedAt),
      },
    });
  }

  async removeAssignment(tenantId: string, clientId: string, userId: string): Promise<void> {
    await this.db.clientAssignment.deleteMany({ where: { tenantId, clientId, userId } });
  }

  async listActAs(tenantId: string, actorId?: string): Promise<ClientActAsRecord[]> {
    const rows = await this.db.clientActAsSession.findMany({
      where: actorId === undefined ? { tenantId } : { tenantId, actorId },
      orderBy: { startedAt: "desc" },
    });
    return rows.map(toActAsRecord);
  }

  async findActAs(tenantId: string, sessionId: string): Promise<ClientActAsRecord | null> {
    const row = await this.db.clientActAsSession.findFirst({ where: { tenantId, id: sessionId } });
    return row ? toActAsRecord(row) : null;
  }

  async insertActAs(record: ClientActAsRecord): Promise<void> {
    await this.db.clientActAsSession.create({ data: actAsData(record) });
  }

  async updateActAs(record: ClientActAsRecord): Promise<void> {
    await this.db.clientActAsSession.update({ where: { id: record.id }, data: actAsData(record) });
  }
}

function actAsData(record: ClientActAsRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    clientId: record.clientId,
    actorId: record.actorId,
    reason: record.reason,
    startedAt: new Date(record.startedAt),
    expiresAt: new Date(record.expiresAt),
    endedAt: record.endedAt === null ? null : new Date(record.endedAt),
    endReason: record.endReason,
  };
}
