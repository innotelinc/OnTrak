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
issues identity; a directory can provision into it and it can read one; and the
first Guard slice turns telemetry into an alert that names a person. What is *not*
here is still stated: a synced group decides nothing yet (roles and groups as
policy is S1's last bullet), Guard has no streaming listener and no triage UI, and
rule rotation and signing-key provisioning are open. The identity spine:

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
- `prisma/schema.prisma` + `prisma/migrations/` — the data model, **migrated**
  in nine steps: `20260928000000_init` (the spine and the evidence log),
  `20260929000000_oidc` (the grant rows), `20260930000000_logout_saml`
  (`AccessToken.revokedAt` and the SAML service providers),
  `20261001000000_mfa_totp` (the TOTP enrollment state on `MfaFactor`),
  `20261015000000_webauthn` (the public key and signature counter on `MfaFactor`,
  plus the `WebAuthnChallenge` table), `20261020000000_scim`
  (`Identity.externalId`, `ScimToken`, `Group`, `GroupMember`),
  `20261025000000_policy_scope` (the `ALL` baseline and the per-role scope on
  `IdentityPolicy`), `20261026000000_directory_sync` (`DirectoryConnection` and
  `DirectorySyncRun`) and `20261027000000_guard_alert` (`Alert`, `AlertEvent`).
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
  rather than a second person; a leaver is deactivated rather than deleted, down
  the same path a SCIM `active:false` takes. Covered by
  `tests/sentinel-directory.test.ts`.
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
  for it, and what it resolves to) and the **directory** page (create a connection,
  run a sync, read the report). Covered by `tests/sentinel-console.test.ts`.
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
  Guard surface at `/guard/v1` when a token is configured. Deployable key
  management and rotation are the next slice, so there is no image yet.

The full platform is built *after* OnTrak Tix; see [ROADMAP.md](./ROADMAP.md).

Like the other two products, this one is a project in its own right:

```bash
cd ontrak-sentinel
npm install
npm run typecheck
npm test                      # 260 checks; the Postgres one skips without DATABASE_URL

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
security key, provisioning, policies, directory sync, sign-out). With
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
collector posts, it does not yet tail), no triage UI, no detection-coverage map, and
no rule *editing* — the rulebook is code with a version, and publishing a rule is a
deploy.

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

Per-role policies and key rotation are still to come; see
[ROADMAP.md](./ROADMAP.md).
