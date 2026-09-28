# OnTrak Tix — Product & Engineering Roadmap

> Status legend: `[x]` done · `[~]` in progress · `[ ]` planned · `[-]` out of scope for v1
>
> This file is the single source of truth for **what** we are building and in
> **what order**. It is deliberately opinionated; each milestone lists explicit
> exit criteria so "done" is not a matter of taste.

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

### M0 — Foundations & intake `[~]`
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
> (`compliance-service.ts`), and a **standalone verifier** for a third party
> holding only a packet and the key (`scripts/verify-packet.ts`). What remains in
> M3: incident communications templates, and a retention sweep that walks expired
> artifacts rather than waiting to be asked.
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

### M1 — Service desk basics `[~]`
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

### M3 — Incident response & defensible documentation `[~]`
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
  - `[ ]` Communications templates: the duty, its clock and its acknowledgement
    are tracked, but the message itself is typed each time — the M1 canned
    responses are not yet offered from an incident's regimes.
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

### M4 — MSP & multi-client `[ ]`
**Goal:** one desk serving many clients safely.

- Clients/companies, contacts, per-client SLAs, branding and portal identity.
- Cross-client agent views with strict scoping and "act as client" guardrails.
- Time tracking, rate cards, billable vs non-billable, invoice-ready exports.
- Shift handoff: on-call schedules, rota, coverage windows.
- Per-client reporting and a client-facing satisfaction (CSAT) survey.
- **Exit:** an agent works two clients without data bleed; time entries export to
  an invoice line; per-client SLA attainment is reportable.

### M5 — Automation & knowledge `[ ]`
**Goal:** reduce manual work and capture know-how.

- Rules engine: trigger (+conditions) → actions (set field, route, notify, reply,
  tag, escalate); dry-run and rule test harness.
- Macros (multi-step agent shortcuts) and public/private knowledge base with
  article suggestions on ticket create.
- Self-service deflection: suggested articles on the portal before submission.
- CSAT dashboards and knowledge-gap reporting (repeat tickets with no article).
- **Exit:** rules cover the top intake paths; ≥30% of new tickets are auto-routed
  or deflected; KB suggestions measurably cut handling time.

### M6 — Platform & integrations `[ ]`
**Goal:** fit into the surrounding toolchain.

- Public REST API + webhooks with scoped tokens, rate limits and delivery logs.
- Integrations (beyond the M2 IdP and M2 telemetry): RMM/monitoring (alert →
  ticket with auto-resolve), Slack/Teams, and a marketplace pattern for
  third-party connectors.
- Custom fields, ticket forms and per-queue layouts.
- Enterprise controls: granular roles, audit-evidence export, data-retention and
  legal-hold policies.
- **Exit:** a monitoring alert opens a ticket and closes it when the alert clears;
  audit evidence exports on demand; the API is versioned and documented.

### M7 — Intelligence & scale `[ ]`
**Goal:** enterprise hardening and assistance.

- AI assist (opt-in): classification/routing suggestions, thread summarisation,
  draft replies, similar-ticket retrieval — always human-approved.
- Analytics: trends, forecasting, agent/queue scorecards, SLA risk modelling.
- Performance/multi-region hardening, backup/DR runbooks, SOC 2-ready controls.
- **Exit:** documented scale targets met under load test; AI suggestions are
  measurable, reversible and never auto-send.

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
