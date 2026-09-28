/**
 * Inbound mail transport (M0): the seam that hands bytes to the `EmailWorker`.
 *
 * The worker already knows how to process one `InboundEmail`. What changes with
 * a deployment is *how* a message arrives: a provider webhook that posts JSON to
 * us, or an IMAP mailbox we poll on a timer. Both converge here on one shape —
 * `MailboxMessage` — so the worker, the decide-what-to-do logic and the intake
 * ledger never learn which transport delivered the mail.
 *
 * Two transports ship:
 *   - `WebhookTransport` parses a provider payload and feeds the worker once.
 *   - `MailboxPoller` drains a `MailboxSource` (IMAP, a queue, a fake) and
 *     acknowledges each message only after the worker has handled it, so a
 *     crash mid-batch leaves the unprocessed mail unseen rather than lost.
 *
 * The content fingerprint the worker dedupes on is the real idempotency guard;
 * acknowledgement is a throughput optimisation, not the correctness boundary.
 */

import type { InboundEmail } from "./intake-rules";
import type { EmailOutcome, EmailWorker } from "./email-worker";

/** One message as a mailbox/webhook hands it over, before the worker sees it. */
export interface MailboxMessage extends InboundEmail {
  /** Mailbox- or provider-assigned id, so the message can be acknowledged. */
  id: string;
}

/** Where messages come from. A real IMAP client or a fake implement this. */
export interface MailboxSource {
  /** Unseen messages, oldest first. */
  fetchUnseen(limit?: number): Promise<MailboxMessage[]>;
  /** Mark a message as processed so it is not delivered twice. */
  acknowledge(id: string): Promise<void>;
}

export type PolledOutcome = { id: string; outcome: EmailOutcome };

/* -------------------------------------------------------------------------- */
/*  Webhook transport                                                         */
/* -------------------------------------------------------------------------- */

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text !== undefined && text.trim() !== "") return text;
  }
  return undefined;
}

function asStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const list = value.map(asString).filter((entry): entry is string => Boolean(entry));
    return list.length > 0 ? list : undefined;
  }
  const single = asString(value);
  if (!single) return undefined;
  return single
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Turn a provider webhook body into the worker's `InboundEmail`.
 *
 * Providers disagree on field names, so we accept the common aliases rather than
 * force one vendor's shape. Anything without a sender and a body is not a
 * message we can act on, and returns `null` so the handler can answer 400
 * instead of opening a junk ticket.
 */
export function parseWebhookEmail(body: unknown): InboundEmail | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;

  const from = firstString(raw.from, raw.sender, raw.From, raw.replyTo);
  const subject = firstString(raw.subject, raw.Subject) ?? "";
  const text = firstString(raw.body, raw.text, raw.plain, raw["stripped-text"], raw.content);
  if (!from || text === undefined) return null;

  return {
    from,
    to: asStringList(raw.to ?? raw.recipients ?? raw.To) ?? [],
    subject,
    body: text,
    messageId: firstString(raw.messageId, raw["message-id"], raw.MessageID, raw.id),
    inReplyTo: firstString(raw.inReplyTo, raw["in-reply-to"], raw.InReplyTo),
    references: asStringList(raw.references ?? raw.References),
    autoSubmitted: firstString(raw.autoSubmitted, raw["auto-submitted"], raw.AutoSubmitted),
    precedence: firstString(raw.precedence, raw.Precedence),
  };
}

/** Handles one webhook delivery for a tenant, end to end. */
export class WebhookTransport {
  constructor(
    private readonly worker: EmailWorker,
    private readonly tenantId: string,
  ) {}

  /**
   * Returns the worker's outcome, or `null` when the payload never was a mail
   * we could parse (so the caller can reject it without side effects).
   */
  async receive(body: unknown): Promise<EmailOutcome | null> {
    const email = parseWebhookEmail(body);
    if (!email) return null;
    return this.worker.handle(this.tenantId, email);
  }
}

/* -------------------------------------------------------------------------- */
/*  Mailbox poller                                                            */
/* -------------------------------------------------------------------------- */

/** The outcomes of one poll, plus how many messages were left for a retry. */
export interface PollResult {
  outcomes: PolledOutcome[];
  /** Messages the worker could not process; left unseen for the next poll. */
  deferred: number;
}

/**
 * Drain a mailbox through the worker.
 *
 * A successful handle is acknowledged. A `failed` outcome is *not* — the ticket
 * was never recorded, so leaving it unseen lets the next poll retry it without
 * a duplicate, which is the whole point of the intake ledger.
 */
export class MailboxPoller {
  constructor(
    private readonly worker: EmailWorker,
    private readonly tenantId: string,
    private readonly source: MailboxSource,
  ) {}

  async poll(limit = 25): Promise<PollResult> {
    const messages = await this.source.fetchUnseen(limit);
    const outcomes: PolledOutcome[] = [];
    let deferred = 0;

    for (const message of messages) {
      const { id, ...email } = message;
      const outcome = await this.worker.handle(this.tenantId, email);
      outcomes.push({ id, outcome });
      if (outcome.kind === "failed") {
        deferred += 1;
        continue;
      }
      await this.source.acknowledge(id);
    }

    return { outcomes, deferred };
  }
}

/* -------------------------------------------------------------------------- */
/*  IMAP adapter                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One message as an IMAP server hands it over: a UID, decoded headers and the
 * plain-text body. The mapping to mail headers is the only IMAP-specific part,
 * so it lives behind this shape.
 */
export interface ImapMessage {
  uid: number;
  /** Header names in any case; lookup is case-insensitive. */
  headers: Record<string, string>;
  text: string;
}

/** The IMAP operations the transport needs, so any client can slot in. */
export interface ImapClient {
  /** UIDs of unseen messages, oldest first. */
  searchUnseen(): Promise<number[]>;
  fetch(uid: number): Promise<ImapMessage>;
  /** Set the `\Seen` flag. */
  markSeen(uid: number): Promise<void>;
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** Map a fetched IMAP message onto the transport's neutral shape. */
export function imapMessageToMailboxMessage(message: ImapMessage): MailboxMessage {
  const references = header(message.headers, "References")
    ?.split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  return {
    id: String(message.uid),
    from: header(message.headers, "From") ?? "",
    to: (header(message.headers, "To") ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
    subject: header(message.headers, "Subject") ?? "",
    body: message.text,
    messageId: header(message.headers, "Message-ID"),
    inReplyTo: header(message.headers, "In-Reply-To"),
    references,
    autoSubmitted: header(message.headers, "Auto-Submitted"),
    precedence: header(message.headers, "Precedence"),
  };
}

/** A `MailboxSource` over a connected IMAP client. */
export class ImapMailboxSource implements MailboxSource {
  constructor(private readonly client: ImapClient) {}

  async fetchUnseen(limit = 25): Promise<MailboxMessage[]> {
    const uids = await this.client.searchUnseen();
    const chosen = uids.slice(0, limit);
    const messages: MailboxMessage[] = [];
    for (const uid of chosen) {
      messages.push(imapMessageToMailboxMessage(await this.client.fetch(uid)));
    }
    return messages;
  }

  async acknowledge(id: string): Promise<void> {
    const uid = Number(id);
    if (Number.isFinite(uid)) await this.client.markSeen(uid);
  }
}

/* -------------------------------------------------------------------------- */
/*  In-memory mailbox (tests and local work)                                  */
/* -------------------------------------------------------------------------- */

/** An in-memory mailbox whose "unseen" set is emptied by acknowledgement. */
export class MemoryMailboxSource implements MailboxSource {
  private readonly messages = new Map<string, MailboxMessage>();

  /** Queue a message; returns the id so a test can assert on it. */
  add(message: Omit<MailboxMessage, "id"> & { id?: string }): string {
    const id = message.id ?? `m_${this.messages.size + 1}`;
    this.messages.set(id, { ...message, id });
    return id;
  }

  /** How many messages are still unseen. */
  get size(): number {
    return this.messages.size;
  }

  async fetchUnseen(limit = 25): Promise<MailboxMessage[]> {
    return [...this.messages.values()].slice(0, limit).map((message) => ({ ...message }));
  }

  async acknowledge(id: string): Promise<void> {
    this.messages.delete(id);
  }
}
