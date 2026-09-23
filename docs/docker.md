# Running OnTrak in Docker

The whole control plane and the browser console run as containers. The training
machines do not — they are Incus virtual machines on the host, and that split is
the design, not a shortcut.

```bash
make up                       # the whole installation, first run included, over TLS
# portal   https://<this host>:8443/    console   https://<this host>:8443/guacamole/
make ps                       # health of every service
make logs                     # follow
make setup-log                # what the first run set up (secrets, Incus on the host)
make ps-check                 # parse and audit the guest PowerShell, in the container
make down                     # stop (the state and media volumes survive)
```

**TLS is the default.** `make up` generates a local certificate if there is not
one and starts `docker-compose.yml` together with `docker-compose.tls.yml`, so the
stack serves one published port, encrypted. There is no unencrypted door beside
it — the overlay *replaces* the 8080 mapping rather than adding to it.
`make up-plain` is the exception, for a host whose TLS edge already terminates in
front of it.

A bare `docker compose up -d --build` still starts the *plain* stack on 8080: the
overlay is a compose file that has to be named, and `make up` is what names it.
`--build` only matters after a `git pull`: without it compose reuses the image from
the previous commit, and a stale `lab-setup` reports a host step it never ran.

## Start anywhere

Nothing has to be installed first. `./start.sh` (or `make`, or
`scripts/setup.sh`) finds the machine's package manager and installs what the
path you chose needs — Python and `make` for the host portal, Docker and its
Compose plugin for the container one — then picks the right stack:

```bash
./start.sh            # what this machine has: Docker if usable, else the host portal
./start.sh up         # the full stack; needs a local Incus host
./start.sh stop       # stop whatever is running
```

`make` works the same way without being a step you have to run first: every
Python target builds the virtualenv itself when it is missing. The rest of this
page is the container detail.

| Stack | Command | Host needs | Training machines |
| --- | --- | --- | --- |
| **full** | `make up` (TLS) | Docker + a Linux host with KVM | real Incus VMs |
| **remote** | `make up-remote` | Docker | an Incus cluster elsewhere |

What the lab host needs, for the version that installs Incus for you:

| | |
| --- | --- |
| Linux, Debian or Ubuntu | the host step installs with `apt`. Another distribution: install Incus yourself, then run the stack with `ONTRAK_LAB_SETUP=off`. |
| Docker Engine with Compose v2 | the setup container is privileged and needs `pid: host`, so it must be the daemon on the lab host itself. |
| x86-64 with virtualisation, `/dev/kvm` | bare metal with VT-x/AMD-V, or a VM with nested virtualisation. Nothing else can boot a Windows guest. |
| RAM for the machines in flight | the default student profile is 2 vCPU / 4 GiB; size the host for a class, not for one student ([operations.md](operations.md)). |

**Docker Desktop, a laptop, a phone, or Docker on another machine:** the host step
cannot reach the lab host's namespaces, point the stack at a cluster instead:

```bash
make up-remote                                            # or:
docker compose -f docker-compose.yml -f docker-compose.remote.yml up -d
```

And a bare `docker compose up` on a machine with no hypervisor still comes up:
`lab-setup` notices, says so, and the portal serves every page — it just cannot
provision a machine. Point it at a cluster (`make up-remote`) or prepare the host
(`sudo infra/bootstrap-host.sh`) to serve real machines.

## The first run

`docker compose up` on a machine that has only Docker is a complete
installation. A one-shot `lab-setup` service runs before anything else and does
the two things a fresh checkout cannot do for itself:

1. **Secrets.** It writes `.env` (via `scripts/secrets.sh`, which never
   overwrites a value that is already there) and publishes the shared keys to a
   volume the portal and the console gateway both read. This step has to happen
   inside a container: compose interpolates variables and reads `env_file` when
   it loads the project, *before* any container runs, so a stack that required a
   `.env` could never create one.
2. **Incus on the host.** If the host cannot run training machines yet, it runs
   the host's own `infra/bootstrap-host.sh` — installs Incus, initialises the
   daemon, and creates the storage pool, lab bridge, project and profiles. It
   does that by entering the host's namespaces (`privileged: true`, `pid: host`)
   and running the script as *the host's file*, so a host prepared this way and a
   host prepared by hand end up identical.

Only then do the portal and the gateway start: both wait on
`service_completed_successfully`, because the files `lab-setup` writes are what
they read. `scripts/check-first-run-contract.py` checks that arrangement against
the rendered configuration, where a comment cannot rot.

Two things it deliberately does **not** do: it never blocks the control plane
(a host that cannot run VMs is reported, and the portal still comes up — against a
remote cluster, or serving pages with no machines), and it never guesses a storage driver,
because cloning is what makes a reset cheap and only you know what the disk is:

```bash
# in .env, before the first run
ONTRAK_STORAGE_DRIVER=zfs          # dir (default) | btrfs | zfs | lvm
ONTRAK_STORAGE_SOURCE=/dev/nvme1n1 # a block device, for zfs/lvm
```

`ONTRAK_LAB_SETUP=force` re-runs the host step; `off` skips it. See
[operations.md](operations.md) for what the pool layout does to class timings.

## What is a container, and what is not

| Piece | Runs as | Why |
| --- | --- | --- |
| `portal` — FastAPI student portal: scenarios, sessions, tickets, grading, admin panel | **container** | plain Python service: stateless apart from the database, no privileges of its own |
| `guacamole` + `guacd` — HTML5 console (RDP/SSH into the training machines) | **containers** | off-the-shelf upstream images, the job they were built for |
| The training machines: Windows 95→11, Server, Office, and the Linux distributions | **Incus VMs on the host** | they must boot a real kernel, hold a driver fault, survive a "malware" scenario and be snapshot-restored between students. A container cannot be Windows 95, and a broken machine that shares the host kernel is an outage, not a lesson |
| Bare Incus, the bridge and the profiles | **host services** | created by `infra/bootstrap-host.sh` |

So the containers are the *control plane*. The lab is the host.

## Three ways to reach a hypervisor

The portal shells out to the `incus` CLI, so "where is Incus" is a mount, not a
build flag.

**1. Local Incus on the same host (the normal lab).** This is the base stack,
and `lab-setup` installs and initialises Incus for you if it is not there yet.
`/var/lib/incus` is bind-mounted into the portal, which is where the daemon's
socket and its configuration live.

That directory is the whole Incus API: an unprivileged reader of it can create,
delete and exec into machines. **The portal container is a hypervisor admin,
because that is what it is.** Treat it like root on the lab host — which is also
why the mount is the directory rather than the socket file (a host without Incus
yet gets an empty directory instead of Docker creating a stray file where the
daemon will later want its own socket), and why a range that is reachable from a
network at all wants the TLS edge in front before a class uses it.

**2. A remote Incus cluster over HTTPS.** `docker-compose.remote.yml` turns the
host step off (nothing to install here) and points the portal at a named remote,
with the CLI's trust config mounted read-only:

```bash
docker compose -f docker-compose.yml -f docker-compose.remote.yml up -d   # or: make up-remote
```

Set `ONTRAK_INCUS__REMOTE` to the remote's name (and `ONTRAK_INCUS__PROJECT`) in
`.env`; uncomment the trust-config mounts at the bottom of that file for your
operator account. A cluster also removes the single-host ceiling: placement
across hosts is the daemon's problem, not the portal's.

**3. No hypervisor at all.** `make up` still works with no hypervisor: the
first-run step reports that the host cannot be prepared, the portal starts anyway,
serves everything stored in its database, and tells you on the admin panel that
the hypervisor is unreachable rather than
failing to render.

## Volumes

| Volume | Holds | Lose it and… |
| --- | --- | --- |
| `ontrak-state` → `/app/state` | SQLite: accounts, sessions, **submitted grades**, tickets, audit log | you lose every result. Back this up; nothing else here is worth a second copy |
| `ontrak-media` → `/app/media` | installation media (`ontrak media fetch`) | you re-download it. It is large and reproducible, never back it up |
| `ontrak-secrets` → `/run/ontrak` (portal, gateway) | the shared keys the first run generated | the portal and the gateway lose their common key and console links stop opening. `ONTRAK_LAB_SETUP=force` regenerates it, which logs everyone out |
| `deploy/guacamole/recordings` → `/recordings` | optional session recordings (`ONTRAK_GUAC__RECORDING=true`) | you lose the recordings. They can be very large, and they show a student's screen |

`../state` on the host is still the path the *host* uses when you run
`make serve` instead of the container. The two are deliberately separate: mixing
them means a container upgrade can lock the host out of its own database.

## Ports

| Port | Default | Service |
| --- | --- | --- |
| 8080 | `ONTRAK_BIND_ADDR:ONTRAK_PORTAL__PORT` | the origin gateway: the student portal and admin panel at `/`, the console at `/guacamole/` |
| 8443 | `ONTRAK_BIND_ADDR:ONTRAK_TLS_PORT` | the same gateway with TLS — what `make up` publishes *instead of* 8080, not alongside it |

One published port, on purpose. The portal and the console are separate containers
but share an origin (`deploy/gateway/nginx.conf` routes them), because the estate's
edge forwards a host rather than a path — and because a port per service is one
more host port to collide with whatever else the machine is running.

A range does not need any of that to run. Every deployment is reachable by its own
**address** — `make lan` prints it, and the admin panel's Overview page shows the one
it was opened on — and nothing in the stack resolves a hostname of its own. The names
below are for an estate that wants one URL per audience; a lab on a LAN (or a laptop,
or a phone hotspot) simply uses `https://<address>:8443/` and never provisions DNS. A
name cannot be added by hand, though: on the deployment the range answers on three
names, provisioned through Cerulean (DNS, the wildcard certificate and the edge host
— `make provision`), which is the only supported way, because a record added by hand
and a certificate fetched by hand are two things that drift apart, and the drift is a
browser warning in front of a class.

| Address | What serves it |
| --- | --- |
| `https://ontrak.innotel.us/` | the range itself — the portal, and the console at `/guacamole/` |
| `https://student.ontrak.innotel.us/` | the same portal; what a student is given |
| `https://admin.ontrak.innotel.us/` | the same portal; what an instructor is given |

One portal, three names, role-gated at sign-in: the student and staff names are
how an institution hands out one URL each, and how the edge can be told to treat
them differently later (the student name on the internet, the staff name behind
the VPN) without touching the app.

What the edge has to do with the stack is three hosts and no paths: every name
goes to the same address, and the stack's gateway decides what `/` and
`/guacamole/` mean. The path is passed through unchanged, and with
`ONTRAK_GUAC__BASE_URL=auto` the console link follows whichever name the student
arrived on.

| Public | Upstream |
| --- | --- |
| `https://ontrak.innotel.us/` | `http://<lab host>:8080/` |
| `https://ontrak.innotel.us/guacamole/` | `http://<lab host>:8080/guacamole/` (routed inside the stack, not at the edge) |
| `https://student.ontrak.innotel.us/` | `http://<lab host>:8080/` |
| `https://admin.ontrak.innotel.us/` | `http://<lab host>:8080/` |

TLS is one wildcard (`*.ontrak.innotel.us`) plus a certificate for the apex — a
wildcard never covers the name it hangs off — both issued by Cerulean over
DNS-01, so nothing has to be reachable from the internet for them to exist.

`ONTRAK_BIND_ADDR` defaults to `0.0.0.0`. OnTrak is a setup-anywhere lab: the
point of it is that the phone, tablet or laptop next to the host can open it, and
a stack that only answers on the machine it runs on cannot be used from the device
in the room. Set it to `127.0.0.1` to keep the range on one machine, or to a
single address to pin it to one interface.

The console follows automatically. `ONTRAK_GUAC__BASE_URL` defaults to `auto`: the
portal works the console address out from the address the student's browser used
(`X-Forwarded-Proto`/`X-Forwarded-Host` when the stack's gateway is in front of
it), so one checkout serves localhost, a LAN address and a TLS host with no edit.
Set an absolute URL when the browser name differs from the container's own — a
deployment behind Cerulean's edge — and leave it empty for no browser console at
all. The console payload travels in a URL fragment and must never cross a network
in plain text off-host, which is the one reason to put TLS in front of a
`0.0.0.0` binding before a class uses it.

**If the TLS proxy is itself a container on this host,** the `0.0.0.0` default is
what makes it work. The edge forwards to the host's address (`192.168.1.62:8080`,
the current range host — `ONTRAK_FORWARD_HOST`), and a loopback binding answers
that from the host's *own* process namespace — not from another container, which
reaches the published port over the bridge. The symptom is a 502 from the edge
while `curl 127.0.0.1:8080` succeeds on the host, which reads as the stack being
down when it is up. A stack that deliberately narrowed the binding to `127.0.0.1`
needs to widen it — or move the proxy onto the host's network.

### TLS without the estate (the default)

A range reached directly on a LAN — a laptop, a mini-PC, a phone hotspot — has no
public name, so there is nothing for Let's Encrypt to validate and no CA to ask.
`make up` answers that case: the gateway terminates TLS itself on 8443 with a
self-signed certificate, and `docker-compose.tls.yml` publishes **that port alone**,
because publishing 8080 beside it would leave the unencrypted door open next to the
encrypted one. It is the default because the old arrangement — TLS being a separate
command — left the unencrypted posture one forgotten word away.

```bash
make up             # certificate if missing, then the encrypted stack (the default)
make up-plain       # the unencrypted stack, for a host behind a TLS edge
make renew-tls      # re-issue the certificate (the host's address changed)
make lan            # print the address devices should open
```

* The certificate names every address the host answers on (`localhost`, its
  hostname, `127.0.0.1`, each private IPv4) as subject alternative names — the part
  a browser actually checks. `scripts/tls-local-cert.sh` writes it; it is
  gitignored, and the key is `0600`.
* Terminating in the gateway keeps it to one proxy hop, so `X-Forwarded-Proto` is
  simply `https` and the console link comes back `https://<host>:8443/guacamole/`
  with no second proxy to configure. The port survives because the shared include
  proxies the raw `Host` (`$http_host`), not nginx's port-less `$host` — see
  `deploy/gateway/ontrak-upstreams.inc`.
* A device that has never seen the certificate warns once. The traffic is encrypted
  either way; the warning goes away when the certificate is trusted on that device,
  or when a real one replaces it. Nothing is revoked by trusting a self-signed
  certificate on a lab machine, but it is not a substitute for a real certificate
  on anything reachable from the internet.
* Going back to plain HTTP is `make up-plain` (or starting without the file:
  `docker compose up -d`). A deployment behind Cerulean's edge does not use TLS
  here at all — the edge already terminates it with a real certificate, and the
  stack keeps answering plain HTTP on 8080 behind it.

### Start on boot (`make boot`)

A lab host that comes back from a power cut serving nothing is a support call at
the start of a class. One command makes the range come up on its own:

```bash
make boot           # needs sudo: writes and enables ontrak-range.service
make lan            # the address it comes back on
```

The unit starts exactly the stack `make up` starts — the same two compose files —
so what returns after a reboot is what an operator was running by hand. Before
starting it runs `scripts/tls-local-cert.sh` (idempotent: it writes only when the
certificate is missing) and rebuilds the portal image if it has been pruned. It
refuses to start when the certificate is absent rather than leaving the range
half-up, so the journal says why instead of a restart loop.

```bash
journalctl -u ontrak-range -n 50             # what the last boot did
sudo systemctl disable --now ontrak-range    # stop it coming back
```

The checkout path is baked into the unit at install time; re-run `make boot` after
moving the checkout.

## Configuration

Everything under `environment:` in `docker-compose.yml` is a `ONTRAK_*` override
of `config/ontrak.yaml`, and every one of them has a default, so `.env` only
needs the values you want to differ. The two that have no default are the ones a
first run generates for you:

* `ONTRAK_PORTAL__SECRET` — signs portal session cookies.
* `ONTRAK_GUAC__SECRET_KEY` — exactly 32 hex characters; the portal signs console
  links with it and Guacamole verifies them. **One value, two services**; if they
  ever disagree, every console link silently fails to open.

`lab-setup` generates both (with the instructor and guest passwords) on the first
run, through `make secrets` / `scripts/secrets.sh`, which never overwrites a value
that is already there — a `vault://` reference counts as a value. In production
these come from Cerulean Vault by reference (see `.env.example`); the container
resolves a reference only if the deployment gives it something that can,
otherwise it fails at boot. There is no silent fallback to a local secret.

Run `bash scripts/secrets.sh` by hand to create `.env` *before* the first run —
useful when you want to set the storage driver first, or to see the generated
instructor password without reading it back out of the file.

Sign-in has a default: **local accounts**. A stack that has never been pointed at
an identity provider comes up offering first-run setup, and `/setup` creates the
first instructor — or set `ONTRAK_PORTAL__ADMIN_PASSWORD` (and
`ONTRAK_PORTAL__ADMIN_USERNAME`) and the account is seeded at startup instead.
After that, **Admin → Accounts** adds everyone else.

SSO is optional and off by default. To use Cerulean's Authentik, register this
range's application there, set the four `ONTRAK_PORTAL__OIDC_*` values, and
switch SSO on under **Admin → Sign-in** — see
[operations.md](operations.md#sign-in). A local account can stay as the
break-glass path.

## Operating it

```bash
make exec ARGS="user list"                      # the CLI, inside the running portal
make exec ARGS="pool status"
make exec ARGS="catalog groups"
make exec ARGS="session list --state in_use"
docker compose exec portal python3 -m ontrak scenario validate   # same thing
```

`make exec ARGS="user list"` shows the accounts the range knows. A local account
keeps a password (set at `/setup`, seeded from `ONTRAK_PORTAL__ADMIN_PASSWORD`, or
set under **Admin → Accounts**); an SSO account appears the first time its owner
signs in and carries none, its role coming from the Authentik instructor group —
see [operations.md](operations.md#sign-in).

Templates and the warm pool still need a host that can build them
(`infra/build-templates.sh`, `make templates`). Start a class with
`make pool` to check depth, or let the admin panel's Maintenance card do it.

Housekeeping is the portal's own job here, because a container stack has no cron
for `ontrak reap` to live in. `ONTRAK_SESSION__MAINTENANCE_ENABLED` (true by
default) runs a background loop that recycles sessions past their time limit or
idle beyond `ONTRAK_SESSION__IDLE_RECYCLE_MINUTES`, and once a day deletes
finished session history older than `ONTRAK_SESSION__HISTORY_DAYS` (30; `0` keeps
it forever, and a session a result or ticket points at is never deleted). It
never refills the warm pool — `ONTRAK_POOL__DEFAULT_TARGET` and `ONTRAK_POOL__TARGETS`
are yours to set, and nothing in the stack grows the pool behind your back.

## The tools container: PowerShell, and a prompt

The training machines are Windows, and their automation is PowerShell:
`infra/windows/products/*.ps1` installs Exchange, SQL Server, SharePoint and
Microsoft 365 Apps *inside* a guest, and `scenarios/**/*.ps1` injects and checks
the faults. None of that can run on this host — a guest needs a hypervisor,
licensed media and the better part of an hour. What *can* happen here is reading
the scripts, and that is worth more than it sounds: two argument-construction bugs
that would each have cost an install attempt were found by reading them, and no
other check in this repository would have caught either.

So the image carries `pwsh` (see the `Dockerfile` — pinned to a release, and
checksummed), and a `tools` service gives it the checkout:

```bash
make ps-check                 # parse every script, then audit the parse trees
make pwsh                     # a pwsh prompt, with this checkout at /project
docker compose --profile tools run --rm tools bash   # the same container, a bash prompt
```

`make ps-check` runs `scripts/check-powershell.ps1` — the *same* script CI runs, so
the local gate and the CI gate cannot drift apart. It parses every `.ps1` under
`scenarios/` and `infra/`, and then audits each parse tree for the trap that parsing
alone cannot see: PowerShell's comma binds tighter than `+`, so a concatenation
next to a comma inside an array literal is not the element it looks like.

```powershell
@('/PrepareAD', '/OrganizationName:"' + $org + '"')   # four arguments, not two
@('/ConfigurationFile=' + $ini, '/QUIET')             # one argument, not two
```

Both of those were live in this tree. A newline separates the elements safely;
only the comma does not, which is why the audit keys on it, and the fix is always
a pair of parentheses. A deliberate array concatenation (`@('a', 'b') + $c`) trips
the same audit and is fixed the same way — which is what makes it unambiguous to
the next reader.

The container mounts the checkout at `/project` rather than shadowing `/app`, so
what gets checked is the tree you are editing rather than the revision the image was
built from. It is deliberately **not** part of a running range: it sits behind the
`tools` profile, so a plain `docker compose up` still starts the four containers a
range needs and nothing else.

## Upgrades

```bash
git pull
make up                       # `docker compose up -d --build`: a new image, then start
# or, without make:
docker compose build && docker compose up -d
```

The state volume is untouched by a rebuild. `docker compose down -v` deletes the
volumes — on a range that has graded results, that is data loss, so it is not a
"reset".

## Troubleshooting

**`/admin` shows "Hypervisor reads failed".** The panel is telling you exactly
what it could not read — usually `The incus daemon doesn't appear to be started`.
Everything stored in the portal still works and is still shown; only live machine
facts are missing. Start Incus on the host (`systemctl start incus`) and check it
is answering there (`incus info`); if it is not installed at all,
`ONTRAK_LAB_SETUP=force docker compose up -d` runs the host step again.

**`failed to bind host port`.** Something already owns the published port — 8443
with TLS (`make up`, the default), or 8080 without it (`make up-plain`). Only one
port is ever published, so this is the only one that can collide. Set
`ONTRAK_TLS_PORT` (or `ONTRAK_PORTAL__PORT` for the plain stack) in `.env` and
bring the stack up again.

**`unix.socket` became a directory.** Bind-mounting a path that does not exist
makes Docker create it — and it creates a *directory*. The base stack mounts
`/var/lib/incus` as a directory for exactly this reason, so this only bites an
old overlay that pointed at the socket file. If it happened:

```bash
docker compose down
sudo rmdir /var/lib/incus/unix.socket     # only if it is empty and Incus is stopped
sudo systemctl restart incus              # the socket is recreated by the daemon
```

**The portal is up but no console appears in the iframe.** `ONTRAK_GUAC__BASE_URL`
is what *students' browsers* resolve, not what the container can reach. It is
`auto` by default, which works out the address from the browser's own request, so
the usual cause is now a stack whose portal and console are reached under
different names — set the absolute public console URL in that case (`make exec
ARGS=doctor` reports the console checks as skipped under `auto`, since there is no
fixed URL here for them to probe; to check a console anyway, run the tunnel check
against one from the lab host, where the console has an address of its own:
`ontrak console verify --linux --base-url https://localhost:8443/guacamole/`).

**`make exec ARGS=doctor` says there is no hypervisor, but Incus is installed.**
The first run says which of the three ways to reach a hypervisor it took; read it
with `docker compose logs lab-setup`. "cannot reach the host's namespaces" means
Docker is not running on the lab host itself (Docker Desktop, or a remote
daemon) — install Incus on that host with `sudo infra/bootstrap-host.sh`, or use
the remote overlay. If Docker *is* on the lab host and it still
says that, check for a stale image first: `make up` (which passes `--build`)
rather than a bare `docker compose up` after a `git pull`.

**The host step failed and I want to see the output again.** It is in
`docker compose logs lab-setup`, and the last line names the script *by its path
on the host*, so the retry it prints can be pasted into a shell there:

```bash
sudo /path/to/checkout/infra/bootstrap-host.sh   # the host step, alone
ONTRAK_LAB_SETUP=force make up                   # then let the stack re-check
```

**`guacamole` never becomes healthy.** It waits for `guacd`; check
`make logs` — and note the first start pulls the upstream images.
