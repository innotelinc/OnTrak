#!/usr/bin/env python3
"""Install a catalog product into a running guest: Exchange, SQL Server, SharePoint, Microsoft 365 Apps.

    infra/windows/apply-product-install.py <instance> --entry sql-server-2022

A product image is the base OS image *plus* a product, and the product's install is a
long, rebooting, unattended sequence that has to happen inside the guest. The catalog
names the script (`catalog/server-products.yaml`, `install.script`) and
`infra/windows/products/` holds it; this tool

  * attaches the product's media — a CD-ROM device for an ISO, an upload for an archive;
  * uploads the script, the library it dot-sources and a descriptor of what to install;
  * runs it, and restarts the guest when the script says the product needs one;
  * deletes the descriptor and the state file again, because a published image must not
    carry either a password or someone else's half-finished step list.

The descriptor is built here rather than by the shell that calls this, so that no
password is ever part of a command line: everything secret comes from this checkout's
settings (`guest.password`) or an `ONTRAK_PRODUCT_*` override.

Passwords here are the *lab's*: a training range hands these machines to students who
are meant to know the local passwords. They are not tenant credentials and nothing in
this file is ever fetched from Microsoft.

Both `product-on-base` scripts and the guest driver they run under are reviewed and
parsed, and have not been through a build on a real host: no Windows, no licensed media
and no hypervisor in the checkout this was written in. See docs/roadmap.md.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ontrak.catalog import Catalog  # noqa: E402
from ontrak.config import load_settings  # noqa: E402
from ontrak.guest import GuestError, build_driver  # noqa: E402
from ontrak.incus import IncusClient  # noqa: E402
from ontrak.media import MediaStore  # noqa: E402
from ontrak.models import Session  # noqa: E402

PRODUCTS_DIR = Path(__file__).resolve().parent / "products"
GUEST_DIR = r"C:\ProgramData\OnTrak"
GUEST_LIB = GUEST_DIR + r"\lib.ps1"
GUEST_SCRIPT = GUEST_DIR + r"\product-install.ps1"
GUEST_CONFIG = GUEST_DIR + r"\product.json"
GUEST_STATE = GUEST_DIR + r"\product-state.txt"
GUEST_MEDIA_DIR = GUEST_DIR + r"\media"

OK_MARKER = "ONTRAK-PRODUCT-OK"
REBOOT_MARKER = "ONTRAK-PRODUCT-REBOOT"

# One run of one product script. Long on purpose: Exchange's schema preparation and a
# SQL Server install are both measured in tens of minutes, and a build that gave up at
# the fifteen-minute mark would be a build that reports every product as broken.
RUN_TIMEOUT_SECONDS = 7200


def _secret(name: str, default: str = "") -> str:
    """A lab password for the accounts a product creates, override by name.

    All of them default to the range's own training password: these machines are handed
    to students, and one password to know beats a different one per product. A range
    that wants them apart sets ONTRAK_PRODUCT_<NAME> in its own environment.
    """
    return os.environ.get(f"ONTRAK_PRODUCT_{name.upper()}") or default


def descriptor(entry, settings) -> dict:
    """What the product script needs to know, in the shape `lib.ps1` reads.

    Version is the entry's own `released` year rather than a guess: the catalog is where
    a version lives, and a script that has to branch can do it on this. `media_folder`
    is a *guest* path and is only where an archive is unpacked — an ISO is a drive the
    script finds for itself, so there is no path in it to get wrong.
    """
    password = settings.guest.password
    archive = entry.media.kind == "archive"
    return {
        "entry": entry.id,
        "product": entry.install_script.rsplit("/", 1)[-1].removesuffix(".ps1"),
        "version": entry.released[:4] if entry.released[:4].isdigit() else entry.edition,
        "media_kind": entry.media.kind,
        # Empty for an ISO, and that is load-bearing: `Get-MediaFolder` searches the
        # attached CD-ROM drives only when it is given no folder, so naming one that
        # no ISO build ever creates made every ISO product fail before it looked at
        # the media at all.
        "media_folder": GUEST_MEDIA_DIR + "\\" + entry.id if archive else "",
        "media_archive": GUEST_MEDIA_DIR + "\\" + entry.media.filename if archive else "",
        "domain": os.environ.get("ONTRAK_PRODUCT_DOMAIN", "ontrak.test"),
        "org": os.environ.get("ONTRAK_PRODUCT_ORG", "OnTrak"),
        "sql_instance": os.environ.get("ONTRAK_PRODUCT_SQL_INSTANCE", "localhost"),
        "port": int(os.environ.get("ONTRAK_PRODUCT_PORT", "8080")),
        "channel": os.environ.get("ONTRAK_PRODUCT_CHANNEL", "Current"),
        "product_id": os.environ.get("ONTRAK_PRODUCT_ID", "O365ProPlusRetail"),
        "prereq_folder": os.environ.get("ONTRAK_PRODUCT_PREREQ_FOLDER", ""),
        "farm_account": os.environ.get("ONTRAK_PRODUCT_FARM_ACCOUNT", "ontrak-farm"),
        "user": settings.guest.user,
        "password": password,
        "admin_password": _secret("admin_password", password),
        "sa_password": _secret("sa_password", password),
        "farm_password": _secret("farm_password", password),
        "farm_passphrase": _secret("farm_passphrase", password),
        "safe_mode_password": _secret("safe_mode_password", password),
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    instance = argv[1]
    args = argv[2:]
    entry_id = ""
    address = ""
    # Passes, not minutes. Microsoft's sequences restart a machine several times —
    # the forest promotion, one restart per prerequisite the tool settles that way,
    # and the documented restarts after Exchange and SharePoint setup — and every
    # restart is a pass. Four was one too few for SharePoint's documented worst case
    # (promotion, two prerequisite restarts, the post-setup restart).
    attempts = 8
    index = 0
    while index < len(args):
        flag = args[index]
        value = args[index + 1] if index + 1 < len(args) else ""
        if flag == "--entry":
            entry_id = value
        elif flag == "--address":
            address = value
        elif flag == "--attempts":
            attempts = max(1, int(value))
        else:
            print(__doc__)
            return 2
        index += 2
    if not entry_id:
        print("--entry <catalog entry> is required")
        return 2

    settings = load_settings()
    if not settings.guest.password:
        print("guest.password is empty: set ONTRAK_GUEST__PASSWORD first", file=sys.stderr)
        return 2

    catalog = Catalog(settings.catalog_dir)
    entry = catalog.get(entry_id)
    if entry.recipe != "product-on-base":
        print(
            f"{entry_id} is not a product entry (recipe {entry.recipe!r}); "
            "`ontrak image build` handles the others",
            file=sys.stderr,
        )
        return 2
    script = catalog.product_script_path(entry)
    if script is None:
        print(
            f"{entry_id} names {entry.install_script!r}, which is not in this checkout "
            f"({catalog.repo_root})",
            file=sys.stderr,
        )
        return 2

    library = script.with_name("lib.ps1")
    media = MediaStore(settings.media_dir, catalog).find(entry)
    if media is None:
        print(
            f"the media for {entry_id} ({entry.media.filename}) is not in the media store: "
            "`ontrak media status` says what is missing",
            file=sys.stderr,
        )
        return 2

    incus = IncusClient(settings)
    if not IncusClient.available():
        print("incus is not on PATH; this runs on the host that built the base image", file=sys.stderr)
        return 2

    if not address:
        address = incus.instance_ip(instance) or ""
    if not address:
        print(f"{instance} has no address yet; start it first, or pass --address", file=sys.stderr)
        return 1

    # A product ISO is attached, not uploaded: a 5 GiB ISO base64'd through WinRM is
    # hours of copying, and Incus presents a file device to a VM as a CD-ROM drive. An
    # archive (the Microsoft 365 Apps deployment tool) has no such trick, so it is
    # pushed into the guest and the script unpacks it there.
    if entry.media.kind == "iso":
        print(f"attaching {media} to {instance} as product media")
        incus.add_device(instance, "disk", "productmedia", source=str(media))

    driver = build_driver(settings)
    session = Session(
        id=None,
        student="<product-build>",
        scenario_id=entry_id,
        instance=instance,
        host_ip=address,
        rdp_user=settings.guest.user,
        rdp_password=settings.guest.password,
    )

    payload = descriptor(entry, settings)

    def wait_ready() -> bool:
        print(f"waiting for the {driver.name} transport on {instance} ({address}) ...")
        return driver.wait_ready(session, timeout=settings.guest.ready_timeout_seconds)

    def run() -> tuple[str, int]:
        result = driver.run_script_file(GUEST_SCRIPT, host=address, instance=instance, timeout=RUN_TIMEOUT_SECONDS)
        return (result.stdout or "") + (result.stderr or ""), result.exit_code

    uploaded = [GUEST_SCRIPT, GUEST_CONFIG]
    if library.is_file():
        uploaded.append(GUEST_LIB)
    try:
        if not wait_ready():
            print(f"the guest never became reachable over {driver.name}", file=sys.stderr)
            return 1
        if entry.media.kind == "archive":
            print(f"uploading {media} into the guest")
            driver.upload_file(str(media), GUEST_MEDIA_DIR + "\\" + entry.media.filename, host=address, instance=instance)
        driver.upload_text(json.dumps(payload, indent=2), GUEST_CONFIG, host=address, instance=instance)
        driver.upload_file(str(script), GUEST_SCRIPT, host=address, instance=instance)
        if library.is_file():
            print(f"uploading {library.name} (the library the product scripts dot-source)")
            driver.upload_file(str(library), GUEST_LIB, host=address, instance=instance)

        for attempt in range(1, attempts + 1):
            print(f"running {script.name} on {instance} (pass {attempt} of {attempts}) ...")
            output, exit_code = run()
            print(output.strip())
            if OK_MARKER in output:
                print(f"\nok: {entry_id} is installed on {instance}")
                break
            if REBOOT_MARKER in output:
                if attempt == attempts:
                    print(
                        f"\n{entry_id} asked for a restart on the last pass; raise --attempts "
                        "if the product needs more of them",
                        file=sys.stderr,
                    )
                    return 1
                print("the product asked for a restart; restarting the guest and continuing\n")
                incus.stop_instance(instance, force=True)
                incus.start_instance(instance)
                address_for_retry = ""
                for _ in range(60):
                    address_for_retry = incus.instance_ip(instance) or ""
                    if address_for_retry:
                        break
                    time.sleep(5)
                if not address_for_retry:
                    print(f"{instance} did not come back with an address", file=sys.stderr)
                    return 1
                address = address_for_retry
                session.host_ip = address
                if not wait_ready():
                    print("the guest did not come back after its restart", file=sys.stderr)
                    return 1
                continue
            if exit_code == 0:
                print(
                    f"\nthe script finished without reporting {OK_MARKER}: every product script "
                    "ends with it, so this is a bug in the script rather than a slow install",
                    file=sys.stderr,
                )
                return 1
            print(f"\n{entry_id} failed on {instance} (exit {exit_code})", file=sys.stderr)
            return 1

        # The descriptor carries passwords and the state file is this build's business,
        # not the image's: both go before anyone publishes this machine.
        for path in (GUEST_CONFIG, GUEST_STATE):
            driver.run_powershell(
                f"Remove-Item -Path '{path}' -Force -ErrorAction SilentlyContinue; 'cleaned'",
                host=address,
                instance=instance,
            )
        print(f"{entry_id} installed; the descriptor and state file are removed again")
        return 0
    except GuestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except GuestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
