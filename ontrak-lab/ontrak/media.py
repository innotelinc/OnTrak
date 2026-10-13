"""The media store: where installation media actually lives.

The catalog describes media; this module resolves it to a file on disk.

* ``source: free`` — the manifest carries a URL and OnTrak can fetch it (Linux
  images come straight from the Incus image server, so there is nothing to fetch;
  Microsoft evaluation ISOs are downloaded).
* ``source: operator`` — retail Windows, Office, anything end-of-life. OnTrak will
  never download these; it looks for the file the manifest names in the operator's
  media directory and reports it as missing (with the exact filename and where to
  put it) if it is not there.

Nothing here writes outside the media directory, and a download only ever starts
for a manifest that is marked free.
"""

from __future__ import annotations

import hashlib
import shutil
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from .catalog import Catalog, CatalogEntry

CHUNK = 1024 * 1024


class MediaError(RuntimeError):
    """Raised when media is missing where it is required, or a transfer fails."""


@dataclass
class MediaStatus:
    entry_id: str
    name: str
    source: str
    filename: str
    state: str  # present | fetchable | operator-required
    path: str = ""
    size_bytes: int = 0
    note: str = ""

    @property
    def ready(self) -> bool:
        return self.state == "present"

    @property
    def size_human(self) -> str:
        size = float(self.size_bytes)
        for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
            if size < 1024 or unit == "TiB":
                return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
            size /= 1024
        return f"{size:.1f} TiB"


class MediaStore:
    def __init__(self, root: str | Path, catalog: Catalog):
        self.root = Path(root)
        self.catalog = catalog

    # -- resolution ----------------------------------------------------
    def path_for(self, entry: CatalogEntry) -> Path | None:
        if entry.media.kind == "image" or not entry.media.filename:
            return None
        return self.root / entry.media.filename

    def find(self, entry: CatalogEntry) -> Path | None:
        """Look for the manifest's filename, then for any file with that suffix."""
        candidate = self.path_for(entry)
        if candidate and candidate.exists():
            return candidate
        if not entry.media.filename:
            return None
        stem = Path(entry.media.filename).stem
        if self.root.exists():
            for path in sorted(self.root.glob(f"{stem}*")):
                if path.is_file():
                    return path
        return None

    def status(self, entry: CatalogEntry) -> MediaStatus:
        if entry.media.kind == "image":
            return MediaStatus(
                entry_id=entry.id,
                name=entry.label,
                source="free",
                filename=entry.image_alias,
                state="fetchable",
                note=f"pulled from the image server as {entry.image_alias!r} on first use",
            )
        path = self.find(entry)
        if path:
            return MediaStatus(
                entry_id=entry.id,
                name=entry.label,
                source=entry.media.source,
                filename=path.name,
                state="present",
                path=str(path),
                size_bytes=path.stat().st_size,
            )
        if entry.media.is_free and entry.media.url:
            return MediaStatus(
                entry_id=entry.id,
                name=entry.label,
                source="free",
                filename=entry.media.filename,
                state="fetchable",
                note="run `ontrak media fetch " + entry.id + "`",
            )
        return MediaStatus(
            entry_id=entry.id,
            name=entry.label,
            source=entry.media.source,
            filename=entry.media.filename,
            state="operator-required",
            note=(
                f"place {entry.media.filename} in {self.root} from your licensed source"
                if entry.media.filename
                else "no filename declared in the catalog"
            ),
        )

    def statuses(self, entries: list[CatalogEntry] | None = None) -> list[MediaStatus]:
        rows = entries if entries is not None else self.catalog.list()
        return [self.status(entry) for entry in rows]

    def ready(self, entry: CatalogEntry) -> bool:
        return self.status(entry).ready

    # -- fetching ------------------------------------------------------
    def fetch(self, entry: CatalogEntry, *, verify: bool = True) -> Path:
        """Download a *freely redistributable* manifest. Refuses anything else."""
        if entry.media.kind == "image":
            raise MediaError(
                f"{entry.id} is an Incus image ({entry.image_alias}); there is nothing to "
                "download — the daemon pulls it on first use"
            )
        if not entry.media.is_free:
            raise MediaError(
                f"{entry.id} media is operator-supplied ({entry.media.filename}). OnTrak does not "
                "download licensed media: copy it into " + str(self.root)
            )
        if not entry.media.url:
            raise MediaError(f"{entry.id} declares free media without a url")

        existing = self.find(entry)
        if existing:
            return existing

        self.root.mkdir(parents=True, exist_ok=True)
        target = self.root / entry.media.filename
        partial = target.with_suffix(target.suffix + ".part")
        try:
            with (
                urllib.request.urlopen(entry.media.url, timeout=60) as response,  # noqa: S310
                open(partial, "wb") as handle,
            ):
                shutil.copyfileobj(response, handle, CHUNK)
        except Exception as exc:  # noqa: BLE001 - surfaced to the operator
            partial.unlink(missing_ok=True)
            raise MediaError(f"could not download {entry.media.url}: {exc}") from exc
        partial.replace(target)

        if verify and entry.media.sha256:
            actual = sha256_file(target)
            if actual != entry.media.sha256:
                target.unlink(missing_ok=True)
                raise MediaError(
                    f"checksum mismatch for {target.name}: expected {entry.media.sha256}, got {actual}"
                )
        return target

    def fetchable(self) -> list[CatalogEntry]:
        return [
            entry
            for entry in self.catalog.list()
            if entry.media.is_free and entry.media.kind != "image" and entry.media.url
        ]

    def missing_operator_media(self) -> list[MediaStatus]:
        return [row for row in self.statuses() if row.state == "operator-required"]

    def summary(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for row in self.statuses():
            counts[row.state] = counts.get(row.state, 0) + 1
        return counts


def sha256_file(path: str | Path, chunk: int = CHUNK) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def default_media_store(settings, catalog: Catalog) -> MediaStore:
    return MediaStore(settings.media_dir, catalog)
