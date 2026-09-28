# Email intake

How a message becomes a ticket, and how to connect a mail source to it.

```
 provider / mailbox ──▶ transport ──▶ EmailWorker ──▶ planIngestion ──▶ TicketService
   (webhook / IMAP)      (bytes)     (resolves the      (accept /        (create or append
                                      sender, dedupes)   reject /         + audit event)
                                                         thread)
```

Every channel converges on the same path, so intake rules, access rules, the
hash-chained audit trail and the dedupe ledger apply identically whether a
message arrived by webhook or by mailbox poll. Nothing decides anything outside
`planIngestion` and the ticket service.

| Piece | File |
| --- | --- |
| Parse / classify / thread / dedupe (pure) | `src/lib/intake-rules.ts` |
| The worker's decision (pure, flag-gated) | `src/lib/intake-service.ts` |
| The worker itself (resolves sender, persists, ledgers) | `src/lib/email-worker.ts` |
| Transport: webhook, poller, IMAP adapter | `src/lib/email-transport.ts` |
| Webhook auth + status mapping (pure) | `src/lib/intake-webhook.ts` |
| The HTTP entry point | `src/app/api/intake/email/route.ts` |

## Configuration

```bash
ONTRAK_TIX_EMAIL_INGESTION="true"        # the pipeline is off until this is true
ONTRAK_TIX_WEBHOOK_SECRET="<long-random>"  # signs webhook deliveries
```

A hidden flag is deliberate: an unconfigured desk must not start turning a busy
mailbox into tickets. When the flag is off the transport returns `disabled`
before anything is read or written.

## Option A — provider webhook

Point your mail provider's inbound route at:

```
POST /api/intake/email?tenant=<slug>
Authorization: Bearer <ONTRAK_TIX_WEBHOOK_SECRET>
Content-Type: application/json
```

The tenant can also be sent as `x-ontrak-tenant: <slug>`. The body accepts the
common provider field aliases — `from`/`sender`, `to`/`recipients`,
`body`/`text`/`plain`/`stripped-text`, `messageId`/`message-id`,
`inReplyTo`/`in-reply-to`, `references`, `autoSubmitted`/`auto-submitted`, and
`precedence` — so most providers work without a translation shim.

Try it locally against the seeded `acme` tenant:

```bash
curl -i -X POST "http://localhost:3000/api/intake/email?tenant=acme" \
  -H "Authorization: Bearer $ONTRAK_TIX_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
        "from": "Ada Lovelace <ada@client.example>",
        "to": ["support@ontrak.local"],
        "subject": "Cannot log in to the VPN",
        "text": "The client says the certificate is invalid since this morning.",
        "message-id": "<abc-123@client.example>"
      }'
```

### Response codes

| Status | Meaning | Provider should |
| --- | --- | --- |
| `202` | Ticket created or appended — body carries `ticketId` and, for a new ticket, `ref` | stop |
| `200` | Idempotent redelivery (`duplicate`) or a recorded decision (`rejected`) | stop |
| `400` | The body was not a parseable message, or no tenant was given | fix the payload |
| `401` | Missing or wrong shared secret | fix the credentials |
| `404` | Unknown tenant slug | fix the tenant |
| `500` | The ticket could not be written | **retry** — see below |
| `503` | Ingestion is disabled | stop; enable the flag first |

A `500` is the only retryable outcome: the ticket was never recorded, so leaving
the message for another delivery is safe. The `InboundMessage` ledger — keyed on
`(tenantId, dedupeKey)` — makes the retry a no-op once it does succeed, and
dedupes on the mail's `Message-ID` (or a content fingerprint when there is
none). Redeliveries of a message that already produced a ticket therefore answer
`200 duplicate` rather than opening a second one.

## Option B — IMAP poll

Poll a mailbox on a timer. Any IMAP library works; implement the three-method
`ImapClient` port and hand it to `ImapMailboxSource`, then let `MailboxPoller`
drain it:

```ts
import { ImapFlow } from "imapflow"; // or any client you prefer
import { EmailWorker, PrismaIntakeStore } from "./src/lib/email-worker";
import { ImapMailboxSource, MailboxPoller, type ImapClient } from "./src/lib/email-transport";
import { prisma } from "./src/lib/db";
import { ticketServices } from "./src/lib/ticket-server";

// Adapt your client to the three operations the transport needs.
function clientFor(flow: ImapFlow): ImapClient {
  return {
    async searchUnseen() {
      return (await flow.search({ seen: false }, { uid: true })) as number[];
    },
    async fetch(uid) {
      const message = await flow.fetchOne(String(uid), { uid: true, source: true, envelope: true });
      return {
        uid,
        headers: Object.fromEntries(
          (message.headers?.toString() ?? "")
            .split(/\r?\n(?=[A-Za-z-]+:)/)
            .map((line) => {
              const [name, ...rest] = line.split(":");
              return [name.trim(), rest.join(":").trim()];
            }),
        ),
        text: message.source?.toString("utf8") ?? "",
      };
    },
    async markSeen(uid) {
      await flow.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
    },
  };
}

const flow = new ImapFlow({ host, port: 993, secure: true, auth: { user, pass } });
await flow.connect();

const poller = new MailboxPoller(
  new EmailWorker(ticketServices().service, new PrismaIntakeStore(prisma)),
  tenant.id,
  new ImapMailboxSource(clientFor(flow)),
);

// Poll on your scheduler of choice.
setInterval(() => void poller.poll(50), 30_000);
```

`imapflow` (or the client you choose) is a deployment dependency, not one this
repo ships: the transport only needs the `ImapClient` port, which keeps the
worker testable against `MemoryMailboxSource` and swappable between vendors.

### Acknowledging

`MailboxPoller` sets `\Seen` **after** the worker has handled a message, and
leaves a `failed` message unseen so the next poll retries it. Acknowledgement is
a throughput optimisation, not the correctness boundary — the ledger is what
makes a retry safe.

## What gets recorded

- **A new ticket** when a message from a human starts a thread. The sender is
  resolved to a requester, creating the account if the desk has never seen them.
- **An append** when the message answers a thread the ledger already links, via
  `In-Reply-To` or the first `References` entry.
- **A rejection** for machine-generated mail (auto-replies, bounces, bulk/list
  precedence) — recorded so a retry is quiet rather than a second refusal.
- **An audit event** for every ticket mutation, on the same per-tenant
  hash-chained log as agent actions.

## Testing

```bash
npx tsx --tsconfig tests/tsconfig.json --test ontrak-tix/tests/tix-ingestion.test.ts
```

covers the rules, the worker and both transports against in-memory fakes. The
`postgres:` test in `tix-db.test.ts` exercises the real Prisma store and audit
sink when a database is reachable (and skips cleanly when it is not).
