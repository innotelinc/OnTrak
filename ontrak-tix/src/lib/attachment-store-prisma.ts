/**
 * Prisma adapter for the attachment metadata store (M1).
 *
 * Metadata only — the bytes live behind the `BlobStore` port. Structural like
 * the other adapters, so the real client and a fake are interchangeable.
 */

import type { AttachmentRecord } from "./attachment-rules";
import type { AttachmentStore } from "./attachment-service";

export interface AttachmentRow {
  id: string;
  tenantId: string;
  ticketId: string;
  messageId: string | null;
  uploaderId: string | null;
  filename: string;
  contentType: string;
  byteSize: number;
  storageKey: string;
  createdAt: Date;
}

export interface AttachmentPrismaClient {
  attachment: {
    findMany(args: unknown): Promise<AttachmentRow[]>;
    count(args: unknown): Promise<number>;
    create(args: { data: unknown }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toAttachmentRecord(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ticketId: row.ticketId,
    messageId: row.messageId,
    uploaderId: row.uploaderId,
    filename: row.filename,
    contentType: row.contentType,
    byteSize: row.byteSize,
    storageKey: row.storageKey,
    createdAt: toIso(row.createdAt),
  };
}

export function toAttachmentData(record: AttachmentRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    ticketId: record.ticketId,
    messageId: record.messageId,
    uploaderId: record.uploaderId,
    filename: record.filename,
    contentType: record.contentType,
    byteSize: record.byteSize,
    storageKey: record.storageKey,
    createdAt: new Date(record.createdAt),
  };
}

export class PrismaAttachmentStore implements AttachmentStore {
  constructor(private readonly db: AttachmentPrismaClient) {}

  async listForTicket(tenantId: string, ticketId: string): Promise<AttachmentRecord[]> {
    const rows = await this.db.attachment.findMany({
      where: { tenantId, ticketId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toAttachmentRecord);
  }

  async countForTicket(tenantId: string, ticketId: string): Promise<number> {
    return this.db.attachment.count({ where: { tenantId, ticketId } });
  }

  async insert(record: AttachmentRecord): Promise<void> {
    await this.db.attachment.create({ data: toAttachmentData(record) });
  }
}
