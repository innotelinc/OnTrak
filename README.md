<div align="center">

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

# 🛠️ Ontrak Sync

**The estate's package and container update view — two managers that must never be confused, and one place that installs what a person approved.**

**CodeOps · self-hosted · single responsibility**

[![CI](https://github.com/innotelinc/ontrak-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/ontrak-sync/actions/workflows/ci.yml)
[![Conformity](https://github.com/innotelinc/ontrak-sync/actions/workflows/conform.yml/badge.svg)](https://github.com/innotelinc/ontrak-sync/actions/workflows/conform.yml)

</div>

---

## Why Ontrak Sync

| Problem | Ontrak Sync answer |
| --- | --- |
| “0 updates pending” on a fleet where three hosts have been unreachable for a month | An unreachable host is recorded **unreachable** and counted as **Unknown**, shown *next to* the pending count, never underneath it |
| “No updates” and “I could not look” read identically in every updater | Four distinct answers per target: findings, none, tool-not-installed, could-not-look — only the first two mark a target scanned |
| An update tool becomes the outage | No `dist-upgrade`, no installs, no removals, no config-file replacement, no blind container recreate — not configurable, because each one is how a patch becomes an incident |
| The registry budget is shared with every image pull | Digests are cached for `ONTRAK_DIGEST_TTL` (six hours); the comparison is redone every scan, and a failed lookup is never cached |
| Approval arrives as a shell session nobody can audit | Findings carry a status, the timer is a setting in the database, and applying is an explicit API call — one code path changes a machine |

> **About Ontrak Sync** — estate-wide package and container update *monitoring* and, on
> approval, *updating*. One service, one dashboard, every host on the LAN: a Python/FastAPI
> backend that reaches the estate over SSH (and `incus exec` on the incus hosts) with no Docker
> socket and nothing installed on the target machines, a Next.js dashboard, and an in-process
> cron scheduler that lives in the database rather than a system crontab.
> **Landing page:** [innotelinc.github.io/ontrak-sync](https://innotelinc.github.io/ontrak-sync)

---

## What it is

- **Backend** — Python 3.12, FastAPI, SQLite, a plain `unittest` suite. It reaches the estate
  over SSH and needs no Docker socket, no incus binary on itself and no privileged mount. `backend/`
- **Frontend** — Next.js 16, React 19, TypeScript, hand-written CSS. `web/`
- **Timer** — an in-process cron scheduler, editable from the dashboard. Nothing in a system
  crontab, nothing to keep in sync.

A **scan** walks each configured host, then every incus container on it, and asks three package
managers what is behind:

| Manager  | How it decides                                                                 |
|----------|--------------------------------------------------------------------------------|
| `apt`    | `apt-get -s upgrade` — the only view that names the *archive*, which is how a security update is told from a feature update. Cross-checked against `apt list --upgradable`. |
| `snap`   | `snap refresh --list`.                                                          |
| `docker` | Local image digest vs the registry's, per platform.                             |

Findings land in SQLite with a status, and the dashboard shows them. An **apply** installs what
has been approved.

### The four answers a target can give

This is the design, and everything else follows from it.

1. **Here are the updates it needs** → findings.
2. **I looked and there are none** → no findings, target marked scanned.
3. **That tool is not installed here** → no findings, target *not* scanned, no error.
4. **I could not look** → no findings, target *not* scanned, an error is recorded.

Cases 3 and 4 must never be confused with case 2, and **none** of them may erase findings already
on record. The dashboard counts case 3 and 4 together as **Unknown** and shows it next to the
pending count rather than underneath the table — because the failure this tool exists to remove is
a fleet that reads "0 pending" while three hosts have not been reachable for a month.

Concretely, in the code:

- an unreachable host is recorded unreachable and its findings are left alone
  (`tests/test_scan.py::Reachability`)
- a probe that could not judge does not expire the finding it could not check
  (`expire_findings(..., protect=...)`)
- a registry that refuses a token produces **neither** a finding **nor** a "current" verdict
  (`scanners.image_is_behind` is three-valued)
- output a parser did not recognise sets the target's apt state to `partial` and logs the line, so
  a distribution changing its format shows up as a warning rather than as silence

### Modes

| | `detect` (default) | `auto` |
|---|---|---|
| Scan on the timer | yes | yes |
| Install without approval | **never** | yes, within the window and scope |

`auto` has to be chosen deliberately in the settings form, where the confirmation names the
managers and the window it will act in. There is no API parameter that applies something
regardless of the mode — a policy a request can bypass isn't a policy. `security_only` is what
makes `auto` tolerable: CVE fixes go out, feature updates wait for a person.

### What it will never do

Not configurable, because each one is how an update tool becomes an outage:

- **No `dist-upgrade`.** A distribution upgrade replaces the kernel and can need a reboot; that is
  a maintenance window with a person in it.
- **No installs and no removals.** apt runs with `--only-upgrade`, so an unsatisfiable dependency
  fails the transaction instead of removing something to satisfy it.
- **No config-file replacement.** `force-confdef`/`force-confold` keeps the operator's configuration.
- **No blind container recreate.** Docker's "apply" means *recreate*, so before recreating a compose
  project the number of services compose would manage is compared against the number running. If
  compose would manage fewer, the recreate is refused with the command the operator should run
  instead. A container that is not compose-managed is pulled and reported as manual — never
  recreated from a guess about its volumes, networks and flags.

## Quick start

```bash
cp .env.example .env          # set ONTRAK_API_TOKEN=$(openssl rand -hex 32)
make check                    # backend suite + frontend typecheck
make up                       # build and start
```

Then open `http://<host>:8421`, paste the token, and **run a scan before trusting any number on
the page** — a fresh install reports everything as unknown, which is correct.

`make setup` installs the attribution-guard hooks and copies `.env`; `scripts/setup.sh` provisions
the container and authorises the SSH key on the estate hosts. See
[docs/placement.md](docs/placement.md) for where it runs and why.

## Documentation

| Doc | What it covers |
|---|---|
| [docs/placement.md](docs/placement.md) | Where it runs (its own incus container), why not on an estate host, the addressing and access boundaries it needs |
| [docs/stack.md](docs/stack.md) | Its role in the [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack): owns / consumes / does not own |

## Layout

```
backend/ontrak/
  config.py     what a deployment is; the token is required, with no default
  db.py         SQLite, and the lifetime of a finding
  remote.py     every command that reaches another machine, in one file
  scanners.py   the pure parsers (the unit-tested core)
  scan.py       walks the estate, records findings, applies expiry
  policy.py     cron arithmetic and the apply decision
  applier.py    the only code that changes a machine
  scheduler.py  the in-process timer
  api.py        the HTTP surface
web/            the dashboard (Next.js app router)
web/landing/    the GitHub Pages landing
```

`remote.py` and `applier.py` are the only modules that touch the estate, and only `applier.py`
writes to it.

## Tests

```bash
make test        # 188 tests, ~1s, no estate required
```

The suite covers the parsers, the cron arithmetic, the finding lifecycle, the scan engine (against
a fake estate) and the apply decision. It is plain `unittest` and ships inside the backend image,
so the deployed artefact can be verified directly:

```bash
docker run --rm innotel/ontrak-sync-api:1.0.0 python tests/run-all.py
```

Bugs of this kind that have already been caught here, all of which would have been silent in
production:

- **weekday mapping.** cron numbers Sunday=0…Saturday=6; Python numbers Monday=0…Sunday=6. The
  first version assumed they matched, so `0 4 * * 0` would have fired on **Monday** and every
  weekly schedule would have been a day out. The same mistake had a second home in the sentence
  the settings page prints, which labelled every schedule one day early while the list of next
  runs beneath it disagreed.
- **expiry on a non-verdict.** A target whose managers were all *absent* counted as inspected, so
  a scan could expire findings it had never actually checked.
- **one archive instead of a list.** `apt-get -s` prints two archives for a package in both an
  updates and a security pocket — `noble-updates, noble-security` — and the parser matched a single
  token. It rejected those lines, which is exactly the security case, so the simulation contributed
  nothing on a real estate and every target read as `partial`. The cross-check against
  `apt list --upgradable` kept the findings visible, which is why the unit tests did not catch it
  and the first scan against the real estate did.

## The registry budget

Checking whether an image is behind means asking its registry what the tag points at now. For
Docker Hub that question is answered anonymously out of roughly a hundred requests per six hours
per address — the same budget every image **pull** in the estate draws from, so a scan that is
careless about it is what makes an update fail with `429 Too Many Requests`.

Two things keep the scanning side cheap, both of them about the same insight, that the answer is
being re-requested when it has not changed:

- **A locally built image is never asked about.** It has no repository digest, so no registry can
  produce a verdict, and the request would buy nothing.
- **A fetched digest is reused for `ONTRAK_DIGEST_TTL` seconds** (six hours by default; `0` asks
  every time). The digest is cached, not the verdict — the comparison is redone on every scan, so
  an image pulled since the digest was fetched is still recognised as current.

In this estate that took a repeat scan from about 210 s to about 72 s, and the second scan made no
registry requests at all. A failed lookup is never cached: a rate limit is not a statement about
the image, and caching one would report an estate as up to date for as long as the row lived.

## License

MIT — see [LICENSE](LICENSE). Copyright © 2026 Innotel Inc. The repo is all original material: it
consumes the platform services (Cerulean for DNS/TLS and optional SSO, Cerulean Vault for secrets,
the NPM Edge for public routing) rather than vendoring or re-licensing anything, so there are no
upstream licences to retain and no `THIRD_PARTY_NOTICES.md`.

---

<div align="center">

*Ontrak Sync · CodeOps · © 2026 · [GitHub](https://github.com/innotelinc/ontrak-sync) · [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)*

</div>
