/**
 * Intake rules (M0): turn an inbound email into a ticket, or decide not to.
 *
 * Email is the hardest intake channel — bounces, auto-responders and threading
 * all have to be handled before a message becomes work. Keeping the decision
 * here, pure and tested, means the ingestion worker only has to move bytes.
 */

import type { TicketPriority, TicketType } from "./ticket-rules";

export interface InboundEmail {
  /** Raw `From`, e.g. `Ada Lovelace <ada@client.example>`. */
  from: string;
  to: string[];
  subject: string;
  body: string;
  /** The mail's own `Message-ID`, kept (normalized) for future threading. */
  messageId?: string;
  /** `In-Reply-To` header, when the mail answers an earlier message. */
  inReplyTo?: string;
  /** `References` header; the first entry is the thread root. */
  references?: string[];
  /** `Auto-Submitted` header value. `no` (or absent) means a human sent it. */
  autoSubmitted?: string;
  /** `Precedence` header, e.g. `bulk`, `junk`, `list`. */
  precedence?: string;
}

export interface NewTicketDraft {
  requesterEmail: string;
  subject: string;
  description: string;
  type: TicketType;
  priority: TicketPriority;
}

export interface IntakeResult {
  /** Whether a ticket should be created or appended. */
  accept: boolean;
  /** Why it was rejected, when `accept` is false. */
  reason?: string;
  /** A new ticket, when the mail starts a thread. */
  newTicket?: NewTicketDraft;
  /** Normalized `Message-ID` this mail replies to, when it continues a thread. */
  threadParent?: string;
  /**
   * Idempotency key. A retried ingestion of the same mail must not create a
   * second ticket, so the worker dedupes on this.
   */
  dedupeKey: string;
}

/* -------------------------------------------------------------------------- */
/*  Normalization helpers                                                     */
/* -------------------------------------------------------------------------- */

/** Strip the angle brackets mail clients wrap `Message-ID` values in. */
export function normalizeMessageId(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/^</, "").replace(/>$/, "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** `"Ada Lovelace <ada@client.example>"` → `"ada@client.example"`. */
export function extractEmailAddress(raw: string): string {
  const angled = raw.match(/<([^>]+)>/);
  const value = (angled?.[1] ?? raw).trim();
  return value.toLowerCase();
}

/** Whether a string looks like an email address at all. */
export function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

const SUBJECT_PREFIX = /^(?:\s*(?:re|fwd?|aw|sv)\s*(?:\[\d+\])?\s*:\s*)+/i;

/** Drop `Re:`/`Fwd:` chains so replies line up under one subject. */
export function normalizeSubject(subject: string): string {
  return subject.replace(SUBJECT_PREFIX, "").trim();
}

/* -------------------------------------------------------------------------- */
/*  Classification                                                            */
/* -------------------------------------------------------------------------- */

const AUTOREPLY_SUBJECT = /^(?:automatic reply|auto[- ]?reply|out of office|autoreply|undeliverable|delivery (?:status )?notification|returned mail|mail delivery failed)/i;

/**
 * Whether a mail was sent by a machine. Bounces, vacation responders and list
 * traffic must never open a ticket — that is how a mailbox turns into a ticket
 * storm.
 */
export function isAutoReply(email: InboundEmail): boolean {
  const auto = email.autoSubmitted?.trim().toLowerCase();
  if (auto && auto !== "no") return true;
  const precedence = email.precedence?.trim().toLowerCase();
  if (precedence && ["bulk", "junk", "list"].includes(precedence)) return true;
  return AUTOREPLY_SUBJECT.test(normalizeSubject(email.subject));
}

const REQUEST_HINT = /\b(?:request(?:ing)?|please (?:add|create|enable|install|grant|provision|order)|new (?:user|account|laptop|hire|starter)|onboard|purchase|access to)\b/i;
const URGENT_HINT = /\b(?:urgent|critical|outage|down|asap|p1|sev(?:erity)? ?1|everything is broken)\b/i;
const HIGH_HINT = /\b(?:high|important|blocking|cannot work|can'?t work|blocked|impacting)\b/i;

/** A work request versus something broken. Defaults to an incident. */
export function classifyType(subject: string, body = ""): TicketType {
  return REQUEST_HINT.test(`${subject}\n${body}`) ? "REQUEST" : "INCIDENT";
}

/** Infer an opening priority from the wording. Defaults to `NORMAL`. */
export function inferPriority(subject: string, body = ""): TicketPriority {
  const text = `${subject}\n${body}`;
  if (URGENT_HINT.test(text)) return "URGENT";
  if (HIGH_HINT.test(text)) return "HIGH";
  return "NORMAL";
}

/* -------------------------------------------------------------------------- */
/*  The decision                                                              */
/* -------------------------------------------------------------------------- */

/** The mail this one answers, if any, as a normalized `Message-ID`. */
export function resolveThreadParent(email: InboundEmail): string | undefined {
  return normalizeMessageId(email.inReplyTo) ?? normalizeMessageId(email.references?.[0]);
}

/**
 * A stable idempotency key. Prefers the mail's own `Message-ID`, and falls back
 * to a content fingerprint for mails that arrive without one.
 */
export function dedupeKey(email: InboundEmail): string {
  const messageId = normalizeMessageId(email.messageId);
  if (messageId) return `mid:${messageId}`;
  const sender = extractEmailAddress(email.from);
  const subject = normalizeSubject(email.subject).toLowerCase();
  const snippet = email.body.trim().slice(0, 200).replace(/\s+/g, " ");
  return `fp:${sender}|${subject}|${snippet}`;
}

/**
 * Turn one inbound mail into an intake decision. A reply continues an existing
 * thread (the worker appends it); anything else the machine sent is refused;
 * everything else becomes a new ticket.
 */
export function parseInboundEmail(email: InboundEmail): IntakeResult {
  const key = dedupeKey(email);

  if (isAutoReply(email)) {
    return { accept: false, reason: "Message looks machine-generated (auto-reply or bounce).", dedupeKey: key };
  }

  const sender = extractEmailAddress(email.from);
  if (!sender || !isEmailAddress(sender)) {
    return { accept: false, reason: "Message has no usable sender address.", dedupeKey: key };
  }

  const threadParent = resolveThreadParent(email);
  if (threadParent) {
    return { accept: true, threadParent, dedupeKey: key };
  }

  const subject = normalizeSubject(email.subject) || "(no subject)";
  const body = email.body.trim();
  return {
    accept: true,
    newTicket: {
      requesterEmail: sender,
      subject,
      description: body || subject,
      type: classifyType(email.subject, body),
      priority: inferPriority(email.subject, body),
    },
    dedupeKey: key,
  };
}
