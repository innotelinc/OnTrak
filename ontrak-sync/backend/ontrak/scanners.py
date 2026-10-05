"""Ontrak Sync — deciding what is behind.

This module is deliberately pure: it takes the *text* a package manager printed
and returns findings. No subprocesses, no SSH, no database. That is what makes the
hard part testable, and the hard part is not the plumbing — it is that these
parsers decide what an operator is told to install across a whole Network.

THE RULE THEY ALL FOLLOW: **unknown is not up-to-date.**
Every parser here can fail to understand a line. When it does, it says so rather
than dropping the line, because the two mistakes are not equally bad. Missing an
update costs a patch window. Reporting a package as current because its output
format changed means the Network looks patched while it is not, and that is the
failure mode a patch-monitoring tool exists to prevent — it is exactly how
PatchMon's agent tables read `0 pending` while hosts were drifting.

WHY `apt-get -s upgrade` AND NOT `apt list --upgradable`
-------------------------------------------------------
Both print the candidate, but only the simulation names the *archive* it would
come from, and the archive is the only reliable way to tell a security update from
a feature update. `noble-security` and `noble-updates` are distinguishable;
`[upgradable from: …]` is not, and neither is a version-string heuristic. So the
simulation is the source and `apt list --upgradable` is the cross-check.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

# `Inst name [old] (new Archive[, Archive...] [arch])` — the `-s` simulation, and
# the only format that carries the archive. The old version is absent for a package
# not installed yet, and the archive is absent for one with no candidate archive;
# both are handled rather than assumed.
#
# THE ARCHIVE COLUMN IS A LIST, and capturing it as a single `\S+` is how this
# parser silently rejected most of the Network. A package published in both an
# updates and a security pocket — which is what a security update IS — is printed
# as `(2.39-0ubuntu8.9 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security
# [amd64])`, two tokens where the old pattern allowed one, so every such line fell
# through to `unparsed` and the simulation contributed nothing. The cross-check in
# `parse_apt_upgradable` kept the findings visible, which is exactly why the bug
# was worth finding rather than merely inconvenient. The whole parenthesised column
# is captured and split afterwards instead of being matched token-wise.
_SIMULATE = re.compile(
    r"^Inst\s+(?P<name>\S+)(?:\s+\[(?P<old>[^\]]*)\])?\s+\((?P<candidate>[^)]*)\)"
)
# A trailing `[amd64]` in the candidate column is the target architecture, not an
# archive, and must not reach `is_security_suite`.
_ARCH_SUFFIX = re.compile(r"\s*\[[^\]]*\]\s*$")

# `name/suite arch new-version [upgradable from: old]` — `apt list --upgradable`.
_UPGRADABLE = re.compile(
    r"^(?P<name>[^/\s]+)/(?P<suite>\S+)\s+(?P<new>\S+)\s+(?P<arch>\S+)(?:\s+\[upgradable from:\s*(?P<old>[^\]]+)\])?"
)

# A suite is a security suite if the distribution's `-security` pocket is in it.
# Matched as a suffix on a hyphen boundary so `noble-security` and
# `bookworm-security` both hit and `noble-updates` does neither.
_SECURITY_SUITE = re.compile(r"(?:^|[-/])security(?:$|[-/])")


@dataclass(frozen=True)
class Update:
    """One package, one reason to act."""

    manager: str
    package: str
    current: str = ""
    candidate: str = ""
    security: bool = False
    detail: str = ""

    def as_dict(self) -> dict:
        return {
            "manager": self.manager, "package": self.package, "current": self.current,
            "candidate": self.candidate, "security": self.security, "detail": self.detail,
        }


def is_security_suite(suite: str) -> bool:
    """Is this apt suite a security pocket?"""
    return bool(_SECURITY_SUITE.search(suite or ""))


def parse_apt_simulate(text: str) -> tuple[list[Update], list[str]]:
    """Parse `apt-get -s upgrade`. Returns `(updates, lines_not_understood)`.

    The candidate column is `<version> <archive>[, <archive>...] [<arch>]`, so it is
    split rather than matched: the version is the first token, the architecture is
    whatever trailing bracket is left, and the archives are the rest. A line is only
    unparsed when it has no parenthesised column at all, which is a real change in
    apt's output rather than a package this code cannot describe.
    """
    updates: list[Update] = []
    unparsed: list[str] = []
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.startswith("Inst "):
            continue
        match = _SIMULATE.match(line)
        if not match:
            unparsed.append(line)
            continue
        version, _, archives = match.group("candidate").strip().partition(" ")
        archives = _ARCH_SUFFIX.sub("", archives).strip().strip(",").strip()
        updates.append(Update(
            manager="apt",
            package=match.group("name"),
            current=(match.group("old") or "").strip(),
            candidate=version.strip(),
            security=is_security_suite(archives),
            detail=archives,
        ))
    return updates, unparsed


def parse_apt_upgradable(text: str) -> tuple[list[Update], list[str]]:
    """Parse `apt list --upgradable`. Returns `(updates, lines_not_understood)`.

    Used as the cross-check on the simulation rather than as the source, because
    this format has no archive column — see the module docstring. A package this
    sees and the simulation did not is reported as a plain update (not security)
    rather than ignored, since the *candidate* still came from apt.
    """
    updates: list[Update] = []
    unparsed: list[str] = []
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line or line.startswith("Listing"):
            continue
        if "upgradable from" not in line and "/" not in line:
            continue  # a header or a blank `apt` prints on some versions
        match = _UPGRADABLE.match(line)
        if not match:
            unparsed.append(line)
            continue
        updates.append(Update(
            manager="apt",
            package=match.group("name"),
            current=(match.group("old") or "").strip(),
            candidate=match.group("new"),
            security=is_security_suite(match.group("suite")),
            detail=match.group("suite"),
        ))
    return updates, unparsed


def merge_apt(simulated: list[Update], listed: list[Update]) -> list[Update]:
    """Union the two apt views into one list per package.

    The simulation wins by default: it is the view that carries the archive, and
    therefore the one whose `security` flag is trustworthy. `apt list` is kept
    because it can see a package the simulation skipped (held, phased, pinned
    differently), which should still be reported — as a plain update, which is
    what it is.

    WHEN THEY DISAGREE ABOUT SECURITY, THE ALARM WINS. If either view says a
    package comes from a `-security` pocket, the finding is marked security. The
    two mistakes are not symmetric: a false alarm costs someone a glance at a
    package that turned out to be a feature update, while a missed security flag
    means a CVE fix sits in a backlog marked "routine".
    """
    merged: dict[str, Update] = {u.package: u for u in simulated}
    for update in listed:
        existing = merged.get(update.package)
        if existing is None:
            merged[update.package] = update
        elif update.security and not existing.security:
            merged[update.package] = Update(
                manager="apt", package=existing.package, current=existing.current,
                candidate=existing.candidate, security=True,
                detail=existing.detail or update.detail,
            )
    return sorted(merged.values(), key=lambda u: (not u.security, u.package))


# ── snap ─────────────────────────────────────────────────────────────────────
# `snap refresh --list` is a fixed-width table with a `Name Version Rev Size
# Publisher Notes` header. Columns are separated by runs of two or more spaces,
# which is stable; counting characters is not.
_SNAP_ROW = re.compile(r"^(?P<name>\S+)\s{2,}(?P<version>\S+)\s{2,}(?P<rev>\S+)\s{2,}")

# The two ways `snap` says it has nothing to do. Both are a result, not a line this
# code failed to understand, and treating "All snaps up to date." as unparsed made
# every snap-carrying host report a `partial` snap manager and an error line — a
# permanently alarming dashboard for the most ordinary possible state.
_SNAP_NOTHING = ("No refreshes available", "All snaps up to date")


def parse_snap_refresh(text: str) -> tuple[list[Update], list[str]]:
    """Parse `snap refresh --list`. Returns `(updates, lines_not_understood)`."""
    updates: list[Update] = []
    unparsed: list[str] = []
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip() or line.startswith("Name ") or line.startswith(_SNAP_NOTHING):
            continue
        match = _SNAP_ROW.match(line)
        if not match:
            unparsed.append(line)
            continue
        updates.append(Update(
            manager="snap",
            package=match.group("name"),
            candidate=match.group("version"),
            detail=f"rev {match.group('rev')}",
        ))
    return updates, unparsed


# ── docker ───────────────────────────────────────────────────────────────────
def parse_repo_digest(text: str) -> str:
    """The digest from `docker image inspect --format '{{json .RepoDigests}}'`.

    An image built locally has no `RepoDigest` — it was never pushed, so there is
    nothing to compare against and no remote to ask. That is `""`, which every
    caller must treat as *unknown*, not as current. This Network builds several
    images locally (`ghcr.io/innotelinc/olympus:local`, `innotel/npm-edge`), so
    this is the common case rather than an edge case.
    """
    try:
        digests = json.loads(text or "[]")
    except (ValueError, TypeError):
        return ""
    if not isinstance(digests, list) or not digests:
        return ""
    first = str(digests[0])
    return first.split("@", 1)[1] if "@" in first else ""


def parse_manifest(text: str, arch: str = "amd64", os_name: str = "linux") -> tuple[str, str]:
    """`docker manifest inspect --verbose <ref>` → `(platform_digest, kind)`.

    Two shapes, because a multi-arch tag is a manifest list and a single-arch tag
    is not: a list has `.manifests[]` each with `.platform` and a digest, and a
    single image has `.Descriptor.digest` with no list. Returning the *platform*
    digest rather than the list's own digest is what makes the comparison correct —
    the list digest changes when any platform is republished, including ones this
    host does not run.

    `kind` is `"list"` for a multi-arch tag and `"single"` for a single-manifest
    one, and it is not decoration. It says which digest the local image's
    `RepoDigest` may be compared to: a single-arch tag's `RepoDigest` *is* its
    manifest digest, while a multi-arch tag's `RepoDigest` is the *index* digest —
    a different kind of value entirely — and must be resolved to this host's
    platform digest before the two can be compared at all. Comparing an index
    digest against a platform digest is how every multi-arch tag read as
    permanently behind (`ontrak.scan._record_docker` resolves it).
    """
    try:
        data = json.loads(text or "null")
    except (ValueError, TypeError):
        return "", ""
    if isinstance(data, list):
        for entry in data:
            desc = (entry or {}).get("Descriptor") or {}
            plat = desc.get("platform") or {}
            # `--verbose` on a list gives one entry per platform with its own
            # Descriptor; take the one this host would actually pull.
            if plat.get("architecture") == arch and (plat.get("os") or os_name) == os_name:
                return str(desc.get("digest") or ""), "list"
        # No matching platform is not "up to date"; it is unjudged.
        return "", "list"
    if isinstance(data, dict):
        desc = data.get("Descriptor") or data
        return str(desc.get("digest") or ""), "single"
    return "", ""


def parse_manifest_digest(text: str, arch: str = "amd64", os_name: str = "linux") -> str:
    """The platform digest from `docker manifest inspect --verbose <ref>`.

    A thin view of `parse_manifest` for callers that do not need to know whether
    the tag was a list or a single manifest.
    """
    return parse_manifest(text, arch, os_name)[0]


def image_is_behind(local_digest: str, remote_digest: str) -> bool | None:
    """Is the local image older than the registry's? `None` means unknowable.

    Three-valued on purpose. `False` ("current") and `None` ("cannot tell") must
    stay distinct: a locally built image, an unreachable registry and a rate-limited
    Docker Hub all produce `None`, and collapsing them into `False` would report an
    entire Network as up to date the first time a registry refused a token.
    """
    if not local_digest or not remote_digest:
        return None
    return local_digest != remote_digest


def parse_compose_images(text: str) -> dict[str, str]:
    """Service name -> image, from `docker compose config --format json`.

    Only used to know which service a container belongs to when recreating it, so
    the parse is small on purpose: anything without both keys is skipped rather
    than guessed at.
    """
    try:
        data = json.loads(text or "null")
    except (ValueError, TypeError):
        return {}
    services = (data or {}).get("services") or {}
    out: dict[str, str] = {}
    for name, spec in services.items():
        image = (spec or {}).get("image")
        if isinstance(image, str) and image:
            out[str(name)] = image
    return out


# ── the reboot ───────────────────────────────────────────────────────────────
# Unpacking a new kernel is not running one. The moment `apt` installs the
# replacement every package manager in this Network reports the host as up to
# date, while the machine goes on booting the old kernel until somebody restarts
# it — so a security fix for the kernel reads exactly like a finished patch run.
# That is the same class of untruth as "0 pending" on a host nobody could reach,
# and it is why a pending reboot is a verdict of its own rather than a line in
# some package's detail column.
#
# Debian and Ubuntu write the fact down (`/var/run/reboot-required`, plus a file
# naming the packages that asked for it); a distribution that keeps it some other
# way is *asked and does not answer*. Those are different answers, and `known` is
# what keeps them apart: a host whose reboot state this code could not read must
# not render as one that answered "nothing pending".
REBOOT_REQUIRED = "__ONTRAK_REBOOT_REQUIRED__"
REBOOT_CLEAR = "__ONTRAK_REBOOT_CLEAR__"
REBOOT_UNKNOWN = "__ONTRAK_REBOOT_UNKNOWN__"


@dataclass(frozen=True)
class RebootState:
    """What one host said when it was asked whether it is waiting to restart."""

    known: bool = False
    required: bool = False
    packages: tuple[str, ...] = ()

    def as_dict(self) -> dict:
        return {"known": self.known, "required": self.required,
                "packages": list(self.packages)}


# The answer a host that could not be asked gives. There is one instance of it
# because every caller means the same thing by it.
UNKNOWN_REBOOT = RebootState()


def parse_reboot_state(text: str) -> RebootState:
    """Parse the output of `remote.reboot_probe`.

    Three outcomes, and the third is not the second: required, clear, and *no
    answer* — an empty string, an unrecognised marker, or a distribution whose
    pending-reboot file this code does not know about. Only a marker that says the
    question was understood produces a `known` state, because "we did not ask" and
    "we asked and there is nothing pending" are the two answers a patch report must
    never swap.
    """
    lines = [line.strip() for line in (text or "").splitlines()]
    if REBOOT_REQUIRED in lines:
        # Everything after the marker is a package name, one per line, straight out
        # of the distribution's own file. De-duplicated and ordered rather than
        # trusted to be either: it is a list to show a person, not a fixture, and
        # the same package can be named twice on a host that upgraded it twice.
        packages = tuple(sorted({
            line for line in lines[lines.index(REBOOT_REQUIRED) + 1:]
            if line and not line.startswith("__ONTRAK_")
        }))
        return RebootState(known=True, required=True, packages=packages)
    if REBOOT_CLEAR in lines:
        return RebootState(known=True, required=False)
    return UNKNOWN_REBOOT
