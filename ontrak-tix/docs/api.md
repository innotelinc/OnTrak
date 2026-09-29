# The public API and webhooks (M6)

Everything before M6 was reached by a person: a browser holding a session cookie,
a portal, a console. This is the first surface a *program* reaches, and it is
built as one — scoped bearer tokens instead of sessions, rate limits instead of
goodwill, and a delivery log instead of a shrug when a webhook does not arrive.

- [Versions and prefixes](#versions-and-prefixes)
- [Tokens](#tokens)
- [Scopes](#scopes)
- [Rate limits](#rate-limits)
- [Endpoints](#endpoints)
- [Webhooks](#webhooks)
- [The delivery log](#the-delivery-log)
- [The integrations console](#the-integrations-console)
- [The monitoring webhook](#the-monitoring-webhook)
- [What is deliberately missing](#what-is-deliberately-missing)

## Versions and prefixes

The version is in the path, not a header, because it is the thing a caller
bookmarks, pastes into a script and reads in a log line:

```
/api/v1/tickets
```

Every JSON body carries `api_version` beside its `data`, so a response captured
in a ticket can be told apart from one produced by a later version. Errors carry a
stable `error` code and a human `message`, because a client that has to
string-match prose is a client that breaks when the prose improves:

```json
{ "error": "insufficient_scope", "message": "This token does not hold the “tickets:write” scope." }
```

## Tokens

A token is minted by a signed-in administrator and **shown exactly once**:

```
POST /api/v1/tokens
{ "name": "Zabbix", "scopes": ["tickets:read"], "expires_in_days": 365, "rate_limit_per_minute": 120 }

201 { "data": { "id": "…", "prefix": "tx1_9fK2pQ", … }, "token": "tx1_…", "secret_shown_once": "…" }
```

The plaintext is generated, returned once, and never stored. What is kept is
`SHA-256(token)` and a short `tx1_…` prefix, so a support engineer who can read
the database still cannot impersonate the integration, and a person can still
tell two tokens apart when deciding which one to revoke. The prefix also makes a
leaked token findable by a secret scanner rather than merely a long string.

**An API token cannot mint another API token.** A credential that can re-issue
itself after being revoked removes the one remedy revocation exists to provide, so
minting and revoking are signed-in administrators' acts (`tenant:manage`), reached
with a session cookie rather than a bearer token:

```
GET    /api/v1/tokens          list this workspace's tokens
POST   /api/v1/tokens          mint one
DELETE /api/v1/tokens/:id      revoke one (idempotent)
```

## Scopes

Three, and deliberately no more:

| Scope | Reaches |
| --- | --- |
| `tickets:read` | `GET /api/v1/tickets`, `GET /api/v1/tickets/:id` |
| `tickets:write` | `POST /api/v1/tickets` |
| `webhooks:manage` | the `/api/v1/webhooks*` endpoints |

An unknown scope is refused **at creation** rather than carried around and
ignored, because a token that looks like it can do something it cannot is worse
than one that was never issued.

A token also carries a role, and it is the *least* one that could serve its
scopes — a token with ticket scopes acts as an agent, so it can never do
something an agent could not. The scope only narrows that further: two fences, and
the inner one is never opened by the outer.

## Rate limits

Every token has a fixed window of sixty seconds and a limit (default 60, maximum
6000 requests a minute). Windows are aligned to the epoch rather than to a token's
first request, so two processes agree on which window a request belonged to
without sharing anything but the clock.

Every authenticated answer carries the state, and only a refusal carries
`Retry-After` — on a success it would be a lie about what to do next:

```
RateLimit-Limit: 60
RateLimit-Remaining: 41
RateLimit-Reset: 1790000000     # epoch seconds
Retry-After: 23                # a 429, and only then
```

The window is spent by **authenticating**, not by being allowed. An integration
hammering an endpoint it has no scope for is still hammering us; a token that
could escape its budget by picking a forbidden path would make the limit
advisory.

## Endpoints

### `GET /api/v1/tickets`

Scope `tickets:read`. Newest first is not offered — the order is by id, so a
client walking with `cursor` sees every ticket once:

```
GET /api/v1/tickets?limit=25&cursor=clx…
{ "api_version": "v1", "data": [ { "id": "…", "ref": "T-118", "status": "OPEN", … } ], "next_cursor": "clx…" }
```

A cursor that names no ticket in the workspace is a `400 invalid_cursor` rather
than a silent restart at the beginning, because a client looping over the first
page forever is worse than an error.

### `GET /api/v1/tickets/:id`

Scope `tickets:read`. The list omits the description and the conversation; this
returns them, because an integration told about a ticket by webhook needs a way to
fetch the thing it was told about. A ticket in another workspace is **not found**,
not forbidden — the same answer as for an id that never existed.

### `POST /api/v1/tickets`

Scope `tickets:write`.

```json
{ "subject": "Printer offline", "description": "The MFP in Building 2 is unreachable.",
  "type": "INCIDENT", "priority": "HIGH", "queue_id": "clx…", "client_id": "clx…" }
```

`type` defaults to `INCIDENT` and `priority` to `NORMAL`. The write goes through
`TicketService`, not the store: the desk's automation rules fire, the ticket lands
on the tenant's hash chain with `api-token:<id>` as its actor, and it appears in
the inbox exactly as one raised by a person would. A refusal is the desk's own
validation talking ("a subject is required"), returned as `422 invalid_ticket`
rather than re-worded into something the API invented.

## Webhooks

```
GET  /api/v1/webhooks     list endpoints          scope: webhooks:manage
POST /api/v1/webhooks     register one            scope: webhooks:manage
POST /api/v1/webhooks/sweep   attempt what is due shared cron secret
```

An event is a closed set — `ticket.created`, `ticket.updated`, `ticket.replied` —
because "send me everything" is how an integration receives fields it does not
understand and a change we make becomes its outage.

A destination is a URL registered **once**, checked at registration: `https`, or
`http` only on a loopback address. An outbound request is therefore never sent to
an origin nobody agreed to, which is the difference between a webhook feature and
an SSRF tool.

### What a receiver gets

```http
POST /your/endpoint HTTP/1.1
Content-Type: application/json; charset=utf-8
X-OnTrak-Event: ticket.created
X-OnTrak-Timestamp: 1790000000
X-OnTrak-Delivery: clx…
X-OnTrak-Signature: v1=6f7a…
```

```json
{ "id": "…", "type": "ticket.created", "api_version": "v1",
  "tenant_id": "…", "created_at": "2026-09-30T10:00:00.000Z",
  "data": { "id": "…", "ref": "T-118", "subject": "Printer offline", "status": "NEW" } }
```

The payload rides under `data` rather than at the top level, so an event's own
fields never collide with the envelope's.

### Verifying it

The signature is `HMAC-SHA256(secret, "{timestamp}.{body}")`, hex, prefixed
`v1=`. The timestamp comes **first** on purpose: a receiver checks it over bytes
it has already authenticated, and a replay of a captured delivery carries the
original timestamp, which is the thing it then refuses.

```js
const expected = `v1=${crypto.createHmac("sha256", process.env.ONTRAK_WEBHOOK_SECRET)
  .update(`${req.headers["x-ontrak-timestamp"]}.${rawBody}`)
  .digest("hex")}`;
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-ontrak-signature"]))) return res.sendStatus(401);
if (Math.abs(Date.now() / 1000 - Number(req.headers["x-ontrak-timestamp"])) > 300) return res.sendStatus(401);
```

Sign the **raw** body, not a re-serialisation of the parsed JSON.

### The signing secret

It is generated by the server, returned exactly once at registration, and
rotatable:

```
POST /api/v1/webhooks        → 201 { "secret": "whsec_…", "secret_shown_once": "…" }
```

Unlike an API token, this one **is** stored — an HMAC cannot be computed from a
hash — so it is a credential the deployment must encrypt at rest, and rotation is
what a customer does when they think it has leaked. It is never returned by a
read, which is what keeps a console from leaking it months later.

### Retries

A delivery that is not accepted is retried on a fixed, readable schedule — 30s,
1m, 2m, 4m — and then **stops**. Five attempts over about half a day; an endpoint
that has been down for a day is not going to be fixed by a sixth attempt, and a
queue that grows without bound is its own outage. There is no jitter: this retries
one delivery per endpoint on a schedule a person can read back, and a delay nobody
can predict is a delay nobody can debug.

`POST /api/v1/webhooks/sweep` is what reads that clock. It is safe to run as often
as you like — a delivery that is not due is not in the worklist, one that has been
delivered is not either, and a removed endpoint stops its deliveries instead of
queueing them forever:

```bash
curl -sS -X POST -H "Authorization: Bearer $ONTRAK_TIX_CRON_SECRET" \
  "https://tix.example.test/api/v1/webhooks/sweep?tenant=acme&limit=200"
```

## The delivery log

```
GET /api/v1/webhooks/deliveries?endpoint_id=clx…&status=RETRYING&limit=50
```

Every delivery, what the receiver answered, how many times we tried, when the next
attempt is due, and **the exact bytes that were sent** — because "what did you
actually send us?" is the question that ends most webhook arguments, and answering
it from the record is the difference between a fact and a reconstruction.

| Status | Means |
| --- | --- |
| `PENDING` | written before the attempt; never tried yet |
| `DELIVERED` | a 2xx, and nothing else |
| `RETRYING` | failed, and `next_attempt_at` says when the next attempt is due |
| `EXHAUSTED` | the fifth attempt failed; the log keeps the count and the last error |

The row is written **before** the request, so an event that arrived while the
process was dying is still visible as one that was due. Every attempt is one
`webhook.delivered` or `webhook.delivery_failed` event on the tenant's hash chain,
so a delivery that exhausted reads as five events rather than as one row that
changed.

## The integrations console

An integrator with `curl` needs nothing more than the endpoints above. Everybody
else needs [`/admin/integrations`](../src/app/(desk)/admin/integrations/page.tsx),
gated on `tenant:manage`, which answers the three questions a desk actually asks:

1. **What is talking to us, and as whom?** Every token with its `tx1_…` prefix, its
   scopes, its rate limit, when it was created, when it expires and when it was last
   used. The prefix is the only part of a secret that can be shown — the database
   holds a hash — and it is enough to recognise the row a leaked token belongs to.
2. **Where do we send things, and did it arrive?** Every endpoint and the delivery
   log, plus a **Deliver what is due now** button: the same sweep a scheduler calls,
   so an administrator can watch a retry instead of waiting half a day to find out
   whether the backoff arithmetic was right.
3. **What is the desk working on by itself?** The monitored conditions below.

The two values that are readable exactly once — a minted token and a webhook
signing secret — are handed to the page in a short-lived, path-scoped `httpOnly`
cookie and put away by a button. A secret in a query string would end up in browser
history, in the `Referer` header and in every proxy log between here and the
browser; a cookie scoped to one path is not.

## The monitoring webhook

An RMM or a monitoring system reports a check's state to:

```
POST /api/rmm?tenant=<slug>
Authorization: Bearer $ONTRAK_TIX_RMM_SECRET

{
  "source": "uptime-kuma",
  "host": "db-01",
  "check": "disk /var",
  "state": "OPEN",
  "severity": "critical",
  "summary": "/var is 98% full",
  "externalId": "alert-1",
  "occurredAt": "2026-09-30T10:00:00.000Z"
}
```

Field aliases are accepted (`device`/`hostname`, `monitor`/`check_name`,
`status`/`alert_state`, a boolean `resolved`, epoch seconds or milliseconds), so a
vendor does not have to be rewritten to talk to us. A payload with no host, no
check or no readable state is a `400` with nothing written: an alert about
"something" is not work, and guessing which way an unreadable state points would
either open a ticket for a recovery or close work that is still failing.

The reply codes are policy, and are chosen so a monitoring system's own retry
behaviour does the right thing:

| Code | Means |
| --- | --- |
| `202` | the desk acted: a ticket was opened, reopened, or closed |
| `200` | the answer is already true and would be again: a repeat, a recovery we never opened against, a second recovery |
| `400` | the payload was never an alert, so retrying cannot help |
| `503` | the desk cannot respond at all (no user the work could be raised for), so retrying should |

**The condition is what a ticket is opened against, not the event.** The key is
`source:host:check`, case-folded and whitespace-collapsed, which is what makes a
recovery find its ticket even when the vendor mints a fresh alert id for it. From
that key and the condition's current state, five outcomes follow:

| Condition | Alert | Outcome |
| --- | --- | --- |
| none | failing | **open** a ticket |
| open, ticket live | failing | **repeat**: an internal note and a higher occurrence count, no second ticket |
| resolved | failing | **reopen**: a *new* ticket, because the last outage ended and this one has its own response clock |
| open, ticket live | recovered | **resolve**: note the downtime, then close by walking the lifecycle's own edges |
| resolved, or none | recovered | **ignore** (recorded only when the desk knew the check) |

A ticket a person already closed is left alone — the clear is still recorded on the
link, because when the check came back is a different question from when the desk
finished. Closing walks `NEW → OPEN → CLOSED` rather than jumping, because
`ticket-rules.ts` forbids the shortcut and an auto-closed ticket should leave the
trail a person's would. The condition and its ticket are on the tenant's hash chain
under `rmm.alert.open`, `rmm.alert.repeat`, `rmm.alert.reopen`,
`rmm.alert.resolve` and `rmm.alert.ignored`, keyed by the condition so a recurring
fault reads as one story. Setting `ONTRAK_TIX_RMM_REQUESTER_EMAIL` decides who the
work is raised for; without it the tenant's first active administrator is used.

## Chat notifications

Slack and Teams, which are the same events told to a different audience: an
integration reconciles from the webhook, and a person reads the room. A channel is
configured from the integrations console rather than with a token — the room's
webhook URL *is* the credential — but it subscribes to the same closed event set
(`ticket.created`, `ticket.updated`, `ticket.replied`), because two lists of events
is two chances to forget one and "the API told my integration but not my channel"
is a support ticket whose answer would be "they are configured differently".

Two rules make it safe to post a requester's words into a room:

- **The destination is the provider's.** A channel URL is checked at registration
  against the hosts Slack and Microsoft own — `hooks.slack.com`,
  `hooks.slack-gov.com`, `*.webhook.office.com`, `outlook.office.com`,
  `*.logic.azure.com` — with an exact-or-suffix host match, so
  `hooks.slack.com.evil.test` is refused. `https` only, no fragment, no embedded
  credentials.
- **The text is data, not markup.** Every value is escaped for its provider's
  parser. In Slack that means `&`, `<` and `>` become entities, because
  `<!channel>`, `<!here>` and `<!everyone>` are *live control tokens* and
  `<https://…|label>` is a link — a subject of `<!channel> disk full` would
  otherwise page four hundred people from a help-desk form. Teams' card text is
  markdown, so its metacharacters are escaped as well.

A notification needs no signature, and that is not an omission: Slack and Teams
authenticate the *destination* — the URL carries its own token — while our webhook
receiver has to be able to prove a body came from us. A `POST` into a room is a
one-way message, not a contract.

Delivery uses the same state machine as a webhook (`DELIVERED`, `RETRYING` with
the instant of the next attempt, `EXHAUSTED` after five), and each channel keeps
its own delivery log in the console, alongside a button that posts one test
message now — which is the only way to find out that a chat webhook URL pasted
slightly wrong fails *silently*, because nobody notices a message that never
arrived.

## What is deliberately missing

- **No `PATCH` or `DELETE` on tickets.** A public API that can silently rewrite a
  desk's history is a larger decision than this milestone, and the audit trail is
  more useful if integration writes are additions.
- **No OAuth for API tokens.** Client-credentials OAuth arrives with the rest of
  the platform's identity work; a scoped bearer token is the honest smaller thing
  that can be revoked today.
- **No cursor query in `TicketStore` yet.** The list endpoint pages the tenant's
  tickets in memory. That is the seam: the port grows a cursor query when a tenant
  has more tickets than fit in a response, and until then this says so rather than
  implying a database-level cursor exists.
- **No request signing on the way in.** The token is the credential; a signature
  scheme on top of it would be a second thing to get right before the first thing
  is useful.
