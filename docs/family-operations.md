# Running the OnTrak family

**Six products, one identity layer, six names.** This is the operations guide:
what runs where, how a person gets in, and what to do when something does not.

It is written for the deployment that exists, and it is deliberately specific —
addresses, ports and the commands that were actually run. A guide that describes
an architecture instead of a deployment is a guide nobody can follow at 3am.

---

## 1. What runs where

| Product | Address | Port | What it is |
| --- | --- | --- | --- |
| **Portal** | `ontrak.innotel.us` | 3300 | One sign-in, then the products a role belongs in |
| **Training** | `its.ontrak.innotel.us` | 3000 | Browser-based, automatically-graded IT support practice |
| **Tix** | `tix.ontrak.innotel.us` | 3001 | Tickets, SLAs, clients, incident evidence |
| **Sentinel** | `sentinel.ontrak.innotel.us` | 8787 | Identity provider and intrusion detection console |
| **Sync** | `sync.ontrak.innotel.us` | 8420 (API) / 8421 (dashboard) | Network package and container updates, and the family's local account table |
| **Genie** | `genie.ontrak.innotel.us` | 3400 | The browser console for a coding agent: it reads, edits and runs code in a workspace it cannot leave, and shows each call as it happens |

All six run on the **`ontrak` incus container**, `192.168.1.21`, on host **i1**
(`192.168.1.51`). Each is independently deployable and each has its own stack;
`docker-compose.all.yml` in the repository root runs them together.

Genie is the one product whose own stack and the family's stack would otherwise be
the same service on the same port, so the product-only compose in `ontrak-genie/`
defaults to **:3410** and :3400 has exactly one owner — this table's `genie-app`.
Both stacks read `ONTRAK_GENIE_PORT`, so one setting moves whichever you are starting.

```
                    ┌──────────────────────────────────────────┐
   browser ────────▶│  Cerulean edge (192.168.1.71)            │
                    │   NPM :80/:443   +  *.ontrak wildcard     │
                    └────────────────┬─────────────────────────┘
                                     │  six proxy hosts
                    ┌────────────────▼─────────────────────────┐
                    │  ontrak container · 192.168.1.21          │
                    │   :3300 portal   :8421 sync dashboard     │
                    │   :3000 training :3001 tix   :8787 sentinel│
                    │   :3400 genie                             │
                    └──────────────────────────────────────────┘
                                     │
                    Cerulean/Authentik ─ auth.cerulean.innotel.us
```

## 2. Identity

**Cerulean runs Authentik** at `https://auth.cerulean.innotel.us`, and it is the
directory. One OIDC client, `ontrak`, serves every product; a product registers its
callback in the client's redirect URI list rather than getting a client of its own,
because one client means one place a group mapping can be wrong.

Application-scoped issuer — note the slug, which is what has to match the
discovery document:

```
https://auth.cerulean.innotel.us/application/o/ontrak
```

### The role groups

Created in Authentik by `cerulean/scripts/authentik-setup.py ontrak`, and mapped
to family roles by `ONTRAK_OIDC_ROLE_MAPPINGS` in each product's `.env`:

| Authentik group | Role | Belongs in |
| --- | --- | --- |
| `ontrak-students` | `STUDENT` | training |
| `range-instructors`, `ontrak-instructors` | `INSTRUCTOR` | training |
| `ontrak-desk` | `TECHNICIAN` | Tix |
| `ontrak-analysts` | `ANALYST` | Sentinel |
| `ontrak-sysadmins` | `SYSADMIN` | Tix, Sentinel, Sync |
| `ontrak-admins` | `ADMIN` | everything, plus accounts |

Add a person to a group in Authentik and their access follows within one
sign-in — nothing is copied into a product, which is why a change here needs no
migration anywhere else.

A group that matches nothing falls through to `ONTRAK_OIDC_DEFAULT_ROLE`
(`STUDENT` — the *least* privileged role). The portal says so on the dashboard
rather than leaving it to be discovered.

### The one detail that breaks sign-in quietly

**Authentik's application-scoped issuer ends in a slash** —
`https://auth.cerulean.innotel.us/application/o/ontrak/` — and that is the exact
string it puts in an ID token's `iss`. Products store the issuer with the slash
trimmed, because a `.env` value is read by three programs that disagree about
trailing whitespace and quotes. A verifier that compares its configured issuer
*byte for byte* therefore rejects a token that is entirely valid, and it does it
**after** the password has been typed: the portal showed `the ID token was not
accepted: unexpected "iss" claim value` and the browser landed on `0.0.0.0:3300`,
because a refusal redirect was built from the address the proxy used instead of the
one the browser typed. Both are fixed and both have regression tests
(`ontrak-portal/tests/oidc-issuer.test.ts`): the verifier is handed the *advertised*
issuer, and every browser-facing redirect is built from `ONTRAK_PORTAL_PUBLIC_URL`.
When a new product is added, copy that shape rather than the literal comparison.

### The redirect URIs registered on the `ontrak` client

```
https://ontrak.innotel.us/api/sso/callback            the portal
https://ontrak.innotel.us/api/auth/sso/callback       Sync (same origin as the portal's host)
https://its.ontrak.innotel.us/api/sso/callback        training
https://tix.ontrak.innotel.us/api/sso/callback        Tix
https://sync.ontrak.innotel.us/api/auth/sso/callback  Sync behind the edge
```

`./scripts/cerulean-ontrak.py --print-redirect-uris` prints the same list, so the
script and the registered client cannot drift apart unnoticed.

## 3. Adding a hostname, or repairing one

`scripts/cerulean-ontrak.py` is idempotent and is the one command that provisions
the public names. Run it **on the Cerulean host**:

```bash
cd /usr/src/projects/complete/1-primary/cerulean
python3 /path/to/ontrak/scripts/cerulean-ontrak.py --dry-run    # what would change
python3 /path/to/ontrak/scripts/cerulean-ontrak.py              # do it
```

It ensures, for each name: a Technitium A record at the address the zone apex
already uses, an NPM proxy host forwarding to the product's port, and the
certificate that covers the name — including the Network's `*.ontrak.innotel.us`
wildcard, which is the one that matters for the four subdomains.

### `already in use`, and why it is not obvious

NPM refuses a domain that another object holds, **and three of those objects do
not appear in the API that lists proxy hosts**: a soft-deleted proxy host, a 404
("dead") host, and a redirection host. An earlier deployment of a product leaves
the first two behind, so a fresh install hits "already in use" for a name nothing
visible is using. Find the holder:

```bash
docker exec cerulean-npm-db mariadb -uroot -p"$NPM_DB_ROOT_PASSWORD" -e "
SELECT 'proxy', id, is_deleted, domain_names FROM npm.proxy_host WHERE domain_names LIKE '%ontrak%'
UNION ALL SELECT 'dead', id, is_deleted, domain_names FROM npm.dead_host WHERE domain_names LIKE '%ontrak%'
UNION ALL SELECT 'redirect', id, is_deleted, domain_names FROM npm.redirection_host WHERE domain_names LIKE '%ontrak%';"
```

…then delete the row that is genuinely obsolete. The script prints the same
diagnostic when it hits this.

## 4. Deploying a change

On the **`ontrak` container** (`incus exec ontrak -- bash`), everything comes from
one checkout:

```bash
cd /usr/src/ontrak && git pull
cd ontrak-tix       && docker compose up -d --build     # one product
cd ..               && docker compose -f docker-compose.all.yml up -d --build   # or all six
```

Each product is still its own stack with its own project name, so a rebuild of one
recreates that product's containers and keeps every volume — the family file is for
running them together, not a requirement for running one.

The images are built on the host, so a deploy is a rebuild rather than a pull. The
`.env` files are **not** in the repository and each one is load-bearing:
`/usr/src/ontrak/.env` (the training app and the shared stack), `ontrak-tix/.env`,
`ontrak-sentinel/.env`, `ontrak-sync/.env` (the live `ONTRAK_API_TOKEN`) and
`ontrak-portal/.env` (the session signing secret). Back them up before a redeploy —
a deployment that regenerates the API token silently breaks anything already using it.

### After the first start of OnTrak Sync

The service creates **one administrator** on an empty database, because otherwise
the dashboard is a login page nobody can pass. The username and a generated
password are printed **once**:

```bash
docker logs ontrak-sync-api 2>&1 | grep 'generated password'
```

Sign in, change it, and add the real people. Set `ONTRAK_ADMIN_PASSWORD` instead
if you would rather choose it — but note it is read only when the database is
empty, so a stale value can never restore a password somebody rotated.

## 5. Checking it

From anywhere on the Network:

```bash
for h in ontrak its.ontrak tix.ontrak sentinel.ontrak sync.ontrak genie.ontrak; do
  printf '%-26s ' "$h.innotel.us"
  curl -s -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' "https://$h.innotel.us/"
done
```

`curl` **201** on the training range, **200** on the portal, and `200 {"status":"ok"}`
on `https://sync.ontrak.innotel.us/api/health` are healthy answers. A **403/401** is
also a healthy answer for a product behind its own sign-in. A **502** means NPM is
up and the product is not — check `docker compose ps` on the container.

Then, in a browser:

1. `https://ontrak.innotel.us` → the sign-in page, with a **Sign in with Cerulean**
   button.
2. Sign in → the dashboard shows only the tiles for that role.
3. Open each tile → it opens without a second sign-in, because the product
   consumes the same directory.

## 6. When sign-in fails

| Symptom | Cause | Fix |
| --- | --- | --- |
| No SSO button | `ONTRAK_OIDC_ISSUER`/`_CLIENT_ID` not both set | set them and restart |
| "redirect_uri mismatch" at the provider | the registered URI is not what the deployment builds | it is `<ONTRAK_PUBLIC_URL>/api/sso/callback`, byte for byte |
| "The sign-in expired or was replayed" | the state cookie is over ten minutes old, or something dropped it | start again; check the edge is not stripping cookies |
| "None of your groups maps to a role" | the person is in no role group | add them to one in Authentik |
| The session vanishes on every page | the portal is reached on one host and built to call the API on another | build the dashboard with `ONTRAK_PUBLIC_API=` (empty), so it is same-origin |
| Local sign-in says the account table is unavailable | OnTrak Sync is not answering | `docker logs ontrak-sync-api`; SSO is unaffected |

The last row is the split worth remembering: **the portal's two sign-in paths fail
independently.** Cerulean signing in is not affected by Sync being down, and Sync's
account table is not affected by Cerulean being down.

## 6a. Signing in for the first time

| Product | How |
| --- | --- |
| Portal `ontrak.innotel.us` | **Sign in with Cerulean**, or the local username/password form |
| Training `its.ontrak.innotel.us` | `admin@ontrak.local`, `instructor@ontrak.local`, `student@ontrak.local` — password `change-me-ontrak` (set `SEED_PASSWORD` before seeding to choose it). Student join code `NET101`. |
| Tix `tix.ontrak.innotel.us` | `admin@acme.test`, `dispatcher@acme.test`, `agent@acme.test`, `requester@acme.test` — password `ChangeMe123`. The SSO button uses the workspace in `ONTRAK_TIX_DEFAULT_TENANT` (`acme` here); anything else is refused, which is the point of the slug. |
| Sentinel `sentinel.ontrak.innotel.us` | Its console is at `/console` and holds its own accounts and MFA — the root path is deliberately a 404, because the provider has no landing page to show. |
| Sync `sync.ontrak.innotel.us` | `ONTRAK_ADMIN_USER` and the password printed once on an empty database (`docker logs ontrak-sync-api | grep 'generated password'`), or Cerulean. |
| Genie `genie.ontrak.innotel.us` | **Sign in with Cerulean**, through the same `ontrak` client as the portal; with no issuer configured the console falls back to its own `WEB_TOKEN`. |

A person's *role* decides which tiles the portal draws: `ontrak-students` and
`ontrak-instructors` reach training, `ontrak-desk` reaches Tix, `ontrak-analysts`
reaches Sentinel, `ontrak-sysadmins` and `ontrak-admins` reach everything. Change
the group in Authentik and the tiles follow at the next sign-in — nothing is copied
into a product, so there is no second place to update.

## 7. What is not here yet

Stated plainly, because a guide that only lists what works is a guide that wastes
somebody's afternoon:

- **Two training scenarios are blocked on purpose** until their prerequisite is
  present: "Close an open mail relay" needs the postfix package enabled, and
  "Asset reconciliation visit" needs the Contoso Asset Suite key stored. The
  seeding output says so as well.
- **Sentinel's root path answers 404.** The console lives at `/console`; there is no
  marketing page to redirect to, and inventing one would be a page that lies about
  what the product is.
- **SAML and IdP-initiated sign-on** are not implemented; the flow is
  SP-initiated OIDC only.
- **No self-service password reset.** There is no mail server in this Network's
  trust path, and a reset flow that cannot deliver a message is a login page that
  lies. An administrator resets through the dashboard.
- **The portal does not sign you out of the products.** It clears its own session
  and says so; each product holds its own credential.
