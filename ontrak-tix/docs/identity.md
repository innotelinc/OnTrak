# Identity (IdP) integration

Local passwords (scrypt) are the M0 fallback. From **M2** a tenant's staff sign
in through the tenant's own identity provider, and provisioning happens from the
IdP, not from an administrator retyping an org chart.

This slice lands the **decisions** — what a set of IdP claims means for this
tenant — plus the persistence, the audit trail and the OIDC handshake.

## Pieces

| Concern | Where |
| --- | --- |
| Pure rules: config validation, domain/MFA gates, role mapping, SCIM plan | `src/lib/identity-rules.ts` |
| Service: configure, sign in, SCIM | `src/lib/identity-service.ts` |
| Prisma adapter (connection + users) | `src/lib/identity-store-prisma.ts` |
| Pure OIDC rules: discovery, authorization URL, claims, state | `src/lib/oidc-rules.ts` |
| OIDC client (discovery + token exchange, JWKS verification) | `src/lib/oidc-client.ts` |
| Signed authorization-state cookie | `src/lib/sso-session.ts` |
| SSO entry points | `src/app/api/sso/start/route.ts`, `src/app/api/sso/callback/route.ts` |
| Connection administration UI | `src/app/(desk)/admin/identity/page.tsx`, `src/components/IdentityConnectionForm.tsx`, `src/app/actions/identity.ts` |
| Models | `prisma/schema.prisma` (`IdentityConnection`, `User.externalId`) |
| Tests | `tests/tix-m2-identity.test.ts`, `tests/tix-m2-sso.test.ts` |
| A real test IdP, and the handshake driven against it | `tests/support/local-idp.ts`, `tests/tix-m2-sso-local-idp.test.ts` |
| The handshake driven through the running app | `tests/tix-m2-sso-live.test.ts` |
| Pure role rules: narrowing, validation, the stranding guard | `src/lib/role-rules.ts` |
| Role service | `src/lib/role-service.ts` |
| Prisma adapter (roles + holders) | `src/lib/role-store-prisma.ts` |
| Role administration UI | `src/app/(desk)/admin/roles/page.tsx`, `src/app/actions/roles.ts` |
| Models | `prisma/schema.prisma` (`TenantRole`, `User.tenantRoleId`) |
| Tests | `tests/tix-m6-roles.test.ts` |

## The connection

One `IdentityConnection` per tenant, configured by an administrator
(`tenant:manage`). An administrator is validated before it is stored:
the protocol is `OIDC` or `SAML`, the issuer is an absolute http(s) URL, a client
id is present, the default role and every mapping target is a real role, and each
allowed domain looks like a domain.

The **client secret is deliberately not part of this record.** It lives in the
deployment's secret store, so a database dump never leaks a usable credential.

`roleMappings` is JSON config, not code: a list of
`{ claim?, value, role }`, where `claim` defaults to `groups`. A mapping lets an
org-chart change (a new group, a renamed team) land as configuration rather than
a deploy. The claim match is case-insensitive because IdPs disagree about the
case of group names.

## Sign-in

`authorizeSignIn` is the whole gate, in order:

1. **Issuer** — the assertion must come from this tenant's IdP.
2. **Email** — a usable address must be asserted.
3. **Domain** — if the connection names allowed domains, the address must be in
   one of them.
4. **MFA** — if the connection requires it, the assertion must carry
   second-factor evidence (`amr` of `otp`/`hwk`/`webauthn`/…, or an explicit
   `mfa: true`).

Then `mapRole` walks the mappings and falls back to the connection's default.

`IdentityService.signIn` resolves the claims to a user — by the IdP subject first,
then by email — **creating** the user on a first sign-in and **updating** it
afterwards, including a role change when the groups moved. Every attempt is
audited: a successful sign-in as `identity.signin`, a refusal as
`identity.signin.denied` (with the reason, and not the address), a role change as
`identity.role.change`.

## SCIM

`planScimProvision` turns one SCIM push into exactly one
`CREATE` / `UPDATE` / `DEACTIVATE` / `NOOP`:

- A **deactivation** wins over everything else — deprovisioning is immediate and
  unconditional — and repeating it is a `NOOP`.
- An **unknown** user is created with the role their groups imply.
- A **known** user is updated; a push that names no groups falls back to the
  connection's default role, because SCIM replaces the resource rather than
  patching it.
- A push that changes nothing is a `NOOP`, so a nightly sync does not rewrite
  history.

Applied through the same `User` row the rest of the app already trusts, so
deprovisioning disables the desk access as well as the IdP login. Every applied
plan is audited as `identity.scim.provision` or `identity.scim.deprovision`.

### Outbound: the desk pushes its people

`planScimProvision` above is the *inbound* direction — an IdP pushing users at
Tix. The desk also speaks SCIM the other way, because that is how the family is
deployed: **the desk is where the people are.** An administrator adds an agent
here; nobody wants to add them a second time in the provider's console, and a
deployment where the two disagree is one where somebody who left still has an
identity at the IdP.

| Concern | Where |
| --- | --- |
| Pure rules: the target, the plan, the wire shapes | `src/lib/scim-rules.ts` |
| The client: `HttpScimClient`, and a provider in memory | `src/lib/scim-client.ts` |
| The service: whose people, in what order, what is recorded | `src/lib/scim-sync-service.ts` |
| Prisma adapter (the listing) | `src/lib/scim-sync-store-prisma.ts` |
| The console card and its action | `src/components/ScimPushCard.tsx`, `/admin/identity` |
| The scheduled run | `src/app/api/scim/push/route.ts`, `scripts/scim-sweep.ts` |
| Tests | `tests/tix-m2-scim-push.test.ts`, and the opt-in `tests/tix-m2-scim-live.test.ts` and `tests/tix-m2-scim-sweep-live.test.ts` |

`ontrak-tix/.env` names the target: `ONTRAK_TIX_SCIM_BASE_URL` (the provider's
origin) and `ONTRAK_TIX_SCIM_TOKEN` (a connector token minted in the provider's
console — in OnTrak Sentinel, `/console/provisioning`). The token is read from the
environment, never stored in a row, for the same reason the client secret is not:
a database dump must not be a set of working credentials. With neither variable
set the card says the deployment is not configured and offers no button; with one
of them set it refuses and says which one is missing.

`planScimPush` turns one person into exactly one `CREATE` / `REPLACE` /
`DEACTIVATE` / `NOOP`:

- The match is **`externalId` first** (Tix's own account id), then `userName`. A
  person changing their address moves the provider's identity instead of creating
  a second one.
- A person the provider does not have is created; a person whose details moved, or
  who is active here but switched off there, is **replaced** — the desk is the
  system of record for its own people, so provider-side drift is what the sync
  exists to close.
- Somebody switched off here is **deactivated** there, and repeating it is a
  `NOOP`, so a nightly run over an unchanged desk writes nothing at all.
- **Roles are deliberately not pushed.** Sentinel issues its own roles
  (ADMIN/AGENT/AUDITOR), Tix has a different set, and any mapping between them
  would grant or remove *privilege* at the provider as a side effect of a desk
  edit. Provisioning answers "who exists and may they sign in"; the provider's own
  console stays the one place that decides what they may do there.

One person's refusal does not abandon the run: the provider's own sentence (and
its `scimType`, because `uniqueness` and `invalidValue` are different futures) is
reported for that person and the rest continue. Each applied change is audited as
`identity.scim.push` — a name distinct from `identity.scim.provision`, because
reading the trail, the two are the two halves of one conversation and an
investigation wants to know which side spoke.

### Keeping it in step: the scheduled push

A button only provisions the people who were added since somebody last pressed it,
and the person it misses is a new colleague who cannot sign in until an
administrator notices. So the same run is reachable without a session:

```bash
# a cron, or anything that can make one HTTP request
curl -fsS -X POST -H "Authorization: Bearer $ONTRAK_TIX_CRON_SECRET" \
  http://127.0.0.1:3001/api/scim/push            # every desk
curl -fsS -X POST -H "Authorization: Bearer $ONTRAK_TIX_CRON_SECRET" \
  "http://127.0.0.1:3001/api/scim/push?tenant=acme"   # one desk

npm run sweep:scim              # the same sweep from a terminal, using the
npm run sweep:scim -- acme      # deployment's own database and configuration
npm run sweep:scim -- --dry-run # report what would change, write nothing
npm run sweep:scim -- acme      # exit 0 = a completed sweep, 1 = it could not run
```

Four things about it are deliberate:

- **It is safe to schedule aggressively, and that is a property of the sync rather
  than of the endpoint.** A person the provider already matches is planned as a
  `NOOP`, so a quiet run performs no provider writes, records no audit entries and
  leaves nothing for anybody to clean up. A sweep every few minutes costs a couple
  of reads per person and no trail noise.
- **An unconfigured deployment is `503`, not `200` with zeroes.** A scheduler's job
  is to notice that a sync stopped happening; a run that reports success while
  pushing nowhere is exactly the failure it cannot see. The body names the two
  variables to set. The script separates the same states with its exit code.
- **The sweep is not an authorization bypass.** It is what the *cron* calls, so it
  carries the deployment's own credential rather than a session, and the changes it
  makes are audited as **`system:scim-sync`** — a system run is still attributable,
  and a reader of the trail can tell an automatic sweep from an administrator's.
  The permission check stays in the service's `push()`, which is the path the
  console takes, because the check belongs where the write is and not where the
  button is.
- **One desk's broken connector does not stop the others.** An unscoped run walks
  every tenant, and a tenant whose push refused is reported per-tenant with the
  provider's own words (the response is `partial`) rather than aborting the sweep.
  The scoping parameter exists for the same reason the SLA and retention sweeps
  have one: an unscoped run is a real change to every desk in the database.

## Single sign-on (OIDC)

A staff member who types their workspace on `/sign-in` starts the
**authorization-code flow with PKCE**:

```
/sign-in ──▶ /api/sso/start ──▶ the tenant's IdP ──▶ /api/sso/callback ──▶ /inbox
             (discover, build     (authenticate)        (exchange, verify,
              state+nonce+PKCE)                          sign in, set session)
```

- **`/api/sso/start?tenant=<slug>`** resolves the workspace to a tenant and its
  connection, discovers the IdP, and builds an authorization request with a CSRF
  `state`, a replay `nonce` and an S256 PKCE challenge. Those three are stored in
  one short-lived (10-minute) signed cookie — never in the URL — and the browser
  is redirected to the IdP. A workspace configured for SAML is refused with a
  clear message rather than half-handled.
- **`/api/sso/callback`** recovers and checks the state, exchanges the code, and
  verifies the ID token's signature against the issuer's published JWKS (via
  `jose`), plus its `iss`, `aud` and `nonce`. Only then are the claims mapped
  (`extractOidcClaims`) and handed to `IdentityService.signIn` — so SSO and SCIM
  share one role-mapping decision. The ordinary Tix session is issued last.

The client secret comes from the deployment (`ONTRAK_TIX_OIDC_CLIENT_SECRET`),
never from the connection row, so a database dump is not a credential leak. The
route returns to a same-site `returnTo` path only, so the callback can never be
turned into an open redirect.

### Proving it works

Two tests go beyond fixtures, because "the rules add up" is not the same claim as
"single sign-on works".

`tests/support/local-idp.ts` is a real, minimal OpenID Connect provider on a
loopback port. It signs actual ID tokens with an actual key, publishes the JWKS,
enforces `response_type=code`, S256 PKCE, a single-use code and (optionally) a
client secret — and can be told to sign with a key it does not publish, which is
the only honest way to test "a forged token is refused".

```bash
npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m2-sso-local-idp.test.ts
```

That covers discovery, the authorize redirect, the code exchange with PKCE
checked by the provider, `jose` verifying the signature against the JWKS, and the
claims pass — plus the refusals: a replayed code, a wrong verifier, a forged
signature, an unverified email, a wrong nonce, a foreign issuer, a missing client
secret, and claims the tenant's own connection config forbids (domain allow-list,
required MFA).

The live test goes one step further and drives the app's own routes:

```bash
ONTRAK_TIX_BASE_URL=http://127.0.0.1:3001 \
  npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m2-sso-live.test.ts
```

It boots the test provider, writes a real `IdentityConnection` for a throwaway
tenant, then walks `/api/sso/start` → the provider → `/api/sso/callback` with a
cookie jar, exactly as a browser would, and finally fetches `/inbox` with the
session the callback issued. It asserts the user was provisioned with the role
the group mapped to, that the session is real (the page renders with it and
redirects without it), that the sign-in is on the tenant's hash chain, and that an
unknown workspace, a tenant with no connection, a blank workspace and a forged
callback are each refused with a readable message.

## Roles (M6)

A tenant role is written on this desk, against one of the four built-in roles,
and **keeps a subset of that role's permissions**. It cannot add one. That is the
whole design: the worst a mistaken role can do is take something away from
somebody who already had it, and `Role` keeps meaning what it already meant
everywhere else — the isolation checks here, the API token scopes, and SCIM's
`mapRole` never learn that tenant roles exist.

The intersection is computed once (`effectivePermissions`) and stored already
narrowed, so a row cannot disagree with the rule that reads it. An unknown
permission is dropped rather than left in the array for a later release to start
honouring, and a `baseRole` this release does not know reads as `REQUESTER` — the
least powerful role there is.

`actorHasPermission` is what every page and action asks. An actor carrying a
resolved set is judged by it; an actor carrying none is judged by their built-in
role, which is why a desk that has written no roles behaves exactly as it did
before. The narrowing is resolved as the actor is built for a request
(`withEffectivePermissions`) rather than carried in the session cookie: a cookie
cannot be re-issued when an administrator edits a role, and a permission that
outlives its own revocation until the session expires is the one failure this
feature must not have.

Two edits that would leave nobody active holding `tenant:manage` are refused — a
save that removes it from a role somebody holds, and an assignment of a narrow
role to the last administrator. Archiving has no such guard, and the absence is
deliberate: a role can only narrow, so retiring one can only give power back.

Every change lands on the tenant's hash chain: `role.assign` and `role.unassign`
beside `role.create`, `role.update` and `role.archive`, so "who gave them that, and
when" is answerable from the record rather than from memory — and each entry
carries what the role kept as well as what it withheld. The role's **key is fixed once written** for that reason —
entries name the role by key, and a key that changed would leave every past entry
pointing at something that no longer answers. Archiving is not deleting: the row
stays and its holders fall back to their built-in role.

The screen is `/admin/roles`, one page for both halves of the question — what each
role may do, and who holds which role. It needs `user:manage` (a role catalogue is
a map of the desk's own privileges), shows a permission the base role does not
hold rather than hiding it, and chooses the base role through the URL so the
checklist rendered is the checklist the server will honour.

## What is not here yet

- SAML (the connection is stored, and refused at `/api/sso/start`).
- Inbound SCIM HTTP endpoints — the provisioning *plan* is applied by the
  service; the `/scim` routes an IdP pushes to are not mounted. (Outbound, where
  the desk pushes to the provider, is described above and is wired.)
- IdP-initiated sign-on (the flow is SP-initiated only).
- A scheduled outbound sync: the push runs when an administrator presses the
  button, and a person added to the desk is not at the provider until they do.
