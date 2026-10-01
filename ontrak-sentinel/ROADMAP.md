# OnTrak Sentinel — Product & Engineering Roadmap

> Identity Provider (IdP) + Intrusion Detection & Prevention (IDS/IPS). An
> [Innotel Labs](../INNOTEL-LABS.md) product, built **after** OnTrak Tix.
>
> Status legend: `[x]` shipped · `[~]` in progress · `[ ]` planned · `[-]` out of scope for v1
>
> **OnTrak family release 2026.09** ([portfolio](../INNOTEL-LABS.md)): this
> product's slice of it is **S3 — Guard detection**, started (the normalizer, the
> detection rules and the alert pipeline; no streaming listener yet); the others are
> **OnTrak IT Support Training v1.2** and **OnTrak Tix M6**.
>
> **What 1.0 is.** Sentinel 1.0 is **S0–S4**, and nothing further is needed to
> call it finished: a standards-compliant IdP the family can rely on (OIDC, SAML
> 2.0, SCIM, MFA, sessions, access reviews) plus Guard's v1 — what it can *see*
> and what it can *do about it* — with every one of those actions landing in the
> same hash-chained evidence log and exportable as a signed assurance packet.
> S5 (unified risk and response) and S6 (enterprise hardening) are deliberately
> **after 1.0**: they make Sentinel larger, and 1.0 is the line where one
> deployment is complete rather than where a fleet is. The rule for the boundary
> is that 1.0 must not *depend* on a subsystem that does not exist yet — so
> prevention lands with its approvals, safe-lists and rollback, not ahead of them.

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
- `Indicator` — the IoC rows an alert is judged against: kind, canonical value,
  the feed it came from, a confidence, an optional severity and an optional
  expiry. `Alert.threatIntel` keeps the matches an alert was judged on. A
  STIX/TAXII feed is a *transport* on top of this, not a second table.
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

**The 1.0 line runs from S0 to S4.** S0–S2 are the identity product; S3 and S4
are Guard's v1, split at the point where it stops observing and starts acting.
S5 and S6 are post-1.0 and are marked as such below, which is a statement about
scope rather than about order — neither is a prerequisite for shipping 1.0.

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
    an identity's own display name cannot become markup on its own page. The image
    and compose stack this bullet owed have since landed — see
    [Containers](./README.md#containers) — with a published registry still to come.
- Admin console shell; APIs; policy skeleton.
- **Exit:** an admin creates an identity, sees every action in the tamper-evident
  log, and tenant isolation is covered by CI tests.

### S1 — Sentinel Identity v1 `[x]`
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
  - `[x]` **Deployable key management, rotation included** (`SigningKeys` and
    `loadSigningKeys` in `oidc-keys.ts`): `SENTINEL_SIGNING_KEY` loads the signing key
    from a PEM so it stays out of the source tree and out of a generated one, and
    the SAML signature and the JWKS publish the same material — a second key would
    be a second thing somebody forgets to rotate. Rotation is a **two-step, because a
    key cannot be swapped in one**: for as long as a token the old key signed is
    still valid, the new key has to be *published* before it can be *used*. Naming the
    old key in `SENTINEL_SIGNING_PREVIOUS_KEY`/`_KID` publishes it beside the new one —
    `SigningKeys` is active-first, the JWKS carries every key in it, and SAML metadata
    emits one `KeyDescriptor` per key so a service provider that re-reads metadata can
    verify either — while only the active key ever signs. Removing the two settings
    retires the old key for real: what it signed stops verifying, so the overlap is a
    window rather than a permanent second key. The two configurations that would
    otherwise start and then quietly misbehave — a retired key with no `kid`, and one
    named as its own predecessor — are refused at startup rather than published
    ambiguously. Covered by `tests/sentinel-key-rotation.test.ts`, which includes a
    token issued before a rotation verifying after it.
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
  - `[x]` **The console's own sign-in through a provider** (`upstream-rules.ts`,
    `upstream-service.ts`, `console-*.ts`, the `upstreamStart`/`upstreamCallback`
    paths, and a run of `serve.ts`): Sentinel is the family's identity provider, so
    its own console was the one login in the family that checked a password itself —
    a second password beside the one the deployment's provider already holds, and a
    second thing to reset and a second place to forget a leaver. The console now also
    accepts an **authorization-code** sign-in from a configured provider, and keeps
    the password form for a deployment that has none — `upstream: { path, label }`
    (or `null`) in the sign-in view, so the page says *whose* SSO it is rather than
    rendering a control that could never work. The state, the nonce and the PKCE
    verifier are **sealed into a cookie** rather than carried in the callback, so the
    reply is matched against a value the browser never saw in the open; the ID token
    is verified **RS256 against the provider's JWKS** before a single claim is
    believed, with `iss`/`aud`/`exp` checked as well as the signature. Two limits are
    the point of it rather than an omission: a login the provider did not mark as
    multi-factor is still refused by the S0 spine when the policy requires one — the
    provider cannot be a way *around* the second factor — and the person is named by
    the provider's email while the **role comes only from the configured admin
    group**, so a group name upstream cannot hand out a grant here. The address the
    sign-in is started from is checked too, because the sealed attempt is a cookie:
    reached by the LAN address, the IP or `localhost` the browser is **sent to the
    registered redirect's host first** rather than handed to the provider with an
    ending it will never see, and the two cookies a callback answers with travel as
    two headers rather than one comma-joined value a browser may read as a single
    cookie — the shape that would leave somebody signed out with no error. What is
    configured is also said out loud once at startup, with a warning for the two
    half-configurations that only fail after the provider has been asked. Covered by
    `tests/sentinel-upstream.test.ts`.
  - `[x]` **Per-role policies** (`POLICY_SCOPES` in `identity-rules.ts`, the
    `IdentityPolicy` scope column in `20261025000000_policy_scope`,
    `IdentityService.policyForRole`/`setPolicy`, the `policies` console page): an
    organization keeps one **baseline** policy — the scope every organization
    already had, so nothing about an existing deployment's behaviour changed — and
    may add a policy per role that overrides it. `policyForRole(rows, role)` is the
    only resolver, so "which policy governs this person?" has one answer, and the
    scope that answered is recorded on the session grant itself: an audit entry says
    *the AGENT policy let this in*, not merely that *a* policy did. Three decisions
    are stated out loud. **The baseline is the fallback, never a second opinion** — a
    missing role row is the baseline, not "no policy", because a deployment that has
    never written an ADMIN row must not silently drop MFA. **A role policy may
    legitimately differ in either direction**, and the page shows every scope beside
    the number it resolves to (`Effective now: …` for a role with no row of its own),
    so a role that is looser than the baseline is visible rather than accidental; the
    honest limit is that nothing *forces* a role policy to be at least as strict, so
    tightening one is an administrative decision the screen makes answerable rather
    than a rule the code imposes. And **the built-in default still governs an
    organization with no rows at all**, which is what keeps the console's own login
    honest on a fresh install. Covered by `tests/sentinel-policy.test.ts` and the
    policy tests in `tests/sentinel-console.test.ts`.
- Roles, groups and attribute-based access policies; tenant branding.
- **Exit:** OnTrak Tix and Training sign in through Sentinel via OIDC and SAML;
  MFA is enforced — **TOTP and WebAuthn are done**, an identity can enroll either
  one for themselves from the console, and a session is refused until a code (or an
  assertion) from a confirmed factor has been seen; auth and privilege events are
  fully audited.

### S2 — Provisioning & lifecycle `[x]`
**Goal:** identities stay in sync without manual work.

- SCIM 2.0 server (Users/Groups); directory sync (AD/Entra/Google) with safe
  conflict resolution.
  - `[x]` **The SCIM 2.0 server** (`scim-rules.ts`, `scim-service.ts`,
    `scim-store-prisma.ts`, `scim-http.ts`, `scim-*.ts` in the console, and the
    sixth migration `20261020000000_scim`): Users, Groups, PATCH and PUT, ETag-free
    and honest about it, with discovery (`ServiceProviderConfig`, `ResourceTypes`,
    `Schemas`) public and everything else behind a bearer token. Three decisions
    carry it. **The filter parser accepts a declared subset and refuses the rest by
    name** — a directory sends `userName eq "…"` and sometimes `externalId eq "…"`,
    and a parser that half-implements RFC 7644's grammar would ignore the clause it
    did not understand and return a page that looks like a complete answer, so
    `co`, `sw`, `and` and bracket expressions are `invalidFilter` rather than
    guesses. **The projection is an allowlist** — `toScimUser` names every field it
    emits, because the identity has no password column *today* and a spread is how
    the one added tomorrow leaks to every connected directory. And **only human
    identities are SCIM users**: a `SERVICE` identity is a machine account, absent
    from the collection rather than forbidden in it, so a provisioning push cannot
    switch off the account something runs as.
  - `[x]` **`Identity.externalId`, and therefore a rename is a move** (the
    `(organizationId, externalId)` unique index, `IdentityService.updateIdentity`):
    a connector matching on the user name alone creates a second identity for
    somebody who changed their name and orphans the first — with its sessions, its
    factors and its history attached to a row nobody signs in as. The directory's
    own id is what makes the same person recognisable across a rename, unique when
    present and deliberately not unique across the NULLs, since an identity typed
    into the console and one provisioned from a directory are both ordinary. The
    mover half of the lifecycle rides with it: a rename, a role change and a
    directory id all go through one method that re-uses the spine's own validation
    and the last-administrator refusal, so a demotion cannot walk around the rule a
    deactivation obeys.
  - `[x]` **Deprovisioning that actually deprovisions**
    (`ScimService.deprovision`, called by `PATCH active:false` and by `DELETE`):
    switching somebody off, ending every session they hold, **and revoking the
    access tokens those sessions minted** — the third step is the one that is easy
    to leave out, and without it an offboarded person keeps calling the API until a
    token expires on its own. `DELETE` deactivates rather than deletes, because the
    sessions, factors and audit events naming an identity are evidence and evidence
    is the one thing this product cannot delete; the row stays, switched off, and a
    re-hire gets their history back.
  - `[x]` **Connector tokens, minted by a person** (`ScimToken` in the sixth
    migration, the console's provisioning page): stored as `SHA-256(token)`, with
    the plaintext existing once — in the response to the console request that asked
    for it, rendered into a body rather than a redirect, for the same reason the
    TOTP secret is. The connector acts as the administrator who minted it
    (`scim:<tokenId>`, ADMIN, one organization), which is the delegation stated
    out loud: the audit trail names the connector, never the person who was asleep
    when the directory pushed. **Token management is not on the SCIM surface at
    all**, so a compromised connector cannot mint itself a longer-lived credential.
    Revocation is a timestamp, so the record says *when* a connector stopped being
    trusted. Covered by `tests/sentinel-scim.test.ts`,
    `tests/sentinel-scim-store-prisma.test.ts`, and the provisioning tests in
    `tests/sentinel-console.test.ts`.
  - `[x]` **Groups** (`Group` / `GroupMember` in the sixth migration): synced
    membership with the `(groupId, identityId)` pair as the primary key, so a
    connector re-sending a membership is a no-op rather than a duplicate. Stated
    plainly rather than implied: **a group decides nothing yet** — roles, groups
    and attribute-based policy are the S1 bullet below, and until that lands a
    group is a recorded fact on the evidence chain, which is what a sync is for.
  - `[x]` **Directory sync (AD/Entra/Google), planned before it is applied**
    (`directory-rules.ts`, `directory-service.ts`, `directory-store-prisma.ts`,
    `directory-client.ts`, the `DirectoryConnection`/`DirectorySyncRun` tables in
    `20261026000000_directory_sync`, and the console wiring): a connection names a
    source (`ENTRA`, `GOOGLE`, `LDAP`, `GENERIC`), a reader, a schedule and a
    **conflict policy**, and a run reads a page of the directory, plans every change
    against what Sentinel holds, and applies it through the same
    `IdentityService`/`ScimService` methods a console write uses — so a sync cannot
    become a second, weaker writer. Four decisions carry it. **The plan is computed
    before anything is written** (`planDirectorySync`), so a run reports exactly what
    it will do and a dry run is the same code path with the writing switched off. **A
    conflict is resolved by the policy and reported either way**: with
    `preferDirectory` the directory wins and the local edit is overwritten *with a
    note saying so*; with `preferLocal` the local edit wins and the run reports the
    disagreement rather than leaving it to be discovered later. **A rename is a
    move, not a second person** — matching is by the directory's own id first and the
    address second, which is the `externalId` work above doing its job. And **a
    person who has left the directory is deactivated, never deleted**, which is the
    same deprovisioning path a SCIM `active:false` takes, sessions and tokens
    included. Groups sync as memberships with the same pair key the SCIM server
    uses. Covered by `tests/sentinel-directory.test.ts` (the plan, the conflict
    policies, the leaver and the reader's narrowing) and the store tests in
    `tests/sentinel-store-prisma.test.ts`.
- Joiner/mover/leaver workflows; access reviews; automatic deprovisioning and
  session kill on offboarding.
  - `[x]` **Joiner and leaver**, and the mover's writes: creating a user, renaming
    one, changing their role and switching them off all arrive over SCIM and land on
    the same code paths a console write does, so the rules cannot disagree about
    them.
  - `[x]` **Access reviews and scheduled attestation** (`access-review-rules.ts`,
    `access-review-service.ts`, `access-review-store-prisma.ts`,
    `access-review-scheduler.ts`, the eighth migration
    `20261030000000_access_review`, and the `SENTINEL_ACCESS_REVIEW_INTERVAL_MINUTES`
    wiring in `scripts/serve.ts`): the attestation that the people who have access
    should. A review covers the whole organization or one group, snapshots the
    **active** roster once, and asks a **named reviewer** to mark each identity kept
    or revoked by a deadline. Four decisions carry it, and each one is a way of
    answering “yes” without anybody looking that this refuses: **`PENDING` is the
    default and is not an approval**, so a scope that resolves to nobody is refused
    rather than opened empty (an empty review and one that passed are identical in a
    list), an unrecognised decision counts as undecided rather than as a yes, and
    re-sending `PENDING` is not a decision; **the list is a snapshot**, because a
    list that grew when somebody was hired could never be finished and a joiner is
    the next review's problem — which is what *periodic* attestation means; **lateness
    is derived from the clock, never stored**, because a stored `OVERDUE` flag is one
    that a scheduler which did not run leaves wrong, and the review that most needs to
    look late is the one nobody is scheduling; and **a `REVOKED` decision is carried
    out through `deprovisionForActor`** — the same path a SCIM `active:false` takes,
    sessions and access tokens included — with a deployment that cannot deprovision
    **refusing** the attestation rather than recording one that did nothing, because
    an operator must never be told a revocation happened while the person is still
    signing in. Recurring reviews come from a schedule ticked by
    `SENTINEL_ACCESS_REVIEW_INTERVAL_MINUTES` (unset is **off** — a tick opens reviews
    in every organization, so turning it on is a decision), and a schedule missed by
    months opens **one** review and reports the intervals it swallowed rather than
    thirty identical ones. Closing with items unattested is allowed and records how
    many were never looked at; cancelling keeps the list of what was asked. Covered by
    `tests/sentinel-access-review.test.ts` (35 tests: the rules, the snapshot, the
    refusals, the evidence entries, the scheduler and its failure handling, and the
    console surface). The console page (`/console/reviews`) is the register, one
    review's list, and the forms that open the next review and schedule one — so a
    review is opened, answered, closed and scheduled without leaving the browser, with
    the same refusals the service makes rather than a second set invented for the page.
    A reviewer who does not administer the register reaches only the review they were
    named on; the register itself stays administrators' work. A per-role policy scope
    is deliberately not offered as a review
    scope for the reason given in `access-review-rules.ts`: a role is a property of a
    person that an administrator changes, so a review scoped to one would silently
    change its own population the next time somebody was promoted.
- **Exit:** creating/removing a user in a source directory provisions and
  deprovisions in Sentinel and downstream apps automatically, with an audit trail.
  **Met on the provider side.** A connector pushes to `POST /scim/v2/Users`, and the
  reader on the pulling side (`directory-client.ts`, Entra ID and Google Workspace)
  drives the same writes; switching a user off either way ends their sessions and
  revokes their access tokens with an entry on the organization's evidence chain.
  The attestation half is built too — an access review snapshots the roster, asks a
  named reviewer, carries a `REVOKED` decision out through that same deprovisioning
  path, a schedule opens the recurring ones, and the console page drives all of it.
  **S2 is complete.**

### S3 — Sentinel Guard v1 (detection) `[~]`
**Goal:** see what is happening.

- `[x]` Telemetry ingest (syslog, NetFlow/IPFIX, host agent, OTel) into the
  normalizer, **and a listener that stays open**: `guard-syslog.ts` binds UDP and
  TCP, frames what arrives, parses it with the same normalizer a relay's POST
  uses, and hands each event to the same `GuardService.ingest` — one door into
  detection rather than a second, weaker one. Four things about it are decisions
  rather than details: the tenant is configuration (`SENTINEL_GUARD_ORGANIZATION`,
  and the listener **refuses to start** without it, because a syslog frame cannot
  name its own tenant); the bind address is the access control (default
  `127.0.0.1`, because syslog has no authentication to offer); a line past
  `maxLineBytes` is dropped and counted rather than buffered, so an endless TCP
  line costs a statistic and not the process; and nothing throws out of a socket
  handler, so a malformed frame or a vanishing peer is a counter. NetFlow/IPFIX
  and the OTel receiver remain declared vocabulary rather than readers. The
  **normalizer** is built (`telemetry-rules.ts`): a source-neutral
  `ObservedEvent` with kind (`NETWORK`/`HOST`/`HTTP`/`AUTH`), addresses and ports,
  direction, protocol, bytes and a free-form detail bag; `toObservedEvent` validates
  and narrows a JSON payload, `toObservedEventFromSyslog` reads the RFC 3164 shape,
  and `validateTelemetrySource` refuses a source the deployment has not declared. The
  ingest surface is live (`POST /guard/v1/events`, a bearer token per organization,
  `guard-http.ts` + `guard-service.ts`) and accepts a **batch**; what is not here yet
  is a streaming listener per protocol — a collector posts, it does not yet tail. The
  first four sources (`SYSLOG`, `NETFLOW`, `IPFIX`, `EBPF`, `OTEL`, `PROXY`, `EDR`,
  `FIREWALL`) are declared vocabulary rather than implemented readers, and the roadmap
  says so on purpose.
- `[~]` Signature + behavioural detection rules; rule versioning and test harness.
  Three rules ship (`SUSPICIOUS_SERVICE_RULE`, `SCAN_RULE`,
  `CREDENTIAL_STUFFING_RULE`) with a pure `evaluateRules` that is nothing but a fold
  over events and rules, which is what makes the harness trivial: a case is a list of
  events and the alerts it must produce. `inCidr` handles the address math so a rule
  is a sentence about traffic rather than a parser. **Versioning is not started**: a
  rule carries an id and a version today, and a rulebook endpoint
  (`GET /guard/v1/rules`) reports what the deployment runs so a sensor platform can
  be reconciled against it.
- `[~]` Alert triage, correlation, dedupe and enrichment; detection-coverage map.
  **Dedupe, correlation and triage are built**: `dedupeKey` buckets an event, so the
  same scan seen by two sensors is one alert (the store's `created` flag says whether
  a run was new work), and `correlateIdentity` resolves the addresses the event names
  against live sessions, so an alert links to the identity that was signed in at the
  time as well as the device and asset it names. Alerts have a lifecycle
  (`NEW`/`ACKNOWLEDGED`/`CLOSED`) on the organization's evidence chain. **Triage is
  now a page**: `alert-triage-rules.ts` decides what is still waiting (open by
  default, loudest first, then most recent, aged from the *last* sighting so a burst
  still arriving is not stale), what an alert is part of (`relatedAlerts` names the
  neighbours and the shared value that relates them, tightest first, and never a
  closed alert), and why it is as loud as it is (`escalationSummary` reads the
  indicator that moved the severity out of the alert's own record, so a review still
  gets its answer after the feed is withdrawn). `/console/alerts` renders the queue,
  opens one alert with its timeline — first seen, evidence, repeat, indicator
  matches and the operator's note in one list — and offers acknowledge and close as
  `POST`s that answer `303`, audited as `guard.alert.acknowledged` /
  `guard.alert.closed`. **Assignment is built too** (`alert-assignment-rules.ts`, the
  `assigneeId`/`assigneeLabel`/`assignedAt` columns in `20261031000000_alert_assignment`):
  an alert can be handed to a named person and given back to the queue, the filter offers
  *mine* and *unassigned*, and the header counts how many open alerts nobody owns — which
  is the number that makes "one alert is acted on at a time, by whoever gets there first"
  visible instead of a post-mortem finding. Two rules are about people rather than about
  permissions, and both are refused by name: a `SERVICE` identity cannot own an incident,
  and a **deactivated** identity cannot be given one, because an alert showing a name that
  will never pick it up is invisible to the `unassigned` queue and worse than one that says
  nobody has it. `assignableIdentities` filters through `assignmentRefusal`, so the picker
  the page renders and the check the service makes are one statement. A repeat **keeps** the
  owner, and a closed alert refuses a handover: it is the record of who worked it. The audit
  entries are `guard.alert.assigned` / `guard.alert.unassigned`, carrying the previous owner
  as well as the new one. Covered by `tests/sentinel-alert-assignment.test.ts` and the
  assignment tests in `tests/sentinel-alert-triage.test.ts`, plus the live-Postgres test that
  a clear really clears all three columns (Prisma reads `undefined` as "leave it alone").
  A second page, `/console/compliance`, reports the controls
  in force, the population each policy scope governs and what it resolves to, the
  alert backlog and the chain's verification result, from the same rows the product
  enforces; it is read-only and reports an absence as an absence rather than as a
  tick. Covered by `tests/sentinel-alert-triage.test.ts` and, for the operator's
  side, `docs/alert-triage.md`. **The coverage map is built**
  (`detection-coverage-rules.ts`, `/console/coverage`, covered by
  `tests/sentinel-detection-coverage.test.ts`): derived from the rulebook the build runs,
  it reports which declared kinds and sources a rule reads and which none does — gaps
  first, because they are the answer — so a source being *declared* is never mistaken for
  a source being *watched*. It reports what the rules read, not what arrives: every source
  is still declared vocabulary rather than a running collector, and the page says so. What
  is still not here is suppression and notification: one alert is acted on at a time, and
  nothing is sent anywhere when a CRITICAL is raised. Assignment gives an alert an owner, not
  a way of reaching them, and there is no shift view — a queue can be narrowed to *mine* and
  to *unassigned*, but an alert somebody holds overnight stays theirs until they hand it on.

  The join is only as good as the address a session carries, and today none do:
  `issueSession` records the address its caller supplies, and the only caller in this
  build is the bootstrap in `scripts/serve.ts`, which has no HTTP request behind it. So
  correlation is exercised end to end in the harness (and by hand, against a store whose
  sessions do carry addresses) and stays inert in a running deployment until there is an
  interactive login that grants a session from a request — which is the point at which
  `ipAddress` becomes populated rather than a column nothing writes.
  - `[~]` **Threat-intelligence enrichment** (`threat-intel-rules.ts`,
    `threat-intel-service.ts`, `threat-intel-store-prisma.ts`, the `Indicator`
    table in `20261028000000_threat_intel`, `Alert.threatIntel`, and the console's
    `/console/intel` page): a feed of indicators — IPv4/IPv6 addresses, CIDR
    blocks, domains, URLs and MD5/SHA-1/SHA-256 digests — is matched against every
    observation, and a match **annotates and escalates an existing alert** rather
    than raising one of its own, because "this address is on a list" is not a
    claim that anything happened and an alert that says only that is one nobody
    can action. Six decisions carry it. **Matching is by kind, never by
    substring**, and a `*.` prefix means the domain *and* anything under it while
    every other value matches one host exactly — so a shared-hosting neighbour is
    not an incident. **An expired indicator never matches**, enforced in the
    matcher rather than by a sweep, because a list nobody pruned reports the
    innocent for years and there must be no window in which the sweep has not run
    yet. **Confidence has a floor** (`CONFIDENCE_FLOOR`, 60): below it a match is
    recorded as context and the severity is left alone, and a feed's own severity
    is only ever a *floor* — a feed that says `LOW` about an address this
    deployment's own rule called `CRITICAL` is not evidence for a downgrade,
    because the rule saw the behaviour and the feed has only read about the
    address. **The alert keeps what it was judged on** — indicator, feed,
    confidence, the field it hit (`sourceAddress`, `destinationAddress` or the
    named attribute) and whether it escalated — so an escalation stays reviewable
    after the feed is gone, and an alert already raised keeps its matches even
    once the indicator is withdrawn. **A feed is data with a required
    provenance**: every indicator names the feed it came from, the id is derived
    from the kind and the canonical value so re-ingesting a feed refreshes rows
    instead of duplicating them, and ingesting needs a policy administrator
    (`canManagePolicies`) while reading needs only `canReadDirectory`, because a
    sensor-side read is not an administrative act. The console takes a paste in a
    `value | confidence | severity | expires` line format (a `|` cannot appear in
    a value, so it is the safe separator; a `#` comment and a blank line are
    skipped rather than reported as bad rows; a bare date expires at the *end* of
    that day), reports what was accepted, refreshed and refused, and withdraws one
    named indicator at a time — both writes land on the organization's evidence
    chain (`guard.intel.ingested`, `guard.intel.withdrawn`). Covered by
    `tests/sentinel-threat-intel.test.ts` and the second live-Postgres test in
    `tests/sentinel-postgres-live.test.ts`. **Not here yet: STIX/TAXII transport,
    automatic feed refresh and a scheduled expiry sweep** — a feed is text pasted
    by a person today, and expiry is enforced where the list is read. Triaging an
    alert from the console is done (see the triage bullet above).
- **Exit:** a known-bad pattern is detected from live telemetry, deduped and
  correlated into one alert linked to an identity, device and asset. Reached in the
  service and in `tests/sentinel-guard.test.ts` (events in, one deduped alert out, tied
  to the session's identity) — *live* telemetry means a collector posting, not yet a
  protocol listener.

### S4 — Sentinel Guard v1 (prevention) `[~]` — **the last 1.0 milestone**
**Goal:** act — safely and accountably.

- `[~]` **Compliance reporting and posture summary** — the reviewer's half of the
  work, and the first S4 item to land because it writes nothing. `/console/compliance`
  reports six controls (a second factor required before any session; every active
  identity enrolled; an active administrator exists; the session policy *stored*
  rather than left at the built-in default; nothing at `HIGH` or above waiting in the
  queue; the evidence chain verifying end to end), the policy coverage per scope with
  the number each scope actually resolves to, the alert backlog and the chain's
  result. Every figure is read from the control it describes — `policyForRole` for the
  effective policy, `triageSummary` for the backlog, `auditTrail` for the chain — so
  the report cannot describe a control the login path does not apply, and it says
  `WARN` or `FAIL` where a control is not in force instead of a tick with a footnote.
  - `[x]` **The export, in the family's shared packet format**
    (`assurance-packet.ts`, `assurance-sign.ts`, `ConsoleService.compliancePacket`,
    `GET /console/compliance/packet`, and the download offered on the page itself):
    the roadmap's own next step was to *define the shared assurance-packet format with
    OnTrak Tix before either ships exports*, and this is Sentinel's half of that
    agreement. The envelope is Tix's and deliberately not a Sentinel dialect — the same
    `version` (`1.0`), the same `HMAC-SHA256`, the same three hashes with the same
    division of labour: a `recordHash` over the posture alone (so an archived packet and
    a fresh one are comparable however much time has passed), a `contentHash` over the
    record *and* the evidence anchor (because "where in history was this cut?" is part
    of the assertion), and a `signature` over the content digest (so nothing, anchor
    included, can be edited without the key). It carries the same rows the page
    renders, because it is built from the same view in one call — a document and a
    screen that could disagree about a control would make the export worse than nothing.
    Verification needs the packet's bytes and the key and nothing else: no session, no
    database, no `Prisma`, which is what lets somebody who has never seen this
    deployment check a forwarded file. The key is `SENTINEL_ASSURANCE_SECRET`, falling
    back to the IdP's own signing key so a deployment that has an identity provider can
    export without being told about a second variable first. Covered by
    `tests/sentinel-assurance-packet.test.ts` (13 checks: the format asserted as
    literals so a drift breaks a test rather than the agreement, an edited control, a
    moved anchor, a re-signed forgery refused by anyone without the key, and the
    page's own affordance).
  - What is **not** here: retention windows, control *history* over time, a CSV or
    PDF rendering for readers who will not take JSON, and any S4 enforcement action at
    all — the first three because the packet is the artefact the family agreed on, and
    the last because it is the rest of S4.
- `[~]` **Policy-gated enforcement actions** (block, quarantine, rate-limit) with
  approvals, safe-lists for critical infrastructure, and one-click rollback.
  - `[x]` **The decision** (`src/lib/enforcement-rules.ts`): what may be enforced
    against, and on whose authority, computed before anything touches a packet —
    because the safety rails are the part that has to exist *first*. The order of
    the checks is the design. **The safe-list is checked first and is absolute**
    (an address inside a protected CIDR, or a named identity or device, is refused
    for an administrator with a second approval on file — a rail you could reach by
    exhausting the other rails would not be one). **Blast radius refuses rather
    than truncates**, since a silently smaller action is a different action from
    the one somebody described. **The rate limit is a rolling hour**, taken as the
    times of recent actions so the rule stays pure and the deployment owns the
    clock. **Authority comes last**, because every check above is a reason to refuse
    an administrator too — prevention is an administrator's action, and where the
    policy asks for a second approver it has to be a *different* administrator
    (the requester's own approval is not a second pair of eyes). Two properties are
    part of the answer rather than the caller's problem: every allowed action
    carries **its own inverse** (`LIFT` for a block or a rate limit, `RELEASE` for a
    quarantine) with a TTL, and **its own audit intent** — actor, approver, alert,
    targets, and the policy as it was judged — so an enforcement path that skipped
    the evidence spine would have to go out of its way. Covered by
    `tests/sentinel-enforcement.test.ts` (31 checks, each rail driven with the
    inputs that must pass and the ones just short of it).
  - What is **not** here, and is the rest of this milestone: the wire. Nothing
    applies a block, lifts one, stores a policy, or renders a page yet — there is
    no enforcement model in `prisma/schema.prisma`, no service method, and no
    console surface, and `canApproveEnforcement` was the only thing in the tree
    before this. The decision module is what those will call, so the next step is
    the service (`applyEnforcement`/`liftEnforcement` driving the returned audit
    intent through the chain) and the stored policy behind the page that shows what
    each number means.
- Reversible-by-default, rate-limited, blast-radius caps; every action audited.
- **Exit:** a threat is blocked within a defined latency; the block is approved,
  logged, reversible, and cannot be applied to a protected target.

### S5 — Unified risk & response `[ ]` — *after 1.0*
**Goal:** identity and network see the same picture.

- Identity-aware detection (a login from a new geolocation plus anomalous flows
  becomes one incident, not two alerts).
- Step-up authentication and session revocation triggered by a detection.
- Playbook-driven response, exporting incidents into OnTrak Tix with full
  evidence.
- **Exit:** an incident correlates identity + network signal, exports to Tix, and
  a step-up/revoke action is applied and audited.

### S6 — Enterprise hardening `[ ]` — *after 1.0*
**Goal:** run it at scale, prove it.

- Multi-tenant isolation, HA/failover, backup/DR, scale-out data plane.
- SOC 2-ready controls; audit/evidence exports for cyber-insurance; retention
  and data-subject handling.
- Threat-intel **transport**: STIX/TAXII and vendor feed subscriptions, automatic
  refresh and expiry sweeps, and partner/EDR/firewall integrations. The indicator
  model and its matcher shipped in S3 (`Indicator`, `threat-intel-rules.ts`); what
  is missing is the wire, not the meaning.
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
   **Done** — engine, HTTP surface and persistence (the second migration), then
   SAML 2.0 (the third), logout and token revocation, and deployable key management
   with rotation. **S1 is closed**; the milestone above records what each part
   decided rather than only that it landed.
3. ~~Implement the SCIM 2.0 server so a directory can provision identities.~~
   **Done** — the server (Users, Groups, connector tokens, deprovisioning with
   session and token kill; the sixth migration) *and* the connector that drives it
   (`directory-client.ts`: Entra ID through Graph and Google Workspace, on a real
   client-credentials flow, paging by the provider's own next-link). LDAP is
   deliberately not built — an LDAP bind is a different protocol with a different
   dependency, so a deployment that needs it supplies its own reader rather than
   being handed a fake. ~~What remains of S2 is **access reviews**.~~ **Access
   reviews have landed** (see the S2 bullet above): the rules, the service, the
   store and its migration, the scheduler that opens the recurring ones, and the
   `/console/reviews` page that opens, answers, closes and schedules them. That
   closes the bullet.
4. Build the telemetry normalizer and one detection rule end to end (S3 spike).
5. ~~Define the shared assurance-packet format with OnTrak Tix before either ships
   exports, so both are compatible from the start.~~ **Done on Sentinel's side**
   (`assurance-packet.ts`, S4 below): the envelope *is* Tix's — same `version`, same
   `HMAC-SHA256`, same `recordHash`/`contentHash`/`signature` discipline — and the test
   asserts the format as literals, so the day one product changes its envelope the two
   disagree in CI rather than in an auditor's hands. What that leaves is the other half
   of the shared work: one verification tool both packets can be handed to.

### What stands between today and 1.0

In the order they have to happen, and each one stated as the thing that is
missing rather than as a task name:

1. ~~**Guard can only read what it is handed.**~~ **Closed (2026-10-01):**
   `guard-syslog.ts` listens — syslog over UDP and TCP, into the same ingest path
   — so a detector can be pointed at a network rather than at something else's
   feed. What is still true: it is *one* protocol. NetFlow/IPFIX and an OTel
   receiver are the next listeners, and a pcap reader after them, so 1.0 has a
   listener rather than a taxonomy.
2. **A rule change is not a version.** Detection rules are code, and the corpus
   they are judged against is not tracked, so "why did this fire last Tuesday"
   has no answer. Versioning the rule set — and recording which version an alert
   was raised under — is what makes the evidence trail as durable on the network
   side as the hash-chained log already is on the identity side.
3. **Alerts have no off switch.** There is no suppression, no maintenance window
   and no notification transport, so every detection is a row in a queue that
   somebody has to be looking at. 1.0 needs both the mute and the delivery.
4. **Correlation is inert.** The identity-aware sweep exists but an interactive
   login never writes `ipAddress`, so the one join that makes Sentinel more than
   an IdP glued to an IDS has no data on the identity side. Closing that is
   small and is the whole point of the product.
5. **Prevention is the rest of S4** — block, quarantine, rate-limit, with
   approvals, safe-lists and one-click rollback. This is last on purpose: an
   action nobody can undo is not the thing to build first, and the order inside
   it follows the same rule. The **decision** has landed
   (`src/lib/enforcement-rules.ts`): the safe-list that refuses even an
   administrator, the blast-radius cap that refuses rather than truncates, the
   rolling hour, the second-approver rule, and the inverse computed at the
   moment of the decision so every action is reversible by construction. What is
   still missing is the wire — nothing applies a block, lifts one, stores the
   policy, or draws the page — so what stands between today and 1.0 here is an
   enforcement action a person can take and undo, on rails that already say what
   it may touch.

S5 and S6 sit behind all five. A 1.0 that arrives with an IdP, a detector, a
working listener and a reversible action, all on one evidence chain, is the
product this roadmap describes; everything above that line is scale.
