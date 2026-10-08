<div align="center">

# OnTrak Portal

**One sign-in, then the products your role belongs in.**

**Control plane · self-hosted · no database of its own**

</div>

---

## Why a portal

The family is six products that each work on their own, and one more thing that
remembers who somebody is for all of them. Without the portal, that means six
bookmarks, six sign-ins, and a person who has been given the wrong role finding
out by being refused something at 9am. With it, there is one address:

| | |
| --- | --- |
| **Students and instructors** | [its.ontrak.innotel.us](https://its.ontrak.innotel.us) — the training range |
| **Students and instructors** | [lab.ontrak.innotel.us](https://lab.ontrak.innotel.us) — the hands-on lab: real Linux VMs and scenario instances |
| **Technicians** | [tix.ontrak.innotel.us](https://tix.ontrak.innotel.us) — the service desk |
| **Analysts** | [sentinel.ontrak.innotel.us](https://sentinel.ontrak.innotel.us) — identity and intrusion detection |
| **Sysadmins** | [sync.ontrak.innotel.us](https://sync.ontrak.innotel.us) — Network package and container updates |
| **Sysadmins and builders** | [genie.ontrak.innotel.us](https://genie.ontrak.innotel.us) — the browser coding console |
| **Everyone** | [ontrak.innotel.us](https://ontrak.innotel.us) — this portal |

## The one rule

**The portal decides *where to send somebody*, never *what they may do there*.**

Every product already authorises the caller from its own credential: the training
range re-checks the caller on every server action, the desk scopes an agent to
their clients, Sentinel owns the directory, and OnTrak Sync checks a capability on
every route. A second authorisation system here would be a second thing to be
wrong, and the more dangerous of the two would be the one people trusted.

So a tile the portal declines to draw is a courtesy; the product it points at is
still the thing that refuses. The one thing the portal does enforce is that a
person is never *shown* a product they have no business in — because a tile that
always refuses teaches people that refusals are normal.

The consequence is the useful one: **a role change in Cerulean takes effect
everywhere at once**, because nothing here is copied anywhere.

## Roles

One vocabulary, shared with every product in the family and with OnTrak Sync's own
account table:

| Role | Products | How it is usually granted |
| --- | --- | --- |
| `STUDENT` | training, the lab | `ontrak-students` |
| `INSTRUCTOR` | training, the lab | `range-instructors`, `ontrak-instructors` |
| `TECHNICIAN` | the desk | `ontrak-desk` |
| `ANALYST` | Sentinel | `ontrak-analysts` |
| `SYSADMIN` | the desk, Sentinel, Sync, Genie | `ontrak-sysadmins` |
| `ADMIN` | everything, plus account management | `ontrak-admins` |

A group that matches nothing falls back to `STUDENT` — the *least* privileged role
— and the dashboard says so in words rather than leaving somebody to wonder why
they cannot see anything.

## How somebody signs in

Two ways, and the page is honest about which are available:

1. **Cerulean (Authentik)**, the Network's directory. Authorization code flow with
   PKCE; the ID token's signature is verified against the provider's published
   JWKS, and then its issuer, audience, nonce, expiry and email verification are
   checked before anything in it is believed. A group claim decides the role.
2. **Username and password, delegated to [OnTrak Sync](../ontrak-sync/README.md).**
   The portal keeps no accounts. Sync owns the family's local account table — the
   path a LAN with no route to the provider signs in through — and this form is
   how the portal consumes it rather than inventing a second login.

An optional **break-glass account** (`ONTRAK_PORTAL_ADMIN_USER`/`_PASSWORD`,
disabled unless both are set) exists because the honest failure mode of a portal
whose only sign-in is an identity provider is that the provider being down takes
the portal with it. It grants `ADMIN`, it is compared in constant time, and every
use is logged.

## Running it

```bash
cp .env.example .env            # then set ONTRAK_PORTAL_SESSION_SECRET
docker compose up -d --build    # http://<host>:3300
```

Or as part of the family, from the repository root:

```bash
make all-up                     # portal :3300, training :3000, Tix :3001, Sentinel :8787, Sync :8420
```

There is no database, no migration and no state. The portal can be restarted,
moved or rolled back at any moment.

### The environment

| Variable | Why it matters |
| --- | --- |
| `ONTRAK_PORTAL_PUBLIC_URL` | The redirect URI is built from it, and Cerulean compares it byte for byte. A URI built from the container's own address can never match — the most common reason SSO "just does not work". |
| `ONTRAK_PORTAL_SESSION_SECRET` | **Required, no default.** It signs the session cookie; a placeholder is a cookie anybody can mint. |
| `ONTRAK_OIDC_ISSUER` | The *application-scoped* issuer, `…/application/o/ontrak/`. Authentik advertises its base URL as the issuer while an application's endpoints live under the slug, and the discovery document is checked against this value. |
| `ONTRAK_OIDC_ROLE_MAPPINGS` | `authentik-group=ROLE`, comma-separated. An unknown role is **dropped**, never guessed: a typo that silently granted `ADMIN` is worse than one that grants nothing. |
| `ONTRAK_SYNC_API_URL` | Where the password form sends a sign-in. |

## What a product's status light means

Three values, and the third is not a bug:

| | |
| --- | --- |
| **answering** | the product answered its own unauthenticated health endpoint |
| **not answering** | the request failed |
| **not checked** | there is nothing to ask |

`not checked` is drawn in the same grey as "we could not look" on OnTrak Sync's
own dashboard, on purpose. A page of green lights because the prober was broken is
the exact failure the family was built to avoid.

## Tests

```bash
npm test        # 25 tests: role routing, group mapping, claim checks, redirects
npm run typecheck
```

They run with no provider, no network and no browser, and the ones that matter
assert *refusals*: a technician never shown the sysadmin's product, a group list in
an unexpected order still resolving to one role, an assertion that is valid but was
issued to another application, and a callback that will not redirect to somebody
else's site.

## Layout

```
src/lib/portal-rules.ts   the catalogue, the role routing, the redirect rule  ← pure, tested
src/lib/oidc-rules.ts     what an assertion means, and every refusal           ← pure, tested
src/lib/oidc-client.ts    discovery, PKCE, the token exchange, JWKS verify
src/lib/session.ts        the signed session and SSO-state cookies
src/lib/sync-client.ts    OnTrak Sync: local sign-in and product probes
src/app/api/sso/*         the two halves of the Cerulean handshake
src/app/api/login         password sign-in, delegated to OnTrak Sync
src/app/page.tsx          the dashboard
```

## License

MIT — see [LICENSE](../LICENSE). Copyright © 2026 Innotel Inc.

---

*OnTrak Portal · Control plane · the front door of the [OnTrak family](../INNOTEL-LABS.md)*
