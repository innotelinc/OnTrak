"""Ontrak Sync — the in-process scheduler.

One thread, ticking every `ONTRAK_SCHEDULER_TICK` seconds, comparing the wall
clock against the operator's cron expression. It lives in the API process rather
than in the host's crontab because the whole point of the timer is that it is
editable from the dashboard, and a system crontab cannot be edited by a web form
without the service shelling out to rewrite its own schedule — which is both a
privilege escalation and a way to end up with two schedules that disagree.

WHAT IT DOES NOT DO: FIRE TWICE IN A MINUTE
-------------------------------------------
The tick is 30 seconds by default, so a minute contains two of them. Without the
last-fired guard, every scheduled run would happen twice — two scans racing each
other, and in `auto` mode two applies of the same package. The guard is the minute
number itself rather than a "running" flag, because a run that takes ninety seconds
should not make the *next* minute's run get skipped.

The lock is separate and does the opposite job: it stops a manual scan from the
dashboard and a scheduled scan from walking the estate at the same time, which
would double every finding and put two `apt-get` transactions on one host.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone

from . import db
from .applier import apply_findings
from .policy import Cron, CronError, Policy
from .scan import scan_estate

log = logging.getLogger("ontrak.scheduler")

POLICY_KEY = "policy"


def load_policy(conn, settings=None) -> Policy:
    """The operator's policy, or the defaults if nothing has been saved yet.

    `settings` is optional only so a caller that has no `Settings` (a test, a
    one-off script) still gets a usable policy. When it IS passed, its
    `default_schedule`/`default_mode` seed the policy that exists before the form
    has ever been saved — that is what those two environment variables are FOR,
    and honouring them here is the difference between a documented default and a
    decoration. The moment a policy has been saved the database wins outright: the
    environment must never quietly rewrite a schedule somebody chose.
    """
    stored = db.get_setting(conn, POLICY_KEY, {})
    if stored:
        return Policy.from_dict(stored)
    seed = {"schedule": settings.default_schedule, "mode": settings.default_mode} \
        if settings is not None else {}
    return Policy.from_dict(seed)


def save_policy(conn, policy: Policy) -> list[str]:
    """Validate, then persist. Returns the list of problems (empty on success).

    Invalid input is REFUSED rather than stored-and-ignored: a schedule the
    scheduler cannot parse would be a timer that silently never fires, and the
    operator would have no way to tell that from a timer that fired and found
    nothing to do.
    """
    problems = policy.validate()
    if problems:
        return problems
    db.set_setting(conn, POLICY_KEY, policy.as_dict())
    conn.commit()
    return []


class Scheduler(threading.Thread):
    """The timer. Daemon thread, so it never keeps the process alive."""

    def __init__(self, conn, settings, *, lock: threading.Lock | None = None):
        super().__init__(name="ontrak-scheduler", daemon=True)
        self.conn = conn
        self.settings = settings
        self.lock = lock or threading.Lock()
        self._stop = threading.Event()
        self._last_minute: str | None = None
        self.last_fired_at: str | None = None
        self.last_result: dict | None = None

    def stop(self) -> None:
        self._stop.set()

    def due(self, now: datetime | None = None) -> bool:
        """Is a run due right now, and not already run this minute?"""
        policy = load_policy(self.conn, self.settings)
        if not policy.enabled:
            return False
        try:
            cron = Cron.parse(policy.schedule)
        except CronError as exc:
            log.error("schedule %r is unusable: %s", policy.schedule, exc)
            return False
        moment = now or datetime.now(timezone.utc)
        if not cron.matches(moment):
            return False
        return moment.strftime("%Y-%m-%dT%H:%M") != self._last_minute

    def tick(self, now: datetime | None = None) -> dict | None:
        """One pass: scan if due, then apply if the policy allows it.

        The policy is re-read inside the lock so a settings change made while a
        previous run was in flight takes effect on this run rather than the next.
        """
        moment = now or datetime.now(timezone.utc)
        if not self.due(moment):
            return None
        self._last_minute = moment.strftime("%Y-%m-%dT%H:%M")
        with self.lock:
            policy = load_policy(self.conn, self.settings)
            db.log(self.conn, f"scheduled scan fired ({policy.schedule}, mode={policy.mode})")
            self.conn.commit()
            result = scan_estate(self.conn, self.settings, policy, trigger="schedule")
            self.last_fired_at = db.utcnow()
            self.last_result = result

            if policy.mode != "auto":
                # Detect mode stops here. The scan has already written what it
                # found; a person approves it from the dashboard.
                return result

            approved = db.list_findings(self.conn, status="approved")
            approved += db.list_findings(self.conn, status="pending")
            ids = [row["id"] for row in approved]
            security_only = policy.security_only
            if security_only:
                ids = [row["id"] for row in approved if row["security"]]
            if ids:
                action = policy.action_for(
                    security_count=sum(1 for row in approved if row["security"]),
                    total_count=len(approved),
                    now=moment,
                )
                if action == "apply":
                    result = dict(result)
                    result["apply"] = apply_findings(
                        self.conn, self.settings, policy, finding_ids=ids, trigger="schedule"
                    )
            return result

    def run(self) -> None:  # noqa: D102 — threading.Thread
        tick = max(5, self.settings.scheduler_tick_seconds)
        log.info("scheduler started, ticking every %ss", tick)
        while not self._stop.wait(tick):
            try:
                self.tick()
            except Exception:  # a bad tick must not kill the timer for good
                log.exception("scheduler tick failed")
                db.log(self.conn, "scheduled tick failed — see server log", level="error")
                self.conn.commit()
