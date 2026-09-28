# OnTrak Tix

An **enterprise ticketing and service-management platform** for internal IT
service desks and Managed Service Providers (MSPs). OnTrak Tix tracks every
request, incident, change and problem from intake to closure, enforces SLAs,
coordinates multi-client work for MSPs, and is the system of record for the
people, assets and processes behind IT support.

It is part of the [Innotel Labs](../INNOTEL-LABS.md) family, alongside
[OnTrak IT Support Training](../README.md): the training product **trains** the
technicians, OnTrak Tix is the tool they **work in**.

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

**M0–M2 complete; M3 in progress.** The foundations have landed:

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
  `postcss.config.mjs`, `docker-compose.yml`, `.env.example` — the standalone
  project scaffold, so the shell runs on its own.

### Running the app

```bash
cd ontrak-tix
cp .env.example .env      # set DATABASE_URL and TIX_AUTH_SECRET
npm install
npm run docker:db         # or point DATABASE_URL at your own Postgres
npm run setup             # prisma generate, db push, then seed the demo tenant
npm run dev
```

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
  digest.
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
  tracked actions, and the hash-chained audit event).

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
the incident communication drafts (placeholders, regime selection, readiness, the
M1 bridge and the rendered duty panel); `tix-m3-assurance.test.ts`
covers the packet's digests and signature, offline verification, completeness and
the export that records itself; `tix-db.test.ts`
exercises the real Prisma store and hash-chained audit against Postgres,
skipping cleanly when no database is reachable.

The Tix surfaces have a browser sweep too — opt-in, because it needs the app
running:

```bash
ONTRAK_TIX_BASE_URL=http://127.0.0.1:3001 npm run test:e2e:tix
```

It runs the strict axe rule set over the staff surfaces (`/inbox`, `/reports`,
`/notifications`, `/canned`, `/templates`, `/inbox/new`, `/security`,
`/incidents`), checks the template prefill end-to-end, promotes a security alert,
declares an incident and downloads its manifest, walks a chain of custody through
a hand-off and a legal hold and downloads the signed packet (asserting the record
digest is stable across exports while the packet digest moves), tracks a
regulatory clock and records the drafted notice onto it, confirms a
requester cannot reach the worklist, and — as an administrator — audits
`/admin/identity` and confirms a desk agent is turned away from it.

The SSO routes have a live test too, which is the honest answer to "does single
sign-on work?" — it boots the test provider, writes a real `IdentityConnection`,
and drives the app's own routes over HTTP:

```bash
ONTRAK_TIX_BASE_URL=http://127.0.0.1:3001 \
  npx tsx --tsconfig tests/tsconfig.json --test ontrak-tix/tests/tix-m2-sso-live.test.ts
```

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
