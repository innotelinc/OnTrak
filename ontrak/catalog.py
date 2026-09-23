"""The workload catalog: every operating system and application OnTrak can stand up.

A catalog entry is a *manifest*, never a binary. For freely redistributable media
(Linux images from the Incus image server, Microsoft evaluation ISOs) the manifest
names a URL that :mod:`ontrak.media` can fetch. For everything else — retail
Windows, Office, anything end-of-life — the manifest names the media and declares
``source: operator``: the operator supplies it from their own licensed store. That
split is what keeps the repository publishable while still describing the whole
"Windows 95 to present" range.

Entries are grouped into files under ``catalog/`` (``windows-desktop.yaml``,
``windows-server.yaml``, ``office.yaml``, ``linux.yaml``, ...). A file may declare
``defaults:`` which every entry inherits, which is what keeps the Linux file (dozens
of near-identical distro images) readable.

Nothing here talks to Incus; :meth:`Catalog.plan` turns an entry plus the current
host state into the fastest available provisioning path, and the session manager
executes that plan.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

# yaml.safe_dump writes sequence entries with a 2-space leader ("- id: x"); inside the
# generated file's "entries:" list that needs to be 4 spaces total, so the import path
# re-indents the dumped block rather than formatting it by hand.

# --------------------------------------------------------------------------- #
# device profiles
# --------------------------------------------------------------------------- #

# Named hardware profiles. Guests from the DOS-based era cannot use VirtIO devices
# and need BIOS boot with IDE disks and emulated NICs, so the profile is part of
# the entry rather than a global setting.
DEVICE_PROFILES: dict[str, dict[str, Any]] = {
    "modern": {
        "label": "Modern (UEFI, VirtIO, Secure Boot + TPM)",
        "description": "Windows 11/Server 2016+, or any Linux VM image.",
        "devices": {
            "root": {"type": "disk", "options": {"bus": "virtio-scsi", "size": "48GiB"}},
            "eth0": {"type": "nic", "options": {"nictype": "virtio"}},
        },
        "config": {"security.secureboot": "true"},
        "notes": [],
    },
    "vista-era": {
        "label": "Vista/7 era (BIOS, VirtIO, no Secure Boot)",
        "description": "Windows Vista through 8.1: VirtIO drivers exist, Secure Boot does not.",
        "devices": {
            "root": {"type": "disk", "options": {"bus": "virtio-scsi", "size": "40GiB"}},
            "eth0": {"type": "nic", "options": {"nictype": "virtio"}},
        },
        "config": {"security.secureboot": "false"},
        "notes": ["Install VirtIO drivers from the virtio-win ISO during setup."],
    },
    "legacy-xp": {
        "label": "XP/2003 era (BIOS, IDE disk, emulated NIC)",
        "description": "Windows 2000/XP/2003: no native VirtIO; IDE + e1000 keep setup simple.",
        "devices": {
            "root": {"type": "disk", "options": {"bus": "ide", "size": "24GiB"}},
            "eth0": {"type": "nic", "options": {"nictype": "e1000"}},
        },
        "config": {
            "security.secureboot": "false",
            "limits.memory": "2GiB",
        },
        "notes": [
            "Raw QEMU arguments may be needed for some installers (see raw.qemu below).",
            "Enable Remote Desktop and Remote Assistance manually — WinRM exists from XP SP2 but "
            "on-demand WS-Management setup is unreliable at this era.",
        ],
    },
    "legacy-9x": {
        "label": "DOS-based era (95/98/ME: IDE, rtl8139, cirrus VGA)",
        "description": "Windows 95/98/ME: no ACPI assumptions, no VirtIO, small RAM ceiling.",
        "devices": {
            "root": {"type": "disk", "options": {"bus": "ide", "size": "8GiB"}},
            "eth0": {"type": "nic", "options": {"nictype": "rtl8139"}},
        },
        "config": {
            "security.secureboot": "false",
            "limits.memory": "512MiB",
            "limits.cpu": "1",
            # These guests predate ACPI; give them a chipset they understand.
            "raw.qemu": "-M pc -cpu pentium2 -vga cirrus -device AC97",
        },
        "notes": [
            "No guest automation is possible: there is no WMI, PowerShell or agent. Grading is "
            "instructor-observed or media-inspection, so mark such scenarios manual.",
            "Some installers need a floppy/CD-ROM switch during setup.",
        ],
    },
    "linux-vm": {
        "label": "Linux VM",
        "description": "Distro VM images (server or desktop).",
        "devices": {
            "root": {"type": "disk", "options": {"bus": "virtio-scsi", "size": "32GiB"}},
            "eth0": {"type": "nic", "options": {"nictype": "virtio"}},
        },
        "config": {},
        "notes": [],
    },
    "linux-container": {
        "label": "Linux container",
        "description": "System container: shares the host kernel, so it starts in about a second.",
        "devices": {},
        "config": {},
        "notes": [
            "Kernel-level exercises (boot loaders, drivers, kernel modules) are out of scope "
            "inside a container — pick a VM image for those.",
        ],
    },
}

AUTOMATION_LEVELS = {
    "none": "No guest automation: no PowerShell, no agent (DOS-based Windows).",
    "winrm-ps2": "Windows PowerShell 2.0 era: WinRM possible but enable it per image.",
    "winrm-ps51": "Windows PowerShell 5.1: full automation, what scenarios are written against.",
    "agent": "Incus agent over virtio-vsock (no network dependency).",
    "ssh": "SSH: Linux guests, automate with shell scenarios.",
}

VALID_KINDS = {"vm", "container"}
VALID_RECIPES = {"iso-unattended", "image-alias", "container-image", "product-on-base", "manual"}

# Where a product entry's install script has to live, relative to the checkout. The
# catalog names a path rather than embedding the script, for the same reason it names
# media rather than shipping it: the manifest stays readable and the script stays
# reviewable as a script.
PRODUCT_SCRIPT_ROOT = Path("infra/windows/products")


class CatalogError(RuntimeError):
    """Raised when a catalog file is missing, malformed or inconsistent."""


# --------------------------------------------------------------------------- #
# model
# --------------------------------------------------------------------------- #


@dataclass
class Media:
    """Where an entry's installation media comes from."""

    source: str = "operator"  # free | operator
    kind: str = "iso"  # iso | image | archive
    filename: str = ""
    url: str = ""
    sha256: str = ""
    notes: str = ""

    @property
    def is_free(self) -> bool:
        return self.source == "free"

    @property
    def is_image(self) -> bool:
        """An Incus image alias rather than a file to fetch."""
        return self.kind == "image"

    @classmethod
    def from_dict(cls, data: dict) -> Media:
        return cls(
            source=str(data.get("source", "operator")),
            kind=str(data.get("kind", "iso")),
            filename=str(data.get("filename", "")),
            url=str(data.get("url", "")),
            sha256=str(data.get("sha256", "")).lower(),
            notes=str(data.get("notes", "")),
        )


@dataclass
class Resources:
    cpu: int = 2
    memory: str = "4GiB"
    disk: str = "48GiB"

    @classmethod
    def from_dict(cls, data: dict | None) -> Resources:
        data = data or {}
        return cls(
            cpu=int(data.get("cpu", 2)),
            memory=str(data.get("memory", "4GiB")),
            disk=str(data.get("disk", "48GiB")),
        )

    @property
    def memory_mib(self) -> int:
        return _to_mib(self.memory)


@dataclass
class CatalogEntry:
    id: str
    name: str
    group: str
    family: str = "windows"
    kind: str = "vm"
    released: str = ""
    support: str = ""  # supported | extended | eol
    edition: str = ""
    media: Media = field(default_factory=Media)
    install: dict = field(default_factory=dict)
    device_profile: str = "modern"
    resources: Resources = field(default_factory=Resources)
    automation: str = "winrm-ps51"
    scenario_families: list[str] = field(default_factory=list)
    requires: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    notes: str = ""

    @property
    def profile(self) -> dict:
        return DEVICE_PROFILES.get(self.device_profile, DEVICE_PROFILES["modern"])

    @property
    def recipe(self) -> str:
        return str(self.install.get("recipe", "manual"))

    @property
    def layered_on(self) -> str:
        """The catalog entry this one is a product *on top of*, or ``""``.

        A product entry (Office, Exchange, SQL Server, SharePoint) is not an operating
        system: it names the OS it is layered onto, and its image is that guest with the
        product installed. One base, because one product image is one machine.
        """
        return self.requires[0] if self.requires else ""

    @property
    def install_script(self) -> str:
        """The install script a ``product-on-base`` entry names, or ``""``.

        Relative to the checkout root, so the catalog file says where to look without
        saying where *this* checkout is — see :data:`PRODUCT_SCRIPT_ROOT`.
        """
        return str(self.install.get("script") or "").strip()

    @property
    def image_alias(self) -> str:
        """The Incus image alias for image-based entries."""
        return str(self.install.get("alias") or self.media.filename)

    @property
    def label(self) -> str:
        return f"{self.name}" + (f" ({self.edition})" if self.edition else "")

    @property
    def automated(self) -> bool:
        return self.automation in {"winrm-ps51", "winrm-ps2", "agent", "ssh"}

    def resolved_devices(self) -> dict[str, dict]:
        return {name: dict(spec) for name, spec in (self.profile.get("devices") or {}).items()}

    def resolved_config(self) -> dict[str, str]:
        config = dict(self.profile.get("config") or {})
        config["limits.cpu"] = str(self.resources.cpu)
        config["limits.memory"] = self.resources.memory
        return config

    def to_public(self) -> dict:
        """Console/portal-facing view (no media URLs, which may be signed)."""
        return {
            "id": self.id,
            "name": self.name,
            "label": self.label,
            "group": self.group,
            "family": self.family,
            "kind": self.kind,
            "released": self.released,
            "support": self.support,
            "automation": self.automation,
            "automated": self.automated,
            "resources": {"cpu": self.resources.cpu, "memory": self.resources.memory, "disk": self.resources.disk},
            "device_profile": self.device_profile,
            "scenario_families": list(self.scenario_families),
            "tags": list(self.tags),
            "media": {"source": self.media.source, "kind": self.media.kind},
            "notes": self.notes,
        }


@dataclass
class CatalogGroup:
    id: str
    label: str
    description: str = ""
    era: str = ""
    entries: list[CatalogEntry] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# provisioning plans
# --------------------------------------------------------------------------- #

# Rough wall-clock costs, used to pick the fastest available path and to tell an
# operator what they are waiting for. The order of preference is what matters:
# a warm VM is instant, a container launch is near-instant, cloning a snapshot is
# tens of seconds, and building an image is an operator task, not a request path.
STRATEGY_COST_SECONDS = {
    "warm-pool": 5,
    "container-image": 8,
    "clone-template": 45,
    "image-launch": 90,
    "build-image": 3600,
    "unsupported": 0,
}

STRATEGY_LABELS = {
    "warm-pool": "Hand out an already-booted VM from the warm pool",
    "container-image": "Launch a system container from the image server",
    "clone-template": "Clone the scenario template's clean snapshot",
    "image-launch": "Create the guest from a published image, then inject the scenario",
    "build-image": "Build the guest image from media first (operator task)",
    "unsupported": "Cannot be provisioned automatically",
}

STRATEGY_ORDER = [
    "warm-pool",
    "container-image",
    "clone-template",
    "image-launch",
    "build-image",
]


@dataclass
class ProvisionPlan:
    entry_id: str
    strategy: str
    estimate_seconds: int
    steps: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def label(self) -> str:
        return STRATEGY_LABELS.get(self.strategy, self.strategy)

    @property
    def ready(self) -> bool:
        return self.strategy != "unsupported"

    @property
    def needs_operator(self) -> bool:
        return self.strategy == "build-image"

    def to_dict(self) -> dict:
        return {
            "entry_id": self.entry_id,
            "strategy": self.strategy,
            "label": self.label,
            "estimate_seconds": self.estimate_seconds,
            "steps": list(self.steps),
            "blockers": list(self.blockers),
            "notes": list(self.notes),
            "ready": self.ready,
            "needs_operator": self.needs_operator,
        }


# --------------------------------------------------------------------------- #
# catalog
# --------------------------------------------------------------------------- #


class Catalog:
    def __init__(self, root: str | Path, repo_root: str | Path | None = None):
        self.root = Path(root)
        # Product scripts are named relative to the checkout, not to the catalog, so the
        # root has to be known here to check that one exists. Defaulting to the catalog's
        # own parent is right for a checkout (catalog/ sits in the repo root) and harmless
        # for a test that points the catalog at a directory of its own: the file simply
        # is not there, which is what such a test is usually asserting.
        self.repo_root = Path(repo_root) if repo_root else self.root.parent
        self.groups: dict[str, CatalogGroup] = {}
        self.entries: dict[str, CatalogEntry] = {}

    def product_script_path(self, entry: CatalogEntry) -> Path | None:
        """The host path of a product entry's install script, or ``None`` when it is
        missing or escapes the checkout.

        ``None`` covers both "no such file" and "the manifest points outside the tree",
        because both mean the same thing to a build: there is nothing here to run.
        """
        script = entry.install_script
        if not script:
            return None
        path = Path(script)
        if path.is_absolute() or ".." in path.parts:
            return None
        resolved = self.repo_root / path
        return resolved if resolved.is_file() else None

    # -- loading -------------------------------------------------------
    def load(self, force: bool = False) -> dict[str, CatalogEntry]:
        if self.entries and not force:
            return self.entries
        if not self.root.exists():
            raise CatalogError(f"catalog directory not found: {self.root}")
        groups: dict[str, CatalogGroup] = {}
        entries: dict[str, CatalogEntry] = {}
        for path in sorted(self.root.glob("*.yaml")):
            group = self._load_file(path)
            if group.id in groups:
                raise CatalogError(f"duplicate catalog group {group.id!r} (in {path.name})")
            for entry in group.entries:
                if entry.id in entries:
                    raise CatalogError(
                        f"duplicate catalog entry id {entry.id!r} "
                        f"({entries[entry.id].group} and {entry.group})"
                    )
                entries[entry.id] = entry
            groups[group.id] = group
        self.groups = groups
        self.entries = entries
        return entries

    def _load_file(self, path: Path) -> CatalogGroup:
        try:
            data = yaml.safe_load(path.read_text()) or {}
        except yaml.YAMLError as exc:
            raise CatalogError(f"{path.name}: invalid YAML: {exc}") from exc
        if not isinstance(data, dict):
            raise CatalogError(f"{path.name}: top level must be a mapping")
        group_id = str(data.get("group") or path.stem)
        defaults = data.get("defaults") or {}
        if not isinstance(defaults, dict):
            raise CatalogError(f"{path.name}: defaults must be a mapping")
        entries = []
        for raw in data.get("entries") or []:
            if not isinstance(raw, dict):
                raise CatalogError(f"{path.name}: every entry must be a mapping")
            merged = _deep_merge(defaults, raw)
            entries.append(self._entry(group_id, data, merged, path))
        return CatalogGroup(
            id=group_id,
            label=str(data.get("label") or group_id.replace("-", " ").title()),
            description=str(data.get("description") or "").strip(),
            era=str(data.get("era") or ""),
            entries=entries,
        )

    def _entry(self, group_id: str, group_data: dict, data: dict, path: Path) -> CatalogEntry:
        if not data.get("id"):
            raise CatalogError(f"{path.name}: an entry is missing 'id'")
        install = dict(data.get("install") or {})
        media = Media.from_dict(dict(data.get("media") or {}))
        if "alias" in install and media.kind == "image":
            media.filename = media.filename or str(install["alias"])
        return CatalogEntry(
            id=str(data["id"]),
            name=str(data.get("name") or data["id"]),
            group=group_id,
            family=str(data.get("family") or group_data.get("family") or "windows"),
            kind=str(data.get("kind") or "vm"),
            released=str(data.get("released") or ""),
            support=str(data.get("support") or ""),
            edition=str(data.get("edition") or ""),
            media=media,
            install=install,
            device_profile=str(data.get("device_profile") or "modern"),
            resources=Resources.from_dict(data.get("resources")),
            automation=str(data.get("automation") or "winrm-ps51"),
            scenario_families=[str(f) for f in (data.get("scenario_families") or [])],
            requires=[str(r) for r in (data.get("requires") or [])],
            tags=[str(t) for t in (data.get("tags") or [])],
            notes=str(data.get("notes") or "").strip(),
        )

    # -- access --------------------------------------------------------
    def get(self, entry_id: str) -> CatalogEntry:
        self.load()
        if entry_id not in self.entries:
            raise CatalogError(
                f"unknown catalog entry {entry_id!r}; try `ontrak catalog list`"
            )
        return self.entries[entry_id]

    def list(self, **filters: Any) -> list[CatalogEntry]:
        self.load()
        order = {group: index for index, group in enumerate(self.groups)}
        rows = list(self.entries.values())
        for key, value in filters.items():
            if value in (None, "", [], False):
                continue
            rows = [row for row in rows if _matches(row, key, value)]
        rows.sort(key=lambda e: (order.get(e.group, 99), e.released, e.name))
        return rows

    def group_list(self) -> list[CatalogGroup]:
        self.load()
        return list(self.groups.values())

    # -- validation ----------------------------------------------------
    def validate(self) -> list[str]:
        problems: list[str] = []
        try:
            self.load(force=True)
        except CatalogError as exc:
            return [str(exc)]

        for entry in self.entries.values():
            prefix = f"[{entry.id}]"
            if entry.kind not in VALID_KINDS:
                problems.append(f"{prefix} kind must be vm or container (got {entry.kind!r})")
            if entry.device_profile not in DEVICE_PROFILES:
                problems.append(
                    f"{prefix} unknown device_profile {entry.device_profile!r}; "
                    f"known: {', '.join(sorted(DEVICE_PROFILES))}"
                )
            if entry.recipe not in VALID_RECIPES:
                problems.append(
                    f"{prefix} install.recipe must be one of {sorted(VALID_RECIPES)} (got {entry.recipe!r})"
                )
            if entry.automation not in AUTOMATION_LEVELS:
                problems.append(
                    f"{prefix} unknown automation level {entry.automation!r}; "
                    f"known: {', '.join(sorted(AUTOMATION_LEVELS))}"
                )
            if entry.media.source not in {"free", "operator"}:
                problems.append(f"{prefix} media.source must be free or operator")
            if entry.media.kind not in {"iso", "image", "archive"}:
                problems.append(f"{prefix} media.kind must be iso, image or archive")
            if entry.resources.cpu < 1:
                problems.append(f"{prefix} resources.cpu must be >= 1")
            if entry.resources.memory_mib < 128:
                problems.append(f"{prefix} resources.memory is implausibly small")

            if entry.media.is_free and entry.media.kind != "image" and not entry.media.url:
                problems.append(f"{prefix} free media must have a url (or kind: image)")
            if entry.media.source == "operator" and not entry.media.filename:
                problems.append(
                    f"{prefix} operator-supplied media must name a filename so the "
                    "media store can look it up"
                )
            if entry.recipe == "image-alias" and not entry.install.get("alias"):
                problems.append(f"{prefix} install.recipe image-alias needs install.alias")
            if entry.recipe == "container-image" and entry.kind != "container":
                problems.append(f"{prefix} container-image recipe requires kind: container")
            if entry.recipe == "iso-unattended" and not entry.install.get("builder"):
                problems.append(
                    f"{prefix} iso-unattended needs install.builder (how the ISO is turned into an image)"
                )
            if entry.kind == "container" and entry.automation in {"winrm-ps51", "winrm-ps2", "agent"}:
                problems.append(
                    f"{prefix} a Linux container cannot be driven by {entry.automation}; use ssh"
                )
            if entry.device_profile == "legacy-9x" and entry.kind == "container":
                problems.append(f"{prefix} DOS-era profiles are VM-only")
            if not entry.automated and not entry.notes:
                problems.append(
                    f"{prefix} has automation {entry.automation!r} and no notes explaining how it is used"
                )
            for required in entry.requires:
                if required not in self.entries:
                    problems.append(
                        f"{prefix} requires {required!r}, which is not in the catalog "
                        "(a product entry must name the OS it is layered onto)"
                    )
            if entry.requires and entry.recipe not in {"manual", "product-on-base"}:
                problems.append(
                    f"{prefix} is a product entry — it requires {entry.layered_on!r} — so "
                    "its recipe is either product-on-base (built onto that base) or manual "
                    f"(got {entry.recipe!r})"
                )
            if entry.recipe == "product-on-base":
                for problem in self._product_problems(entry, prefix):
                    problems.append(problem)
            if (
                entry.recipe == "iso-unattended"
                and entry.install.get("builder") == "incus-windows"
                and entry.device_profile != "modern"
            ):
                problems.append(
                    f"{prefix} uses the incus-windows builder with device profile "
                    f"{entry.device_profile!r}; that builder targets Secure Boot/TPM guests "
                    "(use the answer-file builder for older releases)"
                )
        return problems

    def _product_problems(self, entry: CatalogEntry, prefix: str) -> list[str]:
        """What is wrong with one ``product-on-base`` entry, if anything.

        A product image is a base guest plus an unattended install, so every one of these
        is a way that build would fail somewhere expensive (an hour into an Exchange
        setup, say) instead of here:

        * no base, or more than one: one product image is one machine;
        * a base nothing can drive: the install happens *inside* the guest, so a base
          with no automation is a product that could only be installed by hand;
        * a base that is itself a container: a Windows product does not install into a
          Linux container;
        * no script, or one that is missing/outside the checkout: the catalog names the
          script, so it is the catalog's job to say when it is not there.
        """
        problems: list[str] = []
        if not entry.requires:
            problems.append(
                f"{prefix} recipe product-on-base must name the OS it is layered onto "
                "in requires"
            )
        elif len(entry.requires) > 1:
            problems.append(
                f"{prefix} is layered onto {', '.join(entry.requires)}; a product image "
                "is one base plus one product, so name exactly one"
            )
        base = self.entries.get(entry.layered_on) if entry.layered_on else None
        if base is not None:
            if base.kind != "vm":
                problems.append(
                    f"{prefix} layers onto {base.id}, which is a {base.kind}: a product "
                    "installs into a guest, not into a container"
                )
            if not base.automated:
                problems.append(
                    f"{prefix} layers onto {base.id}, whose automation is "
                    f"{base.automation!r}: the install runs inside the guest, so nothing "
                    "could drive it"
                )
        if not entry.install_script:
            problems.append(
                f"{prefix} recipe product-on-base needs install.script (the script that "
                f"installs the product in the guest, under {PRODUCT_SCRIPT_ROOT})"
            )
        else:
            script = Path(entry.install_script)
            if script.is_absolute() or ".." in script.parts:
                problems.append(
                    f"{prefix} install.script {entry.install_script!r} must be a path "
                    "inside the checkout"
                )
            elif self.product_script_path(entry) is None:
                problems.append(
                    f"{prefix} install.script {entry.install_script!r} is not in this "
                    f"checkout ({self.repo_root}) — the catalog names the script, so a "
                    "rename that missed the manifest is caught here rather than at build "
                    "time"
                )
        return problems

    # -- planning ------------------------------------------------------
    def plan(
        self,
        entry: CatalogEntry | str,
        *,
        pool_ready: bool = False,
        template_ready: bool = False,
        image_ready: bool = False,
        media_ready: bool = False,
    ) -> ProvisionPlan:
        """Pick the fastest viable provisioning path for an entry.

        The caller supplies what the host currently has; this function is pure, so
        the CLI can print a plan without touching Incus (``--dry-run`` style) and
        the session manager can call it with live facts.
        """
        if isinstance(entry, str):
            entry = self.get(entry)

        plan = ProvisionPlan(entry_id=entry.id, strategy="unsupported", estimate_seconds=0)

        if entry.kind == "container":
            plan.strategy = "container-image"
            plan.steps = [
                f"incus launch {entry.image_alias} <instance> -p default -p {entry.device_profile}",
                "wait for cloud-init/the init system, then run the scenario setup script over SSH",
            ]
            plan.estimate_seconds = STRATEGY_COST_SECONDS["container-image"]
            if entry.recipe != "container-image":
                plan.blockers.append(
                    f"kind is container but install.recipe is {entry.recipe!r}; expected container-image"
                )
            return plan

        if entry.media.kind == "image" or entry.recipe == "image-alias":
            if not image_ready:
                plan.strategy = "image-launch"
                plan.blockers.append(
                    f"image alias {entry.image_alias!r} is not published yet; "
                    "publish it once, or build it from media"
                )
            else:
                plan.strategy = "image-launch"
            plan.steps = [
                f"incus init {entry.image_alias} <template> --profile {entry.device_profile}",
                "apply the profile's devices and config (legacy profiles differ: IDE disk, e1000 NIC)",
                "boot, run the scenario setup script, snapshot as clean",
            ]
            plan.estimate_seconds = STRATEGY_COST_SECONDS["image-launch"]
            return plan

        # A product: someone else's guest, with the product installed inside it. The
        # build is two steps the operator can see and repeat — the base image, then this
        # one on top — because the base is shared: rebuilding it means rebuilding every
        # product layered onto it.
        if entry.recipe == "product-on-base":
            base = entry.layered_on
            if not media_ready:
                plan.blockers.append(
                    "the product's own media is not in the media store; "
                    f"place {entry.media.filename} there from your licensed source"
                )
            if not image_ready:
                plan.strategy = "build-image"
                plan.steps = [
                    f"ontrak image build {base}   # the OS it is layered onto, if it is not published",
                    f"ontrak media status {entry.id}   # {entry.media.filename} is operator-supplied",
                    f"ontrak image build {entry.id}  # launches {base}, runs {entry.install_script} "
                    f"in the guest, publishes ontrak-{entry.id}",
                    f"ontrak template build <scenario> --workload {entry.id}",
                ]
                plan.estimate_seconds = STRATEGY_COST_SECONDS["build-image"]
                plan.notes.append(
                    f"a product image is {base} plus an install, so a rebuilt base means "
                    f"rebuilding {entry.id} too"
                )
                for note in DEVICE_PROFILES.get(entry.device_profile, {}).get("notes", []) or []:
                    plan.notes.append(note)
                return plan
            plan.strategy = "image-launch"
            plan.estimate_seconds = STRATEGY_COST_SECONDS["image-launch"]
            return plan

        # An ISO that has to be turned into an image at least once.
        if entry.recipe == "iso-unattended":
            if not media_ready:
                plan.blockers.append(
                    "installation media is not in the media store; "
                    + (
                        "run `ontrak media fetch` (freely redistributable)"
                        if entry.media.is_free
                        else f"place {entry.media.filename} in the media store from your licensed source"
                    )
                )
            if not image_ready:
                plan.strategy = "build-image"
                plan.steps = [
                    f"ontrak media fetch {entry.id}   # or operator-supplied {entry.media.filename}",
                    f"ontrak image build {entry.id}  # unattended install via {entry.install.get('builder')}",
                    f"ontrak template build <scenario> --workload {entry.id}",
                ]
                plan.estimate_seconds = STRATEGY_COST_SECONDS["build-image"]
                for note in DEVICE_PROFILES.get(entry.device_profile, {}).get("notes", []) or []:
                    plan.notes.append(note)
                return plan
            plan.strategy = "image-launch"
            plan.estimate_seconds = STRATEGY_COST_SECONDS["image-launch"]
            return plan

        plan.blockers.append(
            f"recipe {entry.recipe!r} cannot be automated; provision it by hand and publish the image"
        )
        plan.notes.extend(entry.profile.get("notes") or [])
        return plan

    def merge_order(self, plans: Iterable[ProvisionPlan]) -> list[ProvisionPlan]:
        """Sort plans by the order requests would be served in (fastest first)."""
        rank = {name: index for index, name in enumerate(STRATEGY_ORDER)}
        return sorted(plans, key=lambda p: (rank.get(p.strategy, 99), p.estimate_seconds))

    # -- remote image import -------------------------------------------
    def import_images(self, images: list[dict], *, group: str = "linux-images") -> Path:
        """Write a catalog group from ``incus image list <remote>: --format=json``.

        This is how "every Linux distribution" stays true over time: rather than
        hand-maintaining thousands of entries, refresh from the image server. The
        generated file is committed so the catalog works offline too.
        """
        lines = [
            "# Generated by `ontrak catalog refresh` from the Incus image server.",
            "# Hand edits are overwritten on the next refresh; put curated entries in",
            "# the hand-written group files instead.",
            "",
            f"group: {group}",
            "label: Linux images (from the image server)",
            'description: Every image the configured Incus image server publishes.',
            "family: linux",
            "defaults:",
            "  kind: container",
            "  family: linux",
            "  install: {recipe: container-image}",
            "  media: {source: free, kind: image}",
            "  automation: ssh",
            "  device_profile: linux-container",
            "entries:",
        ]
        seen = set()
        # `incus image list --format=json` has no `name` field, so sort on what it does
        # publish: the alias, which is also what the entries are keyed by. Without this
        # the file's entry order would depend on the daemon's output order.
        def sort_key(image: dict) -> str:
            alias = (image.get("aliases") or [{}])[0]
            return str(alias.get("name") or image.get("fingerprint", ""))

        for image in sorted(images, key=sort_key):
            props = image.get("properties") or {}
            alias = (image.get("aliases") or [{}])[0]
            alias_name = alias.get("name") or props.get("os") or image.get("fingerprint", "")[:12]
            if not alias_name or alias_name in seen:
                continue
            seen.add(alias_name)
            os_name = props.get("os", alias_name.split("/")[0])
            release = props.get("release", "")
            variant = props.get("variant", "")
            entry_id = re.sub(r"[^a-z0-9]+", "-", alias_name.lower()).strip("-")
            label = " ".join(part for part in (os_name.title(), release, variant) if part)
            description = props.get("description", "").strip() or "Image from the configured remote."
            # Note the 4-space indent on the keys after ``- id``: they belong to the same
            # sequence entry. Getting this wrong produces a file that still looks right
            # but will not parse, which is why the round-trip is covered by a test.
            entry = {
                "id": entry_id,
                "name": label,
                "released": str(props.get("release_date", "")),
                "install": {"recipe": "container-image", "alias": alias_name},
                "media": {"source": "free", "kind": "image", "filename": alias_name},
                "notes": description,
            }
            block = yaml.safe_dump([entry], sort_keys=False, width=100, default_flow_style=False)
            lines += ["  " + line if line.strip() else line for line in block.rstrip().splitlines()]
            lines[-1] = lines[-1].rstrip()
        target = self.root / f"{group}.yaml"
        target.write_text("\n".join(lines) + "\n")
        return target


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


def _deep_merge(base: dict, overlay: dict) -> dict:
    out = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _to_mib(value: str) -> int:
    text = str(value).strip().upper()
    for suffix, factor in (("GIB", 1024), ("MIB", 1), ("GB", 1000), ("MB", 1)):
        if text.endswith(suffix):
            try:
                return int(float(text[: -len(suffix)]) * factor)
            except ValueError:
                return 0
    try:
        return int(text)
    except ValueError:
        return 0


def _matches(entry: CatalogEntry, key: str, value: Any) -> bool:
    if key in {"group", "family", "kind", "automation", "support", "device_profile", "id", "name"}:
        actual = str(getattr(entry, key))
        if key in {"id", "name"}:
            return value.lower() in actual.lower()
        return actual == str(value)
    if key == "automated":
        return entry.automated == bool(value)
    if key == "tag":
        return str(value) in entry.tags
    if key == "scenario_family":
        return str(value) in entry.scenario_families
    if key == "era":
        return entry.group.startswith(str(value))
    if key == "max_memory_mib":
        return entry.resources.memory_mib <= int(value)
    if key == "available":
        # Filter by what can actually be provisioned without operator work.
        return entry.media.is_free or entry.recipe == "container-image"
    return True


def default_catalog(settings) -> Catalog:
    return Catalog(settings.catalog_dir)
