"""The real Incus client, driven against a stand-in for the CLI.

`tests.helpers.FakeIncus` implements the same *method names* as the real client, so
it can never catch a command line the CLI does not accept. That is precisely how
this shipped: on Incus 7.4 `image info`, `info` and `storage info` have no
`--format` flag, and the client asked for it anyway. `Error: unknown flag:
--format`, exit 1, read as "this image does not exist" — so `image_exists()`
answered False for every image on the host and `template build` refused every
workload, telling the operator to run `ontrak image build` which answers "already
an image; nothing to build". Two commands, each pointing at the other.

The stand-in reproduces the flag surface that matters: `--format` belongs to the
*list* commands, and the three above reject it the way the real CLI does. So these
tests assert behaviour rather than argv, and putting the flag back has to fail
them.
"""

from __future__ import annotations

import stat
from pathlib import Path

import pytest

from ontrak.incus import IncusClient

STUB = r'''#!/usr/bin/env python3
"""A stand-in for `incus`, with the flag surface of 7.4 for the calls we make.

`--format` is a flag of the list commands. `image info`, `info` and `storage info`
do not take it, and the real CLI answers `Error: unknown flag: --format`, exit 1.
Asking for it here is how a client that gets it wrong fails on a host.
"""
import json
import os
import sys

KNOWN_ALIASES = {"images:ubuntu/24.04", "images:debian/12", "ontrak-win-base"}
ROOT = {"environment": {"server_version": "7.4", "driver": "incus"}}
POOL = {"name": "default", "driver": "zfs"}

argv = list(sys.argv[1:])
while argv and argv[0] in {"--project", "--remote"}:
    argv = argv[2:]

# Recorded only when asked for, so the CLI shim stays a plain command otherwise.
log = os.environ.get("ONTRAK_INCUS_STUB_LOG")
if log:
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(" ".join(argv) + "\n")


def die(message):
    sys.stderr.write("Error: " + message + "\n")
    raise SystemExit(1)


def asks_for_format(args):
    return any(a == "--format" or a.startswith("--format=") for a in args)


if not argv:
    die("no subcommand")

head, rest = argv[0], argv[1:]

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

# The raw API answers in JSON by nature, so there is no flag to get wrong.
if head == "query" and rest:
    path = rest[0]
    if path == "/1.0":
        sys.stdout.write(json.dumps(ROOT) + "\n")
        raise SystemExit(0)
    if path.startswith("/1.0/storage-pools/"):
        sys.stdout.write(json.dumps(POOL) + "\n")
        raise SystemExit(0)
    sys.stdout.write("{}\n")
    raise SystemExit(0)

# Everything else the platform runs is a list command, where --format is real.
if asks_for_format(rest) or head in {"list", "image", "storage", "network", "profile", "snapshot"}:
    sys.stdout.write("[]\n")
    raise SystemExit(0)

sys.stdout.write("")
'''


@pytest.fixture
def stub_bin(tmp_path) -> Path:
    """The stand-in, on PATH for the client to run."""
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


# --------------------------------------------------------------------------- #
# the invariant, stated directly
# --------------------------------------------------------------------------- #
def test_the_client_never_asks_for_a_format_those_subcommands_lack(client, monkeypatch, tmp_path):
    log = tmp_path / "argv.log"
    monkeypatch.setenv("ONTRAK_INCUS_STUB_LOG", str(log))

    client.image_exists("images:ubuntu/24.04")
    client.server_info()
    client.storage_info("default")

    asked = [line for line in log.read_text(encoding="utf-8").splitlines() if line]
    assert asked, "the stand-in recorded no commands"
    for line in asked:
        assert "--format" not in line, f"asked for a flag that does not exist: {line}"
