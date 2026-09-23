# Roadmap

This is a working document: what is verified, what is built but unproven, and what is
planned. Anything in the last two sections is a statement of intent, not a feature.

## Verified in this repository

- Python control plane: catalog, scenarios, sessions, scoring, selection, scheduler,
  generator, portal (student and admin), CLI — `pytest` (565 tests) and `ruff` clean. Only two
  tests skip themselves, and both switch on from the environment rather than from a device:
  the Guacamole interop test (`ONTRAK_GUAC_INTEROP_URL`) and the real-range walk
  (`ONTRAK_E2E`, below).
- Scenario and catalog validation, including the grading contract (a check script that
  cannot report an objective fails validation rather than scoring zero forever).
- Scenario generation from fault primitives: every generated scenario is validated before
  it is accepted, and CI generates the full matrix on every push.
- Guacamole's JSON-auth payload format, cross-checked against the `openssl` CLI (an
  independent implementation of HMAC-prepend → AES-128-CBC → PKCS#7 with a zero IV).
- Guest PowerShell: every `scenarios/**/*.ps1` and `infra/**/*.ps1` is parsed by `pwsh` in CI;
  the Linux and identity scenarios are run end to end against the real `chmod`, `chown`,
  `useradd`, `groupadd` and `sudo` tooling in a mount namespace, setup and check scripts both.
- The repository's own tooling, held to the same bar as the platform: `scripts/tests` runs in
  CI and covers the secret scanner, the Cerulean provisioner's certificate and DNS planning,
  and the grade sweep's reading half — the part that decides whether a run means `ok`,
  `BROKEN` or `repaired`, where a false *ok* and a false *BROKEN* are both silent.
- Per-workload (scenario × platform) template matrices: the same fault on Windows 11 and on
  Ubuntu are two templates, and the pool, status views and automatic assignment follow them.
- The in-house ticket system: rubric-marked write-ups (length, required terms, classification)
  blended with the machine grade at submission, with the rubric kept satisfiable by tests.
- The instructor admin panel: overview, accounts, sign-in, scenarios, platforms, tickets,
  sessions, schedule, results, audit — role-gated, and rendering when the hypervisor is
  unreachable.
- The container stack: the portal image builds and validates a checkout with no hypervisor,
  every compose file renders, and the gateway's contract holds in all three: one published
  port, held by the gateway. The TLS overlay is rendered as one of them, which is what proves
  the port swap to 8443 did not leave a plain listener beside it — the unencrypted door that
  overlay exists to close.
- The doors into a range, checked against the running container rather than the source:
  a fresh range offers first-run setup at `/setup` and no identity provider, a range seeded
  from `ONTRAK_PORTAL__ADMIN_USERNAME`/`ONTRAK_PORTAL__ADMIN_PASSWORD` opens with that
  password and no setup page, and a range with SSO switched on offers Authentik, renders no
  password form, and refuses a password on an account that has none.
- The one-command install, both halves of it. `docker compose up` on a machine with no
  `.env` and no Incus writes the secrets, publishes the shared portal/console key, and brings
  both services up healthy — the login page offering first-run setup, which creates the first
  instructor, because the default door is a local account and SSO is optional (docs/operations.md)
  — and a payload the portal signed accepted by the live gateway as a connection the student
  can open. The host half runs `infra/bootstrap-host.sh` inside the host's own
  namespaces, and that script was exercised end to end against a real Incus daemon: the
  upstream package install, the daemon, the storage pool, the lab bridge, the project and
  the limits profile — run twice, to prove a re-run changes nothing. What the dev host here
  cannot do is offer `/dev/kvm`, so what it does instead is stop at the KVM check and say
  why; booting a real Windows VM is still a lab-host job (below).
  `scripts/check-first-run-contract.py` checks the arrangement in CI, because a first run
  that silently half-works is the expensive kind of broken, and CI now runs ShellCheck at
  warning severity over every shell file — the first-run setup runs as root on someone
  else's machine before anything else does.
- The nightly range walk, as a workflow: it is scheduled, only a self-hosted runner labelled
  `incus` takes it, it switches the walk's test on with `ONTRAK_E2E`, and it fails instead of
  reporting green when the walk skips itself — all four pinned by `tests/test_workflows.py`,
  which runs in CI. It then opens every Linux console (`ontrak console verify --linux
  --workloads`) over the same stack and fails if one does not open, because the walk is blind
  to the console: the gateway, the webapp and guacd can each be down while every assertion
  above passes. That sweep is held to the walk's own rule — opening nothing is not a pass —
  and those two properties are pinned there too. Last it opens one scenario's console in a
  real browser (`ontrak console browser`), which is the one layer the wire sweep cannot see:
  the session page, the portal's bootstrap frame that clears Guacamole's stored token, and a
  keystroke. A skipped pytest is a green pytest, so the one thing this job must never
  do is skip its way to a passing nightly. What the walk proves is a statement about the
  range it runs against, which is exactly why the job lives on the range and not on a
  hosted runner: it is the layer no double here can stand in for.
- The console's wire contract, both halves of it. Offline: the tunnel URL and the
  `guacamole` subprotocol a browser builds, the instruction parser, and a verdict for every
  way a tunnel fails — the two worth naming are a gateway that does not negotiate the
  subprotocol (browsers then fall back to the slower HTTP tunnel, so it warns rather than
  fails) and a webapp with no guacd behind it, which on a real range is a WebSocket that
  upgrades and then says *nothing at all*, because the webapp sends the tunnel's UUID only
  once it has guacd to talk to. On the range: `ontrak console verify --linux` opened every
  Linux console — 14 of 14 `(scenario, workload)` pairs — through the real gateway, webapp
  and guacd, over the TLS listener, each painting its terminal; guacd's own typescript for
  one of them reads back the shell prompt, the typed command and its output. A Windows
  scenario's template was rebuilt from the golden image on the same host and its RDP console
  opened onto a painted desktop — guacd signing in as the training user, `img`/`blob` tiles,
  `rect`, `cfill`, no error, and guacd's own log showing the RDP client join. Two things
  only the real stack taught, both now in the check: guacd sends `cursor`, `mouse` and
  `sync` and only *then* its `error` when the login or the guest is bad, so the check waits
  for a paint or a failure rather than answering at the first instruction; and it aborts a
  client it has not heard from for fifteen seconds (status 776, "Aborted. See logs."), so
  the check sends the browser's own five-second `nop` — without it, a console that paints
  slowly was reported as a console that is broken. That is the protocol and the stack, not
  the browser: nothing *there* clicks inside an iframe. A third thing the real stack taught,
  from the sweep that walks both Linux workloads: one upgrade in 28 was never answered at
  all — the gateway logged no request for it — and the same check passed when it was asked
  again, so a handshake that gets no HTTP response at all is retried once, and the retry
  stays in the sentence rather than being smoothed over.
- The student's console page, in a real browser (`ontrak console browser`, and a step of the
  nightly). It signs in to the portal, starts each named scenario *through* the portal, opens
  the session page in Chromium, waits for the console frame, and asks the console for a
  keystroke it has to answer — `echo BROWSER_OK` into a terminal, the Windows key on a
  desktop — into a machine it started itself, never a student's. On the range: signed in,
  session started, the frame painted 4 canvases, and `echo BROWSER_OK` changed the screen, on
  a Linux scenario; a Windows scenario's desktop painted as well, while the key press that
  now *proves* a desktop is unmeasured until a nightly runs it (below). It is portal-driven
  rather than another `console verify` mode because a container stack keeps the portal's
  accounts and sessions in its own volume: a host-side allocation is a machine the portal has
  never heard of, and its page answers 404. What it needs is an account that can open a
  session — the range's admin by default, or one kept for the check — and what it does *not*
  do is prove the same thing for all 14 consoles: it is one machine per scenario named, which
  is why the wire sweep is the one that scales. And it checks a *page*: pixels. The terminal's
  text is in pixels, so "the prompt is really there" is still read from guacd's own typescript
  by the sweep above rather than from this frame.

## Built, but not proven on real hardware

These paths are reviewed and tested only up to the Incus boundary; they need a lab host:

- Unattended Windows image builds (the `incus-windows` and `answer-file` builders) and the
  golden-image pipeline.
- WinRM and Incus-agent guest transports against real Windows guests.
- Windows **Server** and Office template builds — their images, fault injection and
  consoles. The Windows 11 half is exercised on the lab range (a template rebuilt from the
  golden image, its fault injected and verified, all seven Windows consoles opened), but
  Server and Office need a host of their own to prove.
- The product builds (the `product-on-base` recipe): Exchange Server, SQL Server,
  SharePoint and Microsoft 365 Apps installed *inside* a guest made from the base image by
  `infra/windows/apply-product-install.py` and the scripts under
  `infra/windows/products/`, then published as an image. What is proven here is the shape
  — the catalog validates the recipe and the script it names, `ontrak image build`
  dispatches it, and the reboot-and-resume contract is tested up to the Incus boundary —
  and what is not is the install itself: no product media has met a real guest, so the
  unattended steps in those scripts are read against Microsoft's documentation and not yet
  against a setup log.
- The Windows half of the browser console check. `ontrak console browser` asks a desktop for
  the Windows key and requires the screen to change, because that is the only proof a GUI can
  give that the student's keyboard reaches it — a canvas that paints and takes no keystroke is
  a console a student cannot use. A Linux terminal has been through a range answering exactly
  this way; a Windows desktop has only been seen to paint, so whether the key survives
  Chromium, the client, guacd and RDP intact is measured by the nightly and not yet by a
  person. (The nightly names both consoles and fails if either does not open.)
- The browser's clipboard: no check here copies to a real clipboard, so paste-through is the
  one interactive path nothing in this repository exercises.
- ZFS/btrfs clone performance at class scale (the capacity model in
  [operations.md](operations.md) is arithmetic, not a benchmark).

The first-class fix is the same for all of them: `make check`, build one template, walk one
scenario end to end, then size the pool.

## Next

1. **Microsoft products beyond Office.** The build recipes are written — Exchange Server,
   SQL Server, SharePoint and Microsoft 365 Apps are `product-on-base` entries whose
   install runs inside the guest (above) — so what each needs now is a lab host to prove
   the install against licensed media, and then the fault scenarios its tickets call for.
2. **Cloud identity beyond the simulation.** The identity family runs against a simulated
   directory service. Entra ID / Microsoft 365 sign-in failures, MFA resets and
   conditional-access tickets are a large share of real service-desk volume; they need a
   tenant sandbox rather than a simulation before they can be graded honestly.
3. **Recording and review.** `guac.recording` is wired but unused. Turning it on for
   security scenarios, with an instructor-only playback view, is the obvious assessment
   upgrade (and needs a storage-retention decision, which belongs to ONYX).
4. **Role-based portals.** One instructor role today; cohorts (teacher, TA, marker) and
   per-cohort scenario sets are a small addition to the account model.
5. **Metrics.** Session latency, pool depth over time and pass rates per objective, exported
   for the operator. Deliberately last: it is easy to add and hard to remove.
6. **Scenario packs.** Versioned, signed bundles so a course can pin its scenario set and
   ship it to another range without copying the whole repository.
7. **Publish the image.** The Dockerfile is unbuilt-on-push today: the CI job builds it, but
   nothing pushes it to a registry. A tagged `ghcr.io/innotelinc/ontrak` would make a range
   host a `docker pull` instead of a build (and needs the registry credentials decision).

## Out of scope

- **Windows in a container.** Containers share the Linux kernel; Windows guests are VMs.
  This is not a limitation to be worked around, it is how the platforms differ.
- **Redistributing Windows or Office media.** The repository ships manifests. Operators
  supply licensed media; CI fails the build if an ISO is ever committed.
- **A general-purpose hypervisor UI.** Incus already has one. OnTrak manages the lab, not
  the hypervisor.
- **Progress tracking and gradebooks.** Results-only is a deliberate policy: the grade
  submitted at Complete & End is what OnTrak stores, and the institution's system of record
  stays the system of record.
- **Grading by observing the student's actions.** Grading reads machine state so any correct
  fix passes and the privacy of the student's session stays out of it.
