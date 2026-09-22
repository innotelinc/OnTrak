"""The guest transports, against a stand-in for a Windows guest.

The readiness probe is the one call every provisioning path makes before it does
any work, and it was wrong in a way no fake guest could have caught: it asked for
``$env:COMPUTERNAME``, which a sysprepped/OOBE image (and the Incus agent's
service context) can leave unset. The probe then reported a live, installed
Windows guest as unreachable and provisioning stalled until the timeout expired —
which is exactly what happened while building the golden image.

So the stand-in guest here is one whose ``COMPUTERNAME`` is empty and whose
``[Environment]::MachineName`` answers, which is the machine this platform really
meets, and the assertions are about behaviour rather than argv.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from types import SimpleNamespace

from ontrak.guest import (
    READY_PROBE,
    UPLOAD_CHUNK,
    WINRS_COMMAND_LINE_LIMIT,
    IncusExecDriver,
    powershell_argv,
)
from ontrak.models import Session


@dataclass
class _Proc:
    returncode: int = 0
    stdout: str = ""
    stderr: str = ""


class _SyspreppedGuest:
    """A guest whose environment has no COMPUTERNAME, like a real golden image."""

    def __init__(self) -> None:
        self.scripts: list[str] = []

    def exec_in(self, instance, args, timeout=120):  # noqa: ARG002 - mirrors the client
        encoded = args[args.index("-EncodedCommand") + 1]
        script = base64.b64decode(encoded).decode("utf-16-le")
        self.scripts.append(script)
        if "$env:COMPUTERNAME" in script:
            return _Proc(stdout="")  # unset on a sysprepped image
        if "[Environment]::MachineName" in script:
            return _Proc(stdout="DESKTOP-GOLDEN\r\n")
        return _Proc()


def _driver(settings) -> tuple[IncusExecDriver, _SyspreppedGuest]:
    driver = IncusExecDriver(settings)
    guest = _SyspreppedGuest()
    driver.client = guest
    return driver, guest


def _session() -> Session:
    return Session(
        id=None,
        student="alice",
        scenario_id="net-dns-failure",
        instance="ontrak-sess-net-dns-failure-alice",
        host_ip="10.20.0.9",
        rdp_user="student",
        rdp_password="TrainMe!12345",
    )


def test_ready_probe_does_not_depend_on_computername():
    """The probe must not be the variable a golden image leaves unset."""
    assert "COMPUTERNAME" not in READY_PROBE
    assert "[Environment]::MachineName" in READY_PROBE


def test_incus_exec_guest_is_ready_when_computername_is_unset(settings):
    """A live guest with no COMPUTERNAME is ready, not a timeout."""
    driver, guest = _driver(settings)

    assert driver.wait_ready(_session(), timeout=5) is True
    # It got there on the first probe — no five-second sleeps in between.
    assert len(guest.scripts) == 1


def test_incus_exec_guest_without_a_name_is_not_ready(settings):
    """And a genuinely dead guest is still reported as not ready."""
    driver, guest = _driver(settings)
    guest.exec_in = lambda *a, **k: _Proc(stdout="")  # noqa: ARG005 - every call empty

    assert driver.wait_ready(_session(), timeout=0) is False


def test_every_upload_chunk_fits_the_winrs_command_line(settings):
    """A chunk rides in the command line, so its size *is* the command-line size.

    WinRS refuses anything past 8191 characters, and the refusal is opaque:
    HRESULT 0x800700CE, "The filename or extension is too long". At a 32 000-byte
    chunk the first scenario file any Windows guest was asked to accept failed
    there, which killed every Windows template build; the Linux uploader, which
    uses stdin, was untouched. Driving the real `_write_bytes` means this fails if
    the chunk size, the encoding or the argv prefix ever grows past the limit.
    """
    driver, guest = _driver(settings)
    driver._write_bytes(
        b"x" * 20_000,
        r"C:\ProgramData\OnTrak\lib\OnTrak.Common.ps1",
        instance="ontrak-sess-net-dns-failure-alice",
    )

    assert len(guest.scripts) > 1, "a 20 KB file should need more than one chunk"
    for script in guest.scripts:
        command_line = " ".join(powershell_argv(script))
        assert len(command_line) <= WINRS_COMMAND_LINE_LIMIT, (
            f"upload chunk does not fit WinRS: {len(command_line)} characters"
        )


def test_the_declared_chunk_size_is_inside_the_limit():
    """The arithmetic, without trusting a single run to be representative."""
    # Worst realistic call: the longest path we upload to, plus the flags.
    overhead = len(r"Add-Content -Path 'C:\ProgramData\OnTrak\lib\OnTrak.Common.ps1.b64'"
                   r" -Value '' -NoNewline -Encoding Ascii")
    assert (UPLOAD_CHUNK + overhead) * 8 // 3 + 128 <= WINRS_COMMAND_LINE_LIMIT


def test_winrm_probe_uses_the_same_call(settings):
    """Both Windows transports ask the same question, so they cannot drift apart."""
    from ontrak.guest import WinRMDriver

    settings.guest.driver = "winrm"
    driver = WinRMDriver(settings)
    seen: list[str] = []

    def fake(script, host="", instance="", timeout=120):  # noqa: ARG001
        seen.append(script)
        return SimpleNamespace(ok=True, exit_code=0, stdout="DESKTOP-GOLDEN")

    driver.run_powershell = fake  # type: ignore[method-assign]
    assert driver._wait_for_powershell(_session(), timeout=5) is True
    assert seen == [READY_PROBE]
