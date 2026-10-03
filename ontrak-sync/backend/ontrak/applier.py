"""Ontrak Sync — the only code in this system that changes a machine.

Everything else reads. This writes, on potentially every host in the Network, and
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


def _remote(host: Host, container: str | None, argv: list[str], settings: Settings,
            timeout: int | None = None) -> Result:
    """Run one command, at the container when there is one.

    `timeout` overrides the generic ceiling for the commands that are transactions
    rather than probes. See `Settings.apt_timeout` for why apt needs its own.
    """
    if timeout is None:
        timeout = settings.command_timeout
    if container is None:
        return ssh(host, argv, timeout)
    return incus_exec(host, container, argv, timeout)


def _docker(host: Host, container: str, args: list[str], settings: Settings,
            timeout: int | None = None) -> Result:
    """A docker command, on the generic clock unless the caller names another.

    Only the pull needs one: a probe answers in seconds or not at all, while an
    image download is bounded by the uplink (see `Settings.pull_timeout`).
    """
    return docker_in_container(host, container, args,
                               settings.command_timeout if timeout is None else timeout)


# ── apt ──────────────────────────────────────────────────────────────────────
def apply_apt(host: Host, container: str | None, packages: list[str], settings: Settings) -> Result:
    """Upgrade exactly these packages, and nothing else.

    `--only-upgrade` is the load-bearing flag: without it, `apt-get install` will
    happily *install* a package that is not present, so a stale finding row would
    become an unrequested installation. `-o Dpkg::Options::=` twice because dpkg
    takes one option per occurrence.

    One transcript does two jobs — `apt-get update`, then the upgrade — so it runs on
    `Settings.apt_timeout` rather than the generic command ceiling. A cold cache
    behind a slow mirror is a minute of work before a single package moves.
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
    return _remote(host, container, argv, settings, timeout=settings.apt_timeout)


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


def _compose_argv(project: str, workdir: str, files: list[str], env_file: str) -> list[str]:
    """The `docker compose` invocation a container's own labels describe.

    EVERYTHING HERE IS READ BACK FROM THE LABELS compose wrote when the stack was
    started, because an invocation rebuilt from the compose files alone is a
    *different* project. Three labels carry what the files do not:

      * `project` — and it has to be passed explicitly, because a project with no
        `name:` in its files is named after its *directory*, and in this Network the
        two often differ: the monitoring stack is labelled `innotel-metrics` and
        lives in `…/monitoring`, the gateway is `innotel-gateway` and lives in
        `…/llm`. Composing those paths without pinning the name is not the same
        project — it would build `monitoring-grafana-1` while the container that was
        asked about is `metrics-grafana`, leave the latter untouched, and then pass
        its own verification (the image id before and after is unchanged) and call
        the finding applied. The name is pinned for the same reason the working
        directory is: it is part of what the stack *is*.
      * `project.working_dir` and `project.config_files` — the directory and the
        exact `-f` set, which is how a stack started with an override file stays
        started with it.
      * `project.environment_file` — set when the stack was started with
        `--env-file`, which this Network does wherever the secrets live beside the
        stack rather than in the working directory (`…/monitoring/.env.host`,
        `…/llm/.env.host`). Those stacks interpolate `${SECRET:?}`, and without the
        file compose refuses them: the images in them failed every apply with
        "required variable GRAFANA_PASSWORD is missing a value", which reads like a
        broken stack and was a missing argument.

    Profiles are the fourth thing, and they are NOT in the labels, so they are
    rediscovered rather than replayed — see `_plan_services`.
    """
    argv = ["compose", "--project-name", project, "--project-directory", workdir,
            *sum((["-f", f] for f in files), [])]
    if env_file:
        argv += ["--env-file", env_file]
    return argv


def _env_file_still_there(host: Host, container: str, path: str, settings: Settings) -> bool:
    """Does the env file the labels name still exist?

    A labelled env file is not necessarily a file any more. The monarch stack has its
    secrets resolved into `/run/.env.monarch.resolved`, and `/run` is a tmpfs: after a
    reboot the label points at nothing and replaying it fails the entire invocation —
    "couldn't find env file" — which the plan then reports as a stack with no services,
    as if the compose files were broken. It is replayed when it is there and dropped
    when it is not, and the plan that follows decides whether the stack can be read at
    all. Dropping it is not silent: the caller notes it, and any interpolation that
    really did depend on it fails loudly at the next step, with compose's own words.
    """
    if not path:
        return False
    result = _remote(host, container, ["sh", "-c", f"test -f {shlex.quote(path)}"],
                     settings, timeout=settings.ssh_timeout)
    return result.ok


def _plan_services(host: Host, container: str, argv: list[str], running: list[str],
                   settings: Settings) -> tuple[list[str], list[str], list[str], str]:
    """(the invocation to reuse, the services it would manage, the ones it would not,
    compose's own complaint if it could not read the stack at all).

    WHY THIS WIDENS AT ALL. Some stacks in this Network are started with profiles,
    and `docker compose config --services` leaves profile-gated services out of its
    answer. The plan then looks smaller than reality and the recreate is refused —
    correctly, because `up` with the wrong profile set *stops* the services that
    profile defines — but refusing is not a fix, and it left fourteen images
    permanently unupdatable with a warning nobody could act on. Compose does not
    record which profiles a stack was started with, so they are read from the files
    (`config --profiles`) and all of them are enabled: a service's profile is a
    property of how its stack runs, not of the image being replaced.

    WIDENING IS CONDITIONAL, and that is the safety rail. A stack that needs no
    profiles is never handed any — `--profile` changes which services compose would
    start and stop, so introducing one where none was in use would be the very
    accident the check exists to prevent. It is tried only after the plain plan has
    already been shown to miss a running service, and adopted only if it then covers
    all of them.
    """
    def plan_for(cmd: list[str]) -> tuple[list[str], str]:
        result = _docker(host, container, [*cmd, "config", "--services"], settings)
        if result.ok:
            return sorted(set(result.lines())), ""
        # Compose refusing the files and compose managing none of them look identical
        # from the service list, and they are not the same thing to an operator.
        return [], f"{result.message} (exit {result.returncode})"

    planned, why = plan_for(argv)
    if why:
        return argv, planned, [], why
    missing = sorted(set(running) - set(planned))
    if not missing:
        return argv, planned, [], ""

    declared = _docker(host, container, [*argv, "config", "--profiles"], settings)
    names = sorted({line.strip() for line in declared.lines() if line.strip()}) \
        if declared.ok else []
    if not names:
        return argv, planned, missing, ""

    widened = list(argv)
    for name in names:
        widened += ["--profile", name]
    wider, why = plan_for(widened)
    if why:
        return argv, planned, missing, ""
    if set(running) - set(wider):
        return widened, wider, sorted(set(running) - set(wider)), ""
    return widened, wider, [], ""


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
    recorded in the *container's own labels*, and this Network does not always start
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

    The invocation itself is rebuilt from the container's labels — its project name,
    working directory, `-f` set and `--env-file`, plus, when the plain plan cannot see
    every running service and only then, every profile the compose files declare.
    See `_compose_argv` and `_plan_services` for why each is load-bearing: the name
    one in particular, because composing a stack's path without it addresses a
    different project and then looks successful from here.
    """
    # A pull is a download, not a probe: it gets `pull_timeout` for the same reason
    # apt does, because sizing it like a command is what failed the PBX image.
    pulled = _docker(host, container, ["pull", "--quiet", ref], settings,
                     timeout=settings.pull_timeout)
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
        env_file = str(labels.get("com.docker.compose.project.environment_file") or "")
        if env_file and not _env_file_still_there(host, container, env_file, settings):
            outcome.note(f"{cname}: {env_file} is gone; recreating without it")
            env_file = ""
        if not (project and service and files):
            outcome.needs_manual.append(
                f"{cname}: image {ref} pulled, but the container is not compose-managed — "
                f"recreate it by hand (docker rm -f {cname} and re-run its original docker run)"
            )
            continue

        running = sorted(set(_running_project_services(host, container, project, settings)))
        argv, planned, missing, unreadable = _plan_services(
            host, container, _compose_argv(project, workdir, files, env_file), running, settings)
        if unreadable:
            outcome.needs_manual.append(
                f"{cname}: refusing to recreate — compose could not read project {project}: "
                f"{unreadable}"
            )
            continue
        if missing:
            outcome.needs_manual.append(
                f"{cname}: refusing to recreate — compose sees {len(planned)} service(s) for "
                f"project {project} but {len(running)} are running; missing {', '.join(missing)}. "
                f"Re-run the stack with its original profile flags."
            )
            continue

        before = _docker(host, container, ["inspect", "--format", "{{.Image}}", cname], settings)
        args = [*argv, "up", "-d", "--no-deps", service]
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
            # A command that never ran says nothing about any package, so it fails the
            # group at once. A TIMEOUT is deliberately not in that branch: `apt-get
            # update` on a slow mirror and an upgrade that is still unpacking look
            # identical to `subprocess`, and the transcript ran far enough that only
            # apt can report what happened — which is what `apt_still_pending` asks it
            # below, on both paths. Blanket-failing on a timeout is how one slow host
            # became 306 findings recorded as failed, on hosts whose upgrade had
            # already landed.
            if not result.ok and not result.stdout.strip() and not result.timed_out:
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
                        detail = ("apt no longer lists it, though the transcript "
                                  f"timed out after {settings.apt_timeout}s"
                                  if result.timed_out else result.message[:300])
                        db.set_status(conn, [row["id"]], "applied", detail)
                        outcome.applied += 1
                if still or result.timed_out:
                    tail = (f" (the transcript timed out after {settings.apt_timeout}s; "
                            "the verdict was re-read from apt)" if result.timed_out else "")
                    outcome.note(f"apt on {target_name}: {len(packages) - len(still)} applied, "
                                 f"{len(still)} held back{tail}")

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
                    # The reason a recreate produced nothing is usually the *refusal*,
                    # and a refusal is recorded as needing a person rather than as a
                    # note. Reading only `messages` here is how eleven findings came to
                    # read "no container recreated" on the dashboard while the run log
                    # held a paragraph naming the missing services.
                    detail = (image_outcome.needs_manual[-1] if image_outcome.needs_manual
                              else image_outcome.messages[-1] if image_outcome.messages
                              else "no container recreated")
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


def approve_and_apply(conn, settings: Settings, policy: Policy, *, finding_ids: list[int],
                      actor: str, apply: bool = True,
                      trigger: str = "approve") -> tuple[int, dict | None]:
    """Record the approval and, when asked, install it — the one-click path.

    Approving changes no machine; this is the half that does. A person clicking one
    button means both, so the decision is written and the same `apply_findings` run
    (same code, same verification, same run log) follows it in a single call. The
    alternative — approve here, install from a second button — is how an approval
    sits recorded and unapplied, because the list an operator approved from is
    filtered to pending and the approved rows leave it on the next reload.

    Returns (how many findings were approved, the apply outcome) — the outcome is
    None when `apply` is false or there was nothing to approve. Kept here rather
    than in the HTTP layer so it is exercised by the same tests as the apply.
    """
    changed = db.set_status(conn, finding_ids, "approved")
    db.log(conn, f"{changed} finding(s) approved", actor=actor)
    conn.commit()
    if not (apply and changed):
        return changed, None
    outcome = apply_findings(conn, settings, policy, finding_ids=finding_ids,
                             trigger=trigger)
    return changed, outcome
