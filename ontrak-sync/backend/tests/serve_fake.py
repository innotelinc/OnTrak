#!/usr/bin/env python3
"""A Sync API over a *fake* Network, so a browser can drive the real console.

`test_api_rollout.py` proves the endpoints with an ASGI client, which is the right
shape for asserting payloads and status codes and the wrong shape for the one thing
the dashboard is: a page. Whether the rollouts table draws the row it was sent, whether
the claim form fills itself from the images below it, whether the Undo button is offered
on the roll an undo would actually mean something for — none of that is visible to a
test that never renders anything. So the browser spec needs a running stack, and this is
the API half of it.

It is a *serving* harness and not a test: it boots the real application
(`api.create_app`), over a throwaway database, with exactly one thing faked. The fake is
`FakeDocker` from `test_rollout_apply.py` — not a copy of it — because that fake is
already the one the roll's unit tests hold to, so the browser spec and the roll tests
cannot drift apart about what a host answers.

What is real here: FastAPI's routes, Pydantic's parsing, the bearer token and the session
cookie, the capability checks, the remit store, the rails in `rollout.py`, the whole of
`apply_rollouts`, and `undo_roll`. What is faked: `ssh`, `incus exec` and
`docker …` on the host, because a test runner has no Network. The scan's finding is
seeded rather than discovered for the same reason.

    python3 tests/serve_fake.py            # 127.0.0.1:8420, admin/change-me-ontrak

`ONTRAK_FAKE_PORT`, `ONTRAK_FAKE_HOST`, `ONTRAK_FAKE_CONTAINER`, `ONTRAK_FAKE_REF`,
`ONTRAK_API_TOKEN`, `ONTRAK_ADMIN_USER` and `ONTRAK_ADMIN_PASSWORD` override the
defaults. The API refuses to start without a token, so this supplies a local-only
placeholder rather than making the caller invent one — nothing here reaches a machine.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

try:
    import uvicorn
except ImportError as exc:  # pragma: no cover — see the note in test_api_rollout.py
    raise SystemExit(
        "uvicorn is not installed, so there is nothing to serve. It is in "
        f"requirements.txt: pip install -r ontrak-sync/backend/requirements.txt ({exc})"
    )

from ontrak import api, applier, db, registry  # noqa: E402
from ontrak.config import Host, Settings  # noqa: E402
from test_rollout_apply import REF, FakeDocker  # noqa: E402


def settings_from_env() -> tuple[Settings, str, str]:
    """The settings a running API needs, plus the container and ref the spec claims.

    A file rather than `:memory:` because that is the shape the service runs in, and a
    harness that skipped the store's own setup would be one more thing that differs from
    what a deployment does.
    """
    host_name = os.environ.get("ONTRAK_FAKE_HOST", "i1")
    address = os.environ.get("ONTRAK_FAKE_HOST_ADDRESS", "192.168.1.51")
    container = os.environ.get("ONTRAK_FAKE_CONTAINER", "monarch")
    ref = os.environ.get("ONTRAK_FAKE_REF", REF)
    database = os.environ.get("ONTRAK_FAKE_DB") or str(
        Path(tempfile.mkdtemp(prefix="ontrak-sync-fake-")) / "ontrak.sqlite3")
    settings = Settings(
        hosts=(Host(host_name, address, "both"),),
        db_path=Path(database),
        api_token=os.environ.get("ONTRAK_API_TOKEN", "local-only-fake-network"),
        admin_user=os.environ.get("ONTRAK_ADMIN_USER", "admin"),
        admin_password=os.environ.get("ONTRAK_ADMIN_PASSWORD", "change-me-ontrak"),
        # No timer: a pass in this harness is a click, so what the page shows is what
        # the click did and not what happened to fire while the assertion was running.
        scheduler_enabled=False,
        # The kill switch is ON here. The banner the page draws when it is off is real
        # and worth a browser test, but it is not the case a roll can be driven from —
        # and a spec that can only ever see the disabled state proves nothing about the
        # buttons it is there to exercise.
        rollout_enabled=True,
    )
    return settings, container, ref


def seed_finding(conn, *, host: str, container: str, ref: str) -> None:
    """The scan's finding, which is the precondition for a roll even being attempted.

    `_roll_targets` only looks at a container the last scan flagged, so a harness that
    seeded nothing would answer every pass with "no containers in the remit" and the
    spec would be testing an empty Network's worth of nothing.
    """
    target = db.ensure_target(conn, host=host, kind="container", name=container)
    db.record_finding(conn, target_id=target, manager="docker", package=ref,
                      current="sha256:old", candidate="sha256:new")
    row = conn.execute("SELECT id FROM findings WHERE manager='docker'").fetchone()
    db.set_status(conn, [row["id"]], "pending")
    conn.commit()


def main() -> None:
    settings, container, ref = settings_from_env()
    app = api.create_app(settings)
    conn = app.state.conn
    host_name = settings.hosts[0].name
    seed_finding(conn, host=host_name, container=container, ref=ref)

    # The patchers are started and never stopped: this process exists to be the fake, and
    # a `stop()` at the end of `main` would be a stop that never runs.
    fake = FakeDocker()
    mock.patch.multiple(applier, ssh=fake.ssh, incus_exec=fake.incus_exec,
                        docker_in_container=fake.docker_in_container).start()
    mock.patch.multiple(registry, docker_in_container=fake.docker_in_container).start()

    port = int(os.environ.get("ONTRAK_FAKE_PORT", "8420"))
    print(f"fake Network ready on http://127.0.0.1:{port}", flush=True)
    print(f"  host {host_name} · container {container} · {ref}", flush=True)
    print(f"  sign in at /login/break-glass as {settings.admin_user}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
