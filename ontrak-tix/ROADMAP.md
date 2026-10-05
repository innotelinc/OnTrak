# OnTrak Tix — Product & Engineering Roadmap

> Status legend: `[x]` done · `[~]` in progress · `[ ]` planned · `[-]` out of scope for v1
>
> This file is the single source of truth for **what** we are building and in
> **what order**. It is deliberately opinionated; each milestone lists explicit
> exit criteria so "done" is not a matter of taste.
>
> **OnTrak family release 2026.09** ([portfolio](../INNOTEL-LABS.md)): this
> product's slice of it is **M6 — platform & integrations**, shipped; the
> others are **OnTrak IT Support Training v1.2** and **OnTrak Sentinel S3**.

---

## 1. Vision

Give an internal IT desk or an MSP one system that runs the whole life of a
ticket — intake, triage, assignment, SLA, work, knowledge, billing, and
reporting — with multi-client isolation and automation built in, not bolted on.
And when something goes wrong, produce a **tamper-evident record of the incident
and the response** that stands up to auditors, insurers and regulators.

**Positioning:** lighter to run than an enterprise ITSM suite, far more capable
than a shared inbox. The default choice for a 5–200 person IT operation.

## 2. Problem & opportunity

| Today's reality | Consequence |
| --- | --- |
| Requests arrive by email/chat/phone and live in inboxes | Lost work, no history, no SLA |
| SLAs tracked by hand or not at all | Breaches found after the fact |
| MSP work scattered per client | No single view of obligations or billing |
| Knowledge walks out the door | Repetition, slow onboarding |
| Reporting is a spreadsheet export | No trend data, no forecasting |
| Incident response is ad hoc; the timeline is rebuilt from memory afterwards | Slow response, and no defensible record |
| Security alerts live in IDS/IPS/SIEM consoles, not the service desk | Incidents missed or worked twice |
| Insurance and audit requests take weeks of archaeology | Late, incomplete, inconsistent evidence |

OnTrak Tix closes all five with one lifecycle, one SLA engine, and one
multi-client data model.

## 3. Personas

- **Requester / end user** — the employee or client contact who raises a ticket.
- **Agent (L1/L2/L3)** — works queues, updates tickets, logs time.
- **Dispatcher / team lead** — routes, balances load, watches SLA risk.
- **MSP account manager** — owns client relationships, SLAs, and billing.
- **Administrator** — configures tenants, queues, rules, integrations, security.
- **Compliance / auditor** — reads immutable history and access logs.
- **Security / incident-response lead** — runs incidents and owns detection coverage.
- **Insurance & compliance liaison** — assembles evidence packets and audit responses.

## 4. Scope

**In scope for v1**
Ticket lifecycle; queues & routing; SLA engine; multi-client tenancy; contacts &
companies; notifications; knowledge base; canned responses & macros; time
tracking; CSAT; reporting; REST API; email ingestion.

**Newly first-class (driven by incident response & insurance needs)**
Identity (IdP: OIDC/SAML SSO, SCIM, MFA); security-telemetry ingest (IDS/IPS,
SIEM, EDR, network sensors); incident response & playbooks; evidence collection
with chain of custody; audit-grade immutable history; insurance/audit evidence
export.

**Explicit non-goals for v1**
Full ITIL change/release governance; native remote-control/RMM agent; full
accounting suite; on-prem-only distribution; custom per-tenant code. We **ingest**
telemetry from IDS/IPS/SIEM/EDR — we do not replace those sensors or act as one.
OnTrak Tix records facts; it does not give legal advice or adjudicate liability.

## 5. Architecture at a glance

Chosen to match the sibling OnTrak IT Support Training stack so components, patterns and
reviewers carry over.

- **App:** Next.js (App Router) + React + TypeScript, server actions for
  mutations, same `*-rules.ts` pure-logic convention as OnTrak IT Support Training.
- **Data:** PostgreSQL + Prisma; every domain row carries `tenantId`.
- **Queue/async:** Redis + BullMQ for email ingestion, SLA timers, notifications,
  webhook delivery, and scheduled reports.
- **Realtime:** server-sent events (or a WebSocket gateway) for live queue and
  ticket updates.
- **Search:** PostgreSQL full-text first; OpenSearch/Meilisearch as scale demands.
- **Files:** S3-compatible object storage for attachments.
- **Auth / IdP:** JWT sessions (jose) with SSO (OIDC/SAML), SCIM provisioning and
  enforced MFA; every authentication and privilege event is audited.
- **Security telemetry:** a normalizing ingest pipeline that folds IDS/IPS, SIEM,
  EDR and network-sensor alerts into one alert/incident stream (dedupe, enrich,
  link to assets and identities).
- **Evidence store:** append-only object storage with **object-lock (WORM)**
  retention for evidence and exported packets.
- **Tamper-evident audit:** hash-chained, append-only audit log with signed
  checkpoints, so history cannot be quietly edited.
- **Deploy:** containerized; single-tenant and hosted multi-tenant from one image.

```
  intake ──▶ normalize ──▶ ticket ──▶ rules engine ──▶ queue ──▶ agent work
   ▲            │             │            │                        │
 email/       dedupe        audit        SLA timer               time/notes
 portal/      + merge       trail        + escalations           + KB
 API/chat
```

## 6. Tenancy & core data model (first cut)

- `Tenant` → top-level isolation boundary (an MSP, or one internal IT dept).
- `Client` (Company) → a customer within a tenant; MSPs have many.
- `Contact` → a person at a client; requesters and CCs.
- `User` (staff) → agent/admin/dispatcher; tenant-scoped roles.
- `Queue` → worklist with routing rules and SLA policy.
- `Ticket` → type, status, priority, queue, assignee, requester, client, SLA
  clocks, tags, custom fields.
- `Message` → the immutable conversation thread (email, portal, note, system).
- `Attachment`, `TicketLink` (parent/child/related/duplicate).
- `SlaPolicy` / `SlaInstance` → targets, business calendars, breach state.
- `TimeEntry` → agent time, billable flag, rate.
- `KnowledgeArticle`, `CannedResponse`, `Macro`.
- `Asset` / `CmdbItem` → optional link from tickets to affected assets.
- `AutomationRule` → trigger → conditions → actions.
- `AuditEvent` → append-only and **hash-chained** (each event references the
  prior hash); never updated, never deleted.
- `IdentityConnection` → a tenant's IdP (OIDC/SAML) plus SCIM and role-mapping config.
- `SecurityAlert` → a normalized alert from IDS/IPS/SIEM/EDR (source, severity,
  dedupe key, raw-payload ref, linked ticket/incident).
- `Incident` → severity, commander, state, playbook, affected assets/identities,
  regulatory/reporting flags.
- `IncidentTimelineEntry` → auto and manual entries, each with actor + timestamp.
- `Playbook` / `PlaybookStep` → repeatable response procedures.
- `EvidenceItem` → collector, collected-at, cryptographic hash, storage ref.
- `ChainOfCustodyEntry` → every transfer of an evidence item.
- `RetentionPolicy` / `LegalHold` → retention windows with hold overrides.
- `AssurancePacket` → a generated, signed export bundle for insurers and auditors.

## 7. Compliance, Evidence & Assurance (cross-cutting)

This pillar applies to **every** milestone, not only incident response. The aim
is a complete, honest, machine-timestamped record of what was known, decided and
done — evidence of due diligence, not a favourable narrative. Adjusters,
auditors and regulators reward completeness and consistency, so the record has
to stand on its own.

**Principles**

- **Contemporaneous, not reconstructed.** The timeline is built as work happens
  (ticket and incident events, approvals, alerts, logins), not written from
  memory afterwards. Later corrections are *new* entries, never rewrites.
- **Tamper-evident.** The audit log is append-only and hash-chained; periodic
  signed checkpoints make retroactive edits detectable.
- **Attributable.** Every entry names the actor (human or system), the source and
  the time — and reads of sensitive data are themselves audited.
- **Immutable retention.** Evidence and exported packets live in object-locked
  (WORM) storage; legal hold overrides routine retention and purge.
- **Chain of custody.** Each evidence item carries its collector, timestamp,
  cryptographic hash, storage location and every subsequent transfer.
- **Exportable.** One **Assurance Packet** bundles the incident timeline,
  decisions, approvals, evidence manifest, access logs and the policy versions
  in force — signed and reproducible for an insurer or auditor.
- **Privacy-respecting.** Redaction, least-privilege access and data-subject
  request handling are built in, so evidence work never creates a new liability.

**Anti-goals**

- No "blame score" and no automated fault assignment. The system records facts
  and decisions; people and process interpret them.
- No silent edits, backdating, or deletion of history — ever.

## 8. Milestones

### M0 — Foundations & intake `[x]`
**Goal:** a ticket can arrive, be stored, and be seen by an agent.

- Tenant model, auth, RBAC (admin/dispatcher/agent/requester) in middleware *and*
  every server action.
  - `[x]` RBAC + tenant isolation, pure and unit-tested (`src/lib/access-rules.ts`).
  - `[x]` Tenant-scoped session rules: claims validation and the actor they
    resolve to (`src/lib/session-rules.ts`), plus the cookie/JWT plumbing
    (`src/lib/session.ts`).
  - `[x]` Local sign-in: scrypt password hashing (`src/lib/password.ts`), a
    structural user lookup (`src/lib/auth-store.ts`), a sign-in action/page and
    an idempotent seed with one account per role (`prisma/seed.ts`). SSO moves
    to the OnTrak Sentinel IdP at M2.
- Core ticket CRUD + immutable conversation thread and audit trail.
  - `[x]` Status machine, validation, append-only conversation, ticket refs
    (`src/lib/ticket-rules.ts`).
  - `[x]` Hash-chained, append-only, per-tenant audit log with tamper detection
    (`src/lib/audit-chain.ts`).
  - `[x]` Ticket service: pure create/reply/status/assign plans plus a
    `TicketService` that persists through a store port and emits an audit event
    per mutation (`src/lib/ticket-service.ts`).
  - `[x]` Prisma persistence: `PrismaTicketStore` and a durable, per-tenant
    hash-chained `PrismaAuditSink` with pure row/record mappers
    (`src/lib/ticket-store-prisma.ts`), and a `configureTickets` factory
    (`src/lib/ticket-server.ts`). Tested against a fake client; exercised
    against Postgres once the tix app project is scaffolded.
  - `[x]` Server actions for create/reply/status/assign, each starting from
    `requireActor()` (`src/app/actions/tickets.ts`).
  - `[x]` A signed-in desk shell with navigation and sign-out (`src/app/(desk)/`).
- Email ingestion (inbound address → parsed ticket; threading via references).
  - `[x]` Parse/normalize/suppress/classify/thread/dedupe
    (`src/lib/intake-rules.ts`).
  - `[x]` Retry-safe ingest decision behind `ONTRAK_TIX_EMAIL_INGESTION`
    (`src/lib/intake-service.ts`).
  - `[x]` The worker that carries a message through the ingest plan: resolves
    the sender to a requester, creates or appends through the ticket service,
    and records the message in an `InboundMessage` intake ledger so retries are
    no-ops (`src/lib/email-worker.ts`).
  - `[x]` The transport that hands the worker bytes is in place: one neutral
    `MailboxMessage` shape fed from a provider webhook (`WebhookTransport`) or a
    polled mailbox (`MailboxPoller` over a `MailboxSource`, with an
    `ImapMailboxSource` adapter), acknowledging handled mail so a crash mid-batch
    retries rather than loses it (`src/lib/email-transport.ts`).
  - `[x]` The webhook entry point and operator guide:
    `POST /api/intake/email` authenticates a shared secret, resolves the tenant
    and feeds the transport, with status-code policy kept pure and tested
    (`src/lib/intake-webhook.ts`, `docs/email-intake.md`).
- Web portal for requesters to raise and follow tickets.
  - `[x]` Requester portal: my tickets, raise a request, follow the thread
    (`src/app/(desk)/portal/`), scoped by `canReadTicket`, with reply-only
    actions plus attachments and a CSAT survey (below).
- Ticket list + detail UI with filters and bulk actions.
  - `[x]` Inbox filtering, ordering and counts, pure and tested
    (`src/lib/inbox-rules.ts`).
  - `[x]` The list/detail UI: an inbox view model (`src/lib/inbox-view.ts`),
    presentational `AgentInbox`/`TicketDetail`/`TicketList` components and the
    `/inbox` pages that mount them.
  - `[x]` Bulk actions from the inbox: a selection form (no JS required) that
    assigns or changes status on many tickets at once, with pure selection and
    summary rules (`src/lib/bulk-rules.ts`) so skipped tickets and their reasons
    are reported honestly.
  - `[x]` Saved views: named, shareable inbox filters (`src/lib/saved-view-rules.ts`,
    `saved-view-service.ts`, `saved-view-store-prisma.ts`) as a chip strip above
    the worklist. A view is private to its owner unless shared, and only the
    owner or an admin may remove it; the filter is re-sanitized on read.
  - `[x]` The inbox is a staff view: a requester who reaches `/inbox` (or
    `/inbox/[id]`) is redirected to the portal, so the tenant worklist is never
    exposed by URL — closing a gap the portal's per-ticket scoping already
    assumed.
- Standalone project scaffold so the shell runs on its own.
  - `[x]` `package.json`, `tsconfig.json`, `next.config.ts`, PostCSS/Tailwind
    entry, `docker-compose.yml`, `.env.example` and the Prisma client bootstrap
    (`src/lib/db.ts`). Run against Postgres once dependencies are installed.
- **Exit:** an email to the support address creates a ticket visible in the
  portal and agent inbox; every mutation is audited; tenant isolation is tested.

> M0 progress: the pure rules, the M0 schema, Prisma persistence + audit
> emission, the tenant-scoped session and local sign-in with a seed, the inbox
> app shell, the requester portal, the email worker, the inbound mail transport
> (webhook + polled mailbox) with its HTTP entry point, and the standalone
> project scaffold have landed. Covered by `ontrak-tix/tests/tix.test.ts`,
> `tix-app.test.ts`, `tix-ingestion.test.ts` and `tix-db.test.ts`. The app
> builds, and the Prisma store, audit chain and hash-chain verification are
> exercised against a real Postgres by `tix-db.test.ts` (which skips cleanly
> when no database is reachable).
>
> M2 progress: the security-telemetry pipeline has landed end to end — the
> normalizing rules, the at-least-once ingest service and its Prisma adapter
> (`security-alert-rules.ts`, `security-alert-service.ts`,
> `security-alert-store-prisma.ts`), the per-vendor connectors with their
> webhook and poll seams (`security-alert-connector.ts`) and the alert →
> ticket promotion rules and service (`alert-promotion-rules.ts`,
> `alert-promotion-service.ts`, `alert-promotion-store-prisma.ts`). Covered by
> `ontrak-tix/tests/tix-m2-telemetry.test.ts`, `tix-m2-promotion.test.ts` and
> `tix-m2-connector.test.ts`, and documented in `docs/security-telemetry.md`.
> The IdP slice has landed as pure rules plus a service and a Prisma adapter
> (connection config, issuer/domain/MFA gates, group→role mapping, and a SCIM
> create/update/deactivate plan) in `src/lib/identity-rules.ts`,
> `identity-service.ts` and `identity-store-prisma.ts` with the
> `IdentityConnection` model, covered by `ontrak-tix/tests/tix-m2-identity.test.ts`.
> SSO is wired end to end: the pure OIDC rules and the client
> (`oidc-rules.ts`, `oidc-client.ts`), the signed authorization-state cookie and
> the `/api/sso/start` + `/api/sso/callback` routes. The alert stream also has a
> triage console (`/security`, with promotion, false-positive verdicts and
> suppression rules) and a scheduled poll entry point
> (`POST /api/security/poll`). Documented in `docs/identity.md` and
> `docs/security-telemetry.md`; covered by `tix-m2-sso.test.ts`. The
> connection-administration UI has landed as `/admin/identity`, so M2's IdP
> slice is complete apart from SAML, which is stored and refused rather than
> half-implemented. SSO is no longer only unit-tested: `tix-m2-sso-local-idp.test.ts`
> drives the whole handshake against a real test provider (discovery, the
> authorize redirect, PKCE, and `jose` verifying the ID token against the JWKS,
> plus the refusals), and `tix-m2-sso-live.test.ts` — opt-in, like the browser
> sweep — runs it through the app's own routes against a running server and a real
> `IdentityConnection`, asserting the session, the provisioned user and the audit
> event.
>
> The IdP slice now has its **other direction** too: the desk pushes its own people
> to the provider over SCIM (`scim-rules.ts`, `scim-client.ts`,
> `scim-sync-service.ts`, `scim-sync-store-prisma.ts`), driven from the
> `/admin/identity` card and pointed with `ONTRAK_TIX_SCIM_BASE_URL` +
> `ONTRAK_TIX_SCIM_TOKEN`. A person is matched by the desk's own account id before
> their address, so a rename moves the provider's identity rather than creating a
> second one; a quiet run writes nothing, so the provider's trail stays a record of
> changes rather than of polling; and roles are deliberately *not* pushed, because
> privilege at the provider is not a side effect of a desk edit. Covered by
> `tix-m2-scim-push.test.ts`, and by the opt-in `tix-m2-scim-live.test.ts`, which
> pushes real people at a real provider and asserts the leaver stops being able to
> sign in. The push also runs **without** anybody pressing the button: `POST
> /api/scim/push` (Bearer-authenticated with `ONTRAK_TIX_CRON_SECRET`, `?tenant=`
> to scope it) and `npm run sweep:scim [-- <slug>] [--dry-run]` are the scheduled
> entry points, covered by the opt-in `tix-m2-scim-sweep-live.test.ts`. Because a
> matched person is a `NOOP`, a quiet sweep writes nothing and can be scheduled as
> often as a cron likes; because an unconfigured deployment answers `503` rather
> than a cheerful zero, a scheduler can tell a run that stopped syncing from one
> with nothing to do; and because the run has no session, its changes are audited
> as `system:scim-sync` so the trail still names who the write belongs to.
>
> M3 progress: the incident lifecycle has landed as pure rules plus a service
> and a Prisma adapter — the impact×urgency severity matrix, the phase ladder
> (with a regression back to `CONTAINED` treated as the same incident), the four
> incident roles with a staffing gate on SEV1/SEV2, and an append-only timeline
> — in `src/lib/incident-rules.ts`, `incident-service.ts` and
> `incident-store-prisma.ts`, covered by
> `ontrak-tix/tests/tix-m3-incidents.test.ts` and documented in
> `docs/incidents.md`. The runbook and evidence slice has landed too: playbooks
> planned by severity with completed/skipped/reopened step tracking
> (`playbook-rules.ts`), evidence items validated and rolled into a
> digest-stable manifest (`evidence-rules.ts`, `incident-docs-service.ts`,
> `incident-docs-store-prisma.ts`), and the `/incidents` console that drives all
> of it — covered by `ontrak-tix/tests/tix-m3-playbooks.test.ts`. The chain of
> custody and legal hold have landed on top of it (`CustodyEntry`, `LegalHold`),
> and so has the one-click signed **Assurance Packet**
> (`assurance-rules.ts`, `assurance-sign.ts`, `assurance-service.ts`,
> `GET /api/incidents/[id]/packet`), covered by
> `ontrak-tix/tests/tix-m3-assurance.test.ts` and proved end to end by the Tix
> browser sweep (a hand-off, a hold, and a packet whose record digest is stable
> across exports). The rest of the slice has landed since: **object-lock (WORM)
> storage** for the artifacts themselves (`object-lock-rules.ts`,
> `object-lock-file.ts`, `EvidenceArtifact`, covered by
> `ontrak-tix/tests/tix-m3-object-lock.test.ts`), the **war-room timeline**
> assembled from the incident log, the audit chain, the alert stream and the
> decisions (`war-room-rules.ts`, `war-room-service.ts`), **notification duties**
> with their regimes and clocks (`regulatory-rules.ts`), the **post-incident
> review** with tracked actions (`review-rules.ts`) and their service
> (`compliance-service.ts`), a **standalone verifier** for a third party
> holding only a packet and the key (`scripts/verify-packet.ts`), and the
> **communications templates** a duty drafts from (`comms-rules.ts`), covered by
> `ontrak-tix/tests/tix-m3-comms.test.ts` (including the desk's own drafts, `IncidentCommsTemplate`
> and `/incidents/templates`), and the **retention sweep** that acts
> on a closed lock without being asked (`planRetentionSweep`,
> `IncidentDocsService.sweepRetention`, `POST /api/incidents/retention-sweep`,
> `npm run sweep:retention`), covered by `ontrak-tix/tests/tix-m3-retention.test.ts`
> and proved against real Postgres and a real filesystem in
> `ontrak-tix/tests/tix-db.test.ts`, the HTTP entry point in
> `ontrak-tix/tests/tix-m3-retention-live.test.ts`. M3 is complete; the honest
> gaps that remain are listed at the end of
> [docs/incidents.md](./docs/incidents.md) — a real object-locked backend,
> scheduling the sweep yourself, and notice-template versioning.
>
> M4 progress (complete): **clients, contacts and
> the scope that keeps two clients apart**. The SLA ladder gained a client rung
> and a queue rung (`SlaPolicy.clientId`/`queueId`, `resolveSlaPolicy` in
> `sla-rules.ts`), most specific first and reporting *which* rung answered, with
> one resolver shared by the inbox flags, the dispatcher report and the
> escalation sweep. The scoping rules, the act-as guardrails and their validation
> are pure in `client-rules.ts`; `client-service.ts` and
> `client-store-prisma.ts` persist the clients, their contacts, who serves them
> and the recorded "act as client" windows (`Client`, `Contact`,
> `ClientAssignment`, `ClientActAsSession`); the console is `/clients`; and the
> inbox worklist is filtered by the reader's client scope before SLA flags, saved
> views and counts are computed, so an agent assigned to two clients never sees a
> third's work. The scope is asked again where a filter would not have been
> enough: every write (reply, status, assign, the bulk toolbar) refuses a ticket
> whose client the actor does not serve, the ticket's own page answers a `404`
> rather than rendering a row the worklist withheld (its links and link picker
> filtered the same way), and the quick-create form offers the clients the actor
> serves so a ticket keeps the client it was raised for. Covered by
> `ontrak-tix/tests/tix-m4-clients.test.ts` and by the Tix browser sweep (which
> records a client, its ladder, a contact and an acted-as window, checks that a
> client appears only for the people assigned to it, and then files a ticket for a
> client nobody serves, confirms the worklist has no such ticket and that
> addressing it by its own URL gets a 404). The desk can write its own promises from the same console
> (`sla-policy-service.ts`), so a client's SLA is authored rather than seeded.
> Time and billing have landed too (`time-rules.ts`, `time-service.ts`,
> `time-store-prisma.ts`, the `/time` ledger and invoicing, rate cards on
> `/clients`), together with per-client attainment and CSAT on `/reports` and a
> client-facing survey a contact can answer without an account. Documented in
> [docs/clients.md](./docs/clients.md) and
> [docs/billing.md](./docs/billing.md). The last M4 slice has landed as well:
> **queue-scoped promises** (a promise belongs to a client *or* a queue, not
> both, and an edit that does not mention the scope keeps it),
> **branding and portal identity** (`client-branding-rules.ts` — the name,
> colour, logo and voice one client is shown in, with the colour checked for
> contrast and the logo restricted to an image the page can render rather than a
> URL it has to trust), **the rota** (`rota-rules.ts`, `rota-service.ts`, the
> `/handoff` page: cover derived from the shifts, the uncovered hours named,
> on-call load per person, and a handover that requires a note and names the work
> still open), and **billing depth** (`billing-rules.ts`: tax resolved
> client-first and snapshotted onto the entries it priced, credit notes capped by
> what an invoice still owes, retainers whose balance is derived from the ledger,
> and one invoice per currency rather than a total that adds dollars to euros).
> Covered by `tests/tix-m4-sla-authoring.test.ts`, `tests/tix-m4-branding.test.ts`,
> `tests/tix-m4-handoff.test.ts` and `tests/tix-m4-billing-depth.test.ts`.
> M4's checklist is complete; the honest gaps that remain are recorded per
> document (no client portal beyond the survey link, no shift-swap approval, no
> accounting-system sync, one tax line per invoice).
>
> M1 progress: the SLA engine (clocks, escalations and the scheduled sweep),
> queue routing, CSAT surveys, attachments, the dispatcher report, canned
> responses, ticket links/merge and escalation notifications have landed as pure
> rules plus thin services, with their schema models, the portal wiring and the
> `/reports`, `/canned` and `/notifications` pages. The inbox also filters by SLA
> at-risk/breached. Covered by `ontrak-tix/tests/tix-m1.test.ts` and
> `tix-m1-canned-links-notifications.test.ts` and
> `tix-m1-report-export.test.ts`, `tix-m1-bulk-notifications.test.ts` and
> `tix-saved-views.test.ts`. The M1 checklist is complete; what remains across
> the roadmap is M2 and beyond.

### M1 — Service desk basics `[x]`
**Goal:** a working desk for one internal team.

- Queues, statuses, priorities, types, assignment and reassignment.
  - `[x]` Pure queue routing (`src/lib/routing-rules.ts`): ordered queues with
    ANDed criteria and keyword matching, an explicit catch-all fall-through, and
    a decision reason; the first match wins.
  - `[x]` A ticket can be created straight into a routed queue (`queueId` on
    create, carried through the store and mappers). Assignment/reassignment
    already shipped at M0.
- SLA engine: policies, business-hours calendars, response/resolution clocks,
  breach + warning states, escalations.
  - `[x]` Pure SLA rules (`src/lib/sla-rules.ts`): fixed-offset business-hours
    calendars with holidays, business-minute addition and measurement, deadline
    computation, response and resolution clocks with `met`/`on-track`/`warning`/
    `breached` states, a roll-up, attainment, and policy selection/validation.
  - `[x]` The first public *agent* reply stamps `ticket.firstResponseAt` — the
    response clock's input; a requester's reply or an internal note never does.
  - `[x]` `SlaPolicy` model (priority-scoped, JSON calendar, warning fraction)
    and `Ticket.slaPolicyId`/`firstResponseAt`; deadlines are derived, not
    stored, so a policy edit applies immediately.
  - `[x]` Escalations: a warning ladder (half the window, near-deadline,
    passed) with widening audiences (`escalation-rules.ts`), applied by an
    idempotent sweep service that raises each rung once under a `dedupeKey`,
    writing an `SlaEscalation` row and an audit event per rung
    (`escalation-service.ts`).
  - `[x]` The scheduled entry point: `POST /api/sla/sweep` (secret-authenticated,
    `ONTRAK_TIX_CRON_SECRET`) sweeps one tenant or all of them. Idempotency means
    a cron can run it as often as it likes — the point being that breaches are
    surfaced *before* they happen.
  - `[x]` The clock is visible where the work is: an `SlaBadge` on the ticket
    detail (inbox and portal) shows the soonest running clock or the breach,
    computed by the same rules the report and the sweep use.
- Notifications: in-app + email digests; per-user preferences.
  - `[x]` Escalation notifications: each rung the sweep raises writes an
    in-app `Notification` addressed to its audience role, and hands an email
    digest to an `EmailSender` port (`src/lib/notification-rules.ts`,
    `notification-service.ts`). Dedupe mirrors the escalation key, so a replayed
    sweep neither double-notifies nor re-mails; a `/notifications` page shows the
    notice and a nav unread count.
  - `[x]` Per-user in-app preferences: a staff member sets a minimum ladder
    level and can mute themselves without losing their role's audience
    (`NotificationPreference`, `notification-preference-store-prisma.ts`); the
    `/notifications` page filters and counts against it.
- Canned responses, internal notes vs public replies, ticket merge/link.
  - `[x]` Internal notes vs public replies (M0).
  - `[x]` Canned responses: pure template rules with `{{ref}}`/`{{subject}}`/
    `{{requester}}`/`{{agent}}` substitution (`src/lib/canned-rules.ts`), a
    staff-guarded CRUD service, a `/canned` library page, and one-click fills in
    the reply composer. Seeded with starter replies.
  - `[x]` Ticket links and merge: a `TicketLink` relation (related/parent/child/
    duplicate) with reciprocal display (`src/lib/link-rules.ts`), and a merge that
    folds a duplicate's conversation into the survivor, closes the duplicate and
    points a `DUPLICATE` link forward — audited, and gated on `ticket:update`
    (`src/lib/link-service.ts`).
- Basic reporting: open/closed, first-response and resolution times, SLA
  attainment.
  - `[x]` Pure report rules (`src/lib/report-rules.ts`): open/closed/unassigned
    counts, response and resolution attainment over the decided clocks, median
    and p90 business-minute timings, and the breached/at-risk lists ordered for
    triage.
  - `[x]` A dispatcher `/reports` page rendering those numbers plus the open
    escalations and the CSAT roll-up.
  - `[x]` Exportable: a pure RFC-4180 CSV serializer (`src/lib/report-csv.ts`)
    and a staff-guarded `GET /reports/export` download, in the report's own
    triage order.
  - `[x]` Scheduled: `POST /api/sla/report` (same cron secret as the sweep)
    builds each tenant's snapshot and writes it to the hash-chained audit log as
    `report.sla.snapshot`, so a weekly attainment figure leaves tamper-evident
    evidence. No email transport yet — it is returned in the response and the
    audit chain is the durable record.
- CSAT (pulled forward from M4) and attachments:
  - `[x]` Pure CSAT rules and service (`src/lib/csat-rules.ts`,
    `csat-service.ts`): a survey is offered once on a resolved ticket, answered
    once by an unguessable token, expires, and rolls up into a response rate and
    positive percentage. Resolving a ticket requests the survey; the requester
    answers it in the portal.
  - `[x]` Pure attachment rules and service (`src/lib/attachment-rules.ts`,
    `attachment-service.ts`): an allow-list of types, size/count limits,
    filename sanitisation, namespaced storage keys; bytes go behind a `BlobStore`
    port (filesystem for local/single-node) and metadata to its own row. A
    rejected batch writes nothing.
- **Exit:** 100% of tickets land in a queue with a running SLA clock; breaches
  are surfaced before they happen; a weekly attainment report renders.

### M2 — Identity & security telemetry `[x]`
**Goal:** trusted identities and one alert pipeline from the security stack.

- IdP integration: OIDC/SAML SSO, SCIM provisioning/deprovisioning, enforced MFA,
  tenant-scoped role mapping; every auth and privilege event audited.
  - `[x]` Tenant IdP config, role mapping and MFA enforcement
    (`src/lib/identity-rules.ts`): connection validation, an
    issuer/domain/MFA gate on the claims, and group→role mapping with a default.
    `IdentityService` (`identity-service.ts`) with `identity-store-prisma.ts` and
    the `IdentityConnection` model configures it, resolves claims to a user
    (creating on first sign-in, updating after), and audits successful
    sign-ins, refusals and role changes.
  - `[x]` SCIM provisioning/deprovisioning and tenant-scoped role mapping:
    `planScimProvision` turns a SCIM user into one create/update/deactivate —
    deactivation immediate and idempotent, a no-change push a `NOOP` — applied
    through the same `User` row and audited.
  - `[x]` The OIDC protocol client and the SSO sign-in routes
    (`src/lib/oidc-rules.ts`, `oidc-client.ts`): discovery validation, an
    authorization request with `state`/`nonce`/PKCE, an ID token verified
    against the issuer's JWKS (`jose`), and the `/api/sso/start` and
    `/api/sso/callback` handlers that turn claims into a Tix session. SAML is
    stored and refused with a clear message rather than half-done.
  - `[x]` The connection-administration UI (`/admin/identity`, gated on
    `tenant:manage`): protocol, issuer, client id, scopes, allowed domains,
    role mappings, MFA and SCIM, with the redirect URI spelled out and the
    client secret reported as configured without ever being shown.
- IDS/IPS, SIEM, EDR and network-sensor ingest: normalize, dedupe, enrich, and
  link alerts to assets and identities; map coverage against detections.
  - `[x]` Pure telemetry rules (`src/lib/security-alert-rules.ts`): vendor→source
    classification, a closed severity vocabulary (words and both numeric scales),
    ISO timestamp parsing, a stable `dedupeKey` (the vendor id when supplied,
    else a detection/asset/identity/time-window fingerprint), asset/identity
    enrichment with a triage-severity bump, a coverage map against expected
    detections, and a summary roll-up.
  - `[x]` The ingest service (`security-alert-service.ts`): at-least-once safe —
    a repeat folds into the existing row under `dedupeKey`, bumping
    `occurrences` rather than inserting — and the first sighting writes a
    `security.alert.ingest` event to the hash-chained audit log. Includes the
    `SecurityAlert` model and the `PrismaSecurityAlertStore` adapter.
  - `[x]` Per-vendor connectors that feed the rules
    (`src/lib/security-alert-connector.ts`): a vendor-alias parser, a webhook
    `SecurityAlertConnector`, and a `VendorAlertPoller` over an `AlertSource`
    that acknowledges only what the service took — so a crash mid-batch retries
    rather than loses an alert. `POST /api/security/ingest` (shared-secret
    authenticated) is the HTTP entry point.
  - `[x]` Link an alert to a real ticket/incident: `SecurityAlert.ticketId`,
    written first-write-wins by `SecurityAlertService.linkTicket` and set when
    promotion opens the ticket, so an alert and its ticket always resolve to
    each other.
  - `[x]` The triage console (`/security`) lists the stream with each alert's
    promotion outcome, records false-positive verdicts and configures
    suppression rules (`src/components/SecurityAlertList.tsx`,
    `src/app/actions/security.ts`); `POST /api/security/poll` drains a polled
    vendor source through the same connector for vendors that only offer an API.
- Alert → ticket/incident promotion rules, with suppression and false-positive
  tracking.
  - `[x]` Promotion, suppression and false-positive rules
    (`src/lib/alert-promotion-rules.ts`): a promotion policy (a triage-severity
    bar plus a repetition threshold), suppression rules on
    signature/asset/identity/source with an expiry, and false-positive verdicts
    counted per signature over a window. `decidePromotion` returns
    promote/observe/suppress with a reason, and `AlertPromotionService` opens
    the incident through the normal ticket lifecycle, links the alert, and
    records the decision in its own table and the hash-chained audit log.
- **Exit:** staff sign in through the tenant IdP with MFA; SCIM provisions and
  deprovisions automatically; an IDS/IPS alert lands once (deduped), linked to
  the right asset, and can open an incident.

### M3 — Incident response & defensible documentation `[x]`
**Goal:** run incidents to a playbook and produce an evidence packet that stands
up to an adjuster or auditor.

- Incident lifecycle (detect → triage → contain → eradicate → recover → review)
  with a severity matrix, incident commander and role assignment.
  - `[x]` The severity **matrix** (impact × urgency) with the inputs stored
    beside the outcome, the **phase ladder** (with a regression back to
    `CONTAINED` treated as the same incident, not a new one), and the four
    **roles** — commander, comms lead, scribe, liaison. A SEV1/SEV2 cannot be
    triaged without a commander and a scribe, so an incident with nobody owning
    it is refused rather than left to stall. Pure, in
    `src/lib/incident-rules.ts`.
  - `[x]` `IncidentService` (`incident-service.ts`) declares an incident,
    advances its phase, staffs it and appends an **append-only timeline**
    (`IncidentEvent`) as it goes — written as things happened, never
    reconstructed — with a hash-chained audit event per change. Persisted
    through `incident-store-prisma.ts` and the `Incident`/`IncidentEvent`
    models; covered by `tests/tix-m3-incidents.test.ts` and documented in
    [docs/incidents.md](./docs/incidents.md).
- Playbooks/runbooks with step tracking; a war-room timeline assembled
  automatically from tickets, alerts, approvals and logins (contemporaneous,
  never reconstructed).
  - `[x]` A response runbook planned **by severity** whose steps are completed
    or skipped-with-a-reason, and reopened rather than silently flipped; declaring
    an incident auto-starts it (`src/lib/playbook-rules.ts`,
    `incident-docs-service.ts`).
  - `[x]` The incident console (`/incidents`): declare, advance the phase, staff
    the four roles, run the playbook, record evidence and write the timeline —
    offering only the legal next moves, and read-only without `ticket:update`.
  - `[x]` The **war-room timeline** assembled automatically from *other* sources:
    the incident log, the tenant's hash-chained audit log, the alert stream and
    the decisions taken about the incident, merged into one ordering
    (`src/lib/war-room-rules.ts`, `war-room-service.ts`). The same fact seen by
    two systems is one entry attested by both rather than two lines that look
    like two events, an audit-only fact (an export, say) is kept instead of being
    dropped for having no incident-log twin, and reading a timeline writes
    nothing — so assembling it cannot change the record it describes. Staff-only
    and tenant-scoped, rendered on the console with its sources behind each line;
    covered by `ontrak-tix/tests/tix-m3-war-room.test.ts`.
- Evidence collection with chain of custody; object-lock storage; legal hold.
  - `[x]` Evidence items with a kind, label, reference and optional SHA-256,
    validated on the way in, recorded to the timeline, and rolled into a JSON
    manifest whose hash depends on content and not on export time
    (`src/lib/evidence-rules.ts`, `GET /api/incidents/[id]/manifest`).
  - `[x]` Chain of custody: collection writes the item's first custody entry, a
    hand-off carries a recipient and a reason and must start from the item's
    current holder (derived by walking the trail), and the trail is rendered per
    item on the console (`CustodyEntry`, `custodyIntegrity`).
  - `[x]` Legal hold: placed and released with a reason and a name, one active at
    a time, recorded on the timeline and the audit chain, and outranking routine
    retention (`LegalHold`, `retentionDecision`).
  - `[x]` **Object-lock (WORM) storage** for the artifacts themselves
    (`src/lib/object-lock-rules.ts`, `object-lock-file.ts`, `EvidenceArtifact`):
    content-addressed keys (`evidence/<tenant>/<incident>/<sha256>`) so a key
    cannot drift from its bytes and a re-upload of identical bytes is the same
    object rather than an overwrite; `COMPLIANCE` retention that nobody can
    shorten, `GOVERNANCE` retention that a privileged caller may remove early
    only explicitly and on the record; a legal hold that outranks the clock in
    both directions; and removal gated on `tenant:manage`, a reason and the lock,
    which stamps `purgedAt` and keeps the artifact in the manifest as a
    tombstone. The filesystem store enforces write-once with an `wx` open (for
    the writers that go through it) and the module hands out the S3
    `x-amz-object-lock-*` headers a real object-locked bucket needs. The lock
    travels inside the manifest digest, so the retention that applied is part of
    what the hash covers; covered by
    `ontrak-tix/tests/tix-m3-object-lock.test.ts` and exercised end to end by the
    Tix browser sweep (`tests/browser/tix.spec.ts`: upload, locked, a re-upload
    of the same bytes, an agent's removal refused, an administrator's removal
    refused while COMPLIANCE holds, artifact still locked).
  - `[x]` The **retention sweep**: a lock nobody acts on is the same as no lock,
    so `planRetentionSweep` decides what a closed window allows — using the same
    `objectPurgeDecision` a manual purge uses, so a scheduled sweep and a button
    press cannot disagree about a COMPLIANCE artifact — and
    `IncidentDocsService.sweepRetention` carries it out: bytes, tombstone,
    timeline line and audit event per artifact, one run event even when it found
    nothing, all under `system:retention-sweep`. A legal hold stops it in both
    directions, a `dryRun` reports without touching anything, and the report says
    what it left alone and why. Reachable as
    `POST /api/incidents/retention-sweep` (Bearer-authenticated, `?tenant=`,
    `?dryRun=1`) and as `npm run sweep:retention`. Covered by
    `ontrak-tix/tests/tix-m3-retention.test.ts`, and by the Postgres integration
    test in `ontrak-tix/tests/tix-db.test.ts`, which purges real files and rows
    with a real hold in the way and checks the audit chain afterwards.
- Regulatory/notification tracking, communications templates, and a
  post-incident review with tracked actions.
  - `[x]` **Notification duties**: regimes suggested from the incident's own
    facts (severity, personal data, regulated sector), tracked deliberately,
    then run on a clock measured from detection or declaration as the regime
    says — `DUE_SOON` before the deadline, `OVERDUE` after it, a late send
    recorded as late, and a waiver that carries a reason and a name
    (`src/lib/regulatory-rules.ts`, `compliance-service.ts`,
    `IncidentNotification`).
  - `[x]` The **post-incident review**: published once with findings and lessons,
    carrying actions with an owner, a due date and a status that moves only the
    legal way, with `OVERDUE` derived from the date rather than stored
    (`src/lib/review-rules.ts`, `IncidentReview`, `IncidentReviewAction`).
    `reviewCompleteness` is what makes "an incident is not finished while an
    action is open" a rule instead of a hope. Covered by
    `ontrak-tix/tests/tix-m3-compliance.test.ts`.
  - `[x]` **Communications templates** (`src/lib/comms-rules.ts`): each regime
    now comes with the words — a subject, a body and a line on what a message of
    that kind must not forget — rendered from the incident's own facts by the same
    `{{name}}` engine the M1 canned responses use, so a desk's canned wording can
    be adopted as an incident draft unchanged (`cannedAsCommsTemplate`). A field
    only a person can supply (categories of data, subjects affected, material
    impact) is named as a fill-in: the console reports how many are outstanding
    and the service refuses to record a notice as sent while one is unresolved,
    which is what stops a half-written breach notice entering the record as a
    notification. The console offers the drafts on an open duty (flagging the
    generic ones when no template names that regime), pre-fills an editable
    textarea, and stores the text **as sent** on the obligation — with the draft
    it came from on the timeline and the template key in the audit event. A desk
    can author its **own** drafts at `/incidents/templates`
    (`comms-template-service.ts`, `IncidentCommsTemplate`): one aimed at a regime
    is offered ahead of ours on that duty, a generic one on every duty, placeholders
    are validated while somebody is looking at the form, and a draft is retired
    rather than deleted. Covered by `ontrak-tix/tests/tix-m3-comms.test.ts`, and
    exercised end to end by the Tix browser sweep (write a draft, track the
    regime it names, record the notice from the desk's own words).
- One-click **Assurance Packet** export: signed timeline + decisions + approvals
  + evidence manifest + access logs + policy versions.
  - `[x]` The packet (`assurance-rules.ts`, `assurance-service.ts`,
    `GET /api/incidents/[id]/packet`): the incident, playbook, evidence manifest,
    custody trail and legal hold, timeline, an audit-chain excerpt anchored to the
    head it was read at (with that head's verification result) and the policy
    versions in force — assembled from the manifest so it cannot disagree with the
    record. Two digests separate "this packet" from "this record"
    (`contentHash` vs a stable `recordHash`) and an HMAC makes it verifiable
    offline; exporting is audited as `incident.packet.export`.
  - `[x]` A standalone verification **tool** that exposes `verifyAssurancePacket`
    to a third party holding only the packet and the key:
    `scripts/verify-packet.ts` (`npm run verify:packet -- packet.json`), which
    imports the packet rules, the signer and the verifier and nothing else — no
    Prisma, no session, no `db.ts`, no network — so it runs from a checkout that
    was never configured with this deployment's environment. Exit codes separate
    "the packet is forged" (1) from "the file could not be read" (2). Covered by
    `ontrak-tix/tests/tix-m3-verifier.test.ts`.
  - `[x]` Completeness is a rule, not a judgement: `packetCompleteness` reports
    what a reviewer would still be missing, so the "% of incidents with a complete
    packet" metric has a definition.
- **Exit:** an incident runs end to end on a playbook; the timeline is complete
  without manual reconstruction; a signed evidence packet exports; the
  post-incident review is published with owners and due dates.

### M4 — MSP & multi-client `[x]`
**Goal:** one desk serving many clients safely.

- Clients/companies, contacts, per-client SLAs, branding and portal identity.
  - `[x]` **Clients and contacts**: `Client`/`Contact` with name and address
    validation (an address a reply can reach, not a regex-shaped guess), one
    address per person — case-insensitively, and refused if another client
    already has it — and an audit event per write
    (`src/lib/client-rules.ts`, `client-service.ts`, `client-store-prisma.ts`).
  - `[x]` **Per-client SLAs**: a policy may belong to a client or a queue, and
    `resolveSlaPolicy` answers most-specific-first — the client's priority
    policy, then its catch-all, then the queue's, then the desk's — reporting the
    rung that won and falling back to pre-M4 behaviour rather than leaving a desk
    with no promise at all. One resolver, three consumers (inbox flags, report
    attainment, escalation sweep).
  - `[x]` **Writing a promise** (`sla-policy-service.ts`, the `/clients`
    console): validated before it is in force (a blank is not a zero), written on
    one of two hour presets rather than a free-form calendar, audited on every
    change, scoped by `queue:manage`, refused when two promises would share a
    name case-insensitively, and **not deletable** while tickets are measured
    against it — the refusal says how many. An edit that does not mention the
    scope keeps it, so a form carrying only the numbers cannot move a client's
    contract onto the whole desk. Covered by
    `ontrak-tix/tests/tix-m4-sla-authoring.test.ts`.
  - `[x]` **Branding and portal identity per client**
    (`client-branding-rules.ts`, `client-branding-service.ts`, the branding form
    on `/clients`): the name, accent colour, logo, reply-to address and signature
    one client is shown in, resolved by one `brandFor` so a client with no
    branding of its own is simply shown as the desk rather than being a case
    every page has to handle. A colour has to stay readable on the portal
    background (checked as a contrast ratio, not a preference) and a logo has to
    be an `https:` URL or an inline base64 image — never `http:`, never
    `data:text/html`, never an unbounded data URI. The client-facing survey at
    `/survey/[token]` reads the brand through a separate, narrower entry point
    than the actor-scoped one, so the unauthenticated page can resolve a brand
    without ever being able to list clients.
- Cross-client agent views with strict scoping and "act as client" guardrails.
  - `[x]` **Scope**: `clientScopeFor` gives `queue:manage` every client and an
    agent the clients they are assigned to, while work naming no client stays
    visible to the whole desk; `scopeByClient` returns the filtered rows so a
    caller cannot forget it, and the inbox applies it before computing anything
    else.
  - `[x]` **Act as client**: a permission, a client in scope, a reason on the
    record and one window at a time, with a 30-minute expiry and the window
    recorded both as a row and as an audit event (`ClientActAsSession`).
  - `[x]` The multi-client console, `/clients`.
- Time tracking, rate cards, billable vs non-billable, invoice-ready exports.
  - `[x]` **Time and rates** (`time-rules.ts`, `time-service.ts`,
    `time-store-prisma.ts`, `/time`): hours logged on the ticket they belong to,
    priced by a client's card or the desk's default and **snapshotted onto the
    entry** (minutes charged, rate, rounding, currency) so a card changed later
    cannot restate what was billed; rounding as a stated contract term; the
    ledger scoped by the same client scope as the worklist; and an
    invoice-ready CSV that names the labour and refuses a formatted number.
    Covered by `ontrak-tix/tests/tix-m4-time.test.ts`.
  - `[x]` **Invoices that cannot be billed twice**: issuing is a POST that groups
    the period into lines, stamps every entry it covers with the reference and
    records the totals on the audit chain, while `/time/export?ref=…` only
    re-reads it — and an entry on an invoice is frozen (the refusal names the
    credit note that is the real remedy).
- Shift handoff: on-call schedules, rota, coverage windows.
  - `[x]` **The rota** (`rota-rules.ts`, `rota-service.ts`,
    `rota-store-prisma.ts`, the `/handoff` page): shifts and on-call windows per
    person and queue, with an overlapping window for the same person refused at
    the point of writing (and the refusal naming the shift it collided with), and
    a shift longer than a day refused as a mis-typed on-call week.
  - `[x]` **Coverage as a question with an answer**: `coverageAt` says who is
    covering a moment and who to wake; `coverageGaps` returns the uncovered
    intervals inside a window — measured from on-call shifts only, because being
    at a desk is not cover at 03:00 — and `rotaLoad` makes "one name on every
    window" visible rather than merely present in a list.
  - `[x]` **The handoff** (`Handoff`): outlives the shift it happened in. It
    names who handed over, who took it, and the work that was still open by
    reference, and it needs a note — an empty handoff is the failure mode the
    record exists to prevent. Recording one resolves the shift that is on at that
    moment rather than trusting a form, and a handoff from somebody who is not on
    duty is refused unless they run the desk.

- Billing depth: tax, credit notes and retainers.
  - `[x]` **Tax** (`billing-rules.ts`, the tax form on `/clients`): basis points
    on a rule that belongs to a client or to the desk, resolved client-first,
    validated at the point of writing (a rate above 100% is a typo), charged on
    the labour subtotal at the moment the invoice is issued and **snapshotted
    onto the entries it priced** — so a rate changed in April cannot restate what
    March was charged, and an issued invoice reports the rate that produced it
    rather than today's rule.
  - `[x]` **Credit notes** (`CreditNote`, `time.credit_note.issue`): the only
    remedy for an invoice that was wrong, because an invoiced entry is frozen.
    The refusal is the feature: a credit may not exceed what the invoice still
    owes, so the same money cannot be credited twice; it needs a reason somebody
    can read back; and each note carries its own reference beside the invoice it
    answers.
  - `[x]` **Retainers** (`Retainer`): money paid up front for a period, drawn
    down by the invoices issued inside it — and the balance is always *derived*,
    funded minus what the entries carrying its id drew, never a stored counter
    that can drift from the ledger. A retainer is money in one currency, so it
    only ever absorbs invoices denominated in it.
  - `[x]` **One invoice per currency**: a period that spans two currencies issues
    two documents with two references rather than one total nobody can pay. The
    currency is part of a line's identity, the CSV states `Subtotal`, `Tax` and
    `Amount due` in that order, and `issued()` re-reads all of it.
- Per-client reporting and a client-facing satisfaction (CSAT) survey.
  - `[x]` **Per-client attainment and CSAT** (`clientScorecards` in
    `report-rules.ts`, the *By client* table on `/reports`, and
    `/reports/export?scope=clients`): the same function that builds the desk-wide
    report builds each client's, so the two can never disagree; the bucket for
    work that names no client is a row too, so the client figures add up to the
    desk; and worst-first ordering is what makes the first row one somebody can
    act on.
  - `[x]` **A client-facing survey** (`client-survey-rules.ts`,
    `client-survey-service.ts`, the public `/survey/[token]` page): one question
    per client per period, answered from an unguessable link by somebody with no
    account — the one write in the product a stranger can reach, and it does
    exactly one thing. Asking is a manager's act for a client in scope; a link
    answers once, expires, and both halves land on the audit chain
    (`client.survey.request`, `client.survey.respond`). Covered by
    `ontrak-tix/tests/tix-m4-client-reporting.test.ts`.
- **Exit:** an agent works two clients without data bleed; time entries export to
  an invoice line; per-client SLA attainment is reportable.

### M5 — Automation & knowledge `[x]`
**Goal:** reduce manual work and capture know-how.

- Rules engine: trigger (+conditions) → actions (set field, route, notify, reply,
  tag, escalate); dry-run and rule test harness.
  - `[x]` **The engine** (`rule-rules.ts`, `rule-service.ts`,
    `rule-store-prisma.ts`, the `Rule` model): a trigger, the conditions that
    narrow it, and the actions it takes. Conditions are **all** required — there
    is deliberately no OR, because "which rule did this?" should have one answer,
    and a second rule is a cheaper thing to read than an expression language
    nobody can predict. Rules run in `position` order and the **first** one to set
    a field owns it; a later rule that wanted the same field is recorded as
    skipped *with the reason*, rather than letting a position nobody looked at
    decide the outcome. Tags accumulate while singular fields do not, and the
    outward-facing actions (notify, reply, escalate) all accumulate, because
    dropping one quietly is the failure a rule exists to prevent. Writing one
    needs `rule:manage`, names are unique case-insensitively, and every write
    lands on the audit chain with the rule's whole body — so "who made the desk
    reply to everything from that address?" has an answer. Covered by
    `ontrak-tix/tests/tix-m5-rules.test.ts`.
  - `[x]` **The dry run** (`dryRun`, `ruleHazards`, `describeAction`,
    `describeCondition`): the *same* functions the live path runs, applied to
    tickets that already exist, so a preview cannot disagree with what switching
    the rule on will do. It reports what each matched rule would change and what
    it outvoted, and it names the two ways a desk automates something it did not
    mean to — a rule with no conditions, which therefore matches everything, and
    an automatic reply, which leaves the desk under its own name without an agent
    reading the thread.
  - `[x]` **Applied on intake** (`rule-intake.ts`): the engine is wired into
    `TicketService`, which every intake path already goes through, so a rule fires
    wherever a ticket is created, updated or replied to — quick-create, the
    requester portal, inbound email, alert promotion — without any of those paths
    knowing rules exist. On creation the rules run *before* the row is written, so
    a ticket is born with the priority, queue, assignee and tags the desk asked
    for rather than being written and corrected. A `reply` action appends a public
    message from the desk and stops the response clock; `notify` and `escalate`
    reach staff through an injected sink, and an effect that cannot be delivered
    is recorded rather than allowed to lose the ticket. Every firing appends one
    `ticket.rules` event naming the rules that matched, what took effect and what
    an earlier rule outvoted. Covered by
    `ontrak-tix/tests/tix-m5-rule-intake.test.ts`.
  - `[x]` **The console** (`/rules`, `actions/rules.ts`, `rule-form-rules.ts`):
    every rule read back as sentences rather than as the rows it was typed in, its
    hazards said out loud (a catch-all matches everything; an automatic reply
    leaves the desk without an agent reading the thread; an escalation pages
    whoever is on call), and its order changeable — the first rule to set a field
    owns it, so position *is* the policy, and a console that could write rules but
    not reorder them would leave a desk retyping everything to fix one. Reading is
    `ticket:read:any`; writing, moving, switching and removing are `rule:manage`.
    Documented in `docs/rules.md`.
- Macros (multi-step agent shortcuts) and public/private knowledge base with
  article suggestions on ticket create.
  - `[x]` **Macros** (`macro-rules.ts`, `macro-service.ts`,
    `macro-store-prisma.ts`, the `Macro` model): the deliberate counterpart to a
    rule — a saved sequence an agent runs on one ticket, using the engine's own
    eight actions and the same `planTicketChanges` the rules path uses, so "set
    the priority, then tag it" cannot mean two things. A macro has no trigger and
    no conditions (if it needs one it is a rule), reports the same hazards, and
    is run from the ticket's Shortcut picker under `ticket:update`; writing one is
    `rule:manage`, names are unique case-insensitively, and every write carries
    the macro's whole body onto the audit chain. A run is attributed to the agent
    as `ticket.macro`, appends its `reply` under the desk's name (stopping the
    response clock), delivers `notify`/`escalate` through the same sink rules use,
    and deliberately does **not** re-run the rules — an explicit instruction must
    not be outvoted by automation. Covered by
    `ontrak-tix/tests/tix-m5-macros.test.ts` and documented in
    [docs/macros.md](./docs/macros.md).
  - `[x]` **Public/private knowledge base** (`knowledge-rules.ts`,
    `knowledge-service.ts`, `knowledge-store-prisma.ts`, the `KnowledgeArticle`
    model, the `/knowledge` console): an article is offered to requesters in the
    portal or kept to the desk, and the suggestion engine is pure — a query's
    words are matched against a title, then its tags, then its body, weighted in
    that order, so the same query yields the same list and a reader can say why
    an article was offered. **`PRIVATE` is a promise, not a label**: the
    requester's path is handed public articles only by the rules function
    itself. Authoring is `ticket:update`; a write is audited, and a private
    article becoming public is recorded as its own `knowledge.publish` event
    rather than buried in an edit. Covered by
    `ontrak-tix/tests/tix-m5-knowledge.test.ts` and documented in
    [docs/knowledge.md](./docs/knowledge.md).
- Self-service deflection `[x]`: the portal's new-request page runs the public
  article search from the words a requester types (*Find help*), shows the
  matching articles **in full** before the form — each a `<details>` element, so
  it needs no JavaScript — and keeps what was typed in the subject field, so
  looking costs nothing if the answers do not help. The staff quick-create page
  carries the same box with the desk's private articles included.
- CSAT dashboards and knowledge-gap reporting (repeat tickets with no article).
  - `[x]` **The satisfaction dashboard** (`csatDistribution`, `csatDashboard`,
    `csatByGroup` in `csat-rules.ts`, the *Satisfaction* section on `/reports`):
    an average hides the shape of the answers — one 1 and one 5 also average 3 —
    so the dashboard shows the whole scale, *including the points nobody picked*,
    the response rate beside the average (a 5 from four people out of fifty is a
    different finding from a 5 out of five), the answers split by the agent who
    earned them, worst first, and the words, because "the wait was fine but
    nobody explained" is the finding a bar chart cannot carry. A group with no
    answers yet sorts last rather than to the top on a null average: no data is
    not "doing badly".
  - `[x]` **Knowledge-gap reporting** (`findKnowledgeGaps`,
    `buildKnowledgeGapReport` in `knowledge-rules.ts`, the *Knowledge gaps*
    section on `/reports`): a ticket whose subject matches no article is one the
    desk had to answer by hand, and those subjects are clustered by the words
    they share — transitively, so "vpn drops" and "vpn certificate" are one
    question rather than two reports. A cluster one requester raised more than
    once sorts first, because a repeat requester is the loudest signal a desk
    gets that an article is missing; the report counts how much of the desk ran
    through gaps at all. A **staff-only article counts as an answer** — the desk
    could have replied from it — so the finding reads "publish it", not "write
    it". The same pure suggestion engine the portal uses decides what is
    unmatched, so the report cannot disagree with what a requester was offered.
    Covered by `ontrak-tix/tests/tix-m5-csat-knowledge-reporting.test.ts` and
    documented in [docs/reporting.md](./docs/reporting.md).
- **Exit:** rules cover the top intake paths; ≥30% of new tickets are auto-routed
  or deflected; KB suggestions measurably cut handling time. The exit numbers are
  a live-data question rather than a code one — M5 ships the reporting that
  measures them.

> M5 progress: **the rules engine, its dry run and its intake are live**. The
> engine is pure in `rule-rules.ts` — matching, ordering, first-writer-wins and
> hazards — with `rule-service.ts` storing what it decides and
> `rule-store-prisma.ts` adapting the `Rule` table (conditions and actions as
> JSON, because a rule is read and written whole). `rule-intake.ts` wires it into
> `TicketService`, so every intake path fires rules without knowing they exist,
> and `/rules` is the one place a rule is written, reordered, switched off or
> removed. The preview is the same `evaluateRules` + `planTicketChanges` the live
> path uses, applied to tickets that already exist — and a *switched-off* rule is
> previewed as if it were on, because that is the moment the question is actually
> asked. Macros have landed too: an agent-run sequence of the engine's own
> actions, planned by the same planner, run from the ticket's Shortcut picker,
> attributed to the agent as `ticket.macro`, and deliberately not re-running the
> rules. The **knowledge base** and **self-service deflection** have landed
> alongside them: public/private articles authored at `/knowledge`, matched by a
> pure suggestion engine, and offered to a requester from the words they type on
> the portal before they submit. The last piece of M5 — **CSAT dashboards and
> the knowledge-gap report** — is on `/reports`: satisfaction over the whole
> scale with the words beside it and the agents split out, and the subjects no
> article answered, clustered, with repeat requesters first because they are the
> desk's clearest signal that something is missing. **M5 is feature-complete**;
> its exit criteria are numbers the desk now has the reporting to read.

### M6 — Platform & integrations `[x]`
**Goal:** fit into the surrounding toolchain.

- Public REST API + webhooks with scoped tokens, rate limits and delivery logs.
  - `[x]` **Scoped tokens** (`public-api-rules.ts`, `public-api-service.ts`,
    `public-api-store-prisma.ts`, the `ApiToken` model, `/api/v1/tokens`): a token
    is a hash in the database and a string on exactly one screen — the plaintext
    is returned once at creation and never stored, so a support engineer who can
    read the database still cannot impersonate the integration. What is kept
    beside the digest is a `tx1_…` prefix, which is what makes a leaked token
    findable rather than merely long. Three scopes, closed, and refused at
    creation rather than carried around and ignored: `tickets:read`,
    `tickets:write`, `webhooks:manage`. A token also carries the *least* role that
    could serve those scopes, so an integration can never do something an agent
    could not and the scope only narrows that further. **An API token cannot mint
    another API token** — a credential that can re-issue itself after revocation
    removes the one remedy revocation exists to provide, so minting and revoking
    are a signed-in administrator's `tenant:manage` acts. Expiry and revocation
    are one question asked in one place, exactly as they are for a session.
  - `[x]` **Rate limits** (`rateLimitDecision`, `rateLimitHeaders`,
    `consumeRateLimit`): a sixty-second fixed window per token, aligned to the
    epoch so two processes agree on which window a request belonged to without
    sharing anything but the clock. Every authenticated answer carries
    `RateLimit-Limit/Remaining/Reset`, and only a refusal carries `Retry-After` —
    on a success it would be a lie about what to do next. The window is spent by
    *authenticating*, not by being allowed, because an integration hammering an
    endpoint it has no scope for is still hammering us. The counter is advanced by
    conditional writes and **stops growing at the limit plus one**, so refusing
    stays cheap and a flood cannot make a big number.
  - `[x]` **The versioned REST API** (`/api/v1/tickets`, `/api/v1/tickets/:id`,
    `public-api-http.ts`): the version is in the path because it is what a caller
    bookmarks and greps a log for, and every body carries `api_version` beside its
    `data`. The gate is a pure function — token present, then valid, then under
    its limit, then holding the scope — so the *order* of the checks is tested
    without a running framework; a refusal is a stable `error` code beside a human
    `message`, because a client that string-matches prose breaks when the prose
    improves. Reads page by **cursor**, not page number: a page number over a list
    being written to skips and repeats rows, and a cursor that names nothing is a
    `400` rather than a silent restart. A write goes through `TicketService`, so
    an API-created ticket fires the desk's rules, lands on the tenant's hash chain
    with `api-token:<id>` as its actor, and appears in the inbox exactly as one
    raised by a person would.
  - `[x]` **Webhooks with a delivery log** (`webhook-rules.ts`,
    `webhook-service.ts`, `webhook-store-prisma.ts`, the `ApiWebhookEndpoint` and
    `ApiWebhookDelivery` models, `/api/v1/webhooks*`): a destination is registered
    once and checked then — `https`, or `http` only on loopback, never a fragment
    and never a URL carrying credentials — so an outbound request is never sent to
    an origin nobody agreed to. Events are a closed set, and every delivery is
    signed `HMAC-SHA256(secret, "{timestamp}.{body}")` with the **timestamp
    first**, so a receiver checks it over bytes it has already authenticated and a
    replay of a captured delivery carries the timestamp it then refuses. The
    signing secret is the one credential stored in the clear, stated out loud
    because an HMAC cannot be computed from a hash; it is shown once and
    rotatable. The delivery row is written **before** the attempt, so an event that
    arrived while the process was dying is still visible as one that was due, and
    it keeps the exact bytes that were signed — "what did you actually send us?"
    is answered from the record rather than reconstructed. Retries back off 30s,
    1m, 2m, 4m and then **stop**: `EXHAUSTED` is a terminal state with a count, not
    a silent drop, and every attempt is its own event on the tenant's chain.
    `POST /api/v1/webhooks/sweep` is what reads the clock, and it is safe to run as
    often as you like. Covered by `ontrak-tix/tests/tix-m6-public-api.test.ts` and
    `ontrak-tix/tests/tix-m6-webhooks.test.ts`, and documented in
    [docs/api.md](./docs/api.md).
  - `[x]` **The integrations console**
    (`src/app/(desk)/admin/integrations/page.tsx`, `src/app/actions/integrations.ts`):
    the API-first surfaces were reachable only with `curl`, which is fine for an
    integrator and useless for everybody else. One screen, gated on `tenant:manage`,
    now mints and revokes tokens, registers, rotates, disables and removes webhook
    endpoints, reads the delivery log with each row's attempt count and next try,
    and runs the delivery sweep on demand — so an administrator can *watch* a retry
    instead of waiting half a day to find out whether the backoff arithmetic was
    right. It also names the monitoring webhook and lists the conditions the RMM
    connector has open, because "what is the desk working on by itself?" is the same
    question as "what is talking to us?". The two values that are readable exactly
    once — a minted token and a webhook signing secret — are handed to the page in a
    short-lived, path-scoped `httpOnly` cookie and put away by a button: a secret in
    a query string ends up in browser history, in `Referer`, and in every proxy log
    between here and the browser.
- Integrations (beyond the M2 IdP and M2 telemetry): RMM/monitoring (alert →
  ticket with auto-resolve), Slack/Teams, and a marketplace pattern for
  third-party connectors.
  - `[x]` **RMM / monitoring auto-resolve** (`rmm-rules.ts`, `rmm-service.ts`,
    `rmm-store-prisma.ts`, the `RmmAlertLink` model, `POST /api/rmm`): a failing
    check opens a ticket and a recovery closes it — the milestone's exit criterion,
    and the reason this table is keyed on the **condition** (`source:host:check`,
    case-folded) rather than on the vendor's alert id. Vendors disagree about
    whether a re-fire reuses an id; keying on the condition is what lets a recovery
    find the ticket it belongs to when its own id is brand new, and it is what makes
    "open once, close when it clears" true across a vendor's own bookkeeping. A
    repeat is an internal note and a raised occurrence count rather than a second
    ticket, because a check that fails every minute for an hour is one outage. A
    condition that clears and fails again is a **new** ticket — the last outage is
    over, so the second gets its own response clock and its own post-incident
    record — with `reopenCount` making the recurrence visible. A recovery for a check
    the desk never worked is *ignored*, because opening work in order to close it is
    not work. Closing walks the lifecycle's own edges (`NEW → OPEN → CLOSED`), since
    `ticket-rules.ts` forbids the shortcut and an auto-closed ticket should leave the
    trail a person's would; a ticket a person already closed is left alone, with the
    clear still recorded on the link. Tickets are raised through the normal
    `TicketService`, so they fire the desk's rules and land on the tenant's chain,
    and every outcome is itself a `rmm.alert.*` event keyed by the condition. Field
    aliases are accepted, and the status code says what the sender should do: `202`
    acted, `200` already true, `400` never an alert, `503` the desk cannot respond.
    Covered by `tests/tix-m6-rmm.test.ts`.
  - `[x]` **Slack and Teams notifications** (`chat-notify-rules.ts`,
    `chat-notify-service.ts`, `chat-notify-store-prisma.ts`, the `ChatChannel` and
    `ChatDelivery` models, the console's chat section): the M6 webhook is a
    *contract* an integrator reconciles, and this is the other audience — the room
    where the on-call rota already lives. Four decisions make it a connector rather
    than a `curl`:
    **the URL is the provider's**, checked at registration against the hosts Slack
    and Microsoft own (`hooks.slack.com`, `*.webhook.office.com`,
    `outlook.office.com`, `*.logic.azure.com`) with an exact-or-suffix host match, so
    a ticket subject can never be the thing that decides where the desk connects
    next; **a ticket's text is data, not markup** — every value is escaped for its
    provider's parser, because `<!channel>` is a *live* control token in Slack and a
    requester writes the subject, so an unescaped one would page four hundred people
    from a help-desk form; **one message, two renderings**, with Slack Block Kit and
    Teams' `MessageCard` built from the same `ChatMessage`, so a third provider is a
    renderer rather than a second pipeline; and **delivery is the webhook's own state
    machine** (`applyDeliveryAttempt`, shared through a structural type rather than
    copied), so `DELIVERED`, `RETRYING` with the instant of the next try, or
    `EXHAUSTED` after five means exactly one thing in this product whatever the
    destination is. The console adds the control that matters most here: a *send a
    test message* button, because a chat webhook URL pasted slightly wrong fails
    silently — nobody notices a message that never arrived. A channel's URL is a
    credential, so it is never written to the audit trail, which records the name and
    provider instead. Covered by `tests/tix-m6-chat-notify.test.ts`.
  - `[x]` **A marketplace pattern for third-party connectors**
    (`connector-rules.ts`, `connector-service.ts`,
    `connector-store-prisma.ts`, the `ConnectorInstallation` model,
    `/admin/connectors`, `tests/tix-m6-connectors.test.ts` and
    [docs/connectors.md](./docs/connectors.md)): M6 shipped four ways for the outside
    world to reach the desk, each built where it was needed — which is right for the
    connectors we ship and wrong for the one after them. This makes a connector a
    **manifest** and installing one *data*. Six decisions carry it. **The manifest is
    the whole contract** — id, vendor, category, the capabilities it offers and the
    fields it needs — declared once, so the console, the registry and the install path
    cannot disagree about what a connector is. **First-party connectors are catalogued,
    not installed here**: Slack, webhooks, RMM and the rest each configure on their own
    console, and `managePath` says where — so *“what can talk to this desk?”* has one
    answer without a second place the same endpoint is set. **A third-party connector is
    registered, not patched in** — `ConnectorRegistry.register(manifest, handler)`
    validates the manifest with the same rules the built-ins pass and refuses an id it
    could shadow, so shipping a connector is a registration rather than new plumbing.
    **Config is validated in both directions** — a blank required field *and* a key the
    manifest does not declare are refused, because a form that silently drops a setting
    somebody typed lies about what the connector will do. **A secret is a secret
    everywhere** — masked on screen and recorded on the chain as *which* fields were set
    and which are secrets, never a value, because a chain entry outlives the deployment;
    and because the console never receives one back, an edit that leaves a secret blank
    keeps it. And **dispatch is a query over capability, not a list** — an event goes to
    the enabled installations whose manifest declares it, resolved every time, with a
    handler that throws reported as a failed outcome rather than allowed to undo the
    ticket that raised it.
- `[x]` **Custom fields, ticket forms and per-queue layouts** (`form-rules.ts`,
  `form-service.ts`, `form-store-prisma.ts`, `form-payload.ts`, the `CustomField`
  and `QueueForm` models, `/admin/forms`, and the fields rendered into both
  create-ticket forms): the two halves of one question — *what does this desk want
  to know about a ticket*, and *which queue asks it*. Six decisions carry it.
  **A value is stored as a string whatever the field's type**, so a number is a
  number when it is *validated* rather than when it is stored and a change of type
  is a validation change rather than a migration; the value is canonicalised on the
  way in (`"007"` becomes `"7"`, a checkbox becomes `"true"`/`"false"`, a date is
  `YYYY-MM-DD` or refused). **Unknown keys are refused, not ignored** — a form that
  silently dropped a field somebody filled in is a form that loses work, and a value
  posted for a field this queue's form does not show is refused rather than quietly
  kept. **A key cannot change once it holds a value**: renaming a *label* is ordinary
  editing, changing a *key* would orphan every answer stored under it, and the
  service says which one it is refusing. **A field is shown on new forms until it is
  archived, and archived rather than deleted** — a field that has ever held a value
  is part of a ticket's history. **A required field is required by the layout**, so
  the same field is optional on one queue's form and required on another's, and the
  answer is the same wherever a ticket is raised from: the check is a single
  `TicketFormGate.validateTicketValues` on the creation path, so the portal, the
  console and `/api/v1` cannot disagree about a required field. And **a form a queue
  has not written is the desk's default form, not an empty one**, with `inherited`
  on the resolved layout so "why is this queue's form different?" has an answer.
  The admin screen is deliberately honest about the first of those: the field list
  says how many forms use each field, so a field nobody has put on a form reads as
  "on no form yet" instead of existing invisibly. Covered by
  `tests/tix-m6-forms.test.ts` (the rules, the service, the round trip through the
  ticket path, the payload encoding and the Prisma mappers' narrowing).
- Enterprise controls: granular roles, audit-evidence export, data-retention and
  legal-hold policies.
  - `[x]` **Retention and legal hold** landed with M3 rather than here (the
    `RetentionPolicy`/`LegalHold` pair, object-locked evidence, the retention sweep
    and `GOVERNANCE`-vs-`COMPLIANCE` retention in **M3 — Incident response &
    defensible documentation** above). The other three words of this bullet are
    the two entries below.
  - `[x]` **Granular roles** (`role-rules.ts`, `role-service.ts`,
    `role-store-prisma.ts`, `Actor.permissions`/`actorHasPermission` in
    `access-rules.ts`, the `TenantRole` model with `User.tenantRoleId`,
    `/admin/roles`, and `tests/tix-m6-roles.test.ts`): the matrix is no longer
    code only, so a desk that wants "an agent who may close but not delete" — or
    one that may close and *not* read every client's queue — writes a role rather
    than waiting for a release. Six decisions carry it.
    **A role narrows its base role and can never add to it.** It is authored *on*
    one of the four built-ins and keeps a subset of that role's permissions, so a
    role definition cannot become a privilege escalation: the worst a mistaken or
    malicious one can do is take something away from somebody who already had it.
    It also means `Role` keeps meaning what it already meant everywhere else — the
    tenant-isolation checks, the API token scopes (which still name the *least*
    role that could serve a scope) and SCIM's role mapping never learn about tenant
    roles at all. The intersection is computed in one place
    (`effectivePermissions`) and stored already narrowed, so the row cannot
    disagree with the rule that reads it, and an unknown permission is dropped
    rather than kept in the array for a later release to start honouring.
    **Reading is one question asked in one place.** `actorHasPermission` judges an
    actor by their resolved set when they carry one and by their built-in role when
    they do not — so a desk that has written no roles behaves exactly as before,
    and the ~130 call sites could move to the actor without a behaviour change
    anywhere. **The narrowing is not carried in the session cookie**, because a
    cookie cannot be re-issued when an administrator edits a role, and a permission
    that outlives its own revocation until the session expires is the one failure
    granular roles must not have; it is resolved as the actor is built for the
    request (`withEffectivePermissions`, one query, on the read that already
    resolves a session). **A change that would strand the desk is refused**: saving
    or assigning anything that would leave nobody active holding `tenant:manage` is
    refused with a sentence naming the way out, and the screen prints the guard's
    own answer rather than only revealing it as a rejection. Archiving needs no
    guard at all and deliberately has none — a role can only narrow, so retiring
    one can only give power back, and a check that cannot fail would hide the rule
    it pretended to enforce. **An archived role is not a deleted one**: the row
    stays, its holders fall back to their built-in role, and every audit entry that
    named it by key still resolves; the key is fixed once written for exactly that
    reason. And **every change is on the tenant's chain** — `role.create`,
    `role.update`, `role.archive`, `role.assign` and `role.unassign`, each carrying
    what was kept and what was withheld, so "who gave them that, and when" and
    "what did that role mean in March" are both answerable. The screen is one page
    for both halves of the question (what each role may do, and who holds which
    role), chooses the base role through the URL so the checklist rendered is the
    checklist the server honours, and shows a permission the base role does not
    hold rather than hiding it — because "why can I not grant that?" deserves an
    answer on the page. Covered by `tests/tix-m6-roles.test.ts` (30 checks: the
    intersection narrowing rather than granting, an archived or
    differently-based role not narrowing at all, an empty set being a real
    narrowing rather than a missing one, the last-administrator refusal for both a
    save and an assignment, and the row mappers reading an unknown role as the
    least powerful one there is).
  - `[x]` **Audit-evidence export** (`audit-export-rules.ts`,
    `AssuranceService.auditExport`, `GET /api/audit/packet`, and the M6's tests in
    `tests/tix-m6-audit-export.test.ts`): the chain was readable in the console and
    the assurance packet was signed per incident, so what was missing was the
    document for the question an auditor actually asks — *show me everything this
    desk did*, not *what happened to this ticket*. It is deliberately the **same
    envelope** as the M3 incident packet: same `version`, same `HMAC-SHA256`, same
    `recordHash`/`contentHash`/`signature` discipline, and it is verified by the same
    function (which now takes the envelope rather than one packet type, so the two
    kinds cannot drift apart about what a valid signature is). Three things carry it.
    **The record is carried and the payload is not** — every entry's seq, time, actor,
    action and record hash, and none of the free-form `detail` a handler attached,
    because an export that widened itself to whatever was in the bag is how a reset
    token or an internal note ends up in a document that leaves the building. **A
    trail that does not verify still exports**, with `verified: false` *inside the
    signed anchor* — withholding a broken chain would refuse the evidence at the
    moment it is worth the most, and the one failure that must not happen, a break
    presented as sound, is impossible because the flag is under the signature; the
    report then says both true things in one line ("the packet is intact, but the
    trail did NOT verify"). And **exporting is itself audited**
    (`audit.chain.export`, carrying the digest and citing the seq the packet named),
    so who took a copy is on the chain the copy describes. Gated on `audit:read`
    rather than `ticket:read:any`: reading this desk's tickets and taking away the
    record of everything anybody did here are different questions, and only one of
    them is administrative.
> M6 progress: **the public API, its webhooks, the integrations console and the
> monitoring connector are live.** A scoped bearer token is a hash in the database
> and a string on one screen; a sixty-second window per token is enforced by
> conditional writes that stop counting once the window is blown; and `/api/v1`
> serves tickets read, create and fetch behind a pure gate whose order — present,
> valid, under budget, scoped — is the security. Webhooks are registered once
> against an https (or loopback) URL, signed over `{timestamp}.{body}` so a replay
> is refusable, and every attempt lands in a delivery log that says `DELIVERED`,
> `RETRYING` with the instant of the next try, or `EXHAUSTED` after five. A
> monitoring check that fails opens a ticket and a recovery closes it, keyed on the
> condition rather than on the vendor's alert id, and the console that mints the
> tokens and reads the delivery log exists so this is configuration rather than
> `curl`. The desk also tells the rooms people actually sit in: Slack and Teams
> channels choose from the same closed event set, their URLs are checked against the
> hosts the provider owns, a ticket's subject is escaped before it is posted because
> `<!channel>` in a subject would otherwise page the room, and each channel keeps the
> same delivery log with a button that posts one message now. A desk can also now
> ask its own questions: custom fields are defined once, placed on a form per queue
> (the default form is what every queue without one shows), and checked on the
> ticket path — the portal, the console and the API get the same answer about a
> required field because there is one place that answers it. The tenant's whole
> evidence trail also leaves the building now: `GET /api/audit/packet` signs every
> entry as one document in the *same* format as an incident packet — the record and
> not the payloads, a broken chain exported with `verified: false` inside the signed
> anchor rather than withheld, and the export itself recorded on the chain it
> describes. The desk's authority is its own data now too: a role written on this
> desk narrows one of the four built-ins and can never add to it, so it cannot
> escalate anything; the narrowing is resolved as each request's actor is built
> rather than carried in a cookie that cannot be re-issued, `actorHasPermission`
> answers every one of the ~130 call sites, and a save or an assignment that would
> leave nobody able to administer the desk is refused by name. And the desk's
> integrations are its own data too: a connector is a manifest the catalog lists,
> installing one records config validated against that manifest, a secret is never
> written to the chain, and an event is routed to the enabled connectors that
> declared the capability — so the next connector is a registration rather than new
> plumbing. **M6 is complete.** See [docs/api.md](./docs/api.md),
> [docs/rules.md](./docs/rules.md) and [docs/connectors.md](./docs/connectors.md).

- **Exit:** a monitoring alert opens a ticket and closes it when the alert clears
  (**done**); audit evidence exports on demand (**done** — a signed tenant-wide
  export at `/api/audit/packet`); the API is versioned and documented (**done**).

### M7 — Intelligence & scale `[~]`
**Goal:** enterprise hardening and assistance.

- AI assist (opt-in): classification/routing suggestions, thread summarisation,
  draft replies, similar-ticket retrieval — always human-approved. **Shipped:** the
  suggestion engine and the ticket panel (classification, summary, draft reply and
  similar tickets); an accepted classification is applied through the ticket
  service's own `reclassify`; the opt-in is per tenant, not a deployment switch; and
  the outcome author turns solved tickets into articles and scenarios. Analytics below
  remain.
- Analytics: trends, forecasting, agent/queue scorecards, SLA risk modelling.
  **Shipped** on `/reports`, all from the one
  [`analytics-rules.ts`](./src/lib/analytics-rules.ts): the volume trend (opened/closed
  per day, with the backlog it left), a straight-line backlog forecast drawn from it,
  the agent and queue scorecards, and a forward-looking SLA risk list that bands open
  work by how soon its nearest running clock will lapse.
- Performance/multi-region hardening, backup/DR runbooks, SOC 2-ready controls.

> The desk's memory of its own work is usable now. A ticket can be read by an
> assistant that proposes a classification, a one-paragraph summary, a draft reply
> and the tickets that look most like it — and proposes *only*: the service that
> answers has no method that could send, apply or reassign, so "never auto-send" is a
> property of its shape rather than a rule to be remembered. It is opt-in per *desk*
> — a tenant turns it on for itself — and a deployment has to offer a model, and with
> neither the suggestions still appear, computed from the ticket in front of the
> agent — the deterministic path is the guaranteed answer and not a fallback nobody
> sees. Every suggestion can be accepted or dismissed, and that decision lands on the
> same per-tenant hash chain as the ticket it was about, so the milestone's
> "measurable and reversible" is a query rather than a promise — and the panel reads
> those decisions back, so what a desk turned down is evidence rather than a forgotten
> click. The one thing that changes the ticket is an accepted classification, and it
> goes through the ticket service's own `reclassify`: same permission check, same audit
> event, and only the type, the priority and a queue this desk actually has. A model may improve the prose
> but may never supply the hit list: similarity is a fact about this desk, and an
> assistant must not be able to point an agent at a ticket that does not exist.

- **Exit:** documented scale targets met under load test; AI suggestions are
  measurable, reversible and never auto-send (**done** for the assist — a decision is
  recorded on the audit chain and the only write is a classification through the
  ticket service; see [docs/assist.md](./docs/assist.md)).

## 9. Backlog by area (prioritized, unassigned to milestones yet)

**Ticketing:** bulk merge, split, scheduling (deferred/on-hold with reason),
recurring tickets, ticket templates, approval flows, problem/change links.
**Intake:** phone/agent quick-create, chat widget, WhatsApp/SMS channel,
form builder, duplicate detection by embed/requester/subject.
**SLAs:** pause conditions (customer waiting), multiple concurrent SLAs,
holiday calendars, breach post-mortems.
**Agents:** presence, collision detection ("who is viewing"), collision avoid,
saved views, keyboard-first command palette.
**Reporting:** custom dashboards, scheduled CSV/PDF exports, data warehouse
connector, anomaly alerts.
**Admin:** configuration-as-code export/import, environment promotion, feature
flags, impersonation with audit.
**Security & IR:** IDS/IPS false-positive workflow, detection-coverage map,
approval-gated auto-containment (fully audited), threat-intel enrichment,
war-room comms, tabletop exercises built from past incidents.
**Evidence & assurance:** evidence-request portal for insurers/auditors, signed
packet verification tool, retention + legal-hold automation, tamper alarms on the
audit chain, third-party timestamping.

## 10. Non-functional targets

- **Availability:** 99.9% for hosted; no maintenance windows for ticket writes.
- **Latency:** p95 ticket read < 300 ms, p95 write < 500 ms at target load.
- **Scale:** 10,000 agents / 1,000,000 tickets per tenant without re-platforming.
- **Security:** tenant isolation tests in CI; encryption at rest and in transit;
  least-privilege roles; secrets never logged.
- **Audit integrity:** hash-chained append-only log, daily signed checkpoints,
  tamper alarms — retroactive edits are detectable, not merely discouraged.
- **Evidence retention:** per-tenant retention policies, legal-hold override,
  WORM object storage, documented RPO/RTO for evidence.
- **Time integrity:** server-authoritative UTC timestamps; optional trusted
  timestamping for evidence items.
- **Compliance path:** GDPR data-subject requests; evidence redaction; SOC 2 Type
  II readiness; support for cyber-insurance questionnaires.

## 11. Success metrics

| Metric | Why |
| --- | --- |
| First-response & resolution time (median, p90) | Core service quality |
| SLA attainment % | The promise kept |
| Tickets auto-routed / deflected | Automation payoff |
| Knowledge articles reused per ticket | Knowledge health |
| CSAT | Requester perception |
| Billable utilisation (MSP) | Revenue impact |
| Time-to-first-tenant (hosted) | Onboarding friction |
| Incident MTTA / MTTR | Response effectiveness |
| Detection-to-ticket latency | Telemetry pipeline health |
| % incidents with a complete evidence packet | Documentation completeness |
| Audit / insurance requests answered from the system | Assurance payoff vs archaeology |
| SSO + MFA coverage of staff | Identity posture |

## 12. Risks & open questions

- **Build vs integrate** for RMM/remote control — likely integrate, not build.
- **Email deliverability & threading** is the hardest intake problem; needs an
  early spike.
- **AI scope** — keep it assistive and opt-in; never auto-send to requesters
  without human approval.
- **On-prem distribution** — decide whether single-tenant self-host is v1 or post-v1.
- **SLA breadth** — resist full ITIL until M5 lands; avoid over-modelling early.
- **Evidence scope vs noise** — capturing everything is costly; decide what
  counts as evidence and for how long, per client.
- **Privacy vs evidence** — gathering incident evidence can sweep up personal
  data; redaction and data-subject handling must exist from M0, not after.
- **Hash-chain key management** — checkpoint signing needs a key-management story
  and a verification tool before anyone relies on it.
- **Telemetry normalization** — IDS/IPS/SIEM/EDR vendors differ wildly; budget for
  a mapping layer and a per-vendor connector backlog (adapters behind one seam).
- **Auto-containment** — IPS-driven containment is powerful and dangerous; keep it
  approval-gated and fully audited in v1, never silent.
- **Training-product coupling** — share patterns and a component package, but keep the
  two deployable independently.

## 13. Immediate next steps (first two sprints)

1. Repo bootstrap mirroring OnTrak IT Support Training conventions (`typecheck`, `test`, `build`,
   `*-rules.ts` pure-logic modules, server-action guards).
2. Auth + RBAC + tenant-isolation test harness (the gate everything else relies on).
3. **Audit-integrity foundation:** hash-chained, append-only audit log emitting
   from day one — the assurance spine the incident work hangs off.
4. Prisma schema for M0 entities (`Tenant`, `User`, `Client`, `Contact`, `Queue`,
   `Ticket`, `Message`, `AuditEvent`) + seed.
5. Ticket CRUD + conversation thread + audit trail.
6. IdP and security-telemetry connector spikes — each an adapter behind one
   interface, mirroring the training platform's driver seam.
7. Email-ingestion spike (inbound parse + threading) behind a feature flag.
8. Minimal agent inbox UI and requester portal.
