# OnTrak Sentinel — Product & Engineering Roadmap

> Identity Provider (IdP) + Intrusion Detection & Prevention (IDS/IPS). An
> [Innotel Labs](../INNOTEL-LABS.md) product, built **after** OnTrak Tix.
>
> Status legend: `[x]` shipped · `[~]` in progress · `[ ]` planned · `[-]` out of scope for v1

---

## 1. Vision

One platform that answers, for every person and every packet: **who is this, what
are they allowed to reach, and what are they actually doing** — and can enforce
the answer. A standards-compliant IdP and an IDS/IPS that share a single,
identity-aware data model, so detection can reason about identity and prevention
can act on it.

## 2. Scope

### Pillar A — Sentinel Identity (IdP)
**In scope:** OIDC and SAML 2.0 SSO; SCIM 2.0 provisioning/deprovisioning;
enforced MFA (TOTP, WebAuthn); session and device management; roles, groups and
attribute-based policy; admin console; full authentication/privilege audit;
token/refresh lifecycle; tenant branding.

**Non-goals:** being a general-purpose CIAM or social-login platform; storing
customer PII beyond identity needs; replacing a directory (we sync *from* AD/
Entra/Google, we don't replace it).

### Pillar B — Sentinel Guard (IDS/IPS)
**In scope:** network (flow/DPI) and host telemetry ingest; signature and
behavioural/anomaly detection; alert triage and correlation; **prevention**
actions (block, quarantine, rate-limit) that are policy-gated, approval-aware,
reversible and audited; detection-coverage mapping; threat-intel enrichment;
export to OnTrak Tix as incidents.

**Non-goals:** offensive/exploitation tooling; becoming an endpoint agent
(we ingest host telemetry from agents we integrate with); being a full SIEM/log
warehouse; guaranteeing zero false positives.

## 3. Architecture

- **Stack:** Next.js (admin console) + TypeScript services + PostgreSQL
  (config/identity/metadata); a columnar/time-series store for high-volume
  telemetry; Redis for sessions and queues.
- **Data plane:** stream ingest (syslog, eBPF host telemetry, NetFlow/IPFIX,
  OTel) → normalizer → detection engine → alert/incident store → policy engine
  → enforcement.
- **Control plane:** admin console and APIs for identity, policy, rules and
  approvals.
- **Identity-aware detection:** the correlation key between what a user *may* do
  (identity/policy) and what the network *sees* them do.
- **Adapters:** every telemetry source and every enforcement target (firewall,
  EDR, switch ACL, proxy) sits behind one interface, so vendors are swappable —
  the same seam pattern used across Innotel Labs.
- **Deployment:** single-tenant self-hosted and hosted multi-tenant from one
  image; HA for the data plane and the IdP.

## 4. Data model (first cut)

- `Organization` / `Tenant` — isolation boundary.
- `Identity` (human/service), `Credential`, `MfaFactor`, `Session`, `Device`.
- `DirectoryConnection` (AD/Entra/Google), `ScimToken`, `Group`, `Role`, `Policy`.
- `AuthEvent`, `GrantEvent` — append-only, hash-chained.
- `Sensor` / `Source` — where telemetry comes from; `Detection` (signature or
  behavioural), `DetectionVersion`.
- `ObservedEvent` — a normalized network/host observation.
- `Alert` → `Incident` (shared shape with OnTrak Tix), `Correlation`.
- `EnforcementAction` — desired state, approvals, applied state, rollback.
- `ThreatIntelIndicator`, `IntelFeed`.
- `AuditEvent` — the cross-cutting, hash-chained evidence log.

## 5. Cross-cutting — evidence & assurance

Identical model to OnTrak Tix (one shared record format across Innotel Labs):

- **Append-only, hash-chained** audit of every auth grant, policy change, block
  and unblock; signed checkpoints.
- **Attributable** actions (which admin/system, from where, when), with approvals
  captured as part of the record.
- **WORM retention** and legal hold for security evidence.
- **Exportable assurance packets** for auditors, insurers and regulators —
  including *why* a block fired and *who* authorised it.
- **No silent actions, no backdating, no deletion of history.**

## 6. Milestones

### S0 — Foundations `[~]`
**Goal:** the identity spine and the evidence log.

- Org/tenant model, users, sessions, credentials; append-only hash-chained audit
  from day one.
  - `[x]` **The spine** (`identity-service.ts`, `identity-rules.ts`,
    `audit-chain.ts`): organizations, identities and sessions, with every read
    and write scoped to the caller's organization, and an identity in another
    organization simply *absent* rather than forbidden — the answer is the same
    as for an id that never existed, which is the only answer a caller can act on
    without learning about another tenant. There is **one evidence chain per
    organization** rather than one chain filtered by tenant: a filter is a query
    somebody can forget, a separate chain is a different object. An organization
    cannot be left with no active administrator, an identifier is unique within
    an organization and not across them, and ending a session — or every session
    an identity holds — needs a reason on the record.
  - `[x]` **Sessions are policy-gated at grant *and* at read**, through the same
    pure `sessionDecision`: an inactive identity, a second factor owed under a
    policy that requires one, an idle timeout and an absolute lifetime each
    refuse a session — and a deactivated identity loses its sessions without
    anyone having to revoke them.
  - `[x]` **A project of its own**: `package.json`, `tsconfig.json`, its own test
    harness (`npm test`) and a job in the shared CI run. The exit criterion asks
    for tenant isolation to be covered by CI tests, so it is — including that one
    organization's audit trail is not reachable from another's.
  - `[ ]` The Prisma adapter and the first migration — `prisma/schema.prisma` is
    still a draft, and the spine runs on an in-memory store until it is not —
    plus the API surface and an admin console shell.
- Admin console shell; APIs; policy skeleton.
- **Exit:** an admin creates an identity, sees every action in the tamper-evident
  log, and tenant isolation is covered by CI tests.

### S1 — Sentinel Identity v1 `[ ]`
**Goal:** a standards-compliant IdP the family can rely on.

- OIDC authorization-code + PKCE; SAML 2.0 SSO; well-known discovery; JWKS.
- Enforced MFA (TOTP, WebAuthn), session/device management, logout and token
  revocation.
- Roles, groups and attribute-based access policies; tenant branding.
- **Exit:** OnTrak Tix and Training sign in through Sentinel via OIDC and SAML;
  MFA is enforced; auth and privilege events are fully audited.

### S2 — Provisioning & lifecycle `[ ]`
**Goal:** identities stay in sync without manual work.

- SCIM 2.0 server (Users/Groups); directory sync (AD/Entra/Google) with safe
  conflict resolution.
- Joiner/mover/leaver workflows; access reviews; automatic deprovisioning and
  session kill on offboarding.
- **Exit:** creating/removing a user in a source directory provisions and
  deprovisions in Sentinel and downstream apps automatically, with an audit trail.

### S3 — Sentinel Guard v1 (detection) `[ ]`
**Goal:** see what is happening.

- Telemetry ingest (syslog, NetFlow/IPFIX, host agent, OTel) into the normalizer.
- Signature + behavioural detection rules; rule versioning and test harness.
- Alert triage, correlation, dedupe and enrichment; detection-coverage map.
- **Exit:** a known-bad pattern is detected from live telemetry, deduped and
  correlated into one alert linked to an identity, device and asset.

### S4 — Sentinel Guard v1 (prevention) `[ ]`
**Goal:** act — safely and accountably.

- Policy-gated enforcement actions (block, quarantine, rate-limit) with
  approvals, safe-lists for critical infrastructure, and one-click rollback.
- Reversible-by-default, rate-limited, blast-radius caps; every action audited.
- **Exit:** a threat is blocked within a defined latency; the block is approved,
  logged, reversible, and cannot be applied to a protected target.

### S5 — Unified risk & response `[ ]`
**Goal:** identity and network see the same picture.

- Identity-aware detection (a login from a new geolocation plus anomalous flows
  becomes one incident, not two alerts).
- Step-up authentication and session revocation triggered by a detection.
- Playbook-driven response, exporting incidents into OnTrak Tix with full
  evidence.
- **Exit:** an incident correlates identity + network signal, exports to Tix, and
  a step-up/revoke action is applied and audited.

### S6 — Enterprise hardening `[ ]`
**Goal:** run it at scale, prove it.

- Multi-tenant isolation, HA/failover, backup/DR, scale-out data plane.
- SOC 2-ready controls; audit/evidence exports for cyber-insurance; retention
  and data-subject handling.
- Threat-intel feeds (STIX/TAXII), partner/EDR/firewall integrations.
- **Exit:** documented scale targets met under load; an assurance packet exports
  for an auditor; HA failover tested.

## 7. Why IdP + IPS together

Standalone IDS sees packets with no notion of identity; a standalone IdP sees
logins with no notion of behaviour. Together they produce signals neither can:

- **Identity-aware prevention** — block not just an IP, but a compromised
  identity's sessions and lateral path.
- **Behaviour-aware identity** — require step-up MFA when flows indicate a
  session is no longer trustworthy.
- **One evidence trail** — a single signed record from "who logged in" through
  "what they did" to "what we blocked and who approved it".

## 8. Non-functional targets

- **IdP:** p95 auth < 250 ms; 99.95% availability (it is on the login path).
- **Detection:** configurable time-to-detect; time-to-prevent target < 1 s in-path.
- **Throughput:** scale to millions of events/min per tenant; back-pressure safe.
- **Safety:** prevention cannot target protected assets; all actions reversible
  and audited; blast-radius caps enforced.
- **Security:** least privilege, encrypted secrets, signed rule/intel updates.
- **Compliance path:** SOC 2 readiness; GDPR; audit/evidence export.

## 9. Success metrics

| Metric | Why |
| --- | --- |
| Time-to-detect / time-to-prevent | Core protection |
| False-positive rate per rule | Analyst trust |
| % alerts correlated to an identity | Identity-aware value |
| MFA/SSO coverage of downstream apps | Adoption |
| Deprovisioning latency (leaver → access removed) | Lifecycle safety |
| Enforcement actions with recorded approval | Accountability |
| Assurance packets exported | Audit/insurance value |

## 10. Risks & open questions

- **Prevention blast radius** — an IPS can take down the network; safe-lists,
  approvals and rollback are mandatory, not optional.
- **Telemetry scale & cost** — high-volume ingest needs a tiered store and
  sampling strategy; decide early.
- **Vendor landscape** — EDR/firewall vendors are numerous; keep one adapter
  interface and grow connectors incrementally.
- **IdP availability** — it is on the critical login path; HA must land before
  other products depend on it.
- **Privacy** — security telemetry is personal data; retention, redaction and
  lawful-basis handling must be designed in.
- **Scope control** — resist becoming a full SIEM; stay identity-first and
  detection/prevention-focused.

## 11. Immediate next steps

1. Stand up the identity spine (S0): orgs, identities, sessions and the
   hash-chained audit log.
2. Implement OIDC authorization-code + PKCE as the first usable IdP capability.
3. Build the telemetry normalizer and one detection rule end to end (S3 spike).
4. Define the shared assurance-packet format with OnTrak Tix before either ships
   exports, so both are compatible from the start.
