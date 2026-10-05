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

**S0, S1 and S2 complete; S3 started.** The identity spine exists, persists, and
issues identity; a directory can provision into it and it can read one; access
reviews ask the question provisioning cannot — should these people still have
this access? — on a console page of their own, with recurring attestation off
until a deployment asks for it; the
first Guard slice turns telemetry into an alert that names a person; a feed of
indicators now raises how that alert is judged; and the console works the queue
that produces, with a posture summary beside it. What is *not* here is still
stated: a synced group decides nothing yet (roles and groups as policy is S1's
last bullet), Guard has no streaming listener, no
detection-coverage map and no STIX/TAXII feed transport, and rule rotation and
signing-key provisioning are open. The identity spine:

- `src/lib/audit-chain.ts` — the hash-chained, append-only audit log with
  tamper detection (the evidence spine). `src/lib/hash.ts` is the one SHA-256 the
  chains, the PKCE challenge and the token lookups all share.
- `src/lib/identity-rules.ts` — pure session, validation and
  enforcement-approval rules.
- `src/lib/identity-service.ts` — the spine itself: organizations, identities and
  sessions, every read and write scoped to one organization, with one evidence
  chain per organization.
- `src/lib/identity-store-prisma.ts` + `identity-server.ts` — the Prisma side:
  the identity store and a **durable, per-organization audit trail** that
  verifies a chain before extending it and refuses to build on a tampered one.
  The client is described structurally, so the adapter runs against the generated
  client, a fake, or a repository layer.
-  `prisma/schema.prisma` + `prisma/migrations/` — the data model, **migrated**
  in eleven steps: `20260928000000_init` (the spine and the evidence log),
  `20260929000000_oidc` (the grant rows), `20260930000000_logout_saml`
  (`AccessToken.revokedAt` and the SAML service providers),
  `20261001000000_mfa_totp` (the TOTP enrollment state on `MfaFactor`),
  `20261015000000_webauthn` (the public key and signature counter on `MfaFactor`,
  plus the `WebAuthnChallenge` table), `20261020000000_scim`
  (`Identity.externalId`, `ScimToken`, `Group`, `GroupMember`),
  `20261025000000_policy_scope` (the `ALL` baseline and the per-role scope on
  `IdentityPolicy`),  `20261026000000_directory_sync` (`DirectoryConnection` and
  `DirectorySyncRun`), `20261027000000_guard_alert` (`Alert`, `AlertEvent`) and
  `20261028000000_threat_intel` (the `Indicator` table and the matches kept on
  `Alert.threatIntel`) and `20261030000000_access_review` (`AccessReview`,
  `AccessReviewItem` and `AccessReviewSchedule`).
  Every table
  carries the organization it belongs to with a cascading foreign key, and
  `AuditEvent` is unique on `(organizationId, seq)` because each organization has
  a chain of its own.
- `src/lib/oidc-rules.ts` + `oidc-service.ts` + `oidc-keys.ts` (S1) — the
  **authorization-code flow with PKCE**: registered clients with exact redirect
  URIs, PKCE required of every client, single-use sixty-second codes spent before
  they are judged, RS256 ID tokens with a public JWKS, hashed access tokens, and
  discovery that advertises only what is implemented. Every registration and
  grant is on the organization's evidence chain.
- `src/lib/oidc-http.ts` + `oidc-server.ts` (S1) — the **HTTP surface**, as a
  pure router over plain request/response shapes (discovery, JWKS, authorize,
  token, userinfo) plus a thin `node:http` adapter. An error is only ever
  redirected to a redirect URI that was registered; the session travels in the
  `sentinel_session` cookie (or the `X-Sentinel-Session` header) rather than a
  query string; a token response is `no-store`. The whole surface is tested
  without a socket, and once through a real one. The same module exposes
  `createOidcServices` / `configureOidc` / `oidcServices`, one place that binds a
  store to the engine the way `identity-server.ts` binds the spine.
- `src/lib/oidc-store-prisma.ts` (S1) — the **persisted grants**: `OidcClient`,
  `AuthorizationCode` and `AccessToken`, each scoped to its organization. The
  access token is stored as a hash, never as the token, and `markCodeUsed` is a
  single conditional write (`updateMany` where `usedAt` is still null), so two
  exchanges racing on one code cannot both win. A **second migration**
  (`20260929000000_oidc`) creates the tables; CI applies every migration to a real
  Postgres and diffs them against the models.
- `src/lib/oidc-rules.ts` + `oidc-service.ts` + `identity-service.ts`,
  `oidc-http.ts` (S1) — **logout and token revocation**. Sign-out ends the
  **session** through the spine *and* revokes every access token it minted, in one
  statement, because either half alone leaves a way back in: an ended session with
  a live token still reads `userinfo`, and a revoked token with a live session
  still gets another code. `endOwnSession` is deliberately not the admin
  `revokeSession` — holding the session id is the proof, so signing yourself out
  never needs an administrator. `post_logout_redirect_uri` is honoured only when
  the client registered it and dropped otherwise, so the provider cannot be turned
  into an open redirector. Revocation (RFC 7009) needs no secret, answers identically
  for a dead token and one that never existed (a different answer would be a token
  oracle), and is a conditional write. `isTokenActive` is the one place
  "revoked or expired?" is asked, so a killed token cannot come back to life at a
  different endpoint.
- `src/lib/saml-rules.ts` + `saml-service.ts` + `saml-sign.ts` + `saml-http.ts`
  (S1) — **SAML 2.0 SSO**, over the same session policy as OIDC. Registered
  service providers with exact ACS URLs (SAML has no PKCE — the assertion *is* the
  credential), five-minute request freshness, `InResponseTo` echoed back, and a
  signed assertion whose envelope is written with no inter-element whitespace so
  exclusive canonicalisation is the document itself. The signature is verified the
  way a service provider verifies it: RSA over `SignedInfo` first, then the digest
  recomputed from the bytes that arrived. Success is an auto-submitting form post,
  never a redirect. Metadata is public, cacheable and honest about what is not
  served.
- `src/lib/mfa-rules.ts` + `mfa-service.ts` + `mfa-store-prisma.ts` (S1) —
  **enforced TOTP second factors**. S0 stored `mfaEnrolled` and refused every
  session while it was false, with nothing able to make it true by proving
  anything; the flag is now set only after a code from the enrolled secret
  verifies. The arithmetic is RFC 6238 over HMAC-SHA-1 at a thirty-second step
  with one step of drift either way — the drift a phone's clock and a server's
  clock actually have — and a verified step is recorded so the same six digits
  **cannot be presented twice**. Enrollment is two steps (a secret shown once,
  then a code that proves it arrived) precisely so a mistyped or unread secret
  cannot leave an identity looking enrolled and unable to sign in, and the secret
  is the one value here stored in a readable form — a code is computed *from* it —
  so encrypting that column is the deployment's job, stated rather than assumed.
  The flag is still written through `IdentityService.setMfaEnrolled`, so there is
  one writer of the field every session decision reads. Verification needs no
  actor, because it is called from the login path after the password has been
  checked. Covered by `tests/sentinel-mfa.test.ts`, including the RFC's own SHA-1
  test vectors.
- `src/lib/webauthn-rules.ts` + `webauthn-service.ts` (S1) — **WebAuthn security
  keys** as a second factor beside the authenticator app. The challenge is a row,
  spent by a conditional write, so "accepted exactly once" holds across workers
  rather than inside one process's memory, and it expires in two minutes. `origin`
  is compared **exactly** against `clientDataJSON`; the RP ID is compared through
  `SHA-256`, because that is all an authenticator is told; and a signature counter
  that goes backwards is refused as a possibly cloned key, while a device that
  reports `0` is not — refusing those would break every platform authenticator.
  Attestation is deliberately *not* judged: `none` and `packed` self-attestation are
  accepted, and a certificate chain is refused by name, because trusting one is a
  policy decision no deployment should get by accident. The ceremony is exercised
  against real signatures — an EC key pair is generated and the authenticator data
  assembled byte by byte and signed with `node:crypto` — in
  `tests/sentinel-webauthn.test.ts`.
- `src/lib/scim-rules.ts` + `scim-service.ts` + `scim-store-prisma.ts` +
  `scim-http.ts` (S2) — **SCIM 2.0 provisioning**, so a directory can create the
  identities rather than an administrator typing them in. Users and Groups,
  PATCH and PUT, discovery public and everything else behind a bearer token.
  The filter parser implements `eq` on four attributes and **refuses the rest of
  RFC 7644's grammar by name** (`co`, `sw`, `and`, brackets), because a parser that
  silently ignored a clause would answer a narrower question than was asked while
  looking like a successful page. The projection is an **allowlist** — every field
  `toScimUser` emits is named, so a column added later cannot leak to a connected
  directory by being spread. Only `HUMAN` identities are SCIM users: a `SERVICE`
  account is absent from the collection rather than forbidden in it, so a push
  cannot switch off the machine account something runs as. `Identity.externalId`
  makes a rename a *move* — a connector matching on the user name alone would
  create a second person and orphan the first one's sessions, factors and history.
  `DELETE` **deactivates**: the row, its sessions, its factors and the audit events
  naming it are evidence, and evidence is the one thing this product cannot delete.
  Switching a user off ends every session they hold *and* revokes the access tokens
  those sessions minted — ending a session alone leaves a held token working. A
  connector token is stored as `SHA-256(token)`, is shown once, and **cannot be
  minted from the SCIM API at all**: minting happens in the console, where a person
  with a session is present, and the connector acts as `scim:<tokenId>` — the
  delegation, never the person who minted it. Groups sync, and state plainly that
  they decide nothing until groups become policy (the S1 bullet below). Covered by
  `tests/sentinel-scim.test.ts` and `tests/sentinel-scim-store-prisma.test.ts`.
- `src/lib/identity-rules.ts` + `identity-service.ts` (S1) — **per-role policies**.
  An organization keeps one baseline policy (`scope: ALL`) and may add one per role
  that overrides it; `policyForRole` is the only resolver, so "which policy governs
  this person?" has one answer, and the scope that answered is recorded on the
  session grant — an audit entry says *the AGENT policy let this in*, not merely
  that *a* policy did. The `ALL` row is a value rather than an absent one, because
  a missing role row must fall back to the organization's baseline (or the built-in
  default on a fresh install) rather than to no policy at all. The console shows
  every scope beside the number it resolves to, so a role that is looser than the
  baseline is visible rather than accidental. Covered by
  `tests/sentinel-policy.test.ts`.
- `src/lib/directory-rules.ts` + `directory-service.ts` + `directory-store-prisma.ts`
  + `directory-client.ts` (S2) — **reading a directory**: a connection names the
  source, the reader, the schedule and the **conflict policy**, and a run plans
  every change before writing any of them, so the dry run is the same code path
  with the writing switched off. `preferDirectory` lets the directory win and says
  so in the report; `preferLocal` keeps the local edit and reports the
disagreement. Matching is by the directory's own id first, so a rename is a move
  rather than a second person; a leaver is deactivated rather than deleted,  down the same path a SCIM `active:false` takes. Covered by
  `tests/sentinel-directory.test.ts`.
- `src/lib/access-review-rules.ts` + `access-review-service.ts` +
  `access-review-store-prisma.ts` + `access-review-scheduler.ts` + the eighth
  migration `20261030000000_access_review` (S2) — **access reviews and scheduled
  attestation**. Provisioning answers *who exists*; this answers the question
  provisioning cannot: *should these people still have this access?* A review is
  opened over a scope (the whole organization, or one group), snapshots the active
  roster **once**, and asks a **named reviewer** to mark each person kept or
  revoked by a deadline. Four decisions carry it. **A snapshot, not a live
  query** — a list that grew when somebody was hired could never be finished, so a
  later joiner is the next review's problem, which is what *periodic* attestation
  means; and a deactivated identity is not on it, because there is no access left
  to attest. **`PENDING` is the default and is not an approval** — the difference
  between “reviewed and kept” and “nobody got to it” is the thing an auditor is
  actually asking about, so a scope that resolves to nobody is refused rather than
  opened empty, and an unrecognised decision counts as undecided rather than as a
  yes. **Lateness is derived, never stored** — `OVERDUE` is `dueAt` against the
  clock, because a stored flag is one that a scheduler which did not run leaves
  wrong, and the review that most needs to look late is exactly the one nobody is
  scheduling. **A revocation goes through the deprovisioning path** the SCIM
  `active:false` uses, sessions and access tokens included, and where this
  deployment has no way to deprovision the attestation is refused instead of
  recorded — an operator must never be told a revocation happened while the person
  is still signing in. Recurring reviews come from a schedule, ticked by
  `SENTINEL_ACCESS_REVIEW_INTERVAL_MINUTES` (unset means off, since a tick opens
  reviews in every organization here): a schedule that was missed by months opens
  **one** review and reports how many intervals it swallowed, so a month of
  downtime does not come back as thirty reviews that bury the one that matters.
  Closed reviews are evidence, not work — cancelling keeps the list of what was
  asked, and closing with items unattested is allowed and records how many were
  never looked at. The console page at `/console/reviews` is the register, one
  review's list, and the forms that open the next review and schedule one; a
  reviewer who does not administer the register reaches only the review they were
  named on, and the register itself stays administrators' work. Covered by
  `tests/sentinel-access-review.test.ts`.
- `src/lib/telemetry-rules.ts` + `detection-rules.ts` + `detection-service.ts` +
  `guard-service.ts` + `guard-http.ts` (S3) — **the first Guard slice**. A
  source-neutral `ObservedEvent` (kind, addresses, ports, direction, protocol,
  bytes), three pure detection rules, and an alert pipeline where the dedupe key is
  a **bucket** rather than an id — the same scan seen by two sensors is one alert,
  and the response says which case it was. An alert resolves the addresses it names
  against live sessions, so it links to the identity that was signed in at the time
  plus the device and asset, and it records the rule *and its version*, so an alert
  is read against the code that ran. (The join needs an address on the session, and
  in this build only the bootstrap grants a session — with no request behind it — so
  correlation names an identity in the harness and in any deployment whose sessions
  carry an address, and stays quiet until an interactive login populates one.) `POST /guard/v1/events` is mounted only when a
  token is configured; `GET /guard/v1/rules` publishes the rulebook. Covered by
  `tests/sentinel-guard.test.ts`.
- `src/lib/threat-intel-rules.ts` + `threat-intel-service.ts` +
  `threat-intel-store-prisma.ts` + the console's intel page (S3) — **threat
  intelligence**, so an alert is judged against what somebody else has already met
  rather than only against what this deployment's own rules saw. A feed of
  indicators — addresses, CIDR blocks, domains, URLs and file digests — is matched
  against every observation, and a match **annotates and escalates an existing
  detection** rather than raising one of its own, because "this address is on a
  list" is not a claim that anything happened. Matching is by kind and never by
  substring; a `*.` prefix is the domain and everything under it while anything
  else matches one host exactly; and an **expired indicator never matches**,
  enforced in the matcher rather than by a sweep, so no sweep can lag behind a
  reassigned address. Below `CONFIDENCE_FLOOR` a match only annotates, and a feed's
  severity is a floor that can raise a rule's verdict but never lower it — the rule
  saw the behaviour, the feed has only read about the address. The alert keeps what
  it was judged on (indicator, feed, confidence, the field it hit, whether it
  escalated), so an escalation can be reviewed after the feed is gone. A feed is
  data with a required provenance: every indicator names its feed, a re-send
  refreshes the row instead of duplicating it, and every ingest and withdrawal is
  on the organization's evidence chain. Covered by
  `tests/sentinel-threat-intel.test.ts`.
- `src/lib/alert-triage-rules.ts` + the console's alerts and compliance pages
  (S3) — **the operator's side of detection**: the queue, one alert opened, and the
  posture summary. `detection-service.ts` answers *is this an incident* and *who is
  it about*; this module answers the three questions an operator asks next, and
  answers them as pure functions so they are tested without a database, a browser
  or a session. **What is still waiting on me?** The queue is filtered and ordered
  here rather than by the store — loudest first, then most recent, then by rule —
  because a list that reshuffled between two page loads would make an operator
  re-read rows they had already dismissed, and because a store query that sorted
  differently from the summary beside it would put the page's own header in doubt.
  Age is measured from the **last** sighting, not the first: a burst still arriving
  is not an ignored alert. **What is this part of?** An alert is never alone — the
  same identity, address, asset, device or dedupe group raised the alerts around
  it — so `relatedAlerts` names the neighbours *and why they are neighbours*, which
  is the difference between an investigation and a filtered list. A **closed alert
  is never a neighbour**: a resolved printer ticket beside a live intrusion is
  noise, not context. **Why is it this loud?** The severity on the row is not
  always the severity the rule fires at, so `escalationSummary` names the indicator
  that moved it, read from the record — the feed may have been withdrawn a month
  ago, and the review still has to get the answer the alert was judged on. The page
  renders the queue, opens one alert with its timeline (evidence, indicator matches,
  note and all, oldest first) and offers acknowledge and close; nothing here
  mutates, because a second place that could change a state is a second place that
  could change it *without* an audit entry. Beside it, the **compliance** page is a
  read-only posture summary — the controls in force, who and what they govern, the
  policy each scope resolves to, the alert backlog and the chain's verification
  result — computed from the same rows the product enforces, so the page cannot
  describe a control the login path does not apply, and a control that is not in
  force is reported as `WARN` or `FAIL` rather than as a tick with a footnote.
  Covered by `tests/sentinel-alert-triage.test.ts`, and the operator's side of it is
  in [docs/alert-triage.md](./docs/alert-triage.md).
- `src/lib/console-rules.ts` + `console-service.ts` + `console-http.ts` (S0/S1) —
  the **admin console**, as a server-rendered shell with no framework: an overview
  (who you are, whether a second factor is enrolled, and the organization's
  evidence chain with its verification result), a second-factor page, and a
  sign-out that ends the session *and* revokes the tokens it minted, plus a
  **provisioning** page that mints and revokes connector tokens (shown once, in a
  body — never in a redirect or a query string, which is where a credential ends up
  in history and proxy logs) and lists the groups a sync has brought in. It is the third
  pure router on the same listener as OIDC and SAML, and it is what makes MFA
  enrollment **self-service**: an actor may enroll, confirm and remove their own
  factors with no administrator involved, through the same services, the same
  `requireEnrollable` rule and the same single writer of `IdentityService.
  mfaEnrolled`. The page states the limit rather than hiding it — the console needs
  a live session and the policy refuses one without a second factor, so an identity's
  first factor still comes from an administrator until there is a password login —
  and every value on it is escaped through one function, so a display name cannot
  become markup. It also carries the **policies** page (every scope, what is stored
  for it, and what it resolves to)  and the **directory** page (create a connection,
  run a sync, read the report), and the **threat intel**  page (what is watched, a
  paste-in feed box, and a withdrawal per row), the **alerts** page (the queue, and
  one alert's investigation) and the **compliance** page (the posture summary).
  Covered by `tests/sentinel-console.test.ts`.
- `scripts/serve.ts` (`npm run serve`) — a **runnable provider**: an organization,
  an administrator, a session and a demo client, plus a printed authorization URL
  with a PKCE pair. With `DATABASE_URL` set it runs over Postgres, end to end, and
  bootstraps idempotently; without it, the same code path runs over in-memory
  stores for a quick look, and the same listener answers both protocols — OIDC at
  `/oauth2/*` and `/well-known/*`, SAML at `/saml/*`. It also enrolls the demo
  administrator's TOTP factor through the real enrollment path and prints the
  `otpauth://` URI, because the default policy requires a second factor and a
  flipped boolean would not have proved one. It also serves the console at
  `/console` and prints the cookie line that gets a browser into it, and mounts the
  Guard surface at `/guard/v1` when a token is configured. It answers `GET /health`
  without a credential — that is the path the family portal probes to draw a
  product's status light, and it is answered before any router so no surface can
  claim it. Deployable key management and rotation are the next slice, so there is
  no image yet.

The full platform is built *after* OnTrak Tix; see [ROADMAP.md](./ROADMAP.md).

Like the other two products, this one is a project in its own right:

```bash
cd ontrak-sentinel
npm install
npm run typecheck
npm test                      # 307 checks; the live Postgres file skips without DATABASE_URL

cp .env.example .env          # set DATABASE_URL
npm run db:deploy             # apply prisma/migrations

DATABASE_URL=… npm test       # now the live spine round-trip runs too

npm run serve                 # the provider on :8787 (issuer from .env)
```

The provider is runnable: `npm run serve` bootstraps an organization, an
administrator, a session, a demo client and a demo SAML service provider, prints
an authorization URL with a PKCE pair, and answers discovery, JWKS, authorize,
token, userinfo, logout, revocation, SAML metadata, SAML SSO, the SCIM surface at
`/scim/v2` and the console at
`/console` (overview, second-factor enrollment with an authenticator app or a
security key, provisioning, policies, directory sync, threat intel, sign-out). With
`DATABASE_URL` set, every one of those rows is in Postgres — the spine, the
evidence chain, the grants and the service providers — and a restart keeps them;
without it, the same code path runs over in-memory stores. It ships a container
image and compose stack (see [Containers](#containers) below), but it is **not yet
a deployment** in the sense that matters: signing-key provisioning and rotation are
still to come, so the key is read from the environment rather than provisioned by
the product itself. Enforced MFA itself is in — a session is refused
until a code from a confirmed factor (or an assertion from a registered key) has
been verified, and enrollment is now the identity's own act from the console. The
signing key is ephemeral unless `SENTINEL_SIGNING_KEY` is set, and WebAuthn needs a
real console origin (`SENTINEL_WEBAUTHN_ORIGIN`) to be useful from a browser,
because a ceremony is bound to the page it runs on.

Point a SCIM 2.0 connector at `http://127.0.0.1:8787/scim/v2` (the issuer plus
`/scim/v2`), read `ServiceProviderConfig` without a token, then mint a connector
token at `/console/provisioning` and use it as the bearer token. Nothing is
minted for a demo and printed to the terminal on purpose: a provisioning
credential belongs to a person acting in a browser, is shown once, and never
reaches a log or a scrollback.

The connector end of that is in
[docs/scim-provisioning.md](./docs/scim-provisioning.md): what to enter in Entra or
Okta, exactly which attributes this provider serves and returns, and the parts of
RFC 7644 it deliberately does not implement — the filter subset above all, because
that is where a connector's expectations and this provider's refusals meet.

## The family signing in

Sentinel is the provider the desk and the training app point at, and the wiring is
two settings per product:

1. **On the provider**, set `SENTINEL_TIX_CALLBACK` to the desk's callback and
`SENTINEL_TRAINING_CALLBACK` to the training app's — each product's own address
plus `/api/sso/callback` — and `npm run serve` (or this compose stack) registers a
public OIDC client for each and prints the two client ids. Public, because neither
product can keep a secret: PKCE is what binds an authorization code to the caller
that asked for it. Both are opt-in, because a provider that registers a client for
a product nobody pointed at it is issuing identity to an audience that never
asked.
2. **In the product**, hand it that issuer and client id: on the desk, stored at
`/admin/identity`; in the training app, `ONTRAK_OIDC_ISSUER` and
`ONTRAK_OIDC_CLIENT_ID`. Both also need to be told their own address
(`ONTRAK_TIX_BASE_URL`, `ONTRAK_TRAINING_BASE_URL`).

That second setting is load-bearing rather than cosmetic. Without it a product
builds its redirect URI from the address its process is bound to — inside a
container, `0.0.0.0:3000` — and a redirect URI is matched *exactly* against the one
the provider registered. The handshake is then refused with a mismatch that reads
like a wrong client id, and the post-sign-in redirect would strand the browser
somewhere it cannot reach.

One constraint is worth stating before it surprises somebody: the redirect URI is
validated like any other, which means `https`, or `http` on a **loopback** address.
A product reached at a bare LAN address over plain HTTP cannot be registered at
all, and is told so rather than being quietly allowed — so a family served over
plain HTTP does single sign-on on one machine, and across machines only once
something terminates TLS in front of it. The issuer has the matching problem from
the other side: it is one identifier for both parties, so it has to be an address
the browser *and* the app containers resolve. The compose file that brings the
three together says so in its header.

## The desk pushing its people back

Sign-in flows *from* Sentinel; the desk's roster flows *to* it. OnTrak Tix adds an
account at the desk and pushes it here over SCIM 2.0 — mint a connector token at
`/console/provisioning`, put it in the desk's `ONTRAK_TIX_SCIM_TOKEN` beside
`ONTRAK_TIX_SCIM_BASE_URL`, and `/admin/identity` gains a button that provisions
the desk's people at the provider. The push matches by the desk's own account id
before the address, so a rename moves the identity instead of creating a second
one, and a person switched off at the desk is switched off here — which ends their
sessions and revokes the access tokens those sessions minted, exactly as an
inbound SCIM deprovision does. See
[ontrak-tix/docs/identity.md](../ontrak-tix/docs/identity.md).

## Reading a directory

The other direction from SCIM: rather than waiting for something to push a roster,
Sentinel can **read** one. Create a connection at `/console/directory`, naming the
source (`ENTRA`, `GOOGLE`, `GENERIC`, or `LDAP` if the deployment supplies its own
reader), the endpoint and credential, how often to read, and — the setting that
matters — the **conflict policy** for somebody edited in both places.

Nothing is written before the plan is computed. A run reads a page, plans every
change against what Sentinel holds, and reports exactly what it would do; the dry
run is the same code path with the writing switched off. Then:

- **`preferDirectory`** lets the directory win, and says so in the run's report — an
  overwritten local edit is recorded rather than silently lost.
- **`preferLocal`** keeps the local edit and reports the disagreement, so it is a
  decision somebody makes instead of a discrepancy nobody sees.
- **A rename is a move.** Matching is by the directory's own id first and the
  address second, so somebody who changed their name keeps their sessions, their
  factors and their history instead of gaining a second account.
- **A leaver is deactivated, never deleted** — the same path a SCIM
  `active: false` takes, sessions ended and tokens revoked.

Groups come across as memberships. Being honest about the limit: a group is a
**recorded fact on the evidence chain** today and decides nothing yet — roles,
groups and attribute-based policy are the S1 bullet that is still open.

## Seeing what is happening

Sentinel Guard's first slice is the part everything else needs: turning telemetry
into an alert that names a person.

```bash
curl -sS -X POST http://127.0.0.1:8787/guard/v1/events \
  -H "Authorization: Bearer $SENTINEL_GUARD_TOKEN" \
  -H "X-Sentinel-Organization: demo" \
  -H 'Content-Type: application/json' \
  -d '{"source":"FIREWALL","events":[{"kind":"NETWORK","sourceAddress":"203.0.113.9","sourcePort":4444,"destinationPort":3389,"protocol":"tcp","direction":"INBOUND"}]}'
```

A batch goes in; a report comes out saying how many events were accepted, why any
were rejected, and which alerts were created or *matched an existing one*. The three
rules are pure functions over the normalized event, so a rule's test is a list of
events and the alerts they must produce, and `GET /guard/v1/rules` publishes the
rulebook (id, version, name, severity) so a sensor platform can be reconciled
against what is actually running.

Four decisions are worth reading before extending it. **The dedupe key is a bucket,
not an id** — the same scan seen by two sensors is one alert, and the response says
which case it was, because "alerted again" and "alerted the same thing" are
different answers. **An alert links to an identity when it can**: the addresses the
event names are resolved against live sessions, so the alert carries the person who
was signed in at the time, the device and the asset — and keeps the label it
recorded even after sessions end, because a closed alert still has to read. **The
rule that fired is named with its version**, so an alert is judged by the code that
ran rather than by whatever the rule says today. And **the ingest surface is not
mounted at all when no token is configured** — an endpoint that exists only to say
"configure me" is one somebody eventually finds a way to write to.

Not here yet, and named rather than implied: no streaming listener per protocol (a
collector posts, it does not yet tail), no detection-coverage map, and no rule
*editing* — the rulebook is code with a version, and publishing a rule is a deploy.
The queue is worked at `/console/alerts` (see [Working the queue](#working-the-queue)).

## Judging an alert against a feed

Detection answers *what happened*. Threat intelligence answers the other half of the
question — *have we seen this before, and does anybody else think it is bad?* — by
joining an observation to a feed of indicators: IPv4 and IPv6 addresses, CIDR blocks,
domains, URLs and MD5/SHA-1/SHA-256 digests.

Paste a feed at `/console/intel`, one indicator per line, fields separated by a pipe:

```
# a header line is skipped
203.0.113.9
*.bad.example | 80
44d88612fea8a8f36de82e1278abb02f | 90 | CRITICAL | 2027-01-01
```

Everything after the value is optional. A pipe separates because a URL can contain a
comma and a CIDR cannot contain a pipe; a blank line and a `#` comment are skipped rather
than reported as bad rows; and a bare date expires at the **end** of that day, because
"expires 2027-01-01" is how a person writes "stop using it after the 1st". A row that
will never match anything is refused by name and not stored — a row that reads as
protection and matches nothing is worse than no row at all.

A match does **not** raise an alert. "This address is on a list" is not a claim that
anything happened, and an alert that says only that is one nobody can action. What a
match does is change how an *existing* detection is judged:

- **An expired indicator never matches.** Curation is a gift with a date on it: an
  address is reassigned, a domain is re-registered, and a list nobody pruned reports the
  innocent for years. Expiry is enforced in the matcher rather than by a sweep, so there
  is no window in which the sweep has not run yet.
- **Matching is by kind, never by substring.** A domain indicator compared as a substring
  matches `not-evil-vendor.example` for `vendor.example`, and a feed with a hundred
  thousand rows would alert on the word. A `*.` prefix means the domain *and* anything
  under it; anything else matches one host exactly.
- **Confidence has a floor** (`CONFIDENCE_FLOOR`, 60). Below it a match is recorded as
  context and the severity is left alone, and a feed's own severity is only ever a
  *floor* — a feed that says `LOW` about an address the deployment's own rule called
  `CRITICAL` is not evidence for a downgrade, because the rule saw the behaviour and the
  feed has only read about the address.
- **The alert keeps what it was judged on** — the indicator, the feed, the confidence,
  the field it hit (source address, destination address, or the named attribute) and
  whether it escalated — so an escalation stays reviewable after the feed is gone, and an
  alert already raised keeps its matches even once the indicator is withdrawn.

Withdrawal is one row at a time and audited (`guard.intel.withdrawn`), and there is
deliberately no "clear the feed" button: a named withdrawal is a decision somebody can be
asked about, and a bulk erase is what a panicking operator reaches for at 03:00 and regrets
at 09:00.

The operator's side of it — the exact paste format, how a value is classified, what each
action needs to be permitted, and how to drive it from a script — is in
[docs/threat-intelligence.md](./docs/threat-intelligence.md).

Not here yet, and named rather than implied: no STIX/TAXII transport and no automatic
refresh — a feed is pasted by a person today — and no scheduled expiry sweep (the
matcher enforces expiry itself).

## Working the queue

An alert raised by detection lands at `/console/alerts`, and the first thing that page
does is take a position: **open work is the default view**. `CLOSED` is deliberately not
one of the states a filter offers by default, because a queue that shows a resolved
printer ticket beside a live intrusion is a queue nobody reads to the bottom.

The filter is a plain `GET` — which is the one place in the console that is not a `POST`.
Narrowing a list changes nothing, so it belongs in the address bar where it can be
bookmarked, shared and reached with the back button; acknowledge and close stay `POST`s,
and they are exactly why the queue may safely be a `GET`.

The page reports two numbers rather than one, and says which is which. The header
describes *everything* the organization has — how much of it is open, how much of that is
`HIGH` or above, how much of it a feed raised — while the table below it is what the
filter selected. A single number would have to pick one of the two questions, and the
number an operator reports upward is usually the header's.

Opening an alert is a link, not a second page: `?alert=<id>`, with the queue's own filter
carried in the URL beside it, and the alert looked up in the **unfiltered** list, so a link
pasted into a chat opens the incident it names whatever the recipient's queue is narrowed
to. What it shows is the three answers the rules computed:

- **What else is this.** The neighbours, tightest relation first — the same identity,
then the same address, then the same asset, then the same device, then merely the same
dedupe group — each saying *which* shared value relates it. An alert that relates on
several axes is reported once, on its tightest one, so the list does not pad itself, and
a closed alert is never in it.
- **Why it is this loud.** When a feed raised the severity above what the rule fires at,
the page says which indicator did it, in the operator's own words, with the feed and the
confidence — read from the alert's own record rather than looked up in the feed, because
the feed may since have been withdrawn and the escalation still has to be reviewable.
Indicators that matched *below* the confidence floor are reported separately, as
annotations that did not change the judgement.
- **What happened.** One timeline, oldest first: first seen, every observation kept as
evidence (with ports and direction, so it can be drawn on a whiteboard), a repeat, the
indicator matches, and the operator's note. Evidence and indicators share one list on
purpose — two tables side by side make a person line the timestamps up by hand.

**Acknowledge** says somebody has seen it; it is a `POST` that redirects, so a refresh
re-fetches a page rather than re-acknowledging an incident, and a repeat keeps refreshing
the alert underneath it. **Close** requires a reason, because an incident review asks
*why was this closed?* and a blank answer is not one. Both land on the organization's
evidence chain as `guard.alert.acknowledged` / `guard.alert.closed`, against the person
who did it.

**Assign** hands the alert to one person, which is the difference between an incident with
an owner and two people acknowledging the same thing. The row carries the assignee's id
*and* the name they had at that moment — an identity is renamed and deactivated, and a
closed incident still has to say who was asked — the filter offers *mine* and *unassigned*,
and the header counts how many open alerts nobody has picked up. `guard.alert.assigned` /
`guard.alert.unassigned` go on the chain with the person who made the handover, and a
repeat **keeps** the owner: somebody is already working it.

Who may be handed one is a rule about people, and it is shared with the picker the page
renders, so the list cannot offer a name the service would refuse. Only an active *human*
can own an incident: a service identity is refused by name, and so is somebody who has been
switched off — an alert showing a name that will never pick it up is invisible to the
*unassigned* queue, which is worse than one that says nobody has it. A closed alert has no
work left to hand on, so the page offers no picker for it and the service refuses the
handover by name.

Beside the queue, `/console/compliance` is the summary a reviewer is handed: the controls
in force, the population each policy scope governs and the number it resolves to, the
alert backlog, and whether the evidence chain still verifies. Two things are deliberate.
It is **read-only** — a report that could also change a control would be a report and the
thing reported in the same request — and it **reports an absence as an absence**: a
deployment with no second factor enrolled anywhere, no stored baseline, an open alert at
`HIGH` or above, or no detection pipeline at all gets a `WARN` or a `FAIL` naming what is
missing, because a green tick with a footnote is what a review is for catching.

The operator's side of it — the paths, the two POST bodies, and what each action needs to
be permitted — is in [docs/alert-triage.md](./docs/alert-triage.md).

**Prevention reaches a plane, and the plane is a seam rather than a filter.** An action
that becomes `ACTIVE` — immediately, or when a second administrator approves it — is pushed
to whatever `SENTINEL_ENFORCEMENT_PLANE_URL` names, and released from its own stored plan
when it is lifted by hand or by its TTL. A plane answers with an outcome rather than an
exception, so an unreachable firewall cannot undo an approval: the action stays `ACTIVE` and
the refusal is an `enforcement.plane.failed` row naming the plane and its own words. Unset is
a deployment with no plane — the shipped default, said out loud once at startup, where every
action is still an operator's to take and undo and nothing claims a packet was filtered.
The contract is one JSON `POST` per operation; the operator's side of it, including the
example adapter a deployment writes for its own firewall, is in
[docs/enforcement-plane.md](./docs/enforcement-plane.md).

**A raised alert reaches somebody, and the transport is a seam rather than a pager.** When a
rule fires and the store *creates* an alert — not on every sighting that refreshes one — the
alert's own summary is delivered to whatever `SENTINEL_ALERT_WEBHOOK_URL` names, so a queue
nobody is watching is not the detector's only reach. A transport answers with an outcome
rather than an exception, so a webhook that refuses or is unreachable cannot undo a
detection: the alert stays exactly where it is, and the refusal is a `guard.alert.notify.failed`
row naming the transport and its own words. Unset is a deployment with no transport — the
shipped default, said out loud once at startup. The contract is one JSON `POST` of the alert's
summary; the operator's side of it is in [docs/alert-delivery.md](./docs/alert-delivery.md).

**A known detection can be silenced for a bounded window, and the silence is on the record.** An
administrator can create a *mute* on the queue page — a maintenance window, this desk's own
scanner, a load test it scheduled — naming at least one rule, address, asset, device or person,
for a window that must end and is capped at a week. A detection a window catches is **recorded on
the evidence chain (`guard.detection.suppressed`) and not raised**, so the queue stays what is new
and a review can still see what was silenced and by which window; an absence would read as a rule
that stopped firing. A window that names nothing is refused rather than read as "any", because
the one rule a person makes by accident is the one that switches the detector off — and the
section is rendered only for an administrator, with the service refusing everybody else, because
a list of where the detector has been made blind is not a page for the whole desk.

## Containers

All three products ship the same shape: a `Dockerfile` and a `docker-compose.yml`,
with a `docker-compose.prod.yml` overlay for a real deployment.

```bash
cd ontrak-sentinel
docker compose up -d --build     # builds, migrates the spine, serves on :8787
```

Two things differ from the other two stacks, both deliberate. It needs no `.env`
to start — every value has a working default and the stack reads `.env` when it
exists rather than requiring one — so a first `up` works on a bare checkout. And it
publishes its database on **5434**, because Sentinel keeps its own database and all
three stacks can then run at once: the training app holds 5432, Tix 5433, Sentinel
5434.

The provider answers to the same make targets as the others: `sentinel-up`,
`sentinel-down`, `sentinel-logs`, and `sentinel-prod-up` / `sentinel-prod-down` for
the overlay.

The stack keeps its **signing key on a volume**. A one-shot `signing-key` service
generates one on the first `up` and every later run reuses it, so restarting or
rebuilding does not stop the provider signing with the key it has already
published — which is the failure that matters, because a client that cached the
JWKS would otherwise be left holding a key that no longer signs anything, and the
symptom is a wave of token rejections everywhere the provider federates into. The
production overlay requires `SENTINEL_SIGNING_KEY` instead: a key on one host's
volume is right for a single node and wrong the moment there is a second replica,
which would generate its own. `make sentinel-key` prints a key in the single
escaped line `.env.production` wants.

`scripts/smoke.ts` asks the question no unit test can — does the thing in the
image actually sign somebody in, over the wire, with the key it is holding now? It
runs a full authorization-code flow with PKCE and verifies the ID token's signature
against the JWKS the provider itself serves. CI runs it against this compose stack
on every push, so a Dockerfile that quietly stops working fails the build instead
of a release.

**Rotating that key is a two-step**, because a key cannot be swapped in one: for as
long as a token the old key signed is still valid, the new key has to be *published*
before it can be *used*. Point `SENTINEL_SIGNING_KEY` and `SENTINEL_SIGNING_KID` at
the new key and put the old one in `SENTINEL_SIGNING_PREVIOUS_KEY` with
`SENTINEL_SIGNING_PREVIOUS_KID`. Both keys are then in the JWKS and in the SAML
metadata — one `KeyDescriptor` per key, so a service provider that re-reads metadata
can verify an assertion signed by either — while only the new key signs. Once every
relying party has re-read the JWKS, remove the two `SENTINEL_SIGNING_PREVIOUS_*`
settings, and the retired key is genuinely retired: what it signed stops verifying,
so the window closes rather than leaving a second key published forever. The two
mistakes that would start and then quietly misbehave — a retired key with no `kid`,
and one named as its own predecessor — are refused at startup rather than published
ambiguously. `tests/sentinel-key-rotation.test.ts` drives the whole thing, including
a token issued before the rotation verifying after it.

The identity side is complete through S2 — provisioning, deprovisioning, directory
sync, access reviews and scheduled attestation, all reachable from the console.
What remains is the detection and prevention halves of Sentinel Guard; see
[ROADMAP.md](./ROADMAP.md).
