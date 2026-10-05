<div align="center">

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

# 🛠️ Ontrak Sync

**The Network's package and container update view — two managers that must never be confused, and one place that installs what a person approved.**

**CodeOps · self-hosted · single responsibility**

[![CI](https://github.com/innotelinc/ontrak-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/ontrak-sync/actions/workflows/ci.yml)
[![Conformity](https://github.com/innotelinc/ontrak-sync/actions/workflows/conform.yml/badge.svg)](https://github.com/innotelinc/ontrak-sync/actions/workflows/conform.yml)

</div>

---

## Why Ontrak Sync

| Problem | Ontrak Sync answer |
| --- | --- |
| “0 updates pending” on a fleet where several hosts have been unreachable for a month | An unreachable host is recorded **unreachable** and counted as **Unknown**, shown *next to* the pending count, never underneath it |
| “No updates” and “I could not look” read identically in every updater | Four distinct answers per target: findings, none, tool-not-installed, could-not-look — only the first two mark a target scanned |
| An update tool becomes the outage | No `dist-upgrade`, no installs, no removals, no config-file replacement, no blind container recreate — not configurable, because each one is how a patch becomes an incident |
| The registry budget is shared with every image pull | Digests are cached for `ONTRAK_DIGEST_TTL` (six hours), and a configured `ONTRAK_REGISTRY_CREDENTIALS` puts every pull on the authenticated budget instead of the anonymous one the scans share |
| Approval arrives as a shell session nobody can audit | Findings carry a status, the timer is a setting in the database, and applying is an explicit API call — one code path changes a machine |

> **About Ontrak Sync** — Network-wide package and container update *monitoring* and, on
> approval, *updating*. One service, one dashboard, every host on the LAN: a Python/FastAPI
> backend that reaches the Network over SSH (and `incus exec` on the incus hosts) with no Docker
> socket and nothing installed on the target machines, a Next.js dashboard, and an in-process
> cron scheduler that lives in the database rather than a system crontab.
> **Landing page:** [innotelinc.github.io/ontrak-sync](https://innotelinc.github.io/ontrak-sync)

---

## What it is

- **Backend** — Python 3.12, FastAPI, SQLite, a plain `unittest` suite. It reaches the Network
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
| `docker` | Local image digest vs the registry's platform digest — resolved like for like, because a multi-arch tag's local digest is the *index* digest. |

Findings land in SQLite with a status, and the dashboard shows them. **Approving installs** —
the Approve buttons record the decision and run the apply in one call, because a person clicking
"do the updates" means both — and **apply** re-runs whatever is already approved (after a failed
run, or an approval recorded elsewhere). Both are the same code path.

### The four answers a target can give

This is the design, and everything else follows from it.

1. **Here are the updates it needs** → findings.
2. **I looked and there are none** → no findings, target marked scanned.
3. **That tool is not installed here** → no findings, target *not* scanned, no error.
4. **I could not look** → no findings, target *not* scanned, an error is recorded.

Cases 3 and 4 must never be confused with case 2, and **none** of them may erase findings already
on record. The dashboard counts case 3 and 4 together as **Unknown** and shows it next to the
pending count rather than underneath the table — because the failure this tool exists to remove is
a fleet that reads "0 pending" while several hosts have not been reachable for a month.

Concretely, in the code:

- an unreachable host is recorded unreachable and its findings are left alone
  (`tests/test_scan.py::Reachability`)
- a probe that could not judge does not expire the finding it could not check
  (`expire_findings(..., protect=...)`)
- a registry that refuses a token produces **neither** a finding **nor** a "current" verdict
  (`scanners.image_is_behind` is three-valued)
- output a parser did not recognise sets the target's apt state to `partial` and logs the line, so
  a distribution changing its format shows up as a warning rather than as silence

### The update that is installed and not running

One more answer, and this one is about the *host*: no manager reports it. Unpacking a new
kernel is not running one, so the moment `apt` installs the replacement every manager
reports the machine as current while it goes on booting the old kernel until somebody
restarts it. A kernel CVE fix can therefore be fully installed, read as done, and not be in
effect — the same shape of untruth as "0 pending" on a host nobody could reach.

A pending reboot is a verdict of its own. It is recorded **per host** rather than as a
finding, because a reboot is not a package to approve and every container on the machine
shares its kernel; and it is deliberately **not derived from the findings**, because the
moment it would be wrong, nothing else on the page has moved.

Three answers again, and only one of them means "no":

| What the host said | What is shown |
|---|---|
| `/var/run/reboot-required` exists | **reboot**, with the packages that asked for it, and a warning in the run log |
| It was asked and there is nothing pending | **no reboot** |
| It could not be asked in a way this code understands | **reboot?** — never drawn as "no reboot" |

A probe that times out records nothing at all: a machine that answered yesterday is not
evidence that it needs nothing today. Sync will never do the reboot — that is a maintenance
window with a person in it.

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
- **No blind container recreate.** Docker's "apply" means *recreate*, so a compose project is
  rebuilt with the invocation the container's own labels describe — its project name, its working
  directory, its exact `-f` set and the `--env-file` it was started with — and, only when the plain plan cannot
  see every running service, with the profiles the compose files declare. The number of services
  compose would manage is then compared against the number running; if any are missing, the
  recreate is refused with the command the operator should run instead. A container that is not
  compose-managed is pulled and reported as manual — never recreated from a guess about its
  volumes, networks and flags.

## Quick start

```bash
cp .env.example .env          # set ONTRAK_API_TOKEN=$(openssl rand -hex 32)
make check                    # backend suite + frontend typecheck
make up                       # build and start
```

Then open `http://<host>:8421`, paste the token, and **run a scan before trusting any number on
the page** — a fresh install reports everything as unknown, which is correct.

`make setup` installs the attribution-guard hooks and copies `.env`; `scripts/setup.sh` provisions
the container and authorises the SSH key on the Network hosts. See
[docs/placement.md](docs/placement.md) for where it runs and why.

## Documentation

| Doc | What it covers |
|---|---|
| [docs/placement.md](docs/placement.md) | Where it runs (its own incus container), why not on a Network host, the addressing and access boundaries it needs |
| [docs/stack.md](docs/stack.md) | Its role in the [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack): owns / consumes / does not own |

## Layout

```
backend/ontrak/
  config.py     what a deployment is; the token is required, with no default
  db.py         SQLite, and the lifetime of a finding
  remote.py     every command that reaches another machine, in one file
  scanners.py   the pure parsers (the unit-tested core)
  scan.py       walks the Network, records findings, applies expiry
  policy.py     cron arithmetic and the apply decision
  applier.py    the only code that changes a machine
  scheduler.py  the in-process timer
  api.py        the HTTP surface
web/            the dashboard (Next.js app router)
web/landing/    the GitHub Pages landing
```

`remote.py` and `applier.py` are the only modules that touch the Network, and only `applier.py`
writes to it.

## Tests

```bash
make test        # 303 tests, no Network required
```

The suite covers the parsers, the cron arithmetic, the finding lifecycle, the scan engine (against
a fake Network) and the apply decision. It is plain `unittest` and ships inside the backend image,
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
  nothing on a real Network and every target read as `partial`. The cross-check against
  `apt list --upgradable` kept the findings visible, which is why the unit tests did not catch it
  and the first scan against the real Network did.

## The registry budget

Checking whether an image is behind means asking its registry what the tag points at now. For
Docker Hub that question is answered anonymously out of roughly a hundred requests per six hours
per address — the same budget every image **pull** in the Network draws from, so a scan that is
careless about it is what makes an update fail with `429 Too Many Requests`.

Five things keep the scanning side cheap, all of them about the same insight, that the answer is
being re-requested when it has not changed:

- **A locally built image is never asked about.** It has no repository digest, so no registry can
  produce a verdict, and the request would buy nothing.
- **A fetched digest is reused for `ONTRAK_DIGEST_TTL` seconds** (six hours by default; `0` asks
  every time). The digest is cached, not the verdict — the comparison is redone on every scan, so
  an image pulled since the digest was fetched is still recognised as current.
- **A multi-arch tag is compared like for like.** A manifest list's local repository digest is the
  *index* digest, while the registry is asked for a *platform* digest, and the two never coincide —
  so the scan first resolves the image's own index to its platform digest and compares that. The
  answer names one immutable list and is therefore cached for a year: the extra request is one per
  image *version*, not one per scan.
- **Warming that cache is spread over scans, not done in one burst.** The first scan of a Network
  against a cold cache would otherwise make one extra request per multi-arch image version all at
  once, which is exactly the shape Docker Hub answers with `429`. A scan resolves at most
  `ONTRAK_DOCKER_PIN_WARM_BUDGET` (48 by default; `0` means no cap) indices it has not seen before;
  the rest are left *unjudged* — protected, never called current — and resolved by later scans. The
  budget is one per run, not per host, because the cache is a property of the Network.
- **A tag the registry definitively refuses is remembered for a while.** A tag that does not exist,
  or that this deployment may not read, cannot be judged however often it is asked, so re-asking buys
  nothing and spends the request budget. The refusal is cached as a *cause* for `TAG_MISS_TTL_SECONDS`
  (half an hour) — never as a digest — so the image stays unjudged. A rate limit or a timeout is
  deliberately **not** remembered: those clear on their own, and caching one would hide the registry
  coming back.

In this Network that took a repeat scan from about 210 s to about 72 s, and the second scan made no
registry requests at all. A failed lookup is never cached *as an answer*: a rate limit is not a
statement about the image, and caching one as up to date would report a Network as current for as
long as the row lived. Two failures *are* remembered, both as misses and never as digests — a pinned
index the registry will not resolve (a pruned manifest, a reference that is not a list) for six hours
(`PINNED_MISS_TTL_SECONDS`), because otherwise a handful of gone indices spend a warm-up slot and a
request on every scan and starve the ones that can be resolved; and a tag the registry definitively
refuses for half an hour (`TAG_MISS_TTL_SECONDS`). A rate limit and a timeout are pointedly excluded
from both: they clear, and remembering one would hide the registry coming back. The image stays
unjudged in every case rather than being called current.

When the registry will not answer, the scan now says *why* rather than one flat "could not answer":
a request the registry rate-limited, a read it refused, and a tag it says does not exist are three
different facts to an operator — the first clears on its own, the last two are decisions — so they get
their own line in the run report.

The pulls are the other half, and thrift on the scanning side does not help them: a pull draws on
the *same* anonymous allowance, so a Network that checks carefully can still 429 the moment it
tries to install. `ONTRAK_REGISTRY_CREDENTIALS` closes that: before pulling from a registry it
holds a credential for, the applier runs `docker login` on the host (the password over stdin, never
an argument), and the pull — and every scan after it, because the daemon keeps the credential —
spends the account's budget rather than the anonymous one. Anonymous is still the default: a
registry with no credential is pulled exactly as before.

### What the registry would not answer, per host

A run report says how many images the registry would not judge, and why. That is one scan. The
same figure is also stored per host per scan (`registry_refusals`, pruned to the newest twenty
runs) and served alongside `/api/hosts`, so the hosts page can show a *rate limit* as a pattern
rather than as a sentence: a host the registry throttles scan after scan is a capacity problem,
while a refused read of a locally built image's name is ordinary noise — and one scan cannot tell
the two apart. Deliberately keyed by host and not by target, because the host's address is what
shares the registry's per-address allowance, however the affected images are spread over the
containers on it.

The response carries that window as a `series` — one point per stored run — and the hosts page
draws it beside the pill as a small bar chart, oldest on the left. Height is how many images the
scan could not judge and colour is whether the registry was throttling, so "the same thirteen
locally built names every scan" and "newly rate-limited this scan" stop looking alike; a flat row
of grey bars is the Network's baseline, an amber bar is the thing to fix.

## License

MIT — see [LICENSE](LICENSE). Copyright © 2026 Innotel Inc. The repo is all original material: it
consumes the platform services (Cerulean for DNS/TLS and optional SSO, Cerulean Vault for secrets,
the NPM Edge for public routing) rather than vendoring or re-licensing anything, so there are no
upstream licences to retain and no `THIRD_PARTY_NOTICES.md`.

---

<div align="center">

*Ontrak Sync · CodeOps · © 2026 · [GitHub](https://github.com/innotelinc/ontrak-sync) · [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)*

</div>
