#!/usr/bin/env python3
"""Check the promise `docker compose up` makes on a machine that has only Docker.

One command is the whole installation: `lab-setup` writes `.env`, publishes the
shared secrets the portal and the console gateway must agree on, and prepares
Incus on the host; then the other services start. Compose cannot interpolate a
secret that does not exist yet (interpolation happens when the project is
loaded, before any container runs) and `env_file` is read even earlier, so the
only way to keep that promise is the arrangement this checks:

  * a `lab-setup` service exists and can reach the host (privileged, pid: host),
    write the project directory, and run the image's own copy of its script —
    a bind mount over /app would shadow it, executable bit and all;
  * the portal and the console gateway wait for it to *complete*, not merely to
    start, because the files it writes are what they read;
  * both of them can read the shared secrets volume, and the portal can reach
    the host's Incus;
  * the whole file renders with no `.env` at all — a first run has none.

Read the rendered configuration rather than the YAML: what matters is the
project compose actually builds, including interpolation and overrides.

Exit 0 when the contract holds, 1 with the first broken promise otherwise.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

PORTAL = "portal"
GATEWAY = "guacamole"
SETUP = "lab-setup"
SECRETS_MOUNT = "/run/ontrak"
PROJECT_MOUNT = "/project"
IMAGE_MOUNT = "/app"
INCUS_MOUNT = "/var/lib/incus"


def rendered(*extra: str) -> dict:
    cmd = ["docker", "compose", *extra, "config", "--format", "json"]
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"{' '.join(cmd)} failed:\n{proc.stderr.strip()}")
    return json.loads(proc.stdout)


def mounts(service: dict) -> set[str]:
    return {str(m.get("target")) for m in service.get("volumes") or []}


def check(config: dict) -> list[str]:
    problems: list[str] = []
    services = config.get("services") or {}

    setup = services.get(SETUP)
    if setup is None:
        return [f"there is no {SETUP} service: `docker compose up` would not prepare a host"]

    if not setup.get("privileged") or setup.get("pid") != "host":
        problems.append(
            f"{SETUP} cannot reach the host's namespaces "
            "(needs privileged: true and pid: host)"
        )
    if PROJECT_MOUNT not in mounts(setup):
        problems.append(
            f"{SETUP} cannot write the project directory (no {PROJECT_MOUNT} mount), "
            "so it cannot generate .env"
        )
    # The script says where it thinks the checkout is; the mount says where it
    # actually is. If they disagree, `.env` is written into the container and the
    # operator never sees it.
    setup_env = setup.get("environment") or {}
    if setup_env.get("ONTRAK_PROJECT_DIR") != PROJECT_MOUNT:
        problems.append(
            f"{SETUP} looks for the checkout at "
            f"{setup_env.get('ONTRAK_PROJECT_DIR')!r}, but it is mounted at "
            f"{PROJECT_MOUNT}"
        )
    # A bind mount over /app replaces the image's copy of the script — including
    # the executable bit `entrypoint` needs, and a checkout on a filesystem with
    # no exec permission would then fail to start at all.
    if IMAGE_MOUNT in mounts(setup):
        problems.append(
            f"{SETUP} mounts over {IMAGE_MOUNT}, shadowing the image's own copy of "
            "docker/lab-setup.sh — the host's checkout may not be executable"
        )
    entrypoint = setup.get("entrypoint") or []
    if not entrypoint or not str(entrypoint[0]).startswith(f"{IMAGE_MOUNT}/"):
        problems.append(
            f"{SETUP} runs {entrypoint[:1] or 'nothing'}, not the script baked into "
            f"the image under {IMAGE_MOUNT}/ — a first run must not depend on the "
            "checkout being executable"
        )

    for name in (PORTAL, GATEWAY):
        service = services.get(name)
        if service is None:
            problems.append(f"there is no {name} service")
            continue
        dependency = (service.get("depends_on") or {}).get(SETUP) or {}
        if dependency.get("condition") != "service_completed_successfully":
            problems.append(
                f"{name} does not wait for {SETUP} to finish "
                f"(condition: {dependency.get('condition', 'missing')!r}) — it would "
                "start before the secrets it needs exist"
            )
        if SECRETS_MOUNT not in mounts(service):
            problems.append(f"{name} cannot read the shared secrets ({SECRETS_MOUNT})")

    portal = services.get(PORTAL) or {}
    if INCUS_MOUNT not in mounts(portal):
        problems.append(
            f"{PORTAL} cannot reach the host's Incus ({INCUS_MOUNT}) — training "
            "machines would be unreachable"
        )
    return problems


def main() -> int:
    # With no .env at all: the first run of a fresh clone.
    bare = rendered()
    # And as an operator starts it when .env exists: same contract, and it also
    # proves the remote/demo override does not break it.
    from_env = rendered("-f", "docker-compose.yml", "-f", "docker-compose.remote.yml")

    problems = check(bare)
    problems += [f"(remote/demo override) {p}" for p in check(from_env)]
    if problems:
        for problem in problems:
            print(f"first-run contract: {problem}", file=sys.stderr)
        return 1

    print("first-run contract: ok — lab-setup prepares the host, the services wait for it")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
