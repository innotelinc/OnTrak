# Running OnTrak in Docker

The whole control plane and the browser console run as containers. The training
machines do not — they are Incus virtual machines on the host, and that split is
the design, not a shortcut.

```bash
make secrets      # .env with generated portal/console keys (never overwrites)
make up           # portal + Guacamole; adds the host's Incus when it finds one
# portal   http://localhost:8080        console   http://localhost:8081/guacamole/
make ps           # health of every service
make logs         # follow
make down         # stop (the state and media volumes survive)
```

`make up` prints which mode it picked, so the choice is never silent.

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

**1. Local Incus on the same host (the normal lab).** Compose overlay
`docker-compose.incus.yml` bind-mounts `/var/lib/incus/unix.socket` into the
portal. `make up` applies it automatically when the socket exists; force it with
`docker compose -f docker-compose.yml -f docker-compose.incus.yml up -d`.

That socket is the whole Incus API in one file: an unprivileged reader of it can
create, delete and exec into machines. **The portal container is a hypervisor
admin, because that is what it is.** Treat it like root on the lab host — which
is also why it is not published beyond loopback by default.

**2. A remote Incus cluster over HTTPS.** No overlay, plus the CLI's trust
config mounted read-only:

```bash
docker run -d --name ontrak-portal \
  -p 8080:8080 --env-file .env \
  -v "$HOME/.config/incus:/root/.config/incus:ro" \
  ontrak:local
```

Set `ONTRAK_INCUS__REMOTE=https://incus.example.com:8443` (and
`ONTRAK_INCUS__PROJECT`) in `.env`. A cluster also removes the single-host
ceiling: placement across hosts is the daemon's problem, not the portal's.

**3. No hypervisor at all.** Demo mode runs an entire class against an
in-memory Incus — no socket, no Windows, no guests:

```bash
make demo                    # on the host: a 6-student class, end to end
make docker-demo             # the same thing inside the image
docker compose run --rm -e ONTRAK_DEMO__ENABLED=true portal demo serve
```

Use it for a workshop, a screenshot, a smoke test, or CI. `make up` also works
with no socket at all: the portal starts, serves everything stored in its
database, and tells you on the admin panel that the hypervisor is unreachable
rather than failing to render.

## Volumes

| Volume | Holds | Lose it and… |
| --- | --- | --- |
| `ontrak-state` → `/app/state` | SQLite: accounts, sessions, **submitted grades**, tickets, audit log | you lose every result. Back this up; nothing else here is worth a second copy |
| `ontrak-media` → `/app/media` | installation media (`ontrak media fetch`) | you re-download it. It is large and reproducible, never back it up |
| `deploy/guacamole/recordings` → `/recordings` | optional session recordings (`ONTRAK_GUAC__RECORDING=true`) | you lose the recordings. They can be very large, and they show a student's screen |

`../state` on the host is still the path the *host* uses when you run
`make serve` instead of the container. The two are deliberately separate: mixing
them means a container upgrade can lock the host out of its own database.

## Ports

| Port | Default | Service |
| --- | --- | --- |
| 8080 | `ONTRAK_BIND_ADDR:ONTRAK_PORTAL__PORT` | student portal and admin panel |
| 8081 | `ONTRAK_BIND_ADDR:ONTRAK_GUAC__PUBLIC_PORT` | Guacamole (the console iframe's target) |

`ONTRAK_BIND_ADDR` defaults to `127.0.0.1`. That is the portfolio posture — a
TLS proxy (NPM Edge / Cerulean-issued certificate) in front, never the portal
straight onto a network. For a lab where students reach the host directly, set
`ONTRAK_BIND_ADDR=0.0.0.0` and make sure `ONTRAK_GUAC__BASE_URL` is the URL
those browsers actually use; the console payload travels in a URL fragment and
must never cross a network in plain text off-host.

## Configuration

Everything under `environment:` in `docker-compose.yml` is a `ONTRAK_*` override
of `config/ontrak.yaml`, and every one of them has a default, so `.env` only
needs the values you want to differ. Two have no default and the stack refuses
to start without them:

* `ONTRAK_PORTAL__SECRET` — signs portal session cookies.
* `ONTRAK_GUAC__SECRET_KEY` — exactly 32 hex characters; the portal signs console
  links with it and Guacamole verifies them. **One value, two services**; if they
  ever disagree, every console link silently fails to open.

`make secrets` generates both (and the instructor and guest passwords) into the
gitignored `.env`, and never overwrites a value that is already there — a
`vault://` reference counts as a value. In production these come from Cerulean
Vault by reference (see `.env.example`); the container resolves a reference only
if the deployment gives it something that can, otherwise it fails at boot. There
is no silent fallback to a local secret.

## Operating it

```bash
make exec ARGS="user list"                      # the CLI, inside the running portal
make exec ARGS="user import roster.csv --default-password 'ChangeMe!23'"
make exec ARGS="pool status"
make exec ARGS="catalog groups"
make exec ARGS="session list --state in_use"
docker compose exec portal python3 -m ontrak scenario validate   # same thing
```

The instructor account is seeded from `ONTRAK_PORTAL__ADMIN_PASSWORD` on boot,
so the admin panel is reachable the first time you `make up`. Change that
password by setting it in `.env` and restarting, or with
`make exec ARGS="user add --username you --role instructor --password '…'"`.

Templates and the warm pool still need a host that can build them
(`infra/build-templates.sh`, `make templates`). Start a class with
`make pool` to check depth, or let the admin panel's Maintenance card do it.

## Upgrades

```bash
git pull
docker compose build          # or `make build`
docker compose up -d          # recreates only what changed
```

The state volume is untouched by a rebuild. `docker compose down -v` deletes the
volumes — on a range that has graded results, that is data loss, so it is not a
"reset".

## Troubleshooting

**`/admin` shows "Hypervisor reads failed".** The panel is telling you exactly
what it could not read — usually `The incus daemon doesn't appear to be started`.
Everything stored in the portal still works and is still shown; only live machine
facts are missing. Start Incus on the host (`systemctl start incus`), or apply
the overlay if you forgot it.

**`failed to bind host port`.** Something already owns 8080 or 8081 on the host.
Set `ONTRAK_PORTAL__PORT` / `ONTRAK_GUAC__PUBLIC_PORT` in `.env` and bring the
stack up again.

**`unix.socket` became a directory.** Bind-mounting a path that does not exist
makes Docker create it — and it creates a *directory*. If that happened:

```bash
docker compose down
sudo rmdir /var/lib/incus/unix.socket     # only if it is empty and Incus is stopped
sudo systemctl restart incus              # the socket is recreated by the daemon
```

Use `make up` (which checks for the socket first) and this does not happen.

**The portal is up but no console appears in the iframe.** `ONTRAK_GUAC__BASE_URL`
is what *students' browsers* resolve, not what the container can reach. Behind a
TLS proxy it is the public console host, not `localhost`.

**`guacamole` never becomes healthy.** It waits for `guacd`; check
`make logs` — and note the first start pulls the upstream images.
