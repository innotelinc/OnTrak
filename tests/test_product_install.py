"""`infra/windows/apply-product-install.py`, driven to its own contract.

The tool is what turns a base Windows guest into a product image: it ships the
media and the install script in, runs the script, and — the part that is easy to
get wrong and expensive to discover on a lab host — restarts the guest and runs
the script again every time the script says the product needs a reboot, until the
script says the product is installed. That loop is what these tests drive, with a
guest driver that answers like a product script whose install spans reboots.

What is deliberately *not* here: anything about the products themselves. The
scripts under `infra/windows/products/` install Exchange, SQL Server, SharePoint
and Microsoft 365 Apps and need a real guest with licensed media. What can be
pinned without one is the dance around them: the markers, the restarts, the fresh
address after one, and the descriptor that must not survive into a published
image.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from ontrak.catalog import Catalog
from ontrak.guest import CommandResult

REPO_ROOT = Path(__file__).resolve().parent.parent
TOOL = REPO_ROOT / "infra" / "windows" / "apply-product-install.py"

# The contract `infra/windows/products/lib.ps1` speaks: these two strings are the
# whole protocol between the guest and this tool.
OK_MARKER = "ONTRAK-PRODUCT-OK"
REBOOT_MARKER = "ONTRAK-PRODUCT-REBOOT"

OK = f"[product] {OK_MARKER}\n[product] sql-server 2022 installed and listening"
REBOOT = f"[product] a reboot is required: the promotion finishes\n{REBOOT_MARKER}\n"


def _load_tool():
    """The tool as a module — it is a script with a dash in its name, so it is
    loaded by path rather than imported. ``main(argv)`` is the whole interface."""
    spec = importlib.util.spec_from_file_location("apply_product_install", TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ScriptRun:
    """One answer from the guest: the product script's output and exit code."""

    def __init__(self, output: str = "", exit_code: int = 0):
        self.output = output
        self.exit_code = exit_code


class FakeDriver:
    """The guest transport, answering like a product script mid-install.

    It records every call, because the loop under test is all about *which*
    calls follow a restart: a stale address, a missing re-run, or a re-upload
    that never happens are the bugs this double exists to catch.
    """

    name = "fake"

    def __init__(self, runs):
        self.runs = list(runs)
        self.calls: list[tuple] = []
        self.descriptor_text = ""

    def wait_ready(self, session, timeout=None) -> bool:
        self.calls.append(("wait_ready", session.host_ip))
        return True

    def upload_file(self, local_path, remote_path, host="", instance="", timeout=120):
        self.calls.append(("upload_file", remote_path, host))
        return CommandResult(ok=True, exit_code=0)

    def upload_text(self, text, remote_path, host="", instance="", timeout=90):
        self.calls.append(("upload_text", remote_path, host))
        self.descriptor_text = text
        return CommandResult(ok=True, exit_code=0)

    def run_script_file(self, remote_path, host="", instance="", timeout=300):
        self.calls.append(("run_script_file", remote_path, host))
        if not self.runs:
            raise AssertionError("the tool ran the product script again, with no answer left for it")
        run = self.runs.pop(0)
        return CommandResult(ok=run.exit_code == 0, exit_code=run.exit_code, stdout=run.output)

    def run_powershell(self, script, host="", instance="", timeout=120):
        self.calls.append(("run_powershell", script, host))
        return CommandResult(ok=True, exit_code=0, stdout="cleaned")

    def of(self, kind: str) -> list[tuple]:
        return [call for call in self.calls if call[0] == kind]


class FakeIncus:
    """The hypervisor half: enough for a restart to be observable.

    ``instance_ip`` hands out the fresh address a restarted guest comes back
    with, so a tool that kept using the old one is caught by the host recorded
    against the next run.
    """

    def __init__(self):
        self.stopped: list[str] = []
        self.started: list[str] = []
        self.devices: list[tuple] = []
        self.addresses_served = 0

    def instance_ip(self, name):
        # A fresh address on every ask, one restart at a time: the tool polls
        # until the guest has one, and a double that ran out of answers would
        # leave it polling a real sixty times against a fake.
        self.addresses_served += 1
        return f"10.20.0.{40 + self.addresses_served}"

    def add_device(self, instance, kind, name, **options):
        self.devices.append((instance, kind, name, options))

    def stop_instance(self, name, force=False, timeout=120):
        self.stopped.append((name, force))

    def start_instance(self, name, wait=False, timeout=None):
        self.started.append(name)


class FakeMediaStore:
    """The media store, holding exactly one file the tests place there."""

    def __init__(self, path: Path):
        self.path = path

    def find(self, entry):
        return self.path if self.path.exists() else None


class Harness:
    def __init__(self, settings, entry_id, driver, media):
        self.settings = settings
        self.entry_id = entry_id
        self.driver = driver
        self.media = media
        self.incus = FakeIncus()
        self.module = None

    def run(self, *extra, instance="build-product"):
        return self.module.main(
            ["apply-product-install.py", instance, "--entry", self.entry_id, "--address", "10.20.0.7", *extra]
        )


def _start(settings, tmp_path, *runs, entry_id="sql-server-2022"):
    """Wire one run of the tool against the doubles above."""
    entry = Catalog(settings.catalog_dir).get(entry_id)
    media = tmp_path / "media" / entry.media.filename
    media.parent.mkdir(parents=True, exist_ok=True)
    media.write_bytes(b"licensed product media")

    harness = Harness(settings, entry_id, FakeDriver(runs), media)
    module = _load_tool()
    harness.module = module

    def incus_factory(_settings):
        return harness.incus

    incus_factory.available = lambda binary="incus": True
    module.load_settings = lambda: settings
    module.build_driver = lambda settings: harness.driver
    module.IncusClient = incus_factory
    module.MediaStore = lambda root, catalog: FakeMediaStore(media)
    return harness


def test_a_restart_is_followed_by_a_second_pass_on_the_new_address(settings, tmp_path):
    """The point of the whole tool: a product that asks for a reboot gets one,
    and the install resumes afterwards — on the address the guest comes back
    with, since a restarted machine is not obliged to keep its old one."""
    harness = _start(settings, tmp_path, ScriptRun(REBOOT), ScriptRun(OK))
    assert harness.run() == 0

    runs = harness.driver.of("run_script_file")
    assert [call[2] for call in runs] == ["10.20.0.7", "10.20.0.41"], "the re-run used a stale address"
    assert harness.incus.stopped == [("build-product", True)], "the guest was never restarted"
    assert harness.incus.started == ["build-product"]
    # Readiness is asked again after the restart: a transport that answered
    # before the reboot says nothing about the machine that came back.
    assert len(harness.driver.of("wait_ready")) == 2
    assert harness.driver.runs == [], "the script's answers were not all used"


def test_several_restarts_are_all_followed(settings, tmp_path):
    """Microsoft's sequences reboot more than once — the forest promotion, a
    prerequisite, the post-setup restart — so the loop is a loop, not a single
    special case."""
    harness = _start(
        settings, tmp_path, ScriptRun(REBOOT), ScriptRun(REBOOT), ScriptRun(REBOOT), ScriptRun(OK)
    )
    assert harness.run() == 0
    assert len(harness.driver.of("run_script_file")) == 4
    assert len(harness.incus.stopped) == 3


def test_a_pass_without_the_ok_marker_is_a_script_bug_not_a_slow_install(settings, tmp_path, capsys):
    """Every product script ends with the marker; a pass that ends without one is
    a broken script, and saying so beats a build that reports success because
    nothing failed loudly."""
    harness = _start(settings, tmp_path, ScriptRun("all done, nothing to see"))
    assert harness.run() == 1
    assert "bug in the script" in capsys.readouterr().err


def test_a_failed_install_reports_the_exit_code_and_stops(settings, tmp_path, capsys):
    """A product that fails is a failed build: the exit code is the product's
    own, and nothing after it runs."""
    harness = _start(settings, tmp_path, ScriptRun("setup exploded", exit_code=3))
    assert harness.run() == 1
    assert "exit 3" in capsys.readouterr().err
    assert harness.driver.runs == []
    # The descriptor is left alone on purpose: the guest it is on is a failed
    # build's crime scene, and the message says how to read it and delete it.


def test_a_restart_on_the_last_pass_is_refused_rather_than_looped(settings, tmp_path, capsys):
    """A product that reboots forever would occupy a build host forever. The
    pass budget is the fence, and hitting it is an error naming the knob."""
    harness = _start(settings, tmp_path, ScriptRun(REBOOT), ScriptRun(REBOOT))
    assert harness.run("--attempts", "2") == 1
    assert "--attempts" in capsys.readouterr().err
    assert len(harness.driver.of("run_script_file")) == 2


def test_the_descriptor_and_the_state_file_do_not_survive_into_the_image(settings, tmp_path):
    """The descriptor carries the lab passwords the product's accounts are
    created with and the state file is this build's step list — a published
    image must carry neither. They go once the product is installed."""
    harness = _start(settings, tmp_path, ScriptRun(OK))
    assert harness.run() == 0

    descriptor = json.loads(harness.driver.descriptor_text)
    assert descriptor["entry"] == "sql-server-2022"
    assert descriptor["product"] == "sql-server"
    assert descriptor["password"], "the guest scripts read their credentials from here"
    cleanup = " ".join(call[1] for call in harness.driver.of("run_powershell"))
    assert "product.json" in cleanup, "the descriptor survives into the published image"
    assert "product-state.txt" in cleanup, "this build's step list survives into the image"


def test_an_iso_is_attached_as_media_and_an_archive_is_uploaded(settings, tmp_path):
    """Two media shapes, two deliveries: an ISO becomes a CD-ROM drive (a 5 GiB
    upload would take hours), and an archive — the Deployment Tool — is pushed
    into the guest because there is no drive to attach it as."""
    iso = _start(settings, tmp_path, ScriptRun(OK))
    assert iso.run() == 0
    assert [device[:3] for device in iso.incus.devices] == [("build-product", "disk", "productmedia")]
    assert not [call for call in iso.driver.of("upload_file") if call[1].endswith(".iso")]

    archive = _start(settings, tmp_path, ScriptRun(OK), entry_id="m365-apps-on-win11")
    assert archive.run() == 0
    assert archive.incus.devices == []
    assert any(call[1].endswith("m365-apps-c2r.zip") for call in archive.driver.of("upload_file"))


def test_the_descriptor_names_a_media_folder_only_for_media_that_is_unpacked(settings):
    """An ISO is a CD-ROM drive the guest script goes looking for; an archive is a
    folder it unpacks. Naming a folder for an ISO is not merely useless: the guest
    library searches the attached drives *only* when it is given no folder, so the
    folder an ISO build never creates made every ISO product stop with "the media
    the builder placed at ... is not there" before it had looked at its media.

    The products that pass `$config.media_folder` to `Get-MediaFolder` (SQL Server,
    Exchange, SharePoint) and the one that uses it as an unpack destination
    (Microsoft 365 Apps) both read this field, so the branch has to be here."""
    module = _load_tool()
    catalog = Catalog(settings.catalog_dir)

    iso = module.descriptor(catalog.get("sql-server-2022"), settings)
    assert iso["media_kind"] == "iso"
    assert iso["media_folder"] == "", "an ISO build has a drive, not a folder"
    assert iso["media_archive"] == ""

    archive = module.descriptor(catalog.get("m365-apps-on-win11"), settings)
    assert archive["media_kind"] == "archive"
    assert archive["media_folder"].endswith("m365-apps-on-win11")
    assert archive["media_archive"].endswith("m365-apps-c2r.zip")


def test_an_entry_that_is_not_a_product_is_refused(settings, tmp_path):
    """`ontrak image build` handles the OS recipes; a product entry is this
    tool's whole subject, and anything else is a mistake worth naming."""
    harness = _start(settings, tmp_path, entry_id="win2022")
    assert harness.run() == 2
    assert harness.driver.calls == [], "a refused entry never reaches the guest"
