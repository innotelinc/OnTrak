/**
 * Attachment service (M1): validate, store the bytes, persist the metadata.
 *
 * The bytes and the metadata travel different paths on purpose — object storage
 * for the bytes, a row for the metadata — so a failed metadata write can be
 * cleaned up and a leaked key is useless without the row that names it. All the
 * decisions live in `attachment-rules.ts`; this only sequences them.
 */

import { randomUUID } from "node:crypto";

import { canReplyToTicket, type Actor } from "./access-rules";
import {
  DEFAULT_ATTACHMENT_LIMITS,
  storageKeyFor,
  validateAttachments,
  type AttachmentLimits,
  type AttachmentRecord,
  type BlobStore,
} from "./attachment-rules";
import type { TicketRecord } from "./ticket-service";

/** One uploaded file: the client-declared metadata plus its bytes. */
export interface AttachmentUpload {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export type AttachmentResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface AttachmentStore {
  listForTicket(tenantId: string, ticketId: string): Promise<AttachmentRecord[]>;
  countForTicket(tenantId: string, ticketId: string): Promise<number>;
  insert(record: AttachmentRecord): Promise<void>;
}

export interface AttachmentIds {
  id(): string;
  now(): string;
}

export function systemAttachmentIds(): AttachmentIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

/** The minimum a ticket must expose to attach a file to it. */
export type AttachableTicket = Pick<TicketRecord, "id" | "tenantId" | "requesterId" | "assigneeId">;

export class AttachmentService {
  constructor(
    private readonly store: AttachmentStore,
    private readonly blobs: BlobStore,
    private readonly limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
    private readonly ids: AttachmentIds = systemAttachmentIds(),
  ) {}

  async list(actor: Actor, ticket: AttachableTicket): Promise<AttachmentRecord[]> {
    if (!canReplyToTicket(actor, ticket)) return [];
    return this.store.listForTicket(ticket.tenantId, ticket.id);
  }

  /**
   * Validate a batch, write the bytes, then the rows. Nothing is persisted for a
   * batch that fails validation, so a rejected upload never leaves an orphan.
   */
  async attach(actor: Actor, ticket: AttachableTicket, uploads: readonly AttachmentUpload[]): Promise<AttachmentResult<AttachmentRecord[]>> {
    if (!canReplyToTicket(actor, ticket)) return { ok: false, error: "You cannot attach files to this ticket." };

    const candidates = uploads.map((upload) => ({
      filename: upload.filename,
      contentType: upload.contentType,
      byteSize: upload.data.byteLength,
    }));
    const existing = await this.store.countForTicket(ticket.tenantId, ticket.id);
    const issues = validateAttachments(candidates, existing, this.limits);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const records: AttachmentRecord[] = [];
    const written: string[] = [];
    try {
      for (const upload of uploads) {
        const id = this.ids.id();
        const storageKey = storageKeyFor(ticket.tenantId, ticket.id, id, upload.filename);
        await this.blobs.put(storageKey, upload.data, upload.contentType);
        written.push(storageKey);
        records.push({
          id,
          tenantId: ticket.tenantId,
          ticketId: ticket.id,
          messageId: null,
          uploaderId: actor.id,
          filename: upload.filename,
          contentType: upload.contentType,
          byteSize: upload.data.byteLength,
          storageKey,
          createdAt: this.ids.now(),
        });
      }
      for (const record of records) await this.store.insert(record);
    } catch (error) {
      // Roll the blobs back so a partial write cannot leak storage or charge.
      for (const key of written) await this.blobs.delete(key).catch(() => undefined);
      throw error;
    }

    return { ok: true, value: records };
  }
}

/** An in-memory metadata store, used by tests and local development. */
export class MemoryAttachmentStore implements AttachmentStore {
  private readonly records = new Map<string, AttachmentRecord>();

  async listForTicket(tenantId: string, ticketId: string): Promise<AttachmentRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.tenantId === tenantId && record.ticketId === ticketId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((record) => structuredClone(record));
  }

  async countForTicket(tenantId: string, ticketId: string): Promise<number> {
    return [...this.records.values()].filter((record) => record.tenantId === tenantId && record.ticketId === ticketId).length;
  }

  async insert(record: AttachmentRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }
}
