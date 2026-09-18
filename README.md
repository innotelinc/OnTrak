<div align="center">

# OnTrak

**Self-hosted tech-support training range — Windows 95 → present, graded.**

[![CI](https://github.com/innotelinc/OnTrak/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/OnTrak/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

> **OnTrak** is a TrainingOps platform: it stands up deliberately broken Windows, Linux
> and Office machines on demand, hands one to a student in the browser, grades the fix by
> reading live system state, and destroys the machine. It runs on Ubuntu + Incus, consumes
> Cerulean for identity and trust, and keeps only results — never progress.
> **Landing page:** [https://innotelinc.github.io/OnTrak/](https://innotelinc.github.io/OnTrak/)

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
- **A session lifecycle** — request → clone → boot → hand over → grade → submit → destroy, with per-session time limits, progressive hints, reset-on-demand and a reset that is always a fresh clone.
- **A student portal** — FastAPI app with login, ticket dashboard, HTML5 console via the gateway, time-limit control, `Complete & End`, and results-only reporting.
- **An operator surface** — CLI (`doctor`, `catalog`, `media`, `image`, `template`, `pool`, `schedule`, `session`, `generate`, `demo`), warm-pool management, scheduled prewarm/teardown, and an instructor view with CSV export.
- **Demo mode** — the whole student flow against an in-memory hypervisor: no Incus, no Windows, no secrets, in about five seconds.

## Quick start

Two commands, no hypervisor, no Windows image:

```bash
git clone https://github.com/innotelinc/OnTrak.git
cd OnTrak
./scripts/setup.sh
make demo            # a full class: assign, provision, grade, submit, tear down
make demo-serve      # the student portal, in demo mode, at http://127.0.0.1:8080
```

For a real range (Incus, KVM, ZFS or btrfs):

```bash
sudo infra/bootstrap-host.sh          # Incus, KVM, project, pool, bridge, profile
make check                            # host readiness, including storage and secrets
declare -x ONTRAK_GUEST__PASSWORD='…' # or set it in .env
make media-fetch                      # free media only (Microsoft evaluation ISOs)
python -m ontrak image build win11-24h2
make templates                        # build every scenario template
make serve
```

## Documentation

| Doc | What it covers |
| --- | --- |
| [docs/stack.md](docs/stack.md) | OnTrak's role in the Innotel Platform Stack (TrainingOps), and its owns/consumes boundaries |
| [docs/architecture.md](docs/architecture.md) | Components, the session lifecycle, the template/pool model, and the grading contract |
| [docs/catalog.md](docs/catalog.md) | The workload catalog: every group and entry, device profiles, media rules, provisioning plans |
| [docs/scenarios.md](docs/scenarios.md) | The five scenario families, why they are ranked that way, how to write one, and how generation works |
| [docs/operations.md](docs/operations.md) | Host sizing, capacity maths, warm pools, schedules, media management, backups and troubleshooting |
| [docs/roadmap.md](docs/roadmap.md) | What is verified, what is planned, and what is explicitly out of scope |

## Repo layout

```
OnTrak/
├── catalog/                   # workload manifests: Windows, Server, Office, Linux
├── config/                    # configuration (ontrak.yaml + gitignored local.yaml)
├── deploy/guacamole/          # browser-console gateway (HTML5 RDP)
├── docs/                      # architecture, catalog, scenarios, operations, stack, roadmap
├── infra/                     # host bootstrap, golden-image and template builds, workload images
├── ontrak/                    # the platform: catalog, sessions, scoring, portal, CLI
├── scenarios/                 # scenarios (scenario.yaml + setup.ps1 + check.ps1) and the shared guest library
├── scripts/setup.sh           # bootstrap: hooks, venv, dependencies, .env
├── tests/                     # pytest suite
├── web/landing/               # static GitHub Pages landing
├── .githooks/                 # attribution guard (commit-msg, pre-commit, guard-lib)
└── .github/workflows/         # CI, attribution guard, Pages
```

## Status

- **Verified here:** the Python control plane — `pytest` (210 tests collected, 1 skipped
  where the host lacks a tool it needs), `ruff` clean, scenario validation, catalog
  validation, the CLI, demo mode end to end, generated scenarios validated, and the
  Guacamole link format cross-checked against the `openssl` CLI.
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

*OnTrak — support training range. © 2026 Innotel Inc*

## 🏛️ Platform stack

OnTrak is the ecosystem's **TrainingOps** platform in the
[**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) —
the canonical single-responsibility architecture where Authentik owns identity,
Cerulean Vault owns secrets, Cerulean owns trust, ONYX owns storage, Magnate owns
revenue, NPM Edge owns the edge, and every other platform is a business function
that consumes them. See [docs/stack.md](docs/stack.md) for this platform's
owns/consumes boundaries.
