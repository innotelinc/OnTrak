"""Ontrak Sync — the scan.

This walks the Network and writes *findings*: one row per (target, package) that is
behind. It is the only thing in the system that talks to every machine, so it is
also the only thing that has to be careful about the difference between the three
possible answers a target can give:

  * here are the updates it needs          → findings
  * I looked and there are none            → no findings
  * I could not look                       → an error on the target, and NO
                                             findings, and the two must not be
                                             confused on the dashboard

The third case is the one that matters. A host that failed to answer must not read
as patched, because that is precisely how a fleet drifts for months while the
monitor shows green — the failure mode this tool exists to remove. So every probe
here either produces findings or records why it could not, and `scanned` is only
true when at least one manager actually produced a verdict.

That third case has a *durable* form that used to be mishandled: a container that
is not running cannot be read at all, so it is recorded as out of service and
holds no findings (`scan_target`). Carrying a previous scan's findings forward
for one made a machine that is deliberately down report updates that no apply
could ever install.

WHY EACH MANAGER REPORTS WHAT IT SAW
------------------------------------
Deleting a finding is how "this got updated by someone else" becomes visible
without anybody clicking anything, and it is why `_record_*` return the set of
(manager, package) pairs they detected *this run* rather than a count. Counting
would tell the expiry pass how many rows to expect; the set tells it *which*, and
only the set can distinguish "this package is gone" from "this package is fine".
"""

from __future__ import annotations

import concurrent.futures as futures
import json
import logging
from dataclasses import dataclass, field

from . import db, scanners
from .config import WORKLOAD_KINDS, Host, Settings
from .policy import Policy
from .registry import docker_login, registry_of
from .remote import Result, docker_in_container, incus, incus_exec, reboot_probe, ssh

log = logging.getLogger("ontrak.scan")

# `apt-get -s upgrade` is the source of truth for apt because it is the only view
# that names the archive (see scanners.py). `apt-get update` runs first so the
# answer is about now rather than about whenever this container last refreshed;
# it writes to /var/lib/apt/lists and installs nothing, so it is safe in a
# detect-only Network.
APT_SIMULATE = [
    "sh", "-c",
    "export DEBIAN_FRONTEND=noninteractive LC_ALL=C; "
    "apt-get -qq update >/dev/null 2>&1; "
    "apt-get -s -o Debug::NoLocking=1 upgrade 2>&1",
]
APT_LIST = ["sh", "-c", "LC_ALL=C apt list --upgradable 2>/dev/null"]
# The sentinel is the point of this probe. Without it, "snap is not installed" and
# "snap is installed and everything is current" are the same empty string, and a
# target that was never really looked at would count as inspected — which is the
# difference between reporting a host as clean and reporting it as unknown.
NO_SNAP = "__ONTRAK_NO_SNAP__"
SNAP_LIST = ["sh", "-c",
             f"if command -v snap >/dev/null 2>&1; then LC_ALL=C snap refresh --list 2>&1; "
             f"else echo {NO_SNAP}; fi"]
DOCKER_IMAGES = ["image", "ls", "--no-trunc", "--digests", "--format", "{{json .}}"]
OS_RELEASE = ["sh", "-c", ". /etc/os-release 2>/dev/null && printf '%s|%s\\n' \"$PRETTY_NAME\" \"$(uname -r)\""]

Seen = set  # of (manager, package)


def _absent(result: Result) -> bool:
    """Did the command fail because the tool is not installed on this target?

    A minimal container here has no apt and no snap, and that is not a fault to
    report. Distinguishing it from a probe that *broke* matters because only a real
    verdict lets expiry run.
    """
    blob = f"{result.stderr}\n{result.error}\n{result.stdout}"
    return (not result.ok and not result.timed_out
            and ("command not found" in blob or "not found" in blob or "No such file" in blob))


@dataclass
class TargetReport:
    """What one target (a host, or one container on it) contributed."""

    host: str
    name: str
    kind: str
    manager_status: dict[str, str] = field(default_factory=dict)
    findings: int = 0
    errors: list[str] = field(default_factory=list)
    # (manager, package) pairs this scan could NOT reach a verdict about. They
    # protect any existing finding from expiry — an image whose registry refused a
    # token is not evidence that it was updated.
    inconclusive: set[tuple[str, str]] = field(default_factory=set)

    @property
    def scanned(self) -> bool:
        """True only if some manager actually looked.

        A target with no apt, no snap and no docker is not an error: there was
        nothing on it this tool knows how to inspect. A target whose every probe
        *failed* reports not-scanned, and `unknown` on the dashboard counts it.

        This is the value written to `targets.last_scanned_ok` at the end of the
        target's scan, which is what makes the dashboard's count outlast the run.
        """
        return any(state == "ok" for state in self.manager_status.values())


def _run_summary(reports: list[TargetReport]) -> str:
    ok = [r for r in reports if r.scanned]
    bad = [r for r in reports if not r.scanned]
    parts = [f"{len(ok)} target(s) scanned", f"{sum(r.findings for r in reports)} finding(s)"]
    if bad:
        parts.append(f"{len(bad)} target(s) could not be inspected")
    return "; ".join(parts)


def _record_apt(conn, target_id: int, host: Host, container: str | None,
                settings: Settings, report: TargetReport) -> Seen:
    """apt findings for one target, from both views, unioned."""
    def run(argv: list[str], timeout: int) -> Result:
        if container is None:
            return ssh(host, argv, timeout)
        return incus_exec(host, container, argv, timeout)

    simulated = run(APT_SIMULATE, settings.command_timeout)
    listed = run(APT_LIST, settings.command_timeout)

    if simulated.timed_out and listed.timed_out:
        report.manager_status["apt"] = "timeout"
        report.errors.append(f"apt: {simulated.message}")
        return set()
    if _absent(simulated) and _absent(listed):
        report.manager_status["apt"] = "absent"
        return set()

    # `apt-get -s upgrade` warns on stderr that `apt` is unstable in scripts; that
    # is noise. A real failure is a non-zero exit with no `Inst` lines at all,
    # which is what this checks rather than the bare returncode.
    sim_updates, sim_unparsed = scanners.parse_apt_simulate(simulated.stdout)
    list_updates, list_unparsed = scanners.parse_apt_upgradable(listed.stdout)
    if not sim_updates and not list_updates and not simulated.ok and not listed.ok:
        report.manager_status["apt"] = "error"
        report.errors.append(f"apt: {simulated.message}")
        return set()

    seen: set[tuple[str, str]] = set()
    for update in scanners.merge_apt(sim_updates, list_updates):
        db.record_finding(
            conn, target_id=target_id, manager="apt", package=update.package,
            current=update.current, candidate=update.candidate, security=update.security,
            detail=update.detail,
        )
        seen.add(("apt", update.package))
        report.findings += 1

    # Unparsed lines are surfaced, not swallowed: they are the early warning that a
    # distribution changed its output format, which would otherwise silently
    # under-report the whole Network.
    for line in (sim_unparsed + list_unparsed)[:10]:
        report.errors.append(f"apt: unparsed output: {line[:200]}")
    report.manager_status["apt"] = "ok" if not (sim_unparsed + list_unparsed) else "partial"
    return seen


def _record_snap(conn, target_id: int, host: Host, container: str | None,
                 settings: Settings, report: TargetReport) -> Seen:
    argv = SNAP_LIST
    result = (ssh(host, argv, settings.command_timeout) if container is None
              else incus_exec(host, container, argv, settings.command_timeout))
    if result.timed_out:
        report.manager_status["snap"] = "timeout"
        report.errors.append(f"snap: {result.message}")
        return set()
    if NO_SNAP in result.stdout or _absent(result):
        report.manager_status["snap"] = "absent"
        return set()
    updates, unparsed = scanners.parse_snap_refresh(result.stdout)
    seen: set[tuple[str, str]] = set()
    for update in updates:
        db.record_finding(
            conn, target_id=target_id, manager="snap", package=update.package,
            candidate=update.candidate, detail=update.detail,
        )
        seen.add(("snap", update.package))
        report.findings += 1
    for line in unparsed[:10]:
        report.errors.append(f"snap: unparsed output: {line[:200]}")
    report.manager_status["snap"] = "ok" if not unparsed else "partial"
    return seen


def _record_docker(conn, target_id: int, host: Host, container: str | None,
                   settings: Settings, report: TargetReport) -> Seen:
    """Docker image findings for one target.

    Three-valued comparison all the way down (see `scanners.image_is_behind`): an
    image with no registry digest was built locally, so there is no registry to
    ask and it is reported as unjudged rather than as current. This Network builds
    several images locally, so that path is exercised constantly.

    THE REGISTRY IS ASKED AS LITTLE AS POSSIBLE. A locally built image is not asked
    about at all, because the answer cannot matter, and a digest fetched within the
    last `digest_ttl_seconds` is reused instead of re-requested (`db.get_digest`).
    Both matter because the budget for asking Docker Hub anonymously is about a
    hundred requests per six hours, shared with every image pull in the Network: a
    scan that spends it makes the *updates* fail.

    AND WHEN IT IS ASKED, IT IS ASKED AUTHENTICATED. A deployment that holds a
    credential for the ref's registry (`Settings.registry_credentials`) logs in
    before the first digest request of the run, so this scan spends the account's
    allowance rather than the anonymous one the pulls are competing for. The login
    is per container and registry and only happens when a request is actually
    about to be made — a scan answered entirely from the digest cache logs in not
    at all.
    """
    if container is None:
        # Docker runs inside the incus containers here, not on the bare hosts.
        return set()
    listed = docker_in_container(host, container, DOCKER_IMAGES, settings.command_timeout)
    if listed.timed_out:
        report.manager_status["docker"] = "timeout"
        report.errors.append(f"docker: {listed.message}")
        return set()
    if _absent(listed):
        report.manager_status["docker"] = "absent"
        return set()

    images: list[dict] = []
    for line in listed.lines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and row.get("Repository"):
            images.append(row)
    if not listed.ok and not images:
        report.manager_status["docker"] = "error"
        report.errors.append(f"docker: {listed.message}")
        return set()

    seen: set[tuple[str, str]] = set()
    unjudged = 0
    # (container, registry) pairs already logged in during this call. The daemon
    # keeps the credential, so one login covers every later request on the same
    # host and target; doing it per request would spend the budget the request needs.
    logged_in: set[tuple[str, str]] = set()
    for row in images:
        repo = str(row.get("Repository") or "")
        tag = str(row.get("Tag") or "")
        # `<none>` is a dangling intermediate layer and an empty tag has nothing to
        # re-pull; neither is something an operator can "update".
        if repo in ("", "<none>") or tag in ("", "<none>"):
            continue
        ref = f"{repo}:{tag}"
        local_digest = str(row.get("Digest") or "").replace("<none>", "")
        if not local_digest:
            # Nothing to compare against, so the registry has nothing to tell us:
            # `image_is_behind` answers "cannot tell" whatever comes back. Not asking
            # is therefore free of consequence — and each avoided request is one of a
            # hundred an hour on a budget that image pulls also draw from.
            unjudged += 1
            report.inconclusive.add(("docker", ref))
            continue
        remote_digest = db.get_digest(conn, ref, ttl_seconds=settings.digest_ttl_seconds)
        if remote_digest is None:
            # Authenticate before the registry is asked, if this deployment holds a
            # credential for it, so the request is answered from the account's
            # allowance instead of the anonymous budget the pulls share. A failure
            # is not fatal — the manifest is still attempted, because an
            # unauthenticated read may yet succeed — but it is reported, so a
            # rotated token shows up as itself.
            registry = registry_of(ref)
            credential = settings.credential_for(registry)
            if credential is not None and (container, registry) not in logged_in:
                logged_in.add((container, registry))
                login = docker_login(host, container, registry, credential, settings)
                if not login.ok:
                    report.errors.append(f"docker login to {registry} failed: {login.message}")
            manifest = docker_in_container(
                host, container, ["manifest", "inspect", "--verbose", ref], settings.command_timeout
            )
            remote_digest = scanners.parse_manifest_digest(manifest.stdout) if manifest.ok else ""
            if remote_digest:
                db.set_digest(conn, ref, remote_digest)
        behind = scanners.image_is_behind(local_digest, remote_digest)
        if behind is None:
            # No verdict. The image is protected rather than confirmed: a finding
            # already on record for it stays (we could not check), and no new one is
            # invented. Note it is NOT added to `seen` — "seen" means judged.
            unjudged += 1
            report.inconclusive.add(("docker", ref))
            continue
        if behind:
            db.record_finding(
                conn, target_id=target_id, manager="docker", package=ref,
                current=local_digest[:19], candidate=remote_digest[:19],
                detail="newer image in registry",
            )
            seen.add(("docker", ref))
            report.findings += 1
        # An image that matches the registry is NOT added to `seen`: it is a verdict
        # of "current", which is what lets a finding recorded before the pull be
        # expired by the scan after it. Adding it here would strand that row as
        # pending forever, the same way the apt path would if it listed packages
        # that are no longer upgradable.
    report.manager_status["docker"] = "ok" if not unjudged else "partial"
    if unjudged:
        report.errors.append(f"docker: {unjudged} image(s) not in a registry — not compared")
    return seen


def _parse_instances(listing) -> list[tuple[str, str]]:
    """`incus list -c ns` rows → (name, STATE).

    The state travels with the name because a stopped instance cannot be read at
    all: `incus exec` fails on it, so every manager reports the same error, and it
    is the *state* — not the error text — that tells this scan the difference
    between a machine that is out of service and one that answered badly.
    """
    out: list[tuple[str, str]] = []
    for line in listing.lines():
        parts = [part.strip() for part in line.split(",")]
        if not parts or not parts[0]:
            continue
        out.append((parts[0], parts[1] if len(parts) > 1 else ""))
    return out


def scan_target(conn, *, host: Host, name: str, kind: str, container: str | None,
                settings: Settings, policy: Policy, state: str | None = None) -> TargetReport:
    """Inspect one target and record its findings. Never raises."""
    report = TargetReport(host=host.name, name=name, kind=kind)
    try:
        target_id = db.ensure_target(
            conn, host=host.name, kind=kind, name=name, ref=container or host.address,
            meta={"address": host.address},
        )
    except Exception as exc:  # a broken row must not abort the Network
        report.errors.append(f"target: {exc}")
        report.manager_status["target"] = "error"
        return report

    # A container that is not running cannot be read at all. That is a *durable*
    # "could not look", not a transient probe failure, so the contract this module
    # documents at the top applies literally — an error on the target and NO
    # findings. Carrying the previous scan's findings forward is what made four
    # stopped instances report 77 updates that no apply could ever install, failing
    # every run with "Instance is not running" and keeping the Network's failed
    # count permanently red for machines that are deliberately down. Nothing is
    # hidden while one is out of service: the first scan after it starts again
    # re-detects the same updates and they come back as pending.
    if kind == "container" and state and state.upper() != "RUNNING":
        db.expire_findings(conn, [target_id], set())
        report.manager_status["instance"] = "not-running"
        report.errors.append(f"instance is not running (state: {state})")
        db.touch_target(conn, target_id, error=f"instance is not running (state: {state})",
                        looked=False)
        return report

    seen: set[tuple[int, str, str]] = set()
    for manager, fn in (("apt", _record_apt), ("snap", _record_snap), ("docker", _record_docker)):
        if manager not in policy.scopes:
            continue
        try:
            found = fn(conn, target_id, host, container, settings, report)
        except Exception as exc:  # one manager failing must not lose the others
            report.manager_status[manager] = "error"
            report.errors.append(f"{manager}: {exc}")
            continue
        seen.update((target_id, m, p) for m, p in found)

    # EXPIRY ONLY RUNS ON A REAL VERDICT, and this is the line that keeps the
    # dashboard honest in both directions. `ok` and `partial` mean a manager
    # actually read the machine; `absent`, `error` and `timeout` mean it did not.
    # Expiring on any of those would erase a target's findings because a tool was
    # missing or a command timed out — the drift this tool exists to surface,
    # deleted by the tool itself. Deriving this from the statuses rather than
    # setting a flag in the loop is deliberate: a new manager cannot forget to
    # declare whether it really looked.
    looked = any(state in ("ok", "partial") for state in report.manager_status.values())
    if looked:
        protect = {(target_id, m, p) for m, p in report.inconclusive}
        db.expire_findings(conn, [target_id], seen, protect=protect)

    db.touch_target(conn, target_id, error="; ".join(report.errors) or None,
                    looked=report.scanned)
    return report


def scan_network(conn, settings: Settings, policy: Policy, *, trigger: str = "manual",
                host_names: list[str] | None = None) -> dict:
    """Scan the Network and return the run summary the GUI shows."""
    hosts = [h for h in settings.hosts if not host_names or h.name in host_names]
    run_id = db.start_run(conn, "scan", trigger)
    db.log(conn, f"scan started ({trigger}) for {len(hosts)} host(s)", run_id=run_id)

    reports: list[TargetReport] = []

    def work(host: Host) -> list[TargetReport]:
        def record_reboot() -> None:
            """Ask the host whether it is waiting to restart, and record the answer.

            Asked on every scan rather than only after an apply, because a kernel
            installed by somebody else's `unattended-upgrades` at 04:00 leaves
            exactly the same fact behind. It is a fact about the *machine* and not
            about any target on it, so it is recorded against the host row rather
            than as a finding: a reboot is not a package to approve.

            Nothing is recorded when the probe did not answer — see
            `db.record_reboot_state`. The alternative is a report that forgets a
            pending reboot because one SSH connection was slow.
            """
            probe = reboot_probe(host, settings.ssh_timeout)
            if not probe.ok:
                return
            state = scanners.parse_reboot_state(probe.stdout)
            db.record_reboot_state(conn, name=host.name, state=state)
            if state.required:
                count = len(state.packages)
                db.log(conn,
                       f"{host.name} is waiting for a reboot"
                       + (f" ({count} package(s) asked for it)" if count else ""),
                       level="warning", run_id=run_id)

        try:
            identity = ssh(host, OS_RELEASE, settings.ssh_timeout)
            if identity.error or identity.timed_out or not identity.ok:
                db.upsert_host(conn, name=host.name, address=host.address, kind=host.kind,
                               ssh_user=host.ssh_user, reachable=False, error=identity.message)
                db.log(conn, f"{host.name} unreachable: {identity.message}", level="error",
                       run_id=run_id)
                bad = TargetReport(host.name, host.name, "host")
                bad.manager_status["ssh"] = "error"
                bad.errors.append(identity.message)
                return [bad]

            os_name, _, kernel = (identity.stdout.strip() + "||").partition("|")
            instances: list[tuple[str, str]] = []
            # A kind is only asked for its guests when this deployment can actually
            # enumerate them (see `WORKLOAD_KINDS`). A Proxmox node, a VMware host or
            # a bare-metal box is scanned as a machine in its own right — which is
            # the correct answer, not a fallback.
            if host.kind in WORKLOAD_KINDS:
                # `-c ns` (name, state), not `-c n`: the state is what lets a
                # stopped instance be reported as out of service instead of being
                # probed, failing, and leaving stale findings behind.
                listing = incus(host, ["list", "--format", "csv", "-c", "ns",
                                       "--project", "default"],
                                settings.ssh_timeout)
                instances = _parse_instances(listing)
                if listing.timed_out or not listing.ok:
                    # Enumerate containers or do not pretend to: a host whose
                    # container list failed would otherwise contribute one host
                    # target and silently omit all 27 containers.
                    db.upsert_host(conn, name=host.name, address=host.address, kind=host.kind,
                                   ssh_user=host.ssh_user, reachable=False,
                                   os_name=os_name.strip() or None, kernel=kernel.strip() or None,
                                   error=f"incus list failed: {listing.message}")
                    # The host answered SSH, so its reboot state can still be read even
                    # though the list of what runs on it could not.
                    record_reboot()
                    db.log(conn, f"{host.name}: incus list failed: {listing.message}",
                           level="error", run_id=run_id)
                    return [TargetReport(host.name, host.name, "host")]

            db.upsert_host(conn, name=host.name, address=host.address, kind=host.kind,
                           ssh_user=host.ssh_user, reachable=True, os_name=os_name.strip() or None,
                           kernel=kernel.strip() or None, container_count=len(instances))
            record_reboot()
            db.log(conn, f"{host.name} up: {os_name.strip()} ({len(instances)} container(s))",
                   run_id=run_id)

            out = [scan_target(conn, host=host, name=host.name, kind="host", container=None,
                               settings=settings, policy=policy)]
            for name, state in instances:
                out.append(scan_target(conn, host=host, name=name, kind="container", container=name,
                                       settings=settings, policy=policy, state=state))
            return out
        except Exception as exc:  # a host-level crash must not abort the run
            db.upsert_host(conn, name=host.name, address=host.address, kind=host.kind,
                           ssh_user=host.ssh_user, reachable=False, error=str(exc))
            db.log(conn, f"{host.name} scan error: {exc}", level="error", run_id=run_id)
            bad = TargetReport(host.name, host.name, "host")
            bad.manager_status["scan"] = "error"
            bad.errors.append(str(exc))
            return [bad]

    with futures.ThreadPoolExecutor(max_workers=max(1, policy.max_concurrent)) as pool:
        for result in pool.map(work, hosts):
            reports.extend(result)

    for report in reports:
        for message in report.errors:
            db.log(conn, f"{report.host}/{report.name}: {message}",
                   level="error" if not report.scanned else "warning", run_id=run_id)

    looked = sum(1 for r in reports if r.scanned)
    total = sum(r.findings for r in reports)
    status = "ok" if looked else "error"
    summary = _run_summary(reports)
    db.finish_run(conn, run_id, status=status, findings=total, summary=summary)
    db.log(conn, f"scan finished: {summary}", run_id=run_id)
    conn.commit()
    return {
        "run_id": run_id,
        "targets": len(reports),
        "scanned": looked,
        "findings": total,
        "status": status,
        "summary": summary,
        "hosts": [
            {"host": r.host, "target": r.name, "kind": r.kind, "findings": r.findings,
             "scanned": r.scanned, "managers": r.manager_status, "errors": r.errors}
            for r in reports
        ],
    }


def host_admin_summary(conn) -> dict:
    """Counts for the dashboard header. `unknown` is first-class, not folded in.

    `unknown` answers "we could not look", and it has two sources: a host that did
    not answer, and a target whose last scan reached no verdict — a stopped
    instance, a probe that timed out, every manager on it failing or missing.

    The second used to be counted as "never scanned" (`last_scanned_at IS NULL`),
    which a target stops being the moment the first scan touches it — and a scan that
    could not read a machine still touches it, because the moment of the attempt is
    worth recording. A stopped instance therefore counted as inspected for as long as
    it stayed down, which is how the dashboard showed nothing unknown over precisely
    the machines nobody could read. The count now reads the flag the scan writes
    (`targets.last_scanned_ok`), so a failed look stays unknown until a scan really
    does read the target.

    `reboot_required` is the count of hosts that have installed a new kernel and not
    restarted since. It is a header count rather than a column because it is an
    all-clear-or-not number: every package on such a host reports current, so
    nothing else on this page moves when it appears.
    """
    row = conn.execute(
        """
        SELECT
          (SELECT COUNT(*) FROM hosts)                                    AS hosts,
          (SELECT COUNT(*) FROM hosts WHERE reachable=1)                  AS reachable,
          (SELECT COUNT(*) FROM targets)                                  AS targets,
          (SELECT COUNT(*) FROM targets
            WHERE last_scanned_at IS NULL
               OR COALESCE(last_scanned_ok,0)=0)                          AS unscanned,
          (SELECT COUNT(*) FROM findings WHERE status='pending')          AS pending,
          (SELECT COUNT(*) FROM findings WHERE status='approved')         AS approved,
          (SELECT COUNT(*) FROM findings WHERE status='failed')           AS failed,
          (SELECT COUNT(*) FROM findings WHERE security=1 AND status='pending') AS security,
          (SELECT COUNT(*) FROM hosts WHERE reboot_required=1)            AS reboot_required
        """
    ).fetchone()
    data = dict(row)
    data["unknown"] = int(data["unscanned"]) + max(0, int(data["hosts"]) - int(data["reachable"]))
    return data
