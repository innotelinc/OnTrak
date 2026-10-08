# One identity for the lab

> **Status: operator-run, not executed here.** This is the Step 3 artefact of the
> OnTrak ⇄ OnTrak-dev consolidation (`docs/consolidation-audit.md`, §7). It is a set of
> configuration steps an operator performs on a lab host. **OnTrak-dev is not changed
> by anything in this document**, and no lab is deployed in the environment this was
> written in — so nothing below has been run end to end.

The lab is the hands-on half of the same training the range runs in a browser. Its
portal already signs a person in through a single OIDC provider, keeps no password of
its own, and re-reads the provider's groups on every sign-in
(`OnTrak-dev/ontrak/oidc.py`). What it does not yet share is the family's *identity*:
today it points at Authentik directly and knows only two roles, `instructor` and
`student`. This document says how to point it at the family's provider and how its two
roles line up with the family's six.

## What the lab already is

Two facts make this a configuration change rather than a code change.

- **It is a relying party, not an identity provider.** There is no local login to fall
  back to and no credential stored: the `password_hash` column every account row
  carries holds the literal sentinel `sso:authentik` (`OnTrak-dev/ontrak/auth.py`,
  `ACCOUNT_SENTINEL`), which nothing verifies.
- **It speaks plain OIDC discovery.** The flow reads the issuer's
  `/.well-known/openid-configuration`, uses the `authorization_endpoint`,
  `token_endpoint` and `userinfo_endpoint` it names, and reads identity from
  **userinfo** — reached with the access token it was just issued — rather than
  verifying an `id_token` against JWKS (`OnTrak-dev/ontrak/oidc.py`). Any provider that
  serves those documents and returns `email` and `groups` will work.

One caveat worth naming: the flow is generic OIDC, but the *copy* is Authentik's — the
login page names "Authentik" and a refusal reads "Authentik refused the sign-in"
(`oidc.py` `public_config`, `portal/app.py` `/oidc/callback`). Pointing the issuer at
the family's provider therefore works, and the words on the page will keep saying
Authentik until the lab's own copy is changed, which is out of scope here.

## The provider the lab points at

The family's IdP is **Sentinel** (which itself federates to Cerulean/Authentik when a
deployment uses that — see the audit, §3.4 and §6/C5). The lab needs that provider to
return, from userinfo:

- `email` — the lab's key for an account; the row is keyed by the lowercased email
  (`oidc.username_for`), and an account with no email is refused rather than given a
  made-up name.
- `groups` — the claim the role is decided from. The lab requests the `groups` scope
  (`oidc.SCOPE`), so the provider must carry the same group claim mapping the family's
  other relying parties use.

## Pointing the lab at it

The lab's `ONTRAK_<SECTION>__<KEY>` convention (`ontrak/config.py`) addresses the
`portal` section's fields. Every one of the four `oidc_*` values must be set for SSO to
be enabled at all; an empty one fails the flow closed rather than half-working
(`oidc.enabled`).

| Variable | Sets | Notes |
| --- | --- | --- |
| `ONTRAK_PORTAL__OIDC_ISSUER` | `portal.oidc_issuer` | The family IdP's issuer URL. Its discovery document is fetched from here. |
| `ONTRAK_PORTAL__OIDC_CLIENT_ID` | `portal.oidc_client_id` | The client registered with the provider for the lab. |
| `ONTRAK_PORTAL__OIDC_CLIENT_SECRET` | `portal.oidc_client_secret` | Never sent to a browser. |
| `ONTRAK_PORTAL__OIDC_REDIRECT_URI` | `portal.oidc_redirect_uri` | Comma-separated; **canonical (first) entry wins**. Every entry must also be registered on the provider. |
| `ONTRAK_PORTAL__OIDC_INSTRUCTOR_GROUP` | `portal.oidc_instructor_group` | The provider group whose members are class-facing. Empty promotes nobody to `instructor`. |
| `ONTRAK_PORTAL__OIDC_REQUIRED_GROUP` | `portal.oidc_required_group` | If set, an account must be in this group to enter the range at all. Empty admits any account the provider authenticates. |
| `ONTRAK_PORTAL__SECRET` | `portal.secret` | Signs the lab's own session cookie. Unrelated to the provider, but required or the portal will not sign anybody in. |

**The redirect URI is `<lab origin>/oidc/callback`.** The lab answers on more than one
name, and the callback follows the origin the sign-in started on — so every origin the
range serves must appear in the list *and* be registered on the provider, or that origin
cannot sign in at all (`oidc.callback_for`; `config/ontrak.yaml` documents the same for
the range's three names). For a lab behind the family edge, that is:

```
ONTRAK_PORTAL__OIDC_ISSUER="https://sentinel.<base-domain>/application/o/ontrak-lab"
ONTRAK_PORTAL__OIDC_CLIENT_ID="ontrak-lab"
ONTRAK_PORTAL__OIDC_CLIENT_SECRET="…"
ONTRAK_PORTAL__OIDC_REDIRECT_URI="https://lab.<base-domain>/oidc/callback"
ONTRAK_PORTAL__OIDC_INSTRUCTOR_GROUP="ontrak-instructors"
```

`ONTRAK_PORTAL__OIDC_INSTRUCTOR_GROUP` names a *single* group. See the mapping below for
why that is coarser than the family's roles and what to do about it.

The session cookie the lab issues stays the lab's own: an HMAC-SHA256 value signed with
`portal.secret`, `httponly`, twelve hours (`ontrak/auth.py`). The provider change does not
touch it.

## The role mapping

The lab has two roles; the family has six. The mapping is explicit and the **provider's
groups decide it** — nothing is inferred from an email, a display name or the shape of an
account.

| The lab's role | The family's role(s) it stands for | How it is granted |
| --- | --- | --- |
| `instructor` | `INSTRUCTOR`, `TECHNICIAN`, `ADMIN` | Membership of `ONTRAK_PORTAL__OIDC_INSTRUCTOR_GROUP`; an IdP superuser is always treated as `instructor` (`oidc.role_for`) |
| `student` | `STUDENT` | Everyone the provider authenticates who is not in the instructor group |

Two things follow, and both are honest limitations rather than details:

- **The lab's `instructor` is coarser than the family's three roles.** The lab asks one
  question — "is this person class-facing?" — where the family distinguishes an
  instructor from a technician from an administrator. So the lab's
  `ONTRAK_PORTAL__OIDC_INSTRUCTOR_GROUP` should be set to a single group that holds the
  family's class-facing staff (the members of the family's `INSTRUCTOR`, `TECHNICIAN`
  and `ADMIN` groups). The family's finer role is still decided **at the family's own
  boundary**, by `roleFromGroups` in `ontrak-portal/src/lib/portal-rules.ts`; the lab's
  two-value answer is not asked to carry it.
- **The mapping is not a rename.** `instructor` does not become `INSTRUCTOR`; it covers
  a set the family resolves more precisely. The audit states the same at §6/C6. Never map
  in the other direction — do not derive a family role from the lab's `student`/`instructor`
  column.

## The lab's account row is a cache, not a source of truth

The lab keeps a `users` row per person so it can hold a display name and a role
(`store.upsert_sso_user`). After this change that row is a **cache keyed by the IdP
subject** — here, the email — and the IdP is the only writable source of identity.
The row is re-derived on every sign-in, so a group change takes effect on the next one
with nothing to keep in step locally.

This is the whole reason to make the change: running the lab's table and the family's
account table as two writable sources of truth is how an offboarding silently fails —
a person removed from the provider stays a `student` in the lab until somebody remembers
to delete the row by hand. One source, re-read on every sign-in, is what makes removal
immediate.

An instructor may still deactivate a row locally, and that control wins over an SSO
sign-in on purpose (a refusal from the local store outranks the provider's yes). That is
a per-deployment override, not a second identity store: it can only ever *narrow* access,
never grant it.

## What this does not do

- **It does not change OnTrak-dev.** No file in that repository is modified by this
  step. It is operator configuration and documentation only.
- **It has not been executed.** No lab host or hypervisor exists in the environment this
  was written in, so every step above is unverified against a running lab. The variable
  names, route paths and role rules are read from the sources named inline; whether a
  given deployment's provider returns a compatible `email` and `groups` for the lab's
  client is something an operator confirms by signing in.
- **It does not make the lab a family product yet.** The lab is a catalogue entry, a tile
  and a gated student link (audit Steps 2 and 4). This step is about *who somebody is*
  when they arrive, not about where the lab is served from, which is §9/Q4.
