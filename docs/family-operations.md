# Running the OnTrak family

**Five products, one identity layer, five names.** This is the operations guide:
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
| **Sync** | `sync.ontrak.innotel.us` | 8420 (API) / 8421 (dashboard) | Estate package and container updates, and the family's local account table |

All five run on the **`ontrak` incus container**, `192.168.1.21`, on host **i1**
(`192.168.1.51`). Each is independently deployable and each has its own stack;
`docker-compose.all.yml` in the repository root runs them together.

```
                    ┌──────────────────────────────────────────┐
   browser ────────▶│  Cerulean edge (192.168.1.71)            │
                    │   NPM :80/:443   +  *.ontrak wildcard     │
                    └────────────────┬─────────────────────────┘
                                     │  five proxy hosts
                    ┌────────────────▼─────────────────────────┐
                    │  ontrak container · 192.168.1.21          │
                    │   :3300 portal   :8421 sync dashboard     │
                    │   :3000 training :3001 tix   :8787 sentinel│
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
certificate that covers the name — including the estate's `*.ontrak.innotel.us`
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

On the **`ontrak` container** (`incus exec ontrak -- bash`):

```bash
cd /opt/ontrak-sync    && docker compose up -d --build     # API + dashboard
cd /opt/ontrak-portal  && docker compose up -d --build     # the portal
```

Both images are built on the host, so a deploy is a rebuild rather than a pull.
The `.env` files are **not** in the repository: `/opt/ontrak-sync/.env` holds the
live `ONTRAK_API_TOKEN`, and `/opt/ontrak-portal/.env` holds the session signing
secret. Back them up before a redeploy — a deployment that regenerates the API
token silently breaks anything already using it.

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

From anywhere on the estate:

```bash
for h in ontrak its.ontrak tix.ontrak sentinel.ontrak sync.ontrak; do
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

## 7. What is not here yet

Stated plainly, because a guide that only lists what works is a guide that wastes
somebody's afternoon:

- **The training, Tix and Sentinel stacks are not running on this container yet.**
  Their names, certificates and proxy hosts all exist and point at the right ports;
  bring the products up with `make all-up` from the repository root, or each
  product's own `docker compose up -d --build`. Until then those three names
  answer 502, which is honest about the state rather than pretending.
- **SAML and IdP-initiated sign-on** are not implemented; the flow is
  SP-initiated OIDC only.
- **No self-service password reset.** There is no mail server in this estate's
  trust path, and a reset flow that cannot deliver a message is a login page that
  lies. An administrator resets through the dashboard.
- **The portal does not sign you out of the products.** It clears its own session
  and says so; each product holds its own credential.
