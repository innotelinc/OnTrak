"""Ontrak Sync — the only code in this system that changes a machine.

Everything else reads. This writes, on potentially every host in the estate, and
so it is written to a different standard than the rest: every command is fixed
except for the package names, and those come from a database row rather than from
the command line.

WHAT IT WILL NOT DO
-------------------
These are not configurable, because each one is a way an update tool becomes an
outage:

  * **No `dist-upgrade`, ever.** A distribution upgrade replaces the kernel and
    can require a reboot, a new bootloader or a config migration. That is a
    maintenance window with a human in it, not a scheduled job.
  * **No removals and no new installs.** apt runs with `--only-upgrade`, so a
    dependency that has become unsatisfiable fails the transaction instead of
    quietly removing a package to satisfy it.
  * **No config-file prompts.** `force-confdef`/`force-confold` keeps the
    operator's config, which is what you want unattended — `force-confnew` would
    silently replace a tuned `nginx.conf` with the maintainer's.
  * **No blind container recreate.** Docker is the one manager where "apply" means
    *recreate*, and a recreate with the wrong compose invocation silently drops
    services. See `_docker_recreate` for the check that prevents it.

VERIFICATION IS NOT OPTIONAL
----------------------------
A finding only becomes `applied` after the applier re-reads the machine and
confirms the candidate is gone. Trusting the exit code would be cheaper and would
make the dashboard lie whenever apt exited 0 while dpkg held a package back —
which it does, routinely, and without failing.
"""

from __future__ import annotations

import json
import logging
import shlex
from dataclasses import dataclass, field

from . import db, scanners
from .config import Host, Settings
from .policy import Policy
from .remote import Result, docker_in_container, incus_exec, ssh

log = logging.getLogger("ontrak.apply")


@dataclass
class Outcome:
    """The result of applying one target's approved findings."""

    ok: bool
    applied: int = 0
    failed: int = 0
    messages: list[str] = field(default_factory=list)
    needs_manual: list[str] = field(default_factory=list)

    def note(self, message: str) -> None:
        self.messages.append(message[:400])


def _remote(host: Host, container: str | None, argv: list[str], settings: Settings) -> Result:
    if container is None:
        return ssh(host, argv, settings.command_timeout)
    return incus_exec(host, container, argv, settings.command_timeout)


def _docker(host: Host, container: str, args: list[str], settings: Settings) -> Result:
    return docker_in_container(host, container, args, settings.command_timeout)


# ── apt ──────────────────────────────────────────────────────────────────────
def apply_apt(host: Host, container: str | None, packages: list[str], settings: Settings) -> Result:
    """Upgrade exactly these packages, and nothing else.

    `--only-upgrade` is the load-bearing flag: without it, `apt-get install` will
    happily *install* a package that is not present, so a stale finding row would
    become an unrequested installation. `-o Dpkg::Options::=` twice because dpkg
    takes one option per occurrence.
    """
    if not packages:
        return Result("apt: nothing to do", 0)
    argv = [
        "sh", "-c",
        "export DEBIAN_FRONTEND=noninteractive LC_ALL=C; "
        "apt-get -qq update >/dev/null 2>&1; "
        "apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "
        "install --only-upgrade " + " ".join(shlex.quote(p) for p in packages),
    ]
    return _remote(host, container, argv, settings)


def apt_still_pending(host: Host, container: str | None, packages: list[str],
                      settings: Settings) -> set[str]:
    """Which of `packages` apt still considers upgradable — the real verdict."""
    result = _remote(host, container, ["sh", "-c", "LC_ALL=C apt list --upgradable 2>/dev/null"],
                     settings)
    if not result.ok and not result.stdout.strip():
        # Cannot tell. Returning the whole set would report a success as a failure
        # and re-run a completed upgrade; returning empty would report a failure as
        # success. Neither, so: treat as still pending and let the message say why.
        return set(packages)
    updates, _ = scanners.parse_apt_upgradable(result.stdout)
    pending = {u.package for u in updates}
    return {p for p in packages if p in pending}


# ── snap ─────────────────────────────────────────────────────────────────────
def apply_snap(host: Host, container: str | None, packages: list[str], settings: Settings) -> Result:
    if not packages:
        return Result("snap: nothing to do", 0)
    argv = ["sh", "-c", "LC_ALL=C snap refresh " + " ".join(shlex.quote(p) for p in packages)]
    return _remote(host, container, argv, settings)


# ── docker ───────────────────────────────────────────────────────────────────
def _compose_labels(host: Host, container: str, container_id: str, settings: Settings) -> dict:
    result = _docker(host, container, ["inspect", "--format", "{{json .Config.Labels}}", container_id],
                     settings)
    try:
        return json.loads(result.stdout or "{}") or {}
    except ValueError:
        return {}


def _running_project_services(host: Host, container: str, project: str, settings: Settings) -> list[str]:
    result = _docker(
        host, container,
        ["ps", "--filter", f"label=com.docker.compose.project={project}",
         "--format", '{{.Label "com.docker.compose.service"}}'],
        settings,
    )
    return [line.strip() for line in result.lines() if line.strip()]


def _docker_recreate(host: Host, container: str, ref: str, settings: Settings,
                     outcome: Outcome) -> None:
    """Pull `ref` and recreate the containers running it, or explain why not.

    THE CHECK THAT MATTERS: a compose project is recreated with the compose files
    recorded in the *container's own labels*, and this estate does not always start
    a stack the same way it is written down — profiles are used on some projects
    and not others, and `docker compose up` with the wrong profile set *stops the
    services that profile defines*. So before recreating, the number of services
    compose would manage is compared with the number currently running. If compose
    sees fewer, the invocation is incomplete and recreating would take down
    something else on the way past. That is refused, with the exact command the
    operator should run instead.

    A container that is not under compose at all cannot be recreated safely from
    here either: the correct replacement depends on the volumes, networks and
    entrypoint flags it was created with, and guessing produces a container that
    works until the first restart. It is pulled and reported as manual.
    """
    pulled = _docker(host, container, ["pull", "--quiet", ref], settings)
    if not pulled.ok:
        outcome.failed += 1
        outcome.note(f"docker pull {ref} failed: {pulled.message}")
        return

    listing = _docker(host, container, ["ps", "--format", "{{.ID}}|{{.Names}}",
                                        "--filter", f"ancestor={ref}"], settings)
    ids = [line.strip() for line in listing.lines() if "|" in line]
    if not ids:
        # Image is current but nothing runs it: the finding is genuinely resolved.
        outcome.applied += 1
        outcome.note(f"docker {ref}: pulled; no running container uses it")
        return

    for entry in ids:
        cid, _, cname = entry.partition("|")
        labels = _compose_labels(host, container, cid, settings)
        project = str(labels.get("com.docker.compose.project") or "")
        service = str(labels.get("com.docker.compose.service") or "")
        workdir = str(labels.get("com.docker.compose.project.working_dir") or "")
        files = [f for f in str(labels.get("com.docker.compose.project.config_files") or "").split(",") if f]
        if not (project and service and files):
            outcome.needs_manual.append(
                f"{cname}: image {ref} pulled, but the container is not compose-managed — "
                f"recreate it by hand (docker rm -f {cname} and re-run its original docker run)"
            )
            continue

        running = sorted(set(_running_project_services(host, container, project, settings)))
        plan = _docker(host, container,
                       ["compose", "--project-directory", workdir, *sum([["-f", f] for f in files], []),
                        "config", "--services"], settings)
        if plan.ok:
            planned = sorted(set(plan.lines()))
            missing = sorted(set(running) - set(planned))
            if missing:
                outcome.needs_manual.append(
                    f"{cname}: refusing to recreate — compose sees {len(planned)} service(s) for "
                    f"project {project} but {len(running)} are running; missing {', '.join(missing)}. "
                    f"Re-run the stack with its original profile flags."
                )
                continue

        before = _docker(host, container, ["inspect", "--format", "{{.Image}}", cname], settings)
        args = ["compose", "--project-directory", workdir, *sum([["-f", f] for f in files], []),
                "up", "-d", "--no-deps", service]
        result = _docker(host, container, args, settings)
        if not result.ok:
            outcome.failed += 1
            outcome.note(f"{cname}: compose up failed: {result.message}")
            continue
        after = _docker(host, container, ["inspect", "--format", "{{.Image}}", cname], settings)
        expected = _docker(host, container, ["image", "inspect", "--format", "{{.Id}}", ref], settings)
        if expected.ok and after.stdout.strip() == expected.stdout.strip():
            outcome.applied += 1
            outcome.note(f"{cname}: recreated on {ref}")
        elif after.stdout.strip() == before.stdout.strip():
            # Recreated but still on the old layer — compose did not need to
            # replace it, so the pull changed nothing it uses.
            outcome.applied += 1
            outcome.note(f"{cname}: already running the current image for {ref}")
        else:
            outcome.failed += 1
            outcome.note(f"{cname}: recreated but image id is neither old nor new — verify by hand")


# ── orchestration ────────────────────────────────────────────────────────────
def apply_findings(conn, settings: Settings, policy: Policy, *, finding_ids: list[int],
                   trigger: str = "manual") -> dict:
    """Apply the named findings (already approved, or approved by `auto` policy).

    Grouped per target and per manager so one target gets one apt transaction
    rather than one per package — forty separate `apt-get install` calls on
    twenty-seven containers is both slow and a much larger window in which a
    partially-updated host can be observed.
    """
    if not finding_ids:
        return {"run_id": None, "applied": 0, "failed": 0, "manual": [], "messages": []}

    marks = ",".join("?" for _ in finding_ids)
    rows = conn.execute(
        f"""
        SELECT f.id, f.manager, f.package, f.candidate, t.id AS target_id, t.host, t.kind,
               t.name, t.ref
          FROM findings f JOIN targets t ON t.id = f.target_id
         WHERE f.id IN ({marks}) AND f.status IN ('approved','pending')
         ORDER BY t.host, t.name, f.manager
        """,
        finding_ids,
    ).fetchall()

    run_id = db.start_run(conn, "apply", trigger)
    db.log(conn, f"apply started ({trigger}) for {len(rows)} finding(s)", run_id=run_id)

    by_host = {h.name: h for h in settings.hosts}
    grouped: dict[tuple[str, str], dict[str, list]] = {}
    for row in rows:
        key = (row["host"], row["name"])
        grouped.setdefault(key, {}).setdefault(row["manager"], []).append(row)

    totals = {"applied": 0, "failed": 0}
    messages: list[str] = []
    manual: list[str] = []

    for (host_name, target_name), managers in grouped.items():
        host = by_host.get(host_name)
        if host is None:
            for bucket in managers.values():
                for row in bucket:
                    db.set_status(conn, [row["id"]], "failed", f"host {host_name} is not configured")
                    totals["failed"] += 1
            continue
        container = None if target_name == host_name else target_name
        outcome = Outcome(ok=True)

        if "apt" in managers:
            rows_apt = managers["apt"]
            packages = [r["package"] for r in rows_apt]
            result = apply_apt(host, container, packages, settings)
            if result.timed_out or (not result.ok and not result.stdout.strip()):
                for row in rows_apt:
                    db.set_status(conn, [row["id"]], "failed", result.message)
                outcome.failed += len(rows_apt)
                outcome.note(f"apt on {target_name}: {result.message}")
            else:
                still = apt_still_pending(host, container, packages, settings)
                for row in rows_apt:
                    if row["package"] in still:
                        detail = result.message if not result.ok else "apt held it back after upgrade"
                        db.set_status(conn, [row["id"]], "failed", detail)
                        outcome.failed += 1
                    else:
                        db.set_status(conn, [row["id"]], "applied", result.message[:300])
                        outcome.applied += 1
                if still:
                    outcome.note(f"apt on {target_name}: {len(packages) - len(still)} applied, "
                                 f"{len(still)} held back")

        if "snap" in managers:
            rows_snap = managers["snap"]
            result = apply_snap(host, container, [r["package"] for r in rows_snap], settings)
            for row in rows_snap:
                if result.ok:
                    db.set_status(conn, [row["id"]], "applied", result.message[:300])
                    outcome.applied += 1
                else:
                    db.set_status(conn, [row["id"]], "failed", result.message)
                    outcome.failed += 1
            if not result.ok:
                outcome.note(f"snap on {target_name}: {result.message}")

        if "docker" in managers:
            # One image at a time, each with its own outcome. Docker findings are
            # per-image rather than per-target-group, because a single unrecreateable
            # container must not mark the other images on the same host as failed.
            if container is None:
                for row in managers["docker"]:
                    db.set_status(conn, [row["id"]], "failed", "docker findings belong to a container")
                    totals["failed"] += 1
                continue
            for row in managers["docker"]:
                image_outcome = Outcome(ok=True)
                _docker_recreate(host, container, row["package"], settings, image_outcome)
                if image_outcome.applied:
                    detail = (f"image now {row['candidate']}" if row["candidate"]
                              else "image already current")
                    db.set_status(conn, [row["id"]], "applied", detail)
                    totals["applied"] += 1
                else:
                    detail = image_outcome.messages[-1] if image_outcome.messages else "no container recreated"
                    db.set_status(conn, [row["id"]], "failed", detail)
                    totals["failed"] += 1
                messages.extend(image_outcome.messages)
                manual.extend(image_outcome.needs_manual)
            continue

        totals["applied"] += outcome.applied
        totals["failed"] += outcome.failed
        messages.extend(outcome.messages)
        manual.extend(outcome.needs_manual)

    for message in messages:
        db.log(conn, message, run_id=run_id)
    for message in manual:
        db.log(conn, message, level="warning", run_id=run_id)

    summary = f"{totals['applied']} applied, {totals['failed']} failed"
    if manual:
        summary += f", {len(manual)} need manual action"
    db.finish_run(conn, run_id, status="ok" if not totals["failed"] else "partial",
                  applied=totals["applied"], failed=totals["failed"], summary=summary)
    db.log(conn, f"apply finished: {summary}", run_id=run_id)
    conn.commit()
    return {"run_id": run_id, "applied": totals["applied"], "failed": totals["failed"],
            "manual": manual, "messages": messages, "summary": summary}
