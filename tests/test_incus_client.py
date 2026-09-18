"""The real Incus client, driven against a stand-in for the CLI.

`tests.helpers.FakeIncus` implements the same *method names* as the real client, so
it can never catch a command line the CLI does not accept. That is precisely how
this shipped, twice over in one function each:

  * on Incus 7.4 `image info`, `info` and `storage info` have no `--format` flag —
    `Error: unknown flag: --format`, exit 1 — so `image_exists()` answered False for
    every image on the host and `template build` refused every workload, telling the
    operator to run `ontrak image build`, which answers "already an image; nothing
    to build";
  * `incus query` refuses `--project` outright (`Error: --project cannot be used
    with the query command`), because the project belongs in the path — so the same
    mistake in the other direction.

The stand-in reproduces both rules, so these tests assert behaviour rather than
argv, and putting either call back has to fail them. The last test names both
directly, for the reader who arrives here from a failure.
"""

from __future__ import annotations

import stat
from pathlib import Path

import pytest

from ontrak.incus import IncusClient

STUB = r'''#!/usr/bin/env python3
"""A stand-in for `incus`, with the CLI rules that the platform's calls trip over.

  * `--format` belongs to the *list* commands. `image info`, `info` and
    `storage info` answer `Error: unknown flag: --format`, exit 1.
  * `query` is a raw API call and refuses `--project`: the project belongs in the
    path. `Error: --project cannot be used with the query command`.
"""
import json
import os
import sys

KNOWN_ALIASES = {"images:ubuntu/24.04", "images:debian/12", "ontrak-win-base"}
ROOT = {"environment": {"server_version": "7.4", "driver": "incus"}}
POOL = {"name": "default", "driver": "zfs", "status": "Created"}

raw = list(sys.argv[1:])

# Recorded whole, global flags included: the invariants are about what is *asked*.
log = os.environ.get("ONTRAK_INCUS_STUB_LOG")
if log:
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(" ".join(raw) + "\n")

argv = list(raw)
project = None
while argv and argv[0] in {"--project", "--remote"}:
    if argv[0] == "--project":
        project = argv[1]
    argv = argv[2:]


def die(message):
    sys.stderr.write("Error: " + message + "\n")
    raise SystemExit(1)


def asks_for_format(args):
    return any(a == "--format" or a.startswith("--format=") for a in args)


if not argv:
    die("no subcommand")

head, rest = argv[0], argv[1:]

# The raw API: JSON by nature, and no place for a project flag.
if head == "query":
    if project is not None:
        die("--project cannot be used with the query command")
    if asks_for_format(rest):
        die("unknown flag: --format")
    path = rest[0] if rest else ""
    sys.stdout.write(json.dumps(ROOT if path == "/1.0" else {}) + "\n")
    raise SystemExit(0)

if head == "image" and rest[:1] == ["info"]:
    if asks_for_format(rest[1:]):
        die("unknown flag: --format")
    alias = rest[1] if len(rest) > 1 else ""
    if alias in KNOWN_ALIASES:
        sys.stdout.write("Architecture: x86_64\nFingerprint: " + "a" * 64 + "\n")
        raise SystemExit(0)
    die("Failed getting image: The requested image couldn't be found")

if head == "info":
    if asks_for_format(rest):
        die("unknown flag: --format")
    sys.stdout.write("api_extensions: []\napi_version: 1.0\n")
    raise SystemExit(0)

if head == "storage" and rest[:1] == ["info"]:
    if asks_for_format(rest[1:]):
        die("unknown flag: --format")
    sys.stdout.write("driver: zfs\n")
    raise SystemExit(0)

# The list commands: `--format` is real here, and that is where a JSON answer
# about the pools comes from.
if head == "storage" and rest[:1] == ["list"] and asks_for_format(rest):
    sys.stdout.write(json.dumps([POOL]) + "\n")
    raise SystemExit(0)

if asks_for_format(rest):
    sys.stdout.write("[]\n")
    raise SystemExit(0)

sys.stdout.write("")
'''


@pytest.fixture
def stub_bin(tmp_path) -> Path:
    """The stand-in, executable, for the client to run."""
    path = tmp_path / "incus"
    path.write_text(STUB, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


@pytest.fixture
def client(settings, stub_bin) -> IncusClient:
    return IncusClient(settings, binary=str(stub_bin))


# --------------------------------------------------------------------------- #
# an alias that resolves
# --------------------------------------------------------------------------- #
def test_a_serverside_alias_counts_as_present(client):
    """`images:ubuntu/24.04` is not cached on a fresh host, and does not need to be.

    A container workload launches it from the image server — the path the catalog
    planner calls `container-image` — so "not in the local cache" is not the same
    question as "cannot be provisioned".
    """
    assert client.image_exists("images:ubuntu/24.04") is True


def test_the_sites_golden_image_counts_as_present(client):
    assert client.image_exists("ontrak-win-base") is True


def test_an_alias_that_resolves_nowhere_is_absent(client):
    assert client.image_exists("images:nothing/1.0") is False


def test_a_missing_binary_reads_as_absent_rather_than_raising(settings, tmp_path):
    """`ontrak doctor` asks this on hosts that may not have Incus at all."""
    client = IncusClient(settings, binary=str(tmp_path / "no-such-incus"))
    assert client.image_exists("images:ubuntu/24.04") is False


# --------------------------------------------------------------------------- #
# the two calls that had the same wrong flag
# --------------------------------------------------------------------------- #
def test_server_info_reports_the_version(client):
    """This answered `{}` on Incus 7.4, so `doctor` printed "server unknown"."""
    assert client.server_info()["environment"]["server_version"] == "7.4"


def test_storage_info_reports_the_pool_driver(client):
    """The driver decides whether clones are cheap, so an empty answer is a lie."""
    assert client.storage_info("default")["driver"] == "zfs"


def test_storage_info_defaults_to_the_configured_pool(client, settings):
    assert client.storage_info()["name"] == settings.incus.storage_pool


def test_storage_info_says_nothing_about_a_pool_that_is_not_there(client):
    assert client.storage_info("nosuchpool") == {}


# --------------------------------------------------------------------------- #
# the invariants, stated directly
# --------------------------------------------------------------------------- #
def test_the_client_asks_nothing_the_cli_refuses(client, monkeypatch, tmp_path):
    log = tmp_path / "argv.log"
    monkeypatch.setenv("ONTRAK_INCUS_STUB_LOG", str(log))

    client.image_exists("images:ubuntu/24.04")
    client.server_info()
    client.storage_info("default")

    asked = [line for line in log.read_text(encoding="utf-8").splitlines() if line]
    assert asked, "the stand-in recorded no commands"
    for line in asked:
        if line.startswith("query"):
            assert "--project" not in line, f"query refuses a project flag: {line}"
            assert "--format" not in line, f"query has no --format: {line}"
        if line.startswith(("image info", "info ", "storage info")):
            assert "--format" not in line, f"no such flag on this subcommand: {line}"
