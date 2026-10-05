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
import threading
from dataclasses import dataclass, field

from . import db, reconcile, scanners
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
# A `repo@sha256:…` reference names one immutable manifest list, so the platform
# digest it resolves to never changes. Cached far longer than a tag's answer (which
# can be repointed), which keeps the resolution to one extra request per image
# *version* rather than one per scan.
PINNED_DIGEST_TTL_SECONDS = 365 * 24 * 3600
# A pinned index the registry will not resolve — a pruned manifest, a reference that is
# not a list, a registry that refused — is remembered briefly instead of being asked
# again on every scan. Without this, an image whose old index is gone re-consumes a
# warm-up slot and a request on every pass and is *never* resolved, and a handful of them
# would starve the indices that can be. It is short because an index missing today may be
# published or unpruned tomorrow, and it deliberately does not record an *answer*: the
# image stays unjudged, so this can never report a Network as up to date.
PINNED_MISS_TTL_SECONDS = 6 * 3600
OS_RELEASE = ["sh", "-c", ". /etc/os-release 2>/dev/null && printf '%s|%s\\n' \"$PRETTY_NAME\" \"$(uname -r)\""]

Seen = set  # of (manager, package)


class PinWarmBudget:
    """How many *new* manifest-list resolutions one scan may make.

    Warming the pinned-index cache costs one extra registry request per multi-arch
    image version: `repo@<index>` must be asked, once, for the platform digest the
    local index resolves to (see `_resolve_local_platform`). Resolving it lazily already
    dedupes across hosts and images within a run, but a first scan against a cold cache
    would still spend every one of them at once — and the budget for asking Docker Hub
    anonymously is roughly a hundred requests per six hours *per address*, shared with
    the image pulls. That burst is what gets a scan answered with 429s and, worse, leaves
    the pulls competing for an allowance the scan just spent.

    So a scan resolves at most `limit` indices it has not seen before, shared across the
    hosts it scans concurrently (hence the lock). The rest are left unjudged — protected,
    not called current — and picked up by later scans, which turns one burst into a
    trickle and never invents a finding.

    Each index is *claimed* at most once per run. Hosts run concurrently and routinely
    carry the same image, so without that a busy Network would spend several slots on the
    same `repo@<index>` — several requests where one would do, and a second host left
    unjudged anyway once the cache is written. The claim means a duplicate is treated as
    deferred rather than re-requested; the next scan reads the answer from the cache.
    `limit = 0` means no cap and no coalescing, which is the behavior before this existed
    and the right choice for a deployment with a registry of its own.
    """

    def __init__(self, limit: int = 0):
        self._limit = max(0, int(limit))
        self._taken = 0
        self._claimed: set[str] = set()
        self._lock = threading.Lock()

    def take(self, ref: str = "") -> bool:
        """Claim `ref`, or refuse when it is already claimed or the budget is spent."""
        if self._limit == 0:
            return True
        with self._lock:
            if ref and ref in self._claimed:
                return False
            if self._taken >= self._limit:
                return False
            if ref:
                self._claimed.add(ref)
            self._taken += 1
            return True


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


def _pin_miss_key(ref: str) -> str:
    """Cache key for a pinned index the registry could not resolve (`PINNED_MISS_TTL_SECONDS`).

    A separate namespace from the answer, so a miss is never mistaken for a digest and a
    later success plainly overwrites nothing.
    """
    return f"pinmiss:{ref}"


def _kind_key(ref: str) -> str:
    """Cache key for a tag's manifest kind (`list` or `single`).

    Stored beside the digest rather than inferred at read time: the kind cannot be
    recovered from the digest alone, and the comparison depends on it (see
    `scanners.parse_manifest`).
    """
    return f"kind:{ref}"


def _resolve_local_platform(conn, host: Host, container: str, repo: str,
                            local_digest: str, settings: Settings,
                            authenticate, warm: PinWarmBudget) -> str | None:
    """A multi-arch image's platform digest, from the index digest it was pulled by.

    `local_digest` is the local `RepoDigest` of a manifest list: the *index* digest,
    which names the same immutable list the image came from. Asking the registry for
    that exact list — `repo@<index>` — and taking this architecture's entry yields the
    platform digest the local image actually runs, which is the only thing comparable
    to the digest `docker manifest inspect <tag>` returned for the tag as it is now.

    The answer is immutable for a given index, so it is cached far longer than a
    tag's answer (`PINNED_DIGEST_TTL_SECONDS`): the extra request costs one per image
    *version*, not one per scan. An empty result — the index was pruned, or the
    registry refused — is unjudged, not current.

    Returns `None` when this scan will not resolve the index this time — either it has
    spent its warm-up budget (`warm`) or another host is already resolving the same index
    in this run — and the answer is not already cached. That is *deferred*, not
    *unresolvable*: the image is left unjudged exactly as an empty answer would leave it,
    but the caller reports it as a budget deferral rather than as a registry that could not
    resolve the index, because the two mean different things to an operator — one clears on
    the next scan, the other may not.
    """
    pinned_ref = f"{repo}@{local_digest}"
    ttl = PINNED_DIGEST_TTL_SECONDS if settings.digest_ttl_seconds > 0 else 0
    miss_ttl = PINNED_MISS_TTL_SECONDS if settings.digest_ttl_seconds > 0 else 0
    cached = db.get_digest(conn, pinned_ref, ttl_seconds=ttl)
    if cached is not None:
        return cached
    if db.get_digest(conn, _pin_miss_key(pinned_ref), ttl_seconds=miss_ttl) is not None:
        # Known unresolvable recently: no request and, importantly, no warm-up slot — a
        # budget that a gone index eats every scan is a budget the resolvable ones need.
        return ""
    if not warm.take(pinned_ref):
        return None
    authenticate(pinned_ref)
    manifest = docker_in_container(
        host, container, ["manifest", "inspect", "--verbose", pinned_ref],
        settings.command_timeout)
    platform = scanners.parse_manifest(manifest.stdout)[0] if manifest.ok else ""
    if platform:
        db.set_digest(conn, pinned_ref, platform)
        return platform
    # No platform digest came back. Remember the miss so the next scans skip it; the miss
    # never records an answer, so the image is left unjudged rather than called current.
    db.set_digest(conn, _pin_miss_key(pinned_ref), "1")
    return ""


def _record_docker(conn, target_id: int, host: Host, container: str | None,
                   settings: Settings, report: TargetReport,
                   warm: PinWarmBudget) -> Seen:
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

    AND ONLY WHEN THE DAEMON IS NOT ALREADY AUTHENTICATED. A login is itself a
    request the registry counts, and the daemon keeps the credential in its own
    config, so a scan within `Settings.login_ttl_seconds` of the last one skips it
    (`db.registry_login_is_fresh`). The pull path authenticates unconditionally, so
    a rotated token is still caught where it matters and this side only inherits the
    result.

    AND A MULTI-ARCH TAG IS COMPARED LIKE FOR LIKE. The local `RepoDigest` of a
    multi-arch image is the *index* digest, while `docker manifest inspect` answers
    with the *platform* digest — two different values that never coincide. Comparing
    them directly, as this used to, reported every multi-arch tag as behind on every
    scan and never let the finding clear: the pull it suggested said "up to date".
    When the tag is a manifest list this resolves the local index to its own platform
    digest first (`_resolve_local_platform`) and compares that; a single-manifest tag
    is compared directly, because there its `RepoDigest` *is* the manifest digest.
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
    # Locally built images: no repository digest, so no registry can give a verdict.
    unjudged = 0
    # Images the registry could not answer about at all — a refused manifest, or a pinned
    # index it will not resolve. Counted apart from `unjudged` because the sentence an
    # operator needs is different, and percent-apart from `deferred` because this one may
    # not clear on the next scan.
    unresolved = 0
    # Multi-arch images left unjudged because this scan has spent its warm-up budget (or
    # another host claimed the same index first). A deferral clears on a later scan.
    deferred = 0
    # (container, registry) pairs already logged in during this call. The daemon
    # keeps the credential, so one login covers every later request on the same
    # host and target; doing it per request would spend the budget the request needs.
    logged_in: set[tuple[str, str]] = set()

    def authenticate(request_ref: str) -> None:
        """Log in to `request_ref`'s registry when this deployment holds a credential.

        Called before *any* registry request — the tag's manifest and the pinned
        index's — so both are answered from the account's allowance rather than the
        anonymous budget the pulls share. At most once per (container, registry): the
        daemon keeps the credential, and a login is itself a request the registry
        counts. A failure is not fatal (the manifest is still attempted) but it is
        reported, so a rotated token shows up as itself.
        """
        registry = registry_of(request_ref)
        credential = settings.credential_for(registry)
        if credential is None or (container, registry) in logged_in:
            return
        logged_in.add((container, registry))
        if not db.registry_login_is_fresh(
                conn, host=host.name, container=container, registry=registry,
                ttl_seconds=settings.login_ttl_seconds):
            login = docker_login(host, container, registry, credential, settings)
            if login.ok:
                db.record_registry_login(
                    conn, host=host.name, container=container, registry=registry)
            else:
                report.errors.append(f"docker login to {registry} failed: {login.message}")

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
        kind = db.get_digest(conn, _kind_key(ref), ttl_seconds=settings.digest_ttl_seconds)
        if remote_digest is None or kind is None:
            # `kind` is fetched and cached with the digest because the comparison
            # needs it as much as the digest itself: it says whether the local
            # RepoDigest is directly comparable or must first be resolved. When it is
            # missing the digest is re-fetched rather than the question guessed at —
            # an older cache entry predates this fact and is no reason to compare the
            # wrong pair of digests.
            authenticate(ref)
            manifest = docker_in_container(
                host, container, ["manifest", "inspect", "--verbose", ref], settings.command_timeout
            )
            remote_digest, kind = (
                scanners.parse_manifest(manifest.stdout) if manifest.ok else ("", "")
            )
            if remote_digest:
                db.set_digest(conn, ref, remote_digest)
                db.set_digest(conn, _kind_key(ref), kind)
        if kind == "list":
            # A manifest list's local RepoDigest is an *index* digest; resolve the
            # image's own index to this host's platform digest before comparing, or
            # every multi-arch tag reads as behind forever.
            local_platform = _resolve_local_platform(
                conn, host, container, repo, local_digest, settings, authenticate, warm)
            if local_platform is None:
                # The warm-up budget is spent for this scan. Not a verdict either way.
                deferred += 1
                report.inconclusive.add(("docker", ref))
                continue
            behind = scanners.image_is_behind(local_platform, remote_digest)
        else:
            behind = scanners.image_is_behind(local_digest, remote_digest)
        if behind is None:
            # No verdict. The image is protected rather than confirmed: a finding
            # already on record for it stays (we could not check), and no new one is
            # invented. Note it is NOT added to `seen` — "seen" means judged.
            unresolved += 1
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
    report.manager_status["docker"] = "ok" if not (unjudged or unresolved or deferred) else "partial"
    if unjudged:
        report.errors.append(f"docker: {unjudged} image(s) not in a registry — not compared")
    if unresolved:
        report.errors.append(f"docker: {unresolved} image(s) the registry could not answer about — not compared")
    if deferred:
        report.errors.append(
            f"docker: {deferred} multi-arch image(s) left unjudged while the "
            f"pinned-index cache warms — they are re-checked on a later scan")
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
                settings: Settings, policy: Policy, state: str | None = None,
                warm: PinWarmBudget | None = None) -> TargetReport:
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

    # One warm-up budget per *run*, created by `scan_network` and shared by every target
    # and thread below, so the cost of warming the pinned-index cache is bounded for the
    # whole Network and not per host (a per-host budget would multiply the burst by the
    # number of machines). A direct caller that passes none gets an uncapped one, which is
    # exactly the behavior before the budget existed.
    warm = warm or PinWarmBudget(0)

    seen: set[tuple[int, str, str]] = set()
    for manager, fn in (("apt", _record_apt), ("snap", _record_snap), ("docker", _record_docker)):
        if manager not in policy.scopes:
            continue
        try:
            found = (fn(conn, target_id, host, container, settings, report, warm)
                     if manager == "docker"
                     else fn(conn, target_id, host, container, settings, report))
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
    # One warm budget for the whole run: the pinned-index cache is a property of the
    # Network, not of a host, so the extra registry requests it costs are bounded once
    # rather than once per machine. See `PinWarmBudget`.
    warm = PinWarmBudget(settings.docker_pin_warm_budget)

    reports: list[TargetReport] = []
    # Host name -> the target names its prune dropped. Collected under a lock
    # because the hosts are scanned concurrently, and handed to the reconcile
    # report at the end, which is the only place they are still knowable: the rows
    # themselves are gone by then.
    vanished: dict[str, list[str]] = {}
    vanished_lock = threading.Lock()

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

            # A container the list no longer names has been removed, and its findings
            # can never be re-detected, applied or expired — so they would sit red for
            # a machine that is not there, and the host would keep counting it. Only
            # done with a real listing in hand: a failed `incus list` returned above,
            # so reaching here means the list is authoritative and a missing name
            # really was removed rather than merely unasked.
            if host.kind in WORKLOAD_KINDS:
                removed = db.prune_targets(conn, host=host.name, kind="container",
                                           present={name for name, _ in instances})
                if removed:
                    with vanished_lock:
                        vanished[host.name] = removed
                    shown = ", ".join(sorted(removed)[:8])
                    more = "" if len(removed) <= 8 else f" (+{len(removed) - 8} more)"
                    db.log(conn,
                           f"{host.name}: dropped {len(removed)} target(s) no longer "
                           f"present: {shown}{more}", level="warning", run_id=run_id)

            out = [scan_target(conn, host=host, name=host.name, kind="host", container=None,
                               settings=settings, policy=policy, warm=warm)]
            for name, state in instances:
                out.append(scan_target(conn, host=host, name=name, kind="container", container=name,
                                       settings=settings, policy=policy, state=state, warm=warm))
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
    # The reconcile runs inside the scan so the scheduled timer carries it, and so
    # "what vanished" is reported in the same breath as the scan that discovered it.
    # It is read-and-record only — it never applies, expires or deletes anything.
    reconciliation = reconcile.reconcile(conn, settings, vanished=vanished, trigger=trigger)
    conn.commit()
    return {
        "run_id": run_id,
        "targets": len(reports),
        "scanned": looked,
        "findings": total,
        "status": status,
        "summary": summary,
        "reconcile": reconciliation,
        "hosts": [
            {"host": r.host, "target": r.name, "kind": r.kind, "findings": r.findings,
             "scanned": r.scanned, "managers": r.manager_status, "errors": r.errors}
            for r in reports
        ],
    }


def host_admin_summary(conn, *, stale_failure_seconds: int | None = None) -> dict:
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
    # The header's `failed` is "red right now"; this is "red long enough to be a
    # decision". Only counted when the caller names a threshold, so a caller that has
    # no Settings (and the existing tests) sees exactly the row it always did. See
    # `reconcile.py` for what the number is for.
    if stale_failure_seconds is not None:
        data["stale_failures"] = len(
            db.stale_failures(conn, older_than_seconds=stale_failure_seconds))
    return data
