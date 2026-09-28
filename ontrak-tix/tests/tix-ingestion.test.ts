/**
 * OnTrak Tix sign-in and email-ingestion tests.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test ontrak-tix/tests/tix-ingestion.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog } from "../src/lib/audit-chain";
import { TicketService, MemoryTicketStore } from "../src/lib/ticket-service";
import { INGESTION_FLAG } from "../src/lib/intake-service";
import type { InboundEmail } from "../src/lib/intake-rules";
import { EmailWorker, MemoryIntakeStore, displayNameFromEmail } from "../src/lib/email-worker";
import {
  ImapMailboxSource,
  MemoryMailboxSource,
  MailboxPoller,
  WebhookTransport,
  imapMessageToMailboxMessage,
  parseWebhookEmail,
  type ImapClient,
  type ImapMessage,
} from "../src/lib/email-transport";
import { extractSecret, secretsMatch, tenantSlug, webhookReply } from "../src/lib/intake-webhook";
import { hashPassword, passwordIssue, verifyPassword } from "../src/lib/password";
import {
  claimsForUser,
  findActiveUserByEmail,
  normalizeEmail,
  type AuthPrismaClient,
  type AuthUserRow,
} from "../src/lib/auth-store";

const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

/* -------------------------------------------------------------------------- */
/*  Passwords                                                                 */
/* -------------------------------------------------------------------------- */

test("password: a hash verifies and a salt makes each hash unique", () => {
  const hash = hashPassword("ChangeMe123");
  assert.match(hash, /^scrypt:[0-9a-f]+:[0-9a-f]+$/);
  assert.equal(verifyPassword("ChangeMe123", hash), true);
  assert.equal(verifyPassword("changeMe123", hash), false);
  assert.notEqual(hash, hashPassword("ChangeMe123"), "each hash carries its own salt");
});

test("password: malformed or missing hashes fail closed", () => {
  assert.equal(verifyPassword("x", null), false);
  assert.equal(verifyPassword("x", undefined), false);
  assert.equal(verifyPassword("x", ""), false);
  assert.equal(verifyPassword("x", "plaintext"), false);
  assert.equal(verifyPassword("x", "scrypt:salt"), false);
  assert.equal(passwordIssue("short"), "A password must be at least 8 characters.");
  assert.equal(passwordIssue("longenough"), null);
});

/* -------------------------------------------------------------------------- */
/*  Auth store                                                                */
/* -------------------------------------------------------------------------- */

function authDb(rows: AuthUserRow[]): AuthPrismaClient {
  return { user: { findMany: async () => rows } };
}

const row = (overrides: Partial<AuthUserRow> = {}): AuthUserRow => ({
  id: "u1",
  tenantId: "t_acme",
  email: "agent@acme.test",
  displayName: "Sam Agent",
  role: "AGENT",
  active: true,
  passwordHash: hashPassword("ChangeMe123"),
  ...overrides,
});

test("auth: an email is normalized and mapped to claims", async () => {
  assert.equal(normalizeEmail("  Agent@Acme.Test "), "agent@acme.test");
  const user = row();
  const found = await findActiveUserByEmail(authDb([user]), "Agent@Acme.Test");
  assert.equal(found?.id, "u1");
  assert.deepEqual(claimsForUser(user), {
    userId: "u1",
    tenantId: "t_acme",
    role: "AGENT",
    email: "agent@acme.test",
    name: "Sam Agent",
  });
});

test("auth: an ambiguous or inactive identity is refused", async () => {
  assert.equal(await findActiveUserByEmail(authDb([]), "nobody@acme.test"), null);
  assert.equal(await findActiveUserByEmail(authDb([row({ active: false })]), "agent@acme.test"), null);
  // The same email in two tenants is ambiguous, so the local fallback refuses it.
  const twin = row({ id: "u2", tenantId: "t_other" });
  assert.equal(await findActiveUserByEmail(authDb([row(), twin]), "agent@acme.test"), null);
  assert.equal(await findActiveUserByEmail(authDb([row({ role: "WIZARD" as never })]), "agent@acme.test"), null);
  assert.equal(await findActiveUserByEmail(authDb([row()]), "   "), null);
});

/* -------------------------------------------------------------------------- */
/*  The email worker                                                          */
/* -------------------------------------------------------------------------- */

const ON = { [INGESTION_FLAG]: "true" };

function worker(env: Record<string, string | undefined> = ON) {
  const store = new MemoryTicketStore();
  const audit = new AuditLog(sha256);
  const service = new TicketService(store, audit);
  const intake = new MemoryIntakeStore();
  return { store, audit, service, intake, worker: new EmailWorker(service, intake, env) };
}

function mail(overrides: Partial<InboundEmail> = {}): InboundEmail {
  return {
    from: "Ada Lovelace <ada@client.example>",
    to: ["support@ontrak.local"],
    subject: "Cannot log in to the VPN",
    body: "Since this morning the VPN client says the certificate is invalid.",
    messageId: "<abc-123@client.example>",
    ...overrides,
  };
}

test("worker: the feature flag disables the whole pipeline", async () => {
  const w = worker({});
  assert.deepEqual(await w.worker.handle("t_acme", mail()), { kind: "disabled" });
  assert.equal(w.audit.length, 0);
});

test("worker: a new mail becomes an audited ticket for a fresh requester", async () => {
  const w = worker();
  const outcome = await w.worker.handle("t_acme", mail());
  assert.equal(outcome.kind, "created");
  if (outcome.kind !== "created") return;
  assert.equal(outcome.ref, "TIX-000001");

  const ticket = await w.store.findTicket("t_acme", outcome.ticketId);
  assert.equal(ticket?.subject, "Cannot log in to the VPN");
  assert.equal(ticket?.status, "NEW");
  // The sender was resolved to a brand-new requester account.
  assert.equal(await w.intake.requesterFor("t_acme", "ada@client.example"), ticket?.requesterId);
  // The creation is on the hash chain like any other ticket.
  assert.deepEqual(w.audit.verify(), { ok: true, length: 1 });
});

test("worker: retrying the same message is a duplicate, not a second ticket", async () => {
  const w = worker();
  await w.worker.handle("t_acme", mail());
  const retry = await w.worker.handle("t_acme", mail());
  assert.deepEqual(retry, { kind: "duplicate", dedupeKey: "mid:abc-123@client.example" });
  assert.equal((await w.store.listTickets("t_acme")).length, 1);
});

test("worker: a reply to a known thread appends instead of opening a ticket", async () => {
  const w = worker();
  const created = await w.worker.handle("t_acme", mail());
  assert.equal(created.kind, "created");

  const reply = await w.worker.handle(
    "t_acme",
    mail({ messageId: "<reply-1@client.example>", inReplyTo: "<abc-123@client.example>", body: "Still broken." }),
  );
  assert.equal(reply.kind, "appended");
  if (reply.kind !== "appended" || created.kind !== "created") return;
  assert.equal(reply.ticketId, created.ticketId);

  const ticket = await w.store.findTicket("t_acme", created.ticketId);
  assert.deepEqual(ticket?.messages.map((message) => message.body), ["Still broken."]);
  assert.equal((await w.store.listTickets("t_acme")).length, 1);
});

test("worker: a reply to an unknown thread still opens a ticket", async () => {
  const w = worker();
  const outcome = await w.worker.handle("t_acme", mail({ messageId: "<x@client.example>", inReplyTo: "<stranger@x>" }));
  assert.equal(outcome.kind, "created");
  assert.equal((await w.store.listTickets("t_acme")).length, 1);
});

test("worker: machine-generated mail is rejected and not retried loudly", async () => {
  const w = worker();
  const rejected = await w.worker.handle("t_acme", mail({ autoSubmitted: "auto-replied" }));
  assert.equal(rejected.kind, "rejected");
  // The second attempt is a duplicate, so a retry never re-processes it.
  assert.equal((await w.worker.handle("t_acme", mail({ autoSubmitted: "auto-replied" }))).kind, "duplicate");
  assert.equal(w.audit.length, 0);
});

test("worker: a missing Message-ID dedupes on the content fingerprint", async () => {
  const w = worker();
  const email = mail({ messageId: undefined });
  assert.equal((await w.worker.handle("t_acme", email)).kind, "created");
  assert.equal((await w.worker.handle("t_acme", { ...email, body: `  ${email.body}  ` })).kind, "duplicate");
});

test("worker: display names are derived from the local part", () => {
  assert.equal(displayNameFromEmail("ada.lovelace@client.example"), "Ada Lovelace");
  assert.equal(displayNameFromEmail("support+it@client.example"), "Support+it");
  assert.equal(displayNameFromEmail("@"), "Requester");
});

/* -------------------------------------------------------------------------- */
/*  Inbound mail transport                                                    */
/* -------------------------------------------------------------------------- */

test("transport: a webhook payload maps provider aliases onto the worker shape", () => {
  const email = parseWebhookEmail({
    sender: "Ada Lovelace <ada@client.example>",
    recipients: "support@ontrak.local, ops@ontrak.local",
    Subject: "Re: Cannot log in to the VPN",
    "stripped-text": "Still broken after the fix.",
    "message-id": "<reply-9@client.example>",
    "in-reply-to": "<abc-123@client.example>",
    References: "<abc-123@client.example>",
  });
  assert.ok(email);
  assert.equal(email?.from, "Ada Lovelace <ada@client.example>");
  assert.deepEqual(email?.to, ["support@ontrak.local", "ops@ontrak.local"]);
  assert.equal(email?.subject, "Re: Cannot log in to the VPN");
  assert.equal(email?.body, "Still broken after the fix.");
  assert.equal(email?.messageId, "<reply-9@client.example>");
  assert.equal(email?.inReplyTo, "<abc-123@client.example>");
  assert.deepEqual(email?.references, ["<abc-123@client.example>"]);
});

test("transport: a payload without a sender or body is not a message", () => {
  assert.equal(parseWebhookEmail(null), null);
  assert.equal(parseWebhookEmail("text"), null);
  assert.equal(parseWebhookEmail({ subject: "No sender" }), null);
  assert.equal(parseWebhookEmail({ from: "ada@client.example" }), null);
});

test("transport: the webhook transport opens a ticket through the worker", async () => {
  const w = worker();
  const transport = new WebhookTransport(w.worker, "t_acme");
  const outcome = await transport.receive({ from: "ada@client.example", subject: "New laptop", text: "Please order one." });
  assert.equal(outcome?.kind, "created");
  assert.equal((await w.store.listTickets("t_acme")).length, 1);
  // An unparseable delivery has no side effects at all.
  assert.equal(await transport.receive({ nope: true }), null);
  assert.equal((await w.store.listTickets("t_acme")).length, 1);
});

test("transport: the webhook transport honours the ingestion flag", async () => {
  const w = worker({});
  const transport = new WebhookTransport(w.worker, "t_acme");
  const outcome = await transport.receive({ from: "ada@client.example", subject: "x", text: "y" });
  assert.deepEqual(outcome, { kind: "disabled" });
});

test("transport: the poller drains a mailbox, acknowledging what it handled", async () => {
  const w = worker();
  const mailbox = new MemoryMailboxSource();
  mailbox.add(mail());
  mailbox.add(mail({ messageId: "<second@client.example>", subject: "Printer jammed", body: "Second floor printer." }));

  const poller = new MailboxPoller(w.worker, "t_acme", mailbox);
  const first = await poller.poll();
  assert.deepEqual(first.outcomes.map((entry) => entry.outcome.kind), ["created", "created"]);
  assert.equal(first.deferred, 0);
  assert.equal(mailbox.size, 0, "handled messages are acknowledged");

  // Re-queueing the same mail is a duplicate, never a second ticket.
  mailbox.add(mail());
  const retry = await poller.poll();
  assert.deepEqual(retry.outcomes.map((entry) => entry.outcome.kind), ["duplicate"]);
  assert.equal((await w.store.listTickets("t_acme")).length, 2);
});

test("transport: a failed message is left unseen for the next poll", async () => {
  const service = {
    createTicket: async () => ({ ok: false as const, error: "store unavailable" }),
    reply: async () => ({ ok: false as const, error: "store unavailable" }),
  } as unknown as TicketService;
  const mailbox = new MemoryMailboxSource();
  mailbox.add(mail());
  const poller = new MailboxPoller(new EmailWorker(service, new MemoryIntakeStore(), ON), "t_acme", mailbox);

  const result = await poller.poll();
  assert.equal(result.outcomes[0].outcome.kind, "failed");
  assert.equal(result.deferred, 1);
  assert.equal(mailbox.size, 1, "a failure stays queued so a retry can pick it up");
});

const imap = (uid: number, headers: Record<string, string>, text = "body"): ImapMessage => ({ uid, headers, text });

function imapClient(messages: ImapMessage[]): ImapClient & { seen: number[] } {
  const seen: number[] = [];
  return {
    seen,
    searchUnseen: async () => messages.filter((message) => !seen.includes(message.uid)).map((message) => message.uid),
    fetch: async (uid) => {
      const found = messages.find((message) => message.uid === uid);
      if (!found) throw new Error(`no message ${uid}`);
      return found;
    },
    markSeen: async (uid) => {
      seen.push(uid);
    },
  };
}

test("transport: IMAP headers are mapped case-insensitively", () => {
  const mapped = imapMessageToMailboxMessage(
    imap(7, {
      from: "Ada <ada@client.example>",
      to: "support@ontrak.local, ops@ontrak.local",
      subject: "Re: VPN",
      "message-id": "<r@client.example>",
      "in-reply-to": "<root@client.example>",
      references: "<root@client.example> <mid@client.example>",
      "auto-submitted": "auto-replied",
      precedence: "bulk",
    }),
  );
  assert.equal(mapped.id, "7");
  assert.equal(mapped.from, "Ada <ada@client.example>");
  assert.deepEqual(mapped.to, ["support@ontrak.local", "ops@ontrak.local"]);
  assert.equal(mapped.subject, "Re: VPN");
  assert.equal(mapped.messageId, "<r@client.example>");
  assert.equal(mapped.inReplyTo, "<root@client.example>");
  assert.deepEqual(mapped.references, ["<root@client.example>", "<mid@client.example>"]);
  assert.equal(mapped.autoSubmitted, "auto-replied");
  assert.equal(mapped.precedence, "bulk");
});

test("transport: the IMAP source fetches unseen mail and marks it seen on ack", async () => {
  const client = imapClient([
    imap(1, { From: "Ada <ada@client.example>", To: "support@ontrak.local", Subject: "VPN" }),
    imap(2, { From: "Bob <bob@client.example>", To: "support@ontrak.local", Subject: "Printer" }),
  ]);
  const source = new ImapMailboxSource(client);

  const picked = await source.fetchUnseen(1);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].id, "1");
  await source.acknowledge("1");
  assert.deepEqual(client.seen, [1]);
  assert.deepEqual((await source.fetchUnseen()).map((entry) => entry.id), ["2"]);
});

test("transport: the webhook secret is read from either header, and compared safely", () => {
  assert.equal(extractSecret(new Headers({ authorization: "Bearer s3cret" })), "s3cret");
  assert.equal(extractSecret(new Headers({ "x-ontrak-secret": "s3cret" })), "s3cret");
  assert.equal(extractSecret(new Headers()), null);
  // A basic-auth header is not a bearer token, and fails closed.
  assert.equal(extractSecret(new Headers({ authorization: "Basic abc" })), null);

  assert.equal(secretsMatch("s3cret", "s3cret"), true);
  assert.equal(secretsMatch("s3cret", "other"), false);
  // A missing configuration never matches, however the delivery is signed.
  assert.equal(secretsMatch("anything", null), false);
  assert.equal(secretsMatch(null, "s3cret"), false);
  assert.equal(secretsMatch("", ""), false);
});

test("transport: the tenant comes from the query first, then the header", () => {
  assert.equal(tenantSlug("acme", "other"), "acme");
  assert.equal(tenantSlug(null, "acme"), "acme");
  assert.equal(tenantSlug("  ", "  "), null);
  assert.equal(tenantSlug(null, null), null);
});

test("transport: outcomes map to HTTP replies a provider can act on", () => {
  assert.equal(webhookReply(null).status, 400);
  assert.equal(webhookReply({ kind: "disabled" }).status, 503);
  assert.equal(webhookReply({ kind: "failed", error: "boom" }).status, 500);
  assert.equal(webhookReply({ kind: "duplicate", dedupeKey: "mid:x" }).status, 200);
  assert.equal(webhookReply({ kind: "rejected", reason: "bounce" }).status, 200);

  const created = webhookReply({ kind: "created", ticketId: "t1", ref: "TIX-000001" });
  assert.equal(created.status, 202);
  assert.deepEqual(created.body, { status: "created", ticketId: "t1", ref: "TIX-000001" });
  assert.equal(webhookReply({ kind: "appended", ticketId: "t1" }).status, 202);
});

test("transport: an IMAP mailbox feeds the worker end to end", async () => {
  const w = worker();
  const client = imapClient([
    imap(11, {
      From: "Ada Lovelace <ada@client.example>",
      To: "support@ontrak.local",
      Subject: "Cannot log in to the VPN",
      "Message-ID": "<imap-1@client.example>",
    }, "The VPN client reports an invalid certificate."),
  ]);
  const poller = new MailboxPoller(w.worker, "t_acme", new ImapMailboxSource(client));

  const result = await poller.poll();
  assert.equal(result.outcomes[0].outcome.kind, "created");
  assert.deepEqual(client.seen, [11]);
  assert.equal((await w.store.listTickets("t_acme"))[0].subject, "Cannot log in to the VPN");
});
