"""Talking to the Windows guest.

Three interchangeable drivers:

``winrm``
    Default. Needs WinRM enabled in the image, which the golden-image build
    does. Works on any Windows version and does not care about vsock support.
``incus-exec``
    Uses the Incus Windows agent over virtio-vsock (Incus 6.22+, virtio-win
    0.1.285+, ``Incus-Agent`` service set to Automatic). No network dependency,
    so it also survives scenarios that break the student's NIC.
``null``
    Does nothing and reports empty output. Used for dry runs, catalogue
    validation and CI.

All PowerShell is sent as a UTF-16LE ``-EncodedCommand`` so quoting, newlines and
non-ASCII characters survive every transport. File uploads are chunked base64
over the same channel, so no SMB/SCP path is required.
"""

from __future__ import annotations

import base64
import socket
import time
from dataclasses import dataclass
from pathlib import Path

from .config import Settings
from .models import Session

POWERSHELL = "powershell"
# Windows command lines are capped (cmd.exe 8k, WinRM envelopes larger but not
# unbounded); 32 KB of base64 per call is safely inside every transport.
UPLOAD_CHUNK = 32_000


@dataclass
class CommandResult:
    ok: bool
    exit_code: int
    stdout: str = ""
    stderr: str = ""
    duration: float = 0.0

    def __bool__(self) -> bool:  # convenience: `if result:`
        return self.ok


class GuestError(RuntimeError):
    """Raised for unrecoverable transport problems."""


def encode_ps(script: str) -> str:
    return base64.b64encode(script.encode("utf-16-le")).decode("ascii")


def powershell_argv(script: str) -> list[str]:
    return [
        POWERSHELL,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encode_ps(script),
    ]


def quote_ps(value: str) -> str:
    """Single-quote a value for PowerShell, escaping embedded quotes."""
    return "'" + str(value).replace("'", "''") + "'"


def wait_for_port(host: str, port: int, timeout: int = 300, interval: float = 3.0) -> bool:
    """Poll a TCP port until it accepts connections (or we give up)."""
    if not host:
        return False
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=3):
                return True
        except OSError:
            time.sleep(interval)
    return False


class BaseDriver:
    name = "base"

    def __init__(self, settings: Settings):
        self.settings = settings
        self.guest = settings.guest

    # -- addressing ----------------------------------------------------
    def resolve_host(self, instance: str = "", host: str = "") -> str:
        if host:
            return host
        if self.guest.static_host:
            return self.guest.static_host
        raise GuestError(
            f"{self.name} driver needs a host address for instance {instance!r}; "
            "set guest.static_host or pass the session's host_ip"
        )

    # -- transport primitives -----------------------------------------
    def run_powershell(
        self, script: str, host: str = "", instance: str = "", timeout: int = 120
    ) -> CommandResult:
        raise NotImplementedError

    # -- generic operations (work on every transport) ------------------
    def run_script_file(
        self, remote_path: str, host: str = "", instance: str = "", timeout: int = 300
    ) -> CommandResult:
        """Run a .ps1 already inside the guest, with prefixed error output."""
        script = (
            "$ErrorActionPreference='Continue';"
            f"& {quote_ps(remote_path)} *>&1 | Out-String -Width 4096"
        )
        return self.run_powershell(script, host=host, instance=instance, timeout=timeout)

    def upload_text(
        self, text: str, remote_path: str, host: str = "", instance: str = "", timeout: int = 90
    ) -> CommandResult:
        """Write UTF-8 text to a guest path (used for scenario scripts)."""
        return self._write_bytes(
            text.encode("utf-8"), remote_path, host=host, instance=instance, timeout=timeout
        )

    def upload_file(
        self, local_path: str | Path, remote_path: str, host: str = "", instance: str = "",
        timeout: int = 120,
    ) -> CommandResult:
        return self._write_bytes(
            Path(local_path).read_bytes(), remote_path, host=host, instance=instance, timeout=timeout
        )

    def _write_bytes(
        self,
        data: bytes,
        remote_path: str,
        host: str = "",
        instance: str = "",
        timeout: int = 120,
    ) -> CommandResult:
        """Chunked base64 upload. Retries the final decode once: a single flaky
        call should not fail a provisioning step."""
        b64 = base64.b64encode(data).decode("ascii")
        remote_b64 = remote_path + ".b64"
        parent = remote_path.rsplit("\\", 1)[0] if "\\" in remote_path else "."

        def run(script: str) -> CommandResult:
            return self.run_powershell(script, host=host, instance=instance, timeout=timeout)

        prep = (
            f"New-Item -ItemType Directory -Force -Path {quote_ps(parent)} | Out-Null;"
            f"Set-Content -Path {quote_ps(remote_b64)} -Value '' -NoNewline -Encoding Ascii"
        )
        result = run(prep)
        if not result.ok:
            raise GuestError(f"cannot prepare {parent}: {result.stderr or result.stdout}")

        for offset in range(0, len(b64), UPLOAD_CHUNK):
            chunk = b64[offset : offset + UPLOAD_CHUNK]
            result = run(
                f"Add-Content -Path {quote_ps(remote_b64)} -Value '{chunk}' "
                "-NoNewline -Encoding Ascii"
            )
            if not result.ok:
                raise GuestError(
                    f"upload of {remote_path} failed at offset {offset}: "
                    f"{result.stderr or result.stdout}"
                )

        decode = (
            f"$b=[Convert]::FromBase64String((Get-Content -Raw -Path {quote_ps(remote_b64)}));"
            f"[IO.File]::WriteAllBytes({quote_ps(remote_path)},$b);"
            f"Remove-Item -Path {quote_ps(remote_b64)} -Force;"
            f"'wrote {len(data)} bytes'"
        )
        result = run(decode)
        if not result.ok:
            raise GuestError(f"upload decode failed for {remote_path}: {result.stderr or result.stdout}")
        return result

    # -- readiness -----------------------------------------------------
    def wait_ready(self, session: Session, timeout: int | None = None) -> bool:
        raise NotImplementedError

    def _wait_for_powershell(self, session: Session, timeout: int | None = None) -> bool:
        deadline = time.time() + (timeout or self.guest.boot_timeout_seconds)
        while time.time() < deadline:
            result = self.run_powershell("$env:COMPUTERNAME", host=session.host_ip,
                                        instance=session.instance, timeout=30)
            if result.ok and result.stdout.strip():
                return True
            time.sleep(5)
        return False


class WinRMDriver(BaseDriver):
    name = "winrm"

    def _session(self, host: str):
        try:
            import winrm  # noqa: PLC0415 - optional dependency, imported lazily
        except ImportError as exc:  # pragma: no cover - dependency path
            raise GuestError(
                "pywinrm is not installed; `pip install pywinrm` or set guest.driver"
            ) from exc
        scheme = "https" if self.guest.winrm_use_ssl else "http"
        return winrm.Session(
            f"{scheme}://{host}:{self.guest.winrm_port}/wsman",
            auth=(self.guest.user, self.guest.password),
            transport=self.guest.winrm_transport,
            server_cert_validation="ignore",
        )

    def run_powershell(
        self, script: str, host: str = "", instance: str = "", timeout: int = 120
    ) -> CommandResult:
        target = self.resolve_host(instance, host)
        started = time.time()
        try:
            result = self._session(target).run_cmd(POWERSHELL, powershell_argv(script)[1:])
        except Exception as exc:  # winrm raises a wide variety of transport errors
            return CommandResult(False, 1, "", str(exc), time.time() - started)
        return CommandResult(
            ok=result.status_code == 0,
            exit_code=result.status_code,
            stdout=result.std_out.decode("utf-8", "replace"),
            stderr=result.std_err.decode("utf-8", "replace"),
            duration=time.time() - started,
        )

    def wait_ready(self, session: Session, timeout: int | None = None) -> bool:
        host = self.resolve_host(session.instance, session.host_ip)
        if not wait_for_port(host, self.guest.rdp_port, timeout or self.guest.boot_timeout_seconds):
            return False
        return self._wait_for_powershell(session, timeout or self.guest.ready_timeout_seconds)


class IncusExecDriver(BaseDriver):
    """Runs commands through the Incus Windows agent (virtio-vsock)."""

    name = "incus-exec"

    def __init__(self, settings: Settings):
        super().__init__(settings)
        from .incus import IncusClient  # local import: avoids an import cycle

        self.client = IncusClient(settings)

    def _exec(self, instance: str, args: list[str], timeout: int) -> CommandResult:
        started = time.time()
        try:
            proc = self.client.exec_in(instance, args, timeout=timeout)
        except Exception as exc:
            return CommandResult(False, 1, "", str(exc), time.time() - started)
        return CommandResult(
            ok=proc.returncode == 0,
            exit_code=proc.returncode,
            stdout=proc.stdout or "",
            stderr=proc.stderr or "",
            duration=time.time() - started,
        )

    def run_powershell(
        self, script: str, host: str = "", instance: str = "", timeout: int = 120
    ) -> CommandResult:
        if not instance:
            raise GuestError("incus-exec driver requires an instance name")
        return self._exec(instance, powershell_argv(script), timeout)

    def wait_ready(self, session: Session, timeout: int | None = None) -> bool:
        if not session.instance:
            return False
        deadline = time.time() + (timeout or self.guest.boot_timeout_seconds)
        while time.time() < deadline:
            result = self.run_powershell("$env:COMPUTERNAME", instance=session.instance, timeout=30)
            if result.ok and result.stdout.strip():
                return True
            time.sleep(5)
        return False


class NullDriver(BaseDriver):
    """No-op driver: everything succeeds with canned/empty output.

    Lets you validate the catalogue, exercise the portal and run the test suite
    without any Windows infrastructure. ``responses`` maps a substring of the
    script to output, which is how tests simulate a passing or failing guest.
    """

    name = "null"

    def __init__(self, settings: Settings, responses: dict[str, str] | None = None):
        super().__init__(settings)
        self.responses = responses or {}
        self.calls: list[tuple[str, str]] = []

    def run_powershell(
        self, script: str, host: str = "", instance: str = "", timeout: int = 120
    ) -> CommandResult:
        self.calls.append((instance, script[:200]))
        for needle, response in self.responses.items():
            if needle in script:
                return CommandResult(True, 0, response)
        return CommandResult(True, 0, "")

    def wait_ready(self, session: Session, timeout: int | None = None) -> bool:
        return True

    def _write_bytes(self, data: bytes, remote_path: str, host: str = "", instance: str = "",
                     timeout: int = 120) -> CommandResult:
        self.calls.append((instance, f"upload:{remote_path}:{len(data)}B"))
        return CommandResult(True, 0, "wrote bytes")


def build_driver(settings: Settings, responses: dict[str, str] | None = None) -> BaseDriver:
    driver = (settings.guest.driver or "winrm").strip().lower()
    if driver == "winrm":
        return WinRMDriver(settings)
    if driver in {"incus-exec", "incus", "agent"}:
        return IncusExecDriver(settings)
    if driver in {"null", "none", "dry-run"}:
        return NullDriver(settings, responses)
    raise GuestError(f"unknown guest.driver {settings.guest.driver!r} (winrm | incus-exec | null)")


__all__ = [
    "BaseDriver",
    "CommandResult",
    "GuestError",
    "IncusExecDriver",
    "NullDriver",
    "WinRMDriver",
    "build_driver",
    "encode_ps",
    "powershell_argv",
    "quote_ps",
    "wait_for_port",
]
