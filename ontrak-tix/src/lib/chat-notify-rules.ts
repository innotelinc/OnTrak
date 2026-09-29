/**
 * Chat notification rules (M6): telling a room what the desk just did, safely.
 *
 * The webhook half of M6 is a *contract*: register an endpoint, get signed JSON,
 * reconcile the delivery log. That is what an integration needs and it is not what
 * an MSP's service desk needs at nine in the morning, which is a message in the
 * channel where the on-call rota already lives. This module is that: the same
 * delivery discipline, pointed at Slack and Teams.
 *
 * Four choices worth stating out loud:
 *
 *  1. **The URL is the provider's, and only the provider's.** A generic webhook may
 *     go anywhere `https`; a chat channel is a fixed destination, so `hooks.slack.com`
 *     and the Teams bot hosts are the *only* hosts this connector will post to. That
 *     is a stronger promise than "https", and it is what stops a ticket subject from
 *     being the thing that decides where the desk connects next.
 *  2. **A ticket's text is data, not markup.** Every value goes into the room
 *     escaped — Slack's `&`, `<`, `>` entities, markdown metacharacters for Teams —
 *     so a subject containing `<!channel>` does not page four hundred people and a
 *     subject containing a link does not become one. A chat message is the one place
 *     our users' words are rendered by somebody else's parser.
 *  3. **The payload is per provider, but the message is not.** One `ChatMessage` is
 *     built from an event; Slack's Block Kit and Teams' MessageCard are two
 *     renderings of it. Adding a provider is then a renderer, not a second pipeline.
 *  4. **Delivery is a state machine, shared with webhooks.** `DELIVERED`,
 *     `RETRYING` with the instant of the next attempt, or `EXHAUSTED` after five —
 *     the same arithmetic as `webhook-rules.ts`, because "did our notification
 *     arrive?" should have exactly one answer in this product, whatever the
 *     destination looks like.
 *
 * Pure: no clock, no network, no `fetch`. The transport is a port in the service and
 * the clock is handed in, so the retry arithmetic is tested without waiting for one,
 * and the renderers are tested by asserting on strings.
 */

import { DELIVERY_MAX_ATTEMPTS, WEBHOOK_EVENTS, type DeliveryStatus, type WebhookEvent } from "./webhook-rules";

/* -------------------------------------------------------------------------- */
/*  Providers                                                                 */
/* -------------------------------------------------------------------------- */

export const CHAT_PROVIDERS = ["SLACK", "TEAMS"] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

export function isChatProvider(value: string): value is ChatProvider {
  return (CHAT_PROVIDERS as readonly string[]).includes(value);
}

/** What a person calls the provider, for a console that has to print it. */
export function chatProviderLabel(provider: ChatProvider): string {
  return provider === "SLACK" ? "Slack" : "Microsoft Teams";
}

/* -------------------------------------------------------------------------- */
/*  Events                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The events a channel may ask for: the *same closed set* the webhook API emits.
 *
 * Deliberately not a separate list. Two lists of events is two chances to forget
 * one, and "the API told my integration but not my channel" is a support ticket
 * whose answer would be "they are configured differently".
 */
export const CHAT_EVENTS = WEBHOOK_EVENTS;
export type ChatEvent = WebhookEvent;

/** A delivery's event, plus the one a channel can be asked to send on demand. */
export type ChatDeliveryEvent = ChatEvent | "test";

export function chatEventLabel(event: ChatDeliveryEvent): string {
  switch (event) {
    case "ticket.created":
      return "Ticket created";
    case "ticket.updated":
      return "Ticket updated";
    case "ticket.replied":
      return "Ticket replied to";
    case "test":
      return "Test message";
  }
}

/* -------------------------------------------------------------------------- */
/*  Channels                                                                  */
/* -------------------------------------------------------------------------- */

export const CHAT_NAME_MAX = 120;
export const CHAT_URL_MAX = 2_000;
export const CHAT_TIMEOUT_MS = 10_000;

export interface ChatChannelRecord {
  id: string;
  tenantId: string;
  provider: ChatProvider;
  name: string;
  url: string;
  events: readonly ChatEvent[];
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  disabledAt: string | null;
}

export interface ChatIssue {
  field: string;
  message: string;
}

/**
 * The hosts a provider owns.
 *
 * Slack incoming webhooks and Teams' `webhookb2` connectors and Power Automate
 * workflow URLs, and nothing else. A prefix match on the suffix rather than a
 * substring match on the whole host is the difference between accepting
 * `hooks.slack.com` and accepting `hooks.slack.com.evil.test`.
 */
const PROVIDER_HOSTS: Record<ChatProvider, readonly string[]> = {
  SLACK: ["hooks.slack.com", "hooks.slack-gov.com"],
  TEAMS: ["webhook.office.com", "outlook.office.com", "logic.azure.com"],
};

function hostBelongsTo(provider: ChatProvider, hostname: string): boolean {
  const host = hostname.toLowerCase();
  return PROVIDER_HOSTS[provider].some((owned) => host === owned || host.endsWith(`.${owned}`));
}

/**
 * Whether we would post to this URL at all.
 *
 * `https` only — a chat notification carries a ticket's subject and its reference,
 * and a plain-`http` destination puts them on the wire in the clear. No fragment
 * (it is never sent, so the message would be rendered and then dropped) and no
 * embedded credentials (they would be forwarded to the provider, which is a way to
 * smuggle a secret into somebody else's logs).
 */
export function isRegistrableChatUrl(provider: ChatProvider, value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.hash) return false;
  if (url.username || url.password) return false;
  return hostBelongsTo(provider, url.hostname);
}

export function validateChatChannel(input: {
  provider?: string;
  name?: string;
  url?: string;
  events?: readonly string[];
}): ChatIssue[] {
  const issues: ChatIssue[] = [];

  const provider = input.provider?.trim().toUpperCase() ?? "";
  if (!isChatProvider(provider)) {
    issues.push({ field: "provider", message: `“${input.provider ?? ""}” is not a chat provider we post to.` });
  }

  const name = input.name?.trim() ?? "";
  if (!name) issues.push({ field: "name", message: "A name is required, so somebody can tell this channel from the others." });
  else if (name.length > CHAT_NAME_MAX) {
    issues.push({ field: "name", message: `The name may be at most ${CHAT_NAME_MAX} characters.` });
  }

  const url = input.url?.trim() ?? "";
  if (!url) issues.push({ field: "url", message: "A webhook URL is required." });
  else if (url.length > CHAT_URL_MAX) {
    issues.push({ field: "url", message: `The URL may be at most ${CHAT_URL_MAX} characters.` });
  } else if (isChatProvider(provider) && !isRegistrableChatUrl(provider, url)) {
    issues.push({
      field: "url",
      message: `That is not a ${chatProviderLabel(provider)} webhook URL: it must be https on ${PROVIDER_HOSTS[provider][0]} (or another host the provider owns).`,
    });
  }

  const events = input.events ?? [];
  if (events.length === 0) issues.push({ field: "events", message: "At least one event is required." });
  if (new Set(events).size !== events.length) {
    issues.push({ field: "events", message: "The same event is listed twice." });
  }
  for (const event of events) {
    if (!(CHAT_EVENTS as readonly string[]).includes(event)) {
      issues.push({ field: "events", message: `“${event}” is not an event the desk announces.` });
    }
  }

  return issues;
}

/** Whether a channel asked for this event. A disabled channel asks for nothing. */
export function channelsFor(channels: readonly ChatChannelRecord[], event: ChatEvent): ChatChannelRecord[] {
  return channels.filter((channel) => channel.enabled && channel.events.includes(event));
}

/* -------------------------------------------------------------------------- */
/*  The message                                                               */
/* -------------------------------------------------------------------------- */

export interface ChatField {
  label: string;
  value: string;
}

export interface ChatMessage {
  event: ChatDeliveryEvent;
  /** One line, used where a client shows a notification summary. */
  title: string;
  /** The body. Plain text: each renderer escapes it for its own parser. */
  text: string;
  /** Where a person can open the thing the message is about, when we know. */
  url: string | null;
  fields: readonly ChatField[];
}

/**
 * The message one ticket event produces.
 *
 * The title carries the reference and what happened, the body carries the subject,
 * and the fields carry the two things somebody on call triages on — priority and
 * status — because a message that says only "a ticket was created" makes every
 * notification equally urgent, and a channel where everything is urgent is a channel
 * nobody reads. A requester's name is deliberately *not* here: getting one means a
 * directory lookup on the hot path of every creation, and the link is where the
 * detail already lives.
 */
export function ticketChatMessage(input: {
  event: ChatEvent;
  ref: string;
  subject: string;
  status: string;
  priority: string;
  url?: string | null;
}): ChatMessage {
  return {
    event: input.event,
    title: `${input.ref} · ${chatEventLabel(input.event)}`,
    text: input.subject,
    url: input.url ?? null,
    fields: [
      { label: "Priority", value: input.priority },
      { label: "Status", value: input.status },
    ],
  };
}

/** The message the console's test button sends, so somebody can prove a channel works. */
export function testChatMessage(input: { channelName: string; url?: string | null }): ChatMessage {
  return {
    event: "test",
    title: "OnTrak Tix is connected",
    text: `This is a test message for the channel “${input.channelName}”. Nothing is wrong: if you can read this, the desk can reach this room.`,
    url: input.url ?? null,
    fields: [{ label: "Sent from", value: "OnTrak Tix · integrations" }],
  };
}

/* -------------------------------------------------------------------------- */
/*  Escaping                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Slack's `mrkdwn` escaping, exactly as Slack documents it: three entities, and
 * that is the whole of it.
 *
 * The reason it is not cosmetic: `<!channel>`, `<!here>` and `<!everyone>` are
 * *live* control tokens in a Slack message, and `<https://…|label>` is a link. A
 * ticket subject is written by a requester, so a subject of `<!channel> disk full`
 * would page the room from a help-desk form, and `<https://evil.test|our intranet>`
 * would put an attacker's link behind our words. Escaping `<` is what makes a
 * subject data.
 */
export function escapeSlackText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Teams' MessageCard text is markdown, so the metacharacters are escaped with a
 * backslash and the three HTML-significant characters are escaped as entities —
 * a card renderer is entitled to treat `<br>` as markup, and a subject of
 * `**urgent**` should not arrive bold.
 */
export function escapeTeamsText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\*_~`[\]#+\-.!|])/g, "\\$1");
}

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A Slack incoming-webhook body: a `text` fallback plus Block Kit blocks.
 *
 * `text` is not decoration — it is what a notification banner, a screen reader and
 * an old client show, and Slack requires it beside `blocks` for exactly that reason.
 */
export function renderSlack(message: ChatMessage): string {
  const header = escapeSlackText(message.title);
  const body = escapeSlackText(message.text);
  const fields = message.fields.map((field) => `*${escapeSlackText(field.label)}:* ${escapeSlackText(field.value)}`).join("   ");
  const link = message.url ? `\n<${message.url}|Open in OnTrak Tix>` : "";

  return JSON.stringify({
    // The fallback is escaped like the blocks are: it is `mrkdwn` too, so an
    // unescaped one would page the room from a notification banner.
    text: escapeSlackText(`${message.title} — ${message.text}`),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${header}*\n${body}` } },
      ...(fields ? [{ type: "context", elements: [{ type: "mrkdwn", text: fields }] }] : []),
      ...(link ? [{ type: "section", text: { type: "mrkdwn", text: link.trim() } }] : []),
    ],
  });
}

/**
 * A Teams body: the legacy `MessageCard`, which is what a bare incoming webhook
 * accepts without an app registration or a workflow.
 */
export function renderTeams(message: ChatMessage): string {
  const card: Record<string, unknown> = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    // `summary` is plain text — a notification banner reads it verbatim — while the
    // title and body are markdown, so those two are escaped and this one is not.
    summary: message.title,
    themeColor: themeColorFor(message),
    title: escapeTeamsText(message.title),
    text: escapeTeamsText(message.text),
  };
  if (message.fields.length > 0) {
    card.sections = [
      {
        facts: message.fields.map((field) => ({ name: field.label, value: escapeTeamsText(field.value) })),
      },
    ];
  }
  if (message.url) {
    card.potentialAction = [{ "@type": "OpenUri", name: "Open in OnTrak Tix", targets: [{ os: "default", uri: message.url }] }];
  }
  return JSON.stringify(card);
}

/** The one field a card cannot carry as text: the colour of the bar down its side. */
function themeColorFor(message: ChatMessage): string {
  if (message.event === "ticket.created") return "F97316";
  if (message.event === "test") return "14B8A6";
  return "64748B";
}

/** The body one delivery posts, whichever provider it is going to. */
export function renderPayload(provider: ChatProvider, message: ChatMessage): string {
  return provider === "SLACK" ? renderSlack(message) : renderTeams(message);
}

/* -------------------------------------------------------------------------- */
/*  Delivery                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A delivery to a chat channel.
 *
 * The same shape as `WebhookDeliveryRecord` minus the signature and plus the
 * channel, because the state machine — attempt count, next attempt, terminal
 * `EXHAUSTED` — is shared (`applyDeliveryAttempt`), and this record is the reason
 * that function takes a structural type rather than the webhook's own.
 */
export interface ChatDeliveryRecord {
  id: string;
  tenantId: string;
  channelId: string;
  event: ChatDeliveryEvent;
  /** The exact bytes posted, kept so "what did the room actually see?" has an answer. */
  payload: string;
  status: DeliveryStatus;
  attemptCount: number;
  firstAttemptAt: number | null;
  lastAttemptAt: number | null;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: number | null;
  deliveredAt: number | null;
  createdAt: number;
}

/** Every attempt before we stop. The same five as a webhook, for the same reason. */
export const CHAT_MAX_ATTEMPTS = DELIVERY_MAX_ATTEMPTS;
