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

## What is not here yet

- SAML (the connection is stored, and refused at `/api/sso/start`).
- Inbound SCIM HTTP endpoints — the provisioning *plan* is applied by the
  service; the `/scim` routes an IdP pushes to are not mounted.
- IdP-initiated sign-on (the flow is SP-initiated only).
