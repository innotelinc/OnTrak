"""Test doubles and fixtures helpers.

``FakeIncus`` implements the slice of :class:`ontrak.incus.IncusClient` that the
session manager uses, in memory. It models the parts that actually matter for
correctness: templates only exist once built and snapshotted, cloning requires
that snapshot, and claimed instances are removed on delete.
"""

from __future__ import annotations

from ontrak.incus import IncusError, IncusNotFound, InstanceInfo


def synthesise_ticket(form) -> dict[str, str]:
    """Write a plausible incident write-up that satisfies a ticket rubric.

    Fills each field from the rubric's own required terms, padded to its minimum
    length with a sentence that is true of any repair. A rubric asking for something
    nobody could write is then unreachable in a test rather than in a class.
    """
    values: dict[str, str] = {}
    for field in form.fields:
        if field.is_choice():
            values[field.id] = field.expected or (field.options[0] if field.options else "")
            continue
        if (field.kind or "").lower() == "number":
            values[field.id] = "1"
            continue
        terms = [*field.all_of, *(field.any_of[:1] if field.any_of else [])]
        text = ("Answered: " + ", ".join(terms) + ".") if terms else "Recorded the incident."
        # Pad to the minimum length with a sentence that is true of any repair, and
        # never with a phrase the rubric rejects.
        filler = " Verified on the machine before handing the session in."
        while len(text.split()) < max(field.min_words, 1) + 1 and len(text) < 1200:
            text = f"{text}{filler}" if not text.endswith(filler.strip()) else f"{text} Confirmed."
        values[field.id] = text
    return values


class FakeIncus:
    def __init__(
        self,
        image_alias: str = "ontrak-win-base",
        image_present: bool = True,
        images: set[str] | None = None,
        requires_agent_disk: bool = False,
    ):
        self.image_alias = image_alias
        self.image_present = image_present
        # A Windows image published by incus-windows demands an agent:config disk
        # before it will start; the Linux images do not.
        self.requires_agent_disk = requires_agent_disk
        # Workload images published beyond the site's golden one: a Linux scenario names
        # an image alias from the catalog, and the template build refuses to run until
        # that image exists.
        self.images: set[str] = set(images or ())
        self.instances: dict[str, dict] = {}
        self.snapshots: dict[str, set[str]] = {}
        self.calls: list[tuple] = []
        self.devices: list[tuple] = []
        self.configs: list[tuple] = []
        self._config: dict[tuple[str, str], str] = {}
        self._ip_counter = 100

    def add_image(self, alias: str, present: bool = True) -> None:
        if present:
            self.images.add(alias)

    # -- test utilities -------------------------------------------------
    def add_instance(self, name: str, running: bool = True, ip: str = "", snapshots=()) -> None:
        self.instances[name] = {"status": "RUNNING" if running else "STOPPED", "ip": ip or self._next_ip()}
        self.snapshots[name] = set(snapshots)

    def _next_ip(self) -> str:
        self._ip_counter += 1
        return f"10.20.0.{self._ip_counter}"

    def live_names(self) -> set[str]:
        return set(self.instances)

    # -- IncusClient surface -------------------------------------------
    def available(self, binary: str = "incus") -> bool:  # matches the static helper
        return True

    def list_instances(self) -> list[InstanceInfo]:
        out = []
        for name, data in self.instances.items():
            out.append(
                InstanceInfo(
                    name=name,
                    status=data["status"],
                    ipv4=data["ip"] if data["status"] == "RUNNING" else "",
                )
            )
        return out

    def exists(self, name: str) -> bool:
        return name in self.instances

    def instance_status(self, name: str) -> str | None:
        return self.instances.get(name, {}).get("status")

    def instance_ip(self, name: str) -> str | None:
        data = self.instances.get(name)
        if not data or data["status"] != "RUNNING":
            return None
        return data["ip"]

    def snapshot_names(self, instance: str) -> list[str]:
        return sorted(self.snapshots.get(instance, set()))

    def has_snapshot(self, instance: str, snapshot: str) -> bool:
        return snapshot in self.snapshots.get(instance, set())

    def image_exists(self, alias: str) -> bool:
        if alias in self.images:
            return True
        return self.image_present and alias == self.image_alias

    def image_aliases(self) -> list[str]:
        return sorted(self.images | {self.image_alias})

    def create_instance(self, name: str, image: str, profiles=None) -> None:
        self.calls.append(("create_instance", name, image, tuple(profiles or ())))
        if not self.image_exists(image):
            raise IncusNotFound(["init", image, name], 1, f"image {image} not found")
        self.instances[name] = {"status": "STOPPED", "ip": self._next_ip()}
        self.snapshots.setdefault(name, set())

    def copy_instance(self, source: str, name: str, instance_only: bool = True) -> None:
        self.calls.append(("copy_instance", source, name))
        instance, _, snapshot = source.partition("/")
        if instance not in self.instances:
            raise IncusNotFound(["copy", source, name], 1, f"instance {instance} not found")
        if snapshot and snapshot not in self.snapshots.get(instance, set()):
            raise IncusNotFound(["copy", source, name], 1, f"snapshot {snapshot} not found")
        self.instances[name] = {"status": "STOPPED", "ip": self._next_ip()}
        self.snapshots.setdefault(name, set())

    def start_instance(self, name: str, wait: bool = False, timeout: int | None = None) -> None:
        self.calls.append(("start_instance", name))
        if name not in self.instances:
            raise IncusNotFound(["start", name], 1, "not found")
        self.instances[name]["status"] = "RUNNING"

    def stop_instance(self, name: str, force: bool = False, timeout: int = 120) -> None:
        self.calls.append(("stop_instance", name))
        if name in self.instances:
            self.instances[name]["status"] = "STOPPED"

    def power_off_instance(self, name: str, timeout: int = 90) -> None:
        # Recorded separately from `stop_instance` so a test can tell a build that
        # lets the guest flush from one that power-cuts it -- the difference a
        # snapshot of a just-injected fault depends on.
        self.calls.append(("power_off_instance", name))
        if name in self.instances:
            self.instances[name]["status"] = "STOPPED"

    def delete_instance(self, name: str, force: bool = True) -> None:
        self.calls.append(("delete_instance", name))
        self.instances.pop(name, None)
        self.snapshots.pop(name, None)

    def create_snapshot(self, instance: str, snapshot: str) -> None:
        self.calls.append(("create_snapshot", instance, snapshot))
        if instance not in self.instances:
            raise IncusNotFound(["snapshot", "create", instance], 1, "instance not found")
        self.snapshots.setdefault(instance, set()).add(snapshot)

    def delete_snapshot(self, instance: str, snapshot: str) -> None:
        self.snapshots.get(instance, set()).discard(snapshot)

    def get_config(self, instance: str, key: str) -> str:
        # Config set on an instance is readable back off it, the way Incus behaves:
        # the template recipe a build stamps is only useful if the next build can
        # read it, and a double that swallowed it would make every template stale.
        if key == "image.requirements.cdrom_agent" and self.requires_agent_disk:
            return "true"
        return self._config.get((instance, key), "")

    def add_agent_disk_if_required(self, instance: str) -> bool:
        if not self.requires_agent_disk:
            return False
        self.devices.append((instance, "disk", "agent", {"source": "agent:config"}))
        return True

    def set_config(self, instance: str, key: str, value) -> None:
        self.configs.append((instance, key, value))
        self._config[(instance, key)] = str(value)

    def set_configs(self, instance: str, values: dict) -> None:
        for key, value in values.items():
            self.set_config(instance, key, value)

    def add_device(self, instance: str, kind: str, name: str, **options) -> None:
        self.devices.append((instance, kind, name, options))

    def remove_device(self, instance: str, name: str) -> None:
        pass

    def exec_in(self, instance: str, command, timeout: int = 60, detach: bool = False):
        raise IncusError(list(command), 1, "the fake has no agent")

    def wait_for_status(self, instance: str, status: str, timeout: int = 300, interval: float = 2.0) -> bool:
        return self.instance_status(instance) == status

    def server_info(self) -> dict:
        return {"environment": {"server_version": "fake"}}
