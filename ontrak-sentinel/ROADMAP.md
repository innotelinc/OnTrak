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
  - `[x]` **The Prisma adapter and the first migration**
    (`identity-store-prisma.ts`, `identity-server.ts`,
    `prisma/migrations/20260928000000_init`): the schema now matches the domain
    records — `Identity.mfaEnrolled` and `Session.expiresAt` are columns rather
    than hopes — every table carries the `organizationId` it belongs to with a
    cascading foreign key, and `AuditEvent` is unique on
    `(organizationId, seq)` rather than on `seq` alone, because the spine keeps
    one chain per organization and the sequence number is a position *inside* a
    chain. The client is described structurally, so the adapter runs against the
    generated client, a fake, or a later repository layer; the durable trail
    verifies an organization's chain before extending it and refuses to build on
    a tampered history. Applied and checked in CI (the schema must generate), with
    an opt-in live test against a real Postgres
    (`tests/sentinel-postgres-live.test.ts`).
  - `[x]` **The API surface, and the console shell beside it** (`oidc-http.ts`,
    `oidc-server.ts`, `console-rules.ts`, `console-service.ts`, `console-http.ts`):
    the endpoints landed with S1 — discovery, JWKS, authorize, token, userinfo, SAML
    metadata, SAML SSO — and the console that S0 owed is now a third pure router on
    the same listener. Three pages, no framework: an overview that shows who you are,
    whether a second factor is enrolled, and the organization's evidence chain with
    its verification result; a second-factor page that enrolls, confirms and removes
    TOTP factors and security keys; and a sign-out that ends the session and revokes
    the tokens it minted. Server-rendered from data through one escaping function, so
    an identity's own display name cannot become markup on its own page. The
    registry's image and compose stack is still to come.
- Admin console shell; APIs; policy skeleton.
- **Exit:** an admin creates an identity, sees every action in the tamper-evident
  log, and tenant isolation is covered by CI tests.

### S1 — Sentinel Identity v1 `[~]`
**Goal:** a standards-compliant IdP the family can rely on.

- OIDC authorization-code + PKCE; SAML 2.0 SSO; well-known discovery; JWKS.
  - `[x]` **The authorization-code flow with PKCE** (`oidc-rules.ts`,
    `oidc-service.ts`, `oidc-keys.ts`): the IdP half of what M2 built on the
    client side in Tix. A client is registered with exact redirect URIs (`https`,
    or `http` only on a loopback address) and the scopes it may ask for; every
    authorization request is checked against it, with the redirect URI settled
    *first* so an error is only ever sent somewhere we recognise; **PKCE with
    S256 is required of every client**, so a code that leaks is useless without
    the verifier; a code is single-use and lives sixty seconds, and it is spent
    the moment it is presented — before the verifier is judged — so the token
    endpoint is not an oracle for guessing it. The session behind the grant is
    resolved through the S0 spine, so an OIDC sign-in cannot get around a
    deactivated identity, an unenforced second factor or an idle timeout. ID
    tokens are signed RS256 with a published JWKS whose private half never leaves
    the provider; the access token is stored as a hash, for the same reason a
    credential is. Discovery advertises only what is implemented — `none` as the
    token endpoint auth method, because client secrets are not built yet. Every
    registration, grant and refusal is on the organization's evidence chain.
    Covered by `tests/sentinel-oidc.test.ts`.
  - `[x]` **The HTTP surface** (`oidc-http.ts`, `oidc-server.ts`,
    `npm run serve`): discovery, JWKS, authorize, token and userinfo, as a **pure**
    router over plain request/response shapes, so every endpoint is tested with
    no socket — and a thin `node:http` adapter that turns the request line into
    an absolute URL (honouring `X-Forwarded-Proto`) and caps the body. The edge
    keeps the same three promises the engine does: an error is only ever
    redirected to a redirect URI that was registered, the session travels in a
    cookie (`sentinel_session`) or the `X-Sentinel-Session` header rather than a
    query string, and a token response is `no-store`. The suite drives every
    endpoint through the router **and** once through a real socket. Covered by
    `tests/sentinel-oidc-http.test.ts`.
  - `[x]` **Persisted clients, codes and tokens** (`oidc-store-prisma.ts`, the
    second migration `prisma/migrations/20260929000000_oidc`,
    `createOidcServices` in `oidc-server.ts`): the grant rows now live where the
    identities do. `OidcClient`, `AuthorizationCode` and `AccessToken` each carry
    the `organizationId` they belong to with a cascading foreign key, exactly as
    S0's tables do, and the access token is keyed on `SHA-256(token)` rather than
    on the token — a copy of the database is a list of sessions that have ended,
    not a set of credentials that work. The port's one subtle obligation is
    honoured literally: **`markCodeUsed` is a single conditional write**
    (`updateMany` where `usedAt` is still null), so two exchanges racing on one
    code cannot both win — the loser gets `false` rather than a second token.
    `npm run serve` uses the durable stores whenever `DATABASE_URL` is set (and
    says which mode it is in), and bootstraps idempotently, so a restart no
    longer forgets the organization, the client or the grants. Covered by
    `tests/sentinel-oidc-store-prisma.test.ts`, which drives the whole flow over
    the Prisma-shaped rows and then resolves an already-issued token through a
    *second* service instance — the difference between persisting grants and
    merely caching them. CI now applies both migrations to a real Postgres and
    diffs them against the models, so a hand-edited SQL file cannot drift.
  - `[x]` **SAML 2.0** (`saml-rules.ts`, `saml-service.ts`, `saml-sign.ts`,
    `saml-http.ts`, the `SamlServiceProvider` table in the third migration): the
    second protocol the family can sign in with, and deliberately a separate
    table from `OidcClient` rather than a widened one — the two answer the same
    question with different fields, and pretending they are one record would mean
    every reader checking which half it is looking at. An `entityId` is the
    primary key because an AuthnRequest arrives naming it and nothing else, so it
    has to resolve to exactly one organization; the ACS URL is matched **exactly**
    against what was registered, because SAML has no PKCE and no code — the
    assertion *is* the credential — and a prefix match is how one is delivered to
    somebody else's origin. A request older than five minutes is refused, so a
    captured one is not a sign-in tomorrow, and the `InResponseTo` the SP chose is
    echoed so it can match the answer. The assertion is signed with the **same
    key** the ID tokens use (one key pair, one rotation), and the signature is
    XML-DSig enveloped over an assertion written with no inter-element whitespace
    — so exclusive canonicalisation is the document, and `assertionCanonical` is a
    deletion of the signature block rather than a re-serialisation. `saml-sign.ts`
    verifies it the way an SP does: RSA over `SignedInfo` first, then the digest
    recomputed from the bytes that arrived, so an edited attribute fails even
    though `SignedInfo` is untouched. Success is an auto-submitting **form post**,
    never a redirect, because an assertion in a query string is a credential in a
    proxy log. Metadata is public and tenant-independent, says
    `WantAuthnRequestsSigned="false"` out loud, and advertises no artifact or
    attribute-query service. The NameID format is the registration, not each
    request's wish: a request that asks for a different known format is refused,
    so a per-request parameter cannot widen what an administrator decided. Covered
    by `tests/sentinel-saml.test.ts`.
  - `[~]` Deployable key management: `SENTINEL_SIGNING_KEY` loads the signing key
    from a PEM so it stays out of the source tree and out of a generated one, and
    the SAML signature and the JWKS publish the same material — a second key would
    be a second thing somebody forgets to rotate. Rotation itself (publishing a
    second `kid` and switching) is still to come.
- Enforced MFA (TOTP, WebAuthn), session/device management, logout and token
  revocation.
  - `[x]` **TOTP second factors** (`mfa-rules.ts`, `mfa-service.ts`,
    `mfa-store-prisma.ts`, `MfaFactor.confirmedAt`/`lastUsedAt`/`lastUsedCounter`
    in the fourth migration `20261001000000_mfa_totp`): S0 stored a boolean called
    `mfaEnrolled` and refused every session while it was false — the policy
    working, and also a dead end, because nothing could make it true by *proving*
    anything. The arithmetic is RFC 6238 over HMAC-SHA-1 with a thirty-second step
    and **one step of drift either way**, which is the drift a phone's clock and a
    server's clock actually have; widening it is how six digits become guessable,
    and narrowing it is how a correct code is refused once a month. Enrollment is
    two steps on purpose: a secret is generated and shown once, and the flag is set
    only after a code from that secret verifies — so a secret that never reached
    the app cannot leave an identity looking enrolled and unable to sign in. A
    verified step is recorded and **never accepted again**, because otherwise a
    captured code stays valid for the rest of its window and the second factor is
    only as good as the password it was meant to strengthen. The flag is still set
    through `IdentityService.setMfaEnrolled`, so there is one writer of the field
    every session decision reads, and the secret — the one value in Sentinel that
    has to be readable rather than hashed, since a code is computed *from* it — is
    documented as the deployment's to encrypt rather than quietly stored in the
    clear. Enrollment is **self-service** — see the console bullet below, which is
    where the actor became the person rather than an administrator — and
    verification needs no actor at all, because it is called from the login path
    where the password has already been checked. `npm run serve` enrolls the demo
    administrator's factor through this path and prints the `otpauth://` URI rather
    than flipping a boolean. Covered by `tests/sentinel-mfa.test.ts`, including the RFC's own test
    vectors.
  - `[x]` **Logout and token revocation** (`oidc-rules.ts`, `oidc-service.ts`,
    `oidc-http.ts`, `identity-service.ts`, `AccessToken.revokedAt` in the third
    migration): sign-out is two things and both are required for it to mean
    anything — the **session** is ended through the S0 spine, so every other entry
    point (a fresh authorize, a userinfo read) sees it as dead, and every **access
    token** the session minted is revoked in one statement, because a client that
    kept one would otherwise keep working after the user left. Ending the session
    alone leaves already-issued tokens live; revoking the tokens alone leaves the
    session usable for another code. `endOwnSession` is deliberately not
    `revokeSession`: holding the session id *is* the proof, so sign-out does not
    require an administrator — which is how a session outlives its user. The
    organization comes from the named client and never from the request's own idea
    of who it is, so a sign-out cannot reach another tenant. `post_logout_redirect_uri`
    is honoured only when the client registered it and **dropped** otherwise — the
    session still ends, and we simply do not send the browser anywhere — which is
    what keeps an IdP from becoming an open redirector. Revocation (RFC 7009) is
    reached with the token itself, needs no secret, answers `200` identically for a
    dead token and one that never existed (the difference would be a token oracle),
    and is a conditional write so two revocations racing produce one kill. An
    expired-but-unrevoked token and a revoked one are one question asked in one
    place (`isTokenActive`), so a killed token cannot come back to life by being
    presented somewhere else. Every refusal, grant, sign-out and revocation is on
    the organization's evidence chain. Covered by `tests/sentinel-logout.test.ts`.
  - `[x]` **WebAuthn as a second factor** (`webauthn-rules.ts`,
    `webauthn-service.ts`, `MfaFactor.publicKey`/`signCount` and the
    `WebAuthnChallenge` table in the fifth migration `20261015000000_webauthn`):
    a security key beside the authenticator app, and the same delivery discipline
    the rest of S0 has — a challenge is a **row**, spent by a conditional
    `updateMany`, so "accepted exactly once" holds across two workers rather than
    inside one process's memory, and it expires in two minutes. `origin` is compared
    **exactly** against `clientDataJSON` (a suffix match is how
    `id.example.evil.test` borrows a ceremony), the RP ID is compared through
    `SHA-256` because that is all an authenticator is ever told, and a signature
    counter that goes backwards is refused as a possibly cloned key while a device
    that reports `0` is not — refusing those would break every platform
    authenticator. Attestation is deliberately **not** judged: `none` and `packed`
    self-attestation are accepted, and a certificate chain is refused by name, because
    trusting one is a policy decision no deployment should get by accident. Verified
    against real ceremonies — an EC key pair is generated, the authenticator data is
    assembled byte by byte and signed with `node:crypto` — in
    `tests/sentinel-webauthn.test.ts`, including the RFC's CBOR and the clone case.
  - `[x]` **Self-service enrollment, and the console that makes it possible**
    (`MfaService.requireEnrollable`, `IdentityService.setMfaEnrolled`,
    `console-*.ts`): enrollment was an administrator's act and is now a person's own.
    The rule is one line — an actor may always act on their own identity, and an
    administrator may act on anybody in their organization — and it is applied by
    both factor services, so the requirement is the same whichever kind of factor is
    being enrolled. The flag's *writer* did not change: `setMfaEnrolled` is still the
    only place `mfaEnrolled` is set, now permitting self, so "who may set it" widened
    while "what proves it" did not. The honest limit is stated on the page rather
    than hidden: the console needs a live session and the default policy refuses one
    without a second factor, so an identity's **first** factor still comes from an
    administrator (or from a login path that prompts for one — S2's password
    credentials), and removing your last factor ends every session you hold including
    the one you are reading the page on. Covered by `tests/sentinel-console.test.ts`.
  - `[ ]` Per-role policies: today an organization has one `IdentityPolicy` and
    everybody reads it.
- Roles, groups and attribute-based access policies; tenant branding.
- **Exit:** OnTrak Tix and Training sign in through Sentinel via OIDC and SAML;
  MFA is enforced — **TOTP and WebAuthn are done**, an identity can enroll either
  one for themselves from the console, and a session is refused until a code (or an
  assertion) from a confirmed factor has been seen; auth and privilege events are
  fully audited.

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

1. ~~Stand up the identity spine (S0): orgs, identities, sessions and the
   hash-chained audit log.~~ **Done** (schema migrated, adapter, verified chain).
2. ~~Implement OIDC authorization-code + PKCE as the first usable IdP capability.~~
   **Engine, HTTP surface and persistence done** (the second migration landed);
   deployable key management, logout/token revocation and SAML are the next
   slice.
3. Build the telemetry normalizer and one detection rule end to end (S3 spike).
4. Define the shared assurance-packet format with OnTrak Tix before either ships
   exports, so both are compatible from the start.
