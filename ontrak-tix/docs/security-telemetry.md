# Security telemetry ingest

OnTrak Tix **ingests** alerts from the security stack — it does not replace the
sensor. The job is to fold IDS/IPS, SIEM, EDR and network-sensor alerts into one
normalized stream the desk can triage, deduplicate and enrich against what it
already knows about its assets and identities.

This is the security-telemetry slice of **M2 — Identity & security telemetry**
(see `ROADMAP.md`). The IdP (OIDC/SAML SSO, SCIM, MFA) is the remaining M2 work.

## Pieces

| Concern | Where |
| --- | --- |
| Pure rules: normalize, dedupe, enrich, coverage, summary | `src/lib/security-alert-rules.ts` |
| Ingest service + in-memory store | `src/lib/security-alert-service.ts` |
| Prisma adapter for `SecurityAlert` | `src/lib/security-alert-store-prisma.ts` |
| Per-vendor connectors (webhook + poll) | `src/lib/security-alert-connector.ts` |
| HTTP entry point | `src/app/api/security/ingest/route.ts` |
| Promotion / suppression / false-positive rules | `src/lib/alert-promotion-rules.ts` |
| Promotion service + in-memory store | `src/lib/alert-promotion-service.ts` |
| Prisma adapter for verdicts, suppressions, promotions | `src/lib/alert-promotion-store-prisma.ts` |
| Scheduled poll entry point | `src/app/api/security/poll/route.ts` |
| Triage console | `src/app/(desk)/security/page.tsx`, `src/components/SecurityAlertList.tsx`, `src/app/actions/security.ts` |
| Models | `prisma/schema.prisma` (`SecurityAlert`, `AlertVerdict`, `AlertSuppression`, `AlertPromotion`) |
| Tests | `tests/tix-m2-telemetry.test.ts`, `tests/tix-m2-promotion.test.ts`, `tests/tix-m2-connector.test.ts`, `tests/tix-m2-sso.test.ts` |

## What "normalize" means here

A connector hands over a vendor-shaped `RawSecurityAlert`; `normalizeAlert`
returns one canonical `NormalizedSecurityAlert`:

- **Source.** `normalizeSource` classifies the vendor into `IDS`, `IPS`, `SIEM`,
  `EDR` or `NETWORK`. The patterns are ordered most-specific-first so a product
  whose name contains another's (SentinelOne vs Microsoft Sentinel) lands in the
  right class. Unknown vendors default to `SIEM`.
- **Severity.** `normalizeSeverity` accepts a word (`critical`, `warning`,
  `informational`, …) or a number. Numbers are read against the two scales
  vendors actually use: a small level (`0`–`5`, low→high) and a score out of
  `100`. An unreadable value becomes `MEDIUM` — visible, never dropped.
- **Time.** `normalizeOccurredAt` parses to ISO-8601 UTC and throws on an
  unparseable value rather than inventing one.

## De-duplication

Every alert gets a `dedupeKey`:

1. If the vendor supplied its own alert id, that wins: `<source>:id:<id>`.
2. Otherwise a fingerprint is built from the source, the lower-cased signature,
   the asset, the identity, and the start of the five-minute window the alert
   falls in. Repeats of the same detection against the same subject inside a
   window collapse to one key.

`SecurityAlertService.ingest` looks up the key before writing, so ingest is
**at-least-once safe**: a repeat bumps `occurrences` and advances `lastSeenAt`
without inserting a row, while `firstSeenAt` is never rewritten. The same alert
in two tenants is stored independently (`@@unique([tenantId, dedupeKey])`).

The **first** sighting emits a `security.alert.ingest` event into the
hash-chained audit log, so the record the desk acted on is tamper-evident.
Repeats do not — they are the same alert, not new activity.

## Enrichment and triage

`enrichAlert` attaches what the desk knows: the asset's owner, client and
criticality, and whether the identity is privileged. It then produces a
`triageSeverity` — the sensor's own `severity` raised one step when the alert
lands on a business-critical asset or a privileged identity, capped at
`CRITICAL`. The sensor's classification is kept untouched; the bump is a triage
hint, not a re-write of the evidence.

`coverageAgainst(alerts, expectedDetections)` reports which expected detections
produced alerts and which are silent, so a quiet sensor is visible rather than
merely absent from the list. `summarizeAlerts` rolls the stream up by severity
and source.

## Connectors

A sensor or SIEM does not speak this vocabulary, and different deployments
deliver alerts differently, so both arrive through one seam in
`security-alert-connector.ts`:

- **`parseVendorAlert`** reads a vendor's payload through its common field
  aliases (`vendor`/`product`, `severity`/`priority`/`level`/`score`,
  `signature`/`rule`/`ruleName`, `hostname`/`asset`/`device`, …). A payload with
  no identifiable vendor or no parseable time returns `null`, so the route can
  answer 400 without writing a junk row. A missing severity defaults to
  `MEDIUM`.
- **`SecurityAlertConnector`** feeds one payload to the ingest service (the
  webhook path) and reports `created`, `duplicate` or `failed`.
- **`VendorAlertPoller`** drains an `AlertSource` (a vendor API, a queue, a fake)
  and acknowledges each alert only after the service has taken it; a `failed`
  alert stays unseen so the next poll retries it, while a payload that was never
  an alert is acknowledged because retrying it would fail identically forever.

Two HTTP entry points:

- **`POST /api/security/ingest`** is the push path. It authenticates with the
  shared secret (`Authorization: Bearer …` or `x-ontrak-secret`, the same
  `ONTRAK_TIX_WEBHOOK_SECRET` as email intake) and resolves the tenant from
  `?tenant=<slug>` or `x-ontrak-tenant`. `connectorReply` maps the outcome onto a
  status: 202 created, 200 idempotent redelivery, 400 not an alert, 500 retry.
- **`POST /api/security/poll?tenant=<slug>`** is the pull path, for vendors that
  only offer an API. A cron hits it with the same secret as the other schedulers
  (`ONTRAK_TIX_CRON_SECRET`); `HttpAlertSource` lists from
  `ONTRAK_TIX_ALERT_SOURCE_URL` (with `_TOKEN`, and an `_ACK_URL` template using
  `<id>`) and `VendorAlertPoller` drains it. The tenant is required rather than
  inferred — one vendor feed belongs to one tenant — and an unset source is
  reported as `503` rather than a silent success.

The `dedupeKey` is the real idempotency guard, so an at-least-once sender or a
repeated poll is safe.

## Promotion, suppression and false positives

An alert stream is not a worklist, so `alert-promotion-rules.ts` decides what an
alert is *worth* before the service acts:

- **`PROMOTE`** — a `HIGH`+ triage alert on sight, or a sub-threshold detection
  that has repeated (default five times).
- **`SUPPRESS`** — covered by a suppression rule, silenced by a false-positive
  history, or already promoted. A suppression is a recorded decision with a
  reason, never a silent drop.
- **`OBSERVE`** — below the bar and not yet repeated; it stays in the stream.

A **suppression rule** names a field (`signature`/`asset`/`identity`/`source`),
a case-insensitive substring and an optional expiry. **False-positive tracking**
counts `FALSE_POSITIVE`/`BENIGN` verdicts per signature over the policy window;
`TRUE_POSITIVE` verdicts are kept for the history but never suppress. Order
matters: a suppression or a false-positive history outranks severity, because
those records exist precisely because severity alone proved to be the wrong
signal.

`AlertPromotionService` promotes through the **normal ticket lifecycle** — it
calls `TicketService.createTicket` as a system `ADMIN` for a caller-supplied
requester, so the usual access rules and audit trail apply. It then writes
`SecurityAlert.ticketId` (first-write-wins, so a retried promotion returns the
existing ticket rather than opening a second) and records the decision in
`AlertPromotion` plus a `security.alert.promote` / `security.alert.suppress`
event on the hash chain.

## The triage console

`/security` is where the desk works the stream:

- each alert shows its **sensor and triage severity**, the enrichment (asset,
  owner, identity, source IP) and how many times it has repeated;
- its **status is always a sentence** — promoted (with a link to the ticket),
  suppressed (with the reason), or still in the stream. "Suppressed" and "nobody
  looked" are very different answers, so neither is an absence;
- staff can **open an incident** (the acting staff member is the requester — an
  alert has no end user), **record a false-positive verdict**, and **configure a
  suppression rule**.

All three actions go through the promotion service, so the rules and the audit
chain are the same ones the scheduled paths use. Requesters cannot reach the
page, and triage is gated on `ticket:update`.

## What is not here yet

- A persisted asset/identity directory — enrichment currently takes whatever
  asset and identity records the caller supplies (so the seeded demo alerts are
  not enriched).
- Per-tenant connector configuration — the polled source is deployment-wide
  today.
