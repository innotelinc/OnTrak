"""The catalog is a manifest library, so the tests are mostly about honesty:
does validation catch a bad manifest, and does the planner pick the fastest path
that the host can actually deliver?"""

from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
import yaml

from ontrak.catalog import DEVICE_PROFILES, Catalog, CatalogError

REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture()
def catalog(settings) -> Catalog:
    return Catalog(settings.catalog_dir)


# --------------------------------------------------------------------------- #
# the shipped catalog
# --------------------------------------------------------------------------- #


def test_shipped_catalog_is_valid(catalog):
    assert catalog.validate() == []


def test_catalog_covers_the_whole_range(catalog):
    entries = catalog.list()
    ids = {e.id for e in entries}
    # Windows 95 through present, desktop and server.
    for expected in ("win95-osr2", "win98se", "win-me", "win-xp-sp3", "win7-sp1", "win11-24h2"):
        assert expected in ids
    for expected in ("win2003-r2", "win2008-r2", "win2019", "win2025"):
        assert expected in ids
    # The Office suite, each layered onto a Windows base.
    for expected in ("office97-on-win95", "office2003-on-xp", "office2016-on-win10", "m365-apps-on-win11"):
        assert expected in ids
    # Linux, containers and VMs.
    assert {"ubuntu-24.04", "debian-12", "alpine-3.21", "ubuntu-desktop-24.04"} <= ids


def test_office_entries_name_the_os_they_are_layered_onto(catalog):
    for entry in catalog.list(family="microsoft-office"):
        assert entry.requires, f"{entry.id} must require a Windows base"
        for required in entry.requires:
            assert catalog.get(required).family in {"windows", "linux"}


def test_legacy_platforms_use_a_legacy_device_profile(catalog):
    assert catalog.get("win95-osr2").device_profile == "legacy-9x"
    assert catalog.get("win-xp-sp3").device_profile == "legacy-xp"
    assert catalog.get("win11-24h2").device_profile == "modern"
    # DOS-era hardware predates VirtIO entirely; the profile has to say so.
    config = catalog.get("win98se").resolved_config()
    assert "raw.qemu" in config
    assert catalog.get("win98se").resolved_devices()["eth0"]["options"]["nictype"] == "rtl8139"


def test_licensed_media_is_never_marked_free(catalog):
    for entry in catalog.list(family="microsoft-office"):
        assert entry.media.source == "operator", f"{entry.id} must not be redistributable"


def test_filters(catalog):
    containers = catalog.list(kind="container")
    assert containers and all(e.kind == "container" for e in containers)
    legacy = catalog.list(group="windows-desktop", kind="vm")
    assert any(e.media.source == "operator" for e in legacy)
    assert catalog.list(id="win10").pop().id == "win10-22h2"


# --------------------------------------------------------------------------- #
# plans
# --------------------------------------------------------------------------- #


def test_container_workloads_plan_a_launch(catalog):
    plan = catalog.plan("ubuntu-24.04")
    assert plan.strategy == "container-image"
    assert plan.ready and not plan.needs_operator
    assert plan.estimate_seconds < 30


def test_iso_workloads_need_an_image_before_they_are_fast(catalog):
    cold = catalog.plan("win11-24h2", media_ready=False, image_ready=False)
    assert cold.strategy == "build-image"
    assert cold.needs_operator
    assert any("media store" in blocker for blocker in cold.blockers)

    warm = catalog.plan("win11-24h2", media_ready=True, image_ready=True)
    assert warm.strategy == "image-launch"
    assert warm.ready and not warm.needs_operator

    # Media but no image: still an operator task, and the plan says which one.
    media_only = catalog.plan("win11-24h2", media_ready=True, image_ready=False)
    assert media_only.strategy == "build-image"
    assert any("ontrak image build win11-24h2" in step for step in media_only.steps)


def test_manual_platforms_report_themselves_unplannable(catalog):
    plan = catalog.plan("win95-osr2")
    assert plan.strategy == "unsupported"
    assert plan.ready is False
    assert plan.blockers


def test_image_based_workloads_launch_without_media(catalog):
    plan = catalog.plan("ubuntu-desktop-24.04")
    assert plan.strategy == "image-launch"
    assert plan.ready


def test_plans_are_ordered_fastest_first(catalog):
    plans = [
        catalog.plan("win11-24h2", media_ready=False, image_ready=False),
        catalog.plan("ubuntu-24.04"),
        catalog.plan("win95-osr2"),
    ]
    ordered = catalog.merge_order(plans)
    assert ordered[0].strategy == "container-image"
    assert ordered[-1].strategy == "unsupported"


# --------------------------------------------------------------------------- #
# validation of hand-written manifests
# --------------------------------------------------------------------------- #


def _write(tmp_path, name: str, body: str) -> Catalog:
    (tmp_path / name).write_text(textwrap.dedent(body))
    return Catalog(tmp_path)


def _write_alone(tmp_path, name: str, body: str) -> Catalog:
    """A second catalog for the same test: its own directory, so the group isn't twice."""
    root = tmp_path / Path(name).stem
    root.mkdir()
    (root / name).write_text(textwrap.dedent(body))
    return Catalog(root)


BASE = """
group: test
label: Test
entries:
  - id: ok-entry
    name: Fine
    media: {source: free, kind: image, filename: 'images:ubuntu/24.04'}
    install: {recipe: container-image, alias: 'images:ubuntu/24.04'}
    kind: container
    family: linux
    device_profile: linux-container
    automation: ssh
    notes: fine
"""


def test_valid_minimal_catalog(tmp_path):
    catalog = _write(tmp_path, "test.yaml", BASE)
    assert catalog.validate() == []


@pytest.mark.parametrize(
    ("old", "new", "expected"),
    [
        # A DOS-era platform cannot be a container (it needs its own kernel).
        ("device_profile: linux-container", "device_profile: legacy-9x", "DOS-era profiles are VM-only"),
        # Unknown automation level would silently change how a guest is driven.
        ("automation: ssh", "automation: telepathy", "unknown automation level"),
        # Free media must say where it comes from.
        (
            "media: {source: free, kind: image, filename: 'images:ubuntu/24.04'}",
            "media: {source: free, kind: iso, filename: 'x.iso'}",
            "free media must have a url",
        ),
        # A container recipe must name the image alias to launch.
        (
            "install: {recipe: container-image, alias: 'images:ubuntu/24.04'}",
            "install: {recipe: image-alias}",
            "install.alias",
        ),
        # Operator media has to name a file, or the media store cannot find it.
        (
            "media: {source: free, kind: image, filename: 'images:ubuntu/24.04'}",
            "media: {source: operator, kind: iso}",
            "operator-supplied media must name a filename",
        ),
        # A container cannot be driven over WinRM: there is no Windows in it.
        ("automation: ssh", "automation: winrm-ps51", "cannot be driven by winrm-ps51"),
    ],
)
def test_validation_catches_broken_manifests(tmp_path, old, new, expected):
    assert old in BASE, f"test case out of date: {old!r} is no longer in the fixture"
    catalog = _write(tmp_path, "test.yaml", BASE.replace(old, new))
    problems = " ".join(catalog.validate())
    assert expected in problems, problems


def test_validation_catches_unknown_device_profile(tmp_path):
    catalog = _write(tmp_path, "test.yaml", BASE.replace("linux-container", "vibes"))
    assert any("unknown device_profile" in problem for problem in catalog.validate())


def test_validation_catches_a_missing_base_product(tmp_path):
    body = BASE + """  - id: office-on-nothing
    name: Office without an OS
    kind: vm
    family: microsoft-office
    requires: [does-not-exist]
    device_profile: vista-era
    automation: none
    media: {source: operator, kind: iso, filename: office.iso}
    install: {recipe: manual, builder: manual}
    notes: layered onto nothing
"""
    catalog = _write(tmp_path, "test.yaml", body)
    problems = " ".join(catalog.validate())
    assert "requires 'does-not-exist'" in problems


def test_duplicate_ids_across_files_are_rejected(tmp_path):
    _write(tmp_path, "a.yaml", BASE)
    _write(tmp_path, "b.yaml", BASE.replace("group: test", "group: other"))
    with pytest.raises(CatalogError, match="duplicate catalog entry id"):
        Catalog(tmp_path).load()


def test_defaults_are_inherited_and_overridable(tmp_path):
    body = """
    group: test
    label: Test
    defaults:
      kind: container
      family: linux
      automation: ssh
      device_profile: linux-container
      media: {source: free, kind: image}
      install: {recipe: container-image}
    entries:
      - id: inherited
        name: Inherits everything
        install: {alias: 'images:debian/12'}
        media: {filename: 'images:debian/12'}
      - id: overridden
        name: Overrides the profile
        kind: vm
        device_profile: linux-vm
        automation: ssh
        install: {recipe: image-alias, alias: 'images:debian/12/cloud'}
        media: {kind: image, filename: 'images:debian/12/cloud'}
    """
    catalog = _write(tmp_path, "test.yaml", body)
    assert catalog.validate() == []
    assert catalog.get("inherited").kind == "container"
    assert catalog.get("inherited").recipe == "container-image"
    assert catalog.get("overridden").kind == "vm"
    assert catalog.get("overridden").device_profile == "linux-vm"


def test_unknown_entry_raises_with_a_hint(catalog):
    with pytest.raises(CatalogError, match="ontrak catalog list"):
        catalog.get("windows-3000")


def test_import_images_writes_a_loadable_group(catalog, tmp_path):
    catalog.root = tmp_path
    images = [
        {
            "aliases": [{"name": "ubuntu/24.04"}],
            "properties": {"os": "ubuntu", "release": "24.04", "variant": "default", "description": "Ubuntu 24.04"},
        },
        {
            "aliases": [{"name": "debian/12"}],
            "properties": {"os": "debian", "release": "12", "description": "Debian 12"},
        },
    ]
    target = catalog.import_images(images)
    assert target.exists()
    loaded = yaml.safe_load(target.read_text())
    assert loaded["group"] == "linux-images"
    assert [e["id"] for e in loaded["entries"]] == ["debian-12", "ubuntu-24-04"]
    # ``kind: container`` and the rest come from the group's defaults block.
    assert loaded["defaults"]["kind"] == "container"
    assert loaded["entries"][0]["install"]["alias"] == "debian/12"
    # The generated file must be a catalog like any other: this is the round trip that
    # catches mis-indented YAML that looks fine in a editor.
    reloaded = Catalog(tmp_path)
    assert reloaded.validate() == []
    assert reloaded.list(group="linux-images")[1].name == "Ubuntu 24.04 default"


def test_every_referenced_device_profile_exists(catalog):
    for entry in catalog.list():
        assert entry.device_profile in DEVICE_PROFILES


# --------------------------------------------------------------------------- #
# product entries: one OS, one product, installed inside the guest
# --------------------------------------------------------------------------- #

PRODUCTS = """
group: products
label: Products
defaults:
  kind: vm
  family: microsoft-server
  device_profile: modern
  automation: agent
  resources: {cpu: 2, memory: 4GiB, disk: 60GiB}
entries:
  - id: base-os
    name: Base OS
    media: {source: operator, kind: iso, filename: base.iso}
    install: {recipe: iso-unattended, builder: incus-windows}
    notes: the OS a product is layered onto
  - id: a-product
    name: A product
    requires: [base-os]
    media: {source: operator, kind: iso, filename: product.iso}
    install: {recipe: product-on-base, builder: product, script: infra/windows/products/sql-server.ps1}
    notes: a product on the base above
"""


def test_the_shipped_catalog_carries_the_server_products(catalog):
    """Exchange, SQL Server and SharePoint, each named on the OS it is layered onto.

    The catalog shape could always describe these — a product entry names its base — and
    what it lacked was a recipe, so every one of them was a weekend of clicking. What
    this pins is that the entries exist, that they are layered (never standalone) and
    that each names a script the checkout actually has.
    """
    layered = {
        "exchange-server-2019": "win2019",
        "exchange-server-se": "win2022",
        "sql-server-2019": "win2019",
        "sql-server-2022": "win2022",
        "sharepoint-server-se": "sql-server-2022",
    }
    for entry_id, base in layered.items():
        entry = catalog.get(entry_id)
        assert entry.layered_on == base, f"{entry_id} is layered onto the wrong thing"
        assert entry.recipe == "product-on-base"
        assert entry.media.source == "operator", f"{entry_id} must not be redistributable"
        assert catalog.product_script_path(entry) is not None, f"{entry_id} names no real script"

    # A farm needs its database server, so SharePoint is layered onto the SQL entry and
    # that onto Windows Server: the chain is the build order.
    assert catalog.get("sql-server-2022").layered_on == "win2022"
    # Microsoft 365 Apps is the one Office entry with a recipe rather than a readme.
    m365 = catalog.get("m365-apps-on-win11")
    assert m365.recipe == "product-on-base"
    assert catalog.product_script_path(m365) is not None


def test_a_product_script_has_to_be_in_this_checkout(tmp_path):
    """The catalog names the script, so it is the catalog's job to notice a rename."""
    missing = _write(tmp_path, "products.yaml", PRODUCTS)
    problems = " ".join(missing.validate())
    assert "infra/windows/products/sql-server.ps1" in problems
    assert "not in this checkout" in problems

    escaped = _write_alone(
        tmp_path,
        "elsewhere.yaml",
        PRODUCTS.replace("infra/windows/products/sql-server.ps1", "/etc/passwd"),
    )
    assert "must be a path inside the checkout" in " ".join(escaped.validate())


def test_a_product_needs_a_base_something_can_drive(tmp_path):
    """The install happens inside the guest, so a base nothing can reach is a dead end."""
    undrivable = _write(
        tmp_path,
        "products.yaml",
        PRODUCTS.replace("automation: agent", "automation: none"),
    )
    assert "whose automation is 'none'" in " ".join(undrivable.validate())

    without = _write_alone(tmp_path, "bare.yaml", PRODUCTS.replace("    requires: [base-os]\n", ""))
    assert "must name the OS it is layered onto" in " ".join(without.validate())


def test_a_product_recipe_is_the_one_a_product_entry_uses(tmp_path):
    """A product is built onto its base or by hand; an OS recipe makes no sense for it."""
    wrong = _write(
        tmp_path,
        "products.yaml",
        PRODUCTS.replace("recipe: product-on-base", "recipe: iso-unattended"),
    )
    assert "either product-on-base" in " ".join(wrong.validate())


def test_a_product_image_plans_the_base_before_itself(catalog):
    plan = catalog.plan("exchange-server-se", media_ready=False, image_ready=False)
    assert plan.strategy == "build-image" and plan.needs_operator
    steps = " ".join(plan.steps)
    assert "ontrak image build win2022" in steps, "the base image is not built first"
    assert "infra/windows/products/exchange-server.ps1" in steps
    assert any("media store" in blocker for blocker in plan.blockers)
    assert any("rebuilt base" in note for note in plan.notes), plan.notes

    warm = catalog.plan("exchange-server-se", media_ready=True, image_ready=True)
    assert warm.strategy == "image-launch" and warm.ready


@pytest.mark.parametrize(
    ("entry_id", "expected"),
    [
        ("win11-24h2", "incus-windows"),
        ("win2003-r2", "answer-file"),
        ("office2016-on-win10", "manual"),
        ("sql-server-2022", "product"),
    ],
)
def test_the_image_builder_can_dispatch_every_recipe(entry_id, expected):
    """`infra/build-workload-image.sh` chooses its builder from `catalog show`'s install line.

    A shell script cannot import the catalog, so that one line is the interface between
    them — and it was missing, which made every ISO-based `ontrak image build` die with
    "unknown builder" while the script looked correct. This runs the same greps the
    script runs, so a builder that is added without a line to dispatch on fails here
    rather than on a range.
    """
    done = subprocess.run(
        [sys.executable, "-m", "ontrak", "catalog", "show", entry_id],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    # Exit 1 is "known, and not provisionable yet" — the facts are printed either way.
    assert done.returncode in (0, 1), done.stderr
    facts = done.stdout
    if "recipe manual, builder manual" in facts:
        assert expected == "manual"
        return
    install_line = next((line for line in facts.splitlines() if "install:" in line.lower()), "")
    assert install_line, f"catalog show prints no install line for {entry_id}"
    assert expected in install_line, install_line
