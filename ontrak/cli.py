"""Command line interface.

Everything an instructor or operator needs, without touching Python:

    ontrak doctor                         # is this host ready?
    ontrak scenario list|show|validate
    ontrak lesson list|show|validate      # the command walkthroughs
    ontrak template build --all           # tpl-<scenario> + clean snapshot
    ontrak pool status|prewarm|refill
    ontrak session start|check|reset|console|end
    ontrak console verify --linux          # open real consoles, end to end
    ontrak console browser <scenario>      # the student's page, in a real browser
    ontrak ticket form|show|grade|complete # the in-house write-up
    ontrak reap --loop                    # pool refill + idle/expiry reaping
    ontrak user list|remove
    ontrak serve                          # the student portal, including /admin
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from . import __version__, browser, guac, selection
from .catalog import Catalog
from .config import ConfigError, load_settings, require_secrets
from .generator import GenerationError, generate, generate_matrix, primitive_matrix, suggest_combinations
from .guest import GuestError, build_driver
from .incus import IncusClient, IncusError
from .lessons import LessonError, LessonRepository
from .media import MediaError, MediaStore
from .models import Session, SessionState
from .scenarios import ScenarioError, ScenarioRepository
from .scheduler import Scheduler
from .scoring import feedback_text
from .sessions import SessionError, SessionManager
from .store import Store
from .tickets import TicketError, missing_required
from .tickets import feedback_text as ticket_feedback_text

OK, WARN, FAIL, INFO = "ok", "warn", "FAIL", "info"
_SYMBOL = {OK: "  ok  ", WARN: " warn ", FAIL: " FAIL ", INFO: " info "}


def _say(status: str, message: str) -> None:
    print(f"[{_SYMBOL[status]}] {message}")


def _table(headers: list[str], rows: list[list[str]]) -> None:
    if not rows:
        print("  (none)")
        return
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))
    line = "  ".join(h.ljust(widths[i]) for i, h in enumerate(headers))
    print("  " + line)
    print("  " + "-" * len(line))
    for row in rows:
        print("  " + "  ".join(str(c).ljust(widths[i]) for i, c in enumerate(row)))


class Context:
    """Lazily-wired runtime objects, so `doctor` still works on a bare host."""

    def __init__(self, config_path: str | None = None, driver_override: str | None = None):
        self.settings = load_settings(config_path)
        if driver_override:
            self.settings.guest.driver = driver_override
        self.settings.ensure_dirs()
        self._store: Store | None = None
        self._repo: ScenarioRepository | None = None
        self._incus: IncusClient | None = None
        self._manager: SessionManager | None = None
        self._catalog: Catalog | None = None
        self._media: MediaStore | None = None
        self._lessons: LessonRepository | None = None

    @property
    def store(self) -> Store:
        if self._store is None:
            self._store = Store(self.settings.db_path)
        return self._store

    @property
    def repo(self) -> ScenarioRepository:
        if self._repo is None:
            self._repo = ScenarioRepository(self.settings.scenarios_dir)
        return self._repo

    @property
    def catalog(self) -> Catalog:
        if self._catalog is None:
            self._catalog = Catalog(self.settings.catalog_dir)
        return self._catalog

    @property
    def media(self) -> MediaStore:
        if self._media is None:
            self._media = MediaStore(self.settings.media_dir, self.catalog)
        return self._media

    @property
    def lessons(self) -> LessonRepository:
        if self._lessons is None:
            self._lessons = LessonRepository(self.settings.lessons_dir)
        return self._lessons

    @property
    def incus(self) -> IncusClient:
        if self._incus is None:
            self._incus = IncusClient(self.settings)
        return self._incus

    @property
    def manager(self) -> SessionManager:
        if self._manager is None:
            self._manager = SessionManager(
                self.settings,
                self.store,
                repo=self.repo,
                incus=self.incus,
                driver=build_driver(self.settings),
                catalog=self.catalog,
            )
        return self._manager


# ---------------------------------------------------------------------------
# doctor
# ---------------------------------------------------------------------------
def cmd_doctor(args) -> int:
    ctx = Context(args.config)
    settings = ctx.settings
    failures = 0

    print(f"OnTrak {__version__} — host readiness")
    print(f"  config: {', '.join(settings.source_files) or 'built-in defaults'}")
    print()

    print("Control plane")
    _say(INFO, f"python {sys.version.split()[0]}")
    for module, purpose in (
        ("yaml", "scenario manifests"),
        ("cryptography", "Guacamole link signing"),
        ("websockets", "the console tunnel check"),
        ("fastapi", "student portal"),
        ("winrm", "guest automation over WinRM"),
    ):
        try:
            __import__(module)
            _say(OK, f"python module {module} ({purpose})")
        except ImportError:
            _say(WARN, f"python module {module} missing ({purpose}) — pip install -r requirements.txt")

    print()
    print("Secrets")
    problems = require_secrets(settings)
    if problems:
        for problem in problems:
            _say(FAIL, problem)
            failures += 1
    else:
        _say(OK, "guest password, portal secret and Guacamole key are set")
    if settings.guest.driver == "winrm" and not settings.guest.password:
        failures += 1

    print()
    print("Incus")
    client = ctx.incus
    if not IncusClient.available():
        _say(FAIL, "the `incus` binary is not on PATH — run infra/bootstrap-host.sh")
        failures += 1
    else:
        _say(OK, "incus binary found")
        info = client.server_info()
        server = (info.get("environment") or {}).get("server_version", "unknown")
        _say(OK, f"incus server {server} (remote: {settings.incus.remote})")

        # Every read here is guarded: a daemon that is not running is a doctor finding,
        # not the end of the report. Unguarded, the first IncusError aborted the whole
        # run mid-section — so a host with a stopped daemon never reached the console,
        # scenario or capacity checks, which are exactly the ones an operator on a
        # half-built host needs to see.
        try:
            pools = client.run_json(["storage", "list", "--format=json"], timeout=30) if client else []
        except IncusError as exc:
            _say(FAIL, f"could not list storage pools: {exc}")
            failures += 1
            pools = []
        names = [p.get("name") for p in (pools or [])]
        if settings.incus.storage_pool in names:
            driver = next(
                (p.get("driver") for p in pools if p.get("name") == settings.incus.storage_pool), "?"
            )
            if driver in {"zfs", "btrfs", "lvm", "ceph"}:
                _say(OK, f"storage pool {settings.incus.storage_pool!r} uses {driver} (fast snapshots)")
            else:
                _say(
                    WARN,
                    f"storage pool {settings.incus.storage_pool!r} uses {driver}: clones will be full "
                    "copies, so provisioning and reset get slow at class scale",
                )
        else:
            _say(FAIL, f"storage pool {settings.incus.storage_pool!r} not found (have: {', '.join(names) or 'none'})")
            failures += 1

        try:
            listed = client.run_json(["network", "list", "--format=json"], timeout=30) or []
        except IncusError as exc:
            _say(FAIL, f"could not list networks: {exc}")
            failures += 1
            listed = []
        networks = [n.get("name") for n in listed]
        if settings.incus.network in networks:
            _say(OK, f"network {settings.incus.network!r} exists")
        else:
            _say(FAIL, f"network {settings.incus.network!r} not found (have: {', '.join(networks) or 'none'})")
            failures += 1

        try:
            profiles = [p.get("name") for p in (client.run_json(["profile", "list", "--format=json"], timeout=30) or [])]
            if settings.incus.profile in profiles:
                _say(OK, f"profile {settings.incus.profile!r} exists")
            else:
                _say(WARN, f"profile {settings.incus.profile!r} missing — VMs get default limits only")
        except IncusError as exc:
            _say(WARN, f"could not list profiles: {exc}")

    print()
    print("Images and templates")
    if IncusClient.available():
        if client.image_exists(settings.incus.image_alias):
            _say(OK, f"golden image {settings.incus.image_alias!r} present")
        else:
            _say(FAIL, f"golden image {settings.incus.image_alias!r} missing — run infra/build-golden-image.sh")
            failures += 1
        rows = []
        try:
            template_rows = ctx.manager.template_status() if ctx.incus else []
        except IncusError as exc:
            # Same rule as the pool and network reads above: a daemon that is down is
            # one finding, not the end of the report.
            _say(FAIL, f"could not read templates: {exc}")
            failures += 1
            template_rows = []
        for row in template_rows:
            status = "ready" if row["ready"] else ("no clean snapshot" if row["exists"] else "missing")
            if not row["ready"]:
                _say(WARN, f"template {row['name']} ({status}) — run `ontrak template build {row['scenario_id']}`")
            rows.append([row["scenario_id"], row["name"], status])
        if rows:
            print()
            _table(["scenario", "template", "state"], rows)

    print()
    print("Scenario catalogue")
    problems = ctx.repo.validate()
    if problems:
        for problem in problems:
            _say(FAIL, problem)
            failures += 1
    else:
        _say(OK, f"{len(ctx.repo.list())} scenario(s) valid")

    print()
    print("Guest transport")
    _say(
        INFO,
        f"driver={settings.guest.driver} user={settings.guest.user} "
        f"winrm_port={settings.guest.winrm_port} rdp_port={settings.guest.rdp_port}",
    )
    if settings.guest.driver == "incus-exec":
        _say(INFO, "incus-exec needs virtio-vsock + the Incus-Agent service set to Automatic")
    if settings.guest.driver == "winrm":
        try:
            import winrm  # noqa: F401

            _say(OK, "pywinrm importable")
        except ImportError:
            _say(FAIL, "guest.driver=winrm but pywinrm is not installed")
            failures += 1

    print()
    print("Console gateway")
    # Three checks, in the order a browser meets them, and each of them for a failure the
    # others cannot see. The first catches the silent one: the portal signs every console
    # link and a gateway with a different key refuses all of them while both sides look
    # healthy. The second follows the signed link the rest of the way — token, then the
    # connection list the browser reads — because a gateway can accept our key and still
    # not register the connection. The third opens the console's own WebSocket, which is
    # the only one that notices a webapp with no guacd behind it. All three look identical
    # from the student's side (an empty console), so all three are asked.
    for probe in (guac.probe_gateway, guac.probe_console, guac.probe_tunnel):
        state, detail = probe(settings)
        if state == "ok":
            _say(OK, detail)
            continue
        if state == "refused":
            _say(FAIL, detail)
            failures += 1
        elif state == "skipped":
            _say(INFO, detail)
        else:
            # `unreachable` (which this section treats as a warning: split-horizon DNS and
            # a console pinned to a name this host cannot resolve are both normal) and
            # `degraded` (the console works, over the slower HTTP tunnel).
            _say(WARN, detail)
        # Whatever went wrong here is upstream of the next request, so stop rather than
        # report on a request that was never made.
        break
    # A console pinned to an absolute URL is a deliberate choice behind a TLS edge and
    # a trap on a LAN range reached by IP. The portal cannot detect this per request
    # (there is no request here), so the note is what stands in for the guard.
    note = guac.pinned_base_url_note(settings)
    if note:
        _say(WARN, note)

    print()
    print("Capacity")
    try:
        meminfo = Path("/proc/meminfo").read_text()
        total_kb = int(
            [line for line in meminfo.splitlines() if line.startswith("MemTotal")][0].split()[1]
        )
        total_gb = total_kb / 1024 / 1024
        cpus = os.cpu_count() or 0
        _say(INFO, f"host has {cpus} vCPU and {total_gb:.0f} GiB RAM")
        per_vm = 4
        headroom = 0.8
        _say(
            INFO,
            f"rough ceiling with 4 GiB VMs at {int(headroom * 100)}% RAM use: "
            f"{int(total_gb * headroom / per_vm)} concurrent students "
            "(see docs/operations.md for the real arithmetic)",
        )
    except Exception:
        _say(WARN, "could not read host memory")

    print()
    if failures:
        _say(FAIL, f"{failures} blocking problem(s) found")
        return 1
    _say(OK, "no blocking problems found")
    return 0


# ---------------------------------------------------------------------------
# scenarios
# ---------------------------------------------------------------------------
def cmd_scenario(args) -> int:
    ctx = Context(args.config)
    if args.action == "list":
        rows = [
            [
                s.id,
                s.category,
                str(s.difficulty),
                f"{s.minutes}m",
                str(len(s.objectives)),
                ", ".join(s.title for s in [s])[:60],
            ]
            for s in ctx.repo.list()
        ]
        _table(["id", "category", "diff", "time", "objs", "title"], rows)
        return 0
    if args.action == "show":
        scenario = ctx.repo.get(args.scenario)
        print(f"{scenario.title}  ({scenario.id})")
        print(f"  category: {scenario.category_label}   difficulty: {scenario.difficulty}/4   time: {scenario.minutes}m")
        print(f"  pass mark: {scenario.pass_score:.0f}%   objectives: {len(scenario.objectives)}   hints: {len(scenario.hints)}")
        if scenario.instance_devices:
            print(f"  extra devices: {', '.join(d.get('name', '?') for d in scenario.instance_devices)}")
        print("\nTicket:\n" + "\n".join("  " + line for line in scenario.briefing.splitlines()))
        print("\nObjectives:")
        for objective in scenario.objectives:
            flag = "critical" if objective.critical else "        "
            print(f"  [{objective.weight:>5.0f}] {flag}  {objective.id}: {objective.text}")
        if scenario.hints:
            print("\nHints (revealed progressively to students):")
            for i, hint in enumerate(scenario.hints, 1):
                print(f"  {i}. {hint}")
        return 0
    if args.action == "validate":
        problems = ctx.repo.validate(catalog=ctx.catalog, lessons=ctx.lessons)
        lesson_problems = ctx.lessons.validate()
        for problem in [*problems, *lesson_problems]:
            _say(FAIL, problem)
        if problems or lesson_problems:
            return 1
        _say(OK, f"{len(ctx.repo.list())} scenario(s) and {len(ctx.lessons.list())} lesson(s) valid")
        return 0
    return 2


# ---------------------------------------------------------------------------
# templates / pool
# ---------------------------------------------------------------------------
def cmd_template(args) -> int:
    ctx = Context(args.config)
    ids = None if args.all else (args.scenarios or None)
    if not ids and not args.all:
        print("specify scenario ids or --all", file=sys.stderr)
        return 2
    results = ctx.manager.build_templates(ids, force=args.force)
    failures = 0
    for scenario_id, status in results.items():
        if status == "ready":
            _say(OK, f"{scenario_id}: {status}")
        else:
            _say(FAIL, f"{scenario_id}: {status}")
            failures += 1
    return 1 if failures else 0


def cmd_pool(args) -> int:
    ctx = Context(args.config)
    if args.action == "status":
        rows = []
        for status in ctx.manager.pool_status():
            rows.append(
                [
                    status.scenario_id,
                    str(status.target),
                    str(status.ready),
                    str(status.claimed),
                    str(status.total),
                    "yes" if status.template_ready else "NO",
                    str(status.deficit),
                ]
            )
        _table(["scenario", "target", "ready", "claimed", "total", "template", "deficit"], rows)
        return 0
    if args.action == "prewarm":
        created = ctx.manager.prewarm(args.scenario, args.count, args.workload)
        label = f"{args.scenario}@{args.workload}" if args.workload else args.scenario
        _say(OK, f"created {created} pre-booted VM(s) for {label}")
        # "created 0" is not an answer on its own: it is what a missing template,
        # an unreachable hypervisor and a full pool all look like from here.
        if not created and ctx.manager.last_prewarm_error:
            _say(FAIL, ctx.manager.last_prewarm_error)
            return 1
        return 0
    if args.action == "refill":
        created = ctx.manager.refill_pool()
        if created:
            for scenario_id, count in created.items():
                _say(OK, f"{scenario_id}: created {count}")
        else:
            _say(INFO, "nothing to do (pools at target, or pool targets are 0)")
        return 0
    if args.action == "drain":
        if not args.scenario:
            _say(FAIL, "--scenario is required (draining every pool at once is a class-ending action)")
            return 2
        removed = ctx.manager.drain_pool(args.scenario)
        _say(OK, f"destroyed {removed} unclaimed VM(s) for {args.scenario}")
        return 0
    return 2


# ---------------------------------------------------------------------------
# sessions
# ---------------------------------------------------------------------------
def _session_or_die(ctx: Context, args) -> Session | None:
    """Fetch a session for a CLI command (an operator may act on any of them)."""
    student = getattr(args, "student", None)
    try:
        if student:
            return ctx.manager.get_owned_session(student, args.session_id, allow_instructor=True)
        match = next((s for s in ctx.store.list_sessions() if s.id == args.session_id), None)
        if match is None:
            _say(FAIL, f"session {args.session_id} not found")
        return match
    except SessionError as exc:
        _say(FAIL, str(exc))
        return None


def cmd_session(args) -> int:
    ctx = Context(args.config)
    action = args.action

    if action == "list":
        rows = []
        for session in ctx.store.list_sessions(limit=args.limit):
            rows.append(
                [
                    str(session.id),
                    session.student,
                    session.scenario_id,
                    session.state.value,
                    session.instance or "-",
                    session.host_ip or "-",
                    f"{session.best_score:.0f}%",
                    str(session.seconds_remaining() or "-"),
                ]
            )
        _table(["id", "student", "scenario", "state", "instance", "ip", "best", "ttl(s)"], rows)
        return 0

    if action == "start":
        scenario_id = args.scenario
        workload = getattr(args, "workload", None)
        if not scenario_id:
            if not ctx.settings.selection.auto_assign:
                _say(FAIL, "--scenario is required (selection.auto_assign is off)")
                return 2
            choice = selection.choose(
                ctx.repo.list(),
                strategy=ctx.settings.selection.strategy,
                max_difficulty=ctx.settings.selection.max_difficulty,
                seed=ctx.settings.selection.seed,
            )
            scenario_id = choice.scenario.id
            _say(INFO, f"auto-assigned {scenario_id} ({choice.explain()})")
        try:
            session = ctx.manager.allocate(
                args.student,
                scenario_id,
                workload=workload,
                time_limit_minutes=getattr(args, "time_limit", None),
            )
        except ScenarioError as exc:
            _say(FAIL, str(exc))
            return 1
        if session.state == SessionState.ERROR:
            _say(FAIL, f"session {session.id} failed: {session.error}")
            return 1
        _say(
            OK,
            f"session {session.id} ready on {session.instance} ({session.host_ip}) "
            f"for {session.time_limit_minutes} minutes",
        )
        return 0

    if action == "prune":
        # Not a per-session action, so it is handled before the lookup: it tidies the
        # history rather than touching a machine. `reap` is the other half — see
        # `SessionManager.prune_sessions` for why an expired *live* row is not pruned.
        result = ctx.manager.prune_sessions(days=args.days, dry_run=args.dry_run)
        if not result["sessions"]:
            _say(OK, f"nothing to prune: no finished session older than {result['days']} day(s)")
        else:
            listed = ", ".join(str(s) for s in result["sessions"])
            if result["dry_run"]:
                _say(OK, f"would delete {len(result['sessions'])} session(s): {listed}")
            else:
                _say(OK, f"deleted {result['deleted']} session(s): {listed}")
        if result["kept"]:
            _say(
                INFO,
                f"kept {len(result['kept'])} with a submitted result or ticket: "
                f"{', '.join(str(s) for s in result['kept'])}",
            )
        if result["live"]:
            _say(
                INFO,
                f"left {len(result['live'])} live session(s) alone (`ontrak reap` ends "
                f"the expired ones): {', '.join(str(s) for s in result['live'])}",
            )
        return 0

    session = _session_or_die(ctx, args)
    if session is None:
        return 1

    if action == "show":
        print(json.dumps(session.to_dict(include_secrets=True), indent=2))
        return 0
    if action == "check":
        report = ctx.manager.run_checks(session)
        print(feedback_text(ctx.repo.get(session.scenario_id), report))
        return 0 if report.resolved else 1
    if action == "reset":
        session = ctx.manager.reset(session)
        if session.state == SessionState.ERROR:
            _say(FAIL, session.error)
            return 1
        _say(OK, f"session {session.id} reset to a clean VM ({session.instance}, {session.host_ip})")
        return 0
    if action == "extend":
        ctx.manager.extend(session, args.minutes)
        _say(OK, f"session {session.id} extended by {args.minutes} minutes")
        return 0
    if action == "limit":
        ctx.manager.set_time_limit(session, args.minutes)
        _say(OK, f"session {session.id} now has a {args.minutes} minute limit")
        return 0
    if action == "complete":
        report = ctx.manager.complete(session)
        print(feedback_text(ctx.repo.get(session.scenario_id), report))
        _say(
            OK if report.resolved else WARN,
            f"session {session.id} submitted and graded; the VM has been destroyed",
        )
        return 0 if report.resolved else 1
    if action == "end":
        ctx.manager.end(session)
        _say(OK, f"session {session.id} ended and VM destroyed")
        return 0
    if action == "console":
        if not session.state.is_usable:
            _say(FAIL, f"session is {session.state.value}; no console yet")
            return 1
        try:
            scenario = ctx.repo.get(session.scenario_id)
            print(guac.build_link(ctx.settings, session, scenario))
        except (ConfigError, guac.GuacError) as exc:
            _say(FAIL, str(exc))
            return 1
        return 0
    return 2


def cmd_reap(args) -> int:
    ctx = Context(args.config)
    interval = ctx.settings.pool.refill_interval_seconds
    while True:
        result = ctx.manager.reap()
        if result["recycled"]:
            _say(OK, f"recycled session(s): {', '.join(str(s) for s in result['recycled'])}")
        if result["refilled"]:
            for scenario_id, count in result["refilled"].items():
                _say(OK, f"prewarmed {count} for {scenario_id}")
        if not args.loop:
            return 0
        time.sleep(interval)


def _console_targets(repo, ids, *, all_scenarios: bool = False, linux_only: bool = False) -> list[str]:
    """Which scenarios a console check should open, in catalogue order.

    Named ids are taken as given (an unknown one raises, the way every other command
    treats a typo). ``--all`` and ``--linux`` both mean "the catalogue", and ``--linux``
    narrows it to the scenarios that get the SSH console — the sweep an operator wants
    before a Linux class, and the one a host that cannot hold every Windows VM can still
    afford to run.
    """
    if ids:
        scenarios = [repo.get(scenario_id) for scenario_id in ids]
    elif all_scenarios or linux_only:
        scenarios = repo.list()
    else:
        return []
    if linux_only:
        scenarios = [scenario for scenario in scenarios if scenario.is_linux]
    return [scenario.id for scenario in scenarios]


def _console_jobs(
    repo,
    ids,
    *,
    all_scenarios: bool = False,
    linux_only: bool = False,
    every_workload: bool = False,
    workload: str = "",
) -> list[tuple[str, str]]:
    """Which ``(scenario, workload)`` pairs a console check should open, in catalogue order.

    A console belongs to a *machine*, and a scenario that names more than one platform
    is more than one machine: ``linux-user-lifecycle`` has a template per platform, so a
    sweep that opens one of them has checked half the range and cannot say so. With
    ``every_workload`` each scenario is walked over the platforms it declares
    (``scenario.platform_workloads``, in the order the scenario lists them) — what the
    nightly range walk runs, and what an operator wants before a class that may land on
    either image. ``workload`` pins one instead, for a run aimed at a single image.
    A scenario that declares no platform is the site's golden image, which is the empty
    workload — the same value `ontrak template build` uses for it.
    """
    jobs: list[tuple[str, str]] = []
    for scenario_id in _console_targets(
        repo, ids, all_scenarios=all_scenarios, linux_only=linux_only
    ):
        scenario = repo.get(scenario_id)
        platforms = scenario.platform_workloads if every_workload else []
        for platform in platforms or [workload]:
            jobs.append((scenario_id, platform))
    return jobs


def _portal_origin(settings) -> str:
    """The portal's own address, when the console's address says where it is.

    `guac.base_url: auto` — the shipped default — is derived from each *browser's*
    address, so a process has no portal to talk to and must be told one. An absolute
    console URL is a path on the stack's one published port, and the portal is that
    origin's `/`, which is the whole reason the shipped gateway serves both.
    """
    base = str(settings.guac.base_url or "").strip()
    if not base or base.lower() == guac.AUTO_BASE_URL:
        return ""
    parsed = urlparse(base if "//" in base else f"//{base}")
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}/"


def cmd_console_browser(ctx, args) -> int:
    """Open one scenario's console the way a student does: in a real browser.

    `console verify` proves the stack — the gateway, the webapp and guacd — with the same
    requests a browser makes, and it cannot see the page itself: a frame that never loads,
    a bootstrap page on another origin, or a canvas no keystroke reaches. So this signs in
    to the portal, starts the scenario through it, opens the session page in Chromium and
    types into the terminal. One scenario at a time, on purpose: a sweep of these is a
    class's worth of machines, and the wire sweep is the one that scales.
    """
    settings = ctx.settings
    missing = browser.engine_missing()
    if missing:
        # Asked for by name, so an engine that is not installed is an error rather than a
        # silent pass: a check that quietly does nothing is the thing this repo keeps
        # finding and removing.
        _say(FAIL, missing)
        return 2
    portal = args.portal_url or _portal_origin(settings)
    if not portal:
        _say(
            FAIL,
            "this check drives the portal's own pages, so it needs the portal's address: "
            "pass --portal-url (https://localhost:8443/ is the TLS stack's own, and "
            "http://localhost:8080/ is what `make up-plain` publishes)",
        )
        return 2
    if len(args.scenarios) != 1:
        _say(
            FAIL,
            "name exactly one scenario: this starts a real machine and drives a real "
            "browser, so it is one console at a time (use `console verify` to sweep)",
        )
        return 2
    scenario_id = args.scenarios[0]
    try:
        ctx.repo.get(scenario_id)
    except ScenarioError as exc:
        _say(FAIL, str(exc))
        return 1
    state, detail, report = browser.verify_console_in_browser(
        settings,
        portal_url=portal,
        scenario_id=scenario_id,
        workload=args.workload or "",
        user=args.browser_user or settings.portal.admin_username,
        password=args.browser_password or settings.portal.admin_password,
        seconds=args.seconds,
        # How long a machine gets to come up before the console is called unreachable:
        # the same budget `ontrak session check` uses, since it is the same wait.
        wait_seconds=args.wait or float(settings.session.check_timeout_seconds),
        keep=args.keep,
    )
    _say(OK if state == "ok" else FAIL, f"{scenario_id}: {detail}")
    if report.frames and state != "ok":
        # Shortened: a console frame's URL carries the whole signed payload, which is noise
        # in a report whose point is which frames the browser ended up on.
        for url in report.frames[:4]:
            _say(INFO, f"  frame: {browser.console_address(url)}")
    return 0 if state == "ok" else 1


def cmd_console(args) -> int:
    """Open each target's console through the whole stack, and report what came back.

    The one question no other command answers: `session check` marks a machine,
    `session console` prints the link, and this opens it. Per target it allocates a
    session, drives the portal's own signed link through the gateway, the webapp and
    guacd — the same three requests a browser makes — and destroys the machine again
    unless ``--keep`` asks to leave it for a look. ``--workloads`` makes one target per
    platform a scenario declares, so a scenario offered on two images is *two* rows.

    A row that is not ``ok`` is a console a student would have to report; ``degraded``
    still opens, over the slower HTTP tunnel, so it is printed but does not fail the run.
    Under ``guac.base_url: auto`` — the shipped default — there is no fixed console URL for
    a process with no browser to open a tunnel on, so this asks for ``--base-url`` rather
    than inventing one that is certainly wrong somewhere.
    """
    ctx = Context(args.config)
    settings = ctx.settings
    if args.action == "browser":
        return cmd_console_browser(ctx, args)
    if args.workload and args.workloads:
        _say(
            FAIL,
            "--workload pins one platform and --workloads opens every platform the "
            "scenarios declare; pass one of them",
        )
        return 2
    if args.base_url:
        settings.guac.base_url = args.base_url
    # There is no fixed console URL under `auto`: it follows each browser's own address, and
    # this command is a process with no browser. Rather than invent one — the one address
    # that is *certainly* wrong on a remote range is this host's own — say what to pass.
    if str(settings.guac.base_url).strip().lower() == guac.AUTO_BASE_URL:
        _say(
            FAIL,
            "guac.base_url is 'auto', so the console address is derived from each browser's "
            "own and there is no fixed URL for this check to open a tunnel on. Pass "
            "--base-url: https://localhost:8443/guacamole/ is the TLS stack's console on "
            "its own host, and http://localhost:8080/guacamole/ is the one `make up` "
            "publishes (inside the stack, use the gateway's service name).",
        )
        return 2

    if args.session_id:
        session = _session_or_die(ctx, args)
        if session is None:
            return 1
        scenario = ctx.repo.get(session.scenario_id)
        state, detail, _report = guac.verify_session_console(
            settings, session, scenario, seconds=args.seconds
        )
        _say(OK if state == "ok" else FAIL, f"session {session.id}: {detail}")
        return 0 if state == "ok" else 1

    jobs = _console_jobs(
        ctx.repo,
        args.scenarios,
        all_scenarios=args.all,
        linux_only=args.linux,
        every_workload=args.workloads,
        workload=args.workload or "",
    )
    if not jobs:
        _say(
            FAIL,
            "specify scenario ids, --all or --linux (or --session-id to check a session "
            "a student is already on)",
        )
        return 2

    rows, results = [], []
    for scenario_id, workload in jobs:
        scenario = ctx.repo.get(scenario_id)
        protocol = guac.protocol_for(settings, scenario) or "none"
        # One student per *target*: `session.max_per_student` would otherwise refuse the
        # second allocation — two platforms of one scenario are two machines — and the
        # name says in `session list` where a machine came from if one is left behind
        # with --keep.
        student = f"{args.student}-{scenario_id}" + (f"-{workload}" if workload else "")
        label = f"{scenario_id}@{workload}" if workload else scenario_id
        session = ctx.manager.allocate(
            student,
            scenario_id,
            workload=workload or None,
            time_limit_minutes=args.time_limit,
        )
        if session.state == SessionState.ERROR:
            state, detail = "error", session.error or "the session failed to provision"
        else:
            state, detail, _report = guac.verify_session_console(
                settings, session, scenario, seconds=args.seconds
            )
        rows.append([scenario_id, session.workload or "-", protocol, state, str(session.id)])
        results.append((label, state, detail))
        if not args.keep:
            ctx.manager.end(session)

    print()
    _table(["scenario", "workload", "console", "state", "session"], rows)
    print()
    for scenario_id, state, detail in results:
        # Every row that is not a working console gets its sentence on its own line: the
        # table cell cannot hold it, and the sentence is the actionable part. `skipped` is
        # a posture rather than a fault (no console configured, or a range whose Linux
        # templates predate `guac.linux_ssh`), ``degraded`` still opens over the slower
        # HTTP tunnel, and the rest are consoles a student would have to report.
        if state == "ok":
            continue
        _say({"skipped": INFO, "degraded": WARN}.get(state, FAIL), f"{scenario_id}: {detail}")
    opened = sum(1 for _id, state, _detail in results if state == "ok")
    skipped = sum(1 for _id, state, _detail in results if state == "skipped")
    failed = [row for row in results if row[1] not in ("ok", "skipped", "degraded")]
    _say(
        OK if not failed else FAIL,
        f"{opened} of {len(jobs)} console(s) opened"
        + (f", {skipped} skipped" if skipped else "")
        + ("" if args.keep else "; the machines have been destroyed"),
    )
    return 1 if failed else 0


def cmd_stats(args) -> int:
    ctx = Context(args.config)
    print(json.dumps(ctx.manager.stats(), indent=2))
    return 0


# ---------------------------------------------------------------------------
# users
# ---------------------------------------------------------------------------
def cmd_user(args) -> int:
    """List the local account rows, or disable one.

    There is nothing to add or import here: identity is Authentik's, and a row is
    created the first time someone signs in (``Store.upsert_sso_user``). A
    username that has never signed in simply has no row, so an operator manages
    *people* in Authentik and *access* here.
    """
    ctx = Context(args.config)
    store = ctx.store
    if args.action == "list":
        rows = [[u["username"], u["role"], u["display_name"], u["created_at"]] for u in store.list_users()]
        _table(["username", "role", "name", "created"], rows)
        return 0
    if args.action == "remove":
        if not args.username:
            _say(FAIL, "--username is required")
            return 2
        store.deactivate_user(args.username)
        _say(OK, f"{args.username!r} disabled — an Authentik sign-in will not re-enable them")
        return 0
    return 2


# ---------------------------------------------------------------------------
# serve
# ---------------------------------------------------------------------------
def cmd_serve(args) -> int:
    try:
        import uvicorn
    except ImportError:
        _say(FAIL, "uvicorn is not installed: pip install -r requirements.txt")
        return 1
    from .portal.app import create_app

    ctx = Context(args.config)
    problems = require_secrets(ctx.settings)
    for problem in problems:
        _say(WARN, problem)
    app = create_app(ctx.settings)
    _say(OK, f"portal on http://{ctx.settings.portal.host}:{ctx.settings.portal.port}")
    uvicorn.run(app, host=ctx.settings.portal.host, port=ctx.settings.portal.port, log_level=args.log_level)
    return 0


# ---------------------------------------------------------------------------
# argument parsing
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# catalog / workloads
# ---------------------------------------------------------------------------
def cmd_catalog(args) -> int:
    ctx = Context(args.config)
    catalog = ctx.catalog

    if args.action == "list":
        rows = []
        for entry in catalog.list(
            group=args.group,
            family=args.family,
            kind=args.kind,
            automated=True if args.automated else None,
        ):
            rows.append(
                [
                    entry.id,
                    entry.group,
                    entry.kind,
                    entry.released,
                    entry.support or "-",
                    entry.automation,
                    f"{entry.resources.cpu}c/{entry.resources.memory}",
                    entry.media.source,
                ]
            )
        _table(
            ["id", "group", "kind", "released", "support", "automation", "resources", "media"],
            rows,
        )
        print(f"\n{len(rows)} entr(y|ies). Media is never redistributed: free = fetched, operator = you supply it.")
        return 0

    if args.action == "groups":
        rows = []
        for group in catalog.group_list():
            rows.append([group.id, group.label, str(len(group.entries)), group.era or "-"])
        _table(["group", "label", "entries", "era"], rows)
        return 0

    if args.action == "show":
        entry = catalog.get(args.entry)
        print(f"{entry.label}  ({entry.id})")
        print(f"  group: {entry.group}   family: {entry.family}   kind: {entry.kind}")
        print(f"  released: {entry.released or '?'}   support: {entry.support or '?'}")
        print(
            f"  resources: {entry.resources.cpu} CPU / {entry.resources.memory} / {entry.resources.disk}"
            f"   device profile: {entry.device_profile}"
        )
        print(f"  automation: {entry.automation}   scenarios: {', '.join(entry.scenario_families) or 'any'}")
        print(f"  media: {entry.media.source}/{entry.media.kind} {entry.media.filename or ''}".rstrip())
        if entry.requires:
            print(f"  requires: {', '.join(entry.requires)}")
        if entry.notes:
            print("\nNotes:\n  " + "\n  ".join(entry.notes.splitlines()))
        for note in entry.profile.get("notes") or []:
            print(f"  * {note}")
        status = ctx.media.status(entry)
        print(f"\nMedia status: {status.state} — {status.note or status.path}")
        print("\nProvisioning plan:")
        return _print_plan(catalog.plan(entry, media_ready=status.ready))

    if args.action == "validate":
        problems = catalog.validate()
        if problems:
            for problem in problems:
                _say(FAIL, problem)
            return 1
        _say(OK, f"{len(catalog.list())} catalog entr(y|ies) valid")
        return 0

    if args.action == "plan":
        entry = catalog.get(args.entry)
        ready = ctx.media.status(entry).ready
        return _print_plan(catalog.plan(entry, media_ready=ready))

    if args.action == "refresh":
        remote = args.remote or "images"
        _say(INFO, f"listing images from remote {remote!r}")
        images = ctx.incus.run_json(["image", "list", f"{remote}:", "--format=json"], timeout=180)
        if not images:
            _say(FAIL, f"no images returned from {remote!r}; is the remote added (`incus remote list`)?")
            return 1
        target = catalog.import_images(images)
        _say(OK, f"wrote {len(images)} image(s) to {target}")
        return 0

    return 2


def _print_plan(plan) -> int:
    print(f"  strategy: {plan.strategy} — {plan.label}")
    print(f"  estimate: {plan.estimate_seconds}s")
    for step in plan.steps:
        print(f"    - {step}")
    for blocker in plan.blockers:
        _say(WARN, f"blocked: {blocker}")
    for note in plan.notes:
        print(f"    * {note}")
    return 0 if plan.ready else 1


# ---------------------------------------------------------------------------
# media
# ---------------------------------------------------------------------------
def cmd_media(args) -> int:
    ctx = Context(args.config)
    store = ctx.media

    entries = [ctx.catalog.get(e) for e in args.entries] if args.entries else None
    if args.action == "status":
        rows = []
        for row in store.statuses(entries):
            rows.append(
                [row.entry_id, row.filename or "-", row.source, row.state, row.size_human if row.size_bytes else "-"]
            )
        _table(["entry", "media", "source", "state", "size"], rows)
        counts = store.summary()
        print("\n" + "  ".join(f"{k}: {v}" for k, v in sorted(counts.items())))
        return 0

    if args.action == "missing":
        rows = []
        for row in store.missing_operator_media():
            rows.append([row.entry_id, row.filename, row.note])
        if not rows:
            _say(OK, "every operator-supplied medium declared in the catalog is present")
            return 0
        _table(["entry", "filename", "what to do"], rows)
        print(f"\n{len(rows)} medium/media to supply from your own licences, into {store.root}")
        return 0

    if args.action == "fetch":
        targets = entries if entries is not None else store.fetchable()
        if not targets:
            _say(INFO, "nothing in the catalog is freely downloadable right now")
            return 0
        failures = 0
        for entry in targets:
            try:
                path = store.fetch(entry)
                _say(OK, f"{entry.id}: {path}")
            except MediaError as exc:
                _say(FAIL, f"{entry.id}: {exc}")
                failures += 1
        return 1 if failures else 0

    return 2


# ---------------------------------------------------------------------------
# workload images
# ---------------------------------------------------------------------------
def cmd_image(args) -> int:
    ctx = Context(args.config)
    entry = ctx.catalog.get(args.entry)
    status = ctx.media.status(entry)
    if args.action == "plan":
        return _print_plan(ctx.catalog.plan(entry, media_ready=status.ready))

    if args.action != "build":
        return 2

    if entry.media.kind == "image":
        _say(INFO, f"{entry.id} is already an image ({entry.image_alias}); nothing to build")
        return 0
    if status.state == "operator-required":
        _say(FAIL, f"{status.note}")
        return 1
    if status.state == "fetchable":
        _say(INFO, f"downloading free media for {entry.id}")
        ctx.media.fetch(entry)
        status = ctx.media.status(entry)
    if not status.ready:
        _say(FAIL, f"media for {entry.id} is not available")
        return 1

    script = Path(__file__).resolve().parent.parent / "infra" / "build-workload-image.sh"
    if not script.exists():
        _say(FAIL, f"build script missing: {script}")
        return 1
    _say(INFO, f"running {script.name} for {entry.id} (this takes a while)")
    proc = subprocess.run(  # noqa: S603 - fixed script, operator-supplied arguments
        [str(script), "--entry", entry.id, "--config", args.config or ""],
        check=False,
    )
    if proc.returncode != 0:
        _say(FAIL, f"image build failed with exit code {proc.returncode}")
        return proc.returncode
    _say(OK, f"image published as ontrak-{entry.id}")
    return 0


# ---------------------------------------------------------------------------
# schedule
# ---------------------------------------------------------------------------
def cmd_schedule(args) -> int:
    ctx = Context(args.config)
    schedule = ctx.settings.schedule.to_schedule()
    if args.action == "show":
        data = schedule.to_dict()
        if not data["windows"]:
            _say(INFO, "no windows configured; set schedule.windows in config/ontrak.yaml")
            print(
                "\nExample:\n  schedule:\n    enabled: true\n    windows:\n"
                "      - label: morning-class\n        days: [mon, wed]\n        start: '09:00'\n"
                "        end: '12:00'\n        prewarm_minutes: 30\n        target: 15\n"
                "        scenarios: [net-dns-failure]"
            )
            return 0
        rows = []
        for window in data["windows"]:
            rows.append(
                [
                    window["label"],
                    ",".join(window["days"]),
                    f"{window['start']}-{window['end']}",
                    str(window["prewarm_minutes"]),
                    str(window["target"]),
                    ", ".join(window["scenarios"]) or "all",
                ]
            )
        _table(["window", "days", "time", "prewarm", "target", "scenarios"], rows)
        print(f"\nenabled: {data['enabled']}   phase now: {schedule.action_for(datetime.now())}")
        return 0

    if args.action == "tick":
        scheduler = Scheduler(ctx.manager, schedule)
        result = scheduler.tick()
        if args.json:
            print(json.dumps(result, indent=2))
            return 0
        print(f"phase: {result['phase']}")
        if not result["planned"]:
            _say(INFO, "nothing to do right now")
        for row in result["performed"]:
            _say(OK if "error" not in row else FAIL, f"{row['kind']} {row.get('scenario_id') or ''} {row.get('reason', '')}")
        return 0
    return 2


# ---------------------------------------------------------------------------
# scenario generation
# ---------------------------------------------------------------------------
def cmd_generate(args) -> int:
    ctx = Context(args.config)
    repository = ctx.repo

    if args.action == "list":
        matrix = primitive_matrix()
        rows = [
            [
                row["id"],
                row["category"],
                str(row["difficulty"]),
                f"{row['minutes']}m",
                ", ".join(row["objectives"]),
            ]
            for row in matrix["primitives"]
        ]
        _table(["primitive", "category", "diff", "time", "objectives"], rows)
        print("\nCurated multi-fault combinations:")
        for combo in matrix["combinations"]:
            print(f"  {combo['scenario_id']}: {' + '.join(combo['primitives'])}")
        return 0

    if args.action == "matrix":
        results = generate_matrix(repository, prefix=args.prefix, force=args.force)
        failures = 0
        for result in results:
            if result.ok:
                _say(OK, f"{result.scenario_id}: {len(result.objective_ids)} objectives")
            else:
                failures += 1
                for problem in result.problems:
                    _say(FAIL, problem)
        return 1 if failures else 0

    if args.action in {"one", "combine"}:
        if args.action == "combine" and not args.primitives:
            ids = suggest_combinations()[0]
        else:
            ids = args.primitives or []
        if not ids:
            _say(FAIL, "give at least one --primitive (see `ontrak generate list`)")
            return 2
        try:
            result = generate(
                ids,
                repository,
                scenario_id=args.scenario,
                title=args.title,
                force=args.force,
            )
        except GenerationError as exc:
            _say(FAIL, str(exc))
            return 1
        if not result.ok:
            for problem in result.problems:
                _say(FAIL, problem)
            return 1
        _say(OK, f"wrote {result.directory}")
        print(f"  objectives: {', '.join(result.objective_ids)}")
        print("  validate:   ontrak scenario validate")
        return 0

    return 2


# ---------------------------------------------------------------------------
# lessons
# ---------------------------------------------------------------------------
def cmd_lesson(args) -> int:
    ctx = Context(args.config)
    if args.action == "list":
        rows = [
            [
                lesson.id,
                lesson.platform,
                f"{lesson.minutes}m",
                str(lesson.difficulty),
                str(len(lesson.commands)),
                str(len(lesson.exercises)),
                lesson.title[:52],
            ]
            for lesson in ctx.lessons.list()
        ]
        _table(["id", "platform", "time", "diff", "cmds", "ex", "title"], rows)
        return 0
    if args.action == "show":
        if not args.lesson:
            print("specify a lesson id (ontrak lesson list)", file=sys.stderr)
            return 2
        lesson = ctx.lessons.get(args.lesson)
        if args.json:
            print(json.dumps(lesson.public(), indent=2))
            return 0
        if args.shell:
            print(lesson.all_shell())
            return 0
        print(f"{lesson.title}  ({lesson.id})")
        print(
            f"  platform: {lesson.platform}   difficulty: {lesson.difficulty}/4   "
            f"time: {lesson.minutes}m   exercises: {len(lesson.exercises)}"
        )
        if lesson.prerequisites:
            print(f"  do first: {', '.join(lesson.prerequisites)}")
        print("\nSummary:\n  " + lesson.summary.replace("\n  ", " ").strip())
        if lesson.objectives:
            print("\nYou will be able to:")
            for objective in lesson.objectives:
                print(f"  - {objective}")
        if lesson.commands:
            print("\nCommands:")
            for command in lesson.commands:
                print(f"  {command.command}")
                print(f"      {command.what}")
                if command.example:
                    print(f"      e.g. {command.example}")
                if command.danger:
                    print(f"      CARE: {command.danger}")
        for index, step in enumerate(lesson.steps, 1):
            print(f"\n{index}. {step.title}")
            if step.body:
                print("   " + step.body.replace("\n", "\n   ").strip())
            if step.command:
                print(f"   $ {step.command}")
        if lesson.exercises:
            print("\nExercises:")
            for exercise in lesson.exercises:
                print(f"  [{exercise.id}] {exercise.prompt.strip()}")
                if args.solutions:
                    print("      solution:")
                    for line in exercise.solution.splitlines():
                        print(f"        {line}")
                    if exercise.verify:
                        print(f"      check with: {exercise.verify}")
        if lesson.docs:
            print("\nFurther reading: " + ", ".join(lesson.docs))
        print("\n(Solutions are hidden; add --solutions to print them.)")
        return 0
    if args.action == "validate":
        problems = ctx.lessons.validate()
        for problem in problems:
            _say(FAIL, problem)
        if problems:
            return 1
        _say(OK, f"{len(ctx.lessons.list())} lesson(s) valid")
        return 0
    return 2


# ---------------------------------------------------------------------------
# tickets (the in-house write-up)
# ---------------------------------------------------------------------------
def _ticket_values(ctx: Context, form, args) -> dict:
    """Collect answers from --json and/or repeated --field id=value."""
    values: dict[str, str] = {}
    if args.json_data:
        try:
            loaded = json.loads(args.json_data)
        except json.JSONDecodeError as exc:
            raise TicketError(f"--json is not valid JSON: {exc}") from exc
        if not isinstance(loaded, dict):
            raise TicketError("--json must be an object of field id to answer")
        values.update({str(k): "" if v is None else str(v) for k, v in loaded.items()})
    for item in args.fields or []:
        if "=" not in item:
            raise TicketError(f"--field expects id=value, got {item!r}")
        key, _, value = item.partition("=")
        values[key.strip()] = value
    known = {field.id for field in form.fields}
    unknown = sorted(set(values) - known)
    if unknown:
        raise TicketError(
            f"unknown ticket field(s): {', '.join(unknown)}; this form has: {', '.join(sorted(known))}"
        )
    return values


def cmd_ticket(args) -> int:
    ctx = Context(args.config)
    action = args.action

    if action == "form":
        scenario = ctx.repo.get(args.scenario) if args.scenario else None
        if scenario is None:
            print("specify --scenario (see `ontrak scenario list`)", file=sys.stderr)
            return 2
        form = ctx.manager.ticket_form(scenario)
        if form is None:
            _say(INFO, f"{scenario.id} has no ticket form; it is graded on machine state alone")
            return 0
        print(f"{form.title}  ({scenario.id})")
        print(f"  {form.weight:.0f}% of the final grade, pass mark {form.pass_score:.0f}%")
        if form.intro:
            print("\n  " + form.intro.replace("\n", "\n  ").strip())
        print("\nFields:")
        for field in form.fields:
            print(f"  [{field.weight:>5.0f}] {field.id:<18} {field.kind:<9} {field.label}")
            if field.options:
                print(f"           options: {', '.join(field.options)}")
            rubric = []
            if field.required:
                rubric.append("required")
            if field.min_words:
                rubric.append(f"at least {field.min_words} words")
            if field.all_of:
                rubric.append("must mention " + ", ".join(field.all_of))
            if field.any_of:
                rubric.append("must mention one of " + ", ".join(field.any_of))
            if field.none_of:
                rubric.append("must not mention " + ", ".join(field.none_of))
            if rubric:
                print(f"           rubric: {'; '.join(rubric)}")
        return 0

    session = _session_or_die(ctx, args)
    if session is None:
        return 1
    form = ctx.manager.ticket_form_for(session)
    if form is None:
        _say(INFO, f"{session.scenario_id} has no ticket form")
        return 0

    if action == "show":
        values = ctx.store.ticket_values(session.id) or ctx.store.ticket_draft(session.id or 0)
        grade = ctx.store.latest_ticket(session.id)
        print(f"Session #{session.id} — {session.student} — {session.scenario_id}")
        print(f"{form.title} ({form.weight:.0f}% of the grade)\n")
        for field in form.fields:
            answer = values.get(field.id, "")
            print(f"  {field.label} [{field.weight:.0f} pts]")
            print("    " + (answer.replace("\n", "\n    ") if answer else "(blank)"))
        if grade:
            print("\n" + ticket_feedback_text(form, grade))
        else:
            print("\n(not handed in yet: no marked ticket for this session)")
        return 0

    values = _ticket_values(ctx, form, args)
    if action == "save":
        ctx.manager.save_ticket_draft(session, values)
        _say(OK, f"saved a draft for session {session.id} ({len(values)} field(s))")
        return 0
    if action == "grade":
        ctx.manager.save_ticket_draft(session, values)
        grade = ctx.manager.grade_ticket(session, values)
        print(ticket_feedback_text(form, grade))
        _say(INFO, "preview only — nothing stored; `ontrak ticket complete` hands it in")
        return 0
    if action == "complete":
        missing = missing_required(form, values)
        if missing:
            _say(FAIL, "required field(s) still blank: " + ", ".join(missing))
            return 1
        report = ctx.manager.complete(session, values=values)
        print(feedback_text(ctx.repo.get(session.scenario_id), report))
        if report.has_ticket:
            print("\n" + report.breakdown())
        _say(OK if report.resolved else FAIL, f"session {session.id} submitted: {report.summary_line()}")
        return 0 if report.resolved else 1
    return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ontrak", description=__doc__.splitlines()[0])
    parser.add_argument("--version", action="version", version=f"ontrak {__version__}")
    parser.add_argument("--config", help="path to a config yaml (default config/ontrak.yaml)")
    parser.add_argument(
        "--driver",
        choices=["winrm", "incus-exec", "incus-shell", "ssh", "null"],
        help=(
            "override guest.driver (winrm/incus-exec for Windows, incus-shell/ssh for "
            "Linux, null runs everything as a no-op)"
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("doctor", help="check host readiness").set_defaults(func=cmd_doctor)

    scenario = sub.add_parser("scenario", help="work with the scenario catalogue")
    scenario.add_argument("action", choices=["list", "show", "validate"])
    scenario.add_argument("scenario", nargs="?")
    scenario.set_defaults(func=cmd_scenario)

    lesson = sub.add_parser("lesson", help="the command walkthrough library")
    lesson.add_argument("action", choices=["list", "show", "validate"])
    lesson.add_argument("lesson", nargs="?")
    lesson.add_argument("--json", action="store_true", help="print the lesson as JSON")
    lesson.add_argument("--shell", action="store_true", help="print only the commands, in order")
    lesson.add_argument("--solutions", action="store_true", help="include exercise solutions")
    lesson.set_defaults(func=cmd_lesson)

    ticket = sub.add_parser("ticket", help="the in-house incident write-up")
    ticket.add_argument("action", choices=["form", "show", "save", "grade", "complete"])
    ticket.add_argument("--scenario", help="for `form`: which scenario's ticket to print")
    ticket.add_argument("--session-id", type=int, help="which session (or wrap with --student)")
    ticket.add_argument("--student", help="the student whose session this is")
    ticket.add_argument(
        "--field",
        dest="fields",
        action="append",
        help="an answer as id=value; repeat for each field",
    )
    ticket.add_argument("--json", dest="json_data", help="answers as a JSON object")
    ticket.set_defaults(func=cmd_ticket)

    template = sub.add_parser("template", help="build scenario templates")
    template.add_argument("action", choices=["build"])
    template.add_argument("scenarios", nargs="*")
    template.add_argument("--all", action="store_true")
    template.add_argument("--force", action="store_true", help="rebuild even if the snapshot exists")
    template.set_defaults(func=cmd_template)

    pool = sub.add_parser("pool", help="manage the warm pool")
    pool.add_argument("action", choices=["status", "prewarm", "refill", "drain"])
    pool.add_argument("--scenario")
    pool.add_argument(
        "--workload",
        help="platform to prewarm, e.g. ubuntu-24.04; omit for every platform "
        "the scenario declares (and for its default image on a single-platform one)",
    )
    pool.add_argument("--count", type=int, default=10)
    pool.set_defaults(func=cmd_pool)

    session = sub.add_parser("session", help="manage student sessions")
    session.add_argument(
        "action",
        choices=[
            "list",
            "start",
            "show",
            "check",
            "reset",
            "extend",
            "limit",
            "complete",
            "end",
            "console",
            "prune",
        ],
    )
    session.add_argument("--student")
    session.add_argument("--scenario")
    session.add_argument("--session-id", type=int)
    session.add_argument("--minutes", type=int, default=15)
    session.add_argument(
        "--time-limit",
        type=int,
        default=None,
        help="minutes the student gets for this session (default: session.time_limit_choices[0])",
    )
    session.add_argument("--workload", help="catalog entry to build the guest from, e.g. win11-24h2")
    session.add_argument("--limit", type=int, default=50)
    session.add_argument(
        "--days",
        type=int,
        default=7,
        help="prune: only finished sessions older than this many days (default 7)",
    )
    session.add_argument(
        "--dry-run", action="store_true", help="prune: report what would go, delete nothing"
    )
    session.set_defaults(func=cmd_session)

    console = sub.add_parser("console", help="open real consoles end to end")
    console.add_argument("action", choices=["verify", "browser"])
    console.add_argument("scenarios", nargs="*", help="scenario ids (or --all / --linux)")
    console.add_argument("--all", action="store_true", help="every scenario in the catalogue")
    console.add_argument(
        "--linux", action="store_true", help="only the scenarios that get the SSH console"
    )
    console.add_argument(
        "--session-id", type=int, help="check one session that already exists, and do not end it"
    )
    console.add_argument(
        "--student",
        default="console-verify",
        help="name to allocate under; the scenario is appended, one machine per scenario",
    )
    console.add_argument(
        "--base-url",
        help="the console URL to open the tunnel on; required when guac.base_url is 'auto' "
        "(e.g. https://localhost:8443/guacamole/)",
    )
    console.add_argument("--workload", help="catalog entry to build the guest from, e.g. debian-12")
    console.add_argument(
        "--workloads",
        action="store_true",
        help="open one console per platform the scenario declares (e.g. ubuntu-24.04 *and* "
        "debian-12) instead of only the default; what the nightly range walk runs",
    )
    console.add_argument("--time-limit", type=int, default=None)
    console.add_argument(
        "--seconds",
        type=float,
        default=guac.TUNNEL_SECONDS,
        help="how long to listen on each console's tunnel (default: %(default)s)",
    )
    console.add_argument(
        "--portal-url",
        help="the portal's own address, for `console browser` (e.g. https://localhost:8443/); "
        "defaults to the origin of --base-url / guac.base_url when it is an absolute URL",
    )
    console.add_argument(
        "--browser-user",
        help="account `console browser` signs in with; defaults to portal.admin_username. "
        "An instructor can open any session's page, so this is normally the range's admin",
    )
    console.add_argument(
        "--browser-password",
        help="password for --browser-user; defaults to portal.admin_password",
    )
    console.add_argument(
        "--wait",
        type=float,
        default=None,
        help="how long `console browser` waits for the machine it started (default: "
        "session.check_timeout_seconds)",
    )
    console.add_argument("--keep", action="store_true", help="leave the machines up for a look")
    console.set_defaults(func=cmd_console)

    reap = sub.add_parser("reap", help="expire sessions and refill pools")
    reap.add_argument("--loop", action="store_true")
    reap.set_defaults(func=cmd_reap)

    sub.add_parser("stats", help="print a JSON status snapshot").set_defaults(func=cmd_stats)

    user = sub.add_parser("user", help="manage portal accounts")
    user.add_argument("action", choices=["list", "remove"])
    user.add_argument("--username")
    user.set_defaults(func=cmd_user)

    catalog = sub.add_parser("catalog", help="the OS/Office workload catalog")
    catalog.add_argument("action", choices=["list", "groups", "show", "validate", "plan", "refresh"])
    catalog.add_argument("entry", nargs="?")
    catalog.add_argument("--group")
    catalog.add_argument("--family")
    catalog.add_argument("--kind", choices=["vm", "container"])
    catalog.add_argument("--automated", action="store_true", help="only entries that can be graded")
    catalog.add_argument("--remote", help="Incus remote to refresh image entries from (default: images)")
    catalog.set_defaults(func=cmd_catalog)

    media = sub.add_parser("media", help="installation media store")
    media.add_argument("action", choices=["status", "missing", "fetch"])
    media.add_argument("entries", nargs="*")
    media.set_defaults(func=cmd_media)

    image = sub.add_parser("image", help="build a workload image from media")
    image.add_argument("action", choices=["plan", "build"])
    image.add_argument("entry")
    image.set_defaults(func=cmd_image)

    schedule = sub.add_parser("schedule", help="prewarm/teardown windows")
    schedule.add_argument("action", choices=["show", "tick"])
    schedule.add_argument("--json", action="store_true")
    schedule.set_defaults(func=cmd_schedule)

    generate_cmd = sub.add_parser("generate", help="generate scenarios from fault primitives")
    generate_cmd.add_argument("action", choices=["list", "one", "combine", "matrix"])
    generate_cmd.add_argument("--primitive", dest="primitives", action="append")
    generate_cmd.add_argument("--scenario", help="scenario id to write (default: derived from primitives)")
    generate_cmd.add_argument("--title")
    generate_cmd.add_argument("--prefix", default="gen")
    generate_cmd.add_argument("--force", action="store_true")
    generate_cmd.set_defaults(func=cmd_generate)

    serve = sub.add_parser("serve", help="run the student portal")
    serve.add_argument("--log-level", default="info")
    serve.set_defaults(func=cmd_serve)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "driver", None):
        os.environ["ONTRAK_GUEST__DRIVER"] = args.driver
    try:
        return int(args.func(args) or 0)
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130
    except (
        ConfigError,
        ScenarioError,
        SessionError,
        IncusError,
        GuestError,
        LessonError,
        TicketError,
    ) as exc:
        _say(FAIL, str(exc))
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
