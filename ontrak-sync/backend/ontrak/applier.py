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

WHY IT LOGS IN TO A REGISTRY
----------------------------
Docker Hub answers an anonymous pull out of roughly a hundred requests per six
hours *per address*, and the Network's own scans spend from that same budget. A
scan that is careful about it (see `digest_ttl_seconds`) still leaves the pulls
sharing the anonymous allowance, which is the other half of why an update fails
with `429 Too Many Requests` even when the digest checks were cheap. So a pull for
a registry this deployment holds a credential for (`Settings.registry_credentials`)
is preceded by a `docker login`, and the pull — and every scan after it, because the
daemon keeps the credential — spends the authenticated budget instead. See
`_docker_login` for why the password goes over stdin and stays in place.
"""

from __future__ import annotations

import json
import logging
import shlex
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone

from . import db, rollout, scanners
from .config import Host, Settings
from .policy import Policy
from .registry import docker_login as _docker_login, registry_of as _registry_of
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
    image download is bounded by the uplink (see `Settings.pull_timeout`). The
    login that goes over stdin lives in `registry.docker_login`, next to the rule
    that decides which registry it applies to.
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


def _compose_invocation(host: Host, container: str, cid: str, cname: str, ref: str,
                        settings: Settings) -> tuple[list[str], str, str, str, str]:
    """(the invocation, its service, its project, a refusal, a note).

    Split out of `_docker_recreate` so the unattended roll in `_roll_one` resolves a
    container exactly the way a clicked apply does. Two copies of this would be two
    answers to "which project is this container part of?", and the whole reason
    `_compose_argv` exists is that the wrong answer is a *different* project that
    composes cleanly, leaves the container untouched and then looks successful.

    The refusal is a sentence rather than a code because it is shown to an operator, and
    the caller prefixes it with the container's name. A `not compose-managed` container
    is not an error: the correct replacement depends on the volumes, networks and
    entrypoint flags it was created with, and guessing produces a container that works
    until the first restart.
    """
    labels = _compose_labels(host, container, cid, settings)
    project = str(labels.get("com.docker.compose.project") or "")
    service = str(labels.get("com.docker.compose.service") or "")
    workdir = str(labels.get("com.docker.compose.project.working_dir") or "")
    files = [f for f in str(labels.get("com.docker.compose.project.config_files") or "").split(",") if f]
    env_file = str(labels.get("com.docker.compose.project.environment_file") or "")
    note = ""
    if env_file and not _env_file_still_there(host, container, env_file, settings):
        note = f"{cname}: {env_file} is gone; recreating without it"
        env_file = ""
    if not (project and service and files):
        return [], "", "", (
            f"image {ref} pulled, but the container is not compose-managed — "
            f"recreate it by hand (docker rm -f {cname} and re-run its original docker run)"
        ), note
    return _compose_argv(project, workdir, files, env_file), service, project, "", note


def _docker_recreate(conn, host: Host, container: str, ref: str, settings: Settings,
                     outcome: Outcome, logged_in: set[tuple[str, str]]) -> None:
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
    # An authenticated pull draws from the account's allowance rather than the
    # anonymous one the scans already spend, so a credential configured for this
    # registry is used before the pull. Once per container and registry per run: a
    # login is itself a registry request, and repeating it would spend the budget the
    # pull needs.
    registry = _registry_of(ref)
    credential = settings.credential_for(registry)
    if credential is not None and (container, registry) not in logged_in:
        logged_in.add((container, registry))
        login = _docker_login(host, container, registry, credential, settings)
        if login.ok:
            # Leave a note for the scans that follow: the daemon keeps the credential,
            # so a scan within the TTL can skip the login rather than spend a request
            # re-establishing it (`db.registry_login_is_fresh`).
            db.record_registry_login(conn, host=host.name, container=container,
                                     registry=registry)
        else:
            # Not fatal on its own — the pull behind it may still succeed on the
            # anonymous budget — but reported, so a rotated token shows up as itself
            # instead of only as the 429 it causes.
            outcome.note(f"docker login to {registry} failed: {login.message}")

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
        argv, service, project, refusal, note = _compose_invocation(
            host, container, cid, cname, ref, settings)
        if note:
            outcome.note(note)
        if refusal:
            outcome.needs_manual.append(f"{cname}: {refusal}")
            continue

        running = sorted(set(_running_project_services(host, container, project, settings)))
        argv, planned, missing, unreadable = _plan_services(
            host, container, argv, running, settings)
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
    # (container, registry) pairs already logged in during THIS run, so a stack with
    # several images from one registry logs in once rather than per image.
    logged_in: set[tuple[str, str]] = set()

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
                _docker_recreate(conn, host, container, row["package"], settings,
                                 image_outcome, logged_in)
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


# ── the unattended roll (rollout.py) ─────────────────────────────────────────
# The rail-and-decision half of this lives in `rollout.py` and is pure. What is here is
# the part that touches machines, and it obeys the same rule as everything else in this
# file: every command is fixed, and the one variable thing — the image ref — comes from a
# remit row somebody wrote rather than from a request.
#
# TWO STAGES, AND WHY THE SECOND ONE EXISTS. The scan's finding is the *precondition*
# (that is what keeps this from asking a registry about every image in the Network on
# every run), and the pull is the *verdict*. A tag that moved between the scan and the
# roll would otherwise be rolled on a stale answer, and — worse — an image the scan could
# not judge at all is recorded the same way as one it judged behind, so a finding is not
# by itself proof that anything needs to change. So: pull, compare the id the tag now
# resolves to against the id the running container has, and restart only if they differ.
# A pull is a read. That is what makes "an unknown is not a reason to restart a
# container" true here rather than a claim, and it costs one registry request per owned
# container per run.

ROLL_STATE_FORMAT = (
    "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}"
    "|{{if .Config.Healthcheck}}yes{{end}}"
)


@dataclass
class _RollTarget:
    """One remit's container, as it was found on the host.

    The resolved `argv`/`service` are carried rather than recomputed, so the plan the
    decision was made from is the plan that is executed. Recomputing between the two
    would make the refusal check advisory.
    """

    remit: rollout.Remit
    state: rollout.ContainerState
    cid: str = ""
    cname: str = ""
    argv: list[str] = field(default_factory=list)
    service: str = ""
    project: str = ""


def _ancestor_containers(host: Host, container: str | None, ref: str,
                         settings: Settings) -> list[tuple[str, str]]:
    """The running containers whose image is `ref`, as (id, name).

    `ancestor` rather than a name match because the name is what a person chose and the
    image is what the remit is *about*: a stack that renamed a service still runs the
    same image, and a remit that stopped matching after a rename would silently stop
    being honoured.
    """
    listing = _docker(host, container,
                      ["ps", "--format", "{{.ID}}|{{.Names}}",
                       "--filter", f"ancestor={ref}"], settings)
    out: list[tuple[str, str]] = []
    for line in listing.lines():
        cid, _, cname = line.partition("|")
        if cid.strip():
            out.append((cid.strip(), cname.strip()))
    return out


def _container_image_id(host: Host, container: str | None, cname: str,
                        settings: Settings) -> str:
    """The image id one container is running, or "" when it cannot be read."""
    result = _docker(host, container, ["inspect", "--format", "{{.Image}}", cname], settings)
    return result.stdout.strip() if result.ok else ""


def _container_health(host: Host, container: str | None, cname: str,
                      settings: Settings) -> tuple[str, str, bool]:
    """(status, health, has-healthcheck) for one container.

    One `docker inspect` rather than a poll loop that shells out per field: this is asked
    every few seconds while a container settles, and three commands per ask would be three
    ssh round trips for one answer.
    """
    result = _docker(host, container, ["inspect", "--format", ROLL_STATE_FORMAT, cname], settings)
    status, _, rest = result.stdout.strip().partition("|")
    health, _, has_healthcheck = rest.partition("|")
    return status.strip(), health.strip(), has_healthcheck.strip() == "yes"


def _wait_for_health(host: Host, container: str | None, cname: str, settings: Settings,
                     config) -> tuple[str, str]:
    """Hold the roll open until the new container is up, or the grace period runs out.

    Returns (the verdict from `rollout.health_verdict`, the last thing the daemon said), so
    the reason a roll was undone is the daemon's own words rather than a guess. `time.sleep`
    between polls, in the caller's thread: this is a bounded wait (ninety seconds by default)
    inside a job that already blocks for minutes, and a thread per container would be more
    machinery than the wait is worth.
    """
    started = time.monotonic()
    last = ""
    while True:
        status, health, has_healthcheck = _container_health(host, container, cname, settings)
        last = f"status={status or 'unknown'} health={health or '-'}"
        elapsed = time.monotonic() - started
        verdict = rollout.health_verdict(
            status=status, health=health, has_healthcheck=has_healthcheck,
            elapsed_seconds=elapsed, grace_seconds=config.health_grace_seconds)
        if verdict != rollout.STARTING:
            return verdict, last
        time.sleep(max(1, int(settings.rollout_health_poll_seconds)))


def _put_image_back(host: Host, container: str | None, ref: str, from_image_id: str,
                    target: _RollTarget, settings: Settings) -> tuple[bool, str]:
    """Move the tag back to the image that was running, and recreate on it.

    `docker tag <old id> <ref>` first, because the compose stack names the *ref*: putting
    the old image back is only possible if the tag points at it again, and the old layers
    are still local (`docker pull` does not remove the image it replaced). If they are not
    — somebody pruned the host, or the roll has been asleep for a long time — this says so
    instead of recreating something else and calling it a rollback.

    Returns (whether the old image is running again, a sentence either way).
    """
    present = _docker(host, container, ["image", "inspect", "--format", "{{.Id}}",
                                       from_image_id], settings)
    if not present.ok:
        return False, (f"cannot roll back: the image that was running ({from_image_id[:19]}) "
                       f"is no longer on the host")
    tagged = _docker(host, container, ["tag", from_image_id, ref], settings)
    if not tagged.ok:
        return False, f"cannot roll back: docker tag failed: {tagged.message}"
    if not target.argv:
        return False, "cannot roll back: the compose invocation that created it is unknown"
    recreated = _docker(host, container, [*target.argv, "up", "-d", "--no-deps", target.service],
                        settings)
    if not recreated.ok:
        return False, f"the old image is tagged {ref} again but compose up failed: {recreated.message}"
    now = _container_image_id(host, container, target.cname, settings)
    if now == from_image_id:
        return True, f"rolled back to {from_image_id[:19]}"
    return False, f"recreated on the old tag but the container is running {now[:19] or 'nothing'}"


def _roll_one(conn, host: Host, target: _RollTarget, settings: Settings, config, *,
              trigger: str, actor: str | None, run_id: int | None) -> tuple[str, str]:
    """Pull one owned image and restart its container only if the tag actually moved.

    Returns (the state the roll row should carry, the sentence for it). Every early return
    is a state, never an exception: a rollout run that stops at the first registry refusal
    would leave the rest of the remit unlooked-at for the night, which is the opposite of
    what a Network-wide job is for.
    """
    ref = target.state.ref
    cname = target.cname
    container = target.remit.container or None
    from_image_id = _container_image_id(host, container, cname, settings)
    if not from_image_id:
        return rollout.ROLL_UNTOUCHED, f"{cname}: could not read the running image id"
    roll_id = db.start_container_roll(
        conn, host=host.name, container=target.remit.container or "", name=cname, ref=ref,
        project=target.project, service=target.service, from_image_id=from_image_id,
        trigger=trigger, actor=actor, run_id=run_id)
    conn.commit()

    registry = _registry_of(ref)
    credential = settings.credential_for(registry)
    if credential is not None:
        login = _docker_login(host, container, registry, credential, settings)
        if login.ok:
            db.record_registry_login(conn, host=host.name, container=target.remit.container or "",
                                     registry=registry)
        else:
            # Not fatal on its own — an anonymous pull may still be allowed — but the
            # failure is named, because a rotated token otherwise shows up only as the
            # 429 it causes (exactly as it does on the clicked path).
            db.log(conn, f"{cname}: docker login to {registry} failed: {login.message}",
                   level="warning", run_id=run_id)

    pulled = _docker(host, container, ["pull", "--quiet", ref], settings,
                     timeout=settings.pull_timeout)
    if not pulled.ok:
        # The verdict that matters: the registry did not answer, so nothing is known and
        # nothing is restarted. `untouched` and not `failed`, because a throttled registry
        # clears on its own and must not hold the container back for a day.
        reason = f"docker pull {ref} failed: {pulled.message}"
        db.finish_container_roll(conn, roll_id, state=rollout.ROLL_UNTOUCHED, reason=reason)
        return rollout.ROLL_UNTOUCHED, reason

    to_image_id = _docker(host, container, ["image", "inspect", "--format", "{{.Id}}", ref],
                          settings).stdout.strip()
    if not to_image_id or to_image_id == from_image_id:
        # The tag resolves to what is already running, so the finding was stale or was
        # protected rather than judged. Nothing is stopped, and the finding is left where
        # the next scan can expire it.
        reason = f"{cname}: already running the current image for {ref}"
        db.finish_container_roll(conn, roll_id, state=rollout.ROLL_UNTOUCHED, reason=reason,
                                 to_image_id=to_image_id)
        return rollout.ROLL_UNTOUCHED, reason

    recreated = _docker(host, container, [*target.argv, "up", "-d", "--no-deps",
                                         target.service], settings)
    if not recreated.ok:
        ok, why = _put_image_back(host, container, ref, from_image_id, target, settings)
        state = rollout.ROLLED_BACK if ok else rollout.ROLL_FAILED
        reason = f"{cname}: compose up failed: {recreated.message}; {why}"
        db.finish_container_roll(conn, roll_id, state=state, to_image_id=to_image_id,
                                 reason=reason)
        return state, reason

    verdict, observed = _wait_for_health(host, container, cname, settings, config)
    if verdict == rollout.UP:
        # VERIFIED, NOT ASSUMED, and the difference is the case compose decides the image
        # it was asked for is the one already there: the container then keeps running the
        # old layer while `compose up` exits 0 and the health gate passes, because nothing
        # was restarted and nothing is wrong — it simply did not do what the roll was for.
        # Recording that as `rolled` would put a green row on a container that is still
        # behind, which is the exact lie `_docker_recreate` already refuses to tell.
        running_id = _container_image_id(host, container, cname, settings)
        if running_id != to_image_id:
            reason = (f"{cname}: compose up did not replace the container — it is running "
                      f"{running_id[:19] or 'nothing'} after being asked for {to_image_id[:19]}")
            db.finish_container_roll(conn, roll_id, state=rollout.ROLL_UNTOUCHED,
                                     to_image_id=to_image_id, reason=reason)
            return rollout.ROLL_UNTOUCHED, reason
        reason = f"{cname}: rolled to {to_image_id[:19]} ({observed})"
        db.finish_container_roll(conn, roll_id, state=rollout.ROLLED, to_image_id=to_image_id,
                                 reason=reason)
        _close_the_finding(conn, host=host.name, target_name=target.remit.container or host.name,
                           ref=ref, reason=f"rolled by Ontrak Sync: {reason}")
        return rollout.ROLLED, reason

    # It did not come up. The previous image goes back, and the *outcome* recorded is the
    # rollback rather than the roll — "we replaced it and then undid it" is the fact an
    # incident review needs, and a row saying `rolled` with a note in the log is not.
    ok, why = _put_image_back(host, container, ref, from_image_id, target, settings)
    state = rollout.ROLLED_BACK if ok else rollout.ROLL_FAILED
    reason = (f"{cname}: the new image did not come up ({observed}, "
              f"{config.health_grace_seconds}s); {why}")
    db.finish_container_roll(conn, roll_id, state=state, to_image_id=to_image_id, reason=reason)
    return state, reason


def _kept_out_note(count: int) -> str:
    """The half of a pass's sentence that is about what it deliberately did not touch.

    A deployment where every container has been released runs a pass that does nothing at
    all, and "no containers in the remit" would read as a Network with nothing to do —
    when the truth is that somebody took each one out and the timer is respecting that.
    The number is in the run log for the same reason every other count is: a pass that
    does nothing has to be able to say *which* nothing.
    """
    if not count:
        return ""
    return f"; {count} kept out of the remit by hand"


def adopt_discovered(conn, settings: Settings, *, actor: str = "sync") -> dict:
    """Take ownership of every container the scans have found on a host this reaches.

    Only runs on a deployment that asked for it (`ONTRAK_ROLLOUT_ADOPT`); on any other it
    is a no-op, because "nothing is owned until a person claims it" is the shipped
    posture and it has to stay the one you get without asking. Where it is on, this is
    what makes the remit a property of the Network rather than a list somebody keeps
    complete by hand: a container that appears on a host this deployment is configured
    for enters the remit without anybody remembering to add it.

    Four things bound it, and each is the difference between adoption and a footgun:

      * **The configured host list.** A finding on a machine this deployment no longer
        reaches is not adopted: ownership of a container nobody can roll is a row that
        only ever reads as coverage.
      * **A `skipped` finding is a person saying "leave it alone"** on the Findings page,
        so it is a decision, not a discovery, and it is not adopted. So is a row on the
        opt-out list (`db.rollout_optouts`), which is what `Release` writes when this is
        on — otherwise a release would last until the next pass, and a control that
        undoes itself is worse than no control.
      * **`watched` adopts without arming.** `ONTRAK_ROLLOUT_ADOPT=watched` fills the
        remit and rolls none of it; only `unattended` makes the adopted rows live, and
        even then the kill switch (`ONTRAK_ROLLOUT`) and the rails in `rollout.py` stand
        between them and a restart.
      * **What is already owned is left alone.** A claim carries terms a person chose —
        a window, a cooldown, a note — and re-writing them from a discovery would throw
        away the only part of the remit somebody actually decided.

    Returns the counts and the keys, because "the pass adopted four containers" is a
    sentence the run log and the page both need and neither can reconstruct afterwards.
    """
    config = settings.rollout_config()
    if not config.adopting:
        return {"adopting": False, "adopted": 0, "kept_out": 0, "owned": 0, "keys": []}

    configured = {host.name for host in settings.hosts}
    owned = {(row["host"], row["container"], row["ref"])
             for row in db.list_rollout_targets(conn)}
    kept_out = {(row["host"], row["container"], row["ref"])
                for row in db.list_rollout_optouts(conn)}

    # Every docker finding, newest first, folded to the triple a remit is keyed on — the
    # same fold the Rollouts page does for what it draws as `not owned`. Status is not
    # filtered to "behind": this is a record of what the scans *saw*, and a container
    # whose finding was closed by a roll is still a container this deployment owns.
    rows = conn.execute(
        """
        SELECT t.host AS host, t.kind AS kind, t.name AS name, f.package AS ref
          FROM findings f JOIN targets t ON t.id = f.target_id
         WHERE f.manager = 'docker' AND f.status != 'skipped'
         ORDER BY f.id ASC, t.host, t.name, f.package
        """
    ).fetchall()

    adopted: list[str] = []
    held: set[tuple[str, str, str]] = set()
    seen: set[tuple[str, str, str]] = set()
    for row in rows:
        if row["host"] not in configured:
            continue
        container = "" if row["kind"] == "host" else row["name"]
        key = (row["host"], container, row["ref"])
        if key in seen:
            continue
        seen.add(key)
        if key in owned:
            continue
        if key in kept_out:
            held.add(key)
            continue
        db.claim_rollout_target(conn, rollout.Remit(
            host=key[0], container=key[1], ref=key[2], auto=config.adopt_auto,
            note=f"adopted automatically from the scan ({config.adopt})",
            created_by=actor, created_at=db.utcnow()))
        adopted.append(f"{key[0]}/{key[1] or 'host-daemon'}:{key[2]}")

    if adopted:
        db.log(conn, f"rollout remit: adopted {len(adopted)} container(s) from the scans"
                     + (" — watched only" if not config.adopt_auto else " — unattended")
                     + f" ({', '.join(adopted[:10])}"
                     + (", …" if len(adopted) > 10 else "") + ")", actor=actor)
    return {"adopting": True, "adopted": len(adopted), "kept_out": len(held),
            "owned": len(owned), "keys": adopted}


def _roll_targets(conn, settings: Settings) -> list[tuple[Host, _RollTarget]]:
    """The remit, resolved against the hosts and containers as they are right now.

    Discovery is read-only: an ancestor listing, the compose labels and the plan check. If
    any of it fails the container is reported unwatched rather than rolled, because every
    one of those failures means the recreate would be made from something other than the
    container's own configuration.
    """
    remits = [rollout.Remit.from_dict(row) for row in db.list_rollout_targets(conn)]
    by_name = {host.name: host for host in settings.hosts}
    # The scan's finding is the precondition for even looking: a ref the last scan judged
    # current has no row, and a rollout over a hundred owned containers should not spend a
    # hundred registry requests re-asking a question the scan answered an hour ago. A
    # `skipped` row is honoured too — an operator asking for something to be left alone is
    # not the same as a scan that could not judge it.
    live: set[tuple[str, str]] = {
        (row["host"], row["target"], row["package"])
        for row in conn.execute(
            """
            SELECT t.host AS host, t.name AS target, f.package AS package
              FROM findings f JOIN targets t ON t.id = f.target_id
             WHERE f.manager = 'docker' AND f.status IN ('pending','approved','failed')
            """
        ).fetchall()
    }

    def flagged(remit) -> bool:
        """Did the last scan flag this ref?

        Keyed on the *target's own name* — the incus container, or the host when Docker
        runs on it directly — and not on the target's host, because a host with two
        Docker-running containers is two targets and a finding on one says nothing about
        the other. That is the mapping `scan.py` writes, reproduced here rather than
        guessed at.
        """
        return (remit.host, remit.container or remit.host, remit.ref) in live
    targets: list[tuple[Host, _RollTarget]] = []
    for remit in remits:
        host = by_name.get(remit.host)
        if host is None:
            targets.append((Host(remit.host, "", "unknown"),
                            _RollTarget(remit, rollout.ContainerState(
                                host=remit.host, name=remit.container or remit.host,
                                ref=remit.ref, container=remit.container))))
            continue
        container = remit.container or None
        found = _ancestor_containers(host, container, remit.ref, settings)
        base = dict(host=remit.host, ref=remit.ref, container=remit.container or "")
        if not found:
            targets.append((host, _RollTarget(remit, rollout.ContainerState(
                name=remit.container or remit.host, running=False, behind=flagged(remit),
                **base))))
            continue
        cid, cname = found[0]
        argv, service, project, refusal, _note = _compose_invocation(
            host, container, cid, cname, remit.ref, settings)
        problem = refusal
        if not problem:
            running = sorted(set(_running_project_services(host, container, project, settings)))
            argv, _planned, missing, unreadable = _plan_services(
                host, container, argv, running, settings)
            if unreadable:
                problem = f"compose could not read project {project}: {unreadable}"
            elif missing:
                problem = (f"compose sees fewer services than are running in {project} "
                           f"(missing {', '.join(missing)}) — re-run the stack with its "
                           f"original profile flags")
        targets.append((host, _RollTarget(
            remit=remit,
            state=rollout.ContainerState(name=cname, project=project, service=service,
                                         behind=flagged(remit), plan_problem=problem or "",
                                         **base),
            cid=cid, cname=cname, argv=argv, service=service, project=project)))
    return targets


def apply_rollouts(conn, settings: Settings, policy: Policy, *, trigger: str = "schedule",
                   actor: str | None = None, now=None) -> dict:
    """One unattended pass over the remit: decide, then roll what the rails allow.

    Called at the end of a scheduled scan (so the timer an operator already set is the
    cadence) and from the API. Nothing here re-implements a rail: the ownership, the
    window, the cooldown, the caps and the health gate are all `rollout.py`'s, and this
    function's job is to assemble their inputs and to keep the run's own tally of how many
    containers it has already restarted on this pass.
    """
    moment = now or datetime.now(timezone.utc)
    config = settings.rollout_config()
    # Adoption happens at the top of a pass, and only here: a pass is the thing the timer
    # already runs after every scan, and the thing the page's button runs by hand, so
    # there is one code path that can change what this deployment owns rather than two
    # that disagree. `adopt_discovered` is a no-op unless the deployment asked for it.
    adoption = adopt_discovered(conn, settings, actor=actor or "sync")
    if adoption["adopted"]:
        conn.commit()
    targets = _roll_targets(conn, settings)
    if not targets:
        summary = (f"adopted {adoption['adopted']} container(s); nothing owned to roll"
                   if adoption["adopted"] else "no containers in the remit")
        summary += _kept_out_note(adoption["kept_out"])
        return {"run_id": None, "rolled": 0, "rolled_back": 0, "failed": 0,
                "skipped": 0, "summary": summary, "messages": [], "decisions": [],
                "adopted": adoption["adopted"], "kept_out": adoption["kept_out"]}

    history = db.rollout_history(conn, [t.remit.key() for _host, t in targets])
    for _host, target in targets:
        past = history.get(target.remit.key()) or {"last_rolled_at": None, "blocker": ""}
        target.state = replace(
            target.state,
            last_roll_at=_parse_stamp(past["last_rolled_at"]),
            blocked_reason=past["blocker"])

    run_id = db.start_run(conn, "rollout", trigger)
    db.log(conn, f"rollout started ({trigger}) over {len(targets)} owned container(s)",
           run_id=run_id)

    configured = {host.name for host in settings.hosts}
    report = rollout.RollReport()
    rolls_this_host: dict[str, int] = {}
    for host, target in targets:
        decision = rollout.decide_roll(
            target.state, target.remit, config, policy, now=moment,
            rolls_this_run=report.rolled + report.rolled_back + report.failed,
            rolls_this_host=rolls_this_host.get(target.state.host, 0),
            configured_hosts=configured)
        report.decisions.append(decision)
        if not decision.roll:
            report.skipped += 1
            continue
        host_used = rolls_this_host.get(target.state.host, 0) + 1
        rolls_this_host[target.state.host] = host_used
        state, reason = _roll_one(conn, host, target, settings, config,
                                 trigger=trigger, actor=actor, run_id=run_id)
        report.note(reason)
        if state == rollout.ROLLED:
            report.rolled += 1
        elif state == rollout.ROLLED_BACK:
            report.rolled_back += 1
        elif state == rollout.ROLL_FAILED:
            report.failed += 1
        conn.commit()

    for message in report.messages:
        db.log(conn, message, run_id=run_id,
               level="warning" if report.rolled_back or report.failed else "info")
    summary = rollout.summarize(report.decisions)
    if adoption["adopted"]:
        summary = (f"adopted {adoption['adopted']} container(s) from the scans; " + summary)
    summary += _kept_out_note(adoption["kept_out"])
    if report.rolled_back or report.failed:
        summary += f"; {report.rolled_back} rolled back, {report.failed} failed"
    db.finish_run(conn, run_id, status="ok" if not (report.rolled_back or report.failed)
                  else "partial", applied=report.rolled, failed=report.rolled_back + report.failed,
                  summary=summary)
    db.log(conn, f"rollout finished: {summary}", run_id=run_id)
    conn.commit()
    return {"run_id": run_id, "rolled": report.rolled, "rolled_back": report.rolled_back,
            "failed": report.failed, "skipped": report.skipped, "summary": summary,
            "messages": report.messages, "adopted": adoption["adopted"],
            "kept_out": adoption["kept_out"],
            "decisions": [{"host": d.state.host, "name": d.state.name, "ref": d.state.ref,
                           "code": d.code, "detail": d.detail} for d in report.decisions]}


def _close_the_finding(conn, *, host: str, target_name: str, ref: str, reason: str) -> None:
    """Mark the scan's finding for this image applied, now that the image is running.

    A roll the operator can watch happen on the Rollouts page and still see pending on
    the Findings page is a dashboard disagreeing with itself, and the disagreement lasts
    until the next scan — up to a week on the default schedule. Closing the row here is
    what keeps the two pages saying one thing.

    It is deliberately *not* done for a roll that found nothing to do (`untouched`):
    "the tag had not moved" is not evidence that the image is current — it is evidence
    that the registry had nothing new, or would not say — so the finding stays where the
    next scan can judge it properly.
    """
    row = conn.execute(
        """
        SELECT f.id FROM findings f JOIN targets t ON t.id = f.target_id
         WHERE t.host = ? AND t.name = ? AND f.manager = 'docker' AND f.package = ?
           AND f.status != 'applied'
         ORDER BY f.id DESC LIMIT 1
        """,
        (host, target_name, ref),
    ).fetchone()
    if row is not None:
        db.set_status(conn, [row["id"]], "applied", reason[:300])


def undo_roll(conn, settings: Settings, *, roll_id: int, actor: str | None = None) -> dict:
    """Put back the image that was running before a recorded roll, by hand.

    The automatic path does this when the health gate fails. This is for what a gate cannot
    see: a container that came up healthy, reports healthy, and is serving the wrong thing —
    a bad release, a regression nothing checks for. A person says "put it back" and this is
    the code that does it.

    The result is deliberately *held*: the container is left blocked until somebody clears
    it (`db.clear_container_roll_blocker`), so the next scheduled pass does not roll it
    forward again while the reason for the undo is still being worked out. Without that, an
    undo on a Monday night would be undone back by Tuesday's timer, which is the worst
    possible shape for a control an operator had to reach for.
    """
    row = conn.execute("SELECT * FROM container_rolls WHERE id=?", (roll_id,)).fetchone()
    if row is None:
        return {"ok": False, "error": f"no roll #{roll_id}"}
    # Only a roll that LANDED can be undone. One that rolled itself back has already put the
    # old image back, and one that never touched the container has nothing to put back —
    # saying so is more use than a recreate that changes nothing.
    if row["state"] != rollout.ROLLED:
        return {"ok": False,
                "error": f"roll #{roll_id} is {row['state']}; only a roll that landed can be undone"}
    if not row["from_image_id"]:
        return {"ok": False, "error": f"roll #{roll_id} did not record the image it replaced"}

    host = next((h for h in settings.hosts if h.name == row["host"]), None)
    if host is None:
        return {"ok": False, "error": f"{row['host']} is not a configured host"}
    container = row["container"] or None
    found = _ancestor_containers(host, container, row["ref"], settings)
    if not found:
        return {"ok": False, "error": f"nothing on {row['host']} runs {row['ref']} any more"}
    cid, cname = found[0]
    argv, service, project, refusal, _note = _compose_invocation(
        host, container, cid, cname, row["ref"], settings)
    if refusal:
        return {"ok": False, "error": refusal}

    target = _RollTarget(
        remit=rollout.Remit(host=row["host"], ref=row["ref"], container=row["container"] or ""),
        state=rollout.ContainerState(host=row["host"], name=cname, ref=row["ref"],
                                     container=row["container"] or ""),
        cid=cid, cname=cname, argv=argv, service=service, project=project)
    landed = _container_image_id(host, container, cname, settings)
    ok, why = _put_image_back(host, container, row["ref"], row["from_image_id"], target, settings)

    # A row of its own rather than an edit of the roll: "we rolled it forward" and "somebody
    # put it back" are two facts with two authors, and a row whose meaning changed would
    # lose the first one exactly when an incident review is reading it.
    undo_id = db.start_container_roll(
        conn, host=row["host"], container=row["container"] or "", name=cname, ref=row["ref"],
        project=project, service=service, from_image_id=landed,
        trigger=f"undo:{actor or 'operator'}", actor=actor)
    state = rollout.ROLLED_BACK if ok else rollout.ROLL_FAILED
    db.finish_container_roll(conn, undo_id, state=state, to_image_id=row["from_image_id"],
                             reason=f"undo of roll #{roll_id}: {why}")
    db.log(conn, f"{cname}: undo of roll #{roll_id} — {why}",
           level="warning" if ok else "error", actor=actor)
    conn.commit()
    return {"ok": True, "roll_id": undo_id, "state": state, "detail": why, "held": ok}


def _parse_stamp(value: str | None):
    """An ISO stamp from the database as an aware datetime, or None.

    `db.utcnow()` writes `2026-11-03T03:30:00Z`, which `fromisoformat` reads on 3.11+ but
    not on every interpreter this service has run on, so the `Z` is spelled out first and
    an unreadable value answers None — a cooldown that cannot be measured must not read as
    "cooled down already".
    """
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


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
