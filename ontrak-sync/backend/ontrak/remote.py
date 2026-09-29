"""Ontrak Sync — how it reaches other machines.

One place where every command Ontrak Sync runs is built, so the answer to "what
does this thing actually execute?" is one file. Three rules live here, and each
one is a bug that was already paid for somewhere in this Network:

1. **`stdin` is always `/dev/null`.**
   `incus exec <c> -- docker …` *consumes* stdin. A caller that pipes a heredoc
   into a script which then shells out to `incus exec` has that heredoc eaten by
   the inner command — the outer script stops halfway and the symptom is a command
   that "did not run" with no error. Closing stdin on every call makes that
   impossible rather than memorable.

2. **Arguments are never string-concatenated on this side.**
   Every remote invocation is a list, quoted with `shlex.quote` exactly once, at
   the boundary. A package name, a container name or a version string that came
   from a registry is untrusted-ish input, and `apt-get install -y $(whatever)`
   built by `+` is how a monitoring tool becomes a remote code execution tool.

3. **A timeout is not an error.**
   `apt-get update` on a slow mirror and an SSH connection that hangs look
   identical to `subprocess`, and they are opposite facts. So a timeout returns a
   result with `timed_out=True` and the callers treat it as *unknown*, never as
   *nothing to do* — a host that did not answer must not appear up to date.
"""

from __future__ import annotations

import shlex
import subprocess
from dataclasses import dataclass, field

from .config import Host
from .scanners import REBOOT_CLEAR, REBOOT_REQUIRED, REBOOT_UNKNOWN


@dataclass
class Result:
    """The outcome of one remote command."""

    command: str
    returncode: int = 0
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False
    error: str = ""

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out and not self.error

    def lines(self) -> list[str]:
        return [line for line in self.stdout.splitlines() if line.strip()]

    @property
    def message(self) -> str:
        """The most useful single line for an operator, preferring the tool's own."""
        for text in (self.error, self.stderr, self.stdout):
            for line in text.splitlines():
                if line.strip():
                    return line.strip()[:300]
        return f"exit {self.returncode}"


@dataclass
class Probe:
    """A result plus the argv that produced it, for the run log."""

    result: Result
    argv: list[str] = field(default_factory=list)


def _exec(argv: list[str], timeout: int) -> Result:
    shown = " ".join(shlex.quote(a) for a in argv)
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            stdin=subprocess.DEVNULL,  # rule 1
        )
    except subprocess.TimeoutExpired:
        return Result(shown, returncode=-1, timed_out=True,
                      error=f"timed out after {timeout}s")
    except FileNotFoundError as exc:
        return Result(shown, returncode=-1, error=f"{exc.filename}: not found")
    except OSError as exc:
        return Result(shown, returncode=-1, error=str(exc))
    return Result(shown, proc.returncode, proc.stdout, proc.stderr)


def ssh(host: Host, remote_argv: list[str], timeout: int) -> Result:
    """Run one command on `host` over SSH.

    `BatchMode=yes` so a missing key fails immediately instead of blocking on a
    password prompt that nobody can answer; `StrictHostKeyChecking=accept-new`
    because these are LAN addresses the Network re-addresses, and a host key prompt
    would hang the scheduler at 04:00.
    """
    argv = [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", f"ConnectTimeout={min(timeout, 20)}",
        "-p", str(host.ssh_port),
        f"{host.ssh_user}@{host.address}",
        " ".join(shlex.quote(part) for part in remote_argv),  # rule 2, once
    ]
    return _exec(argv, timeout)


def local(argv: list[str], timeout: int) -> Result:
    return _exec(argv, timeout)


def incus(host: Host, args: list[str], timeout: int) -> Result:
    """An `incus …` command on an incus host."""
    return ssh(host, ["incus", *args], timeout)


def incus_exec(host: Host, container: str, command: list[str], timeout: int) -> Result:
    """Run `command` inside one incus container, as root.

    `--` then the command; `incus exec` with no `--` would try to interpret the
    container's argv itself, which silently drops flags it recognises.
    """
    return ssh(host, ["incus", "exec", container, "--", *command], timeout)


def docker_on_host(host: Host, args: list[str], timeout: int) -> Result:
    """A `docker …` command on a host that runs Docker directly."""
    return ssh(host, ["docker", *args], timeout)


def docker_in_container(host: Host, container: str, args: list[str], timeout: int) -> Result:
    """A `docker …` command inside an incus container that runs Docker."""
    return incus_exec(host, container, ["docker", *args], timeout)


# ── the probes every scan needs ──────────────────────────────────────────────
def host_identity(host: Host, timeout: int) -> Result:
    """Hostname, OS and kernel in one round trip."""
    return ssh(host, ["sh", "-c",
                      "printf '%s\\n' \"$(hostname)\" \"$(. /etc/os-release && echo $PRETTY_NAME)\" \"$(uname -r)\""],
               timeout)


def incus_names(host: Host, timeout: int) -> Result:
    """The running instance names on an incus host, one per line.

    `-c n` is the name column and `-f csv` avoids the box-drawing table, which is
    not stable across versions and is not worth parsing.
    """
    return incus(host, ["list", "--format", "csv", "-c", "n", "--project", "default"], timeout)


def reboot_probe(host: Host, timeout: int) -> Result:
    """Whether this host is waiting for a reboot, in one round trip.

    A shell built for the same reason as the others in this file: it is a question,
    it changes nothing, and it is asked on every scan. `printf` rather than `echo`
    because a marker written by an `echo` that a distribution has taught to
    interpret backslashes would arrive as a different string.

    THREE ANSWERS, NOT TWO. A machine that upgraded its kernel and has not rebooted
    is the case this exists for, and it is invisible everywhere else: every manager
    reports it current. But a host whose pending-reboot file this code does not know
    how to read must answer *unknown* rather than "nothing pending" — reporting the
    second when the truth is the first is how a monitor goes green over the one
    machine it could not ask. `/etc/debian_version` is what tells the two apart, and
    it is checked only after the marker, so the marker itself needs no distro test.

    The markers live in `scanners` because that is where they are parsed; this
    module only writes them and `parse_reboot_state` only reads them.
    """
    script = (
        "if [ -e /var/run/reboot-required ]; then "
        f"printf '%s\\n' {REBOOT_REQUIRED}; "
        "cat /var/run/reboot-required.pkgs 2>/dev/null; "
        "elif [ -e /etc/debian_version ]; then "
        f"printf '%s\\n' {REBOOT_CLEAR}; "
        "else "
        f"printf '%s\\n' {REBOOT_UNKNOWN}; "
        "fi"
    )
    return ssh(host, ["sh", "-c", script], timeout)
