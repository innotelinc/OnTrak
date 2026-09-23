from __future__ import annotations

import json
from datetime import timedelta

import pytest

from ontrak.guest import NullDriver
from ontrak.incus import IncusError
from ontrak.models import ScoreReport, Session, SessionState, iso, parse_iso, utcnow
from ontrak.scenarios import JSON_BEGIN, JSON_END, SETUP_OK_MARKER
from ontrak.sessions import POOL_SNAPSHOT, SessionError, SessionManager
from tests.helpers import synthesise_ticket

SCENARIO = "net-dns-failure"
OBJECTIVES = ["restore-resolver", "resolve-intranet", "reach-service"]


def payload(**passed: object) -> str:
    checks = [{"objective": key, "passed": value, "detail": f"{key}={value}"} for key, value in passed.items()]
    return f"{JSON_BEGIN}{json.dumps({'checks': checks})}{JSON_END}"


def full_pass() -> str:
    return payload(**{objective: True for objective in OBJECTIVES})


def partial() -> str:
    return payload(**{"restore-resolver": True, "resolve-intranet": False, "reach-service": False})


def manager_with(settings, store, repo, incus, responses: dict[str, str]) -> SessionManager:
    return SessionManager(
        settings, store, repo=repo, incus=incus, driver=NullDriver(settings, responses=responses)
    )


# --------------------------------------------------------------------------- #
# templates
# --------------------------------------------------------------------------- #
def settings_template(manager) -> str:
    return manager.settings.incus.template_name(SCENARIO)


def test_template_build_injects_the_fault_and_snapshots(manager, incus, settings):
    name = manager.ensure_template(SCENARIO)
    assert name == settings.incus.template_name(SCENARIO)
    assert incus.exists(name)
    assert incus.has_snapshot(name, POOL_SNAPSHOT)
    assert incus.instance_status(name) == "STOPPED"  # a snapshot is of a machine at rest


def test_a_template_build_lets_the_guest_flush_before_it_snapshots(manager, incus, settings):
    """The build must not power-cut a guest it reconfigured seconds earlier.

    A hard stop is a *disk* event as much as a power one: the injected fault was
    written moments before and can still be sitting in the guest's write-back cache,
    so `stop --force` snapshots the state from *before* the fault. The template then
    builds clean, every clone boots healthy, and the scenario grades an untouched
    machine at full marks — which is what happened, silently, on every Windows
    template, because nothing about the scenario had moved for the recipe to notice.
    """
    name = manager.ensure_template(SCENARIO)
    stops = [call for call in incus.calls if call[0] == "power_off_instance"]
    assert stops, incus.calls
    # Before the snapshot, so what is captured is the state the guest committed.
    assert incus.calls.index(("power_off_instance", name)) < incus.calls.index(
        ("create_snapshot", name, POOL_SNAPSHOT)
    )


def test_an_unknown_scenario_id_is_reported_rather_than_skipped(manager):
    """A typo used to print nothing at all and exit 0.

    An operator who asks for a template that does not exist was told nothing, which
    reads exactly like a build that happened. The rest of the request still runs.
    """
    results = manager.build_templates([SCENARIO, "net-dns-fialure"])
    assert results["net-dns-fialure"].startswith("failed: unknown scenario")
    assert "net-dns-failure" in results["net-dns-fialure"], results["net-dns-fialure"]
    assert [key for key, status in results.items() if status == "ready"], results


def test_template_build_is_idempotent(manager, incus):
    first = manager.ensure_template(SCENARIO)
    copies_before = len([c for c in incus.calls if c[0] == "create_instance"])
    again = manager.ensure_template(SCENARIO)
    assert first == again
    assert len([c for c in incus.calls if c[0] == "create_instance"]) == copies_before


def test_template_build_can_be_forced(manager, incus, settings):
    manager.ensure_template(SCENARIO)
    manager.ensure_template(SCENARIO, force=True)
    assert len([c for c in incus.calls if c[0] == "delete_instance"]) >= 1
    assert incus.has_snapshot(settings.incus.template_name(SCENARIO), POOL_SNAPSHOT)


def test_template_build_fails_loudly_when_setup_does_not_confirm(settings, store, repo, incus):
    manager = manager_with(settings, store, repo, incus, responses={})  # no ONTRAK-SETUP-OK
    with pytest.raises(SessionError, match="ONTRAK-SETUP-OK"):
        manager.ensure_template(SCENARIO)
    assert not incus.has_snapshot(settings.incus.template_name(SCENARIO), POOL_SNAPSHOT)
    assert incus.instance_status(settings.incus.template_name(SCENARIO)) == "STOPPED"


def test_a_setup_that_breaks_its_own_transport_is_confirmed_by_the_marker_file(
    settings, store, repo
):
    """A fault may end the session it is injected over, and the build must cope.

    ``net-static-ip-conflict`` re-addresses the adapter, which terminates the WinRM
    session running setup.ps1: the build hears a read timeout with no marker on
    stdout, and used to throw away a correctly applied fault. Both helper libraries
    also write the marker to a file beside the scenario library, so the build
    re-reads it -- and has to look at the address the guest moved to, not the one
    the script started from.
    """
    from ontrak.guest import CommandResult

    from .helpers import FakeIncus

    class ReadressedIncus(FakeIncus):
        """The guest's address changes while setup runs, as the fault intends."""

        readdressed = False

        def instance_ip(self, name):
            if self.readdressed:
                return "10.20.0.5"
            return super().instance_ip(name)

    class TransportLost(NullDriver):
        """Setup dies with the session; only the marker file answers afterwards."""

        def __init__(self, settings, incus):
            super().__init__(settings)
            self.incus = incus

        def run_script_file(self, remote_path, host="", instance="", timeout=300):
            self.incus.readdressed = True
            return CommandResult(False, 1, "", "WinRM read timeout: the connection was reset")

        def run_powershell(self, script, host="", instance="", timeout=120):
            if "Get-Content" in script and host == "10.20.0.5":
                return CommandResult(True, 0, f"{SETUP_OK_MARKER}\nstatic=10.20.0.5")
            return CommandResult(True, 0, "")

    incus = ReadressedIncus()
    manager = SessionManager(
        settings, store, repo=repo, incus=incus, driver=TransportLost(settings, incus)
    )

    name = manager.ensure_template(SCENARIO)

    assert incus.has_snapshot(name, POOL_SNAPSHOT)
    kinds = {row["kind"] for row in store.list_events(limit=50)}
    assert "guest_readdressed" in kinds
    assert "setup_confirmed_by_file" in kinds


def test_the_marker_lookup_keeps_trying_while_the_guest_comes_back(
    settings, store, repo, monkeypatch
):
    """A re-addressed guest answers late, and the build has to wait for it.

    Measured on a real host: after net-static-ip-conflict moves the adapter, port 5985
    on the new address refuses connections for a while and then simply works. A
    single-shot probe reads that as "the file is not there" and throws the fault away.
    """
    import ontrak.sessions as sessions_module
    from ontrak.guest import CommandResult

    from .helpers import FakeIncus

    monkeypatch.setattr(sessions_module, "SETUP_OK_POLL_SECONDS", 0.02)
    settings.session.setup_ok_grace_seconds = 1

    class SlowToAnswer(NullDriver):
        def __init__(self, settings):
            super().__init__(settings)
            self.probes = 0

        def run_powershell(self, script, host="", instance="", timeout=120):
            if "Get-Content" in script:
                self.probes += 1
                if self.probes >= 3:
                    return CommandResult(True, 0, SETUP_OK_MARKER)
                return CommandResult(False, 1, "", "connection timed out")
            return CommandResult(True, 0, "")

        def run_script_file(self, remote_path, host="", instance="", timeout=300):
            return CommandResult(False, 1, "", "WinRM read timeout: the connection was reset")

    incus = FakeIncus()
    driver = SlowToAnswer(settings)
    manager = SessionManager(settings, store, repo=repo, incus=incus, driver=driver)

    name = manager.ensure_template(SCENARIO)
    assert incus.has_snapshot(name, POOL_SNAPSHOT)
    assert driver.probes >= 3, "the build gave up before the guest answered"


def test_a_setup_that_never_confirms_is_not_rescued_by_a_stale_marker_file(
    settings, store, repo
):
    """The fallback must not become a rubber stamp: no file, no snapshot."""
    from ontrak.guest import CommandResult

    from .helpers import FakeIncus

    class NoMarker(NullDriver):
        def run_script_file(self, remote_path, host="", instance="", timeout=300):
            return CommandResult(False, 1, "injection failed", "")

        def run_powershell(self, script, host="", instance="", timeout=120):
            return CommandResult(True, 0, "")  # nothing was ever written

    incus = FakeIncus()
    manager = SessionManager(
        settings, store, repo=repo, incus=incus, driver=NoMarker(settings)
    )
    with pytest.raises(SessionError, match="ONTRAK-SETUP-OK"):
        manager.ensure_template(SCENARIO)
    assert not incus.has_snapshot(settings.incus.template_name(SCENARIO), POOL_SNAPSHOT)


def test_template_build_requires_the_golden_image(settings, store, repo):
    from .helpers import FakeIncus

    incus = FakeIncus(image_alias=settings.incus.image_alias, image_present=False)
    manager = manager_with(settings, store, repo, incus, responses={"setup.ps1": "ONTRAK-SETUP-OK"})
    with pytest.raises(SessionError, match="golden image"):
        manager.ensure_template(SCENARIO)


def test_scenario_declared_devices_are_attached_to_the_template(manager, incus, settings):
    name = manager.ensure_template("hw-driver-device")
    devices = [d for d in incus.devices if d[0] == name]
    assert devices, "the hardware scenario needs its second NIC attached before first boot"
    _, kind, device_name, options = devices[0]
    assert (kind, device_name) == ("nic", "eth1")
    assert options["network"] == settings.incus.network


def test_a_windows_image_that_demands_an_agent_disk_gets_one(settings, store, repo):
    """A template must carry the agent disk its image insists on, before boot.

    A Windows image published by incus-windows is created with
    ``requirements.cdrom_agent=true``, and Incus enforces it at *start*, not at
    create: `incus init` succeeds, then `incus start` answers "This virtual machine
    image requires an agent:config disk be added" and the instance stays STOPPED.
    That is why every Windows template build died while the Linux ones were fine,
    so the device has to be attached at creation time.
    """
    from .helpers import FakeIncus

    incus = FakeIncus(image_alias="ontrak-win-base", requires_agent_disk=True)
    driver = NullDriver(settings, responses={"setup.ps1": SETUP_OK_MARKER})
    manager = SessionManager(settings, store, repo=repo, incus=incus, driver=driver)

    name = manager.ensure_template(SCENARIO)
    disks = [d for d in incus.devices if d[0] == name and d[2] == "agent"]
    assert disks, "the Windows image refuses to start without an agent:config disk"
    assert disks[0][3] == {"source": "agent:config"}


def test_an_image_that_asks_for_nothing_gets_no_extra_device(settings, store, repo):
    """Linux images ask for no agent disk, and must not be given one."""
    from .helpers import FakeIncus

    incus = FakeIncus(image_alias="ontrak-win-base", requires_agent_disk=False)
    driver = NullDriver(settings, responses={"setup.ps1": SETUP_OK_MARKER})
    manager = SessionManager(settings, store, repo=repo, incus=incus, driver=driver)

    name = manager.ensure_template(SCENARIO)
    assert not [d for d in incus.devices if d[0] == name and d[2] == "agent"]


def test_build_templates_reports_per_scenario_results(manager):
    results = manager.build_templates(["net-dns-failure", "sw-app-crash"])
    assert results == {"net-dns-failure": "ready", "sw-app-crash": "ready"}


# --------------------------------------------------------------------------- #
# availability — refusing a scenario the range cannot start
# --------------------------------------------------------------------------- #
# A student who started a scenario the range could not run used to end up with a
# session row whose entire content was `template tpl-sw-app-crash is missing
# snapshot clean` — an operator's message, delivered after a slot was spent. The
# availability check is what turns that into a refusal they can act on, so it is
# tested for both the refusal and the two ways it must stay silent.
#
def test_a_built_template_is_available(manager, built_template):
    assert manager.scenario_availability(SCENARIO) == ""


def test_a_scenario_with_no_template_is_refused_by_name(manager, incus):
    reason = manager.scenario_availability("sw-app-crash")
    assert reason.startswith("sw-app-crash is not available on this range yet")
    # The repair is named, because "unavailable" without a next step is just a wall.
    assert "tpl-sw-app-crash" in reason
    assert "ontrak template build sw-app-crash" in reason


def test_a_missing_golden_image_is_named_as_the_cause(manager, incus):
    """The Windows scenarios layer differently from the Linux ones: none of them
    has a template, and building one template would not fix any of them."""
    incus.image_present = False
    reason = manager.scenario_availability("sw-app-crash")
    assert "ontrak-win-base" in reason
    assert "build-golden-image.sh" in reason


def test_a_waiting_pooled_machine_makes_a_scenario_available(manager, incus, settings):
    """No template, but a booted machine already in the pool: the session can run,
    so refusing it would be wrong."""
    incus.add_instance(settings.incus.pool_name("sw-app-crash", 1), running=True)
    assert manager.scenario_availability("sw-app-crash") == ""


def test_an_unreachable_hypervisor_is_not_a_missing_template(manager, incus):
    """An Incus outage cannot prove a scenario is unrunnable, only that we cannot
    tell — refusing every scenario would be a worse failure than the outage."""
    incus.exists = _boom  # type: ignore[method-assign]
    assert manager.scenario_availability("sw-app-crash") == ""
    assert manager.unavailable_scenarios() == {}


def test_unavailable_scenarios_lists_what_cannot_start(manager, incus, built_template):
    reasons = manager.unavailable_scenarios()
    assert SCENARIO not in reasons  # its template is built
    assert "sw-app-crash" in reasons


def _boom(*args, **kwargs):
    raise IncusError(["list", "--format=json"], 1, "The incus daemon doesn't appear to be started")


# --------------------------------------------------------------------------- #
# allocation
# --------------------------------------------------------------------------- #
def test_allocate_clones_the_template_and_reaches_ready(manager, incus, built_template, settings):
    session = manager.allocate("Alice", SCENARIO)
    assert session.state is SessionState.READY
    assert session.student == "alice"
    assert session.instance == settings.incus.session_name(SCENARIO, session.id)
    assert session.host_ip
    assert session.expires_at and parse_iso(session.expires_at) > utcnow()


def test_allocate_claims_a_prewarmed_pool_vm(manager, incus, settings):
    pooled = settings.incus.pool_name(SCENARIO, 1)
    incus.add_instance(pooled, running=True, ip="10.20.0.77")
    session = manager.allocate("bob", SCENARIO)
    assert session.state is SessionState.READY
    assert session.instance == pooled
    assert session.host_ip == "10.20.0.77"
    # no clone was needed
    assert not [c for c in incus.calls if c[0] == "copy_instance"]


def test_allocate_is_idempotent_per_student_and_scenario(manager, built_template):
    first = manager.allocate("alice", SCENARIO)
    second = manager.allocate("alice", SCENARIO)
    assert first.id == second.id


def test_starting_again_does_not_revive_an_expired_session(manager, store, incus, built_template):
    first = manager.allocate("alice", SCENARIO)
    store.update_session(first.id, expires_at=iso(utcnow() - timedelta(minutes=1)))

    second = manager.allocate("alice", SCENARIO)

    assert second.id != first.id
    assert second.state is SessionState.READY
    assert second.seconds_remaining() > 0
    assert store.get_session(first.id).state is SessionState.DESTROYED
    assert not incus.exists(first.instance)


def test_allocate_enforces_one_session_per_student(manager, incus, built_template):
    manager.allocate("alice", SCENARIO)
    with pytest.raises(SessionError, match="already has a live session"):
        manager.allocate("alice", "sw-app-crash")


def test_a_missing_template_is_built_for_the_session_that_needs_it(manager, incus):
    """A template is a snapshot, so it goes stale — and a session heals it.

    This used to be an error naming `ontrak template build` for somebody else to run,
    which leaves the student holding a dead session either way. The useful answer is
    the machine.
    """
    session = manager.allocate("alice", "sw-app-crash")
    assert session.state is SessionState.READY, session.error
    template = manager.settings.incus.template_name("sw-app-crash")
    assert incus.has_snapshot(template, POOL_SNAPSHOT)


def test_a_template_that_cannot_be_built_still_reports_an_error_session(settings, store, repo, incus):
    """Auto-heal must not paper over a build that genuinely failed."""
    # A guest that never confirms the fault was injected: the build refuses to
    # snapshot, exactly as it would on a real host.
    manager = SessionManager(
        settings, store, repo=repo, incus=incus,
        driver=NullDriver(settings, responses={}),
    )
    session = manager.allocate("alice", "sw-app-crash")
    assert session.state is SessionState.ERROR
    assert "ONTRAK-SETUP-OK" in session.error


def test_allocate_marks_a_failed_guest_handshake(settings, store, repo, incus, built_template):
    class NeverReady(NullDriver):
        def wait_ready(self, session, timeout=None):  # noqa: D102 - test double
            return False

    manager = SessionManager(
        settings, store, repo=repo, incus=incus,
        driver=NeverReady(settings, responses={"setup.ps1": "ONTRAK-SETUP-OK"}),
    )
    session = manager.allocate("alice", SCENARIO)
    assert session.state is SessionState.ERROR
    assert "never became reachable" in session.error
    # The machine is up and quiet, which is exactly what the plain message is for: the
    # guest's own state must not be guessed at when there is nothing wrong with it.
    assert "the machine is" not in session.error


def test_a_guest_the_host_killed_is_reported_as_a_machine_that_stopped(
    settings, store, repo, incus, built_template
):
    """A silent guest must not send an operator to WinRM over a machine that is gone.

    Session #22 of a live range failed with "never became reachable over the winrm
    transport", and nothing was wrong with the transport, the golden image or the port:
    the host had three 4 GiB guests resident on 7.8 GiB of RAM, and its global OOM killer
    took that guest's QEMU process mid-boot. Both cases leave the guest silent, so the
    message carries the one fact that tells them apart — what Incus says the machine is
    doing.
    """

    class KilledGuest(NullDriver):
        """The machine stops under the transport, the way an OOM kill reaches it."""

        def __init__(self, settings, incus):
            super().__init__(settings, responses={"setup.ps1": "ONTRAK-SETUP-OK"})
            self.incus = incus

        def wait_ready(self, session, timeout=None):
            self.incus.instances[session.instance]["status"] = "STOPPED"
            return False

    manager = SessionManager(
        settings, store, repo=repo, incus=incus, driver=KilledGuest(settings, incus)
    )
    session = manager.allocate("alice", SCENARIO)
    assert session.state is SessionState.ERROR
    assert "never became reachable" in session.error
    assert "the machine is stopped" in session.error
    assert "out of memory" in session.error
    assert "ontrak doctor" in session.error


def test_a_guest_that_vanished_is_reported_as_gone(settings, store, repo, incus, built_template):
    """No instance at all is a different sentence again, and not a silent empty one."""

    class Vanished(NullDriver):
        def __init__(self, settings, incus):
            super().__init__(settings, responses={"setup.ps1": "ONTRAK-SETUP-OK"})
            self.incus = incus

        def wait_ready(self, session, timeout=None):
            del self.incus.instances[session.instance]
            return False

    manager = SessionManager(settings, store, repo=repo, incus=incus, driver=Vanished(settings, incus))
    session = manager.allocate("alice", SCENARIO)
    assert session.state is SessionState.ERROR
    assert "the machine is gone" in session.error


def test_randomised_credentials_are_applied_when_enabled(settings, store, repo, incus, built_template):
    settings.session.randomize_credentials = True
    manager = manager_with(settings, store, repo, incus, {"setup.ps1": "ONTRAK-SETUP-OK"})
    session = manager.allocate("alice", SCENARIO)
    assert session.state is SessionState.READY
    assert session.rdp_password != settings.guest.password
    assert len(session.rdp_password) >= 16


# --------------------------------------------------------------------------- #
# warm pool
# --------------------------------------------------------------------------- #
def test_prewarm_creates_booted_unclaimed_vms(manager, incus, built_template):
    created = manager.prewarm(SCENARIO, 3)
    assert created == 3
    status = manager.pool_status(SCENARIO)[0]
    assert status.ready == 3
    assert status.total == 3
    assert status.claimed == 0
    assert all(incus.instance_status(name) == "RUNNING" for name in incus.instances if "pool" in name)


def test_prewarm_respects_max_total(manager, incus, built_template, settings):
    assert settings.pool.max_total == 4
    assert manager.prewarm(SCENARIO, 10) == 4
    assert manager.prewarm(SCENARIO, 5) == 0


def test_refill_tops_up_to_the_configured_target(settings, store, repo, incus, built_template):
    settings.pool.targets = {SCENARIO: 2}
    manager = manager_with(settings, store, repo, incus, {"setup.ps1": "ONTRAK-SETUP-OK"})
    created = manager.refill_pool()
    assert created == {SCENARIO: 2}
    assert manager.refill_pool() == {}  # already at target
    assert manager.pool_status(SCENARIO)[0].deficit == 0


def test_refill_does_not_over_create_while_students_hold_the_pool(settings, store, repo, incus, built_template):
    """A full class must not trigger a second wave of VMs.

    The claimed instances keep their pool names and count against the target, so
    the host never has to hold `students + target` Windows VMs at once.
    """
    settings.pool.targets = {SCENARIO: 2}
    manager = manager_with(settings, store, repo, incus, {"setup.ps1": "ONTRAK-SETUP-OK"})
    assert manager.prewarm(SCENARIO, 2) == 2

    alice = manager.allocate("alice", SCENARIO)
    bob = manager.allocate("bob", SCENARIO)
    assert {alice.instance, bob.instance} == {settings.incus.pool_name(SCENARIO, 1), settings.incus.pool_name(SCENARIO, 2)}

    status = manager.pool_status(SCENARIO)[0]
    assert (status.target, status.total, status.ready, status.claimed) == (2, 2, 0, 2)
    assert status.deficit == 0
    assert status.shortfall == 2  # nothing on the shelf, but that is not capacity
    assert manager.refill_pool() == {}
    assert len([name for name in incus.instances if "pool" in name]) == 2

    # once a session ends, the slot is refilled for the next student
    manager.end(alice)
    assert manager.refill_pool() == {SCENARIO: 1}


def test_pool_status_reports_missing_templates(manager, incus):
    rows = {row.scenario_id: row for row in manager.pool_status()}
    assert rows[SCENARIO].template_ready is False
    manager.ensure_template(SCENARIO)
    rows = {row.scenario_id: row for row in manager.pool_status()}
    assert rows[SCENARIO].template_ready is True


# --------------------------------------------------------------------------- #
# grading
# --------------------------------------------------------------------------- #
def test_checks_grade_a_passing_attempt(settings, store, repo, incus, built_template):
    manager = manager_with(settings, store, repo, incus, {"setup.ps1": "ONTRAK-SETUP-OK", "check.ps1": full_pass()})
    session = manager.allocate("alice", SCENARIO)
    assert session.instance  # claimed the pooled entry from the fixture

    report = manager.run_checks(session)
    assert report.score == 100.0
    assert report.resolved is True
    # The achievement is kept, the *state* is not touched: `passed` is what a submitted
    # session is, and a practice check submits nothing. Writing it here took the
    # console, the write-up and the hand-in button off a student's page while their
    # machine was still running (see test_a_practice_check_does_not_submit_the_session).
    assert session.state is SessionState.IN_USE
    assert session.resolved is True
    assert session.best_score == 100.0
    assert session.checks_run == 1
    # Results-only policy: a preview check gives the student feedback but is not
    # recorded. Only Complete & End stores a result.
    assert store.attempt_counts(session.id) == 0
    assert store.latest_report(session.id) is None

    final = manager.complete(session, values=synthesise_ticket(manager.ticket_form_for(session)))
    assert final.score == 100.0
    assert final.resolved is True
    assert session.state is SessionState.PASSED
    assert store.attempt_counts(session.id) == 1
    # The machine is destroyed on submission: nothing is left to tamper with.
    assert incus.exists(session.instance) is False
    assert session.instance == "" and session.host_ip == ""


def test_a_practice_check_does_not_submit_the_session(settings, store, repo, incus, built_template):
    """A check reports on the machine; only Complete & End hands the session in.

    The state is what the session page, the reaper and the prune read to tell a
    submitted session from one being worked in, so a check that resolved must leave it
    exactly as it found it — otherwise a student is locked out of the hand-in on a
    machine that is still up.
    """
    manager = manager_with(
        settings, store, repo, incus, {"setup.ps1": "ONTRAK-SETUP-OK", "check.ps1": full_pass()}
    )
    session = manager.allocate("alice", SCENARIO)
    manager.run_checks(session)
    assert session.state is SessionState.IN_USE
    assert session.resolved is True
    # Still handed back as the student's own machine, not as a finished session.
    assert session.state.is_usable
    assert session.state.is_live

    manager.complete(session, values=synthesise_ticket(manager.ticket_form_for(session)))
    assert session.state is SessionState.PASSED
    # And once it *is* submitted, another check cannot reopen it: the state it found
    # is the state it leaves.
    manager.run_checks(session)
    assert session.state is SessionState.PASSED
    assert session.resolved is True


def test_a_submitted_machine_is_kept_when_the_setting_says_so(settings, store, repo, incus, built_template):
    """``session.destroy_on_complete`` has to mean something.

    It is on the admin panel, in the shipped config and in the reasoning behind what a
    prune may delete — and the session was thrown away whatever it said, so a range
    that set it to keep the machine for a debrief kept nothing.
    """
    settings.session.destroy_on_complete = False
    manager = manager_with(
        settings, store, repo, incus, {"setup.ps1": "ONTRAK-SETUP-OK", "check.ps1": full_pass()}
    )
    session = manager.allocate("alice", SCENARIO)
    manager.run_checks(session)
    instance, address = session.instance, session.host_ip

    report = manager.complete(session, values=synthesise_ticket(manager.ticket_form_for(session)))

    assert report.resolved is True
    assert session.state is SessionState.PASSED
    assert session.instance == instance
    assert session.host_ip == address
    assert incus.exists(instance) is True
    assert incus.instance_status(instance) == "RUNNING"


def test_checks_grade_a_failing_attempt_and_keep_the_session_usable(settings, store, repo, incus, built_template):
    manager = manager_with(settings, store, repo, incus, {"setup.ps1": "ONTRAK-SETUP-OK", "check.ps1": partial()})
    session = manager.allocate("alice", SCENARIO)
    report = manager.run_checks(session)

    assert report.score == 40.0
    assert report.resolved is False
    assert session.state is SessionState.IN_USE  # not a dead end: they can keep working
    assert session.resolved is False
    assert [o.objective_id for o in report.failed] == ["resolve-intranet", "reach-service"]
    assert all(o.reported for o in report.outcomes)  # the script reported all three


def test_best_score_is_kept_across_attempts(settings, store, repo, incus, built_template):
    response = {"setup.ps1": "ONTRAK-SETUP-OK"}
    manager = manager_with(settings, store, repo, incus, {**response, "check.ps1": partial()})
    session = manager.allocate("alice", SCENARIO)
    manager.run_checks(session)
    assert session.best_score == 40.0

    manager.driver.responses["check.ps1"] = full_pass()
    manager.run_checks(session)
    assert session.best_score == 100.0
    assert session.resolved is True
    assert session.checks_run == 2


def test_a_broken_check_script_reports_an_error_not_a_score(settings, store, repo, incus, built_template):
    manager = manager_with(settings, store, repo, incus, {"setup.ps1": "ONTRAK-SETUP-OK", "check.ps1": "crashed\n"})
    session = manager.allocate("alice", SCENARIO)
    report = manager.run_checks(session)
    assert report.error
    assert report.score == 0.0
    assert session.state is SessionState.IN_USE
    assert session.best_score == 0.0


def test_grading_follows_a_machine_that_moved(settings, store, repo, monkeypatch):
    """A correct repair can re-address the guest, and grading has to follow it there.

    `net-static-ip-conflict`'s documented fix — turn DHCP back on — hands the guest a
    new address, while the check talks to the one the session recorded. Without this,
    a student whose work was right is graded "No route to host" and reads it as the
    range being broken. The template build has handled a re-addressed guest since
    `_marker_candidates`; grading never did.
    """
    from ontrak.guest import GuestError

    from .helpers import FakeIncus

    moved_to = "10.20.0.77"

    class Readdressed(FakeIncus):
        """Incus answers with the old address until the machine actually moves."""

        moved = False

        def instance_ip(self, name):
            if self.moved:
                return moved_to
            return super().instance_ip(name)

    class MovesMidCheck(NullDriver):
        """The first attempt cannot reach the old address; the new one answers."""

        def __init__(self, settings, incus):
            super().__init__(settings)
            self.incus = incus
            self.hosts: list[str] = []

        def run_script_file(self, remote_path, host="", instance="", timeout=300):
            # The build runs setup.ps1 through the same transport and must not move;
            # only the grading pass meets a machine that has changed address.
            if "check.ps1" not in remote_path:
                return super().run_script_file(remote_path, host=host, instance=instance, timeout=timeout)
            self.hosts.append(host)
            if not self.incus.moved:
                self.incus.moved = True
                raise GuestError("HTTPConnectionPool: No route to host")
            return super().run_script_file(remote_path, host=host, instance=instance, timeout=timeout)

    incus = Readdressed(image_alias=settings.incus.image_alias)
    driver = MovesMidCheck(settings, incus)
    driver.responses["setup.ps1"] = "ONTRAK-SETUP-OK"
    driver.responses["check.ps1"] = full_pass()
    manager = SessionManager(settings, store, repo=repo, incus=incus, driver=driver)
    manager.ensure_template(SCENARIO)
    session = manager.allocate("alice", SCENARIO)
    before = session.host_ip

    report = manager.run_checks(session)

    assert report.error == ""
    assert report.score == 100.0
    assert driver.hosts[0] == before
    assert driver.hosts[1] == moved_to
    assert session.host_ip == moved_to
    assert "readdressed" in {row["kind"] for row in store.list_events(limit=50)}


def test_grading_still_reports_a_transport_failure_that_did_not_move(settings, store, repo):
    """A machine that has not moved is a real failure, not something to retry away."""
    from ontrak.guest import GuestError

    from .helpers import FakeIncus

    class Unreachable(NullDriver):
        def run_script_file(self, remote_path, host="", instance="", timeout=300):
            if "check.ps1" in remote_path:
                raise GuestError("HTTPConnectionPool: No route to host")
            return super().run_script_file(remote_path, host=host, instance=instance, timeout=timeout)

    incus = FakeIncus(image_alias=settings.incus.image_alias)
    driver = Unreachable(settings, responses={"setup.ps1": "ONTRAK-SETUP-OK"})
    manager = SessionManager(settings, store, repo=repo, incus=incus, driver=driver)
    manager.ensure_template(SCENARIO)
    session = manager.allocate("alice", SCENARIO)

    report = manager.run_checks(session)

    assert "could not run checks" in report.error
    assert report.score == 0.0


def test_grading_does_not_re_upload_the_setup_script(settings, store, repo, incus, built_template):
    manager = manager_with(settings, store, repo, incus, {"setup.ps1": "ONTRAK-SETUP-OK", "check.ps1": full_pass()})
    session = manager.allocate("alice", SCENARIO)
    uploads_before = [c for c in manager.driver.calls if "setup.ps1" in c[1]]
    manager.run_checks(session)
    uploads_after = [c for c in manager.driver.calls if "setup.ps1" in c[1]]
    assert len(uploads_after) == len(uploads_before)


# --------------------------------------------------------------------------- #
# reset, recycle, reaping
# --------------------------------------------------------------------------- #
def test_reset_destroys_the_machine_and_hands_over_a_clean_one(manager, incus, built_template, settings):
    session = manager.allocate("alice", SCENARIO)
    broken_instance = session.instance
    incus.calls.clear()

    session = manager.reset(session)
    assert session.state is SessionState.READY
    assert session.instance == broken_instance  # same deterministic name, new VM
    assert ("delete_instance", broken_instance) in incus.calls
    assert any(c[0] == "copy_instance" for c in incus.calls)
    assert incus.instance_status(session.instance) == "RUNNING"
    assert session.best_score == 0.0  # scores belong to the previous attempt


def test_reset_prefers_a_ready_pool_vm(manager, incus, built_template, settings):
    session = manager.allocate("alice", SCENARIO)
    spare = settings.incus.pool_name(SCENARIO, 9)
    incus.add_instance(spare, running=True, ip="10.20.0.99")
    session = manager.reset(session)
    assert session.instance == spare
    assert session.host_ip == "10.20.0.99"


def test_reset_refuses_terminal_sessions(manager, built_template):
    session = manager.allocate("alice", SCENARIO)
    manager.end(session)
    assert session.state is SessionState.DESTROYED
    with pytest.raises(SessionError, match="cannot be reset"):
        manager.reset(session)


def test_end_destroys_the_instance(manager, incus, built_template):
    session = manager.allocate("alice", SCENARIO)
    instance = session.instance
    manager.end(session)
    assert session.state is SessionState.DESTROYED
    assert not incus.exists(instance)


def test_reap_expires_sessions_past_their_ttl(manager, store, incus, built_template):
    session = manager.allocate("alice", SCENARIO)
    instance = session.instance
    store.update_session(session.id, expires_at=iso(utcnow() - timedelta(minutes=1)))

    result = manager.reap()
    assert session.id in result["recycled"]
    assert store.get_session(session.id).state is SessionState.DESTROYED
    assert not incus.exists(instance)  # the student's VM is gone
    assert incus.exists(settings_template(manager))  # the template survives for the next student


def test_reap_reclaims_idle_sessions(manager, store, incus, built_template):
    session = manager.allocate("alice", SCENARIO)
    store.update_session(session.id, last_activity_at=iso(utcnow() - timedelta(hours=2)))
    result = manager.reap()
    assert session.id in result["recycled"]
    assert "idle" in store.get_session(session.id).notes


def test_reap_leaves_active_sessions_alone(manager, store, built_template):
    session = manager.allocate("alice", SCENARIO)
    manager.touch(session)
    result = manager.reap()
    assert result["recycled"] == []
    assert store.get_session(session.id).state is SessionState.READY


def test_reap_clears_stuck_provisioning_rows(manager, store, incus, built_template):
    session = manager.create_session("alice", SCENARIO)
    store.update_session(
        session.id, state=SessionState.ALLOCATING, created_at=iso(utcnow() - timedelta(hours=1))
    )
    manager.reap()
    reloaded = store.get_session(session.id)
    assert reloaded.state is SessionState.ERROR
    assert "timed out" in reloaded.error


# --------------------------------------------------------------------------- #
# pruning the history
#
# `reap` handles a session a student is still owed. This handles the rows nobody is
# owed anything for: machines destroyed weeks ago, still listed as sessions. It must
# never take a row a grade or a ticket points at — but the row a student is *still
# sitting in front of* is reap's business, so a live one is left alone either way.
# --------------------------------------------------------------------------- #
def _finished_session(store, *, state=SessionState.DESTROYED, days_ago=30, student="alice"):
    when = utcnow() - timedelta(days=days_ago)
    return store.create_session(
        Session(
            id=None,
            student=student,
            scenario_id=SCENARIO,
            state=state,
            instance=f"ontrak-sess-closed-{student}",
            created_at=iso(when),
            last_activity_at=iso(when),
        )
    )


def test_prune_deletes_finished_sessions_older_than_the_cutoff(manager, store):
    old = _finished_session(store, days_ago=30)
    fresh = _finished_session(store, days_ago=1, student="bob")

    result = manager.prune_sessions(days=7)

    assert result["deleted"] == 1
    assert result["sessions"] == [old.id]
    assert store.get_session(old.id) is None
    assert store.get_session(fresh.id) is not None  # too recent to be history


def test_prune_keeps_a_session_a_grade_points_at(manager, store):
    """A stored result is the record of the course, not a machine that stopped existing."""
    graded = _finished_session(store, days_ago=30)
    other = _finished_session(store, days_ago=30, student="bob")
    store.add_result(ScoreReport(session_id=graded.id, scenario_id=SCENARIO, score=80.0, resolved=True), "alice")

    result = manager.prune_sessions(days=7)

    assert result["kept"] == [graded.id]
    assert result["sessions"] == [other.id]
    assert store.get_session(graded.id) is not None
    assert store.latest_report(graded.id) is not None


def test_prune_leaves_a_live_session_to_reap(manager, store, incus, built_template):
    """An expired `in_use` row is recycled, never pruned: the student still has a console."""
    session = manager.allocate("alice", SCENARIO)
    store.update_session(session.id, last_activity_at=iso(utcnow() - timedelta(days=30)))

    result = manager.prune_sessions(days=7)

    assert result["deleted"] == 0
    assert session.id in result["live"]
    assert store.get_session(session.id) is not None

    # ...and reap is what takes it, destroying the machine on the way out.
    manager.reap()
    assert store.get_session(session.id).state is SessionState.DESTROYED
    assert not incus.exists(session.instance)


def test_prune_dry_run_deletes_nothing(manager, store):
    old = _finished_session(store, days_ago=30)

    result = manager.prune_sessions(days=7, dry_run=True)

    assert result["dry_run"] is True
    assert result["sessions"] == [old.id]
    assert result["deleted"] == 0
    assert store.get_session(old.id) is not None


# --------------------------------------------------------------------------- #
# session helpers
# --------------------------------------------------------------------------- #
def test_hints_reveal_one_at_a_time(manager, built_template, repo):
    session = manager.allocate("alice", SCENARIO)
    scenario = repo.get(SCENARIO)
    assert session.hint_level == 0
    manager.reveal_hint(session, scenario)
    assert session.hint_level == 1
    for _ in range(len(scenario.hints) + 3):
        manager.reveal_hint(session, scenario)
    assert session.hint_level == len(scenario.hints)


def test_extend_pushes_the_expiry_out(manager, built_template):
    session = manager.allocate("alice", SCENARIO)
    before = parse_iso(session.expires_at)
    manager.extend(session, 30)
    assert parse_iso(session.expires_at) > before


def test_ownership_is_enforced(manager, built_template):
    session = manager.allocate("alice", SCENARIO)
    assert manager.get_owned_session("alice", session.id).id == session.id
    with pytest.raises(SessionError, match="another student"):
        manager.get_owned_session("bob", session.id)
    assert manager.get_owned_session("bob", session.id, allow_instructor=True).id == session.id


def test_stats_snapshot(manager, built_template):
    manager.allocate("alice", SCENARIO)
    stats = manager.stats()
    assert stats["sessions"][SessionState.READY.value] == 1
    assert stats["pool"][0]["scenario_id"]
    assert isinstance(stats["templates"], list)


# --------------------------------------------------------------------------- #
# the SSH console transport a Linux template is built with
#
# The console iframe used to point an RDP connection at a Linux container, which
# answers no RDP at all — so every container scenario showed "the remote desktop
# server is currently unreachable", a page that blamed the student's machine for a
# transport that was never going to exist. These pin the replacement.
# --------------------------------------------------------------------------- #
LINUX_SCENARIO = "linux-dir-tree-build"


class RecordingShell(NullDriver):
    """A NullDriver that also speaks shell and keeps what it was asked to run."""

    def __init__(self, settings, marker: str = "ontrak-console-ready", ok: bool = True):
        super().__init__(settings, responses={"setup": f"{SETUP_OK_MARKER}\n"})
        self.marker = marker
        self.ok = ok
        self.shell_calls: list[str] = []

    def run_shell(self, script, host="", instance="", timeout=120):
        from ontrak.guest import CommandResult

        self.shell_calls.append(script)
        if "openssh-server" in script:
            stdout = f"provisioned\n{self.marker}\n" if self.ok else "apt failed\n"
            return CommandResult(self.ok, 0 if self.ok else 1, stdout)
        return CommandResult(True, 0, "ok")


def console_manager(settings, store, repo, incus, driver):
    """The driver is both halves: these tests are about which scenarios get one."""
    return SessionManager(
        settings, store, repo=repo, incus=incus, driver=driver, shell_driver=driver
    )


def _template_builds(incus) -> list[tuple]:
    """Every create/delete the hypervisor was asked for, as evidence of a rebuild."""
    return [call for call in incus.calls if call[0] in ("create_instance", "delete_instance")]


def test_the_console_script_sets_the_lab_credential_and_enables_the_door(settings):
    from ontrak.sessions import console_transport_script

    script = console_transport_script(settings)
    assert f"root:{settings.guest.password}" in script
    assert "chpasswd" in script
    assert "PermitRootLogin yes" in script
    assert "PasswordAuthentication yes" in script
    # `00-` and not `99-`: sshd keeps the *first* value per keyword and reads
    # `sshd_config.d` from the top, so only a name sorting ahead of ours outranks it.
    assert "00-ontrak-console.conf" in script
    assert "openssh-server" in script
    assert f":{settings.guest.ssh_port} " in script
    assert "ontrak-console-ready" in script


def test_a_password_with_a_quote_cannot_escape_the_script(settings):
    from ontrak.sessions import console_transport_script

    settings.guest.password = "pa'ss word"
    script = console_transport_script(settings)
    # Single-quoted and the embedded quote doubled — the shell sees one argument,
    # not a command.
    assert "'root:pa'\\''ss word'" in script


def test_a_linux_template_is_built_with_the_console_transport(settings, store, repo, incus):
    settings.guac.linux_ssh = True
    driver = RecordingShell(settings)
    manager = console_manager(settings, store, repo, incus, driver)
    manager.ensure_template(LINUX_SCENARIO)
    assert any("openssh-server" in call for call in driver.shell_calls), driver.shell_calls


def test_a_windows_template_gets_no_sshd(settings, store, repo, incus):
    settings.guac.linux_ssh = True
    driver = RecordingShell(settings)
    manager = console_manager(settings, store, repo, incus, driver)
    manager.ensure_template(SCENARIO)
    assert not any("openssh-server" in call for call in driver.shell_calls)


def test_the_console_transport_is_opt_in(settings, store, repo, incus):
    settings.guac.linux_ssh = False
    driver = RecordingShell(settings)
    manager = console_manager(settings, store, repo, incus, driver)
    manager.ensure_template(LINUX_SCENARIO)
    assert not any("openssh-server" in call for call in driver.shell_calls)


def test_a_template_built_before_a_console_setting_changed_is_rebuilt(settings, store, repo, incus):
    """The snapshot is of the *settings too*, so changing one rebuilds it.

    This is the failure the recipe stamp exists for: turning `guac.linux_ssh` on left
    every existing Linux template without an sshd, and the portal signed an SSH
    console onto it — a console that never opened, for a reason nothing stated.
    """
    # Built with the console transport off: a Linux template with no sshd.
    settings.guac.linux_ssh = False
    driver = RecordingShell(settings)
    manager = console_manager(settings, store, repo, incus, driver)
    scenario = repo.get(LINUX_SCENARIO)
    manager.ensure_template(LINUX_SCENARIO)
    builds = _template_builds(incus)
    assert manager.template_current(scenario) is True
    assert not any("openssh-server" in call for call in driver.shell_calls)

    # Same settings: the build is a no-op, not another boot.
    manager.ensure_template(LINUX_SCENARIO)
    assert _template_builds(incus) == builds

    # A console setting that is baked in at build time changes the recipe, so the
    # snapshot is stale and the next build replaces it — this time with an sshd.
    # Observed on the hypervisor, not on the shell calls: turning the transport *off*
    # rebuilds too (to a guest without one), and that build runs no shell to count.
    settings.guac.linux_ssh = True
    assert manager.template_current(scenario) is False
    manager.ensure_template(LINUX_SCENARIO)
    assert len(_template_builds(incus)) > len(builds)
    assert any("openssh-server" in call for call in driver.shell_calls)


def test_an_empty_lab_password_refuses_to_build_a_console(settings, store, repo, incus):
    """An empty password would be `chpasswd`-ed in — a console anyone can open as root."""
    settings.guac.linux_ssh = True
    settings.guest.password = ""
    driver = RecordingShell(settings)
    manager = console_manager(settings, store, repo, incus, driver)
    with pytest.raises(SessionError, match="guest.password is empty"):
        manager._provision_console_transport(
            type("S", (), {"scenario_id": LINUX_SCENARIO, "instance": "tpl-x"})(),
            repo.get(LINUX_SCENARIO),
            driver,
        )


def test_a_transport_that_did_not_install_fails_the_build(settings, store, repo, incus):
    """A template whose sshd did not come up must fail loudly, not snapshot quietly.

    The failure it replaces: a build that succeeded and a console that reported the
    remote desktop server as unreachable, with nothing anywhere saying why.
    """
    settings.guac.linux_ssh = True
    driver = RecordingShell(settings, marker="")
    manager = console_manager(settings, store, repo, incus, driver)
    with pytest.raises(SessionError, match="SSH console transport was not installed"):
        manager.ensure_template(LINUX_SCENARIO)
