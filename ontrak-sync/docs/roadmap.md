# OnTrak Sync — roadmap

> **Re-baselined at 2.0 (2026-10-24).** The shipped console is **2.0.0**; the next
> minor milestones are 2.1, 2.2, 2.3, 2.4, and the next majors are 3.0 and 4.0.
> The portfolio view is [../../docs/portfolio-roadmap-v2.md](../../docs/portfolio-roadmap-v2.md).
>
> Status legend: `[x]` shipped · `[~]` in progress · `[ ]` planned.

## 1. Vision

Keep the Network current without becoming the outage. One dashboard answers
"what is behind" for every host and container, and the only path that changes a
machine is an explicit, audited apply a person approved.

## 2. 2.0.0 — shipped baseline `[x]`

- `[x]` **Scan → findings → apply** across every configured host and, on the incus
  hosts, every container. SSH and `incus exec` only: no Docker socket, nothing
  installed on the target.
- `[x]` **Four honest answers per target** — findings, none, tool-not-installed,
  could-not-look. An unreachable host is *unreachable* and counted as Unknown,
  never shown as "up to date".
- `[x]` **Only safe updates** — no `dist-upgrade`, no installs, no removals, no
  config-file replacement, no blind container recreate. Not configurable.
- `[x]` **One code path changes a machine** — an explicit API call behind the
  approval gate; findings carry a status and the timer is a database setting.
- `[x]` **Change freeze** — `Policy.freeze_from`/`freeze_to` refuse every apply,
  `auto` included, during a moratorium.
- `[x]` **Unattended container rolls** (`ONTRAK_ROLLOUT`, off by default) — a
  claimed (host, container, image ref) remit, with undo when the new image does
  not come up, and an empty remit as the shipped state.
- `[x]` **SSO + break-glass**, the family role model and the audit trail.
- `[x]` **Registry budget** — digest cache and authenticated pulls where a
  credential is configured.

**2.0 exit:** a Network admin can see every host, read four distinct answers per
target, approve an apply, and point at the audit row for it — with no unattended
change outside a claimed remit.

## 3. Next

### 2.1 — Approval workflows `[ ]`

**Goal:** an approval that is a decision with a shape, not a click.

- `[ ]` Change windows and maintenance calendars on top of the freeze.
- `[ ]` Approvals with a named approver, an expiry, and a reason.
- `[ ]` Exit: an apply outside its window or without a live approval is refused
  with the reason, pinned by a test.

### 2.2 — Safe apply `[ ]`

**Goal:** a bad update stops at one host.

- `[ ]` Canary then wave for package upgrades (the container path already undoes
  a bad image).
- `[ ]` Rollback for an applied package set.
- `[ ]` Per-host and per-wave blast-radius caps.
- `[ ]` Exit: a failed canary halts the wave and leaves every later host untouched.

### 2.3 — Inventory depth `[ ]`

- `[ ]` Hardware, virtualisation and licence posture beside packages.
- `[ ]` Exit: one estate report names all four.

### 2.4 — Per-team scope `[ ]`

- `[ ]` Multi-tenant estates and team-scoped visibility matching the family roles.
- `[ ]` Exit: two teams see only their own hosts.

### 3.0 — Fleet-wide remediation `[ ]`

**Goal:** an estate-wide "patched" statement you can defend.

- `[ ]` Dependency-aware waves and convergence verification.
- `[ ]` An estate-level patched/unpatched answer backed by per-host evidence.

### 4.0 — Continuous compliance `[ ]`

- `[ ]` Patch SLAs, attestation exports and cross-estate reporting.

## 4. What it will never do

- Act on a container nobody claimed.
- Replace a config file, remove a package, or `dist-upgrade`.
- Report "no updates" for a host it could not read.
- Change a machine from anywhere but the one approved apply path.
