/**
 * Ingestion service (M0): the decision the email worker makes for one message,
 * gated by a feature flag and safe to retry.
 *
 * The worker that carries bytes is deliberately not here — it changes with the
 * transport (IMAP, a webhook, a provider API). What must not change is the
 * decision, so it lives in this pure function: disabled, duplicate, rejected,
 * a new ticket, or an append to an existing thread.
 */

import type { Actor } from "./access-rules";
import type { TicketInput } from "./ticket-rules";
import {
  classifyType,
  extractEmailAddress,
  inferPriority,
  normalizeMessageId,
  normalizeSubject,
  parseInboundEmail,
  type InboundEmail,
  type NewTicketDraft,
} from "./intake-rules";

/** Set to `"true"` to allow mail to open or append tickets. */
export const INGESTION_FLAG = "ONTRAK_TIX_EMAIL_INGESTION";

export function isIngestionEnabled(env: Record<string, string | undefined>): boolean {
  return (env[INGESTION_FLAG] ?? "").trim().toLowerCase() === "true";
}

/** The actor a machine-driven ingest runs as, for the audit trail. */
export function ingestionActor(tenantId: string): Actor {
  return { id: "system:email", tenantId, role: "AGENT" };
}

/** The state the worker keeps between messages: dedupe keys and thread links. */
export interface IngestionState {
  /** Dedupe keys already turned into (or appended to) a ticket. */
  processed: ReadonlySet<string>;
  /** Normalized `Message-ID` → ticket id, for threading replies. */
  threads: ReadonlyMap<string, string>;
}

export type IngestionPlan =
  | { kind: "disabled" }
  | { kind: "duplicate"; dedupeKey: string }
  | { kind: "reject"; reason: string; dedupeKey: string }
  | { kind: "create"; draft: NewTicketDraft; dedupeKey: string }
  | {
      kind: "append";
      ticketId: string;
      body: string;
      inReplyTo: string;
      messageId?: string;
      dedupeKey: string;
    };

/**
 * Decide what to do with one inbound mail. Retrying the same message is always
 * safe: a key already in `processed` returns `duplicate` before any other rule.
 */
export function planIngestion(
  email: InboundEmail,
  env: Record<string, string | undefined>,
  state: IngestionState,
): IngestionPlan {
  if (!isIngestionEnabled(env)) return { kind: "disabled" };

  const parsed = parseInboundEmail(email);
  if (state.processed.has(parsed.dedupeKey)) {
    return { kind: "duplicate", dedupeKey: parsed.dedupeKey };
  }
  if (!parsed.accept) {
    return { kind: "reject", reason: parsed.reason ?? "Message was rejected.", dedupeKey: parsed.dedupeKey };
  }

  // A reply whose parent we know continues that ticket...
  if (parsed.threadParent) {
    const ticketId = state.threads.get(parsed.threadParent);
    if (ticketId) {
      return {
        kind: "append",
        ticketId,
        body: email.body,
        inReplyTo: parsed.threadParent,
        messageId: normalizeMessageId(email.messageId),
        dedupeKey: parsed.dedupeKey,
      };
    }
    // ...and a reply whose parent we have never seen still has to become work,
    // so it opens a fresh ticket from the cleaned subject.
  }

  return { kind: "create", draft: parsed.newTicket ?? draftFrom(email), dedupeKey: parsed.dedupeKey };
}

/** Turn an accepted plan's draft into the fields `TicketService.createTicket` wants. */
export function ticketInputFromDraft(draft: NewTicketDraft, requesterId: string): TicketInput {
  return {
    subject: draft.subject,
    description: draft.description,
    type: draft.type,
    priority: draft.priority,
    requesterId,
  };
}

/** A ticket draft for a mail that parsed as a thread reply with no known parent. */
function draftFrom(email: InboundEmail): NewTicketDraft {
  const sender = extractEmailAddress(email.from);
  const subject = normalizeSubject(email.subject) || "(no subject)";
  const body = email.body.trim();
  return {
    requesterEmail: sender,
    subject,
    description: body || subject,
    type: classifyType(email.subject, body),
    priority: inferPriority(email.subject, body),
  };
}
