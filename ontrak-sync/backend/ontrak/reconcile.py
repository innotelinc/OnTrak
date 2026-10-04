"""Ontrak Sync — the reconcile report.

A scan answers "what is out of date". This answers the two questions a scan
*creates* but does not itself close out, and it runs at the end of every scan so
the scheduled timer carries it along without a second cron to keep in step:

  * **What vanished.** A container that has been removed from a host is dropped by
    `db.prune_targets`, which is the right thing to do — but the drop was only a
    line in the event log, easy to miss among a scan's worth of them. Named here,
    it is a fact the Runs page states: \"i3 dropped onyx, signara — they are not in
    the listing any more\".

  * **What is stuck.** A `failed` finding that survives apply after apply is not a
    retry; it is a decision nobody has made — recreate a manual container by hand,
    accept it, or fix the credential. `db.stale_failures` finds the ones red for
    longer than `Settings.stale_failure_seconds`, and the report says so out loud
    instead of leaving a red number on the dashboard with no explanation.

It is deliberately a *report* and not a remediation: it deletes nothing, applies
nothing and changes no status. The prune is the only destructive act and it stays
where it is, in the scan, gated on a real instance listing. Everything here is
read-and-record, so a wrong threshold can only be noisy, never harmful.

WHY IT IS ALSO STORED. The vanished names only exist at scan time — the target
rows they describe are already gone by the time anyone could ask. So the report is
written back under one settings key, which is what lets `GET /api/reconcile`
answer \"what was dropped last time\" without re-running the Network.
"""

from __future__ import annotations

import logging

from . import db
from .config import Settings

log = logging.getLogger("ontrak.reconcile")

# The one settings row this module owns. It holds the last report as JSON.
RECONCILE_KEY = "reconcile"


def build(conn, settings: Settings, *, vanished: dict | None = None,
          now: float | None = None) -> dict:
    """Compute the report without recording it.

    `vanished` is the scan's own tally — host name to the target names it dropped —
    because only the scan knows it: by the time this runs, `prune_targets` has
    already deleted the rows.
    """
    cleaned = {host: sorted(names) for host, names in (vanished or {}).items() if names}
    stale = db.stale_failures(conn, older_than_seconds=settings.stale_failure_seconds, now=now)
    return {
        "at": db.utcnow(),
        "vanished": cleaned,
        "vanished_count": sum(len(names) for names in cleaned.values()),
        "stale_failures": stale,
        "stale_count": len(stale),
    }


def summarize(report: dict) -> str:
    """One line, in the order a person reads it: what left, then what is stuck."""
    parts: list[str] = []
    if report["vanished_count"]:
        hosts = "; ".join(f"{host}: {', '.join(names)}"
                          for host, names in report["vanished"].items())
        parts.append(f"{report['vanished_count']} target(s) dropped: {hosts}")
    if report["stale_count"]:
        shown = ", ".join(
            f"{row['host']}/{row['target']} {row['manager']} {row['package']}"
            for row in report["stale_failures"][:5]
        )
        more = "" if report["stale_count"] <= 5 else \
            f" (+{report['stale_count'] - 5} more)"
        parts.append(f"{report['stale_count']} stale failure(s): {shown}{more}")
    return "; ".join(parts)


def reconcile(conn, settings: Settings, *, vanished: dict | None = None,
              trigger: str = "scan", now: float | None = None) -> dict:
    """Build the report, remember it, and log it only when it has something to say.

    The run row is written only when there is something to report, so a quiet
    Network does not fill the Runs page with empty reconciles — the report is a
    signal, not a heartbeat. The caller commits.
    """
    report = build(conn, settings, vanished=vanished, now=now)
    report["trigger"] = trigger
    db.set_setting(conn, RECONCILE_KEY, report)
    if report["vanished_count"] or report["stale_count"]:
        summary = summarize(report)
        run_id = db.start_run(conn, "reconcile", trigger)
        db.finish_run(conn, run_id, status="attention", summary=summary)
        db.log(conn, f"reconcile: {summary}", level="warning", run_id=run_id)
        log.warning("reconcile: %s", summary)
    return report


def stored(conn) -> dict | None:
    """The last report recorded by a scan, or None before the first one."""
    return db.get_setting(conn, RECONCILE_KEY)


def current(conn, settings: Settings, *, now: float | None = None) -> dict:
    """The report for a caller asking right now.

    The stale check is recomputed (a failure may have crossed the threshold since
    the last scan), but the vanished names are read back from the stored report,
    because only a scan can produce them and re-running the Network to answer a GET
    would be absurd.
    """
    last = stored(conn) or {}
    return build(conn, settings, vanished=last.get("vanished"), now=now)
