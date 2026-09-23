<div align="center">

# OnTrak

**IT Support Training Platform powered by Innotel OnTrak — Windows, Server, Office and Linux, ticketed and graded.**

[![CI](https://github.com/innotelinc/OnTrak/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/OnTrak/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

> **OnTrak** is the **IT Support Training Platform powered by Innotel OnTrak** — a
> TrainingOps platform that stands up deliberately broken Windows, Server, Office and Linux
> machines on demand, opens an in-house support ticket against each one, hands both to a
> student in the browser, and grades the work from live system state *and* the written
> ticket. It runs on Ubuntu + Incus, consumes Cerulean for identity and trust, and keeps
> only results — never progress.
> **Landing page:** [https://innotelinc.github.io/OnTrak/](https://innotelinc.github.io/OnTrak/)
> **Running it:** a range is reached by its own **address**, and needs no DNS name at all —
> `make up` then `make lan` prints the one to hand out, and the admin panel's Overview
> page shows it too. A lab on your own box is `https://localhost:8443`, with the console at
> `https://localhost:8443/guacamole/` — one address, because the edge forwards a host
> rather than a path, and the console follows whatever address the browser used. The
> certificate is local and self-signed, so each device warns once until it is trusted.
> An estate deployment can also put real names in front of it —
> [ontrak.innotel.us](https://ontrak.innotel.us/) for the portal,
> [student.ontrak.innotel.us](https://student.ontrak.innotel.us/) and
> [admin.ontrak.innotel.us](https://admin.ontrak.innotel.us/) for the people who use it,
> provisioned through Cerulean by `make provision` ([docs/docker.md](docs/docker.md)) — but
> that is a choice, not a requirement, and a range on a LAN never needs it.

---

## Why OnTrak

| Problem | OnTrak answer |
| --- | --- |
| Building a Windows lab for a class takes days, and every rebuild is another day. | Scenario templates are built once — boot, inject the fault, snapshot as `clean` — and every student gets a copy-on-write clone of that snapshot in seconds. |
| "Reset the machine" in a training lab means leaving whatever the previous student broke. | A reset destroys the VM and clones the clean snapshot again. There is no un-break path, no drift, and no state carried between attempts. |
| A class of 30 all provision at 09:00 and the host falls over. | A warm pool hands out already-booted VMs, and scheduled windows prewarm before a class and drain the pool after it, so memory is only spent when the lab is in use. |
| Grading "did they fix it?" by hand does not scale and is not consistent. | Each scenario declares objectives; a check script reads live machine state (does the name resolve, is the service running, is the device enabled) and any correct fix passes. |
| Real training needs old and odd platforms, but those are exactly the ones tooling ignores. | The workload catalog covers Windows 95 through Server 2025, Office 97 through 2024, and every Linux distribution the image server publishes — with the legacy device profiles (IDE, emulated NIC, no Secure Boot) already worked out. |
| Practising on real machines risks real damage, real licences and real malware. | Guests are isolated on their own bridge, security scenarios are simulations with placeholder payloads, and free media is fetched while licensed media stays in the operator's own store. |
| Writing new scenarios is slow, so a course ends up with four of them. | Fault primitives compose into new scenarios (`ontrak generate one --primitive …`), and every generated scenario is validated against the grading contract before it can reach a student. |

## What it is

- **A workload catalog** — manifests for Windows desktop, Windows Server, Microsoft Office and Linux: media source, device profile, resources, automation capability and provisioning plan. Manifests, never binaries.
- **A scenario engine** — six hand-written scenarios and a fault-primitive library that generates more, each with a ticket, weighted objectives, progressive hints, a fault-injecting `setup.ps1` and a live-state `check.ps1`.
- **A session lifecycle** — request → clone → boot → hand over → grade → submit → destroy, with per-session time limits, progressive hints, reset-on-demand and a reset that is always a fresh clone. The portal reaps expiry, idle sessions and finished history itself, so an abandoned machine is taken back without anyone remembering a command — and without a cron job, which the container stack does not have.
- **A student portal** — FastAPI app with local accounts by default and Authentik SSO one toggle away, ticket dashboard, HTML5 console via the gateway, time-limit control, `Complete & End`, and results-only reporting.
- **A container stack** — `docker compose up` brings up the portal and the Guacamole console gateway; the training machines stay Incus VMs on the host, reached over its socket or a cluster endpoint.
- **An operator surface** — CLI (`doctor`, `catalog`, `media`, `image`, `template`, `pool`, `schedule`, `session`, `console`, `generate`), warm-pool management, scheduled prewarm/teardown, and an instructor view with CSV export.
- **Setup anywhere** — one script installs what a machine is missing (Python, `make`, Docker, `openssl`) and `make` builds its own environment, so a checkout carried onto a laptop, a mini-PC or a phone-hosted daemon runs with one command and no editing.

## Quick start

One command, on any machine. `start.sh` installs whatever is missing — Python and
`make` for the host portal, Docker and its Compose plugin for the container path —
and then picks the stack this machine can actually run:

```bash
git clone https://github.com/innotelinc/OnTrak.git
cd OnTrak
./start.sh           # Docker if it is here and usable, otherwise the host portal
```

Nothing is a prerequisite, and nothing has to be read first. The pieces it picks
from:

```bash
./start.sh up        # the full stack; needs a Linux host with Incus + KVM
./start.sh serve     # the real portal on this host, no containers
./start.sh stop      # stop whatever is running
```

`make` works the same way — every Python target builds the virtualenv itself when
it is missing, so `make check` on a fresh clone just works. A machine with no
hypervisor is still a working portal: `lab-setup` notices and reports it, and the
pages that do not need a machine keep working.

The stack binds `0.0.0.0`, so the phone or laptop next to the host can open it:

```bash
make lan             # prints https://<this machine's address>:8443 (it follows the stack)
```

The console follows the address the browser used, so nothing has to be edited to
move the same checkout between `localhost`, a LAN address and a TLS host.

With Docker, one command is the whole installation — no hypervisor, no `.env`,
nothing to read first. (A Debian or Ubuntu lab host with `/dev/kvm` and a few GB
per machine for the full stack; elsewhere the portal still serves its pages —
[docs/docker.md](docs/docker.md) has the table.)

```bash
make up              # the whole installation, over TLS
# portal   https://<this host>:8443/   console   https://<this host>:8443/guacamole/
make ps              # health  ·  make logs  ·  make setup-log
make boot            # come back by itself after a reboot (systemd)
make down
```

`make up` encrypts by default: it writes a local certificate if there is not one
and starts the TLS overlay, so the stack publishes one port — 8443 — with no
unencrypted door beside it. `make up-plain` is the exception, for a host behind a
TLS edge that already terminates it.

(`--build` only matters after a `git pull` — without it compose reuses the image from
whatever commit was checked out before, and a stale first run looks like a broken one.)

A one-shot `lab-setup` service runs before the others: it generates `.env` and the shared
portal/console keys, and — if the host cannot run training machines yet — installs and
initialises Incus on the host (storage pool, lab bridge, project, profiles) by running
`infra/bootstrap-host.sh` in the host's own namespaces. Then the portal and the console
gateway start. A host that cannot be prepared is reported and skipped, never fatal: the
portal still comes up — `lab-setup` says so — or against a remote cluster.
`ONTRAK_LAB_SETUP=force` re-runs the host step; `off` skips it. Details in
[docs/docker.md](docs/docker.md).

The training machines are still Incus VMs on the host — a container cannot be Windows 95,
and a broken machine that shares the host kernel is an outage rather than a lesson.

For a real range (Incus, KVM, ZFS or btrfs), whether or not you use Docker for the
control plane — `lab-setup` runs this same script for you:

```bash
sudo infra/bootstrap-host.sh          # what the first run does, by hand
make check                            # host readiness, including storage and secrets
declare -x ONTRAK_GUEST__PASSWORD='…' # or set it in .env
make media-fetch                      # free media only (Microsoft evaluation ISOs)
python -m ontrak image build win11-24h2
make templates                        # build every scenario template
make serve                            # or `make up`, to run it in Docker
```

On bare metal, `make installer-iso` builds the bootable image that does all of that for
you: Ubuntu Server 24.04 plus the first-boot provisioning (Incus, the lab bridge, the
checkout, the portal stack). The operator answers one screen — identity — so no
credential is baked into the image. [docs/installer.md](docs/installer.md).

## Documentation

| Doc | What it covers |
| --- | --- |
| [docs/stack.md](docs/stack.md) | OnTrak's role in the Innotel Platform Stack (TrainingOps), and its owns/consumes boundaries |
| [docs/architecture.md](docs/architecture.md) | Components, the session lifecycle, the template/pool model, and the grading contract |
| [docs/catalog.md](docs/catalog.md) | The workload catalog: every group and entry, device profiles, media rules, provisioning plans |
| [docs/scenarios.md](docs/scenarios.md) | The five scenario families, why they are ranked that way, how to write one, and how generation works |
| [docs/operations.md](docs/operations.md) | Host sizing, capacity maths, warm pools, schedules, media management, backups and troubleshooting |
| [docs/docker.md](docs/docker.md) | The container stack: what runs in Docker and what cannot, the three ways to reach a hypervisor, volumes, secrets, upgrades |
| [docs/installer.md](docs/installer.md) | The bootable installer ISO: building it, the one screen it stops on, what first boot provisions, and its settings |
| [docs/roadmap.md](docs/roadmap.md) | What is verified, what is planned, and what is explicitly out of scope |

## Repo layout

```
OnTrak/
├── start.sh                   # one command, anywhere: bootstrap, then the right stack
├── catalog/                   # workload manifests: Windows, Server, Office, Linux
├── config/                    # configuration (ontrak.yaml + gitignored local.yaml)
├── docker/                    # container entrypoint (docker-compose.yml is at the root)
├── deploy/guacamole/          # browser-console gateway (HTML5 RDP), standalone deployment
├── docs/                      # architecture, catalog, scenarios, operations, stack, roadmap
├── infra/                     # host bootstrap, installer ISO, golden-image and template builds
├── ontrak/                    # the platform: catalog, sessions, scoring, portal, CLI
├── scenarios/                 # scenarios (scenario.yaml + setup.ps1/check.sh) and the shared guest library
├── scripts/setup.sh           # bootstrap: hooks, venv, dependencies, .env
├── scripts/secrets.sh         # idempotent local secrets: .env blanks only, never a set
│                              #   value; reports keys .env.example no longer lists
├── tests/                     # pytest suite
├── web/landing/               # static GitHub Pages landing
├── docker-compose.yml         # the stack: first-run lab-setup + origin gateway + portal + console
├── docker-compose.remote.yml  # override: a remote Incus cluster, or no hypervisor at all
├── Dockerfile                 # the portal image
├── .githooks/                 # attribution guard (commit-msg, pre-commit, guard-lib)
└── .github/workflows/         # CI, attribution guard, Pages
```

## Status

- **Verified here:** the Python control plane — `pytest` (565 tests; the only two that skip
  themselves are the live-Guacamole interop test and the range walk below), `ruff` clean,
  scenario validation, catalog validation, the CLI, generated scenarios validated, the
  admin panel rendering without a reachable hypervisor, and the Guacamole link format
  cross-checked against the `openssl` CLI. The repository's own tooling — the secret
  scanner, the Cerulean provisioner and the grade sweep's reading half — has its own suite
  too (`scripts/tests`, run by CI).
- **Verified on a real range:** `make sweep` grades every `(scenario, workload)` pair on
  a booted machine — broken untouched, resolved after a repair — and `ONTRAK_E2E=1
  make test` walks one student through the whole lifecycle on a VM, from the door and
  the account to the hand-in and the state it leaves the page in. The walk also runs
  **nightly** on a self-hosted runner labelled `incus`
  (`.github/workflows/range-nightly.yml`), which fails rather than reports green if the
  walk skips itself, and opens every Linux console on the same run — a console sweep that
  opens nothing fails too, for the same reason a skipped walk does. `ontrak console verify
  --linux --workloads` opened all 14 `(scenario, workload)` Linux consoles the way a browser
  does — through the real gateway, webapp and guacd, over the TLS listener, each painting its
  terminal — and guacd's own typescript for one of them reads back the shell prompt, the
  typed command and its output. A Windows scenario's template was rebuilt from the golden
  image the same way (`ontrak template build sw-app-crash --force`) and its RDP console
  opened onto a painted desktop: guacd signing in as the training user, `img`/`blob` tiles,
  `rect`, `cfill`, no error. And `ontrak console browser` opened a console **in Chromium**,
  the way a student does: signing in to the portal, starting the machine through it, loading
  the session page, and typing `echo BROWSER_OK` into the terminal in the frame — 4 canvases
  painted and the screen changed, which is the keystroke half no wire-level check can see.
  The check takes the scenarios to open as arguments and now names both kinds of console — a
  Linux terminal and a Windows desktop — because a GUI has no command to obey, so a desktop
  is asked for the proof it can give instead (the Windows key, which has to change the
  screen). A desktop has only been seen to paint so far; that key press is what the nightly
  measures, since it opens both consoles and fails if either does not open
  ([docs/roadmap.md](docs/roadmap.md)). `make sweep` stays an operator command: it boots the
  whole pool (see [docs/operations.md](docs/operations.md#maintenance)).
- **Verified in Docker:** the image builds and validates a checkout with no hypervisor, every
  compose file renders — the base stack, the remote override and the TLS overlay — the portal
  and the console gateway both report healthy, and the doors behave: first-run setup on a
  fresh range, the environment's password on a seeded one, and no password form on a pure-SSO
  one.
- **Verified as a first run:** from a checkout with no `.env` and no hypervisor, one
  `docker compose up -d --build` writes the secrets, brings both services up healthy, and gets
  a portal-signed console payload accepted by the live gateway as a machine the student can
  open. Reaching the admin panel in that run needs a way in, and the default door is a local
  account: `/setup` creates the first instructor, or `ONTRAK_PORTAL__ADMIN_PASSWORD` seeds one
  at startup. SSO is optional — switch it on under Admin → Sign-in (see
  [docs/operations.md](docs/operations.md#sign-in)).
- **Verified for the host half:** `infra/bootstrap-host.sh` — the same script `lab-setup`
  runs in the host's namespaces — was run twice against a real Incus daemon (upstream
  packages, storage pool, lab bridge, project, limits profile), and the second run changed
  nothing. The first run reaches the host, finds the script, runs it there and reports the
  result; a host without `/dev/kvm` is told exactly that instead of being failed silently.
  Booting a real Windows VM is still a lab-host job — see [docs/roadmap.md](docs/roadmap.md).
- **Guest scripts:** every `scenarios/**/*.ps1` and `infra/**/*.ps1` parses under PowerShell 7
  (checked by CI, and locally with `pwsh`).
- **Reviewed but not proven in this repository:** the Windows, Incus, ZFS and Guacamole
  paths, because that needs a real host. Run `make check`, build one template, and walk one
  scenario end to end before committing a class to it.
- **Licensing:** Microsoft evaluation media expires (90–180 days) and retail Windows/Office
  is never redistributed — see [docs/catalog.md](docs/catalog.md). Volume licensing stays
  the operator's responsibility.

## License

OnTrak is released under the **MIT License** — see [LICENSE](LICENSE). Third-party material
retained in-tree: the attribution-guard shared layers (`guard-lib`, the hooks and the guard
workflow) come from the Innotel Platform Stack and are copied verbatim; upstream projects
referenced by the infrastructure scripts (`antifob/incus-windows`, the Incus image server,
Guacamole, guacd) keep their own licences, which apply to their output, not to this
repository. No upstream source is vendored or re-licensed here.

*OnTrak — IT support training range, powered by Innotel. © 2026 Innotel Inc*

## 🏛️ Platform stack

OnTrak is the ecosystem's **TrainingOps** platform in the
[**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) —
the canonical single-responsibility architecture where Authentik owns identity
(when a range switches SSO on — local accounts need no platform at all),
Cerulean Vault owns secrets, Cerulean owns trust, ONYX owns storage, Magnate owns
revenue, NPM Edge owns the edge, and every other platform is a business function
that consumes them. See [docs/stack.md](docs/stack.md) for this platform's
owns/consumes boundaries.
