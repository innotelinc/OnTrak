# OnTrak Tix

[![CI](https://github.com/innotelinc/OnTrak/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/OnTrak/actions/workflows/ci.yml)
[![Conformity](https://github.com/innotelinc/OnTrak/actions/workflows/conform.yml/badge.svg)](https://github.com/innotelinc/OnTrak/actions/workflows/conform.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)

An **enterprise ticketing and service-management platform** for internal IT
service desks and Managed Service Providers (MSPs). OnTrak Tix tracks every
request, incident, change and problem from intake to closure, enforces SLAs,
coordinates multi-client work for MSPs, and is the system of record for the
people, assets and processes behind IT support.

It is part of the [Innotel Labs](../INNOTEL-LABS.md) family, alongside
[OnTrak IT Support Training](../README.md): the training product **trains** the
technicians, OnTrak Tix is the tool they **work in**.

The badges are the repository's, not this directory's: OnTrak Tix has no
workflow of its own, because its jobs are the `tix` job of
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — the same run that
lints, typechecks and tests the training app beside it. Conformity is the
[Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)
audit, and the licence is the repository's MIT [`LICENSE`](../LICENSE).

```
        ┌──────────────────────────┐            ┌──────────────────────────┐
people →│  OnTrak Tix (real work)   │  tickets →│ OnTrak IT Training        │
        │  queues · SLAs · billing  │  ◀──────  │  scenarios · grading      │
        └──────────────────────────┘  scenarios └──────────────────────────┘
```

## Why it exists

Service desks run on tools that are either too small (a shared inbox with a
spreadsheet) or too heavy (an ITSM suite priced and shaped for enterprises).
OnTrak Tix targets the middle: the full lifecycle for a real desk — intake,
triage, assignment, SLA, time, knowledge, billing, reporting — without the
implementation project.

It also treats **incident response and defensible documentation as first-class**.
When something goes wrong, the record of what was known, decided and done has to
hold up to auditors, insurers and regulators — so OnTrak Tix produces a
contemporaneous, tamper-evident timeline and signed evidence, not a narrative
reconstructed from memory.

## Highlights (target scope)

- **Omnichannel intake** — email, web portal, Slack/Teams, phone (agent-entered),
  API, and monitoring alerts, all converging on one ticket pipeline.
- **Multi-client from the ground up** — one tenant serves many customer
  companies, each with isolated data, contacts, SLAs, and branding.
- **SLA engine** — per-client, per-priority response/resolution targets with
  business-hours calendars and automatic breach/escalation handling.
- **Queues, routing and assignment** — rules-based triage, round-robin/load
  balancing, skills tags, and round-the-clock shift handoff.
- **Time, billing and CSAT** — billable time entries, rate cards, invoice
  exports, and satisfaction surveys.
- **Knowledge & automation** — a knowledge base with public/private articles,
  canned responses, macros, and a workflow/automation engine.
- **Incident response** — severity, incident commander, playbooks, an
  auto-assembled war-room timeline, evidence collection, and post-incident review.
- **Identity (IdP)** — OIDC/SAML SSO, SCIM provisioning, enforced MFA, with every
  authentication and privilege event audited.
- **Security telemetry** — ingest IDS/IPS, SIEM, EDR and network-sensor alerts
  into one normalized alert → ticket/incident pipeline.
- **Insurance-grade evidence** — a hash-chained, append-only audit log, evidence
  chain of custody, legal hold, and one-click signed **Assurance Packet** export
  for adjusters and auditors.
- **Integrations** — RMM and monitoring tools, chat, and a public REST API with
  webhooks.

## Status

**M0–M5 complete; M6 in progress.** The foundations have landed:

- `src/lib/access-rules.ts` — roles, the permission matrix, and the
  tenant-isolation checks every server action runs before touching a row.
- `src/lib/ticket-rules.ts` — ticket types and statuses, the lifecycle state
  machine, input validation, and the append-only conversation rule.
- `src/lib/audit-chain.ts` — the hash-chained, append-only, per-tenant audit
  log with tamper detection (the evidence spine).
- `src/lib/ticket-service.ts` — pure ticket `plan*` functions plus a
  `TicketService` that persists through a small store port and emits an audit
  event per mutation; ships an in-memory store for local work and tests.
- `src/lib/ticket-store-prisma.ts` — the Prisma side of those ports: a
  `TicketStore`, a durable per-tenant hash-chained `AuditSink`, and the pure
  row/record mappers, all written against a small structural client interface so
  they run against the generated client, a fake, or a repository layer.
- `src/lib/ticket-server.ts` — one factory (`configureTickets`) that turns a
  Prisma client into a ready service stack.
- `src/lib/session-rules.ts` + `src/lib/session.ts` — tenant-scoped session rules
  (pure) and the cookie/JWT plumbing that resolves the current `Actor`.
- `src/lib/password.ts` + `src/lib/auth-store.ts` + `src/app/actions/auth.ts` —
  the local sign-in fallback: scrypt hashing, a structural user lookup and the
  sign-in action; `prisma/seed.ts` is idempotent and seeds one account per role.
- `src/lib/email-worker.ts` — the inbound-mail worker: it carries a message
  through the ingest plan, resolves the sender to a requester, creates or
  appends through the ticket service, and records it in an `InboundMessage`
  intake ledger so a retry is a no-op.
- `src/lib/email-transport.ts` — the transport that feeds the worker: a
  provider-webhook adapter and a `MailboxPoller` over a `MailboxSource` (with an
  `ImapMailboxSource` adapter), acknowledging handled mail so a crash mid-batch
  retries rather than loses it.
- `src/lib/intake-webhook.ts` + `src/app/api/intake/email/route.ts` — the
  inbound-email webhook: shared-secret auth, tenant resolution and outcome-to-
  status mapping (pure, tested), wrapped in the `POST /api/intake/email` handler
  that feeds the transport. Operator setup is in [docs/email-intake.md](./docs/email-intake.md).
- `src/app/` — the app shell: server actions for create/reply/status/assign, a
  signed-in desk layout, the agent inbox (list, detail, quick-create) and the
  requester portal (my tickets, raise a ticket, follow a thread).
- `src/lib/inbox-view.ts` + `src/components/` — the inbox view model and the
  presentational `AgentInbox` / `TicketDetail` / `TicketList` components.
- `src/lib/db.ts`, `package.json`, `tsconfig.json`, `next.config.ts`,
  `postcss.config.mjs`, `Dockerfile`, `docker-compose.yml`, `.env.example` — the
  standalone project scaffold, so the shell runs on its own.

### Running the app

In containers:

```bash
cd ontrak-tix
cp .env.example .env      # set DATABASE_URL and TIX_AUTH_SECRET
docker compose up -d --build                  # serve on :3001

docker compose --profile demo run --rm seed   # optional: the demo tenant below
```

Tix is schema-first, so the one-shot service in front of the app pushes the
schema rather than deploying migrations. Attachments and incident evidence each
live on their own volume, because evidence sits under object-lock retention and
a rebuild must never discard it.

As a deployment, `docker-compose.prod.yml` overlays the above: the database stops
being published on a host port, the secrets become required instead of defaulted,
and the containers restart by themselves. It refuses to start while
`TIX_AUTH_SECRET` or `POSTGRES_PASSWORD` is unset, because the development
placeholders in `.env` are public knowledge.

```bash
cp .env.production.example .env.production   # then fill in the two REQUIRED values
make tix-prod-up      # from the repository root, or:
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Give it a fresh volume. Postgres applies `POSTGRES_PASSWORD` only when it creates
the role, so pointing this at an existing development database will not change
that database's password and the app will fail to authenticate.

From source:

```bash
cd ontrak-tix
cp .env.example .env      # set DATABASE_URL and TIX_AUTH_SECRET
npm install
npm run docker:db         # or point DATABASE_URL at your own Postgres
npm run setup             # prisma generate, db push, then seed the demo tenant
npm run dev
```

> Both stacks publish their database on 5432, so run one at a time — or set
> `ONTRAK_TIX_DB_PORT` here (and `ONTRAK_DB_PORT` in the training app) to run
> them side by side.

The seed creates tenant `acme` with an account per role — `admin@acme.test`,
`dispatcher@acme.test`, `agent@acme.test` and `requester@acme.test`, all with the
password `ChangeMe123` — plus a queue and two sample tickets.

> Install dependencies **before** running `prisma generate`: the generator
> writes the client next to whichever `@prisma/client` it resolves, so a
generate without a local install would rewrite the parent project's client.
> The training app and tix use separate databases on purpose.
- `src/lib/intake-rules.ts` — the email-to-ticket decision: normalization,
  auto-reply suppression, type/priority inference, threading and dedupe.
- `src/lib/intake-service.ts` — the worker's decision (`planIngestion`) behind
  an `ONTRAK_TIX_EMAIL_INGESTION` feature flag, safe to retry.
- `src/lib/inbox-rules.ts` — agent-inbox filtering, ordering and counts;
  `src/lib/bulk-rules.ts` — bulk selection and the honest "n applied, m skipped"
  summary behind the inbox toolbar.
- `src/lib/saved-view-rules.ts` + `saved-view-service.ts` +
  `saved-view-store-prisma.ts` — named, shareable inbox filter presets (the chip
  strip above the worklist), with the filter sanitized on the way in and out and
  access scoped to the owner or the desk.
- `src/lib/sla-rules.ts` — the SLA engine (M1): business-hours calendars,
  business-minute arithmetic, response/resolution clocks with their
  `met`/`on-track`/`warning`/`breached` states, roll-up and attainment, plus
  policy selection and validation. Pure; a `firstResponseAt` on the ticket is its
  input.
- `src/lib/routing-rules.ts` — queue routing (M1): ordered queues with ANDed
  criteria and keyword matching, and an explicit catch-all fall-through.
- `src/lib/csat-rules.ts` + `src/lib/csat-service.ts` — CSAT (M1): tokenised
  surveys offered once a ticket is resolved, answered once, with an honest
  response-rate roll-up.
- `src/lib/attachment-rules.ts`, `attachment-service.ts`,
  `attachment-store-prisma.ts`, `attachment-blob-file.ts` — attachments (M1): an
  allow-list of types, size/count limits, filename sanitisation, namespaced
  storage keys, a `BlobStore` port (filesystem for local/single-node) and
  metadata persistence.
- `src/lib/escalation-rules.ts`, `escalation-service.ts`,
  `escalation-store-prisma.ts` — SLA escalations (M1): a warning ladder
  (half-window → near-deadline → passed) with widening audiences, and an
  idempotent sweep that raises each rung once under a `dedupeKey`, recording an
  `SlaEscalation` and an audit event. `POST /api/sla/sweep` (secret-authenticated
  with `ONTRAK_TIX_CRON_SECRET`) is what a scheduler calls; see
  [docs/sla.md](./docs/sla.md).
- `src/lib/sla-store-prisma.ts` — reads `SlaPolicy` rows back into domain
  policies, coercing the JSON calendar with a safe fallback.
- `src/lib/report-rules.ts` — the dispatcher report (M1): open/closed and
  unassigned counts, response/resolution attainment over the decided clocks,
  median and p90 business-minute timings, and the breached/at-risk lists,
  rendered at `/reports`. Its single-ticket `slaStatusFor` powers the `SlaBadge`
  on the ticket detail in the inbox and the portal, so the clock is visible where
  the work is. `report-csv.ts` serialises the same report as RFC-4180 CSV, served
  by the staff-guarded `GET /reports/export` download; `POST /api/sla/report`
  (cron-secret authenticated) writes each tenant's snapshot to the audit chain as
  a `report.sla.snapshot` event — the scheduled form of the weekly report.
- `src/lib/canned-rules.ts` + `canned-service.ts` + `canned-store-prisma.ts` —
  canned responses (M1): template substitution for `{{ref}}`/`{{subject}}`/
  `{{requester}}`/`{{agent}}`, a staff-guarded CRUD service, starter replies, and
  the `/canned` library page. The reply composer offers one-click fills.
- `src/lib/link-rules.ts` + `link-service.ts` + `link-store-prisma.ts` — ticket
  links and merge (M1): a `TicketLink` relation (related/parent/child/duplicate)
  rendered reciprocally, and a merge that folds a duplicate's conversation into
  the survivor, closes the duplicate and points a `DUPLICATE` link forward —
  audited and gated on `ticket:update`.
- `src/lib/notification-rules.ts` + `notification-service.ts` +
  `notification-store-prisma.ts`, `notification-preference-store-prisma.ts` —
  notifications (M1): the SLA sweep's in-app notices, addressed to the rung's
  audience role, plus an email digest behind an `EmailSender` port (a console
  transport by default). The `/notifications` page shows them with a nav unread
  count and per-user preferences (minimum ladder level, or mute); dedupe mirrors
  the escalation key.
- `src/lib/security-alert-rules.ts` + `security-alert-service.ts` +
  `security-alert-store-prisma.ts` — security-telemetry ingest (M2): normalize
  IDS/IPS/SIEM/EDR/network-sensor alerts into one closed vocabulary, dedupe
  repeats under a stable `dedupeKey` (so ingest is at-least-once safe), and
  enrich each alert from the desk's assets and identities with a triage-severity
  bump. The first sighting is audited; see
  [docs/security-telemetry.md](./docs/security-telemetry.md).
- `src/lib/security-alert-connector.ts` — the per-vendor connectors (M2): reads a
  vendor payload through its field aliases and feeds it to the ingest service,
  with a webhook seam (`SecurityAlertConnector`) and a `VendorAlertPoller` over
  an `AlertSource` that acknowledges only what the service took. The
  shared-secret `POST /api/security/ingest` handler is the HTTP entry point.
- `src/lib/alert-promotion-rules.ts` + `alert-promotion-service.ts` +
  `alert-promotion-store-prisma.ts` — alert → ticket promotion (M2): when an
  alert is worth a ticket, when a suppression rule or a false-positive history
  keeps it out of the queue, and when it is merely observed. Promotion opens an
  incident through the normal ticket lifecycle, links the alert to it under a
  first-write-wins guard, and records the decision plus an audit event.
- `src/lib/identity-rules.ts` + `identity-service.ts` +
  `identity-store-prisma.ts` — identity (M2): the tenant's IdP connection as
  validated config, an issuer/domain/MFA gate on the IdP's claims, group→role
  mapping with a default, and a SCIM create/update/deactivate plan. The service
  resolves claims to a user (creating on first sign-in, updating after) and
  audits every sign-in, refusal, role change and provisioning push; see
  [docs/identity.md](./docs/identity.md).
- `src/lib/oidc-rules.ts` + `oidc-client.ts` + `sso-session.ts` +
  `src/app/api/sso/{start,callback}/route.ts` — single sign-on (M2): the pure
  OIDC rules (discovery validation, the authorization request with `state`,
  `nonce` and PKCE, ID-token claim extraction) and a `jose`-verified client,
  wired into a signed-cookie handshake so staff sign in through the tenant's IdP.
  A workspace resolves to a tenant on the sign-in screen.
- `src/components/SecurityAlertList.tsx` + `src/app/(desk)/security/page.tsx` +
  `src/app/actions/security.ts` — the security console (M2): the alert stream
  with each alert's promotion outcome, one-click incident promotion,
  false-positive verdicts and suppression rules.
- `src/app/api/security/poll/route.ts` — the scheduled poll entry point (M2) for
  vendors that only offer an API; `HttpAlertSource` drains them through the same
  connector, rules and dedupe ledger as the push path.
- `src/lib/incident-rules.ts` + `incident-service.ts` + `incident-store-prisma.ts`
  — incident response (M3): the impact×urgency severity matrix (with the inputs
  stored beside the outcome), the phase ladder from detected to reviewed, the
  four incident roles, and an append-only timeline written as things happen. A
  SEV1/SEV2 cannot be triaged without a commander and a scribe; every change is
  audited. See [docs/incidents.md](./docs/incidents.md).
- `src/lib/playbook-rules.ts` + `src/lib/evidence-rules.ts` +
  `src/lib/incident-docs-service.ts` + `src/lib/incident-docs-store-prisma.ts` —
  playbooks and evidence (M3): a response runbook planned **by severity**, whose
  steps are completed or skipped-with-a-reason (and reopened rather than silently
  flipped), plus evidence items that are validated and rolled into a digest-stable
  manifest. Declaring an incident starts its playbook; every step change and
  evidence record lands on the timeline and the hash-chained audit log.
- `src/components/IncidentList.tsx` + `src/app/(desk)/incidents/page.tsx` +
  `src/app/actions/incidents.ts` — the incident console (M3): declare an incident,
  advance its phase, staff the four roles, run the playbook, record evidence and
  write the timeline. It offers only the legal next moves, and is read-only for an
  actor without `ticket:update`.
- `src/app/api/incidents/[id]/manifest/route.ts` — the evidence manifest download
  (M3): an incident's evidence as JSON, with a per-item digest and a manifest hash
  that depends on the content rather than on the moment of export.
- `src/lib/assurance-rules.ts` + `assurance-sign.ts` + `assurance-service.ts` +
  `src/app/api/incidents/[id]/packet/route.ts` — the **Assurance Packet** (M3):
  the incident, its playbook, its evidence manifest, its chain of custody and any
  legal hold, its timeline, an excerpt of the tenant's audit chain with the head
  it was read at, and the policy versions in force — assembled from the manifest
  so a packet cannot disagree with the record it cites, digested twice
  (`recordHash` is stable for an unchanged record; `contentHash` also covers the
  audit anchor) and signed with an HMAC so it verifies offline. Exporting a
  packet is itself audited as `incident.packet.export`.
- The chain of custody and legal hold (M3) live in `evidence-rules.ts`,
  `incident-docs-service.ts` and the `CustodyEntry`/`LegalHold` models: evidence
  is collected with its first custody entry, hand-offs carry a recipient and a
  reason and must start from the current holder, and an active hold blocks
  routine retention (`retentionDecision`) until it is explicitly released.
- `src/lib/object-lock-rules.ts` + `object-lock-file.ts` (M3) — **object-lock
  (WORM) storage** for the evidence bytes themselves: content-addressed keys
  (`evidence/<tenant>/<incident>/<sha256>`) so a key cannot drift from its
  content and a re-upload of the same bytes is the same object rather than an
  overwrite; `COMPLIANCE` retention nobody can shorten versus `GOVERNANCE`, which
  a privileged caller may remove early only explicitly and on the record; a legal
  hold that outranks the clock in both directions; and a write-once filesystem
  store that opens each file with `wx` and hands out the S3 `x-amz-object-lock-*`
  headers a real object-locked bucket needs. The lock travels inside the manifest
  digest. The window is acted on rather than waited on:
  `planRetentionSweep` decides what a closed lock allows (using the same
  `objectPurgeDecision` a manual purge uses, so a sweep and a button press cannot
  disagree about a COMPLIANCE artifact) and `IncidentDocsService.sweepRetention`
  purges the bytes and the row, leaving a tombstone, a timeline line and both a
  per-artifact audit event and one for the run — a legal hold stops it in both
  directions, `dryRun` reports without changing anything, and the report says
  what it left alone and why.
- `src/app/api/incidents/retention-sweep/route.ts` + `scripts/retention-sweep.ts`
  (`npm run sweep:retention`) — the **retention sweep's** scheduled entry point
  (Bearer-authenticated with `ONTRAK_TIX_CRON_SECRET`, `?tenant=`, `?dryRun=1`)
  and its operator-script equivalent. Idempotent, so it is safe to run hourly:
  a purged artifact is out of the worklist the second time.
- `src/lib/war-room-rules.ts` + `war-room-service.ts` (M3) — the **war-room
  timeline**: the incident log, the tenant's audit chain, the alert stream and
  the decisions taken about the incident, merged into one view where the same
  fact seen by two systems is one entry attested by both. Reading it writes
  nothing, so assembling a timeline cannot edit the record it describes.
- `src/lib/regulatory-rules.ts` + `review-rules.ts` + `compliance-service.ts`
  (M3) — **notification duties** with regimes suggested from the incident's own
  facts and run on a clock measured from detection or declaration (late sends
  recorded as late, waivers carrying a reason and a name), and the
  **post-incident review** with tracked actions that have an owner, a due date
  and a status moving only the legal way.
- `src/lib/comms-rules.ts` (M3) — **incident communications templates**: each
  regime comes with a draft (subject, body, guidance) rendered from the incident's
  own facts by the same `{{name}}` engine the M1 canned responses use, so a
  desk's own canned wording can be offered as an incident notice unchanged.
  Fields only a person can supply are named, and a notice with one unresolved is
  refused rather than recorded as sent; the text that went out is stored on the
  duty, so the record holds what was said rather than what a template would say.
- `src/lib/comms-template-service.ts` +
  `src/app/(desk)/incidents/templates/page.tsx` (M3) — **a desk's own notice
  drafts**: author a template aimed at a regime (offered ahead of the shipped
  ones on that duty) or at none (offered on every duty), with placeholders
  validated at authoring time so a typo is refused while somebody is looking at
  the form. Drafts are retired rather than deleted, so a notice that cited one
  stays explainable.
- `src/lib/client-rules.ts` + `client-service.ts` + `client-store-prisma.ts`
  (M4) — **clients, contacts, scope and acting as a client**: the companies one
  desk serves and the people at them — an address a reply can reach, refused
  when the desk already has it — an  assignment row that *is* the agent's scope (`queue:manage` sees every client, an agent only the ones they serve,
  and work naming no client stays visible to the whole desk), and an "act as
  client" window that takes a permission, a client in scope, a reason on the
  record and one window at a time, recorded both as a row and as an audit event.
  The scope is a filter on *reading* and a refusal on *writing*: the worklist
  hides a third client's work, the ticket's own page answers a `404` for it, and
  reply, status, assignment and the bulk toolbar refuse it — an action arrives as
  a ticket id in a form, and a hidden field is not a permission. A ticket records
  the client it was raised for (chosen from the clients the actor serves on
  `/inbox/new`), so the scope has something real to scope.
  The same slice gives the SLA ladder its client rung (`SlaPolicy.clientId`,
  `resolveSlaPolicy`, see [docs/clients.md](./docs/clients.md)), and the console
  is [`/clients`](./src/app/(desk)/clients/page.tsx), which prints each client's
  promise per priority *and which rung answered it* — and where the desk writes
  its own promises (`sla-policy-service.ts`): validated before they are in force,
  on one of two hour presets, audited on every change, editable but not deletable
  while tickets are measured against them.
- `src/lib/time-rules.ts` + `time-service.ts` + `time-store-prisma.ts` (M4) —
  **time, rates and invoices**: hours logged on the ticket they belong to, priced
  by a client's card or the desk's default and snapshotted onto the entry so a
  later rate change cannot restate what was billed, rounding as a stated contract
  term, and an invoice that is *issued* by a POST which stamps and freezes what it
  covers — `/time/export?ref=…` only re-reads it, so a second click cannot bill an
  hour twice. Documented in [docs/billing.md](./docs/billing.md).
- `src/lib/client-survey-rules.ts` + `client-survey-service.ts` (M4) — the
  **client-facing survey**: one question per client per period, answered from an
  unguessable link at [`/survey/[token]`](./src/app/survey/[token]/page.tsx) by
  somebody with no account, because the person who signs the invoice is usually
  not the person who raised the tickets. Link answers once, expires, and both
  halves are on the audit chain. Per-client attainment and CSAT are on
  [`/reports`](./src/app/(desk)/reports/page.tsx), built by the same function as
  the desk-wide figures.
- `src/lib/rule-rules.ts` + `rule-service.ts` + `rule-store-prisma.ts` (M5) —
  **automation rules**: a trigger (`ticket.created|updated|replied`), the
  conditions that narrow it and the actions it takes (set a field, route, assign,
  tag, notify, reply, escalate). Conditions are **all** required — there is
  deliberately no OR, because "which rule did this?" should have one answer, and
  no regex, because a rule is only worth anything if a person reading it can
  predict what it does. Rules run in `position` order and the **first** to set a
  field owns it; a later rule that wanted the same field is recorded as skipped
  *with the reason*. Writing one needs `rule:manage`, names are unique
  case-insensitively, and every write lands on the audit chain with the rule's
  whole body. Documented in [docs/rules.md](./docs/rules.md).
- `src/lib/rule-intake.ts` (M5) — **the rules, applied**: the one seam
  `TicketService` calls, so a rule fires wherever a ticket is created, updated or
  replied to (quick-create, the portal, inbound email, alert promotion) without
  any of those paths knowing rules exist. On creation the rules run *before* the
  row is written, so a ticket is born with the priority, queue, assignee and tags
  the desk asked for; a `reply` action appends a public message from the desk and
  stops the response clock; `notify` and `escalate` reach staff through an
  injected sink, and an effect that cannot be delivered never loses the ticket.
  Every firing appends one `ticket.rules` event naming what applied and what was
  outvoted.
- `src/app/(desk)/rules/page.tsx` + `src/app/actions/rules.ts` + `src/lib/
  rule-form-rules.ts` (M5) — the **automation console**: every rule read back as
  sentences, its hazards said out loud, its order changeable (position *is* the
  policy) and its preview run through the same engine the live path uses. A
  switched-off rule is previewed *as if it were on* — the moment the question is
  actually asked — over the last 50 tickets, writing nothing. Reading needs
  `ticket:read:any`; writing, moving, switching and removing need `rule:manage`.
- `src/lib/macro-rules.ts` + `macro-service.ts` + `macro-store-prisma.ts` +
  `macro-intake.ts` (M5) — **macros**: the deliberate counterpart to a rule, a
  saved sequence an agent runs on one ticket. A macro has no trigger and no
  conditions (if it needs one it is a rule) and reuses the engine's own eight
  actions and the same `planTicketChanges`, so the two cannot drift. Running one
  is `ticket:update` and is attributed to the agent as `ticket.macro`; a `reply`
  goes out under the desk's name and stops the response clock, `notify`/`escalate`
  reach staff through the same sink rules use, and the rules are deliberately
  **not** re-run — an explicit instruction must not be outvoted by automation.
  Writing, retiring and removing one is `rule:manage`, with the whole body on the
  audit chain. Documented in [docs/macros.md](./docs/macros.md).
- `src/app/(desk)/macros/page.tsx` + `src/app/actions/macros.ts` + the ticket's
  **Shortcut** picker (M5) — the **macro console** and the run surface: macros
  read back as sentences with their hazards said out loud, a form that serves
  both add and edit, and a one-click run on the ticket the agent is looking at.
- `src/lib/knowledge-rules.ts` + `knowledge-service.ts` + `knowledge-store-prisma.ts`
  (M5) — the **knowledge base**: public/private articles and a pure suggestion
  engine that matches a query's words against the title, then its tags, then its
  body (stopwords dropped), so the same query always yields the same list. A
  `PRIVATE` article is never handed to a requester's path — the rules function
  enforces it, not the caller — and a private article becoming public is audited
  as its own `knowledge.publish` event. Documented in
  [docs/knowledge.md](./docs/knowledge.md).
- `src/components/ArticleSuggestions.tsx` + the create-form search box (M5) —
  **self-service deflection**: the portal's new-request page runs the public
  article search from the words a requester types, shows the matches in full via
  a `<details>` element (no JavaScript) and keeps the text in the subject field,
  so looking costs nothing if the articles do not help. Staff quick-create
  carries the same box with the desk's private articles included.
- `src/app/(desk)/knowledge/page.tsx` + `src/app/actions/knowledge.ts` (M5) —
  the **knowledge console**: every article with its public/staff-only badge, its
  tags and its hazards, a form that serves both add and edit, and a one-click
  publish / make-staff-only.
- `csatDashboard` / `csatByGroup` in `src/lib/csat-rules.ts` and
  `findKnowledgeGaps` / `buildKnowledgeGapReport` in `src/lib/knowledge-rules.ts`
  (M5) — the **reporting** the milestone closes on, rendered as two sections of
  [`/reports`](./src/app/(desk)/reports/page.tsx). The satisfaction dashboard
  shows the whole scale rather than an average (one 1 and one 5 also average 3),
  the response rate beside it, the answers split by the agent who earned them
  worst-first, and the words people typed. The gap report clusters the subjects
  that matched **no article** by the words they share and puts a **repeat
  requester** first, because that is the loudest signal an article is missing; a
  staff-only article still counts as an answer, so the finding is "publish it",
  not "write it". Both reductions run over records the product already writes,
  through the same pure suggestion engine the portal uses. Documented in
  [docs/reporting.md](./docs/reporting.md).
- `src/lib/public-api-rules.ts` + `public-api-service.ts` +
  `public-api-store-prisma.ts` + `public-api-http.ts` (M6) — the **public API's
  front door**: scoped bearer tokens, a sixty-second rate window per token, and a
  pure gate whose order (present, valid, under budget, scoped) is the security.
  A token is a hash in the database and a string on exactly one screen, and it can
  never mint another token — a credential that can re-issue itself after
  revocation removes the one remedy revocation exists to provide. A token also
  carries the *least* role that could serve its scopes, so an integration can
  never do something an agent could not. Documented in
  [docs/api.md](./docs/api.md).
- `src/app/api/v1/**` (M6) — the **versioned REST API**: `GET`/`POST
  /api/v1/tickets`, `GET /api/v1/tickets/:id`, token administration at
  `/api/v1/tokens`, and webhook subscriptions and the delivery log at
  `/api/v1/webhooks*`. The version is in the path because it is what a caller
  bookmarks and greps a log for; reads page by cursor rather than page number;
  and a write goes through `TicketService`, so an API-created ticket fires the
  desk's rules, lands on the tenant's hash chain with `api-token:<id>` as its
  actor, and appears in the inbox exactly as one raised by a person would.
- `src/lib/webhook-rules.ts` + `webhook-service.ts` + `webhook-store-prisma.ts`
  (M6) — **webhooks with a delivery log**: a destination is checked once, at
  registration (`https`, or `http` only on loopback), every delivery is signed
  `HMAC-SHA256(secret, "{timestamp}.{body}")` with the timestamp first so a replay
  is refusable, and the row is written **before** the attempt so an event that
  arrived while the process was dying is still visible as one that was due.
  Retries back off 30s, 1m, 2m, 4m and then **stop** — `EXHAUSTED` is a terminal
  state with a count, not a silent drop. `POST /api/v1/webhooks/sweep` is what
  reads the clock, and `GET /api/v1/webhooks/deliveries` keeps the exact bytes
  that were signed.
- `src/lib/rmm-rules.ts` + `rmm-service.ts` + `rmm-store-prisma.ts` (M6) — the
  **RMM / monitoring connector**: a failing check opens a ticket and a recovery
  closes it, which is the milestone's exit criterion in one sentence. The table is
  keyed on the *condition* (`source:host:check`) rather than on the vendor's alert
  id, because vendors disagree about whether a re-fire reuses an id — that is what
  makes a recovery find the ticket it belongs to even when its own id is new. A
  repeat is an internal note rather than a second ticket (a check that fails every
  minute for an hour is one outage), a condition that clears and fails again is a
  **new** ticket with its own response clock, and a recovery for a check the desk
  never worked is ignored rather than opened in order to be closed. Closing walks
  the ticket lifecycle's own edges (`NEW → OPEN → CLOSED`, never a shortcut), so an
  auto-closed ticket leaves the trail a person's would. `POST /api/rmm`
  (shared-secret authenticated with `ONTRAK_TIX_RMM_SECRET`, tenant by slug) is the
  HTTP entry point; the requester is the desk's, because a monitoring alert has
  nobody behind it.
- `src/lib/chat-notify-rules.ts` + `chat-notify-service.ts` +
  `chat-notify-store-prisma.ts` (M6) — **Slack and Teams notifications**: the
  audience an integration is not. The URL is checked at registration against the
  hosts Slack and Microsoft actually own (`hooks.slack.com`,
  `*.webhook.office.com`, `outlook.office.com`, `*.logic.azure.com`, with an
  exact-or-suffix host match), so a ticket subject can never be the thing that
  decides where the desk connects next; every value is escaped for its provider's
  parser, because `<!channel>` is a *live* control token in Slack and a requester
  writes the subject, so an unescaped one would page four hundred people from a
  help-desk form; and one `ChatMessage` renders into Slack's Block Kit or Teams'
  `MessageCard`, so a third provider is a renderer rather than a second pipeline.
  Delivery is the *webhook's own* state machine (`applyDeliveryAttempt`, shared
  through a structural type rather than copied), so `DELIVERED`, `RETRYING` with
  the instant of the next try, or `EXHAUSTED` after five means one thing in this
  product whatever the destination. A channel's URL is a credential, so it is never
  written to the audit trail, which records the name and the provider instead.
- `src/app/(desk)/admin/integrations/page.tsx` + `src/app/actions/integrations.ts`
  + `src/lib/integration-console-rules.ts` (M6) — the **integrations console**:
  mint and revoke API tokens, register,
  rotate, disable and remove webhook endpoints, read the delivery log with its
  attempt count and next try, sweep what is due without waiting for the schedule,
  register the Slack and Teams rooms, post a test message into one (the only way
  to find out that a chat webhook URL pasted slightly wrong — which fails
  *silently*, because nobody notices a message that never arrived), and see which
  monitored conditions are open and which ticket each became. Gated
  on `tenant:manage`. The two readable-once secrets — a minted token and a webhook
  signing secret — are handed to the page in a short-lived, path-scoped
  `httpOnly` cookie and put away by a button, because a secret in a query string
  ends up in browser history and every proxy log between here and the browser.
- `scripts/verify-packet.ts` (`npm run verify:packet`) — the **offline packet
  verifier** (M3): a third party holding only a packet and the key can check it,
  importing the packet rules, the signer and the verifier and nothing else — no
  Prisma, no session, no network.
- `src/components/IdentityConnectionForm.tsx` +
  `src/app/(desk)/admin/identity/page.tsx` + `src/app/actions/identity.ts` — the
  identity admin UI (M2): an administrator configures the tenant's IdP, its
  scopes, allowed domains, role mappings, MFA and SCIM posture, and reads back the
  redirect URI to register at the provider. Gated on `tenant:manage`; the client
  secret is reported as configured or not, never displayed.
- `prisma/schema.prisma` — the data model (tenant, users, clients, contacts,
  queues, SLA policies, the ticket with its SLA fields, its messages,
  attachments, CSAT responses, canned responses, ticket links, notifications,
  normalized security alerts with their alert verdicts, suppression rules and
  promotion decisions, the tenant IdP connection, incidents with their
  append-only timeline and their playbook steps, evidence items, custody entries,
  legal holds and stored artifacts under object lock, their notification duties
  with the notice text that went out and their post-incident review with its
  tracked actions, the tenant's own incident notice templates, the desk's clients
  with their contacts, their staff assignments, their acted-as windows, their rate
  cards and their surveys, the time entries those rates priced, and the
  hash-chained audit event, the desk's M5 automation rules with the tags a rule
  can apply, the M5 macros an agent runs by hand, and the M5 knowledge articles
  offered to requesters before they raise a ticket).

Run the tests with:

```bash
npx tsx --tsconfig tests/tsconfig.json --test ontrak-tix/tests/*.test.ts
```

`tix.test.ts` covers the pure M0 rules; `tix-app.test.ts` covers the Prisma
adapters (against a fake client), the session rules, the inbox view model and
the rendered inbox components; `tix-ingestion.test.ts` covers password hashing,
the auth store, the email worker, the inbound mail transport and the webhook
plumbing; `tix-m1.test.ts` covers the SLA engine, queue routing, CSAT and
attachments (rules, services and the first-response stamping);
`tix-m1-canned-links-notifications.test.ts` covers canned responses, ticket
links/merge, notifications and the SLA inbox filters; `tix-m1-report-export.test.ts`
covers the CSV export and report snapshot; `tix-m1-bulk-notifications.test.ts`
covers bulk inbox actions, notification preferences and the rendered worklist /
notification list; `tix-saved-views.test.ts` covers the saved-view rules,
service access and the rendered chip strip; `tix-m2-telemetry.test.ts` covers
the security-telemetry rules, ingest idempotency and its Prisma adapter;
`tix-m2-promotion.test.ts` covers alert promotion, suppression and
false-positive tracking; `tix-m2-connector.test.ts` covers the per-vendor
connector and its webhook/poll seams; `tix-m2-identity.test.ts` covers the IdP
connection rules, sign-in/role mapping, SCIM planning and their adapters;
`tix-m2-sso.test.ts` covers the OIDC rules and client, the alert triage
renderer and the polled source; `tix-m2-sso-local-idp.test.ts` runs the whole
handshake against a **real** test identity provider (see
[tests/support/local-idp.ts](./tests/support/local-idp.ts)) — discovery, the
authorize redirect, PKCE-verified code exchange, and `jose` verifying the ID
token's signature against the provider's JWKS — plus the refusals: a replayed
code, a wrong verifier, a token signed with an unpublished key, a wrong nonce, and
claims the tenant's own config forbids; `tix-m3-incidents.test.ts` covers the incident
severity matrix, phase ladder, roles and timeline; `tix-m3-playbooks.test.ts`
covers playbook planning and step transitions, evidence validation, the chain of
custody, legal hold and retention, manifest determinism, the docs service and its
Prisma adapter, and the rendered incident console; `tix-m3-comms.test.ts` covers
the incident communication drafts (placeholders, regime selection, readiness,the M1 bridge and the rendered duty panel), plus authoring and retirement of the
desk's own drafts; `tix-m3-retention.test.ts` covers the
retention sweep's planning, the service that carries it out (bytes, tombstones,
timeline, audit, dry runs, tenant scoping) and the Prisma worklist query;
`tix-m3-assurance.test.ts`
covers the packet's digests and signature, offline verification, completeness and
the export that records itself; `tix-m4-clients.test.ts` covers the SLA ladder's
client and queue rungs and the rung it reports, the client scope, the act-as
guardrails and lifecycle, client/contact validation, the service's refusals and
their audit events, the refusal a write gets for a client the actor does not
serve, a ticket that keeps the client it was raised for, and the Prisma mappers
(including that the client reaches the row); `tix-m4-sla-authoring.test.ts` covers
writing a promise (validation, hour presets, edits that keep their scope, the
refusal to delete one tickets depend on); `tix-m4-time.test.ts` covers rate
ladders, per-entry rounding, invoice lines and totals, the frozen-after-invoicing
rule, the invoice CSV and its adapter; `tix-m4-client-reporting.test.ts` covers
per-client attainment and CSAT, the per-client CSV, and the client-facing survey's
period rules, one-answer-per-link and audit trail; `tix-m5-rules.test.ts` covers
the rules engine, its dry run and its console, and
`tix-m5-rule-intake.test.ts` / `tix-m5-macros.test.ts` cover what a rule and a
macro do to a *stored* ticket — including that a macro is attributed to the agent
and does not re-run the rules; `tix-m5-knowledge.test.ts` covers the knowledge
base's validation, its stopword/word split, the title→tag→body weighting, the
public/private boundary on both suggestion paths and the publish-versus-edit
audit events; `tix-m5-csat-knowledge-reporting.test.ts` covers the satisfaction
distribution over an empty scale, the per-agent response rate and worst-first
order, and the gap clustering — transitivity, the repeat flag, the private
article that counts as an answer and the empty report; `tix-db.test.ts`
exercises the real Prisma store and hash-chained audit against Postgres, and the
retention sweep against real Postgres plus real files on disk (a held artifact
survives, the rest are purged, the chain still verifies), skipping cleanly when
no database is reachable; `tix-m6-public-api.test.ts` covers the API's gate and
its order, the rate window's arithmetic and the tokens that cannot read back their
own secret; `tix-m6-webhooks.test.ts` covers the URL rules, the signed string, the
retry schedule and the delivery state machine; `tix-m6-rmm.test.ts` covers the
monitoring connector's five outcomes, the lifecycle edges an auto-close walks, and
the condition key that survives a vendor minting a fresh alert id;
`tix-m6-chat-notify.test.ts` covers the provider-host policy (including a host that
merely contains the provider's name), the escaping that keeps `<!channel>` out of a
room, both renderings of one message, the shared retry state machine, and a channel
removed while a retry was pending.

The Tix surfaces have a browser sweep too — opt-in, because it needs the app
running:

```bash
ONTRAK_TIX_BASE_URL=http://127.0.0.1:3001 npm run test:e2e:tix
```

It runs the strict axe rule set over the staff surfaces (`/inbox`, `/reports`,
`/notifications`, `/canned`, `/templates`, `/rules`, `/macros`, `/knowledge`,
`/inbox/new`, `/security`, `/incidents`, `/incidents/templates`, `/clients`),
checks the template prefill
end-to-end, checks the M5 satisfaction and knowledge-gap sections are on
`/reports`, writes a macro and runs it on a ticket, promotes a security alert,
declares an incident and downloads its manifest, walks a chain of custody through
a hand-off and a legal hold and downloads the signed packet (asserting the record
digest is stable across exports while the packet digest moves), tracks a
regulatory clock and records the drafted notice onto it, writes a notice draft of
its own at `/incidents/templates` and records a notice from it, records a client
with its promise ladder and a contact and looks through its eyes at `/clients`
(then checks the client is in scope only for the agents assigned to it, files a
ticket for a client nobody serves and confirms the other agent's worklist has no
such ticket and its own URL answers 404), logs time
on a ticket and issues the invoice that freezes it (checking the CSV is a read
that cannot bill twice), asks a client for a rating and answers it from the public
link, confirms a requester cannot reach the worklist, and — as an administrator —
audits `/admin/identity` and confirms a desk agent is turned away from it. It also
mints an API token at `/admin/integrations` (checking the secret is shown once and
then hidden, and that the row keeps the prefix and never the secret), registers a
webhook endpoint with a signing secret, refuses a plain-`http` destination with the
rule named, sweeps what is due, revokes the token and removes the endpoint, and
confirms a desk agent is turned away from that page too.

The SSO routes have a live test too, which is the honest answer to "does single
sign-on work?" — it boots the test provider, writes a real `IdentityConnection`,
and drives the app's own routes over HTTP:

```bash
ONTRAK_TIX_BASE_URL=http://127.0.0.1:3001 \
  npx tsx --tsconfig tests/tsconfig.json --test ontrak-tix/tests/tix-m2-sso-live.test.ts
```

The scheduled retention sweep has one for the same reason — it POSTs to the
running app as a cron would, and asserts that the app removed a real file from
its own evidence directory and recorded why:

```bash
ONTRAK_TIX_BASE_URL=http://127.0.0.1:3001 ONTRAK_TIX_CRON_SECRET=… \
  npx tsx --tsconfig tests/tsconfig.json --test ontrak-tix/tests/tix-m3-retention-live.test.ts
```

The scheduled **SLA sweep** has one too: it provisions two throwaway desks whose
tickets are past their response and resolution promises, then POSTs to
`/api/sla/sweep` and asserts that the rung was raised on the right clock for the
right desk only, that it is on the audit chain, and that a second run raises
nothing:

```bash
ONTRAK_TIX_BASE_URL=http://127.0.0.1:3001 ONTRAK_TIX_CRON_SECRET=… \
  npx tsx --tsconfig tests/tsconfig.json --test ontrak-tix/tests/tix-m1-sla-sweep-live.test.ts
```

Unlike the other two it never omits `?tenant=`: an unscoped run would sweep every
tenant in the database, including the demo one.

See [ROADMAP.md](./ROADMAP.md) for the full milestone sequence.

## Documentation

- [ROADMAP.md](./ROADMAP.md) — vision, architecture, milestones, backlog, risks.
- [docs/email-intake.md](./docs/email-intake.md) — connecting a mail source
  (provider webhook or IMAP poll) and what the pipeline records.
- [docs/sla.md](./docs/sla.md) — how the SLA engines and escalation sweep work,
  and how to schedule the sweep.
- [docs/security-telemetry.md](./docs/security-telemetry.md) — how security
  alerts are normalized, deduped, enriched and promoted on the way in, and how
  a vendor connects.
- [docs/identity.md](./docs/identity.md) — the tenant IdP connection, sign-in
  gating and role mapping, SCIM provisioning, and the OIDC single sign-on flow.
- [docs/incidents.md](./docs/incidents.md) — the incident severity matrix, the
  lifecycle phases, incident roles, the append-only timeline, playbooks, evidence
  with its chain of custody and legal hold, and the signed Assurance Packet.
- [docs/clients.md](./docs/clients.md) — the clients a desk serves, the SLA
  ladder's client rung and its queue rung, the scope that keeps two clients
  apart, the guardrails on acting as a client, per-client branding and portal
  identity, per-client reporting, and the client-facing survey.
- [docs/billing.md](./docs/billing.md) — time entries, rate cards and their
  rounding, tax rules and the credit notes that reverse an invoice, retainers and
derived balances, one invoice per currency, and why issuing an invoice and
  downloading it are two steps.
- [docs/rules.md](./docs/rules.md) — automation rules: what a rule may be, when
  it fires on intake, and the console that previews it before it is switched on.
- [docs/macros.md](./docs/macros.md) — macros: the agent-run counterpart to a
  rule, what running one changes, and how a run is attributed and audited.
- [docs/knowledge.md](./docs/knowledge.md) — the knowledge base and deflection:
  public versus staff-only, how a suggestion is scored, and where it appears.
- [docs/api.md](./docs/api.md) — the public REST API: versions and prefixes,
  scoped tokens and why one cannot mint another, the rate window and its headers,
  the endpoints, webhooks with their signature scheme, retry schedule and delivery
  log, the integrations console, the monitoring webhook a check fails into, and
  the Slack/Teams channels — which are not part of the public API, and are
  documented there because they consume the same events.
- [docs/reporting.md](./docs/reporting.md) — the satisfaction dashboard (the
  whole scale, the response rate, the agents, the words) and the knowledge-gap
  report (how subjects cluster, what counts as an answer, why repeats sort
  first).
- [docs/handoff.md](./docs/handoff.md) — the rota, on-call windows and the
  coverage gaps they leave, on-call load per person, and the handoff record that
  names the work still open.

## Relationship to OnTrak IT Support Training

The two products are designed to complement each other:

- **Shared design language.** Both use a Next.js + React + Prisma + PostgreSQL
  stack and the same UI conventions, so one component library can serve both.
- **Ticket ↔ scenario bridge.** A solved onboarding scenario can be exported as
  a knowledge-base article; a real ticket can be redacted into a training
  scenario.
- **Embedded training.** OnTrak Tix onboarding checklists can assign training
  scenarios and track completion, so new hires practice on the same workflows
  they will run for real.
- **Single identity.** Both can sit behind the same SSO/SCIM provider.
