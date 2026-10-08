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
| `ontrak-sysadmins` | `SYSADMIN` | Tix, Sentinel, Sync, Genie |
| `ontrak-admins` | `ADMIN` | everything, plus accounts |

The last column is the portal's catalogue answering for each role
(`ontrak-portal/src/lib/portal-rules.ts`), minus **OnTrak Lab** — the catalogue's one
optional product, which a deployment runs only if it says so (§7), so it is not in a
table describing what *this* deployment serves. Add a person to a group in Authentik and
their access follows within one sign-in — nothing is copied into a product, which is why
a change here needs no migration anywhere else.

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
https://genie.ontrak.innotel.us/api/auth/callback     Genie, which signs in itself
```

`./scripts/cerulean-ontrak.py --print-redirect-uris` prints the same list — this list,
and not a second copy of it: `tests/family-ops.test.ts` compares the two, because they
had drifted. The page stopped at five while the client registers six, and the one
missing was Genie's, which is a sign-in that fails at the provider with the
`redirect_uri mismatch` in §6 as the only clue.

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
wildcard, which is the one that matters for the five subdomains.

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

Those two commands are the **development** shape: they build on the host. The four
deployments — Training, Tix, Sentinel and Genie — have overlays beside them that
name a published image and reset the build context, so starting one is a pull:

```bash
make sentinel-prod-up                    # or prod-up / tix-prod-up / genie-prod-up
```

`ONTRAK_TRAINING_IMAGE_TAG`, `ONTRAK_TIX_IMAGE_TAG`, `ONTRAK_SENTINEL_IMAGE_TAG`
and `ONTRAK_GENIE_IMAGE_TAG` in that product's `.env.production` choose the release;
each defaults to the version its overlay was written against. Images come from `ghcr.io/innotelinc/ontrak-*`,
published either by `make publish-images` or by cutting a release, which runs
`publish.yml`. So a deployment needs registry access and a credential
(`gh auth token | docker login ghcr.io -u <user> --password-stdin`) rather than a
toolchain and the memory to run several Next builds at once.

The **development** tags work differently, and deliberately. A dev or family stack
builds on the host, so its images carry the moving `main` tag and every build moves
it — following the branch is what a development checkout is for. A moving tag
cannot say which tree an image came from, though, and two builds of two commits are
then indistinguishable: a container can be running an image older than the checkout
beside it with nothing on screen showing it. So every build also stamps the commit
(`sha-<commit>`, the same rule `make publish-images` and `publish.yml` use), which
is the one tag a later build cannot overwrite. `make images`, `make family-image`
and the per-product `-images` targets apply it as part of the build rather than
leaving it to be remembered. To pin a development stack to one build instead, set
the same variable the overlays use — `ONTRAK_GENIE_IMAGE_TAG=0.2.0 make family-image`.

One thing to know before publishing by hand: the migration image is **separate and
required**. Each migration runs in its Dockerfile's `builder` stage — the stage that
carries the Prisma CLI and the schema tree, which the serving image deliberately
leaves out — so `ontrak-<product>-migrate` is published alongside
`ontrak-<product>`. Publishing only the serving images leaves a deployment that
cannot migrate. Genie is the exception in both directions: it has no database, so
it publishes one image (`ontrak-genie`, the `runtime` stage) and no `-migrate`
twin, and its overlay pins that single image.

The `.env` files are **not** in the repository and each one is load-bearing:
`/usr/src/ontrak/.env` (the training app and the shared stack), `ontrak-tix/.env`,
`ontrak-sentinel/.env`, `ontrak-sync/.env` (the live `ONTRAK_API_TOKEN`) and
`ontrak-portal/.env` (the session signing secret). Back them up before a redeploy —
a deployment that regenerates the API token silently breaks anything already using it.

### The training app's machine credentials, and rotating them

Three credentials in `/usr/src/ontrak/.env` are held by systems rather than people,
so none is a session and none is discoverable from the app. Each is generated on the
host and never committed:

| Variable | Who presents it | Where the other side holds it |
| --- | --- | --- |
| `ONTRAK_SCIM_TOKEN` | the directory's SCIM connector (Entra, Okta) | the connector's **Secret Token** |
| `ONTRAK_API_TOKEN` | whatever reads `/api/v1/*` (results, roster, deliveries) | in each caller |
| `ONTRAK_LTI_KEY_ID` + `ONTRAK_LTI_PRIVATE_KEY` | this app, to the LMS's token endpoint | the matching **public JWKS** in the LTI registration |

**Rotating the SCIM token** is a replace-and-restart, because nothing else reads it
except the connector's next scheduled sync:

```bash
cd /usr/src/ontrak
NEW=$(openssl rand -hex 24)
sed -i "s|^ONTRAK_SCIM_TOKEN=.*|ONTRAK_SCIM_TOKEN=\"$NEW\"|" .env
docker compose up -d app          # re-reads .env; add --force-recreate if it did not
```

Then paste `$NEW` into the connector's **Secret Token** and **Test Connection**
before its next cycle. Until you do, the connector presents a token this app no
longer accepts and every sync answers `401` — a wrong token is `401`, an *unset* one
is `503`, so the two failures name different problems. The value lives in that
`.env` (gitignored); the running container is the other place to confirm it:
`docker exec ontrak-training-app-1 printenv ONTRAK_SCIM_TOKEN`.

**Rotating the LTI passback key** is a change to one side or two, depending on how
the LMS registered the key. This deployment publishes its own public key set at
`https://its.ontrak.innotel.us/api/lti/jwks.json` (`GET /api/lti/jwks.json`), so an
LMS registered with a **Keyset URL** is already reading the key from here: rotate
with `make lti-key` **reusing the same `ONTRAK_LTI_KEY_ID`**, update the two `.env`
lines, and nothing in the LMS changes. An LMS registered with a **pasted key** is
still two sides — the key id, the private key and the LMS's copy of the public half
move together, or the grade silently stays here — and the paste comes from
`make lti-key ARGS="--from-env --pem"` for a key already in `.env`, or from the
fuller output of `make lti-key`. Either way, the key set is cached for an hour, so
a passback in flight during the change is refused and simply does not deliver.

**Reading the deployment's own state** no longer means reading three `.env` files:
the control room at `/admin` shows single sign-on, LTI and directory sync as off,
configured or misconfigured, with the reason, and reports each shared secret as the
name of the variable that holds it. A mis-wired `ONTRAK_OIDC_*`, `ONTRAK_LTI_*` or
`ONTRAK_SCIM_TOKEN` is also the first line of the app log at boot, because the
quiet failure — a deployment that silently fell back to local passwords, or an LMS
that launches nothing — is the one an operator does not notice.

**Leave `ONTRAK_API_TOKEN` alone** unless something is genuinely wrong: several
callers hold it, none re-reads it, and rotating it is a coordinated change rather
than a restart.

### Sentinel is the family's, not a second stack

Sentinel is the one product with two ways to run and one set of host ports
(`:8787` for HTTP, `:5434` for Postgres, `:5514` for Guard's syslog listener and
`:2055` for its NetFlow/IPFIX collector — the standalone stack and the family stack
map all four the same way), so only one of them may serve at a time. The family stack's `sentinel-app` is that
one. Its database and signing key live on the family volumes, and they are **not**
interchangeable with the standalone stack's: starting the family copy against the
volumes it creates for itself mints a **new signing key** and opens an **empty
directory**, which logs every existing user out for good and invalidates every
token already issued — a rotating-secret incident, not a no-op.

The migration is scripted, repeatable and verified:

```bash
ontrak-sentinel/scripts/consolidate-to-family.sh --check   # what it would do
ontrak-sentinel/scripts/consolidate-to-family.sh           # cut over
ontrak-sentinel/scripts/consolidate-to-family.sh --retire  # once the new one answers
```

It stops the standalone stack, copies its Postgres data directory and its
`signing-key.pem` into `ontrak-family_ontrak-family-sentinel-{db,keys}`, starts the
family Sentinel, then verifies the key hash and the identity count. The standalone
volumes are deliberately kept as the rollback. `make sentinel-up` still runs
Sentinel on its own for a laptop or a test box, but it *refuses* while the family
stack is serving it — the ports are the same, so the two are never meant to run
together on one host.

One composition detail worth knowing: `sentinel-app` in `docker-compose.all.yml`
does **not** set `SENTINEL_ISSUER` or `SENTINEL_ADMIN_EMAIL` in its `environment:`
block. They come from `ontrak-sentinel/.env` through `env_file:`. `environment:`
beats `env_file:`, and the family block is interpolated against the repo root
`.env` — which does not carry them — so setting them there would shadow the real
issuer with `http://127.0.0.1:8787` and every ID token would name an origin no
client can reach.

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
- **OnTrak Lab is not one of the six.** It is a peer deployment — OnTrak-dev, Python,
  on its own host — rather than a service `docker-compose.all.yml` starts, and
  `scripts/cerulean-ontrak.py` provisions no name for it, so §1's six names are the whole
  list this deployment serves. A deployment that *does* run a lab says so in two facts:
  `ONTRAK_LAB_ENABLED` and `ONTRAK_LAB_URL`. Put them in the file the deployment
  actually reads — the root `.env` for `docker-compose.all.yml`, which hands them to the
  training app and to the portal, or `.env.production` for the training app's production
  overlay, whose `.env.production.example` does not list them (the overlay passes
  whatever that file holds, so adding the two lines there is enough). Until both are set
  the portal draws
  no lab tile, the training app's control room marks the lab "not deployed here", and
  `npm run health:check` in the portal skips it — deliberately, because a link to a lab
  nobody deployed is a dead link with a status light beside it, and the light can only
  ever read "not answering". Setting the switch without an address is reported as a
  misconfiguration rather than drawn as one. `ONTRAK_LAB_INTERNAL_URL` is the probe's
  address when the lab's public name is not reachable from inside the portal container,
  exactly as the other products have one. That deployment also puts the lab behind this
  deployment's edge ([audit §9/Q4](consolidation-audit.md)): one name,
  `lab.<base domain>`, forwarding to the lab host's single published port with
  websockets enabled, because the lab's own gateway keeps `/` and `/guacamole/` on that
  one port and the Network's `*.ontrak` wildcard already covers the name. The lab's own
  provisioner must not be pointed at this zone: it publishes `ontrak.innotel.us` too,
  and here that name is the portal, so NPM would refuse the second claim rather than
  quietly move the front door. That deployment runs **one** lab host: the lab is
  single-tenant — its VMs share one bridge, one warm pool and one results store, and
  nothing in it names a tenant — so its host sizing is its own arithmetic (2 vCPU and
  4 GiB per student VM, prewarmed before a class) and multi-tenant hosting stays out of
  scope until somebody measures it ([audit §9/Q5](consolidation-audit.md)). Nine people
  cannot be given a lab by adding a second one to this stack: that is a second host and a
  second name. A deployment that runs one also puts the lab's scenarios in the training
  catalogue — `npm run lab:import` writes the 14 of them as `lab`-tagged, published
  scenarios (idempotent by slug, so it is safe on every release), which is what makes a
  student see a door to the real machine at all; without it the catalogue has no lab
  scenario and the two facts above turn nothing on. Those rows are published but have
  **no simulated start**: the lab grades them, this app has no checks for them, and a
  simulated attempt would be a score nobody earned filed as lab-graded, so the student page
  draws the lab door in place of the start button and the server refuses the POST.

  The lab host itself is the other repository's to prepare, and the order is: its own
  `infra/bootstrap-host.sh` (Incus, the lab bridge, the project and the limits profile — it
  refuses a host with no usable `/dev/kvm`), `make setup && make doctor`, `make templates`
  for the scenarios this deployment offers, and finally `npm run lab:import` here so the
  catalogue holds the tasks those templates grade. **Windows and Office scenarios need one
  thing a host cannot fetch for you**: the golden image is built from the operator's own
  Microsoft evaluation media (`make golden`, 30–60 minutes), and without it only the Linux
  scenarios — which run as system containers, no hypervisor image at all — are buildable.
  Reporting a finished session back is the client in
  `integrations/lab-completion-client/`, installed on the lab host and pointed at this
  deployment's address and `ONTRAK_API_TOKEN`; the lab's own store is what says what
  happened, so the call is written on that host.
- **The portal does not sign you out of the products.** It clears its own session
  and says so; each product holds its own credential.
