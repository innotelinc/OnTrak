#!/usr/bin/env python3
"""Unit tests for ontrak/applier.py — the code that changes the estate.

Everything else in this project reads. This writes, on every host, so the tests
here are about the rails rather than the happy path: that apt is invoked with
`--only-upgrade` and with names it was given rather than names it found, that a
package apt held back is reported as failed rather than applied, that a command
that never ran does not mark anything applied, and that a container is refused a
recreate when doing it would take something else down with it.

The verification step is the one worth being pedantic about. `apt-get` exits 0
while holding a package back — routinely, and without failing — so "the exit code
was fine" is not evidence that anything was installed. Every case below asserts the
outcome that was *re-read from the machine*, not the one the command claimed.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ontrak import applier, db  # noqa: E402
from ontrak.config import Host, Settings  # noqa: E402
from ontrak.policy import Policy  # noqa: E402
from ontrak.remote import Result  # noqa: E402


class FakeRemote:
    """Answers the applier's commands. Records every argv it was given."""

    def __init__(self):
        self.calls: list[tuple] = []
        self.install_rc = 0
        self.install_out = ""
        self.install_timed_out = False
        # The clock each apt command was given, in call order: the transaction, then
        # the verdict re-read. A list rather than a field because the order is what
        # says which ceiling applies to which command.
        self.timeouts: list[int] = []
        self.still_pending: dict[str | None, set[str]] = {}
        self.snap_rc = 0
        self.pull_rc = 0
        # The clock each docker command was given, in call order. A list because the
        # pull is the only one that should differ from the generic ceiling.
        self.docker_timeouts: list[int] = []
        self.containers: list[tuple[str, str]] = []      # (id, name) using the image
        # Keyed by CONTAINER ID, because that is what the applier passes to
        # `docker inspect` — a fake keyed by name would silently exercise the
        # "not compose-managed" path instead of the path under test.
        self.labels: dict[str, dict] = {}
        self.running_services: dict[str, list[str]] = {}  # project -> services
        self.planned_services: dict[str, list[str]] = {}
        # project -> profiles the compose files declare, and project -> the services
        # `config --services` lists once all of them are enabled.
        self.profiles: dict[str, list[str]] = {}
        self.planned_with_profiles: dict[str, list[str]] = {}
        self.image_ids: dict[str, str] = {}               # image ref -> id
        self.image_before: dict[str, str] = {}            # container name -> id
        self.image_after: dict[str, str] = {}             # container name -> id
        self.recreated = False
        self.compose_up_rc = 0

    # ── the two entry points the applier uses ────────────────────────────────
    def _pkg(self, container, command: str, timeout: int = 0) -> Result:
        quoted = command
        if "install --only-upgrade" in quoted:
            self.calls.append(("apt-install", container, command))
            self.timeouts.append(timeout)
            if self.install_timed_out:
                # Killed mid-flight: no exit code and no output, only the clock went
                # off. Whatever apt says afterwards is the entire verdict.
                return Result(command, -1, "", "", timed_out=True,
                              error=f"timed out after {timeout}s")
            return Result(command, self.install_rc, self.install_out,
                          "" if self.install_rc == 0 else "E: Unable to correct problems")
        if "apt list --upgradable" in quoted:
            self.calls.append(("apt-list", container, command))
            self.timeouts.append(timeout)
            names = self.still_pending.get(container, set())
            body = "Listing...\n" + "".join(
                f"{name}/noble-security 9.9 amd64 [upgradable from: 1.0]\n" for name in sorted(names)
            )
            return Result(command, 0, body, "")
        if "snap refresh" in quoted:
            self.calls.append(("snap-refresh", container, command))
            return Result(command, self.snap_rc, "" if self.snap_rc == 0 else "", 
                          "" if self.snap_rc == 0 else "error: snap is busy")
        return Result(command, 0, "", "")

    def ssh(self, host, remote_argv, timeout):
        return self._pkg(None, remote_argv[-1], timeout)

    def incus_exec(self, host, container, command, timeout):
        return self._pkg(container, command[-1], timeout)

    def docker_in_container(self, host, container, args, timeout):
        self.calls.append(("docker", tuple(args)))
        self.docker_timeouts.append(timeout)
        if args[0] == "pull":
            return Result("docker pull", self.pull_rc, "", "" if self.pull_rc == 0 else "denied")
        if args[0] == "ps":
            # The filter value is found by prefix rather than by position: the two
            # `ps` calls differ in how many flags precede it.
            ancestor = next((a.split("=", 1)[1] for a in args if a.startswith("ancestor=")), None)
            if ancestor is not None:
                return Result("docker ps", 0,
                              "".join(f"{cid}|{name}\n" for cid, name in self.containers), "")
            # The value is taken as a suffix, not by splitting on the first `=` —
            # the filter is `label=<key>=<value>` and the key itself contains dots,
            # not equals, so a naive split yields `com.docker.compose.project=/srv/n8n`.
            prefix = "label=com.docker.compose.project="
            project = next((a[len(prefix):] for a in args if a.startswith(prefix)), "")
            return Result("docker ps", 0,
                          "".join(f"{s}\n" for s in self.running_services.get(project, [])), "")
        if args[0] == "inspect":
            target = args[-1]
            fmt = args[2] if len(args) > 2 else ""
            if "Labels" in fmt:
                return Result("docker inspect", 0, json.dumps(self.labels.get(target, {})), "")
            if "Image" in fmt:
                # Before/after are distinct so a recreate can be observed, which is
                # the whole point of the verification step.
                table = self.image_after if self.recreated else self.image_before
                return Result("docker inspect", 0, table.get(target, "sha256:old") + "\n", "")
            return Result("docker inspect", 0, "", "")
        if args[0] == "image":
            return Result("docker image inspect", 0, self.image_ids.get(args[-1], "sha256:new") + "\n", "")
        if args[0] == "compose":
            if "config" in args:
                # The project is read from the directory the caller passed, which is
                # what the container's own compose labels said.
                project = args[args.index("--project-directory") + 1]
                if "--profiles" in args:
                    # `config --profiles` names what the files declare; compose does
                    # not record which of them a running stack was started with.
                    return Result("docker compose config", 0,
                                  "".join(f"{p}\n" for p in self.profiles.get(project, [])), "")
                table = (self.planned_with_profiles if "--profile" in args
                         else self.planned_services)
                return Result("docker compose config", 0,
                              "".join(f"{s}\n" for s in table.get(project, [])), "")
            self.calls.append(("compose-up", tuple(args)))
            self.recreated = self.compose_up_rc == 0
            return Result("docker compose up", self.compose_up_rc, "", "")
        return Result("docker", 0, "", "")


class ApplierCase(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init(self.conn)
        self.fake = FakeRemote()
        self.host = Host("i1", "192.168.1.51", "both")
        self.settings = Settings(hosts=(self.host,))
        self.policy = Policy(mode="auto")
        patcher = mock.patch.multiple(
            applier,
            ssh=self.fake.ssh,
            incus_exec=self.fake.incus_exec,
            docker_in_container=self.fake.docker_in_container,
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def finding(self, manager="apt", package="nginx", target="monarch", status="approved"):
        target_id = db.ensure_target(self.conn, host="i1",
                                     kind="host" if target == "i1" else "container", name=target)
        db.record_finding(self.conn, target_id=target_id, manager=manager, package=package,
                          current="1.0", candidate="1.1")
        row = self.conn.execute(
            "SELECT id FROM findings WHERE manager=? AND package=?", (manager, package)
        ).fetchone()
        db.set_status(self.conn, [row["id"]], status)
        return row["id"]

    def status_of(self, manager="apt", package="nginx"):
        return self.conn.execute(
            "SELECT status, detail FROM findings WHERE manager=? AND package=?",
            (manager, package),
        ).fetchone()

    def apply(self, ids=None, **kwargs):
        return applier.apply_findings(
            self.conn, self.settings, self.policy,
            finding_ids=ids if ids is not None else [r["id"] for r in self.conn.execute(
                "SELECT id FROM findings WHERE status='approved'")],
            **kwargs,
        )


class AptApply(ApplierCase):
    def test_the_install_uses_only_upgrade_and_only_the_named_packages(self):
        self.finding(package="nginx")
        self.finding(package="curl")
        self.apply()
        installs = [call for call in self.fake.calls if call[0] == "apt-install"]
        self.assertEqual(1, len(installs))
        command = installs[0][2]
        self.assertIn("--only-upgrade", command)
        self.assertIn("nginx", command)
        self.assertIn("curl", command)
        # No removals and no distribution upgrade, ever.
        self.assertNotIn("dist-upgrade", command)
        self.assertNotIn("remove", command)
        self.assertIn("--force-confold", command)

    def test_one_apt_transaction_per_target_not_per_package(self):
        # Forty separate installs across twenty-seven containers is a much longer
        # window in which a half-updated host can be observed.
        self.finding(package="nginx")
        self.finding(package="curl")
        self.finding(package="vim")
        self.apply()
        self.assertEqual(1, len([c for c in self.fake.calls if c[0] == "apt-install"]))

    def test_a_successful_upgrade_marks_the_finding_applied(self):
        self.finding(package="nginx")
        result = self.apply()
        self.assertEqual(1, result["applied"])
        row = self.status_of()
        self.assertEqual("applied", row["status"])
        self.assertTrue(row["detail"])

    def test_a_package_apt_held_back_is_failed_not_applied(self):
        # apt exits 0 while holding a package back. Trusting the exit code would make
        # the dashboard report a patch that did not happen.
        self.finding(package="nginx")
        self.finding(package="curl")
        self.fake.still_pending["monarch"] = {"curl"}
        result = self.apply()
        self.assertEqual(1, result["applied"])
        self.assertEqual(1, result["failed"])
        self.assertEqual("applied", self.status_of(package="nginx")["status"])
        failed = self.status_of(package="curl")
        self.assertEqual("failed", failed["status"])
        self.assertIn("held", failed["detail"])

    def test_a_failed_install_marks_every_package_failed(self):
        self.finding(package="nginx")
        self.finding(package="curl")
        self.fake.install_rc = 100
        result = self.apply()
        self.assertEqual(0, result["applied"])
        self.assertEqual(2, result["failed"])
        self.assertEqual("failed", self.status_of(package="nginx")["status"])

    def test_a_missing_verdict_is_treated_as_not_applied(self):
        # The install "succeeded" (exit 0, no output) but the follow-up could not tell
        # us anything. Reporting success would be a guess; reporting failure re-runs
        # a completed upgrade, which is cheap. So it is failure, and the detail says
        # what was actually known.
        self.finding(package="nginx")
        self.fake.install_out = ""
        self.fake.install_rc = 0
        with mock.patch.object(applier, "apt_still_pending", lambda *a, **k: {"nginx"}):
            result = self.apply()
        self.assertEqual(1, result["failed"])
        self.assertEqual("failed", self.status_of()["status"])

    def test_only_approved_and_pending_findings_are_eligible(self):
        approved = self.finding(package="nginx", status="approved")
        applied = self.finding(package="curl", status="applied")
        result = self.apply(ids=[approved, applied])
        self.assertEqual(1, result["applied"])
        # The already-applied one was not re-run.
        command = [c for c in self.fake.calls if c[0] == "apt-install"][0][2]
        self.assertIn("nginx", command)
        self.assertNotIn("curl", command)

    def test_nothing_to_do_is_not_a_run(self):
        result = self.apply(ids=[])
        self.assertIsNone(result["run_id"])
        self.assertEqual(0, result["applied"])
        self.assertEqual([], self.fake.calls)


class AptTimeout(ApplierCase):
    """What a timed-out apt transcript means, and what it must not mean.

    One transcript is `apt-get update` plus the upgrade, and it has a ceiling. Hitting
    that ceiling is not a fact about any individual package, so the outcome has to be
    re-read from the machine rather than assumed in either direction — the same rule
    the exit code already lives under, and the reason `Result.timed_out` is a field
    rather than a non-zero return code.

    The case these tests exist for is the real one: five hosts timed out, every finding
    on them was recorded as failed, and the run summary read "37 applied, 306 failed"
    — which is not what had happened to the estate.
    """

    def test_apt_runs_on_its_own_longer_clock(self):
        self.finding(package="nginx")
        self.apply()
        self.assertGreater(self.settings.apt_timeout, self.settings.command_timeout)
        # The transaction gets the apt budget; the verdict re-read is a probe and gets
        # the probe budget.
        self.assertEqual([self.settings.apt_timeout, self.settings.command_timeout],
                         self.fake.timeouts)

    def test_a_timed_out_transcript_is_applied_when_apt_says_it_landed(self):
        # The transcript ran past the ceiling but the package is gone from apt's
        # upgradable list: the patch happened, and calling it failed is the record
        # lying about the estate.
        self.finding(package="nginx")
        self.fake.install_timed_out = True
        result = self.apply()
        self.assertEqual(1, result["applied"])
        self.assertEqual(0, result["failed"])
        row = self.status_of()
        self.assertEqual("applied", row["status"])
        # The row still has to say the transcript timed out, or the next reader trusts
        # a detail that was written by a process that was killed.
        self.assertIn("timed out", row["detail"])

    def test_a_timed_out_transcript_still_fails_a_package_apt_still_lists(self):
        self.finding(package="nginx")
        self.fake.install_timed_out = True
        self.fake.still_pending["monarch"] = {"nginx"}
        result = self.apply()
        self.assertEqual(0, result["applied"])
        self.assertEqual(1, result["failed"])
        row = self.status_of()
        self.assertEqual("failed", row["status"])
        self.assertIn("timed out", row["detail"])

    def test_a_timeout_that_cannot_be_verified_is_a_failure(self):
        # The verdict re-read cannot tell either — the host is wedged, which is the
        # other way this looks. Failure re-runs a finished upgrade, which is cheap;
        # success would report a patch that may not exist. So: failure.
        self.finding(package="nginx")
        self.fake.install_timed_out = True
        with mock.patch.object(applier, "apt_still_pending", lambda *a, **k: {"nginx"}):
            result = self.apply()
        self.assertEqual(1, result["failed"])
        self.assertEqual("failed", self.status_of()["status"])
        self.assertIn("timed out", self.status_of()["detail"])

    def test_a_timed_out_transcript_is_explained_in_the_run_log(self):
        # Otherwise the next person reads a partial run as an unpatched estate.
        self.finding(package="nginx")
        self.fake.install_timed_out = True
        result = self.apply()
        messages = [row["message"] for row in self.conn.execute(
            "SELECT message FROM events WHERE run_id=?", (result["run_id"],)).fetchall()]
        self.assertTrue(any("timed out" in m for m in messages), messages)


class SnapApply(ApplierCase):
    def test_snap_refresh_names_the_packages(self):
        self.finding(manager="snap", package="lxd")
        result = self.apply()
        refresh = [c for c in self.fake.calls if c[0] == "snap-refresh"]
        self.assertEqual(1, len(refresh))
        self.assertIn("lxd", refresh[0][2])
        self.assertEqual(1, result["applied"])

    def test_a_failed_refresh_is_reported(self):
        self.finding(manager="snap", package="lxd")
        self.fake.snap_rc = 1
        result = self.apply()
        self.assertEqual(0, result["applied"])
        self.assertEqual(1, result["failed"])
        self.assertEqual("failed", self.status_of(manager="snap", package="lxd")["status"])


class DockerApply(ApplierCase):
    IMAGE = "docker.n8n.io/n8nio/n8n:1.60.0"

    def setUp(self):
        super().setUp()
        self.fake.containers = [("cid123", "n8n")]
        self.fake.image_ids = {self.IMAGE: "sha256:new"}
        self.fake.image_before = {"n8n": "sha256:old"}
        self.fake.image_after = {"n8n": "sha256:new"}
        self.compose_labels = {
            "com.docker.compose.project": "/srv/n8n",
            "com.docker.compose.service": "n8n",
            "com.docker.compose.project.working_dir": "/srv/n8n",
            "com.docker.compose.project.config_files": "/srv/n8n/docker-compose.yml",
        }

    def test_a_compose_managed_container_is_recreated(self):
        self.fake.labels["cid123"] = dict(self.compose_labels)
        self.fake.running_services["/srv/n8n"] = ["n8n", "postgres"]
        self.fake.planned_services["/srv/n8n"] = ["n8n", "postgres"]
        self.finding(manager="docker", package=self.IMAGE)
        result = self.apply()
        self.assertEqual(1, result["applied"])
        ups = [c for c in self.fake.calls if c[0] == "compose-up"]
        self.assertEqual(1, len(ups))
        # `--no-deps` so the recreate cannot drag the database into the change.
        self.assertIn("--no-deps", ups[0][1])

    def test_a_recreate_that_would_drop_a_service_is_refused(self):
        # THE safety rail. This estate does not always start a stack the way it is
        # written down — some projects use profiles and some do not — and recreating
        # with the wrong profile set stops the services that profile defines. So if
        # compose would manage fewer services than are running, refuse and say so.
        self.fake.labels["cid123"] = dict(self.compose_labels)
        self.fake.running_services["/srv/n8n"] = ["n8n", "postgres", "redis"]
        self.fake.planned_services["/srv/n8n"] = ["n8n", "postgres"]
        self.finding(manager="docker", package=self.IMAGE)
        result = self.apply()
        self.assertEqual(0, result["applied"])
        self.assertEqual(1, result["failed"])
        self.assertEqual([], [c for c in self.fake.calls if c[0] == "compose-up"])
        self.assertTrue(any("refusing to recreate" in message for message in result["manual"]))
        self.assertTrue(any("redis" in message for message in result["manual"]))

    def test_the_recreate_replays_the_stacks_own_env_file(self):
        # Some stacks keep their secrets beside the stack and are started with
        # `--env-file` (.env.host). Composing without it fails interpolation, which
        # is how a working stack came to fail every apply with a message about a
        # missing variable.
        labels = dict(self.compose_labels)
        labels["com.docker.compose.project.environment_file"] = "/srv/n8n/.env.host"
        self.fake.labels["cid123"] = labels
        self.fake.running_services["/srv/n8n"] = ["n8n"]
        self.fake.planned_services["/srv/n8n"] = ["n8n"]
        self.finding(manager="docker", package=self.IMAGE)
        result = self.apply()
        self.assertEqual(1, result["applied"])
        ups = [c[1] for c in self.fake.calls if c[0] == "compose-up"]
        self.assertEqual(1, len(ups))
        self.assertIn("--env-file", ups[0])
        self.assertEqual("/srv/n8n/.env.host", ups[0][ups[0].index("--env-file") + 1])
        # And the plan was read the same way, so the service count is the stack's.
        plans = [c[1] for c in self.fake.calls
                 if c[0] == "docker" and c[1][:1] == ("compose",)]
        self.assertTrue(all("--env-file" in plan for plan in plans))

    def test_the_recreate_pins_the_project_name_the_container_was_started_under(self):
        # Compose names a project after its *directory* when nothing else says so, and
        # in this estate the two differ (the monitoring stack is labelled
        # `innotel-metrics` and lives in `monitoring`). Composing that path without the
        # name addresses a different project: it builds monitoring-grafana-1, leaves
        # metrics-grafana alone, and then passes its own before/after check.
        self.fake.labels["cid123"] = dict(self.compose_labels)
        self.fake.running_services["/srv/n8n"] = ["n8n"]
        self.fake.planned_services["/srv/n8n"] = ["n8n"]
        self.finding(manager="docker", package=self.IMAGE)
        self.apply()
        ups = [c[1] for c in self.fake.calls if c[0] == "compose-up"]
        self.assertEqual(1, len(ups))
        self.assertIn("--project-name", ups[0])
        self.assertEqual("/srv/n8n", ups[0][ups[0].index("--project-name") + 1])

    def test_a_profile_gated_service_is_recreated_with_the_profiles_enabled(self):
        # The plan without profiles is smaller than what is running, and refusing on
        # that basis left fourteen images unupdatable. The profiles come from the
        # compose files, and they are enabled only once the plain plan is known to
        # miss a running service.
        self.fake.labels["cid123"] = dict(self.compose_labels)
        self.fake.running_services["/srv/n8n"] = ["n8n", "postgres", "redis"]
        self.fake.planned_services["/srv/n8n"] = ["n8n", "postgres"]
        self.fake.profiles["/srv/n8n"] = ["cache"]
        self.fake.planned_with_profiles["/srv/n8n"] = ["n8n", "postgres", "redis"]
        self.finding(manager="docker", package=self.IMAGE)
        result = self.apply()
        self.assertEqual(1, result["applied"])
        self.assertEqual([], result["manual"])
        ups = [c[1] for c in self.fake.calls if c[0] == "compose-up"]
        self.assertEqual(1, len(ups))
        self.assertIn("--profile", ups[0])
        self.assertIn("cache", ups[0])

    def test_a_stack_that_needs_no_profiles_is_never_handed_any(self):
        # `--profile` decides which services compose would start and stop, so
        # introducing one where none was in use is the accident the refusal exists
        # to prevent. Widening is a fallback, not the default.
        self.fake.labels["cid123"] = dict(self.compose_labels)
        self.fake.running_services["/srv/n8n"] = ["n8n", "postgres"]
        self.fake.planned_services["/srv/n8n"] = ["n8n", "postgres"]
        self.fake.profiles["/srv/n8n"] = ["cache"]
        self.fake.planned_with_profiles["/srv/n8n"] = ["n8n", "postgres", "redis"]
        self.finding(manager="docker", package=self.IMAGE)
        self.apply()
        ups = [c[1] for c in self.fake.calls if c[0] == "compose-up"]
        self.assertEqual(1, len(ups))
        self.assertNotIn("--profile", ups[0])

    def test_a_profiled_stack_that_still_misses_a_service_is_refused(self):
        self.fake.labels["cid123"] = dict(self.compose_labels)
        self.fake.running_services["/srv/n8n"] = ["n8n", "postgres", "mystery"]
        self.fake.planned_services["/srv/n8n"] = ["n8n"]
        self.fake.profiles["/srv/n8n"] = ["cache"]
        self.fake.planned_with_profiles["/srv/n8n"] = ["n8n", "postgres"]
        self.finding(manager="docker", package=self.IMAGE)
        result = self.apply()
        self.assertEqual(0, result["applied"])
        self.assertEqual([], [c for c in self.fake.calls if c[0] == "compose-up"])
        self.assertTrue(any("mystery" in message for message in result["manual"]))

    def test_a_refusal_is_what_the_finding_records_as_its_reason(self):
        # The row used to say "no container recreated" while the run log held a
        # paragraph naming the missing services, and the next scan overwrote that
        # anyway — so the dashboard never said why.
        self.fake.labels["cid123"] = dict(self.compose_labels)
        self.fake.running_services["/srv/n8n"] = ["n8n", "postgres", "redis"]
        self.fake.planned_services["/srv/n8n"] = ["n8n", "postgres"]
        self.finding(manager="docker", package=self.IMAGE)
        self.apply()
        detail = self.status_of(manager="docker", package=self.IMAGE)["detail"]
        self.assertIn("refusing to recreate", detail)
        self.assertIn("redis", detail)

    def test_a_pull_gets_its_own_longer_clock(self):
        # A multi-gigabyte image over a domestic uplink is not a probe. Sizing the
        # pull like one failed it for being slow, at every apply.
        self.fake.containers = []
        self.finding(manager="docker", package=self.IMAGE)
        self.apply()
        self.assertGreater(self.settings.pull_timeout, self.settings.command_timeout)
        self.assertIn(self.settings.pull_timeout, self.fake.docker_timeouts)

    def test_a_container_that_is_not_compose_managed_is_pulled_and_handed_over(self):
        self.fake.labels["cid123"] = {}
        self.finding(manager="docker", package=self.IMAGE)
        result = self.apply()
        self.assertEqual(0, result["applied"])
        self.assertTrue(any("not compose-managed" in message for message in result["manual"]))
        # It was pulled; it just was not recreated from a guess.
        self.assertIn(("docker", ("pull", "--quiet", self.IMAGE)), self.fake.calls)

    def test_a_failed_pull_is_a_failure_with_the_registry_s_words(self):
        self.fake.pull_rc = 1
        self.finding(manager="docker", package=self.IMAGE)
        result = self.apply()
        self.assertEqual(1, result["failed"])
        self.assertEqual("failed", self.status_of(manager="docker", package=self.IMAGE)["status"])

    def test_an_image_nothing_runs_is_resolved_by_the_pull_alone(self):
        self.fake.containers = []
        self.finding(manager="docker", package=self.IMAGE)
        result = self.apply()
        self.assertEqual(1, result["applied"])

    def test_a_new_image_id_that_matches_neither_old_nor_new_is_a_failure(self):
        # Recreated, but not onto the image we pulled — that needs a person, and
        # calling it success would be a guess.
        self.fake.image_after = {"n8n": "sha256:somethingelse"}
        self.fake.labels["cid123"] = dict(self.compose_labels)
        self.fake.running_services["/srv/n8n"] = ["n8n"]
        self.fake.planned_services["/srv/n8n"] = ["n8n"]
        self.finding(manager="docker", package=self.IMAGE)
        result = self.apply()
        self.assertEqual(1, result["failed"])
        self.assertIn("verify by hand", self.status_of(manager="docker", package=self.IMAGE)["detail"])


class RunBookkeeping(ApplierCase):
    def test_the_run_records_what_happened(self):
        self.finding(package="nginx")
        result = self.apply()
        row = self.conn.execute("SELECT * FROM runs WHERE id=?", (result["run_id"],)).fetchone()
        self.assertEqual("apply", row["kind"])
        self.assertEqual(1, row["applied"])
        self.assertEqual(0, row["failed"])
        self.assertTrue(row["finished_at"])

    def test_an_unconfigured_host_fails_its_findings_rather_than_being_skipped(self):
        # A finding against a host that is no longer in ONTRAK_HOSTS must surface, not
        # disappear — the row is evidence of something that used to be in the estate.
        self.finding(package="nginx")
        self.settings = Settings(hosts=())
        result = self.apply()
        self.assertEqual(1, result["failed"])
        self.assertEqual("failed", self.status_of()["status"])

    def test_docker_findings_on_a_bare_host_are_refused(self):
        self.finding(manager="docker", package="redis:7.4", target="i1")
        result = self.apply()
        self.assertEqual(1, result["failed"])
        self.assertIn("container", self.status_of(manager="docker", package="redis:7.4")["detail"])


if __name__ == "__main__":
    unittest.main()
