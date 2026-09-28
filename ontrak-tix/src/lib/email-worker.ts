/**
 * Email worker (M0): carry one inbound message through the ingestion decision.
 *
 * The decision itself lives in `intake-service.ts` and is pure; this is the part
 * that changes with the transport — it resolves the sender to a requester,
 * creates or appends the ticket through the normal `TicketService` (so the same
 * access rules and audit trail apply), and records the message in the intake
 * ledger so a retry is a no-op.
 *
 * Two seams keep it testable and swappable: `IntakeStore` (the ledger and
 * requester lookup) and the injected `TicketService`. The transport that hands
 * us bytes — IMAP, a provider webhook — substitutes only `InboundEmail`.
 */

import {
  extractEmailAddress,
  normalizeMessageId,
  parseInboundEmail,
  type InboundEmail,
} from "./intake-rules";
import {
  ingestionActor,
  isIngestionEnabled,
  planIngestion,
  ticketInputFromDraft,
  type IngestionState,
} from "./intake-service";
import type { TicketService } from "./ticket-service";

/** One processed inbound message, as the ledger remembers it. */
export interface IntakeRecord {
  dedupeKey: string;
  messageId?: string;
  ticketId?: string;
}

/** The dedupe + thread ledger, plus requester resolution. */
export interface IntakeStore {
  seen(tenantId: string, dedupeKey: string): Promise<boolean>;
  threadTicket(tenantId: string, messageId: string): Promise<string | null>;
  record(tenantId: string, record: IntakeRecord): Promise<void>;
  requesterFor(tenantId: string, email: string): Promise<string | null>;
  /** Create a requester account for an unknown sender, returning its id. */
  ensureRequester(tenantId: string, email: string): Promise<string>;
}

export type EmailOutcome =
  | { kind: "disabled" }
  | { kind: "duplicate"; dedupeKey: string }
  | { kind: "rejected"; reason: string }
  | { kind: "created"; ticketId: string; ref: string }
  | { kind: "appended"; ticketId: string }
  | { kind: "failed"; error: string };

export class EmailWorker {
  constructor(
    private readonly service: TicketService,
    private readonly store: IntakeStore,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  async handle(tenantId: string, email: InboundEmail): Promise<EmailOutcome> {
    if (!isIngestionEnabled(this.env)) return { kind: "disabled" };

    const parsed = parseInboundEmail(email);
    // Duplicate first: a retry of the same message must never double-post.
    if (await this.store.seen(tenantId, parsed.dedupeKey)) {
      return { kind: "duplicate", dedupeKey: parsed.dedupeKey };
    }

    const threads = new Map<string, string>();
    if (parsed.threadParent) {
      const ticketId = await this.store.threadTicket(tenantId, parsed.threadParent);
      if (ticketId) threads.set(parsed.threadParent, ticketId);
    }
    const state: IngestionState = { processed: new Set<string>(), threads };

    const plan = planIngestion(email, this.env, state);
    const actor = ingestionActor(tenantId);

    switch (plan.kind) {
      case "disabled":
        return { kind: "disabled" };
      case "duplicate":
        return { kind: "duplicate", dedupeKey: plan.dedupeKey };
      case "reject":
        // Record the rejection so a retry is quiet rather than a second refusal.
        await this.store.record(tenantId, {
          dedupeKey: plan.dedupeKey,
          messageId: normalizeMessageId(email.messageId),
        });
        return { kind: "rejected", reason: plan.reason };

      case "append": {
        const result = await this.service.reply(actor, plan.ticketId, plan.body, "PUBLIC_REPLY");
        if (!result.ok) return { kind: "failed", error: result.error };
        await this.store.record(tenantId, {
          dedupeKey: plan.dedupeKey,
          messageId: plan.messageId,
          ticketId: plan.ticketId,
        });
        return { kind: "appended", ticketId: plan.ticketId };
      }

      case "create": {
        const found = await this.store.requesterFor(tenantId, plan.draft.requesterEmail);
        const requesterId = found ?? (await this.store.ensureRequester(tenantId, plan.draft.requesterEmail));
        const result = await this.service.createTicket(actor, ticketInputFromDraft(plan.draft, requesterId));
        if (!result.ok) return { kind: "failed", error: result.error };
        await this.store.record(tenantId, {
          dedupeKey: plan.dedupeKey,
          messageId: normalizeMessageId(email.messageId),
          ticketId: result.value.id,
        });
        return { kind: "created", ticketId: result.value.id, ref: result.value.ref };
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Prisma-backed ledger                                                      */
/* -------------------------------------------------------------------------- */

export interface IntakePrismaClient {
  inboundMessage: {
    findFirst(args: unknown): Promise<{ ticketId: string | null } | null>;
    upsert(args: unknown): Promise<unknown>;
  };
  user: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
    create(args: unknown): Promise<{ id: string }>;
  };
}

/** A local-part display name for a requester the desk has never seen. */
export function displayNameFromEmail(email: string): string {
  const local = extractEmailAddress(email).split("@")[0] ?? "Requester";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Requester";
}

export class PrismaIntakeStore implements IntakeStore {
  constructor(private readonly db: IntakePrismaClient) {}

  async seen(tenantId: string, dedupeKey: string): Promise<boolean> {
    return (await this.db.inboundMessage.findFirst({ where: { tenantId, dedupeKey } })) !== null;
  }

  async threadTicket(tenantId: string, messageId: string): Promise<string | null> {
    const row = await this.db.inboundMessage.findFirst({ where: { tenantId, messageId } });
    return row?.ticketId ?? null;
  }

  async record(tenantId: string, record: IntakeRecord): Promise<void> {
    await this.db.inboundMessage.upsert({
      where: { tenantId_dedupeKey: { tenantId, dedupeKey: record.dedupeKey } },
      update: { messageId: record.messageId, ticketId: record.ticketId },
      create: { tenantId, dedupeKey: record.dedupeKey, messageId: record.messageId, ticketId: record.ticketId },
    });
  }

  async requesterFor(tenantId: string, email: string): Promise<string | null> {
    const user = await this.db.user.findFirst({
      where: { tenantId, email: extractEmailAddress(email), role: "REQUESTER", active: true },
    });
    return user?.id ?? null;
  }

  async ensureRequester(tenantId: string, email: string): Promise<string> {
    const address = extractEmailAddress(email);
    const existing = await this.db.user.findFirst({ where: { tenantId, email: address } });
    if (existing) return existing.id;
    const created = await this.db.user.create({
      data: { tenantId, email: address, displayName: displayNameFromEmail(address), role: "REQUESTER" },
    });
    return created.id;
  }
}

/* -------------------------------------------------------------------------- */
/*  In-memory ledger (tests and local work)                                   */
/* -------------------------------------------------------------------------- */

export class MemoryIntakeStore implements IntakeStore {
  private readonly records = new Map<string, IntakeRecord>();
  private readonly requesters = new Map<string, string>();
  private counter = 0;

  private key(tenantId: string, dedupeKey: string): string {
    return `${tenantId}:${dedupeKey}`;
  }

  async seen(tenantId: string, dedupeKey: string): Promise<boolean> {
    return this.records.has(this.key(tenantId, dedupeKey));
  }

  async threadTicket(tenantId: string, messageId: string): Promise<string | null> {
    for (const record of this.records.values()) {
      if (record.messageId === messageId && record.ticketId) return record.ticketId;
    }
    return null;
  }

  async record(tenantId: string, record: IntakeRecord): Promise<void> {
    this.records.set(this.key(tenantId, record.dedupeKey), structuredClone(record));
  }

  async requesterFor(tenantId: string, email: string): Promise<string | null> {
    return this.requesters.get(`${tenantId}:${extractEmailAddress(email)}`) ?? null;
  }

  async ensureRequester(tenantId: string, email: string): Promise<string> {
    const key = `${tenantId}:${extractEmailAddress(email)}`;
    const existing = this.requesters.get(key);
    if (existing) return existing;
    this.counter += 1;
    const id = `u_new_${this.counter}`;
    this.requesters.set(key, id);
    return id;
  }
}
