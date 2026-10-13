# Moving the development server

`infra/restore-dev-server.sh` stands this development server back up on a new
machine. It exists because the server is disposable and the work in it is not, and
because a replacement host should rebuild as little as possible: everything the
script needs is already in one of three places on GitHub.

```bash
infra/restore-dev-server.sh --check                 # would this host work? (changes nothing)
infra/restore-dev-server.sh --dry-run               # every step, spelled out (changes nothing)
sudo infra/restore-dev-server.sh                    # the family stack
sudo infra/restore-dev-server.sh --with-lab         # ... plus the lab control plane
sudo infra/restore-dev-server.sh --with-lab --with-templates
```

## What is stored where

| what | where | how it comes back |
| --- | --- | --- |
| the family application and the lab (`src/`, `prisma/`, `ontrak-{tix,sentinel,sync,genie,portal}/`, `ontrak-lab/`) | `innotelinc/OnTrak`, branch `main` | `git clone` — one clone, because it is one repository since 2026-10-13 |
| the product images | `ghcr.io/innotelinc/ontrak-{training,training-migrate,tix,tix-migrate,sentinel,sentinel-migrate,genie,portal,sync-api,sync-web}` | `docker pull`, then re-tagged into the names the family stack expects |
| the lab portal image | `ghcr.io/innotelinc/ontrak` | `docker pull`, tagged `ontrak:local` (what the lab's compose names it) |
| the Windows golden image | `ghcr.io/innotelinc/ontrak-golden` (`win11e-*`) | `make golden-pull` (`--with-templates`) |
| the scenario templates | `ghcr.io/innotelinc/ontrak-template` | `infra/import-templates.sh` (`--with-templates`) |
| the range-host installer | the `installer-24.04.5` release, still published from `innotelinc/OnTrak-dev` (three ISOs, split into parts under GitHub's asset cap) | `./reassemble.sh <tier>` from the release |

The images are published by `make publish-images` on the OnTrak side, which tags
each one with its product version, its major.minor, `latest`, and `sha-<commit>`.
The publish is a rebuild of the tree, so a tree whose images were published can be
restored without compiling anything.

## What the merge did not move

The lab's tree is here. Three things that used to be beside it are not, and none of
them moves on its own.

- **The lab's workflows.** GitHub reads `.github/workflows/` from the repository root
  and nowhere else, so all six files that arrived under
  `ontrak-lab/.github/workflows/` are inert: the merge carried them across but
  nothing will ever run them again. The lab's *tests* did not fall through with
  them — the root `ci.yml` runs both of the lab's Python suites in its `lab` job,
  which is what `tests/ci-coverage.test.ts` demanded before it would pass.
- **The lab's publish workflow.** `ontrak-lab/.github/workflows/publish.yml` pushed
  `ghcr.io/<owner>/ontrak` — the portal image `ONTRAK_IMAGE` names in
  [docker.md](docker.md) — when a release was published. It cannot run from here,
  and the root `publish.yml` does not build the lab's image yet, so that image is
  built and pushed by hand until the job is ported:
  `ontrak-lab/scripts/publish-image.sh` is its local twin, from the same stage and
  the same tags. The golden image and the scenario-template packages are in the same
  position: `infra/publish-golden-image.sh` and `infra/publish-templates.sh` still
  push them, and both now label what they push with *this* repository as the source,
  because that is where the artifact is built.
- **The installer release.** `installer-iso.yml` built and asserted the installer ISO
  on every change to it, and uploaded the parts as workflow artifacts;
  `installer-24.04.5` — the release `reassemble.sh` reaches for — is an asset on
  `innotelinc/OnTrak-dev`'s releases, because a release does not travel with a tree.
  Republishing it here is a deliberate act rather than a side effect: build the ISO
  from `ontrak-lab/infra/` ([installer.md](installer.md)) and publish the parts under
  this repository's releases, which is also the change that makes `./reassemble.sh`
  point at one place instead of two.

## What it brings up

Three compose projects, which is what this server runs:

| project | file | what it is |
| --- | --- | --- |
| `ontrak-family` | `OnTrak/docker-compose.all.yml` (+ `docker-compose.lan-db.yml`) | ITS (training), Tix, Sentinel, Sync, Genie, Portal, three databases |
| `ontrak-authentik` | `OnTrak/ontrak-lab/deploy/authentik/compose.yaml` | the local IdP the *lab* portal signs in through |
| `ontrak` | `OnTrak/ontrak-lab/docker-compose.yml` | the lab control plane: portal, gateway, Guacamole, and Incus on the host |

The family half is `make all-up-lan` in the OnTrak checkout: the base file plus the
database overlay, which publishes each database on loopback *and* on this host's LAN
address. The lab half needs `/dev/kvm` for real machines; without it the control
plane still starts and demo mode still runs.

## What it deliberately does not restore

- **The Docker volumes.** Their contents are a development server's data — seeded
  accounts, attempts, tickets, sessions — and the `.env` this script writes has
  freshly generated secrets, so an old database's rows would be signed with keys
  that no longer exist. `--no-demo` skips even the seed data. Copy volumes across
  by hand (`docker volume` plus `tar`) if a particular class's results matter.
- **The installer ISO.** It is built where it is needed (`make installer-iso`,
  `make installer-iso-tiers`), and the published release exists for a range host
  that has no internet yet. See [installer.md](installer.md).

Everything else is restored, including the two halves that are slow to produce. The
lab's own portal image is pulled and tagged `ontrak:local`, and the scenario
templates are imported (`infra/import-templates.sh`) rather than built: building one
means booting a Windows guest once per scenario, while importing one is minutes.
`make templates` is the fallback for whatever the registry does not hold, and is what
a host without `incus` or `oras` gets. Two facts are re-established on the new host
rather than shipped, because they are about the machine that will run it: the
`clean` snapshot, and the QEMU accelerator for a host whose KVM differs from the one
that built the template.

## After it finishes

The last step asks every product the same health question the `Family stack` CI job
asks, and exits 1 if one does not answer; a dry run prints those seven probes
instead of asking them. Then:

```bash
cd /srv/ontrak/OnTrak && make all-logs            # if something is missing
cd /srv/ontrak/OnTrak/ontrak-lab && make check    # the lab's own preflight
```

Sign-in is the one thing a fresh host cannot have already: the family's `.env` has
new secrets and the local Authentik has new accounts, and both are printed by the
step that generated them (`deploy/authentik/setup.sh` ends by printing the seed
accounts and the password they share).
