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

### 2.1 — Approval workflows `[x]`

**Goal:** an approval that is a decision with a shape, not a click.

- `[x]` **A maintenance calendar, on top of the freeze.** `Policy.maintenance_windows`
  is a list of named windows — `{name, start, end, weekdays, start_hour, end_hour}`
  — and a configured calendar is an **allow-list**: a moment outside every window
  is outside the calendar. The freeze says "these weeks we do not patch"; the
  calendar says "these are the windows we do", and both outrank `auto`, because a
  mode may only do what the operator said it may (the freeze and the calendar are
  both checked in `Policy.action_for`). Dates are optional, so one entry can be a
  weekly patch night and another a one-off month-end; weekdays are Monday=0, the
  way `datetime.weekday()` numbers them; a window that wraps midnight is the
  normal case. `validate()` refuses a half-written or backwards date range, a
  weekday outside 0-6, an hour outside 0-23 and an equal start/end hour (write 0
  and 23 for a whole day) — all in one pass, because the settings form is one
  submit. An entry this code cannot read **covers nothing** rather than everything,
  which is the fail-closed direction: a typo must not authorise a 3am apply.
- `[x]` **An approval is a record, not a status word.** `findings` carries
  `approved_by`, `approved_at`, `approval_expires_at` and `approval_reason` (additive
  columns, so the deployed database migrates rather than resets). Approving records
  the actor, stamps an expiry from `Policy.approval_ttl_hours` (0 = never, the
  shipped default) and the reason the caller supplied. The expiry is fixed **when
  the decision is made**, so changing the policy later cannot move a deadline
  somebody is planning around. `pending` and `skipped` clear the record — neither
  is a decision any more — and a **moved candidate clears it too**: an approval was
  for the version that was approved, and carrying it across would let a decision
  about 1.1 install 1.2. A failed apply keeps it, because a retry is the same
  decision.
- `[x]` **One rule answers "is this approval live?"** `approvals.py` is pure:
  a named approver, an unexpired deadline, and a reason where
  `Policy.require_approval_reason` asks for one. An approval with no approver is
  refused by name (a row approved before this existed, or by a script that passed
  no actor, must be re-approved — inventing an approver from the event log would be
  worse); an unreadable expiry is a refusal rather than an eternity. `apply_refusal`
  asks the calendar and every row's approval in one answer, calendar first, because
  "14:00 is outside the calendar" tells an operator what to change where "7 findings
  are not ready" would send them to the wrong place. `/api/apply` refuses `409` with
  that sentence and audits `apply.refused`; the one-click approve-and-apply path is
  refused by the **calendar** but not by the approval, because its click *is* the
  decision — and a second button must not be a way around a window. A pending row
  named in a manual apply is refused as "is pending, so there is no approval to act
  on" rather than quietly installed by `apply_findings`' `status IN ('approved',
  'pending')` filter. The scheduler's `auto` path is deliberately untouched: an
  unattended apply is the policy's decision, not a person's, and it is the calendar
  that bounds it.
- `[x]` **Exit:** an apply outside its window or without a live approval is refused
  with the reason, pinned by `tests/test_approvals.py` (the pure rule: no approver,
  expired, unreadable expiry, missing reason, live, the calendar first, the row cap)
  and `tests/test_api_approve.py` (through the real routes: the recorded actor and
  reason, the TTL stamp, an anonymous approval refused, an expired one refused with
  its deadline, a live one applying, a pending row refused, the calendar refusing
  both the manual and the one-click path). `tests/test_policy.py` pins the calendar
  itself (allow-list, wrap, one-off ranges, fail-closed entries, auto/ freeze
  ordering) and `tests/test_db.py` pins the columns and the clearing rules.
- `[x]` **The console draws the calendar.** The settings page now edits the
  maintenance calendar itself: one row per named window, with Mon–Sun checkboxes
  numbered `0`–`6` the way `datetime.weekday()` numbers them, an hour span that may
  wrap midnight, and an optional pair of dates for a one-off window. The approval
  block beside it edits `approval_ttl_hours` (0 = never, with the sentence saying
  the expiry is stamped when the decision is made) and
  `require_approval_reason`, and the page's review pane reports the window count and
  whether approvals lapse. All three fields go through the same `PUT /api/settings`,
  and an **empty list is sent as `[]`** so clearing the calendar actually clears it
  — an omitted field means "leave alone" on this API. The page checks only the
  four shapes a half-typed row makes (no name, no weekday, one date without the
  other, equal start and end hour) and then lets the backend's `validate()` remain
  the authority, which is the same division the cron preview already uses; a refusal
  prints its problems in the page's existing "Not saved" box. The Findings page
  already carries the reason field; the dashboard's quick-approve buttons still
  record none, which is exactly why `require_approval_reason` is a deployment's
  choice rather than a default. With this form the intent behind 2.1 is reachable
  by the person who has to make the decision: the rule, the routes and the console
  all ship, so an apply outside its window or without a live approval is refused
  with the reason, and the calendar, the TTL and the reason requirement are set
  from the page rather than from curl.

### 2.2 — Safe apply `[x]`

**Goal:** a bad update stops at one host.

- `[x]` **Canary then wave for package upgrades.** `waves.plan()` is the order an
  apply touches machines in, and it is a value rather than a loop: the first
  `Policy.apply_canary_targets` targets (default 1) are applied alone, then slices
  of `Policy.apply_wave_size` (default 5). The order is the one the finding query
  already sorted by — the plan does not invent a second notion of "first", or the
  canary would be whichever host sorted first rather than the one an operator
  meant. `apply_findings` walks the plan and, after any wave that produced a
  failure, stops before the next wave is announced: later findings keep the status
  they had (an approval is a decision about a version, and an unacted decision is
  still valid, so a retry is the same decision), the run log names the wave and how
  many targets it did not reach, and the summary says `stopped early`. Turning
  `apply_halt_on_failure` off is how a deployment asks to see every outcome in one
  run instead — an explicit choice, not the default. Tests:
  `tests/test_waves.py` for the order and `SafeApply` in `tests/test_applier.py` for
  the loop obeying it.
- `[x]` **Rollback for an applied package set.** `db.applied_packages` writes, at the
  moment a run records an `applied` verdict, the `(run, finding, manager, package)`
  pair and the version it replaced — because `findings.current` is overwritten by the
  next scan and cannot answer "what did run 12 change?". A rollback is addressed by
  **run**, and `rollback.plan()` is the pure, all-or-nothing plan for it: apt gets one
  pinned transaction per target (`apt-get install --allow-downgrades pkg=1.0`, with
  `--only-upgrade` gone because it forbids exactly what this does), snap gets
  `snap revert` one package at a time, and every row whose previous version was not
  recorded — or whose manager has no package revert at all — refuses the *whole* run
  by name before a command runs. Images stay `undo_roll`'s job, with its own record.
  `applier.rollback_run` then executes the plan, re-reads the machine (dpkg's version,
  snap's revision) rather than trusting an exit code, marks what it restored
  `pending` with the version in the detail, leaves a package whose downgrade did not
  take `applied`, and opens a `rollback` run linked to the apply by
  `runs.rollback_of`. A run is rolled back once: the second request is refused with
  the first rollback's run id, because `rollback_of` is written before the first
  command. `POST /api/rollback {"run_id"}` sits behind `sync:apply` and the same
  run lock; the runs page has the button, with the refusal reasons shown rather than
  swallowed. Tests: `tests/test_rollback.py` (record, pinned downgrade, failed
  downgrade, missing version, docker refusal, second rollback, snap revision) and
  `RollbackThroughTheApi` in `tests/test_api_approve.py` (auth, 404, 409 refusals,
  in-flight lock, the 200 that puts 1.0 back).
- `[x]` **Blast-radius caps.** `Policy.apply_max_targets` (0 = no bound, the shipped
  default) caps a whole run as well as each wave, because a scan that found four
  hundred findings is not four hundred authorisations. Targets beyond it are left
  untouched and the run says so in one line — a cap an operator cannot see is
  indistinguishable from a bug that dropped their fleet. `validate()` refuses a
  zero wave size, a canary larger than its wave and a negative cap, all in one pass.
- `[x]` **Exit: a failed canary halts the wave and leaves every later host
  untouched.** `test_a_failed_canary_leaves_the_next_host_untouched` applies a
  failing canary on one host and asserts the second host's apt command never ran
  and its finding is still `approved`; `test_a_clean_canary_rolls_on_to_the_rest`
  is the other side of the same branch.

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
