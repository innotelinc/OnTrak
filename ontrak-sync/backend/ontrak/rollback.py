"""Ontrak Sync — the plan for undoing one apply run.

`apply_findings` moves packages forward; this module decides how to move them back,
and it is pure for the same reason `waves.py` is: the order and the arguments are
the dangerous part, and they should be testable without a host.

WHY A RUN, AND NOT A FINDING
----------------------------
A finding is one row per package, rewritten by the next scan. "Roll back nginx" is
therefore not a question with an answer — rolled back to *what*? A run is the thing
an operator decided to do, and `db.applied_packages` keeps, per run, the version
each package had before it. So a rollback is addressed by run id, and the rows it
may touch are exactly the ones that run moved.

WHAT IT WILL NOT DO
-------------------
  * **No inferred version.** A row with no recorded `from_version` is refused by
    name. Falling back to `findings.current` would install whatever the last scan
    happened to write, which is not the version this run replaced.
  * **No image rollback here.** Docker findings are recreated containers, and
    undoing one is `applier.undo_roll`'s job with its own record. A package
    rollback that quietly skipped them, or worse ran `docker` commands of its own,
    would be a second, worse implementation of that.
  * **No partial plan.** If any row of the run cannot be reverted, the plan refuses
    the whole run and names every reason at once. Reverting half a run leaves the
    estate split between two versions with no record saying so.
"""

from __future__ import annotations

import shlex
from dataclasses import dataclass

# The managers a package rollback understands. `docker` is deliberately absent —
# see the module docstring.
PACKAGE_MANAGERS = ("apt", "snap")


@dataclass(frozen=True)
class Step:
    """One command group: a target, one manager, and the versions to put back."""

    host: str
    target: str
    kind: str
    manager: str
    packages: tuple[str, ...]
    versions: dict[str, str]
    argv: tuple[str, ...]
    # `applied_packages` rows this step is responsible for. Kept on the step so the
    # executor does not have to re-derive which rows a command covered: a step that
    # fails must leave its rows alone, and one that succeeds must stamp exactly its
    # own.
    applied_ids: tuple[int, ...] = ()

    @property
    def container(self) -> str | None:
        """Where to run it: the container when the target is not the host itself."""
        return None if self.target == self.host else self.target


@dataclass(frozen=True)
class Plan:
    steps: tuple[Step, ...] = ()
    refusals: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return not self.refusals

    @property
    def packages(self) -> int:
        return sum(len(step.packages) for step in self.steps)


def apt_argv(pins: list[tuple[str, str]]) -> tuple[str, ...]:
    """The one apt transaction that puts `pkg=version` back.

    `--allow-downgrades` is the whole point: apt refuses to move a package
    backwards without it, and `--only-upgrade` (which the forward apply relies on)
    makes a downgrade impossible by definition. There is no `apt-get update` here,
    deliberately — re-reading the index is how a "put 1.0 back" turns into "install
    today's 1.3", and the cached .deb from the upgrade is what this is meant to
    use. When the package is not cached the transaction fails, and the finding is
    reported as still applied rather than as rolled back.

    `force-confdef`/`force-confold` for the same reason as the forward path: an
    unattended rollback must not replace a tuned config with the older maintainer's.
    """
    joined = " ".join(f"{shlex.quote(pkg)}={shlex.quote(version)}" for pkg, version in pins)
    command = (
        "export DEBIAN_FRONTEND=noninteractive LC_ALL=C; "
        "apt-get -y -o Dpkg::Options::=--force-confdef "
        "-o Dpkg::Options::=--force-confold install --allow-downgrades " + joined
    )
    return ("sh", "-c", command)


def snap_argv(package: str) -> tuple[str, ...]:
    """`snap revert` takes one snap at a time, so this is one step per package."""
    return ("sh", "-c", "LC_ALL=C snap revert " + shlex.quote(package))


def plan(rows: list[dict]) -> Plan:
    """What it would take to put `rows` (one run's applied packages) back.

    The refusals are returned as a tuple of sentences rather than raised, so the
    caller can put every one of them in the run log and the HTTP answer at once.
    """
    refusals: list[str] = []
    by_target: dict[tuple[str, str, str], list[dict]] = {}

    for row in rows:
        manager = str(row.get("manager") or "")
        package = str(row.get("package") or "")
        target = str(row.get("target") or "")
        host = str(row.get("host") or "")
        from_version = row.get("from_version")
        if manager not in PACKAGE_MANAGERS:
            refusals.append(
                f"{package or 'a package'} on {target or host}: {manager or 'this manager'} "
                "has no package revert — container images are undone by `undo_roll`, "
                "not by a rollback of this run"
            )
            continue
        if not from_version:
            refusals.append(
                f"{package or 'a package'} on {target or host}: the version this run "
                "replaced was not recorded, so there is nothing to go back to"
            )
            continue
        by_target.setdefault((host, target, manager), []).append(row)

    if refusals:
        # All-or-nothing: see the module docstring. Nothing is executed when the
        # plan is refused, so a partial revert cannot happen by accident.
        return Plan(refusals=tuple(refusals))

    steps: list[Step] = []
    for (host, target, manager), group in by_target.items():
        group.sort(key=lambda row: str(row["package"]))
        if manager == "apt":
            pins = [(str(row["package"]), str(row["from_version"])) for row in group]
            steps.append(Step(
                host=host,
                target=target,
                kind=str(group[0].get("kind") or "host"),
                manager=manager,
                packages=tuple(package for package, _ in pins),
                versions={package: version for package, version in pins},
                argv=apt_argv(pins),
                applied_ids=tuple(int(row["id"]) for row in group),
            ))
            continue
        for row in group:
            package = str(row["package"])
            steps.append(Step(
                host=host,
                target=target,
                kind=str(row.get("kind") or "host"),
                manager=manager,
                packages=(package,),
                versions={package: str(row["from_version"])},
                argv=snap_argv(package),
                applied_ids=(int(row["id"]),),
            ))

    steps.sort(key=lambda step: (step.host, step.target, step.manager, step.packages))
    return Plan(steps=tuple(steps))
