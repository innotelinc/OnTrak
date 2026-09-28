# OnTrak Sentinel

An **identity and network-defense platform**: a standards-compliant **Identity
Provider (IdP)** and an **intrusion detection & prevention (IDS/IPS)** engine,
sharing one identity-centric data model. An [Innotel Labs](../INNOTEL-LABS.md)
product.

OnTrak Sentinel is the security backbone of the Innotel Labs family. It issues
identity for [OnTrak Tix](../ontrak-tix/README.md) and
[OnTrak IT Support Training](../README.md), and it is the source of the security
telemetry that drives their incident response.

```
        ┌──────────────────────────── OnTrak Sentinel ────────────────────────────┐
        │                                                                           │
        │   ┌──────────────────────┐          ┌──────────────────────────────┐   │
        │   │  Sentinel Identity    │          │  Sentinel Guard               │   │
        │   │  IdP · OIDC/SAML      │  who →   │  IDS/IPS · flow + host        │   │
        │   │  SCIM · MFA · policy  │  ◀────→  │  detections · prevention      │   │
        │   └──────────────────────┘          └──────────────────────────────┘   │
        └───────────────────────────────────────────────────────────────────────┘
                     │ identity                     │ alerts / incidents
                     ▼                              ▼
            OnTrak Tix · Training            OnTrak Tix incident response
```

## Two pillars, one product

- **Sentinel Identity (IdP).** OpenID Connect and SAML single sign-on, SCIM
  provisioning, enforced MFA, session and device control, role/policy
  administration, and a complete, auditable trail of authentication and
  privilege events.
- **Sentinel Guard (IDS/IPS).** Network and host intrusion detection with
  signature and behavioural rules, plus **prevention** actions (block, quarantine,
  rate-limit) that are policy-gated, approval-aware and fully logged.

They share one model: an identity has sessions, devices, access grants, and the
alerts raised about it. That shared model is what lets Sentinel answer *"who is
this, what can they reach, and what have they done"* in one place.

## Design principles

- **Standards first.** OIDC, SAML 2.0, SCIM 2.0, STIX/TAXII-friendly
  interoperability, syslog/OTel telemetry export.
- **Safe by default.** Prevention actions are deny-listed from dangerous targets,
  rate-limited, reversible where possible, and always audited.
- **Evidence-grade.** Every decision — an auth grant, a block, a policy change —
  is append-only, hash-chained and exportable, matching the assurance model used
  across Innotel Labs.
- **Deploy anywhere.** Single-tenant self-hosted or hosted multi-tenant from one
  image; a drop-in IdP for the rest of the family.

## Status

**S0 in progress.** The identity spine has begun:

- `src/lib/audit-chain.ts` — the hash-chained, append-only audit log with
  tamper detection (the evidence spine).
- `src/lib/identity-rules.ts` — pure session and enforcement-approval rules.
- `prisma/schema.prisma` — the S0 data model draft (organizations, identities,
  sessions, the chained `AuditEvent`).

The full platform is built *after* OnTrak Tix; see [ROADMAP.md](./ROADMAP.md).

Run the S0 tests with:

```bash
npx tsx --test ontrak-sentinel/tests/sentinel.test.ts
```
