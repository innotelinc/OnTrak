# SOC 2 control mapping

> M7's "SOC 2-ready controls" deliverable. SOC 2 is an *attestation* — a qualified
> auditor tests whether the controls a service says it runs actually run. This
> document is therefore not "we are certified"; it is the **control narrative** an
> auditor starts from: each Trust Services Criterion, the control that answers it,
> where in this repository that control lives, and how it is evidenced.
>
> Criteria are from the AICPA 2017 Trust Services Criteria (with the 2022 revised
> points of focus). This maps the **Security** (common criteria, CC), **Availability**
> (A) and **Confidentiality** (C) categories. Processing Integrity and Privacy are
> noted where they overlap; a full mapping is audit work, not repository work.

## How to read this

- **Control** — one sentence an auditor can test.
- **Where** — the module, route or table that implements it. A control with no
  location is a promise; a control with a location is testable.
- **Evidence** — how a run produces proof.

## Common criteria (Security)

### CC6 — logical and physical access

| Ref | Control | Where | Evidence |
| --- | --- | --- | --- |
| CC6.1 | Access is granted by role, and every privileged route re-checks the caller rather than trusting the UI. | `src/lib/access-rules.ts` (pure), `requireActor()` at the head of every server action. | The access-rules tests; each action starts from the actor. |
| CC6.1 | Tenancy isolates one desk from another; every domain row carries `tenantId`. | `src/lib/session-rules.ts`, every Prisma store's `tenantId` scope. | `tests/tix-m4-clients.test.ts`, the tenant-isolation cases. |
| CC6.2/6.3 | Staff authenticate through the tenant IdP (OIDC), with enforced MFA and group→role mapping. | `src/lib/identity-rules.ts`, `oidc-rules.ts`, `oidc-client.ts`; SAML is stored and refused, never half-implemented. | `tests/tix-m2-sso.test.ts`, `tix-m2-sso-local-idp.test.ts`, opt-in `tix-m2-sso-live.test.ts`. |
| CC6.4 | Leavers lose access: SCIM deprovisioning ends sessions and revokes tokens. | `src/lib/scim-rules.ts`, `scim-sync-service.ts`. | `tests/tix-m2-scim-push.test.ts`, opt-in `tix-m2-scim-live.test.ts`. |
| CC6.6/6.7 | The local break-glass account is unlinked, unindexed, and can be closed entirely. | `/sign-in/break-glass`, `ONTRAK_TIX_ALLOW_LOCAL_SIGN_IN=0`. | The page's `robots: noindex` and its absence from `/sign-in`. |
| CC6.8 | Every authentication and privilege event is audited on the hash chain. | `identity-service.ts` → `PrismaAuditSink`. | `auth.sso_sign_in` and the refusal rows in the chain. |

### CC7 — system operations

| Ref | Control | Where | Evidence |
| --- | --- | --- | --- |
| CC7.1 | The audit log is append-only and hash-chained; retroactive edits are detectable. | `src/lib/audit-chain.ts`, `PrismaAuditSink`. | Chain verification on `/admin`; the tamper tests in `tix-db.test.ts`. |
| CC7.2 | Detection coverage and incident response are tracked as first-class records. | `security-alert-rules.ts`, `incident-rules.ts`, the `/security` and `/incidents` consoles. | `tix-m2-telemetry.test.ts`, `tix-m3-incidents.test.ts`. |
| CC7.3 | Incidents run a severity-gated lifecycle with a contemporaneous timeline. | Phase ladder + role staffing in `incident-rules.ts`; append-only `IncidentEvent`. | `tix-m3-incidents.test.ts`. |
| CC7.4/7.5 | A resolved incident produces a signed, reproducible assurance packet. | `assurance-rules.ts`, `assurance-sign.ts`, `GET /api/incidents/[id]/packet`, `scripts/verify-packet.ts`. | `tix-m3-assurance.test.ts`; the standalone verifier. |

### CC8 — change management

| Ref | Control | Where | Evidence |
| --- | --- | --- | --- |
| CC8.1 | The database schema changes only through versioned migrations applied by every environment. | `prisma/migrations`, applied by `prisma migrate deploy`. | CONTRIBUTING.md's migration rule; the migration history. |

### CC9 — risk mitigation

| Ref | Control | Where | Evidence |
| --- | --- | --- | --- |
| CC9.1 | Evidence is write-once (WORM); retention cannot be shortened and removal is gated. | `object-lock-rules.ts`, `object-lock-file.ts`, the `EvidenceArtifact` table. | `tix-m3-object-lock.test.ts`; the browser sweep's lock cases. |
| CC9.1 | Legal hold outranks routine retention in both directions. | `retentionDecision`, `LegalHold`. | `tix-m3-retention.test.ts`. |

## Availability (A)

| Ref | Control | Where | Evidence |
| --- | --- | --- | --- |
| A1.1 | Capacity and performance targets are stated and measured. | §10 of `ROADMAP.md` (p95 read < 300 ms, write < 500 ms; 10k agents / 1M tickets per tenant). | The recorded result at the target load — [`docs/load-test.md`](./load-test.md) and `docs/load-test-2026-10-09.json` (`npm run load-test`). It records both halves: a ticket read and a reply write meet the stated p95, and the whole-worklist read and a create write **do not**, with the cause of each named. |
| A1.2 | Backups are taken, verified and restorable to a stated RPO/RTO. | [`docs/disaster-recovery.md`](./disaster-recovery.md), `scripts/backup.sh`, `scripts/restore.sh`. | The quarterly rehearsal record (§6 of the runbook). |
| A1.3 | A failed backup is distinguishable from a good one. | `backup.sh` exit code `2` = written but did not verify. | The backup log; a `2` is an alert, not a warning. |

## Confidentiality (C)

| Ref | Control | Where | Evidence |
| --- | --- | --- | --- |
| C1.1 | Secrets live in Cerulean Vault, not in the repository; shared secrets are reported by *name*, never by value. | `scripts/vault-env.mjs`; the integrations panel reports variable names. | The `secret-scan` guard; the panel's `configured` state. |
| C1.1 | Multi-client data is scoped at read *and* write, not only filtered in the UI. | `client-rules.ts`, the worklist scope, per-write client checks. | `tix-m4-clients.test.ts`; the browser sweep's 404-on-unserved-client case. |
| C1.2 | Personal data in evidence is handled with redaction and least privilege. | `ROADMAP.md` §7 (privacy-respecting principles); staff-only incident surfaces. | The incident console's `ticket:update` gate. |

## What is *not* here (and is an operator's, not the product's)

An attestation also covers controls this repository cannot implement for you:

- **Physical access** (CC6.5/6.6 physical) — the host and its facility.
- **Vendor management** (CC9.2) — the registries, the identity provider, the object
  store: each is a subservice organisation to be assessed and, where relevant, to
  have its own report.
- **Organisational governance** (CC1–CC5) — policy, board oversight, HR controls.
- **The audit itself** — an independent auditor's testing of the controls above.

The product's contribution is that the **technical controls leave a record**. The
operator's contribution is everything that surrounds them.
