/**
 * OnTrak Tix M6 tests: Slack and Teams notifications.
 *
 * A chat connector is a webhook with a narrower destination and a louder audience,
 * so each test follows one of the ways it goes wrong:
 *
 *  1. a URL that is not the provider's, which turns "tell the on-call room" into a
 *     way to POST a customer's ticket subject at an arbitrary address;
 *  2. a ticket's text reaching the room as *markup* — `<!channel>` is a control
 *     token in Slack, and a requester writes the subject;
 *  3. a failure that is retried forever or dropped silently, instead of retrying on
 *     a schedule a person can read and then stopping;
 *  4. a delivery that happened but left nothing to reconcile against;
 *  5. and one tenant's rooms answering for another's.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m6-chat-notify.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Actor } from "../src/lib/access-rules";
import { AuditLog } from "../src/lib/audit-chain";
import {
  CHAT_EVENTS,
  CHAT_MAX_ATTEMPTS,
  channelsFor,
  chatEventLabel,
  chatProviderLabel,
  escapeSlackText,
  escapeTeamsText,
  isRegistrableChatUrl,
  renderPayload,
  renderSlack,
  renderTeams,
  testChatMessage,
  ticketChatMessage,
  validateChatChannel,
  type ChatChannelRecord,
  type ChatMessage,
} from "../src/lib/chat-notify-rules";
import {
  ChatNotifyService,
  MemoryChatStore,
  type ChatNotifyIds,
  type ChatTransport,
} from "../src/lib/chat-notify-service";
import { sha256Hex } from "../src/lib/ticket-store-prisma";
import { DELIVERY_MAX_ATTEMPTS, deliveryDue, retryDelaySeconds } from "../src/lib/webhook-rules";
import type { TransportOutcome } from "../src/lib/webhook-service";

const ADMIN: Actor = { id: "admin-1", tenantId: "tenant-a", role: "ADMIN" };
const AGENT: Actor = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" };
const SLACK_URL = "https://hooks.slack.com/services/T000/B000/XXXX";
const TEAMS_URL = "https://acme.webhook.office.com/webhookb2/abc@def/IncomingWebhook/xyz";

/* -------------------------------------------------------------------------- */
/*  A harness                                                                 */
/* -------------------------------------------------------------------------- */

class FakeTransport implements ChatTransport {
  readonly requests: { url: string; headers: Record<string, string>; body: string; timeoutMs: number }[] = [];

  constructor(private readonly reply: (attempt: number) => TransportOutcome = () => ({ statusCode: 200, error: null })) {}

  async send(request: { url: string; headers: Record<string, string>; body: string; timeoutMs: number }): Promise<TransportOutcome> {
    this.requests.push(request);
    return this.reply(this.requests.length);
  }
}

const CLOCK_START = Date.parse("2026-10-20T10:00:00.000Z");

function harness(reply?: (attempt: number) => TransportOutcome, baseUrl: string | null = "https://tix.example.test") {
  let clock = CLOCK_START;
  let n = 0;
  const transport = new FakeTransport(reply);
  const ids: ChatNotifyIds = {
    id: () => `id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };
  const store = new MemoryChatStore();
  const audit = new AuditLog(sha256Hex);
  const service = new ChatNotifyService(store, transport, audit, ids, baseUrl);

  return {
    service,
    store,
    transport,
    audit,
    /** The tenant's evidence chain, as the server keeps it. */
    trail: () => audit.snapshot().events,
    advance(ms: number) {
      clock += ms;
    },
    at: () => clock,
  };
}

/* -------------------------------------------------------------------------- */
/*  Who we will post to                                                       */
/* -------------------------------------------------------------------------- */

test("chat: only the hosts a provider owns are registrable", () => {
  assert.equal(isRegistrableChatUrl("SLACK", SLACK_URL), true);
  assert.equal(isRegistrableChatUrl("SLACK", "https://hooks.slack-gov.com/services/T/B/X"), true);

  // The interesting refusals: a host that merely *contains* the provider's name, a
  // plain-`http` destination, a fragment that would never be sent, and credentials
  // that would be forwarded to somebody else's log.
  assert.equal(isRegistrableChatUrl("SLACK", "https://hooks.slack.com.evil.test/services/T/B/X"), false);
  assert.equal(isRegistrableChatUrl("SLACK", "http://hooks.slack.com/services/T/B/X"), false);
  assert.equal(isRegistrableChatUrl("SLACK", `${SLACK_URL}#fragment`), false);
  assert.equal(isRegistrableChatUrl("SLACK", "https://user:pass@hooks.slack.com/services/T/B/X"), false);
  assert.equal(isRegistrableChatUrl("SLACK", "not a url"), false);

  assert.equal(isRegistrableChatUrl("TEAMS", TEAMS_URL), true);
  assert.equal(isRegistrableChatUrl("TEAMS", "https://outlook.office.com/webhook/abc"), true);
  assert.equal(isRegistrableChatUrl("TEAMS", "https://prod-12.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke"), true);
  // A Slack URL is not a Teams URL, however https it is.
  assert.equal(isRegistrableChatUrl("TEAMS", SLACK_URL), false);
  assert.equal(isRegistrableChatUrl("SLACK", TEAMS_URL), false);
});

test("chat: a channel is validated before it is registered", () => {
  assert.deepEqual(validateChatChannel({ provider: "SLACK", name: "On-call", url: SLACK_URL, events: ["ticket.created"] }), []);

  assert.equal(validateChatChannel({ provider: "TELEGRAM", name: "x", url: SLACK_URL, events: ["ticket.created"] })[0].field, "provider");

  const issues = validateChatChannel({ provider: "SLACK", name: "", url: "http://example.test", events: [] });
  assert.deepEqual(
    issues.map((issue) => issue.field),
    ["name", "url", "events"],
  );
  // The message names the provider's own host, so a wrong paste is fixable from the
  // sentence rather than from the documentation.
  assert.match(validateChatChannel({ provider: "SLACK", name: "x", url: "https://example.test", events: ["ticket.created"] })[0].message, /hooks\.slack\.com/);
  assert.equal(validateChatChannel({ provider: "SLACK", name: "x", url: SLACK_URL, events: ["ticket.created", "ticket.created"] }).length, 1);
  assert.equal(validateChatChannel({ provider: "SLACK", name: "x", url: SLACK_URL, events: ["ticket.exploded"] })[0].field, "events");
  assert.equal(CHAT_EVENTS.length, 3);
});

test("chat: an event reaches only the channels that asked for it, and only while they are on", () => {
  const channel = (overrides: Partial<ChatChannelRecord>): ChatChannelRecord => ({
    id: "c1",
    tenantId: "tenant-a",
    provider: "SLACK",
    name: "On-call",
    url: SLACK_URL,
    events: ["ticket.created"],
    enabled: true,
    createdBy: ADMIN.id,
    createdAt: "2026-10-20T10:00:00.000Z",
    disabledAt: null,
    ...overrides,
  });

  const asked = channel({});
  const off = channel({ id: "c2", enabled: false, disabledAt: "2026-10-20T11:00:00.000Z" });
  const otherEvent = channel({ id: "c3", events: ["ticket.replied"] });

  assert.deepEqual(channelsFor([asked, off, otherEvent], "ticket.created").map((entry) => entry.id), ["c1"]);
  assert.deepEqual(channelsFor([asked, off, otherEvent], "ticket.replied").map((entry) => entry.id), ["c3"]);
  assert.deepEqual(channelsFor([asked], "ticket.updated"), []);
});

/* -------------------------------------------------------------------------- */
/*  What the room sees                                                        */
/* -------------------------------------------------------------------------- */

test("chat: a ticket subject is data, so it cannot page the room or carry a link", () => {
  const message = ticketChatMessage({
    event: "ticket.created",
    ref: "TIX-42",
    subject: "<!channel> disk full <https://evil.test|our intranet>",
    status: "NEW",
    priority: "HIGH",
    url: "https://tix.example.test/tickets/TIX-42",
  });

  const slack = JSON.parse(renderSlack(message)) as { text: string; blocks: { text: { text: string } }[] };
  const body = slack.blocks[0].text.text;

  // `<!channel>` is a live control token in Slack and `<url|label>` is a link, so the
  // angle brackets are the whole defence.
  assert.doesNotMatch(body, /<!channel>/);
  assert.doesNotMatch(body, /<https:\/\/evil\.test\|/);
  assert.match(body, /&lt;!channel&gt;/);
  assert.match(body, /&lt;https:\/\/evil\.test\|our intranet&gt;/);
  // The plain-text fallback is escaped too: that is what a notification banner shows.
  assert.match(slack.text, /&lt;!channel&gt;/);

  const teams = JSON.parse(renderTeams(message)) as { title: string; text: string; summary: string };
  assert.doesNotMatch(teams.text, /<!channel>/);
  // Teams' text is markdown as well as HTML, so the exclamation is backslashed out
  // too — the angle brackets are the part that matters, and the rest is belt and
  // braces on a parser we do not run.
  assert.ok(teams.text.includes("&lt;\\!channel&gt;"), teams.text);
  // Teams' cards are markdown, so metacharacters are escaped as well.
  assert.equal(escapeTeamsText("**urgent**"), "\\*\\*urgent\\*\\*");
  assert.equal(escapeSlackText("&<>"), "&amp;&lt;&gt;");
});

test("chat: each provider gets the payload it understands", () => {
  const message: ChatMessage = {
    event: "ticket.created",
    title: "TIX-42 · Ticket created",
    text: "Laptop will not boot",
    url: "https://tix.example.test/tickets/TIX-42",
    fields: [
      { label: "Priority", value: "HIGH" },
      { label: "Status", value: "NEW" },
    ],
  };

  const slack = JSON.parse(renderSlack(message)) as {
    text: string;
    blocks: { type: string; text?: { text: string }; elements?: { text: string }[] }[];
  };
  assert.equal(slack.blocks[0].type, "section");
  assert.match(slack.blocks[0].text!.text, /TIX-42/);
  assert.match(slack.blocks[1].elements![0].text, /\*Priority:\* HIGH/);
  // The fallback is not decoration: Slack requires it beside `blocks`, and it is what
  // a notification banner and a screen reader show.
  assert.match(slack.text, /Laptop will not boot/);

  const teams = JSON.parse(renderTeams(message)) as {
    "@type": string;
    themeColor: string;
    title: string;
    sections: { facts: { name: string; value: string }[] }[];
    potentialAction: { name: string; targets: { uri: string }[] }[];
  };
  assert.equal(teams["@type"], "MessageCard");
  assert.equal(teams.themeColor, "F97316");
  assert.equal(teams.sections[0].facts[0].name, "Priority");
  assert.equal(teams.potentialAction[0].targets[0].uri, "https://tix.example.test/tickets/TIX-42");

  // No link known, no button: a button pointing at a host we invented is worse than
  // no button.
  const bare = JSON.parse(renderTeams({ ...message, url: null })) as Record<string, unknown>;
  assert.equal(bare.potentialAction, undefined);
  assert.equal(renderPayload("SLACK", { ...message, url: null }).includes("Open in OnTrak Tix"), false);
  assert.equal(renderPayload("TEAMS", { ...message, url: null }).includes("Open in OnTrak Tix"), false);
});

test("chat: the test message says what it is, so nobody raises a ticket about it", () => {
  const message = testChatMessage({ channelName: "On-call", url: "https://tix.example.test" });
  assert.equal(message.event, "test");
  assert.equal(chatEventLabel("test"), "Test message");
  assert.match(message.text, /Nothing is wrong/);
  assert.match(message.text, /On-call/);
  assert.equal(chatProviderLabel("SLACK"), "Slack");
  assert.equal(chatProviderLabel("TEAMS"), "Microsoft Teams");
});

/* -------------------------------------------------------------------------- */
/*  Registering                                                               */
/* -------------------------------------------------------------------------- */

test("chat: registering a room needs tenant:manage and a URL the provider owns", async () => {
  const h = harness();

  const denied = await h.service.register(AGENT, { provider: "SLACK", name: "On-call", url: SLACK_URL, events: ["ticket.created"] });
  assert.equal(denied.ok, false);
  assert.match(denied.ok ? "" : denied.error, /manage notification channels/);

  const refused = await h.service.register(ADMIN, { provider: "SLACK", name: "On-call", url: "https://example.test/hook", events: ["ticket.created"] });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /hooks\.slack\.com/);

  const created = await h.service.register(ADMIN, { provider: "SLACK", name: "On-call", url: SLACK_URL, events: ["ticket.created"] });
  assert.ok(created.ok, created.ok ? "" : created.error);
  assert.equal(created.value.provider, "SLACK");
  assert.equal(created.value.enabled, true);

  const duplicate = await h.service.register(ADMIN, { provider: "TEAMS", name: "on-call", url: TEAMS_URL, events: ["ticket.created"] });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.ok ? "" : duplicate.error, /already exists/);

  // The audit trail names the channel and its provider, never the URL: the URL is a
  // credential, and the trail is read by people who may not post.
  const created_ = h.trail().find((event) => event.action === "chat.channel.create")!;
  assert.equal(JSON.stringify(created_.detail).includes("hooks.slack.com"), false);
  assert.equal(JSON.stringify(created_.detail).includes("On-call"), true);
});

test("chat: switching a channel off keeps its history and stops its messages", async () => {
  const h = harness();
  const created = await h.service.register(ADMIN, { provider: "SLACK", name: "On-call", url: SLACK_URL, events: ["ticket.created"] });
  assert.ok(created.ok);

  const off = await h.service.setEnabled(ADMIN, created.value.id, false);
  assert.ok(off.ok, off.ok ? "" : off.error);
  assert.equal(off.value.enabled, false);
  assert.ok(off.value.disabledAt);

  const result = await h.service.notify(ADMIN.tenantId, "ticket.created", {
    ref: "TIX-1",
    subject: "Printer",
    status: "NEW",
    priority: "NORMAL",
  });
  assert.equal(result.channels, 0);
  assert.deepEqual(result.deliveries, []);
  assert.equal(h.transport.requests.length, 0);

  const removed = await h.service.remove(ADMIN, created.value.id);
  assert.ok(removed.ok, removed.ok ? "" : removed.error);
  const remaining = await h.service.list(ADMIN);
  assert.ok(remaining.ok, remaining.ok ? "" : remaining.error);
  assert.equal(remaining.value.length, 0);
  // The chain still shows the channel that used to be there.
  assert.ok(h.trail().some((event) => event.action === "chat.channel.remove"));
});

/* -------------------------------------------------------------------------- */
/*  Delivering                                                                */
/* -------------------------------------------------------------------------- */

test("chat: a created ticket is posted to the room, once per channel", async () => {
  const h = harness();
  await h.service.register(ADMIN, { provider: "SLACK", name: "On-call", url: SLACK_URL, events: ["ticket.created"] });
  await h.service.register(ADMIN, { provider: "TEAMS", name: "Desk", url: TEAMS_URL, events: ["ticket.created", "ticket.replied"] });

  const result = await h.service.notify(ADMIN.tenantId, "ticket.created", {
    ref: "TIX-42",
    subject: "Laptop will not boot",
    status: "NEW",
    priority: "HIGH",
  });

  assert.equal(result.channels, 2);
  assert.equal(result.deliveries.length, 2);
  assert.deepEqual(result.deliveries.map((entry) => entry.status), ["DELIVERED", "DELIVERED"]);
  assert.equal(h.transport.requests.length, 2);
  assert.equal(h.transport.requests[0].url, SLACK_URL);
  assert.equal(h.transport.requests[1].url, TEAMS_URL);
  assert.match(h.transport.requests[0].body, /TIX-42/);
  assert.match(h.transport.requests[0].body, /tix\.example\.test\/tickets\/TIX-42/);

  const log = await h.service.listDeliveries(ADMIN);
  assert.ok(log.ok, log.ok ? "" : log.error);
  assert.equal(log.value.length, 2);
  assert.deepEqual(log.value.map((entry) => entry.channelName).sort(), ["Desk", "On-call"]);
  assert.equal(h.trail().filter((event) => event.action === "chat.delivered").length, 2);
});

test("chat: a refusal is retried on the shared schedule and then stops", async () => {
  // Two failures, then success: the retry has to actually come back.
  const h = harness((attempt) => (attempt < 3 ? { statusCode: 500, error: null } : { statusCode: 200, error: null }));
  const created = await h.service.register(ADMIN, { provider: "SLACK", name: "On-call", url: SLACK_URL, events: ["ticket.created"] });
  assert.ok(created.ok);

  await h.service.notify(ADMIN.tenantId, "ticket.created", { ref: "TIX-1", subject: "s", status: "NEW", priority: "LOW" });
  const first = await h.store.listDeliveries(ADMIN.tenantId);
  assert.equal(first[0].status, "RETRYING");
  assert.equal(first[0].attemptCount, 1);
  assert.equal(first[0].nextAttemptAt, h.at() + retryDelaySeconds(1) * 1000);

  // Not yet due: the sweep does nothing rather than hammering.
  assert.equal(deliveryDue(first[0], h.at()), false);
  const early = await h.service.deliverDue(ADMIN.tenantId);
  assert.equal(early.considered, 0);

  h.advance(retryDelaySeconds(1) * 1000);
  const second = await h.service.deliverDue(ADMIN.tenantId);
  assert.equal(second.considered, 1);
  assert.equal(second.retrying, 1);

  h.advance(retryDelaySeconds(2) * 1000);
  const third = await h.service.deliverDue(ADMIN.tenantId);
  assert.equal(third.delivered, 1);

  const after = await h.store.listDeliveries(ADMIN.tenantId);
  assert.equal(after[0].status, "DELIVERED");
  assert.equal(after[0].attemptCount, 3);
  // Delivered rows are not in the worklist, so running the sweep again is free.
  assert.equal((await h.service.deliverDue(ADMIN.tenantId)).considered, 0);
});

test("chat: a channel that never answers is exhausted rather than retried forever", async () => {
  const h = harness(() => ({ statusCode: null, error: "fetch failed" }));
  await h.service.register(ADMIN, { provider: "SLACK", name: "On-call", url: SLACK_URL, events: ["ticket.created"] });

  await h.service.notify(ADMIN.tenantId, "ticket.created", { ref: "TIX-1", subject: "s", status: "NEW", priority: "LOW" });
  for (let attempt = 2; attempt <= DELIVERY_MAX_ATTEMPTS; attempt += 1) {
    const due = (await h.store.listDeliveries(ADMIN.tenantId))[0];
    h.advance(retryDelaySeconds(attempt - 1) * 1000);
    assert.equal(deliveryDue(due, h.at()), true);
    await h.service.deliverDue(ADMIN.tenantId);
  }

  const rows = await h.store.listDeliveries(ADMIN.tenantId);
  assert.equal(rows[0].status, "EXHAUSTED");
  assert.equal(rows[0].attemptCount, CHAT_MAX_ATTEMPTS);
  assert.equal(rows[0].nextAttemptAt, null);
  assert.equal(rows[0].lastError, "fetch failed");
  assert.equal(h.transport.requests.length, DELIVERY_MAX_ATTEMPTS);
  assert.equal((await h.service.deliverDue(ADMIN.tenantId)).considered, 0);
  assert.equal(h.trail().filter((event) => event.action === "chat.delivery_failed").length, DELIVERY_MAX_ATTEMPTS);
});

test("chat: a channel that was removed while a retry was pending is not retried", async () => {
  const h = harness(() => ({ statusCode: 500, error: null }));
  const created = await h.service.register(ADMIN, { provider: "SLACK", name: "On-call", url: SLACK_URL, events: ["ticket.created"] });
  assert.ok(created.ok);
  await h.service.notify(ADMIN.tenantId, "ticket.created", { ref: "TIX-1", subject: "s", status: "NEW", priority: "LOW" });

  const after = await h.service.remove(ADMIN, created.value.id);
  assert.ok(after.ok, after.ok ? "" : after.error);
  h.advance(retryDelaySeconds(1) * 1000);

  const swept = await h.service.deliverDue(ADMIN.tenantId);
  assert.equal(swept.considered, 1);
  assert.equal(swept.delivered, 0);
  assert.equal(swept.retrying, 0);
  assert.equal(swept.exhausted, 0);
  assert.equal(h.transport.requests.length, 1);
  // The row is kept, with the state it last had, so the log still answers "did we
  // ever get through?" about a channel that no longer exists.
  const rows = await h.store.listDeliveries(ADMIN.tenantId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "RETRYING");
});

test("chat: the console's test message is posted and its answer is kept", async () => {
  const h = harness((attempt) => (attempt === 1 ? { statusCode: 200, error: null } : { statusCode: 429, error: null }));
  const created = await h.service.register(ADMIN, { provider: "TEAMS", name: "Desk", url: TEAMS_URL, events: ["ticket.replied"] });
  assert.ok(created.ok);

  const sent = await h.service.sendTest(ADMIN, created.value.id);
  assert.ok(sent.ok, sent.ok ? "" : sent.error);
  assert.equal(sent.value.outcome.statusCode, 200);
  assert.equal(sent.value.delivery.status, "DELIVERED");
  assert.equal(sent.value.delivery.event, "test");
  assert.match(h.transport.requests[0].body, /Nothing is wrong/);
  // The test does not need a subscription: a channel that only wants replies can
  // still be proved to work.
  assert.ok(h.trail().some((event) => event.action === "chat.channel.test"));

  const refused = await h.service.sendTest(ADMIN, created.value.id);
  assert.ok(refused.ok, refused.ok ? "" : refused.error);
  assert.equal(refused.value.outcome.statusCode, 429);
  assert.equal(refused.value.delivery.status, "RETRYING");

  const missing = await h.service.sendTest(ADMIN, "nope");
  assert.equal(missing.ok, false);
});

test("chat: a tenant's channels are not reachable from another tenant", async () => {
  const h = harness();
  const created = await h.service.register(ADMIN, { provider: "SLACK", name: "On-call", url: SLACK_URL, events: ["ticket.created"] });
  assert.ok(created.ok);
  const other: Actor = { id: "admin-2", tenantId: "tenant-b", role: "ADMIN" };

  const found = await h.store.findChannel(other.tenantId, created.value.id);
  assert.equal(found, null);
  const listed = await h.service.list(other);
  assert.ok(listed.ok, listed.ok ? "" : listed.error);
  assert.equal(listed.value.length, 0);
  assert.equal((await h.service.sendTest(other, created.value.id)).ok, false);
  assert.equal((await h.service.setEnabled(other, created.value.id, false)).ok, false);

  // And nothing of the other tenant's is announced.
  const result = await h.service.notify(other.tenantId, "ticket.created", { ref: "T-1", subject: "s", status: "NEW", priority: "LOW" });
  assert.equal(result.channels, 0);
  assert.equal(h.transport.requests.length, 0);
});
