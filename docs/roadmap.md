# Roadmap

This is a working document: what is verified, what is built but unproven, and what is
planned. Anything in the last two sections is a statement of intent, not a feature.

## Verified in this repository

- Python control plane: catalog, scenarios, sessions, scoring, selection, scheduler,
  generator, portal, CLI — `pytest` (210 tests collected, 1 skipped) and `ruff` clean.
- Scenario and catalog validation, including the grading contract (a check script that
  cannot report an objective fails validation rather than scoring zero forever).
- Scenario generation from fault primitives: every generated scenario is validated before
  it is accepted, and CI generates the full matrix on every push.
- Demo mode end to end: assign → provision → preview check → submit → destroy, against an
  in-memory hypervisor, with results-only storage asserted by tests.
- Guacamole's JSON-auth payload format, cross-checked against the `openssl` CLI (an
  independent implementation of HMAC-prepend → AES-128-CBC → PKCS#7 with a zero IV).
- Guest PowerShell: every `scenarios/**/*.ps1` and `infra/**/*.ps1` is parsed by `pwsh` in CI.

## Built, but not proven on real hardware

These paths are reviewed and tested only up to the Incus boundary; they need a lab host:

- Unattended Windows image builds (the `incus-windows` and `answer-file` builders) and the
  golden-image pipeline.
- WinRM and Incus-agent guest transports against real Windows guests.
- Windows, Server and Office template builds and their scenario fault injection.
- Guacamole deployment, console embedding and TLS in front of the gateway.
- ZFS/btrfs clone performance at class scale (the capacity model in
  [operations.md](operations.md) is arithmetic, not a benchmark).

The first-class fix is the same for all of them: `make check`, build one template, walk one
scenario end to end, then size the pool.

## Next

1. **Per-workload template matrices.** Today a scenario has one base platform (`workload:`),
   so running `net-dns-failure` on both Windows 11 and Ubuntu means two scenario variants.
   The next step is templates keyed by (scenario, workload) with the pool and status views
   following, plus a generator flag to emit the variants.
2. **Microsoft products beyond Office.** Exchange Server, SQL Server, SharePoint and
   Microsoft 365 Apps in more fidelity. The catalog shape already supports it — a product
   entry names the OS it is layered onto — but each needs a build recipe worth trusting.
3. **Cloud and identity scenarios.** Entra ID / Microsoft 365 sign-in failures, MFA resets
   and conditional-access tickets are now a large share of real service-desk volume. They
   need a simulated directory rather than a real tenant, so they belong behind a scenario
   family of their own.
4. **Instructor scheduling UI.** `schedule.windows` is configuration today; a small page
   that shows the next window, the pool plan and the drain would make it usable without
   editing YAML.
5. **Recording and review.** `guac.recording` is wired but unused. Turning it on for
   security scenarios, with an instructor-only playback view, is the obvious assessment
   upgrade (and needs a storage-retention decision, which belongs to ONYX).
6. **Role-based portals.** One instructor role today; cohorts (teacher, TA, marker) and
   per-cohort scenario sets are a small addition to the account model.
7. **Metrics.** Session latency, pool depth over time and pass rates per objective, exported
   for the operator. Deliberately last: it is easy to add and hard to remove.
8. **Scenario packs.** Versioned, signed bundles so a course can pin its scenario set and
   ship it to another range without copying the whole repository.

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
