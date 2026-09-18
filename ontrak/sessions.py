"""Session lifecycle.

The model is deliberately simple and matches the reset policy: **a session is
always a fresh clone of a scenario template, and a reset throws the VM away and
clones again.** No in-place mutation, no drift, no "did the last student leave
something behind". On ZFS/btrfs the clone is copy-on-write, so throwing VMs
away is cheaper and far more reliable than trying to un-break a machine.

Two kinds of instance exist:

``tpl-<scenario>``
    Booted once by ``build-templates``, fault injected, powered off, then
    snapshotted as ``clean``. This is the source of truth for the scenario.
``ontrak-pool-<scenario>-<n>``
    A pre-booted clone waiting to be claimed. Keeps handoff instant for a class
    of 30 instead of making everyone wait a minute for Windows to boot.

A claimed pool instance is recorded on the session row; availability is derived
from "pool-named instance that no live session references", so the pool needs no
bookkeeping of its own and survives control-plane restarts.
"""

from __future__ import annotations

import contextlib
import secrets
import string
import threading
import time
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

from .catalog import Catalog, CatalogEntry, CatalogError
from .config import Settings
from .guest import BaseDriver, GuestError, build_driver, quote_ps
from .incus import IncusClient, IncusError
from .models import ScoreReport, Session, SessionState, iso, parse_iso, seconds_since, utcnow
from .scenarios import COMMON_LIB, SETUP_OK_MARKER, ScenarioRepository
from .scoring import evaluate
from .store import Store

POOL_SNAPSHOT = "clean"
TEMPLATE_PSEUDO_STUDENT = "<template>"


class SessionError(RuntimeError):
    """Raised when a session cannot be created, reset or graded."""


@dataclass
class PoolStatus:
    scenario_id: str
    target: int
    ready: int
    claimed: int
    total: int
    template_ready: bool

    @property
    def deficit(self) -> int:
        """How many instances to create to reach the target.

        Counted against *all* pool-named instances, including the ones students
        have claimed. A claimed VM still has its pool name, so a class where every
        student holds one of 30 target VMs shows a deficit of 0 rather than asking
        the reaper to build 30 more and exhaust the host's memory.
        """
        return max(0, self.target - self.total)

    @property
    def shortfall(self) -> int:
        """Unclaimed instances missing right now (handoff latency, not capacity)."""
        return max(0, self.target - self.ready)

    @property
    def healthy(self) -> bool:
        return self.deficit == 0


class SessionManager:
    def __init__(
        self,
        settings: Settings,
        store: Store,
        repo: ScenarioRepository | None = None,
        incus: IncusClient | None = None,
        driver: BaseDriver | None = None,
        catalog: Catalog | None = None,
    ):
        self.settings = settings
        self.store = store
        self.repo = repo or ScenarioRepository(settings.scenarios_dir)
        self.incus = incus
        self.driver = driver or build_driver(settings)
        self.catalog = catalog
        # Kept as an attribute (not ``self.repo``) because the scheduler and the
        # portal both reach for ``manager.repository``.
        self.repository = self.repo
        # One lock per session, so a portal worker thread cannot race an
        # instructor action or another worker into provisioning the same session
        # twice (which would clone two VMs and orphan one of them).
        self._lock_guard = threading.Lock()
        self._session_locks: dict[int, threading.Lock] = {}

    # ------------------------------------------------------------------
    # infrastructure helpers
    # ------------------------------------------------------------------
    def _require_incus(self) -> IncusClient:
        if self.incus is None:
            raise SessionError(
                "no Incus connection available: the `incus` binary is not on PATH. "
                "Run infra/bootstrap-host.sh, then `ontrak doctor` to confirm."
            )
        if hasattr(self.incus, "available") and not self.incus.available():
            raise SessionError(
                "no Incus connection available: the `incus` binary is not on PATH. "
                "Run infra/bootstrap-host.sh, then `ontrak doctor` to confirm."
            )
        return self.incus

    def _guest_path(self, *parts: str) -> str:
        root = self.settings.guest.work_dir.rstrip("\\")
        return "\\".join([root, *parts])

    @property
    def _lib_source(self) -> Path:
        return self.settings.scenarios_dir / "_lib" / COMMON_LIB

    def _guest_args(self, session: Session) -> dict:
        return {"host": session.host_ip, "instance": session.instance}

    # ------------------------------------------------------------------
    # templates
    # ------------------------------------------------------------------
    def template_status(self) -> list[dict]:
        incus = self.incus
        rows = []
        for scenario in self.repo.list():
            name = self.settings.incus.template_name(scenario.id)
            exists = bool(incus and incus.exists(name))
            rows.append(
                {
                    "scenario_id": scenario.id,
                    "name": name,
                    "exists": exists,
                    "snapshot": bool(exists and incus and incus.has_snapshot(name, POOL_SNAPSHOT)),
                    "running": bool(exists and incus and incus.instance_status(name) == "RUNNING"),
                    "ready": bool(exists and incus and incus.has_snapshot(name, POOL_SNAPSHOT)),
                }
            )
        return rows

    def build_templates(self, ids: list[str] | None = None, force: bool = False) -> dict[str, str]:
        """Build/replace scenario templates. Returns ``{scenario_id: status}``."""
        results: dict[str, str] = {}
        for scenario in self.repo.list():
            if ids and scenario.id not in ids:
                continue
            try:
                self.ensure_template(scenario.id, force=force)
                results[scenario.id] = "ready"
            except (SessionError, IncusError, GuestError) as exc:
                results[scenario.id] = f"failed: {exc}"
                self.store.log_event("template_failed", f"{scenario.id}: {exc}")
        return results

    def ensure_template(self, scenario_id: str, force: bool = False) -> str:
        """Create ``tpl-<scenario>`` with a ``clean`` snapshot, idempotently.

        Boots a clone of the golden image, applies the fault, shuts the guest
        down cleanly and snapshots. Idempotent because re-running a template
        build is a normal operator move after editing a scenario.
        """
        incus = self._require_incus()
        scenario = self.repo.get(scenario_id)
        name = self.settings.incus.template_name(scenario_id)

        if not force and incus.exists(name) and incus.has_snapshot(name, POOL_SNAPSHOT):
            return name

        base_image = self._base_image(scenario)
        if not incus.image_exists(base_image):
            entry = self.workload_for(scenario)
            if entry is not None:
                raise SessionError(
                    f"workload image {base_image!r} for scenario {scenario_id} is not published "
                    f"yet; build it with `ontrak image build {entry.id}` (media: "
                    f"{entry.media.source}/{entry.media.kind})"
                )
            raise SessionError(
                f"golden image {base_image!r} not found; run "
                "infra/build-golden-image.sh first (or `ontrak doctor` for details)"
            )

        if incus.exists(name):
            incus.stop_instance(name, force=True)
            incus.delete_instance(name, force=True)

        profiles = [p for p in ("default", self.settings.incus.profile) if p]
        incus.create_instance(name, base_image, profiles)
        # The workload decides the hardware profile (legacy guests cannot use VirtIO
        # and need different disks/NICs), then the scenario layers on any extra
        # hardware it needs: hardware cannot be added from inside the guest, so it
        # has to exist before first boot.
        entry = self._apply_workload(name, scenario)
        if entry is not None:
            self.store.log_event(
                "workload_applied",
                f"{scenario_id} -> {entry.id} (profile {entry.device_profile}, "
                f"{entry.resources.cpu} CPU / {entry.resources.memory})",
            )
        self._apply_instance_spec(name, scenario)

        session = Session(
            id=None,
            student=TEMPLATE_PSEUDO_STUDENT,
            scenario_id=scenario_id,
            state=SessionState.PROVISIONING,
            instance=name,
            rdp_user=self.settings.guest.user,
            rdp_password=self.settings.guest.password,
        )
        incus.start_instance(name)
        try:
            self._await_guest(session, self.settings.guest.ready_timeout_seconds)
            self._upload_scenario_files(session, scenario, include_setup=True)
            result = self.driver.run_script_file(
                self._guest_path("scenarios", scenario_id, "setup.ps1"),
                timeout=self.settings.session.check_timeout_seconds,
                **self._guest_args(session),
            )
            combined = (result.stdout or "") + (result.stderr or "")
            if not result.ok or SETUP_OK_MARKER not in combined:
                raise SessionError(
                    f"setup.ps1 for {scenario_id} did not report {SETUP_OK_MARKER} "
                    f"(exit {result.exit_code}). Output tail: {combined[-800:].strip()}"
                )
        finally:
            # Fault injection may leave the guest unresponsive (broken NIC, runaway
            # CPU). Force-stop anyway: the snapshot must capture the fault, and a
            # half-built template is worse than a hard power-off.
            with contextlib.suppress(IncusError):
                self._require_incus().stop_instance(name, force=True, timeout=60)

        incus.create_snapshot(name, POOL_SNAPSHOT)
        self.store.log_event("template_built", f"{scenario_id} -> {name}/{POOL_SNAPSHOT}")
        return name

    # ------------------------------------------------------------------
    # workloads (which OS/build a guest runs)
    # ------------------------------------------------------------------
    def workload_for(self, scenario) -> CatalogEntry | None:
        """Resolve the catalog entry a scenario declares, if any.

        A scenario may name a workload (``workload: win11-24h2``) to say "build this
        fault on that platform". Without a catalog, or without the field, we fall
        back to the site's golden image, which is what older scenarios assume.
        """
        workload_id = getattr(scenario, "workload", "") or ""
        if not workload_id or self.catalog is None:
            return None
        try:
            return self.catalog.get(workload_id)
        except CatalogError:
            self.store.log_event(
                "workload_unknown",
                f"scenario {scenario.id} names workload {workload_id!r}, which is not in the catalog",
            )
            return None

    def _base_image(self, scenario) -> str:
        """The Incus image alias a scenario's template should be built from."""
        entry = self.workload_for(scenario)
        if entry is None:
            return self.settings.incus.image_alias
        if entry.media.kind == "image" or entry.recipe in {"image-alias", "container-image"}:
            return entry.image_alias
        # An ISO-based workload is turned into an image once by
        # `ontrak image build`, which publishes it under this alias.
        return f"ontrak-{entry.id}"

    def _apply_workload(self, name: str, scenario) -> CatalogEntry | None:
        """Apply a workload's device profile and resource limits to a new instance.

        This is what makes the legacy platforms work at all: Windows 95/98/ME cannot
        use VirtIO and need an IDE disk, an emulated NIC and a chipset they recognise,
        and none of that can be changed from inside the guest.
        """
        entry = self.workload_for(scenario)
        if entry is None:
            return None
        incus = self._require_incus()
        for device_name, spec in entry.resolved_devices().items():
            options = dict(spec.get("options") or {})
            if spec.get("type") == "nic" and options.get("network") in {None, "lab"}:
                options["network"] = self.settings.incus.network
            incus.remove_device(name, device_name)
            incus.add_device(name, str(spec.get("type", "disk")), device_name, **options)
        incus.set_configs(name, entry.resolved_config())
        return entry

    def _apply_instance_spec(self, name: str, scenario) -> None:
        """Apply scenario-declared instance config and devices to a new instance."""
        incus = self._require_incus()
        if scenario.instance_config:
            incus.set_configs(name, scenario.instance_config)
        for device in scenario.instance_devices:
            options = {k: v for k, v in device.items() if k not in {"name", "type"}}
            # A nic device on a network name is the common case: resolve it to the
            # configured lab bridge so scenarios stay portable.
            if device.get("type") == "nic" and options.get("network") in {None, "lab"}:
                options["network"] = self.settings.incus.network
            incus.add_device(name, device["type"], device["name"], **options)

    # ------------------------------------------------------------------
    # warm pool
    # ------------------------------------------------------------------
    def _all_instances(self):
        return self._require_incus().list_instances()

    def _claimed_instances(self) -> set[str]:
        live = self.store.list_sessions(limit=2000)
        return {s.instance for s in live if s.instance and not s.state.is_terminal}

    def _pool_instances(self, scenario_id: str, instances=None) -> list:
        prefix = f"{self.settings.incus.pool_prefix}-{scenario_id}-"
        instances = instances if instances is not None else self._all_instances()
        return [i for i in instances if i.name.startswith(prefix)]

    def _available_pool(self, scenario_id: str, instances=None) -> list:
        claimed = self._claimed_instances()
        return [
            i
            for i in self._pool_instances(scenario_id, instances)
            if i.running and i.ipv4 and i.name not in claimed
        ]

    def _next_pool_index(self, scenario_id: str, instances=None) -> int:
        existing = self._pool_instances(scenario_id, instances)
        highest = 0
        prefix = f"{self.settings.incus.pool_prefix}-{scenario_id}-"
        for instance in existing:
            suffix = instance.name[len(prefix) :]
            if suffix.isdigit():
                highest = max(highest, int(suffix))
        return highest + 1

    def pool_status(self, scenario_id: str | None = None) -> list[PoolStatus]:
        incus = self.incus
        if incus is None:
            return []
        instances = self._all_instances()
        claimed = self._claimed_instances()
        rows: list[PoolStatus] = []
        for scenario in self.repo.list():
            if scenario_id and scenario.id != scenario_id:
                continue
            pool = self._pool_instances(scenario.id, instances)
            ready = len([i for i in pool if i.running and i.ipv4 and i.name not in claimed])
            owned = len([i for i in pool if i.name in claimed])
            template = self.settings.incus.template_name(scenario.id)
            rows.append(
                PoolStatus(
                    scenario_id=scenario.id,
                    target=self.settings.pool.target_for(scenario.id),
                    ready=ready,
                    claimed=owned,
                    total=len(pool),
                    template_ready=incus.has_snapshot(template, POOL_SNAPSHOT)
                    if incus.exists(template)
                    else False,
                )
            )
        return rows

    def prewarm(self, scenario_id: str, count: int) -> int:
        """Create ``count`` booted, unclaimed VMs for a scenario. Returns how many
        were actually created (bounded by ``pool.max_total``)."""
        self._require_incus()
        if count <= 0:
            return 0
        instances = self._all_instances()
        pool_total = sum(len(self._pool_instances(s.id, instances)) for s in self.repo.list())
        budget = max(0, self.settings.pool.max_total - pool_total)
        to_create = min(count, budget)
        if to_create == 0:
            self.store.log_event(
                "prewarm_skipped", f"{scenario_id}: pool at max_total={self.settings.pool.max_total}"
            )
            return 0
        created = 0
        index = self._next_pool_index(scenario_id, instances)
        for _ in range(to_create):
            name = self.settings.incus.pool_name(scenario_id, index)
            index += 1
            try:
                self._provision_pool_instance(scenario_id, name)
            except (SessionError, IncusError, GuestError) as exc:
                self.store.log_event("prewarm_failed", f"{scenario_id} {name}: {exc}")
                break
            created += 1
        if created:
            self.store.log_event("prewarmed", f"{scenario_id}: {created} VM(s)")
        return created

    def _provision_pool_instance(self, scenario_id: str, name: str) -> str:
        scenario = self.repo.get(scenario_id)
        self._require_incus()
        self._clone_from_template(scenario, name)
        session = Session(
            id=None,
            student=TEMPLATE_PSEUDO_STUDENT,
            scenario_id=scenario_id,
            state=SessionState.PROVISIONING,
            instance=name,
            rdp_user=self.settings.guest.user,
            rdp_password=self.settings.guest.password,
        )
        self._await_guest(session, self.settings.guest.ready_timeout_seconds)
        return name

    def refill_pool(self, scenario_ids: list[str] | None = None) -> dict[str, int]:
        """Top every scenario's pool back up to its configured target."""
        created: dict[str, int] = {}
        for status in self.pool_status():
            if scenario_ids and status.scenario_id not in scenario_ids:
                continue
            if status.deficit and status.template_ready:
                made = self.prewarm(status.scenario_id, status.deficit)
                if made:
                    created[status.scenario_id] = made
        return created

    def _clone_from_template(self, scenario, target_name: str) -> str:
        incus = self._require_incus()
        template = self.settings.incus.template_name(scenario.id)
        if not incus.exists(template) or not incus.has_snapshot(template, POOL_SNAPSHOT):
            raise SessionError(
                f"template {template} is missing snapshot {POOL_SNAPSHOT}; run "
                f"`ontrak template build {scenario.id}`"
            )
        incus.copy_instance(f"{template}/{POOL_SNAPSHOT}", target_name, instance_only=True)
        incus.start_instance(target_name)
        return target_name

    def _await_guest(self, session: Session, timeout: int) -> str:
        """Wait for an address, then for the guest transport to answer."""
        incus = self._require_incus()
        deadline = time.time() + timeout
        ip = ""
        while time.time() < deadline:
            ip = incus.instance_ip(session.instance) or ""
            if ip:
                break
            time.sleep(3)
        if not ip:
            raise SessionError(f"{session.instance} never obtained an address on {self.settings.incus.network}")
        session.host_ip = ip
        remaining = max(30, int(deadline - time.time()))
        if not self.driver.wait_ready(session, timeout=remaining):
            raise SessionError(
                f"{session.instance} at {ip} never became reachable over the "
                f"{self.driver.name} transport"
            )
        return ip

    # ------------------------------------------------------------------
    # scenario files
    # ------------------------------------------------------------------
    def _upload_scenario_files(self, session: Session, scenario, include_setup: bool) -> None:
        args = self._guest_args(session)
        lib = self._lib_source
        if lib.exists():
            self.driver.upload_file(lib, self._guest_path("lib", COMMON_LIB), **args)
        if include_setup:
            self.driver.upload_file(scenario.setup_script, self._guest_path("scenarios", scenario.id, "setup.ps1"), **args)
        self.driver.upload_file(scenario.check_script, self._guest_path("scenarios", scenario.id, "check.ps1"), **args)
        for resource in scenario.resources:
            source = scenario.directory / resource
            destination = self._guest_path("scenarios", scenario.id, "resources", resource.replace("/", "\\"))
            self.driver.upload_file(source, destination, **args)

    # ------------------------------------------------------------------
    # allocation
    # ------------------------------------------------------------------
    def create_session(
        self,
        student: str,
        scenario_id: str,
        *,
        workload: str | None = None,
        time_limit_minutes: int | None = None,
    ) -> Session:
        """Create the session row and return immediately.

        Split from :meth:`provision` so the portal can answer a browser instantly
        and do the slow part (clone + boot + WinRM handshake) in a worker thread
        while the page polls for progress. Idempotent per (student, scenario):
        reloading a page or re-running the CLI will not burn a second VM.

        ``time_limit_minutes`` is the student's clock for this session; it defaults
        to ``session.ttl_minutes`` and can be changed later (instructor action), which
        is why it is stored on the row rather than derived from config on read.
        """
        student = student.strip().lower()
        self.repo.get(scenario_id)  # raises ScenarioError if unknown
        if workload:
            entry = self.catalog.get(workload) if self.catalog else None
            if self.catalog and entry is None:  # pragma: no cover - defensive
                raise SessionError(f"unknown workload {workload!r}")
        limit = int(time_limit_minutes or self.settings.session.ttl_minutes)
        if limit <= 0:
            raise SessionError("the time limit must be a positive number of minutes")
        live = self.store.live_sessions_for(student)

        for existing in live:
            if existing.scenario_id == scenario_id and existing.state != SessionState.ERROR:
                self.touch(existing)
                return existing
        if len(live) >= self.settings.session.max_per_student:
            busy = ", ".join(sorted({s.scenario_id for s in live}))
            raise SessionError(
                f"{student} already has a live session ({busy}); reset or end it first "
                "(session.max_per_student)"
            )

        session = Session(
            id=None,
            student=student,
            scenario_id=scenario_id,
            state=SessionState.REQUESTED,
            rdp_user=self.settings.guest.user,
            rdp_password=self.settings.guest.password,
            expires_at=iso(utcnow() + timedelta(minutes=limit)),
            workload=str(workload or ""),
            time_limit_minutes=limit,
        )
        self.store.create_session(session)
        self.store.log_event(
            "requested",
            f"{student} requested {scenario_id}"
            + (f" on workload {workload}" if workload else "")
            + f" with a {limit} minute limit",
            session.id,
        )
        return session

    def set_time_limit(self, session: Session, minutes: int) -> Session:
        """Set or change a student's time limit mid-session."""
        minutes = int(minutes)
        if minutes <= 0:
            raise SessionError("the time limit must be a positive number of minutes")
        session.set_time_limit(minutes)
        self.store.save_session(session)
        self.store.log_event("time_limit_set", f"{minutes} min", session.id)
        return session

    def extend_limit(self, session: Session, minutes: int) -> Session:
        """Grant extra time as a delta ("+15 minutes")."""
        return self.extend(session, int(minutes))

    def _lock_for(self, session: Session) -> threading.Lock:
        key = session.id or 0
        with self._lock_guard:
            return self._session_locks.setdefault(key, threading.Lock())

    def provision(self, session: Session) -> Session:
        """Bring a requested session up: claim a pooled VM or clone the template.

        Blocking, and serialised per session. The state is re-read from the store
        *inside* the lock, so a second caller (a page reload, an instructor, the
        CLI) waits for the first to finish and then returns the same session
        instead of cloning a second VM.
        """
        with self._lock_for(session):
            fresh = self.store.get_session(session.id) if session.id else None
            target = fresh or session
            if target.state not in {SessionState.REQUESTED, SessionState.ALLOCATING}:
                return target
            return self._provision_locked(target)

    def _provision_locked(self, session: Session) -> Session:
        scenario = self.repo.get(session.scenario_id)
        session.state = SessionState.ALLOCATING
        self.store.save_session(session)

        try:
            if not self._claim_pool(session):
                name = self.settings.incus.session_name(scenario.id, session.id or "x")
                self._clone_from_template(scenario, name)
                session.instance = name
                self.store.save_session(session)
                self.store.log_event("cloned", name, session.id)
            self._await_guest(session, self.settings.guest.ready_timeout_seconds)
            if self.settings.session.randomize_credentials:
                self._rotate_credentials(session)
            session.state = SessionState.READY
            session.ready_at = iso()
            session.last_activity_at = iso()
            self.store.save_session(session)
            self.store.log_event("ready", f"{session.instance} at {session.host_ip}", session.id)
        except Exception as exc:  # noqa: BLE001 - surfaced to the student verbatim
            session.state = SessionState.ERROR
            session.error = str(exc)
            self.store.save_session(session)
            self.store.log_event("provision_failed", str(exc), session.id)
        return session

    def allocate(
        self,
        student: str,
        scenario_id: str,
        *,
        workload: str | None = None,
        time_limit_minutes: int | None = None,
    ) -> Session:
        """Create and provision in one call. Returns a READY or ERROR session."""
        return self.provision(
            self.create_session(
                student,
                scenario_id,
                workload=workload,
                time_limit_minutes=time_limit_minutes,
            )
        )

    def _claim_pool(self, session: Session) -> str | None:
        available = self._available_pool(session.scenario_id)
        if not available:
            return None
        # Lowest name first: it has been idle longest and its page cache is cold.
        chosen = min(available, key=lambda instance: instance.name)
        session.instance = chosen.name
        session.host_ip = chosen.ipv4
        session.state = SessionState.PROVISIONING
        self.store.save_session(session)
        self.store.log_event("claimed_pool", chosen.name, session.id)
        return chosen.name

    def _rotate_credentials(self, session: Session) -> None:
        alphabet = string.ascii_letters + string.digits + "!@#%*+=?"
        password = "".join(secrets.choice(alphabet) for _ in range(20))
        script = (
            f"$p = ConvertTo-SecureString {quote_ps(password)} -AsPlainText -Force;"
            f"Set-LocalUser -Name {quote_ps(self.settings.guest.user)} -Password $p;"
            "'rotated'"
        )
        result = self.driver.run_powershell(script, timeout=60, **self._guest_args(session))
        if result.ok:
            session.rdp_password = password
        else:
            self.store.log_event(
                "credential_rotation_failed",
                (result.stderr or result.stdout)[-400:],
                session.id,
            )

    # ------------------------------------------------------------------
    # using a session
    # ------------------------------------------------------------------
    def claim_for_use(self, session: Session) -> Session:
        """Mark a session in use (student opened the console)."""
        if session.state in {SessionState.READY, SessionState.PASSED}:
            session.state = SessionState.IN_USE
        self.touch(session)
        self.store.save_session(session)
        return session

    def touch(self, session: Session) -> None:
        session.last_activity_at = iso()
        if session.id:
            self.store.update_session(session.id, last_activity_at=session.last_activity_at)

    def extend(self, session: Session, minutes: int) -> Session:
        session.extend(minutes)
        self.store.save_session(session)
        self.store.log_event("extended", f"+{minutes} min", session.id)
        return session

    def reveal_hint(self, session: Session, scenario=None) -> Session:
        scenario = scenario or self.repo.get(session.scenario_id)
        if session.hint_level < len(scenario.hints):
            session.hint_level += 1
            self.store.save_session(session)
            self.store.log_event("hint", f"level {session.hint_level}", session.id)
        return session

    def run_checks(self, session: Session, record: bool | None = None) -> ScoreReport:
        """Grade the current VM state against the scenario.

        ``record`` decides whether this attempt is written to the results table.
        By default it follows ``session.persist_progress``: a student may check
        their work as often as they like, but only the grade they hand in at
        "Complete & End" is kept, so nothing is scored on progress.
        """
        if record is None:
            record = bool(self.settings.session.persist_progress)
        scenario = self.repo.get(session.scenario_id)
        if not session.instance:
            report = ScoreReport(
                session_id=session.id or 0,
                scenario_id=session.scenario_id,
                error="session has no VM",
            )
            return report

        session.state = SessionState.CHECKING
        self.store.save_session(session)
        try:
            self._upload_scenario_files(session, scenario, include_setup=False)
            result = self.driver.run_script_file(
                self._guest_path("scenarios", scenario.id, "check.ps1"),
                timeout=self.settings.session.check_timeout_seconds,
                **self._guest_args(session),
            )
            report = evaluate(scenario, session.id or 0, (result.stdout or "") + "\n" + (result.stderr or ""))
            if not result.ok and not report.outcomes:
                report.notes.append(f"check script exited {result.exit_code}")
        except (GuestError, IncusError, SessionError) as exc:
            report = ScoreReport(
                session_id=session.id or 0,
                scenario_id=session.scenario_id,
                error=f"could not run checks: {exc}",
            )

        session.checks_run += 1
        session.last_activity_at = iso()
        if not report.error:
            session.best_score = max(session.best_score, report.score)
            if report.resolved:
                session.resolved = True
        # The VM stays usable either way: a failed check is a coaching moment, not
        # a dead end. Resolution is sticky once earned.
        session.state = SessionState.PASSED if session.resolved else SessionState.IN_USE
        self.store.save_session(session)
        if session.id:
            if record:
                self.store.add_result(report, session.student)
            self.store.log_event(
                "checked" if record else "checked_discarded", report.summary_line(), session.id
            )
        session.last_report = report
        return report

    def complete(self, session: Session) -> ScoreReport:
        """The student's "Complete & End": grade once, keep the result, destroy the VM.

        This is the only grading run whose outcome is stored. After it the session is
        terminal, the instance is gone, and the student gets a fresh machine next time
        — which is also what makes a reset unnecessary to be perfectly clean.
        """
        if session.state.is_terminal:
            raise SessionError(
                f"session {session.id} is already {session.state.value}; there is nothing to complete"
            )
        report = self.run_checks(session, record=True)
        scenario = self.repo.get(session.scenario_id)
        report.resolved = bool(report.resolved)
        report.notes.append(f"final submission judged against {scenario.title}")
        session.state = SessionState.PASSED if report.resolved else SessionState.FAILED
        session.resolved = bool(report.resolved)
        session.notes = (session.notes + " [completed]").strip()
        self.store.save_session(session)
        self.store.log_event("completed", report.summary_line(), session.id)
        self._destroy_instance(session.instance)
        session.instance = ""
        session.host_ip = ""
        self.store.save_session(session)
        session.last_report = report
        return report

    def drain_pool(self, scenario_id: str) -> int:
        """Delete unclaimed pooled VMs for a scenario (end of a class window).

        Only unclaimed instances go: a student still working keeps their machine.
        Returns the number destroyed.
        """
        if self.incus is None:
            return 0
        removed = 0
        for instance in self._available_pool(scenario_id):
            self._destroy_instance(instance.name)
            removed += 1
        if removed:
            self.store.log_event("pool_drained", f"{scenario_id}: {removed} VM(s)")
        return removed

    # ------------------------------------------------------------------
    # reset / recycle
    # ------------------------------------------------------------------
    def reset(self, session: Session) -> Session:
        """Throw the VM away and hand back a fresh clone of the clean snapshot."""
        if session.state.is_terminal:
            raise SessionError(f"session {session.id} is {session.state.value} and cannot be reset")
        scenario = self.repo.get(session.scenario_id)
        session.state = SessionState.RECYCLING
        session.error = ""
        self.store.save_session(session)

        self._destroy_instance(session.instance)
        session.instance = ""
        session.host_ip = ""
        self.store.save_session(session)

        try:
            if not self._claim_pool(session):
                name = self.settings.incus.session_name(session.scenario_id, session.id or "x")
                self._clone_from_template(scenario, name)
                session.instance = name
                self.store.save_session(session)
            self._await_guest(session, self.settings.guest.ready_timeout_seconds)
            if self.settings.session.randomize_credentials:
                self._rotate_credentials(session)
            session.state = SessionState.READY
            session.ready_at = iso()
            session.last_activity_at = iso()
            self.store.log_event("reset", f"{session.instance} at {session.host_ip}", session.id)
        except Exception as exc:  # noqa: BLE001
            session.state = SessionState.ERROR
            session.error = f"reset failed: {exc}"
            self.store.log_event("reset_failed", str(exc), session.id)
        self.store.save_session(session)
        return session

    def recycle(self, session: Session, reason: str = "expired") -> None:
        """Destroy the VM and close the session (student's time is up)."""
        session.state = SessionState.RECYCLING
        self.store.save_session(session)
        self._destroy_instance(session.instance)
        session.state = SessionState.DESTROYED
        session.host_ip = ""
        session.notes = (session.notes + f" [{reason}]").strip()
        session.last_activity_at = iso()
        self.store.save_session(session)
        self.store.log_event("recycled", reason, session.id)

    def end(self, session: Session, reason: str = "student quit") -> None:
        self.recycle(session, reason=reason)

    def _destroy_instance(self, name: str) -> None:
        if not name or self.incus is None:
            return
        try:
            if self.incus.exists(name):
                self.incus.stop_instance(name, force=True, timeout=60)
                self.incus.delete_instance(name, force=True)
        except IncusError as exc:
            self.store.log_event("destroy_failed", f"{name}: {exc}")

    # ------------------------------------------------------------------
    # maintenance
    # ------------------------------------------------------------------
    def reap(self) -> dict:
        """Expire sessions and top the pool back up. Safe to run in a loop."""
        recycled: list[int] = []
        for session in self.store.list_sessions(
            states=[
                SessionState.READY,
                SessionState.IN_USE,
                SessionState.PASSED,
                SessionState.FAILED,
                SessionState.CHECKING,
            ]
        ):
            if session.is_expired:
                self.recycle(session, reason="ttl_expired")
                recycled.append(session.id or 0)
                continue
            idle_for = seconds_since(session.last_activity_at) or 0
            if idle_for > self.settings.session.idle_recycle_minutes * 60:
                # Never reap a grading run in flight.
                if session.state == SessionState.CHECKING:
                    continue
                self.recycle(session, reason=f"idle_{int(idle_for // 60)}m")
                recycled.append(session.id or 0)

        # Stale ERROR/ALLOCATING rows: surface them for the instructor but do not
        # keep half-built instances around forever.
        for session in self.store.list_sessions(states=[SessionState.ALLOCATING, SessionState.PROVISIONING]):
            if (seconds_since(session.created_at) or 0) > self.settings.pool.claim_timeout_seconds * 4:
                self._destroy_instance(session.instance)
                session.state = SessionState.ERROR
                session.error = session.error or "provisioning timed out"
                session.instance = ""
                self.store.save_session(session)

        refilled = {} if not self.settings.pool.enabled else self.refill_pool()
        return {"recycled": recycled, "refilled": refilled}

    def stats(self) -> dict:
        state_counts = {
            state.value: self.store.count_sessions(states=[state]) for state in SessionState
        }
        return {
            "sessions": state_counts,
            "students": len(self.store.list_users("student")),
            "pool": [
                {**status.__dict__, "deficit": status.deficit, "healthy": status.healthy}
                for status in self.pool_status()
            ],
            "templates": self.template_status(),
        }

    # ------------------------------------------------------------------
    # lookups
    # ------------------------------------------------------------------
    def get_owned_session(self, student: str, session_id: int, allow_instructor: bool = False) -> Session:
        session = self.store.get_session(session_id)
        if session is None:
            raise SessionError(f"session {session_id} not found")
        if not allow_instructor and session.student != student.strip().lower():
            raise SessionError(f"session {session_id} belongs to another student")
        return session

    def session_age_minutes(self, session: Session) -> float:
        started = parse_iso(session.ready_at) or parse_iso(session.created_at) or utcnow()
        return (utcnow() - started).total_seconds() / 60.0
