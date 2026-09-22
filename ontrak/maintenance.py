"""The portal's own housekeeping: expiry, idle recycling and history pruning.

Why this exists: ``ontrak reap`` and ``ontrak schedule tick`` are written to run from
cron, and the stack that ``docker compose up`` builds has no cron in it. Every rule the
reaper enforces was therefore only enforced when somebody remembered a command — and the
symptom was a student's session sitting at ``in_use`` with ``0:00`` left, on a machine
nothing would ever take back, because the row was waiting for a reaper nobody had
started. The promise in docs/operations.md ("a session left open is recycled
automatically") should not depend on an operator's terminal history.

So the portal runs the reaper itself, in one daemon thread on a fixed interval:

* **expiry and idle recycling** — a session past its time limit, or idle beyond
  ``session.idle_recycle_minutes``, is recycled exactly as ``ontrak reap`` would;
* **history** — at most once a day, finished session rows older than
  ``session.history_days`` are deleted, keeping every one a result or ticket points at.

What it deliberately does **not** do is refill the warm pool. Pool depth is capacity
policy — ``pool.targets``, ``ontrak schedule tick``, ``ontrak pool refill``, the admin
panel — and a background thread quietly booting machines on a laptop-sized host is the
opposite of what OnTrak is for. It calls ``manager.reap(refill=False)`` for that reason.

Nothing here is required for a range to work: ``session.maintenance_enabled: false``
turns the loop off, and every action it takes is one an operator can take by hand.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field

LOG = logging.getLogger("ontrak.maintenance")

# Below this, a loop is a busy-wait rather than maintenance. The default is a minute.
MIN_INTERVAL_SECONDS = 5


def tick(manager, settings) -> dict:
    """One maintenance pass. Never raises — a loop that dies is a range that leaks.

    Returns what it did, for the tests and for a caller that wants to log it. Each half
    is guarded separately: a hypervisor that is down must not stop the history prune,
    and vice versa.
    """
    result: dict = {"reaped": None, "pruned": None, "error": ""}
    try:
        result["reaped"] = manager.reap(refill=False)
    except Exception as exc:  # noqa: BLE001 - the next tick is the retry
        result["error"] = f"reap: {exc}"
        LOG.warning("maintenance: reap failed: %s", exc)
    try:
        result["pruned"] = manager.prune_history()
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"{result['error']} prune: {exc}".strip()
        LOG.warning("maintenance: prune failed: %s", exc)
    return result


@dataclass
class Loop:
    """A started maintenance thread, and the way to stop it."""

    thread: threading.Thread
    stop_event: threading.Event = field(default_factory=threading.Event)

    def stop(self, timeout: float = 5.0) -> None:
        """Ask the loop to finish and wait briefly for it.

        The thread is a daemon, so a process that exits without this is not broken —
        but a test that starts one wants it actually gone, and so does a lifespan
        shutdown.
        """
        self.stop_event.set()
        self.thread.join(timeout=timeout)


def start(manager, settings) -> Loop | None:
    """Start the maintenance loop. ``None`` when it is switched off."""
    session = settings.session
    if not session.maintenance_enabled:
        return None
    interval = max(int(session.maintenance_interval_seconds), MIN_INTERVAL_SECONDS)
    stop_event = threading.Event()

    def run() -> None:
        # One pass immediately, so a portal that has just been restarted ends the
        # sessions the previous process left behind rather than waiting out the
        # interval; then once per interval until asked to stop.
        while True:
            tick(manager, settings)
            if stop_event.wait(interval):
                return

    thread = threading.Thread(target=run, name="ontrak-maintenance", daemon=True)
    loop = Loop(thread=thread, stop_event=stop_event)
    thread.start()
    return loop
