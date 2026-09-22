#!/usr/bin/env python3
"""Run infrastructure/windows/post-install.ps1 inside a running Windows VM.

    infra/windows/apply-postinstall.py <instance-name> <ip-address>

Uses the same guest driver the session manager uses (ontrak.guest), so if this
works, provisioning will work too. Writes the training password to a temporary
config file inside the guest, runs the script, verifies its marker, then deletes
the file.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ontrak.config import load_settings  # noqa: E402
from ontrak.guest import GuestError, build_driver  # noqa: E402
from ontrak.models import Session  # noqa: E402

SCRIPT = Path(__file__).resolve().parent / "post-install.ps1"
GUEST_CONFIG = r"C:\ProgramData\OnTrak\config.json"
GUEST_SCRIPT = r"C:\ProgramData\OnTrak\post-install.ps1"
MARKER = "ONTRAK-POSTINSTALL-OK"


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    instance, ip = argv[1], argv[2]

    settings = load_settings()
    if not settings.guest.password:
        print("guest.password is empty: set ONTRAK_GUEST__PASSWORD first", file=sys.stderr)
        return 2

    driver = build_driver(settings)
    session = Session(
        id=None,
        student="<golden-build>",
        scenario_id="<golden-build>",
        instance=instance,
        host_ip=ip,
        rdp_user=settings.guest.user,
        rdp_password=settings.guest.password,
    )

    print(f"waiting for the {driver.name} transport on {instance} ({ip}) ...")
    if not driver.wait_ready(session, timeout=settings.guest.ready_timeout_seconds):
        print("the guest never became reachable; check WinRM and the credentials", file=sys.stderr)
        return 1

    payload = json.dumps({"user": settings.guest.user, "password": settings.guest.password})
    driver.upload_text(payload, GUEST_CONFIG, host=ip, instance=instance)
    driver.upload_file(SCRIPT, GUEST_SCRIPT, host=ip, instance=instance)

    def run() -> tuple[str, int]:
        result = driver.run_script_file(GUEST_SCRIPT, host=ip, instance=instance, timeout=900)
        return (result.stdout or "") + (result.stderr or ""), result.exit_code

    print("running post-install.ps1 ...")
    output, exit_code = run()
    print(output.strip())

    if MARKER not in output:
        # One retry. The script is idempotent, and anything inside it that
        # recycles a Windows service carrying our transport (WinRM while
        # Enable-PSRemoting runs, the Incus agent) drops the exec session part-way
        # through and leaves output that looks exactly like a failed step. Seconds
        # of retry against an hour-long image build is the right trade; a genuine
        # failure fails twice and is reported below.
        print("no marker in that run; retrying once (post-install is idempotent) ...")
        output, exit_code = run()
        print(output.strip())

    if MARKER not in output:
        print(f"\npost-install did not report {MARKER} (exit {exit_code})", file=sys.stderr)
        return 1

    # Belt and braces: post-install deletes the file itself, but a crash between
    # writing it and finishing would leave credentials on the image.
    driver.run_powershell(
        f"Remove-Item -Path '{GUEST_CONFIG}' -Force -ErrorAction SilentlyContinue; 'cleaned'",
        host=ip,
        instance=instance,
    )
    print(f"\nok: golden image customised on {instance}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except GuestError as exc:
        # `from exc` keeps the guest error in the traceback: this exits the
        # process, and the reason is the only thing that explains the exit.
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
