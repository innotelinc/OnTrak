"""The media store is the one place that touches licensed software, so the tests
focus on what it refuses to do as much as what it does."""

from __future__ import annotations

import hashlib

import pytest

from ontrak.catalog import Catalog, CatalogEntry, Media, Resources
from ontrak.media import MediaError, MediaStore, sha256_file

BASE = """
group: media-test
label: Media test
entries:
  - id: free-iso
    name: Free ISO
    kind: vm
    family: windows
    device_profile: vista-era
    automation: winrm-ps51
    media: {source: free, kind: iso, filename: free.iso, url: '__URL__', sha256: '__SHA__'}
    install: {recipe: iso-unattended, builder: answer-file}
  - id: licensed-iso
    name: Licensed ISO
    kind: vm
    family: windows
    device_profile: vista-era
    automation: winrm-ps51
    media: {source: operator, kind: iso, filename: licensed.iso}
    install: {recipe: iso-unattended, builder: answer-file}
  - id: image-entry
    name: Image entry
    kind: container
    family: linux
    device_profile: linux-container
    automation: ssh
    media: {source: free, kind: image, filename: 'images:alpine/3.21'}
    install: {recipe: container-image, alias: 'images:alpine/3.21'}
"""


def _manifest(url: str = "file:///nonexistent", sha: str = "") -> str:
    """Fill the fixture in with str.replace: the body is YAML flow mappings, so
    str.format would read their braces as replacement fields."""
    return BASE.replace("__URL__", url).replace("__SHA__", sha)


def _entry(entry_id="free.iso", source="free", **kwargs) -> CatalogEntry:
    return CatalogEntry(
        id="x",
        name="x",
        group="g",
        media=Media(
            source=source,
            kind=kwargs.get("kind", "iso"),
            filename=entry_id,
            url=kwargs.get("url", ""),
            sha256=kwargs.get("sha256", ""),
        ),
        install={"recipe": "iso-unattended", "builder": "answer-file"},
        resources=Resources(),
    )


# --------------------------------------------------------------------------- #
# status
# --------------------------------------------------------------------------- #


def test_status_reports_the_three_states(tmp_path, settings):
    payload = b"media-bytes"
    source = tmp_path / "free.iso"
    source.write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    (tmp_path / "catalog").mkdir()
    (tmp_path / "catalog" / "media-test.yaml").write_text(_manifest(source.as_uri(), digest))
    catalog = Catalog(tmp_path / "catalog")
    store = MediaStore(tmp_path / "media", catalog)

    free = store.status(catalog.get("free-iso"))
    assert free.state == "fetchable"
    assert free.source == "free"

    licensed = store.status(catalog.get("licensed-iso"))
    assert licensed.state == "operator-required"
    assert "licensed.iso" in licensed.note
    assert str(store.root) in licensed.note

    image = store.status(catalog.get("image-entry"))
    assert image.state == "fetchable"
    assert "image server" in image.note

    counts = store.summary()
    assert counts["fetchable"] == 2
    assert counts["operator-required"] == 1


def test_status_reports_present_files_with_size(tmp_path, settings):
    (tmp_path / "media").mkdir()
    (tmp_path / "media" / "licensed.iso").write_bytes(b"x" * 2048)
    catalog = Catalog(tmp_path / "catalog")
    catalog.root.mkdir(parents=True, exist_ok=True)
    (catalog.root / "c.yaml").write_text(_manifest())
    store = MediaStore(tmp_path / "media", catalog)
    status = store.status(catalog.get("licensed-iso"))
    assert status.state == "present"
    assert status.ready
    assert status.size_bytes == 2048
    assert status.size_human.endswith("KiB")
    assert store.missing_operator_media() == []


def test_a_differently_named_copy_of_the_media_still_counts(tmp_path, settings):
    """Operators rename files. The manifest's stem decides what belongs to what."""
    (tmp_path / "media").mkdir()
    (tmp_path / "media" / "licensed-extra-copy.iso").write_bytes(b"x")
    (tmp_path / "catalog").mkdir()
    (tmp_path / "catalog" / "c.yaml").write_text(_manifest())
    store = MediaStore(tmp_path / "media", Catalog(tmp_path / "catalog"))
    assert store.status(store.catalog.get("licensed-iso")).state == "present"


# --------------------------------------------------------------------------- #
# fetching
# --------------------------------------------------------------------------- #


def test_fetch_downloads_free_media_and_verifies_the_checksum(tmp_path, settings):
    payload = b"evaluation-media" * 100
    source = tmp_path / "free.iso"
    source.write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    (tmp_path / "catalog").mkdir()
    (tmp_path / "catalog" / "c.yaml").write_text(_manifest(source.as_uri(), digest))
    catalog = Catalog(tmp_path / "catalog")
    store = MediaStore(tmp_path / "media", catalog)

    target = store.fetch(catalog.get("free-iso"))
    assert target.read_bytes() == payload
    assert not target.with_suffix(".iso.part").exists()
    # Second fetch is a no-op, not a re-download.
    assert store.fetch(catalog.get("free-iso")) == target


def test_fetch_rejects_a_checksum_mismatch_and_leaves_nothing_behind(tmp_path, settings):
    source = tmp_path / "free.iso"
    source.write_bytes(b"media")
    (tmp_path / "catalog").mkdir()
    (tmp_path / "catalog" / "c.yaml").write_text(_manifest(source.as_uri(), "0" * 64))
    store = MediaStore(tmp_path / "media", Catalog(tmp_path / "catalog"))

    with pytest.raises(MediaError, match="checksum mismatch"):
        store.fetch(store.catalog.get("free-iso"))
    assert list(store.root.glob("*.iso")) == []


def test_fetch_refuses_licensed_media(tmp_path, settings):
    store = MediaStore(tmp_path / "media", Catalog(tmp_path / "catalog"))
    with pytest.raises(MediaError, match="operator-supplied"):
        store.fetch(_entry("vista-sp2.iso", source="operator"))


def test_fetch_refuses_image_entries(tmp_path, settings):
    store = MediaStore(tmp_path / "media", Catalog(tmp_path / "catalog"))
    entry = _entry("images:ubuntu/24.04", kind="image")
    with pytest.raises(MediaError, match="nothing to download"):
        store.fetch(entry)


def test_fetch_reports_a_failed_transfer(tmp_path, settings):
    store = MediaStore(tmp_path / "media", Catalog(tmp_path / "catalog"))
    entry = _entry("gone.iso", url="file:///definitely/not/here.iso")
    with pytest.raises(MediaError, match="could not download"):
        store.fetch(entry)


def test_fetchable_lists_only_downloadable_entries(tmp_path, settings):
    payload = b"x"
    source = tmp_path / "free.iso"
    source.write_bytes(payload)
    (tmp_path / "catalog").mkdir()
    (tmp_path / "catalog" / "c.yaml").write_text(
        _manifest(source.as_uri(), hashlib.sha256(payload).hexdigest())
    )
    store = MediaStore(tmp_path / "media", Catalog(tmp_path / "catalog"))
    assert [e.id for e in store.fetchable()] == ["free-iso"]


def test_sha256_file_helper(tmp_path):
    path = tmp_path / "blob"
    path.write_bytes(b"abc")
    assert sha256_file(path) == hashlib.sha256(b"abc").hexdigest()
