#!/usr/bin/env python3
"""Grade every scenario in the pool on a live machine, and print the table.

Two claims about the whole catalogue, and a sweep is the only thing that can check
either of them, because both are about a *machine* rather than a manifest:

* **untouched does not resolve** — the snapshot a student is handed really is broken.
  A template that quietly lost its injected fault grades full marks for no work, and
  every layer above it (the scenario validates, the template builds, the session
  hands out a machine) says the range is healthy.
* **repaired resolves** — grading tracks the student's work rather than the injection.
  A check script that can never pass fails the students who did everything right, and
  it looks exactly like a hard exercise from the outside.

What is deliberately *not* in this file is the repair for each scenario. Those are the
answers to the exercises, so they live outside the repository, in one ignored place —
``dist/sweep-repairs.json`` by default: a JSON object mapping a scenario id to the
script a competent technician would run::

    {"os-perf-startup": "$burners = @(Get-CimInstance ...)", "id-locked-account": "..."}

Because it is written down there, a sweep is repeatable: the key survives the run, the
shell it was first typed into, and the machine. ``dist/`` is ignored, so it is never
committed, and ``--write-repairs`` lays the skeleton down keyed by every scenario in
the catalogue so nobody hand-builds the mapping.

Without a key the sweep still runs, and still catches the first failure — a fault that
is not in the snapshot. With it, it catches the second as well.

Usage::

    python scripts/grade-sweep.py                      # every pair; both halves if a key exists
    python scripts/grade-sweep.py --write-repairs      # lay down the skeleton to fill in
    python scripts/grade-sweep.py --repairs repairs.json
    python scripts/grade-sweep.py --pairs id-locked-account os-perf-startup

Run it against a real range (it needs Incus and the session manager's config), not
from CI: it boots machines.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RESULTS = ROOT / "dist" / "sweep-results.jsonl"
DEFAULT_LOG = ROOT / "dist" / "sweep.log"
# The answer key lives here, beside the results, on purpose: one ignored path an
# operator can back up, diff between scenarios, and hand to the next sweep.
DEFAULT_REPAIRS = ROOT / "dist" / "sweep-repairs.json"


# --------------------------------------------------------------------------- #
# environment
# --------------------------------------------------------------------------- #
def load_env_file(path: Path) -> None:
    """Read a compose-style ``.env`` into the environment, without running it.

    A shell ``eval`` of the file is the wrong tool: it is compose's and the app's
    *data*, not a script, and evaluating it runs whatever an operator put in it. The
    quoting that lets a value with a space survive `set -a; . ./.env` is stripped again
    here, the way compose strips it — and a *different* environment is a different
    template recipe, which is how one probe called the whole pool stale.
    """
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def write_repairs_skeleton(path: Path, scenario_ids: list[str]) -> None:
    """Lay down the answer key's shape, keyed by every scenario, with empty scripts.

    Writing it from the catalogue rather than from memory is the point: the ids are the
    ones the range actually offers, so a key that has fallen behind a new scenario
    shows up as an empty entry instead of that scenario silently going ungraded.
    An existing file is never overwritten — it holds work that cannot be regenerated.
    """
    if path.exists():
        raise SystemExit(f"{path} already exists; refusing to overwrite it")
    skeleton = {scenario_id: "" for scenario_id in sorted(scenario_ids)}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(skeleton, indent=2) + "\n", encoding="utf-8")


def load_repairs(path: Path) -> dict[str, str]:
    """The answer key: scenario id -> the script that undoes its fault.

    Fails loudly on anything that is not that shape. A repairs file that loads as an
    empty mapping turns the whole second half of the sweep into "no repair given",
    which reads as an incomplete run rather than a typo in the file.
    """
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"no repairs file at {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{path} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit(f"{path} must be a JSON object of scenario id -> script")
    repairs: dict[str, str] = {}
    for scenario_id, script in data.items():
        if not isinstance(script, str) or not script.strip():
            raise SystemExit(f"{path}: repair for {scenario_id!r} is not a script")
        repairs[str(scenario_id)] = script
    if not repairs:
        raise SystemExit(f"{path} has no repairs in it")
    return repairs


# --------------------------------------------------------------------------- #
# reading the result
# --------------------------------------------------------------------------- #
# One verdict per pair, and the rules are the two claims above — nothing else. The
# score is not the measure for the *untouched* half (a half-applied fault that grades
# 40% is still a fault that is not fully in the snapshot, but it is a fault), and for
# the repaired half it is the measure rather than the repair's exit code: a network
# scenario's repair hands the machine's address back to DHCP, which drops the very
# transport the repair was run over.
def verdict(record: dict, *, repairs_expected: bool) -> str:
    if record.get("error"):
        return f"BROKEN: could not be graded: {record['error']}"
    before = record.get("untouched")
    after = record.get("repaired")
    if before is None:
        return "incomplete: nothing was graded for this pair"
    if before.get("resolved"):
        return "BROKEN: untouched already resolves — the fault is not in the snapshot"
    if after is None:
        if repairs_expected:
            return "incomplete: no repair given for this scenario"
        return "ok (untouched only — no repairs file was given)"
    if not after.get("resolved"):
        return f"BROKEN: a correct repair does not resolve (left at {after.get('score')}%)"
    if after.get("score", 0) < 100:
        return f"BROKEN: the repair scores {after.get('score')}% rather than 100%"
    repair = record.get("repair") or {}
    if repair and not repair.get("ok", False):
        return f"ok (the repair's own transport dropped, exit {repair.get('exit_code')})"
    return "ok"


def _fmt(report: dict | None) -> str:
    if not report:
        return "-"
    if report.get("error"):
        return f"error({str(report['error'])[:12]})"
    return f"{report['score']:.0f}% {report['passed']}/{report['total']}"


def table(records: list[dict], *, repairs_expected: bool) -> str:
    """The whole sweep as one screen: pair, both grades, and the verdict."""
    if not records:
        return "nothing was graded"
    lines = [f"{'pair':44} {'untouched':>14} {'repaired':>14}  verdict", "-" * 118]
    problems: list[tuple[str, str, dict]] = []
    for record in sorted(records, key=lambda r: r.get("pair", "")):
        call = verdict(record, repairs_expected=repairs_expected)
        if not call.startswith("ok"):
            problems.append((record.get("pair", "?"), call, record))
        lines.append(
            f"{record.get('pair', '?'):44} {_fmt(record.get('untouched')):>14} "
            f"{_fmt(record.get('repaired')):>14}  {call}"
        )
    lines.append("")
    if not problems:
        lines.append(
            "every pair: broken untouched, resolved after repair"
            if repairs_expected
            else "every pair: broken untouched (no repairs file was given, so the "
            "repair half was not run)"
        )
        return "\n".join(lines)
    lines.append(f"{len(problems)} pair(s) need attention:")
    for pair, call, record in problems:
        lines.append(f"\n== {pair}: {call}")
        for phase in ("untouched", "repaired"):
            report = record.get(phase)
            if not report:
                continue
            lines.append(
                f"   {phase}: {report.get('score', 0):.0f}% resolved={report.get('resolved')}"
            )
            for name, (passed, detail) in (report.get("objectives") or {}).items():
                lines.append(f"     {'PASS' if passed else 'FAIL'} {name}: {str(detail)[:150]}")
        repair = record.get("repair") or {}
        if repair and not repair.get("ok", False):
            lines.append(f"   repair exit={repair.get('exit_code')}")
            lines.append(f"   repair stderr: {(repair.get('stderr') or '')[-800:]}")
        if record.get("traceback"):
            lines.append(record["traceback"])
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# driving a real machine
# --------------------------------------------------------------------------- #
def _build_manager():
    """The session manager, wired the way the CLI wires it."""
    load_env_file(ROOT / ".env")
    sys.path.insert(0, str(ROOT))
    from ontrak.catalog import Catalog  # noqa: PLC0415 - after the env is loaded
    from ontrak.config import load_settings  # noqa: PLC0415
    from ontrak.incus import IncusClient  # noqa: PLC0415
    from ontrak.scenarios import ScenarioRepository  # noqa: PLC0415
    from ontrak.sessions import SessionManager  # noqa: PLC0415
    from ontrak.store import Store  # noqa: PLC0415

    settings = load_settings()
    store = Store(settings.db_path)
    repo = ScenarioRepository(settings.scenarios_dir)
    catalog = Catalog(settings.catalog_dir)
    catalog.load()
    # The manager decides which workloads exist from the catalogue, so a Linux
    # scenario is only offered here if the catalogue is loaded first.
    settings.incus.known_workloads = tuple(catalog.entries)
    return SessionManager(
        settings, store, repo=repo, incus=IncusClient(settings), catalog=catalog
    )


def _report(report) -> dict:
    return {
        "score": round(report.score, 1),
        "resolved": bool(report.resolved),
        "error": report.error,
        "passed": report.passed_count,
        "total": len(report.outcomes),
        "objectives": {o.objective_id: (bool(o.passed), o.detail[:300]) for o in report.outcomes},
    }


def grade_pair(manager, label: str, scenario, workload: str, repairs: dict[str, str], log) -> dict:
    """Hand out a machine for one pair, grade it, repair it, grade it again, then end it.

    The student key is the pair and not the scenario: ``create_session`` is idempotent
    per (student, scenario), so one scenario offered on two platforms would otherwise
    be graded twice on the same machine and the second platform would never be looked
    at.
    """
    record: dict = {
        "pair": label,
        "scenario": scenario.id,
        "workload": workload,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    started = time.time()
    session = None
    try:
        session = manager.create_session(label, scenario.id, workload=workload or None)
        session = manager.provision(session)
        record["instance"] = session.instance
        log(f"{label}: up on {session.host_ip} ({session.instance}) after {time.time() - started:.0f}s")

        before = manager.run_checks(session, record=False)
        record["untouched"] = _report(before)
        log(f"{label}: untouched -> {before.summary_line()}")

        script = repairs.get(scenario.id)
        if script is None:
            record["repair"] = {"ok": False, "error": "no repair given for this scenario"}
            log(f"{label}: no repair given, untouched only")
        else:
            from ontrak.scenarios import COMMON_LIB  # noqa: PLC0415 - ROOT is on the path by now

            driver = manager._driver_for(scenario)
            # Dotted in from where the session manager actually puts it: the work dir
            # is configurable, and a Windows repair that sourced the wrong file would
            # fail every Windows scenario at once.
            lib = manager._join(scenario, "lib", COMMON_LIB)
            if getattr(scenario, "platform", "windows") == "linux":
                result = driver.run_shell(
                    script, host=session.host_ip, instance=session.instance, timeout=300
                )
            else:
                result = driver.run_powershell(
                    f". '{lib}'\n{script}",
                    host=session.host_ip,
                    instance=session.instance,
                    timeout=420,
                )
            record["repair"] = {
                "ok": bool(result.ok),
                "exit_code": result.exit_code,
                "stdout": (result.stdout or "")[-3000:],
                "stderr": (result.stderr or "")[-2000:],
            }
            log(f"{label}: repair rc={result.exit_code} ok={bool(result.ok)}")

            after = manager.run_checks(session, record=False)
            record["repaired"] = _report(after)
            log(f"{label}: repaired -> {after.summary_line()}")
    except Exception as exc:  # noqa: BLE001 - one pair must not end the sweep
        record["error"] = f"{type(exc).__name__}: {exc}"
        record["traceback"] = traceback.format_exc()[-2000:]
        log(f"{label}: ERROR {record['error']}")
    finally:
        record["duration_seconds"] = round(time.time() - started, 1)
        if session is not None:
            try:
                manager.end(session, reason="sweep complete")
                record["destroyed"] = True
            except Exception as exc:  # noqa: BLE001
                record["destroyed"] = False
                record["destroy_error"] = str(exc)
    return record


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--repairs",
        type=Path,
        default=None,
        help=(
            "JSON answer key: scenario id -> script "
            f"(default: {DEFAULT_REPAIRS.relative_to(ROOT)} when it exists)"
        ),
    )
    parser.add_argument(
        "--write-repairs",
        nargs="?",
        const=DEFAULT_REPAIRS,
        type=Path,
        default=None,
        metavar="PATH",
        help="write the answer-key skeleton, keyed by every scenario, then stop",
    )
    parser.add_argument("--pairs", nargs="*", default=[], help="only these (scenario@workload)")
    parser.add_argument("--results", type=Path, default=DEFAULT_RESULTS, help="JSON lines, one per pair")
    parser.add_argument("--log", type=Path, default=DEFAULT_LOG, help="where the running commentary goes")
    parser.add_argument("--force", action="store_true", help="re-grade pairs already in --results")
    args = parser.parse_args(argv)

    args.results.parent.mkdir(parents=True, exist_ok=True)
    args.log.parent.mkdir(parents=True, exist_ok=True)

    def log(message: str) -> None:
        line = f"{time.strftime('%H:%M:%S')} {message}"
        print(line, flush=True)
        with args.log.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")

    manager = _build_manager()

    if args.write_repairs is not None:
        # The one run that touches no machine: the ids come from the catalogue, so a
        # key can never fall behind a scenario the range really offers.
        ids = sorted({scenario.id for scenario, _ in manager.workload_pairs()})
        write_repairs_skeleton(args.write_repairs, ids)
        print(f"answer key skeleton: {args.write_repairs} ({len(ids)} scenario(s))")
        print("fill in each script, then `make sweep` grades both halves.")
        return 0

    # One key, one place: an explicit --repairs wins; otherwise the ignored default is
    # used when it is there, and the run is untouched-only when it is not.
    repairs_path = args.repairs or (DEFAULT_REPAIRS if DEFAULT_REPAIRS.exists() else None)
    repairs = load_repairs(repairs_path) if repairs_path else {}
    if repairs_path:
        log(f"sweep: answer key {repairs_path} ({len(repairs)} scenario(s))")
    else:
        log(f"sweep: no answer key at {DEFAULT_REPAIRS}; grading the untouched half only")

    wanted = set(args.pairs)

    done: list[dict] = []
    if args.results.exists():
        for line in args.results.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    done.append(json.loads(line))
                except json.JSONDecodeError:
                    log(f"ignoring an unreadable line in {args.results}")
    recorded = {row.get("pair") for row in done}

    queue = [
        (f"{scenario.id}@{workload}" if workload else scenario.id, scenario, workload)
        for scenario, workload in manager.workload_pairs()
    ]
    queue = [(label, s, w) for label, s, w in queue if not wanted or label in wanted]
    log(
        f"sweep: {len(queue)} pair(s) of {len(manager.workload_pairs())}, "
        f"{len(recorded)} already in {args.results}"
    )

    for label, scenario, workload in queue:
        if label in recorded and not args.force:
            log(f"{label}: already recorded, skipping")
            continue
        record = grade_pair(manager, label, scenario, workload, repairs, log)
        done.append(record)
        with args.results.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\n")

    log("sweep: finished\n")
    if not done:
        print("nothing was graded — check --pairs, and that the catalogue lists scenarios")
        return 1
    print(table(done, repairs_expected=bool(repairs)))
    print(f"\nresults: {args.results}\nlog:     {args.log}")
    return 1 if any(not verdict(r, repairs_expected=bool(repairs)).startswith("ok") for r in done) else 0


if __name__ == "__main__":
    raise SystemExit(main())
