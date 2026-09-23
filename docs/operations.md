# Operations

## Capacity: the arithmetic

Three resources bind, in this order: **RAM**, then **storage**, then **CPU**.

Baseline per student VM (from `infra/incus/profile.yaml`): 2 vCPU, 4 GiB RAM,
48 GiB thin disk. A booted Windows VM idles at a few percent CPU and ~1.5-2 GiB
resident, but plan for the limit, not the idle.

### RAM is the binding constraint

```text
RAM ≈ host_overhead (8-16 GiB)
    + max(live_students, pool_target) × 4 GiB
    + refill_headroom
```

The `max(...)` is the important part, and it is why the pool targets count
*claimed* VMs too: when a student claims a pooled VM the pool shrinks by one, so
a full class holds `students` VMs, not `students + target`. The reaper only builds
replacements as sessions end.

| Host | Students (simultaneous) | Notes |
| --- | --- | --- |
| 4 vCPU / 15 GiB, `dir` storage | 1 | This site. See "One student at a time" below. |
| 8 vCPU / 16 GiB, `dir` storage | 2-3 | Development only. Every clone is a full 20-30 GB copy. |
| 16 vCPU / 64 GiB, ZFS or btrfs | 8-12 | Small class. Pool of 4-6 prewarmed for instant handoff. |
| 32 vCPU / 128 GiB, ZFS or btrfs | 20-26 | Comfortable class of 20 with a pool of 10. |
| 64 vCPU / 256 GiB, ZFS or btrfs | 45-55 | Two classes back to back, or one large lab. |
| Incus cluster (2× 32 vCPU / 128 GiB) | 40-50 | Recommended above ~30 students; one control node runs the portal. |

### One student at a time

The lab host (`ontrak`) is 4 vCPU / 15 GiB on `dir` storage, and it runs a single
student. That is a policy, not the arithmetic: two fit on paper, and two at once is
exactly the case that swaps — one of them is `os-perf-startup`, which burns a core
by design. So the pool is sized for one machine, which is also what makes the first
connection instant:

```text
ONTRAK_POOL__DEFAULT_TARGET=1   # one machine warm and waiting for the student
ONTRAK_POOL__MAX_TOTAL=1        # and never a second one pre-built beside it
```

`pool.max_total` bounds *pool* VMs, not sessions: a session that outlives the warm
machine still provisions from the template's `clean` snapshot, so the ceiling costs
latency rather than access. Raise both only when the host itself grows — with `dir`
storage every clone is a full 20-30 GB copy, so the second student is the expensive
one.

### RAM belongs to the host, not to the table

The arithmetic above is a function of the machine the range is on, so `ontrak doctor`
prints it from `/proc/meminfo` for the host being asked — run it on the host that is
failing rather than trusting the rows. A 2 vCPU / 7.7 GiB host (a laptop, one student)
has about 3.6 GiB free behind a single Windows guest, which is not enough for another:
a template boot, a hardware probe or a second session becomes a kernel *global* OOM
kill, and the guest the kernel picks dies mid-boot. That does not look like swapping. It
looks like a session that "never became reachable over the winrm transport", because the
machine that message names was already gone — and until the error started carrying the
machine's own state (the troubleshooting row below), the reading sent an operator to
WinRM and the golden image instead. Treat the one-student policy as a ceiling on every
guest the host may hold at once — a booted template is a guest too — and keep the build
work out of teaching hours.

### CPU: mind the performance scenario

`os-perf-startup` deliberately burns one core per student. In that scenario CPU
is not overcommittable: 30 students need roughly 30 cores' worth of headroom, or
the CPU objective becomes noisy and grading turns flaky. Either split the cohort,
shrink the pool for that session, or raise the VM's `limits.cpu` and adjust the
scenario's threshold. Every other scenario is happy at 2-3× CPU overcommit.

### Storage

| Storage driver | Clone cost | When to use |
| --- | --- | --- |
| `zfs` / `btrfs` | Copy-on-write, seconds, megabytes | **Use this.** Snapshots and resets are the whole design. |
| `lvm` (thin) | Similar, with thin snapshots | Fine if you already run LVM thin. |
| `dir` | Full copy: 20-30 GB and minutes per VM | Works, but a 30-student class means ~900 GB and a slow start. |

```text
disk ≈ templates (20-30 GiB × scenarios, powered off)
     + pool VMs × (a few GiB on CoW; full size on dir)
     + recordings, if guac.recording is on
```

`ontrak doctor` warns when the pool driver is `dir`.

## Scheduled prewarm and teardown

A class starts at 09:00. If every student's first action is "provision me a machine", the
first minutes are spent watching a clone bar and the host takes a burst of load. Both
problems disappear if the pool is warm before the class and drained after it.

```yaml
schedule:
  enabled: true
  windows:
    - label: morning-class
      days: [mon, wed]
      start: "09:00"
      end: "12:00"
      prewarm_minutes: 30      # start filling at 08:30
      target: 15               # unclaimed, booted machines per scenario
      scenarios: [net-dns-failure, os-perf-startup]
```

```bash
ontrak schedule show     # the windows, and which phase we are in right now
ontrak schedule tick     # decide and perform: prewarm, recycle idle, drain
```

`tick` is idempotent and safe to run from cron every minute. It prewarms only a genuine
deficit — a class mid-session does not trigger a second wave — recycles sessions idle beyond
`session.idle_recycle_minutes` while a window is open, and drains unclaimed pool machines
when a window closes (never one a student is using).

Without a schedule you can do the same by hand:

```bash
ontrak pool prewarm --scenario net-dns-failure --count 15
ontrak pool drain --scenario net-dns-failure      # after the class
```

## Media, before the first class

The catalog describes media; the media store holds it. Check what you actually have:

```bash
ontrak media status      # present / fetchable / operator-required, with sizes
ontrak media missing     # the exact filenames to supply from your own licences
ontrak media fetch       # free media only: evaluation ISOs and image-server entries
```

Expect a first-run download in the tens of gigabytes if you fetch everything. Free media
can be served from a local mirror instead — a manifest `url:` accepts `file://`.

## Time limits

Each session is created with a time limit the student picks (`session.time_limit_choices`,
default 45/90/180 minutes), stored on the session row rather than derived from config on
read, so what a student was granted is auditable. Operators change it mid-session:

```bash
ontrak session limit --session-id 42 --minutes 120   # set the clock
ontrak session extend --session-id 42 --minutes 15   # grant extra time as a delta
```

Expiry destroys the machine and closes the session. Nothing is graded on the way out — an
unsubmitted session has no result, which is the intended meaning of "results only".

## Running with no host hypervisor

The portal serves every page — catalogue, tickets, grading, the instructor view — against
whatever is stored in its database even when no hypervisor can be reached. It cannot
provision a machine, and it says so on the admin panel:

```bash
ontrak serve                                      # the portal on this host
```

It proves the control plane and the UI. It does **not** prove the Windows path — the same
caveat applies as everywhere else: `ontrak doctor` and one real template build.

Running the platform itself in Docker (`docker compose up -d`) changes none of this: the
containers are the control plane and the console gateway, while the training machines stay
Incus VMs on the host. The first run prepares that host for you — it installs Incus and
creates the pool, bridge, project and profiles — so the only thing left before a class is
the part that genuinely needs a human: check the storage driver, build the templates you
intend to use, and size the pool. See [docker.md](docker.md) for what is containerised, the
three ways to reach a hypervisor, and the volume that holds the results.

## Before, during and after a class

### Before (10 minutes)

```bash
make doctor                                                    # host healthy? (incus, secrets, console gateway key)

.venv/bin/ontrak scenario validate                           # catalogue healthy?
.venv/bin/ontrak template build --all                        # after any scenario edit
.venv/bin/ontrak console verify --linux --workloads \
    --base-url https://localhost:8443/guacamole/              # every Linux console opens? one machine at a time
.venv/bin/ontrak console browser linux-user-lifecycle \
    --portal-url https://localhost:8443/                     # and one of them opens in a real browser
.venv/bin/ontrak pool prewarm --scenario net-dns-failure --count 30
make serve          # the portal — it reaps expiry, idle sessions and history itself
```

Prewarm only the scenario(s) you are teaching now. Keeping a pool warm for all
six scenarios multiplies idle RAM by six for no benefit.

There is no second terminal for the reaper any more. The portal runs the session
half of it in a background loop (`session.maintenance_enabled`, once a
`session.maintenance_interval_seconds`): a session past its time limit or idle
beyond `session.idle_recycle_minutes` is recycled, and once a day finished
history older than `session.history_days` is deleted. That is what makes the
promise under **During** true on the container stack, which has no cron for
`ontrak reap` to live in. It deliberately does **not** refill the pool: that is
capacity policy (`pool.targets`, `ontrak schedule tick`, `ontrak pool refill`) and
a background thread booting machines on a small host is nobody's idea of
lightweight.

*Idle* means no sign of the student, and the sign is this portal: the session page
carries a `/sessions/<id>/heartbeat` while it is open, and the console is a frame on
it — the page says so, in the student's own words. Work done inside the console never
reaches the portal at all (the gateway serves it), so a student who closes that page
and keeps working in a popped-out console reads as absent and loses the machine at
this limit, whatever time limit they chose.

There is a roster if you sign in locally — create the class under **Admin →
Accounts** (or seed the first instructor with `ONTRAK_PORTAL__ADMIN_PASSWORD` on a
headless box). With SSO on there is none to import: the portal creates an account
on the first sign-in, keyed on the account's Authentik **email** address. In that
case provision the class in Authentik (and, if you gate the range to a cohort, set
`ONTRAK_PORTAL__OIDC_REQUIRED_GROUP`) before the session — a student who signs in
before that still lands on the row that holds their results, because the row is
their email either way.

### During

* Students self-serve from `/dashboard`; each gets their own VM and timer.
* `/instructor` shows live sessions, the pool, results, and a **Watch** link per
  session (Guacamole) when `guac.recording` or shadowing is enabled.
* Stuck student: give them `+15 minutes` or reset their session from the
  instructor page rather than debugging the VM yourself.
* A session left open on a screenless desktop is recycled automatically — by the
  portal's own housekeeping loop (`session.idle_recycle_minutes`), or by a cron
  `ontrak schedule tick` on a range that has one — so you rarely need to end
  sessions by hand. The exception is a session whose page a student left *open*:
  that page is what marks them present, so the machine lives until its own time
  limit. End it from `/instructor` if you need the RAM back. Either way the event
  log records the recycle and the machine is destroyed.

### The student's console: RDP for Windows, SSH for Linux

Guacamole speaks RDP and SSH, and the guest decides which one a scenario needs.
A Windows VM brokers RDP (`guest.rdp_port`). A Linux *container* answers no RDP at
all, so an RDP connection aimed at one used to render as a page saying "the remote
desktop server is currently unreachable" — a message that blamed the student's
machine for a transport that was never going to exist, and said nothing about the
scenario being fine.

`guac.linux_ssh` is **on by default**, so `ontrak template build` provisions the
template for a shell console instead: `openssh-server` installed, root's password
set to `guest.password`, `PermitRootLogin` and `PasswordAuthentication` enabled, and
a `00-ontrak-console.conf` drop-in written into `sshd_config.d` so an image's own
drop-in cannot override it. That runs **after** the fault is injected and after
`setup.sh` has verified it, and is the last thing written before the snapshot — a
fault that touches accounts or permissions (`id-locked-account`,
`linux-sudo-delegation`) must not be able to take the console's credential with
it. A build where sshd does not come up **fails**, naming the reason, rather than
snapshotting a template whose console will lie.

Two consequences worth knowing: it is the one step in a template build that
reaches the network (apt), and it opens port 22 in every Linux guest on the
isolated `ontrak0` bridge. It also refuses to run with an empty `guest.password`,
because `chpasswd` would set an empty one and the console would then be openable
as root by anyone on the lab network. Set `guac.linux_ssh: false`
(`ONTRAK_GUAC__LINUX_SSH=false`) for a range whose Linux guests must not answer
SSH: a Linux scenario then has no console, the page explains why, and the build
stops installing sshd. Either way, a template is a snapshot — a change here only
takes effect on a rebuilt template (`ontrak template build --all --force`, or
`make templates`), so a Linux scenario built under the old setting keeps whatever
console it was snapshotted with.

A console is opened by three requests, and they can fail one at a time while looking
identical from the student's side (a blank frame). Two are HTTP: the signed payload
becomes a token, and the token lists the connection. The third is the console itself — a
WebSocket to `<guac.base_url>websocket-tunnel`, opened with the `guacamole` subprotocol,
answered by guacd with the terminal's or desktop's own instructions. That third one is
the only check that notices a webapp with no guacd behind it: with guacd stopped,
measured on a real range, the WebSocket still upgrades and the subprotocol is still
negotiated, and then *nothing* arrives at all, because the webapp sends the tunnel's UUID
only once it has something to send it to. `ontrak doctor` opens that tunnel once, against
a placeholder connection, and says so when nothing comes back; `ontrak console verify
--linux` opens it for every Linux scenario in turn — allocating one machine at a time and
destroying it again — which is a sweep a host that cannot hold a whole class can still
run before one. The check itself sends nothing but what a browser sends — a bare `nop` every
five seconds — because guacd aborts a client it has not heard from for fifteen seconds
(status 776, "Aborted. See logs."); without it, a console that is merely slow to paint is
reported as a console that is broken. Under the shipped `guac.base_url: auto` there is no fixed console address
for a process with no browser to open a tunnel on, so `console verify` asks for one —
`--base-url https://localhost:8443/guacamole/` on a TLS stack's own host, or
`http://localhost:8080/guacamole/` for `make up` — and `ontrak doctor` reports its
console checks as skipped rather than guessing at one.

`--workloads` is what makes "every Linux console" true: a scenario offered on Ubuntu *and*
Debian is one template per platform, so a sweep without it opens the one the catalogue lists
first and reports a green range with the other half unchecked. And one thing none of that
can see is the **page**: `ontrak console browser <scenario>` signs in to the portal, starts
the scenario through the portal, opens the session page in Chromium and types into the
terminal, then destroys the machine. It is the only check that can tell a console which is
perfect over the wire from one whose frame never loads, whose bootstrap page cannot clear
Guacamole's cached token, or whose canvas no keystroke reaches. Three things it needs:

- **A browser engine**, which is a download of its own and deliberately not in
  `requirements.txt`: `pip install playwright && playwright install chromium`. Set
  `PLAYWRIGHT_BROWSERS_PATH` to a directory inside the checkout to keep the ~170 MB there.
  Without an engine the command fails and says so — it does not quietly do nothing.
- **The portal's own address** (`--portal-url`), because this drives the portal's pages and
  not just the gateway's WebSocket. `guac.base_url: auto` is derived from each browser's
  address, so a process has none and must be told one.
- **An account that can open a session**, `--browser-user`/`--browser-password`, defaulting
  to `portal.admin_username`/`portal.admin_password` (an instructor may view any session).
  On a container stack the portal keeps its accounts in its **own volume** (`ontrak-state`),
  not in this checkout's `state/` — so if it refuses the sign-in, the password it wants is
  the one in the portal's database, and the error says exactly that.

One machine at a time, on purpose: this allocates a real scenario through the portal and a
sweep of them is a class's worth of work. The wire sweep above is the one that scales, and
the nightly range walk runs both — the sweep over both Linux workloads, then this for one
scenario (`ONTRAK_BROWSER_SCENARIO`, `ONTRAK_BROWSER_USER`/`ONTRAK_BROWSER_PASSWORD` when
the runner should not hold the admin password).

### After

```bash
curl -s -b "ontrak_session=$COOKIE" http://portal:8080/instructor/results.csv > results.csv
.venv/bin/ontrak session list                     # confirm nothing is left running
.venv/bin/ontrak reap                             # ends anything expired or idle
.venv/bin/ontrak session prune --dry-run          # what finished history would go
.venv/bin/ontrak pool refill                      # or set targets to 0 to give the RAM back
```

Student VMs are always destroyed — there is nothing to clean up by hand. Only pool
VMs and powered-off templates persist, and templates cost no RAM.

Two kinds of *row* are worth knowing about, because they look alike in
`session list` and are not:

* an **expired live row** (`in_use`, timer long past) — the student walked away and
the machine is gone. `ontrak reap` recycles it and ends the session.
* a **finished row** (`destroyed` / `error`) — nobody is owed anything. These pile
up over a term and `ontrak session prune` deletes the ones older than a week
(`--days 0` for all of them, `--dry-run` to see first). A session a submitted
result or a ticket points at is **never** pruned: the marking record outlives the
machine.

## Multi-host

Put the hosts in an Incus cluster and point the control plane at the cluster
endpoint; placement is then the cluster's job.

```bash
incus remote add lab https://node1.lab.example.com:8443 --auth-type=tls
export ONTRAK_INCUS__REMOTE=lab
```

Keep the portal, Guacamole and SQLite on one control node, and prewarm enough VMs
for the whole class: a cluster does not make a cold Windows boot faster.

## Maintenance

| Task | Command / approach |
| --- | --- |
| Before a class: is the pool fit to teach on? | `make sweep` | Grades every `(scenario, workload)` pair on a real machine and prints the table, for the two things a manifest cannot claim: **broken untouched** (the fault really is in the snapshot) and **resolved after repair** (grading follows the student's work). The second half needs the answers to the exercises, which live outside this repository in `dist/sweep-repairs.json` — ignored, so it survives the run and later sweeps grade both halves without a flag. `make sweep-key` writes that file keyed by every scenario in the catalogue to fill in; an existing key is never overwritten. `--pairs id-locked-account` narrows it, and `--repairs <path>` puts the key somewhere else. It boots real machines: a full run is ~40 minutes |
| Did a change break the lifecycle the unit tests cannot see? | `ONTRAK_E2E=1 make test`, or nightly | `tests/test_range_end_to_end.py` walks one student through the whole thing on a real VM: the door, the account, the session, the address off the page, an untouched 20%, the repair, 100%, the write-up, the hand-in, and what the page offers after each of them. Skipped unless `ONTRAK_E2E=1` is set, because it boots a machine. `.github/workflows/range-nightly.yml` runs it at 03:17 UTC on a self-hosted runner labelled `incus`, and **fails when the walk skipped** — a skipped pytest is a green pytest, and a nightly that skips every night reads as coverage while covering nothing. It never deletes instances: it runs against a range a class may be using |
| Refresh the Windows image (patches, expired eval) | `make golden` — rebuilds and republishes `ontrak-win-base`, then rebuild templates |
| Scenario edited | `make validate && .venv/bin/ontrak template build <id> --force` |
| Is a built template still current? | Admin → Platforms (or Scenarios) | Every template is listed with its freshness: **ready**, **stale**, **no snapshot** or **not built**. *stale* is the one that is easy to miss — a clean snapshot built from an older recipe, so the machine boots and grades while running yesterday's fault under today's ticket. The counts are on the overview tile; rebuilding is a button on Scenarios. No separate check is needed |
| Templates regenerated | Pool VMs built from the old template keep running; end their sessions or let the reaper recycle them |
| Leaked instances | `incus --project ontrak list` and delete anything that is not `tpl-*` or an active session; `ontrak stats` shows the state counts |
| Session rows piling up over a term | finished rows (`destroyed`/`error`) nobody is owed | the portal prunes them once a day past `session.history_days` (30 by default; 0 keeps them forever). `ontrak session prune` does it now (add `--days N`, or `--dry-run` to look first) — it keeps every session a result or ticket points at, and never touches a live one |
| Sessions never expiring on their own | `session.maintenance_enabled: false`, or a portal too old to have it | The portal reaps expiry, idle sessions and history itself. Check the stack is on a current image (`make up` rebuilds) and that nothing set the setting to false |
| Control plane database | `state/ontrak.sqlite3` (WAL) on the host, or the `ontrak-state` volume when the portal runs in Docker (`docker run --rm -v ontrak-state:/s alpine tar czf - -C /s . > ontrak-state.tgz`). Back it up if results matter; deleting it resets users/results, not VMs |
| Logs | `journalctl -u incus`, `make logs` (or `docker compose logs -f`) for the stack, and the portal's events table (`/admin/audit`) |
| Who is an instructor | an SSO account's role is membership of the Authentik group in `ONTRAK_PORTAL__OIDC_INSTRUCTOR_GROUP` (read on every sign-in) — change the group in Authentik. A local account's role is set under Admin → Accounts |
| Reclaim RAM fast | set `pool.targets` to 0, then `ontrak pool status` and delete pool VMs, or just stop them with `incus stop` |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Session sits in `provisioning`, then `error` | guest transport never answered | Check `session.error` on the page, then `ONTRAK_INCUS__REMOTE=... incus --project ontrak info <instance>`; confirm the guest has an IP on `ontrak0`. If RDP is up but WinRM is not, the image's `post-install.ps1` step did not run — rebuild the golden image. |
| A session fails with `never became reachable over the winrm transport`, and the error also says the machine is stopped or gone | the host ran out of memory and killed the guest, so nothing was left to answer. Measured on a real range: three QEMU processes resident on a 7.8 GiB host — a session clone, a template VM being started, and a third guest — a *global* OOM kill, and the kernel took one of them mid-boot. WinRM, the golden image and the port were all fine | Fixed — the error now carries the machine's own state from Incus, which is the one fact that separates a killed guest from a slow one. `journalctl -k -g oom` has the kill, and `ontrak doctor` prints what the host actually holds (one 4 GiB guest on 7.8 GiB). Every guest counts against the same RAM — a booted template is a guest too — so do not build a template, sweep or probe while a class is on. Re-run the session once the other machines are gone. |
| `make golden` reports success but every Windows template then hangs at the firmware boot prompt, and `ontrak doctor` still says the golden image is present | the ISO install was OOM-killed and the half-applied disk was published as the image. Incus gives a VM disk the host write cache by default, so applying the ~7 GiB Windows image is charged to the container's memory cgroup; on a 16 GiB range host the kernel kills qemu part-way through the apply. The pinned builder (`tools/click.py`) then only waits for `incus ls` to report STOPPED — it cannot tell that kill from the clean sysprep shutdown it expects — and `pack.sh` publishes the truncated disk anyway | `infra/build-golden-image.sh` now sets the build disk to `io.cache=none` and bounds the guest RAM (`ONTRAK_GOLDEN_CPUS`/`ONTRAK_GOLDEN_MEMORY`), which removes the pressure that caused the kill. Re-run `make golden`. To check a suspect image, inspect its ESP: a formatted-but-empty ESP (no `EFI/Microsoft/Boot/bootmgfw.efi`) means the apply never finished |
| `make golden` gets all the way through the install and then fails part-way through publishing, and from that point every `incus` command fails with `Failed to begin transaction: no available cowsql leader server found` or `context deadline exceeded` | `incus publish` tars the build disk's *apparent* size into the image — holes are not skipped — and the image store shares a dataset with Incus's own cowsql database, so a long enough copy starves the database's leader election and takes the daemon's DB with it. The bigger the build disk, the worse it gets: a 60 GiB disk copied with `--compression none` ran for fourteen minutes before wedging the DB, and a 29 GiB one ran fifteen | Size the build disk small (already done: `ONTRAK_GOLDEN_DISK`, default 32 GiB) and let `incus publish` keep its default gzip (`--compression none` is the mistake, not the fix). If the DB is already wedged, `systemctl restart incus` clears it — the installed disk survives, so recover rather than rebuild: publish that instance instead of re-running the 30-60 minute install |
| `ontrak template build` fails with `incus list --format=json failed (124): timed out after 120s`, even though `ONTRAK_INCUS__OPERATION_TIMEOUT_SECONDS` is raised | the plumbing used to fall back to its own 120 s default for reads, ignoring the operator's setting. `incus list` is not a cheap read on a busy host: it reports each instance's state, agent status and address, so it blocks for minutes on a VM that is still booting | Fixed — the configured timeout is the ceiling for every call. If you are on an older build, raise the default in `incus.py` or pacify the host first |
| `pywinrm` errors with 401 | wrong training password, or the account is not a local admin | Compare with `guest.password`; the image sets `LocalAccountTokenFilterPolicy=1` so elevation should work |
| Template build fails with "never obtained an address" | wrong bridge or DHCP range exhausted | `incus network get ontrak0 ipv4.dhcp.ranges`; widen the range for large classes |
| Template build fails with "did not report ONTRAK-SETUP-OK" | the setup script threw | The error includes the output tail; run the VM manually and execute `setup.ps1` to see the full error |
| "template is missing snapshot clean" | scenario edited, template not rebuilt | `ontrak template build <scenario> --force` |
| Guacamole shows "connection failed" | target 3389 unreachable from guacd, or wrong credentials | `ontrak session console <id>` to inspect; confirm the VM answers on 3389 from the control node; check `guest.rdp_port` |
| Console opens an empty session, or one with no connection in it, while the gateway looks healthy | the gateway accepted the signed payload as a token but did not register the connection the browser then reads (its JSON auth extension is not enabled: `JSON_ENABLED: "false"`) | `ontrak doctor` follows the whole path — token, then the connection list the browser reads, then the console's own WebSocket — and **fails** when the connection is missing. Enable `JSON_ENABLED` on the gateway and recreate it (docker-compose.yml) |
| The console frame opens and stays blank — no error on screen, no desktop or shell — while the gateway and the student's link both look healthy | the webapp has no guacd to open the connection with. With guacd stopped the WebSocket still upgrades and the subprotocol is still negotiated, and then nothing at all arrives: the webapp sends the tunnel's UUID only once it has a guacd connection, so there is nothing to render and nothing to report | `ontrak doctor` opens that tunnel and **warns** (`unreachable`) when nothing comes back, and `ontrak console verify <scenario>` says the same about one real machine. Check `docker compose ps` for `guacd` and `docker compose logs guacamole`; every other check in `doctor` passes on this stack |
| Console loads but every session is refused ("Permission denied"), or the iframe never opens | the gateway signs off on a different `JSON_SECRET_KEY` than the portal's `guac.secret_key`, or its `guacamole-auth-json` extension is not enabled | `ontrak doctor` probes this directly and now **fails** on it (it posts a payload signed with `guac.secret_key` to `<guac.base_url>/api/tokens`). Make `JSON_SECRET_KEY` equal `ONTRAK_GUAC__SECRET_KEY` and recreate the gateway: `make console-recreate` (or `docker compose up -d --force-recreate guacamole`). A stack started before the key was set keeps the empty one until it is recreated. The student's page says so too instead of showing an empty console |
| Console iframe blank | `guac.base_url` is not the URL the student's browser uses, or the page is HTTP while Guacamole is HTTPS | Set `guac.base_url` to the browser-visible HTTPS URL and put a TLS proxy in front |
| A student's console opens the **previous** session's machine — typically one that has since been destroyed — and says "the remote desktop server has encountered an error and has closed the connection" | Guacamole keeps its auth token in the browser's `localStorage` and re-authenticates with it on every load, and the gateway *reuses the session that token belongs to*: a still-valid stored token beats the fresh, correctly signed payload the portal just handed over, so the console keeps dialling the machine that browser opened last. Nothing about the failing machine is wrong | Fixed — the console frame now loads the portal's own `/sessions/<id>/console` page first, which clears `GUAC_AUTH_TOKEN` before opening the signed URL. A browser that still shows it is on the old build; recreating the portal (`make up`) is enough. The one case the portal cannot clear is a console on a *different origin* than the portal (a cross-origin `guac.base_url`), because `localStorage` is per origin — use `auto`, or a name that serves both the portal and `/guacamole/`. `ontrak doctor` warns about a pinned `guac.base_url`, and the student's session page says it in a card above the console, so the misconfiguration is stated rather than left to look like a broken machine |
| Console says "the remote desktop server is currently unreachable" | the console iframe is an **RDP** connection pointed at a Linux *container*, which answers no RDP at all — the template was built while `guac.linux_ssh` was off, so no sshd is in its snapshot | Rebuild that scenario's template with `guac.linux_ssh` on: `ontrak template build <scenario> --force`, or `make templates` for every one. The build installs and configures `sshd` (see below) and the console becomes a shell |
| Console is refused the same way **after** switching `guac.linux_ssh` on | the template predates the setting | Templates are snapshots: re-run `ontrak template build <scenario> --force` for each Linux scenario, or `infra/build-templates.sh`. A template built before the setting was on has no sshd in it |
| A student's machine is destroyed mid-scenario, `destroyed` with `[idle_Nm]` on the row and its console frame still on screen | the reaper read *portal* activity, and a student works in the console — a different upstream — so a session whose page was opened once and then left alone looked abandoned. On this range that was session #8: 45 minutes chosen, destroyed `idle_20m` twenty-one minutes in | Fixed — the session page beats `/sessions/<id>/heartbeat` (once a minute, while the machine is on screen) and that is what activity means; the page says so in its Session card. A beat never revives anything: only a session with a machine is touched, so a destroyed row cannot be held open by a stale tab. If a student closes that page and works only in a popped-out console, the machine still ages out — reopen the session page, or give them `+15 minutes` from `/instructor` |
| Students say "no machine available" | pool empty and clones are slow | Prewarm more, or move the pool to ZFS/btrfs |
| Pool keeps growing and the host swaps | refill targets too high for a full class | Lower `pool.targets`, or `pool.max_total`; remember targets count claimed VMs, so `target = class size` is the right shape |
| Grading returns 0% with "grading could not run" | `check.ps1` failed or never printed the markers | Run it manually in a session; `make validate` first, then check the guest-side error in the network detail line |
| Scores look wrong after an image change | the check reads live state that moved (an adapter name, a service name) | Prefer outcome-based checks (`docs/scenarios.md`); open a session and inspect the `-Detail` strings |

## Sign-in

Sign-in is **local accounts by default**: the portal keeps a password per account,
so a range is usable the moment it starts, with no identity provider installed.
Single sign-on through **Authentik** is optional and off until an instructor
switches it on — both doors end at the same session, and neither needs the other.

### Local accounts

* **First run.** A range with no accounts and no provider configured serves a
  one-time `/setup` page that creates the first instructor. It closes as soon as
  an account exists, and it is deliberately *not* offered on a range that has been
  provisioned for Authentik (see below).
* **Headless.** Set `ONTRAK_PORTAL__ADMIN_PASSWORD` (with
  `ONTRAK_PORTAL__ADMIN_USERNAME`, default `admin`) before the portal starts and
  that instructor is seeded at startup instead — the unattended equivalent of the
  page. Neither touches a password an instructor has since changed.
* **After that**, **Admin → Accounts** creates students and instructors and sets
  or resets passwords. Passwords are PBKDF2-SHA256 (200,000 rounds, random salt);
  the minimum is 8 characters.
* Disable, enable and delete work for every account. Deleting removes only the
  local row: results and tickets stay, because a marking record the instructor can
  erase is not a marking record.

### Single sign-on (optional)

The portal has no identity provider of its own. An instructor and a student can be
**Authentik** accounts in Cerulean, and the portal only decides what a signed-in
account may do — one list of who exists, one place to disable someone, and
nothing on the range to keep in step.

Cerulean registers the application, and prints the client secret for it:

```bash
# in Cerulean's checkout
python3 scripts/authentik-setup.py ontrak
```

Then set the four `ONTRAK_PORTAL__OIDC_*` values in `.env` (see `.env.example`)
and switch SSO on in **Admin → Sign-in**. All four are needed: with any one
missing the admin panel refuses to switch it on, rather than rendering a button
that leads nowhere.

The switch is stored in the portal database, so it survives a restart with no
edit to `.env`. `ONTRAK_PORTAL__SSO_ENABLED` only *seeds* a range that has never
been switched on or off.

**The callback is per origin.** The sign-in returns to the origin it started on,
and Authentik only accepts a callback it was registered with — so every origin
the portal answers on is listed in `ONTRAK_PORTAL__OIDC_REDIRECT_URI`. The range
answers on three names (`scripts/cerulean-provision.py` creates them):

```
https://ontrak.innotel.us/oidc/callback
https://student.ontrak.innotel.us/oidc/callback
https://admin.ontrak.innotel.us/oidc/callback
```

A name whose callback is missing cannot sign in at all — the IdP refuses the
redirect before anyone types a password. A `Host` header naming an origin that is
*not* on the list falls back to the first entry, so a forged one cannot create a
new callback.

**Roles come from Authentik groups**, read on every sign-in: a member of
`ONTRAK_PORTAL__OIDC_INSTRUCTOR_GROUP` is an instructor (the class view, reset and
the admin panel), everyone else who signs in is a student. Adding someone to the
group grants that view and removing them takes it away, with no local edit and no
second place to keep in step. An Authentik superuser is always an instructor, so
the range's owner is never locked out of it. Set
`ONTRAK_PORTAL__OIDC_REQUIRED_GROUP` to gate the whole range to one class cohort.

The portal's account is keyed on the Authentik **email address**. An account
Authentik authenticates but has no email for is refused rather than given an
invented name; the fix belongs in Authentik.### How the two doors relate

* An SSO account carries **no password**: it appears on the range the first time
  its owner signs in through Authentik, keyed on their email address, and the
  local password form can never open it. Only a local account signs in with one.
* Because Authentik is re-read on every sign-in, adding someone to the instructor
  group grants the class view and removing them takes it away, with nothing to
  keep in step locally.
* The admin panel will not switch SSO **on** while the four values are missing,
  and will not switch it **off** while no local account exists — so flipping it can
  neither leave a dead button nor a range nobody can enter.
* With SSO on *and* a local account present, the login page offers both; that
  local account is the operator's break-glass for a provider that has stopped
  answering.
* A range *provisioned* for Authentik whose switch is off and which has no local
  account shows a "no way in" page naming the two variables that end it. It does
  **not** open the `/setup` page — an account-creation page on a range that has an
  operator is a way in for whoever finds it first.

Two consequences worth knowing. A *disabled* account stays disabled: an
instructor taking a student off the board is not undone by that student signing
in again. And **deleting** an SSO account in the admin panel only removes the
local row — identity is Authentik's, so the person can sign straight back in.
Revoke the person in Authentik; use disable for the range's own control. A local
account is the reverse: deleting it removes the credential, so that person cannot
sign in at all.

## Security and audit notes

* **Isolation boundary:** the `ontrak0` bridge. Never put the portal, Guacamole or
  the SQLite file on it, and do not bridge it to the office LAN. Student VMs are
  hostile-by-design (they run simulated malware).
* **Recording:** set `guac.recording: true` to keep an RDP recording per session
  for review. Recordings live on the guacd volume and can be large; treat them as
  student data and prune them.
* **Events:** every allocate/ready/check/reset/recycle is written to the `events`
  table with the session id, which is enough to reconstruct who did what, when.
* **Instructor actions are not yet separately audited** (an instructor reset looks
  like a student reset in the event log) — add the actor to `log_event` before this
  runs in an environment with multiple instructors.
* **Guacamole holds no credentials.** If you enable `guac.recording`, remember the
  recordings contain whatever was on the student's screen.

## Cost and licensing

* **Windows:** the golden-image path uses Microsoft *evaluation* media
  (90 days for Windows 11 Enterprise eval, 180 for Server). Rebuild before a course,
  or use volume licensing with KMS/AD for permanent infrastructure. Licence
  compliance for training VMs is the operator's responsibility.
* **Hosts:** nothing in this stack needs a commercial hypervisor; Linux + KVM +
  Incus covers it. The Zabbly repository is the upstream Incus channel.
* **Third-party build tool:** `antifob/incus-windows` automates the unattended
  Windows install. Pin a commit (`ONTRAK_INCUS_WINDOWS_REF`) — it is a build-time
  dependency, not a runtime one, and its interface changes between versions. Two of
  its behaviours have bitten this stack and are worked around in
  `infra/build-golden-image.sh`: it sizes its build VM at the whole host (rewritten
  to `ONTRAK_GOLDEN_CPUS`/`ONTRAK_GOLDEN_MEMORY`), it grows the build disk to 60 GiB
  (rewritten to `ONTRAK_GOLDEN_DISK`, because that disk becomes the published image),
  and its `tools/click.py` treats any stop as a finished install, so a killed build
  publishes silently — see the golden-image rows above.

## Legacy platform notes

The catalog carries platforms that predate VirtIO, ACPI assumptions and remote management.
Three things to know before offering them:

- **They need their own device profile.** `legacy-9x` guests (95/98/ME) get an IDE disk, an
  rtl8139 NIC, a Pentium-class chipset and a 512 MiB ceiling; giving them VirtIO produces a
  guest that never boots. The profile is applied from the catalog entry, not by hand.
- **They cannot be graded automatically.** There is no WMI, no PowerShell and no agent, so
  those entries are `automation: none`. Scenarios on them are instructor-observed. OnTrak
  will provision them; it will not pretend to grade them.
- **Some media never automates.** Entries with `recipe: manual` have no unattended install,
  so `ontrak image build` refuses and tells the operator to build the guest by hand and
  publish it (`--publish-only`). Budget an evening per platform, once.

## Known limitations

1. **The Windows guest, Incus, ZFS and Guacamole paths are unverified here.** The
   Python control plane is unit-tested by the whole suite, none of which needs Windows;
   `infra/` and the `.ps1` scenarios are reviewed but must be proven on your hardware.
   Run `ontrak doctor`, build one template, and walk one scenario end to end before
   committing a class to it.
2. **The portal is single-node and SQLite-backed.** Fine to roughly 100
   simultaneous students on one control node; beyond that, move to Postgres and a
   second portal replica.
3. **No scheduled class windows.** Prewarming is manual (a cron entry calling
   `ontrak pool prewarm`, or `ontrak schedule tick`, is the obvious next step).
   Expiry and idle recycling are *not* manual — the portal does those itself
   (`session.maintenance_enabled`); only pool depth is left to an operator.
4. **Instructor audit trail** does not record *which* instructor acted (see above).
5. **Scenario realism is bounded by the image.** New Windows builds move things
   (VBScript deprecation, Defender tamper protection); the fallbacks are in place
   but re-verify after each image refresh.
