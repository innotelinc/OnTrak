#!/usr/bin/env python3
"""Unit tests for ontrak/scan.py — what a scan does and, mostly, does not claim.

The remote calls are faked, because the Network is not a test fixture: these cases
are about the decisions the scan makes from what it is told, and the interesting
ones are all about *absence*.

A target has four possible answers and only the first two are "fine":

  * here are the updates it needs      → findings
  * nothing to do                      → no findings, target scanned
  * this tool is not installed here    → no findings, target NOT scanned, no error
  * I could not look                   → no findings, target NOT scanned, an error

The third and fourth must not be confused with the second, and none of the last
three may erase findings already on record. That is why the fake Network models
"tool absent" explicitly: it is the case that makes the difference between a host
being reported clean and being reported unknown, and a fake that returned a
successful empty result for a missing `apt` could not tell them apart.

The scan runs through its real code path — parsers, database, expiry — with only
the four remote functions replaced, so the wiring between them is still covered.
"""

from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ontrak import config, db, registry, scan, scanners  # noqa: E402
from ontrak.config import Host, RegistryCredential, Settings  # noqa: E402
from ontrak.policy import Policy  # noqa: E402
from ontrak.remote import Result  # noqa: E402

SIM_TWO = """\
Reading package lists...
Inst curl [8.5.0-2ubuntu10.1] (8.5.0-2ubuntu10.6 Ubuntu:24.04/noble-security [amd64])
Inst nginx [1.24.0-2ubuntu7] (1.24.0-2ubuntu7.1 Ubuntu:24.04/noble-updates [amd64])
"""

LIST_TWO = """\
Listing...
curl/noble-security 8.5.0-2ubuntu10.6 amd64 [upgradable from: 8.5.0-2ubuntu10.1]
nginx/noble-updates 1.24.0-2ubuntu7.1 amd64 [upgradable from: 1.24.0-2ubuntu7]
"""

SIM_ONE = """\
Reading package lists...
Inst vim [2:9.1.0016-1ubuntu7.1] (2:9.1.0016-1ubuntu7.2 Ubuntu:24.04/noble-updates [amd64])
"""

LIST_ONE = """\
Listing...
vim/noble-updates 2:9.1.0016-1ubuntu7.2 amd64 [upgradable from: 2:9.1.0016-1ubuntu7.1]
"""

NOT_FOUND_APT = "sh: 1: apt-get: not found"
NOT_FOUND_DOCKER = "sh: 1: docker: not found"
NOT_FOUND_SNAP = "sh: 1: snap: not found"


def manifest_list(amd64: str, arm64: str = "sha256:arm64platform000") -> str:
    """A `docker manifest inspect --verbose` answer for a multi-arch tag.

    The shape is the point: a list is what makes the local `RepoDigest` an *index*
    digest, which is the whole reason the scan must resolve it to a platform digest
    before comparing (see `DockerMultiArch`).
    """
    return json.dumps([
        {"Descriptor": {"digest": amd64,
                        "platform": {"architecture": "amd64", "os": "linux"}}},
        {"Descriptor": {"digest": arm64,
                        "platform": {"architecture": "arm64", "os": "linux"}}},
    ])


class FakeNetwork:
    """A canned Network. Every method mirrors the signature it replaces.

    Nothing is installed unless a test says so: an unconfigured tool answers "not
    found", which is what a minimal container actually does. A docker host that is
    present but has no images is expressed by registering it with an empty list.
    """

    def __init__(self, host="i1", containers=("monarch",)):
        self.host = host
        self.containers = list(containers)
        # name -> incus state. Absent means RUNNING, so every pre-existing test
        # keeps describing a live Network; a test that wants a stopped instance
        # registers it here.
        self.states: dict[str, str] = {}
        self.reachable = True
        self.incus_list_ok = True
        # The pending-reboot answer. Defaults to a host that answered and needs
        # nothing, so a test mentions this only when the reboot IS the subject;
        # `None` is the probe that did not answer at all.
        self.reboot: str | None = scanners.REBOOT_CLEAR + "\n"
        self.apt: dict[str | None, tuple[str, str]] = {}
        self.snap: dict[str | None, str] = {}
        self.images: dict[str, list[dict]] = {}
        self.manifests: dict[str, tuple[bool, str]] = {}
        self.calls: list[tuple] = []
        self.logins: list[dict] = []
        self.login_rc = 0

    def _pkg(self, container, command: str) -> Result:
        if "apt-get -s" in command or "apt list --upgradable" in command:
            if container not in self.apt:
                return Result(command, 127, "", NOT_FOUND_APT)
            simulated, listed = self.apt[container]
            return Result(command, 0, simulated if "apt-get -s" in command else listed, "")
        if "snap refresh --list" in command:
            if container not in self.snap:
                return Result(command, 0, scan.NO_SNAP + "\n", "")
            return Result(command, 0, self.snap[container], "")
        return Result(command, 0, "", "")

    def ssh(self, host, remote_argv, timeout):
        self.calls.append(("ssh", host.name, tuple(remote_argv)))
        if not self.reachable:
            return Result("ssh", returncode=255, error="ssh: connect to host port 22: Connection timed out")
        command = remote_argv[-1]
        if "os-release" in command:
            return Result("ssh", 0, "Ubuntu 24.04.3 LTS|6.8.0-45-generic\n", "")
        return self._pkg(None, command)

    def incus(self, host, args, timeout):
        self.calls.append(("incus", host.name, tuple(args)))
        if not self.incus_list_ok:
            return Result("incus list", returncode=1, stderr="Error: cannot connect to incus")
        rows = "".join(f"{name},{self.states.get(name, 'RUNNING')}\n" for name in self.containers)
        return Result("incus list", 0, rows, "")

    def reboot_probe(self, host, timeout):
        self.calls.append(("reboot", host.name))
        if not self.reachable:
            return Result("reboot", returncode=255,
                          error="ssh: connect to host port 22: Connection timed out")
        if self.reboot is None:
            return Result("reboot", returncode=-1, timed_out=True,
                          error=f"timed out after {timeout}s")
        return Result("reboot", 0, self.reboot, "")

    def incus_exec(self, host, container, command, timeout):
        self.calls.append(("incus exec", host.name, container, tuple(command)))
        if self.states.get(container, "RUNNING") != "RUNNING":
            return Result("incus exec", 1, "", "Error: Instance is not running")
        command = command[-1] if command else ""
        if "docker" in command:
            return self.docker_in_container(host, container, command.split()[1:], timeout)
        return self._pkg(container, command)

    def docker_in_container(self, host, container, args, timeout, stdin_text=None):
        self.calls.append(("docker", host.name, container, tuple(args)))
        if args and args[0] == "login":
            self.logins.append({"container": container, "args": tuple(args),
                                "stdin": stdin_text})
            return Result("docker login", self.login_rc, "",
                          "" if self.login_rc == 0
                          else "unauthorized: incorrect username or password")
        has_docker = container in self.images
        if args and args[0] == "image" and len(args) > 1 and args[1] == "ls":
            if not has_docker:
                return Result("docker image ls", 127, "", NOT_FOUND_DOCKER)
            rows = self.images.get(container, [])
            return Result("docker image ls", 0, "".join(json.dumps(r) + "\n" for r in rows), "")
        if args and args[0] == "manifest":
            if not has_docker:
                return Result("docker manifest inspect", 127, "", NOT_FOUND_DOCKER)
            ok, out = self.manifests.get(args[-1], (False, "no such manifest"))
            return Result("docker manifest inspect", 0 if ok else 1, out, "" if ok else "not found")
        return Result("docker", 0, "", "")


class ScanCase(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init(self.conn)
        self.fake = FakeNetwork()
        self.settings = Settings(hosts=(Host("i1", "192.168.1.51", "both"),))
        self.policy = Policy(mode="detect", max_concurrent=1)
        patcher = mock.patch.multiple(
            scan,
            ssh=self.fake.ssh,
            incus=self.fake.incus,
            incus_exec=self.fake.incus_exec,
            docker_in_container=self.fake.docker_in_container,
            reboot_probe=self.fake.reboot_probe,
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        # A scan-time login runs through `registry`, which holds its own transport
        # reference, so the fake is installed there too.
        reg_patcher = mock.patch.multiple(
            registry,
            docker_in_container=self.fake.docker_in_container,
        )
        reg_patcher.start()
        self.addCleanup(reg_patcher.stop)

    def scan(self, **kwargs):
        return scan.scan_network(self.conn, self.settings, self.policy, **kwargs)

    def findings(self):
        # `SELECT *` rather than a column list: the assertions reach for
        # `candidate`, `current` and `first_seen`, and a hand-written list that
        # omits one turns a failed assertion into a confusing IndexError.
        rows = self.conn.execute("SELECT * FROM findings").fetchall()
        return {(r["manager"], r["package"]): r for r in rows}

    def report(self, result, name):
        return next(h for h in result["hosts"] if h["target"] == name)

    def manifest_calls(self) -> int:
        """How many times the Network was asked about a remote image tag.

        The count is the point of the digest cache: each of these is one request out
        of Docker Hub's anonymous budget, which the Network's image pulls share.
        """
        return sum(1 for call in self.fake.calls
                   if call[0] == "docker" and call[3][:1] == ("manifest",))


class Reachability(ScanCase):
    def test_an_unreachable_host_produces_no_findings_and_says_so(self):
        self.fake.reachable = False
        result = self.scan()
        self.assertEqual(0, result["findings"])
        self.assertEqual(0, result["scanned"])
        self.assertEqual("error", result["status"])
        self.assertFalse(self.report(result, "i1")["scanned"])

    def test_an_unreachable_host_is_recorded_as_unreachable_not_as_clean(self):
        self.fake.reachable = False
        self.scan()
        row = self.conn.execute("SELECT * FROM hosts WHERE name='i1'").fetchone()
        self.assertEqual(0, row["reachable"])
        self.assertIn("timed out", row["error"])

    def test_a_failed_scan_does_not_erase_findings_already_on_record(self):
        # The important one. Absence of evidence is not evidence of absence: if a
        # timed-out SSH connection expired a host's findings, the dashboard would go
        # green at exactly the moment the host became unreachable.
        target = db.ensure_target(self.conn, host="i1", kind="container", name="monarch")
        db.record_finding(self.conn, target_id=target, manager="apt", package="nginx",
                          candidate="1.24.0-2ubuntu7.1")
        self.fake.reachable = False
        self.scan()
        self.assertIn(("apt", "nginx"), self.findings())

    def test_a_failed_container_list_contributes_no_container_targets(self):
        self.fake.apt[None] = (SIM_TWO, LIST_TWO)
        self.fake.incus_list_ok = False
        result = self.scan()
        self.assertEqual({"i1"}, {h["target"] for h in result["hosts"]})
        # The host is not believed either, because the list that says what is on it
        # did not answer.
        self.assertEqual(0, result["scanned"])

    def test_a_failed_container_list_does_not_erase_the_containers_findings(self):
        target = db.ensure_target(self.conn, host="i1", kind="container", name="monarch")
        db.record_finding(self.conn, target_id=target, manager="apt", package="nginx")
        self.fake.incus_list_ok = False
        self.scan()
        self.assertIn(("apt", "nginx"), self.findings())


class AptScan(ScanCase):
    def test_findings_are_recorded_with_the_candidate_and_the_security_flag(self):
        self.fake.apt[None] = (SIM_TWO, LIST_TWO)
        result = self.scan()
        self.assertEqual(2, result["findings"])
        found = self.findings()
        self.assertEqual("1.24.0-2ubuntu7.1", found[("apt", "nginx")]["candidate"])
        self.assertEqual(0, found[("apt", "nginx")]["security"])
        self.assertEqual("8.5.0-2ubuntu10.6", found[("apt", "curl")]["candidate"])
        self.assertEqual(1, found[("apt", "curl")]["security"])
        self.assertEqual("pending", found[("apt", "nginx")]["status"])

    def test_each_container_gets_its_own_findings(self):
        self.fake.containers = ["monarch", "capstone"]
        self.fake.apt["monarch"] = (SIM_TWO, LIST_TWO)
        self.fake.apt["capstone"] = (SIM_ONE, LIST_ONE)
        result = self.scan()
        self.assertEqual(3, result["findings"])
        self.assertEqual(2, self.report(result, "monarch")["findings"])
        self.assertEqual(1, self.report(result, "capstone")["findings"])

    def test_a_second_scan_that_finds_nothing_clears_the_findings(self):
        # How "someone patched it by hand" becomes visible without a person
        # clicking anything.
        self.fake.apt[None] = (SIM_TWO, LIST_TWO)
        self.scan()
        self.assertEqual(2, len(self.findings()))
        self.fake.apt[None] = ("Reading package lists...\n", "Listing...\n")
        self.scan()
        self.assertEqual({}, self.findings())

    def test_a_scan_reports_a_partial_result_when_output_is_unrecognised(self):
        # The canary for a distribution changing its format: the target is still
        # scanned, and the dashboard can show that something was not understood.
        self.fake.apt[None] = (SIM_TWO + "Inst who-knows this is new\n", LIST_TWO)
        result = self.scan()
        self.assertEqual(2, result["findings"])
        host = self.report(result, "i1")
        self.assertEqual("partial", host["managers"]["apt"])
        self.assertTrue(any("unparsed" in e for e in host["errors"]))

    def test_scopes_limit_which_managers_run(self):
        self.fake.apt[None] = (SIM_TWO, LIST_TWO)
        self.fake.snap[None] = "Name  Version  Rev\nlxd  5.21.1  29346\n"
        self.policy.scopes = ["apt"]
        self.scan()
        self.assertEqual({"apt"}, {key[0] for key in self.findings()})


class MissingTools(ScanCase):
    def test_a_target_with_no_package_managers_is_not_scanned_and_is_not_an_error(self):
        # A minimal container with no apt, no snap and no docker. This must be
        # "unknown", not "clean", and it must not raise a complaint.
        self.fake.containers = ["scratch"]
        result = self.scan()
        host = self.report(result, "scratch")
        self.assertFalse(host["scanned"])
        self.assertEqual([], host["errors"])
        self.assertEqual("absent", host["managers"]["apt"])
        self.assertEqual("absent", host["managers"]["snap"])
        self.assertEqual(0, result["scanned"])

    def test_a_target_with_no_package_managers_does_not_expire_its_findings(self):
        # Nothing was looked at, so nothing may be concluded from the silence —
        # including the conclusion that a recorded finding is gone.
        target = db.ensure_target(self.conn, host="i1", kind="container", name="scratch")
        db.record_finding(self.conn, target_id=target, manager="apt", package="nginx")
        self.fake.containers = ["scratch"]
        self.scan()
        self.assertIn(("apt", "nginx"), self.findings())


class StoppedInstance(ScanCase):
    """An instance that is not RUNNING is out of service, not merely unreadable.

    `incus exec` cannot reach it, so every manager would report the same error and
    a previous scan's findings would look actionable forever — which is what made
    four stopped instances fail every apply with "Instance is not running".
    """

    def test_a_stopped_instance_is_not_probed_and_reports_not_scanned(self):
        self.fake.containers = ["monarch"]
        self.fake.states["monarch"] = "STOPPED"
        self.fake.apt["monarch"] = (SIM_TWO, LIST_TWO)
        result = self.scan()
        report = self.report(result, "monarch")
        self.assertFalse(report["scanned"])
        self.assertEqual("not-running", report["managers"]["instance"])
        self.assertEqual(0, report["findings"])
        self.assertEqual({}, self.findings())
        probed = [c for c in self.fake.calls if c[0] == "incus exec" and c[2] == "monarch"]
        self.assertEqual([], probed)

    def test_a_stopped_instance_expires_the_findings_it_had(self):
        self.fake.containers = ["monarch"]
        self.fake.apt["monarch"] = (SIM_TWO, LIST_TWO)
        self.scan()
        self.assertEqual(2, len(self.findings()))
        self.fake.states["monarch"] = "STOPPED"
        result = self.scan()
        self.assertEqual({}, self.findings())
        self.assertEqual(0, result["findings"])

    def test_a_restarted_instance_reports_its_findings_again(self):
        # Nothing is hidden while it is down: it comes straight back.
        self.fake.containers = ["monarch"]
        self.fake.apt["monarch"] = (SIM_TWO, LIST_TWO)
        self.fake.states["monarch"] = "STOPPED"
        self.scan()
        self.assertEqual({}, self.findings())
        self.fake.states["monarch"] = "RUNNING"
        self.scan()
        self.assertIn(("apt", "nginx"), self.findings())
        self.assertIn(("apt", "curl"), self.findings())

    def test_the_target_records_why_it_could_not_be_looked_at(self):
        self.fake.containers = ["monarch"]
        self.fake.states["monarch"] = "STOPPED"
        self.scan()
        row = self.conn.execute(
            "SELECT error FROM targets WHERE host='i1' AND name='monarch'").fetchone()
        self.assertIn("not running", row["error"])
        self.assertIn("STOPPED", row["error"])

    def test_a_stopped_instance_keeps_its_applied_history(self):
        # Expiry is about what is still actionable. A record of something that
        # was already installed is not.
        target = db.ensure_target(self.conn, host="i1", kind="container", name="monarch")
        db.record_finding(self.conn, target_id=target, manager="apt", package="curl")
        ids = [r["id"] for r in self.conn.execute("SELECT id FROM findings").fetchall()]
        db.set_status(self.conn, ids, "applied")
        self.fake.containers = ["monarch"]
        self.fake.states["monarch"] = "STOPPED"
        self.scan()
        self.assertIn(("apt", "curl"), self.findings())

    def test_a_stopped_instance_stays_unknown_on_the_dashboard(self):
        # The regression the durable flag exists for. A stopped instance is *touched*
        # by the scan — the attempt is recorded — so "never scanned" stopped being
        # true for it, and the header reported nothing unknown while the machine
        # could not be read at all.
        self.fake.containers = ["monarch"]
        self.fake.states["monarch"] = "STOPPED"
        self.fake.apt[None] = (SIM_TWO, LIST_TWO)  # the host itself still answers
        self.scan()
        row = self.conn.execute(
            "SELECT * FROM targets WHERE name='monarch'").fetchone()
        self.assertTrue(row["last_scanned_at"])
        self.assertEqual(0, row["last_scanned_ok"])
        self.assertEqual(1, scan.host_admin_summary(self.conn)["unknown"])

    def test_a_running_instance_is_read_and_is_no_longer_unknown(self):
        self.fake.containers = ["monarch"]
        self.fake.states["monarch"] = "STOPPED"
        self.fake.apt[None] = (SIM_TWO, LIST_TWO)
        self.fake.apt["monarch"] = (SIM_ONE, LIST_ONE)
        self.scan()
        self.assertEqual(1, scan.host_admin_summary(self.conn)["unknown"])
        self.fake.states["monarch"] = "RUNNING"
        self.scan()
        # Both the host and the container were read this time; nothing is unknown.
        self.assertEqual(0, scan.host_admin_summary(self.conn)["unknown"])

    def test_a_running_instance_is_still_probed(self):
        # The guard is the state, not the presence of the field.
        self.fake.containers = ["monarch"]
        self.fake.states["monarch"] = "RUNNING"
        self.fake.apt["monarch"] = (SIM_TWO, LIST_TWO)
        self.scan()
        self.assertTrue(self.report(self.scan(), "monarch")["scanned"])


class DockerScan(ScanCase):
    def with_images(self, *rows):
        self.fake.images["monarch"] = list(rows)

    def test_a_newer_registry_digest_is_a_finding(self):
        local = "sha256:olddigest0000000"
        remote = "sha256:newdigest0000000"
        self.with_images({"Repository": "docker.n8n.io/n8nio/n8n", "Tag": "1.60.0", "Digest": local})
        self.fake.manifests["docker.n8n.io/n8nio/n8n:1.60.0"] = (
            True, json.dumps({"Descriptor": {"digest": remote}}))
        result = self.scan()
        self.assertEqual(1, result["findings"])
        found = self.findings()[("docker", "docker.n8n.io/n8nio/n8n:1.60.0")]
        self.assertEqual(local[:19], found and
                         self.conn.execute("SELECT current FROM findings").fetchone()["current"])
        self.assertEqual(remote[:19],
                         self.conn.execute("SELECT candidate FROM findings").fetchone()["candidate"])

    def test_a_matching_digest_is_not_a_finding(self):
        digest = "sha256:samedigest000000"
        self.with_images({"Repository": "docker.n8n.io/n8nio/n8n", "Tag": "1.60.0", "Digest": digest})
        self.fake.manifests["docker.n8n.io/n8nio/n8n:1.60.0"] = (
            True, json.dumps({"Descriptor": {"digest": digest}}))
        self.assertEqual(0, self.scan()["findings"])

    def test_a_locally_built_image_is_not_reported_as_up_to_date(self):
        # `:local` images have no registry digest. The three-valued comparison means
        # the target is marked partial and the image is left alone — it is NOT
        # silently counted as current.
        self.with_images({"Repository": "ghcr.io/innotelinc/olympus", "Tag": "local",
                          "Digest": "<none>"})
        result = self.scan()
        self.assertEqual(0, result["findings"])
        host = self.report(result, "monarch")
        self.assertEqual("partial", host["managers"]["docker"])
        self.assertTrue(any("not in a registry" in e for e in host["errors"]))

    def test_dangling_intermediate_layers_are_ignored(self):
        digest = "sha256:samedigest000000"
        self.with_images({"Repository": "<none>", "Tag": "<none>", "Digest": "sha256:x"},
                         {"Repository": "nginx", "Tag": "1.27.0", "Digest": digest})
        self.fake.manifests["nginx:1.27.0"] = (True, json.dumps({"Descriptor": {"digest": digest}}))
        self.assertEqual(0, self.scan()["findings"])

    def test_a_registry_that_cannot_be_asked_is_neither_a_finding_nor_clean(self):
        self.with_images({"Repository": "ghcr.io/private/thing", "Tag": "v1",
                          "Digest": "sha256:olddigest0000000"})
        self.fake.manifests["ghcr.io/private/thing:v1"] = (False, "")
        result = self.scan()
        self.assertEqual(0, result["findings"])
        self.assertEqual("partial", self.report(result, "monarch")["managers"]["docker"])

    def test_a_second_scan_does_not_ask_the_registry_again(self):
        # The rate limit is the reason. Docker Hub answers anonymous requests out of
        # a budget of roughly a hundred per six hours, shared with every image pull
        # in the Network, and a tag's digest does not change between two scans an hour
        # apart — so the second ask buys nothing and costs the Network an update.
        self.with_images({"Repository": "redis", "Tag": "7.4", "Digest": "sha256:olddigest0000000"})
        self.fake.manifests["redis:7.4"] = (True, json.dumps({"Descriptor": {"digest": "sha256:newdigest0000000"}}))
        self.scan()
        self.assertEqual(1, self.manifest_calls())
        self.scan()
        self.assertEqual(1, self.manifest_calls())

    def test_a_cached_digest_is_still_compared_against_the_local_one(self):
        # Caching the ANSWER, not the verdict: the comparison is re-done every scan,
        # so an image pulled since the digest was fetched is still recognised as
        # current and its finding expires.
        remote = "sha256:newdigest0000000"
        self.with_images({"Repository": "redis", "Tag": "7.4", "Digest": "sha256:olddigest0000000"})
        self.fake.manifests["redis:7.4"] = (True, json.dumps({"Descriptor": {"digest": remote}}))
        self.assertEqual(1, self.scan()["findings"])
        self.with_images({"Repository": "redis", "Tag": "7.4", "Digest": remote})
        self.assertEqual(0, self.scan()["findings"])

    def test_a_stale_cached_digest_is_refetched(self):
        self.with_images({"Repository": "redis", "Tag": "7.4", "Digest": "sha256:olddigest0000000"})
        self.fake.manifests["redis:7.4"] = (True, json.dumps({"Descriptor": {"digest": "sha256:newdigest0000000"}}))
        self.scan()
        db.set_digest(self.conn, "redis:7.4", "sha256:newdigest0000000", now=time.time() - 7 * 3600)
        self.scan()
        self.assertEqual(2, self.manifest_calls())

    def test_an_image_with_no_local_digest_is_never_asked_about(self):
        # A locally built image cannot be judged, so the only thing a request buys is
        # a number in a rate limit. The verdict — and the protection that comes with
        # it — is the same either way.
        self.with_images({"Repository": "ghcr.io/innotelinc/olympus", "Tag": "local",
                          "Digest": "<none>"})
        result = self.scan()
        self.assertEqual(0, self.manifest_calls())
        self.assertEqual("partial", self.report(result, "monarch")["managers"]["docker"])
        self.assertEqual(0, result["findings"])

    def test_a_registry_that_refused_is_not_cached_as_an_answer(self):
        # Otherwise a rate limit would read as "up to date" for the whole TTL.
        self.with_images({"Repository": "ghcr.io/private/thing", "Tag": "v1",
                          "Digest": "sha256:olddigest0000000"})
        self.fake.manifests["ghcr.io/private/thing:v1"] = (False, "")
        self.scan()
        self.scan()
        self.assertEqual(2, self.manifest_calls())

    def test_a_docker_finding_produces_exactly_one_row_per_image(self):
        self.with_images({"Repository": "redis", "Tag": "7.4", "Digest": "sha256:olddigest0000000"})
        self.fake.manifests["redis:7.4"] = (True, json.dumps({"Descriptor": {"digest": "sha256:newdigest0000000"}}))
        self.scan()
        self.scan()
        self.assertEqual(1, len(self.findings()))

    def test_an_image_that_became_current_is_expired(self):
        local = "sha256:olddigest0000000"
        remote = "sha256:newdigest0000000"
        self.with_images({"Repository": "redis", "Tag": "7.4", "Digest": local})
        self.fake.manifests["redis:7.4"] = (True, json.dumps({"Descriptor": {"digest": remote}}))
        self.scan()
        self.assertEqual(1, len(self.findings()))
        # The image was pulled elsewhere; the registry now agrees with local.
        self.with_images({"Repository": "redis", "Tag": "7.4", "Digest": remote})
        self.scan()
        self.assertEqual({}, self.findings())


class DockerMultiArch(ScanCase):
    """A manifest list is compared like for like.

    The regression this guards: a multi-arch tag's local `RepoDigest` is the *index*
    digest while `docker manifest inspect` answers with a *platform* digest, and the
    two never coincide — so comparing them directly, as the scan used to, reported
    every multi-arch tag as behind on every scan and no apply could ever clear it
    (the pull it suggested answered "up to date"). These cases pin that the scan
    resolves the local index to its own platform digest first, and only calls the
    image behind when that platform image actually moved.
    """

    INDEX = "sha256:localindex0000000"

    def with_multiarch(self, repository="nginx", tag="1.27.0", index=None):
        self.fake.images["monarch"] = [
            {"Repository": repository, "Tag": tag, "Digest": index or self.INDEX}
        ]

    def test_the_same_platform_digest_is_not_a_finding(self):
        # The list was republished (a new arm64 build, say) so the index digest no
        # longer matches the tag — but this host's amd64 image is unchanged, and that
        # is what "behind" means. The old comparison flagged this forever.
        platform = "sha256:amd64platform00000"
        self.with_multiarch()
        self.fake.manifests["nginx:1.27.0"] = (True, manifest_list(amd64=platform))
        self.fake.manifests[f"nginx@{self.INDEX}"] = (True, manifest_list(amd64=platform))
        result = self.scan()
        self.assertEqual(0, result["findings"])
        self.assertEqual("ok", self.report(result, "monarch")["managers"]["docker"])

    def test_a_moved_platform_digest_is_a_finding(self):
        self.with_multiarch()
        self.fake.manifests["nginx:1.27.0"] = (True, manifest_list(amd64="sha256:newplatform00000"))
        self.fake.manifests[f"nginx@{self.INDEX}"] = (True, manifest_list(amd64="sha256:oldplatform00000"))
        self.assertEqual(1, self.scan()["findings"])

    def test_a_tag_whose_kind_was_cached_before_the_fix_is_re_fetched(self):
        # An entry cached before the kind existed has a digest but no kind. Guessing
        # would compare the wrong pair of digests; the scan re-fetches instead.
        platform = "sha256:amd64platform00000"
        self.with_multiarch()
        self.fake.manifests["nginx:1.27.0"] = (True, manifest_list(amd64=platform))
        self.fake.manifests[f"nginx@{self.INDEX}"] = (True, manifest_list(amd64=platform))
        db.set_digest(self.conn, "nginx:1.27.0", "sha256:staleplatform0000", now=time.time())
        self.assertEqual(0, self.scan()["findings"])

    def test_an_old_index_the_registry_cannot_resolve_is_unjudged(self):
        # If the local index has been pruned the platform digest cannot be known, so
        # the image is protected rather than called current or behind.
        self.with_multiarch()
        self.fake.manifests["nginx:1.27.0"] = (True, manifest_list(amd64="sha256:newplatform00000"))
        # no entry for nginx@<index> → the fake answers "no such manifest"
        result = self.scan()
        self.assertEqual(0, result["findings"])
        self.assertEqual("partial", self.report(result, "monarch")["managers"]["docker"])

    def test_the_platform_resolution_is_cached_so_a_later_scan_does_not_re_ask(self):
        platform = "sha256:amd64platform00000"
        self.with_multiarch()
        self.fake.manifests["nginx:1.27.0"] = (True, manifest_list(amd64=platform))
        self.fake.manifests[f"nginx@{self.INDEX}"] = (True, manifest_list(amd64=platform))
        self.scan()
        first = self.manifest_calls()
        self.scan()
        self.assertEqual(first, self.manifest_calls())


class DockerPinWarmup(ScanCase):
    """Warming the pinned-index cache is spread over scans, not done in one burst.

    A multi-arch tag costs one extra registry request the first time it is seen (see
    `DockerMultiArch`), and a cold cache would spend every one of them in a single scan —
    the burst that gets Docker Hub to answer 429 to the pulls that share the address.
    These cases pin that a scan stops at its budget, leaves the rest unjudged rather than
    guessing, and resolves them on a later scan.
    """

    NGINX_INDEX = "sha256:indexnginx00000"
    REDIS_INDEX = "sha256:indexredis00000"

    def setUp(self):
        super().setUp()
        self.settings = Settings(
            hosts=(Host("i1", "192.168.1.51", "both"),), docker_pin_warm_budget=1)

    def with_images(self):
        # Two multi-arch images. nginx's amd64 image did not move; redis's did, so redis
        # *would* be a finding — which is what makes the deferral worth asserting.
        self.fake.images["monarch"] = [
            {"Repository": "nginx", "Tag": "1.27.0", "Digest": self.NGINX_INDEX},
            {"Repository": "redis", "Tag": "7", "Digest": self.REDIS_INDEX},
        ]
        self.fake.manifests["nginx:1.27.0"] = (True, manifest_list(amd64="sha256:nginxsame000000"))
        self.fake.manifests[f"nginx@{self.NGINX_INDEX}"] = (True, manifest_list(amd64="sha256:nginxsame000000"))
        self.fake.manifests["redis:7"] = (True, manifest_list(amd64="sha256:redisnew0000000"))
        self.fake.manifests[f"redis@{self.REDIS_INDEX}"] = (True, manifest_list(amd64="sha256:redisold0000000"))

    def pinned(self) -> list[str]:
        """The `repo@<index>` references the scan actually asked the registry about."""
        return [call[3][-1] for call in self.fake.calls
                if call[0] == "docker" and call[3][:1] == ("manifest",)
                and "@" in call[3][-1]]

    def test_the_budget_stops_a_scan_resolving_more_than_it_is_allowed(self):
        self.with_images()
        result = self.scan()
        # One resolution, not two: the second index was left for a later scan.
        self.assertEqual(len(self.pinned()), 1)
        # The deferred image would have been a finding; it is not one, and the image is
        # protected rather than called current.
        self.assertEqual(0, result["findings"])
        report = self.report(result, "monarch")
        self.assertEqual("partial", report["managers"]["docker"])
        self.assertTrue(any("warms" in error for error in report["errors"]), report["errors"])

    def test_a_later_scan_resolves_what_the_budget_deferred(self):
        self.with_images()
        self.scan()
        result = self.scan()
        # The cached first resolution cost nothing this time, so the budget went to redis,
        # which really had moved and is judged at last.
        self.assertEqual(len(self.pinned()), 2)
        self.assertEqual(1, result["findings"])

    def test_zero_means_no_cap(self):
        self.settings = Settings(
            hosts=(Host("i1", "192.168.1.51", "both"),), docker_pin_warm_budget=0)
        self.with_images()
        result = self.scan()
        self.assertEqual(len(self.pinned()), 2)
        self.assertEqual(1, result["findings"])

    def test_a_cached_resolution_does_not_spend_the_budget(self):
        self.with_images()
        # nginx's index is already resolved, so it must not consume the single slot.
        db.set_digest(self.conn, f"nginx@{self.NGINX_INDEX}", "sha256:nginxsame000000", now=time.time())
        result = self.scan()
        self.assertEqual([f"redis@{self.REDIS_INDEX}"], self.pinned())
        self.assertEqual(1, result["findings"])


class DockerScanLogin(ScanCase):
    """The scan authenticates before it spends Docker Hub's anonymous budget.

    A pull is not the only thing that draws on that budget. The digest checks this
    scan makes draw on the same per-address allowance, and on a host that has never
    had an update applied there is no login for them to inherit — so the scan logs
    in itself, once, right before the first request it is about to make. These cases
    pin that it happens only when a credential applies, only when a request is
    actually needed, and never more than once per registry.
    """

    def with_credential(self, registry="docker.io", user="innotel",
                        password="dckr_pat_secret"):
        self.settings = Settings(
            hosts=(Host("i1", "192.168.1.51", "both"),),
            registry_credentials=(RegistryCredential(registry, user, password),),
        )

    def with_image(self, repository="redis", tag="7.4", digest="sha256:olddigest0000000"):
        self.fake.images["monarch"] = [
            {"Repository": repository, "Tag": tag, "Digest": digest}
        ]

    def login_calls(self) -> int:
        return len(self.fake.logins)

    def test_a_scan_logs_in_before_asking_the_registry(self):
        self.with_credential()
        self.with_image()
        self.fake.manifests["redis:7.4"] = (
            True, json.dumps({"Descriptor": {"digest": "sha256:newdigest0000000"}}))
        self.scan()
        self.assertEqual(1, self.login_calls())
        login = self.fake.logins[0]
        # Docker Hub takes no server argument, and the secret is the stdin payload.
        self.assertEqual(("login", "--username", "innotel", "--password-stdin"),
                         login["args"])
        self.assertEqual("dckr_pat_secret", login["stdin"])
        self.assertNotIn("dckr_pat_secret", " ".join(login["args"]))
        # And it runs BEFORE the manifest request it is meant to authorise.
        calls = self.fake.calls
        login_at = next(i for i, c in enumerate(calls)
                        if c[0] == "docker" and c[3][:1] == ("login",))
        manifest_at = next(i for i, c in enumerate(calls)
                           if c[0] == "docker" and c[3][:1] == ("manifest",))
        self.assertLess(login_at, manifest_at)

    def test_a_non_hub_registry_names_itself_on_the_login(self):
        self.with_credential(registry="ghcr.io")
        self.with_image(repository="ghcr.io/innotelinc/monarch/watchtower", tag="latest")
        self.fake.manifests["ghcr.io/innotelinc/monarch/watchtower:latest"] = (
            True, json.dumps({"Descriptor": {"digest": "sha256:newdigest0000000"}}))
        self.scan()
        self.assertEqual(("login", "--username", "innotel", "--password-stdin", "ghcr.io"),
                         self.fake.logins[0]["args"])

    def test_without_a_credential_the_registry_is_asked_anonymously(self):
        self.with_image()
        self.fake.manifests["redis:7.4"] = (
            True, json.dumps({"Descriptor": {"digest": "sha256:newdigest0000000"}}))
        self.scan()
        self.assertEqual(0, self.login_calls())

    def test_the_login_happens_once_per_registry_not_per_image(self):
        self.with_credential()
        self.fake.images["monarch"] = [
            {"Repository": "redis", "Tag": "7.4", "Digest": "sha256:olddigest0000000"},
            {"Repository": "nickfedor/watchtower", "Tag": "latest", "Digest": "sha256:olddigest1111111"},
        ]
        self.fake.manifests["redis:7.4"] = (
            True, json.dumps({"Descriptor": {"digest": "sha256:newdigest0000000"}}))
        self.fake.manifests["nickfedor/watchtower:latest"] = (
            True, json.dumps({"Descriptor": {"digest": "sha256:newdigest1111111"}}))
        self.scan()
        self.assertEqual(2, self.manifest_calls())
        self.assertEqual(1, self.login_calls())

    def test_a_scan_answered_from_the_cache_does_not_log_in(self):
        # Logging in is itself a request. When every digest is cached there is
        # nothing to authenticate, so the second scan of a stable target makes no
        # registry call at all — login included.
        self.with_credential()
        self.with_image()
        self.fake.manifests["redis:7.4"] = (
            True, json.dumps({"Descriptor": {"digest": "sha256:newdigest0000000"}}))
        self.scan()
        self.assertEqual(1, self.login_calls())
        self.fake.logins = []
        self.scan()
        self.assertEqual(0, self.login_calls())
        self.assertEqual(1, self.manifest_calls())

    def test_a_failed_login_still_asks_the_registry_and_says_so(self):
        # A rotated token is not a reason to skip the check: the manifest is still
        # attempted, and the refusal is recorded rather than only implied by a 429.
        self.with_credential()
        self.fake.login_rc = 1
        self.with_image()
        self.fake.manifests["redis:7.4"] = (
            True, json.dumps({"Descriptor": {"digest": "sha256:newdigest0000000"}}))
        result = self.scan()
        self.assertEqual(1, self.manifest_calls())
        host = self.report(result, "monarch")
        self.assertTrue(any("login to docker.io failed" in e for e in host["errors"]))

    def test_a_recent_login_is_reused_instead_of_repeated(self):
        # The daemon keeps the credential, so a scan within the TTL must not spend a
        # request re-establishing it — that is the whole point of the record.
        self.with_credential()
        self.with_image()
        self.fake.manifests["redis:7.4"] = (
            True, json.dumps({"Descriptor": {"digest": "sha256:newdigest0000000"}}))
        db.record_registry_login(self.conn, host="i1", container="monarch",
                                 registry="docker.io")
        self.scan()
        self.assertEqual(1, self.manifest_calls())
        self.assertEqual(0, self.login_calls())

    def test_a_successful_login_is_remembered_for_the_next_scan(self):
        self.with_credential()
        self.with_image()
        self.fake.manifests["redis:7.4"] = (
            True, json.dumps({"Descriptor": {"digest": "sha256:newdigest0000000"}}))
        self.scan()
        self.assertEqual(1, self.login_calls())
        self.assertTrue(db.registry_login_is_fresh(
            self.conn, host="i1", container="monarch", registry="docker.io",
            ttl_seconds=self.settings.login_ttl_seconds))


class VanishedTargets(ScanCase):
    """Containers that are gone do not leave findings behind.

    A scan only visits what `incus list` reports, so a removed container's target
    and findings would sit red forever — unapplicable and unexpirable. The cleanup
    must be conservative in the other direction too: a stopped instance is still in
    the listing and must be kept, and a listing that failed must prune nothing,
    because "I could not ask" is not "it is gone".
    """

    def target_names(self, host="i1"):
        return {row["name"] for row in self.conn.execute(
            "SELECT name FROM targets WHERE host=?", (host,)).fetchall()}

    def test_a_removed_container_is_dropped_with_its_findings(self):
        ghost = db.ensure_target(self.conn, host="i1", kind="container", name="ghost")
        db.record_finding(self.conn, target_id=ghost, manager="docker",
                          package="redis:7.4", current="sha256:a", candidate="sha256:b")
        self.scan()
        names = self.target_names()
        self.assertNotIn("ghost", names)
        self.assertIn("monarch", names)
        left = self.conn.execute(
            "SELECT COUNT(*) AS n FROM findings WHERE package='redis:7.4'").fetchone()["n"]
        self.assertEqual(0, left)

    def test_a_stopped_instance_is_kept(self):
        # Out of service is not the same as gone: it is still in the listing.
        self.fake.containers = ["monarch", "mail"]
        self.fake.states["mail"] = "STOPPED"
        db.ensure_target(self.conn, host="i1", kind="container", name="mail")
        self.scan()
        self.assertIn("mail", self.target_names())

    def test_a_failed_container_listing_prunes_nothing(self):
        # We could not ask what runs there, so nothing may be assumed removed.
        self.fake.incus_list_ok = False
        db.ensure_target(self.conn, host="i1", kind="container", name="ghost")
        self.scan()
        self.assertIn("ghost", self.target_names())

    def test_the_scan_report_names_what_vanished(self):
        # The prune deletes the rows, so the names only survive in the run's own
        # reconcile block — this is the assertion that they reach it.
        db.ensure_target(self.conn, host="i1", kind="container", name="ghost")
        result = self.scan()
        self.assertIn("ghost", result["reconcile"]["vanished"]["i1"])

    def test_a_quiet_scan_records_no_reconcile_run(self):
        # The report is a signal, not a heartbeat: nothing wrong means no row on the
        # Runs page.
        self.scan()
        rows = self.conn.execute(
            "SELECT COUNT(*) AS n FROM runs WHERE kind='reconcile'").fetchone()["n"]
        self.assertEqual(0, rows)


class ScanBookkeeping(ScanCase):
    def test_the_run_is_recorded_in_the_runs_table(self):
        self.fake.apt[None] = (SIM_TWO, LIST_TWO)
        result = self.scan()
        row = self.conn.execute("SELECT * FROM runs WHERE id=?", (result["run_id"],)).fetchone()
        self.assertEqual("ok", row["status"])
        self.assertEqual("scan", row["kind"])
        self.assertEqual(2, row["findings"])
        self.assertTrue(row["finished_at"])

    def test_the_host_inventory_is_updated_with_what_was_found(self):
        self.scan()
        row = self.conn.execute("SELECT * FROM hosts WHERE name='i1'").fetchone()
        self.assertEqual(1, row["reachable"])
        self.assertEqual(1, row["container_count"])
        self.assertIn("Ubuntu 24.04", row["os"])
        self.assertIn("6.8.0-45", row["kernel"])

    def test_a_second_host_does_not_erase_the_first(self):
        self.settings = Settings(hosts=(Host("i1", "192.168.1.51", "both"),
                                        Host("i2", "192.168.1.52", "both")))
        self.fake.containers = []
        self.fake.apt[None] = (SIM_TWO, LIST_TWO)
        result = self.scan()
        self.assertEqual(2, result["scanned"])
        self.assertEqual(2, len(self.findings()))

    def test_unreachable_hosts_do_not_count_as_scanned_when_others_are_fine(self):
        self.settings = Settings(hosts=(Host("i1", "192.168.1.51", "both"),
                                        Host("i2", "192.168.1.52", "both")))
        self.fake.containers = []
        self.fake.apt[None] = (SIM_TWO, LIST_TWO)
        # Only i1 answers; the fake is keyed by host name via `reachable`.
        real_ssh = self.fake.ssh

        def flaky(host, argv, timeout):
            if host.name == "i2":
                return Result("ssh", 255, "", "", error="Connection timed out")
            return real_ssh(host, argv, timeout)

        with mock.patch.object(scan, "ssh", flaky):
            result = self.scan()
        self.assertEqual(1, result["scanned"])
        self.assertEqual("ok", result["status"])

    def test_a_network_where_nothing_answers_is_an_error_run(self):
        self.fake.containers = []
        self.fake.reachable = False
        result = self.scan()
        self.assertEqual("error", result["status"])
        self.assertEqual(0, result["scanned"])


class AdminSummary(unittest.TestCase):
    def test_unknown_targets_are_counted_and_not_folded_into_clean(self):
        conn = db.connect(":memory:")
        db.init(conn)
        db.upsert_host(conn, name="i1", address="192.168.1.51", kind="both",
                       ssh_user="root", reachable=True)
        db.upsert_host(conn, name="i2", address="192.168.1.52", kind="both",
                       ssh_user="root", reachable=False, error="timed out")
        target = db.ensure_target(conn, host="i1", kind="container", name="monarch")
        db.record_finding(conn, target_id=target, manager="apt", package="nginx", security=True)
        summary = scan.host_admin_summary(conn)
        self.assertEqual(2, summary["hosts"])
        self.assertEqual(1, summary["reachable"])
        self.assertEqual(1, summary["pending"])
        self.assertEqual(1, summary["security"])
        # one unreachable host and one never-scanned target — neither is "clean".
        self.assertEqual(2, summary["unknown"])

    def test_a_target_touched_by_a_scan_that_could_not_read_it_is_still_unknown(self):
        conn = db.connect(":memory:")
        db.init(conn)
        db.upsert_host(conn, name="i1", address="192.168.1.51", kind="both",
                       ssh_user="root", reachable=True)
        target = db.ensure_target(conn, host="i1", kind="container", name="monarch")
        db.touch_target(conn, target, error="instance is not running (state: STOPPED)")
        self.assertEqual(1, scan.host_admin_summary(conn)["unknown"])
        # And the per-host row the Hosts page prints agrees with the header card.
        self.assertEqual(1, db.list_hosts(conn)[0]["unscanned"])
        db.touch_target(conn, target, error=None, looked=True)
        self.assertEqual(0, scan.host_admin_summary(conn)["unknown"])
        self.assertEqual(0, db.list_hosts(conn)[0]["unscanned"])


class MachineKinds(ScanCase):
    """A machine is not an incus host unless it says it is.

    The Network is bare metal, VMware guests, Proxmox nodes, QEMU/KVM machines and
    containers. A kind with no workload enumerator must be scanned as the machine it
    is, and never probed with a tool it does not have: `incus list` run against a
    VMware host produces an error the operator has to read, and a monitor that turns
    "this is not an incus host" into "nothing to do here" is worse than useless — it
    is reassuring.
    """

    def test_a_non_workload_machine_is_never_probed_with_incus(self):
        self.settings = Settings(hosts=(Host("esx1", "192.168.1.90", "vmware"),))
        self.fake.apt[None] = (SIM_TWO, LIST_TWO)
        result = self.scan()
        # Not one incus call: the kind said what the machine is, and it said `vmware`.
        self.assertEqual([], [c for c in self.fake.calls if c[0] == "incus"])
        # The machine's own packages are what can be out of date, and they were read.
        self.assertEqual(2, len(self.findings()))
        self.assertEqual(2, result["findings"])

    def test_the_vocabulary_covers_the_machines_the_Network_actually_has(self):
        for kind in ("physical", "virtual", "vmware", "proxmox", "lxc", "qemu", "docker", "incus"):
            self.assertIn(kind, config.MACHINE_KINDS)
        # Enumeration is the exception, not the rule: only the kinds the scanner can
        # actually ask for their guests define themselves as workload hosts.
        self.assertEqual({"incus", "both", "docker"}, set(config.WORKLOAD_KINDS))
        self.assertNotIn("vmware", config.WORKLOAD_KINDS)

    def test_an_unrecognised_kind_is_named_rather_than_hidden(self):
        self.assertEqual("a Proxmox VE node", config.machine_kind_label("proxmox"))
        self.assertIn("unrecognised", config.machine_kind_label("mystery-box"))


class PendingReboot(ScanCase):
    """A host that has installed a new kernel and not restarted since.

    Every manager reports such a host as up to date — that is what makes this worth
    asking about separately — so what these cases check is where the fact lands (on
    the host, not as a finding), that it survives a scan that could not ask, and
    that the three answers stay three.
    """

    REQUIRED = f"{scanners.REBOOT_REQUIRED}\nlibc6\nlinux-image-generic\n"

    def host_row(self):
        return self.conn.execute("SELECT * FROM hosts WHERE name='i1'").fetchone()

    def events(self):
        return [row["message"] for row in
                self.conn.execute("SELECT * FROM events").fetchall()]

    def test_a_host_waiting_to_restart_records_it_on_the_host_row(self):
        self.fake.reboot = self.REQUIRED
        self.fake.apt[None] = (SIM_TWO, LIST_TWO)
        self.scan()
        row = self.host_row()
        self.assertEqual(1, row["reboot_required"])
        self.assertEqual(1, row["reboot_known"])
        self.assertEqual("libc6\nlinux-image-generic", row["reboot_packages"])
        self.assertIsNotNone(row["reboot_checked_at"])

    def test_a_pending_reboot_is_not_a_finding(self):
        # It is not a package to approve, and it must not reach the Findings page
        # where "approve, then apply" would have nothing to install.
        self.fake.reboot = self.REQUIRED
        self.fake.apt[None] = (SIM_TWO, LIST_TWO)
        result = self.scan()
        self.assertEqual(2, result["findings"])  # the two apt updates, nothing else
        self.assertNotIn(("apt", "linux-image-generic"), self.findings())

    def test_a_pending_reboot_reaches_the_run_log(self):
        self.fake.reboot = self.REQUIRED
        self.scan()
        self.assertTrue(any("waiting for a reboot" in message for message in self.events()),
                        self.events())
        warning = [row for row in self.conn.execute(
            "SELECT * FROM events WHERE level='warning'").fetchall()
            if "waiting for a reboot" in row["message"]]
        self.assertTrue(warning, "the reboot is a warning, not a note")

    def test_a_probe_that_could_not_answer_does_not_erase_a_known_reboot(self):
        # The rule the whole module is built on: absence of evidence is not evidence
        # of absence. A slow SSH connection must not turn "this host needs a reboot"
        # into "this host needs nothing".
        self.fake.reboot = self.REQUIRED
        self.scan()
        self.fake.reboot = None
        self.scan()
        self.assertEqual(1, self.host_row()["reboot_required"])

    def test_a_host_that_answered_and_needs_nothing_is_recorded_as_clear(self):
        self.fake.reboot = scanners.REBOOT_CLEAR + "\n"
        self.scan()
        row = self.host_row()
        self.assertEqual(1, row["reboot_known"])
        self.assertEqual(0, row["reboot_required"])
        self.assertIsNone(row["reboot_packages"])

    def test_a_host_this_code_cannot_ask_is_not_reported_as_clear(self):
        self.fake.reboot = scanners.REBOOT_UNKNOWN + "\n"
        self.scan()
        row = self.host_row()
        self.assertEqual(0, row["reboot_known"])
        self.assertEqual(0, row["reboot_required"])
        self.assertIsNotNone(row["reboot_checked_at"])

    def test_an_unreachable_host_is_not_asked_and_keeps_what_it_said(self):
        self.fake.reboot = self.REQUIRED
        self.scan()
        self.fake.reachable = False
        self.fake.calls.clear()
        self.scan()
        self.assertNotIn(("reboot", "i1"), self.fake.calls)
        self.assertEqual(1, self.host_row()["reboot_required"])

    def test_a_host_whose_container_list_failed_is_still_asked(self):
        # SSH answered, so the machine can be asked about its kernel even though the
        # list of what runs on it could not be read.
        self.fake.reboot = self.REQUIRED
        self.fake.incus_list_ok = False
        self.scan()
        self.assertEqual(1, self.host_row()["reboot_required"])

    def test_the_header_counts_the_hosts_waiting_for_a_reboot(self):
        self.fake.reboot = self.REQUIRED
        self.scan()
        self.assertEqual(1, scan.host_admin_summary(self.conn)["reboot_required"])
        self.fake.reboot = scanners.REBOOT_CLEAR + "\n"
        self.scan()
        self.assertEqual(0, scan.host_admin_summary(self.conn)["reboot_required"])

    def test_the_probe_is_asked_once_per_host_and_not_per_target(self):
        # It is a fact about the machine. Asking it of every container would be both
        # wrong (they share the host's kernel) and a round trip per target.
        self.fake.reboot = self.REQUIRED
        self.scan()
        self.assertEqual([("reboot", "i1")],
                         [call for call in self.fake.calls if call[0] == "reboot"])


if __name__ == "__main__":
    unittest.main()
