"""Ontrak Sync — configuration.

Everything that differs between deployments is an environment variable, and every
one of them has a working default, because the failure this avoids is the boring
one: a service that will not start because a variable somebody forgot to set is
not in `.env`. The two that must be set deliberately are the API token (there is
no default that is not a hole) and the Network's host list.

WHY THE NETWORK IS CONFIGURED AND NOT DISCOVERED
-----------------------------------------------
Ontrak Sync can tell you what is on a host. It cannot tell you which hosts exist:
the Network's incus hosts are reached over SSH by address, and nothing advertises
them. So the host list is configuration, and `ONtrak_HOSTS` is the one place that
says which machines this deployment is responsible for. A host that is listed and
unreachable is reported as unreachable — never silently dropped — because "no
updates" and "no answer" must not look the same on the dashboard.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    """Read one setting, unwrapping a quoted value.

    The quotes are stripped here because `.env` has three readers and they do not
    agree: docker compose unquotes a value, `docker run --env-file` does not, and a
    shell that sources the file does. `ONTRAK_DEFAULT_SCHEDULE` is the reason this
    matters — a cron expression contains spaces, so it HAS to be quoted to be
    sourceable, and without this the service would see `"0 4 * * 0"` with the
    quotes still on it from one loader and a parse error from the timer.
    """
    raw = os.environ.get(name, default).strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in ("'", '"'):
        raw = raw[1:-1].strip()
    return raw


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = _env(name).lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return default


#
# WHAT A MACHINE IS, NOT WHAT TOOL HAPPENS TO BE ON IT.
#
# The Network is not made of incus containers. It is physical servers, VMware
# guests, Proxmox nodes, LXC containers, QEMU/KVM machines and a few things nobody
# wrote down — and a monitor that assumes the first of those will silently report
# "nothing to do" for all the others. So `kind` names the *machine*, and the scan
# does the honest thing with each one:
#
#   * a kind with a workload enumerator (today: `incus`, `both`) is asked for its
#     guests, and each guest is scanned as its own target;
#   * every other kind is scanned as a machine in its own right, over SSH. Its own
#     packages are what can be out of date, and its guests — a Proxmox node's VMs, a
#     VMware host's VMs — are separate machines with their own entries in
#     `ONTRAK_HOSTS`, because that is what they are.
#
# Adding a kind is a one-line change here plus, if it should enumerate guests, an
# enumerator in `scan.py`. That is deliberate: the list is the contract, and an
# operator should be able to see what this deployment understands without reading
# the scanner.
MACHINE_KINDS: dict[str, str] = {
    "incus": "runs incus containers",
    "both": "runs incus and Docker workloads",
    "docker": "runs Docker containers",
    "lxc": "runs plain LXC containers",
    "proxmox": "a Proxmox VE node",
    "vmware": "a VMware ESXi host",
    "qemu": "a QEMU/KVM hypervisor",
    "virtual": "a virtual machine on any hypervisor",
    "physical": "bare metal",
}

# Kinds whose *guests* this deployment can enumerate and then scan in their own
# right. Everything else is scanned as a machine; its guests are separate host
# entries, which keeps "which machine is behind on updates?" answerable for a
# hypervisor whose API we do not speak.
WORKLOAD_KINDS = frozenset({"incus", "both", "docker"})


def machine_kind_label(kind: str) -> str:
    """The machine's kind in words, for a human. Unknown kinds are named as such
    rather than hidden, because an unrecognised kind means nothing will be
    enumerated on that machine and somebody should be told."""
    return MACHINE_KINDS.get(kind, f"{kind} (unrecognised)")


@dataclass(frozen=True)
class Host:
    """A machine Ontrak Sync is responsible for.

    `kind` is what the machine *is* — see `MACHINE_KINDS` — and it only decides how
    the machine is inspected. It is configuration rather than detection because the
    probes differ per platform and a wrong guess costs a confusing empty result; an
    unrecognised kind is treated as a plain machine and named as unrecognised in
    the dashboard rather than guessed at.
    """

    name: str
    address: str
    kind: str = "incus"
    ssh_user: str = "root"
    ssh_port: int = 22
    containers: tuple[str, ...] = ()
    notes: str = ""


#
# THE HYPERVISORS AND THE SPARE HOST ARE MACHINES TOO.
#
# i2 and i3 are not bare metal: each is a KVM guest on a Proxmox VE node, and
# those nodes (pm3, pm4) run their own packages — a Proxmox security update lands
# on the node, not on the guest. A list of only the incus hosts reported the two
# nodes as if they did not exist, so `pve-manager`/kernel drift on them was
# invisible. They are listed with kind `proxmox` so they are scanned as machines
# in their own right; their guests (i2, i3) already have their own entries.
#
# i4 (192.168.1.54) is the Network's spare bare-metal Incus host, added 2026-10-01.
DEFAULT_HOSTS: tuple[Host, ...] = (
    Host("i1", "192.168.1.51", "both", notes="bare metal; proxy/edge, vault, monarch, ontrak"),
    Host("i2", "192.168.1.52", "both", notes="KVM guest on pm3 (VM 200); capstone, atlas, rizzaura, genesis, terminal, vault, www"),
    Host("i3", "192.168.1.53", "both", notes="KVM guest on pm4 (VM 200); distro, magnate, mail, onyx, pi, signara, subscribe, vpn"),
    Host("i4", "192.168.1.54", "both", notes="bare metal; spare Incus host (rebalance target)"),
    Host("pm3", "192.168.1.3", "proxmox", notes="Proxmox VE node; hosts the i2 KVM guest (VM 200)"),
    Host("pm4", "192.168.1.4", "proxmox", notes="Proxmox VE node; hosts the i3 KVM guest (VM 200)"),
)


def _parse_hosts(raw: str) -> tuple[Host, ...]:
    """Parse `ONTRAK_HOSTS`.

    Shape: `name=address[:kind[:user]]`, comma-separated —
    `i1=192.168.1.51, i2=192.168.1.52`. Deliberately not YAML or JSON: this is
    one line in `.env`, and a one-line format that needs no parser dependency is
    one fewer thing that can fail while you are trying to bring the dashboard up.
    """
    if not raw:
        return DEFAULT_HOSTS
    hosts: list[Host] = []
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        name, _, rest = chunk.partition("=")
        if not rest:
            raise ValueError(f"ONTRAK_HOSTS: `{chunk}` is not name=address")
        parts = rest.split(":")
        hosts.append(Host(
            name=name.strip(),
            address=parts[0].strip(),
            kind=(parts[1].strip() if len(parts) > 1 and parts[1].strip() else "incus"),
            ssh_user=(parts[2].strip() if len(parts) > 2 and parts[2].strip() else "root"),
        ))
    return tuple(hosts) or DEFAULT_HOSTS


ROLE_NAMES = ("ADMIN", "SYSADMIN", "ANALYST", "TECHNICIAN", "INSTRUCTOR", "STUDENT")


def _parse_role_map(raw: str) -> dict[str, str]:
    """Parse `ONTRAK_OIDC_ROLE_MAPPINGS`.

    One rule per line, `group=ROLE`, because that is exactly how the training
    app's `.env` already spells it and an operator who has configured one OnTrak
    product should not have to learn a second syntax for the next one:

        range-instructors=INSTRUCTOR
        it-ops=SYSADMIN

    An unrecognised role name is dropped rather than guessed at. A typo that
    silently granted ADMIN would be worse than a typo that grants nothing, and
    the dropped rule is reported by the login page's refusal text.
    """
    mapping: dict[str, str] = {}
    for line in (raw or "").replace(",", "\n").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        group, _, role = line.partition("=")
        group = group.strip().strip("\"'").lower()
        role = role.strip().strip("\"'").upper()
        if group and role in ROLE_NAMES:
            mapping[group] = role
    return mapping


def _parse_list(raw: str) -> tuple[str, ...]:
    return tuple(item.strip().lower() for item in (raw or "").split(",") if item.strip())


@dataclass(frozen=True)
class Settings:
    hosts: tuple[Host, ...] = field(default_factory=lambda: DEFAULT_HOSTS)
    db_path: Path = Path("/var/lib/ontrak/ontrak.sqlite3")
    # THE API TOKEN IS REQUIRED. There is no permissive default: a monitoring tool
    # that can install packages on every machine in the Network is the last thing
    # that should answer an unauthenticated request, and "it was only on the LAN"
    # is how the LLM gateway's own door got published. Empty means refuse to start.
    api_token: str = ""
    bind_host: str = "127.0.0.1"
    bind_port: int = 8420
    # How long a fetched remote image digest is reused before the registry is asked
    # again. See `db.get_digest` for why this is a knob and not a constant: it is the
    # dial that decides how much of a rate-limited pull budget the scans spend.
    digest_ttl_seconds: int = 6 * 3600
    ssh_timeout: int = 20
    command_timeout: int = 300
    # apt gets its own, longer clock, because one apt transcript is two jobs: an
    # `apt-get update` from a mirror that answers in seconds on a good day and
    # minutes on a bad one, and then the upgrade behind it. A cold cache and empty
    # package lists are the difference between twenty seconds and a quarter of an
    # hour. Sizing that like a probe is what turned five Network hosts into 306
    # findings recorded as failed — on hosts whose upgrade had in some cases already
    # finished. A timeout no longer means failure by itself (see `apply_findings`,
    # where the verdict is re-read from apt), so this number now only decides how
    # long that wait is allowed to be.
    apt_timeout: int = 900
    # An image pull is the third kind of long job, and it shares apt's problem: the
    # clock that suits a probe does not suit a download. This Network pulls images
    # several gigabytes deep over a domestic uplink, so a 300-second ceiling turned
    # the single largest update it knows about — the PBX full-stack image — into a
    # finding that failed every apply for being slow rather than wrong. A pull does
    # not need the re-read that apt's verdict does, because `docker pull` either
    # finished or did not; the number only decides how long the wait may be.
    pull_timeout: int = 900
    # The scheduler is in-process (see policy.py for the cron arithmetic and the
    # apply policy). Disabling it leaves the API and the manual scan/apply paths
    # working, which is what you want while debugging a schedule that fires at the
    # wrong time — but it does NOT change the mode, so a Network configured as
    # `auto` stays `auto` and can still be applied by hand.
    scheduler_enabled: bool = True
    scheduler_tick_seconds: int = 30
    # These two seed the FIRST policy and then step aside: once the settings form
    # has saved one it lives in the database and wins over the environment. See
    # `scheduler.load_policy`, which is where they are applied — a default that is
    # read here but never used is how an operator ends up believing a knob works.
    default_schedule: str = "0 4 * * 0"
    # `detect` is the default and is what the Network runs. `auto` has to be typed
    # deliberately, in an environment variable or the settings form, because it is
    # the difference between proposing a patch and installing it unattended.
    default_mode: str = "detect"

    # ── identity ────────────────────────────────────────────────────────────
    # The first administrator. Used ONCE, on an empty database: after that the
    # account lives in SQLite and this variable changes nothing, which is what
    # stops a stale `.env` from silently restoring a password somebody rotated.
    admin_user: str = "admin"
    admin_password: str = ""
    admin_email: str = ""
    # Where a browser is sent after a successful sign-in when the caller named no
    # narrower destination. Normally the dashboard itself.
    post_login_redirect: str = "/"
    # ── Cerulean SSO (Authentik) ────────────────────────────────────────────
    # The four variables that turn the button on, spelled exactly as the training
    # app spells them so one `.env` snippet configures both.
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: str = ""
    oidc_default_role: str = "STUDENT"
    oidc_role_map: dict[str, str] = field(default_factory=dict)
    oidc_allowed_domains: tuple[str, ...] = ()
    oidc_require_mfa: bool = False
    oidc_provider_name: str = "Cerulean"
    oidc_scopes: tuple[str, ...] = ("openid", "profile", "email", "groups")
    # The PUBLIC base URL of this deployment, as the browser reaches it. The OIDC
    # redirect URI is built from it, and it has to match what is registered in
    # Cerulean byte for byte — a URI built from the container's own address can
    # never match, which is the single most common way SSO "just does not work".
    public_url: str = ""
    # The secret that signs the SSO state cookie. Falls back to the API token,
    # which is already required and already random.
    session_secret: str = ""

    @property
    def sso_configured(self) -> bool:
        return bool(self.oidc_issuer and self.oidc_client_id)

    @property
    def state_secret(self) -> str:
        return self.session_secret or self.api_token

    @property
    def redirect_uri(self) -> str:
        """The registered callback, or empty when no public URL is set.

        Deliberately NOT defaulted to localhost: a redirect URI that only works on
        the machine the API runs on is a configuration that appears to work right
        up until it is deployed, and the provider compares this byte for byte.
        """
        if not self.public_url:
            return ""
        return f"{self.public_url.rstrip('/')}/api/auth/sso/callback"

    @staticmethod
    def from_env() -> "Settings":
        return Settings(
            hosts=_parse_hosts(_env("ONTRAK_HOSTS")),
            db_path=Path(_env("ONTRAK_DB", "/var/lib/ontrak/ontrak.sqlite3")),
            api_token=_env("ONTRAK_API_TOKEN"),
            bind_host=_env("ONTRAK_BIND_HOST", "127.0.0.1"),
            bind_port=_env_int("ONTRAK_BIND_PORT", 8420),
            ssh_timeout=_env_int("ONTRAK_SSH_TIMEOUT", 20),
            digest_ttl_seconds=_env_int("ONTRAK_DIGEST_TTL", 6 * 3600),
            command_timeout=_env_int("ONTRAK_COMMAND_TIMEOUT", 300),
            apt_timeout=_env_int("ONTRAK_APT_TIMEOUT", 900),
            pull_timeout=_env_int("ONTRAK_PULL_TIMEOUT", 900),
            scheduler_enabled=_env_bool("ONTRAK_SCHEDULER", True),
            scheduler_tick_seconds=_env_int("ONTRAK_SCHEDULER_TICK", 30),
            default_schedule=_env("ONTRAK_DEFAULT_SCHEDULE", "0 4 * * 0"),
            default_mode=_env("ONTRAK_DEFAULT_MODE", "detect"),
            admin_user=_env("ONTRAK_ADMIN_USER", "admin"),
            admin_password=_env("ONTRAK_ADMIN_PASSWORD"),
            admin_email=_env("ONTRAK_ADMIN_EMAIL"),
            post_login_redirect=_env("ONTRAK_POST_LOGIN_REDIRECT", "/"),
            oidc_issuer=_env("ONTRAK_OIDC_ISSUER"),
            oidc_client_id=_env("ONTRAK_OIDC_CLIENT_ID"),
            oidc_client_secret=_env("ONTRAK_OIDC_CLIENT_SECRET"),
            oidc_default_role=_env("ONTRAK_OIDC_DEFAULT_ROLE", "STUDENT"),
            oidc_role_map=_parse_role_map(_env("ONTRAK_OIDC_ROLE_MAPPINGS")),
            oidc_allowed_domains=_parse_list(_env("ONTRAK_OIDC_ALLOWED_DOMAINS")),
            oidc_require_mfa=_env_bool("ONTRAK_OIDC_REQUIRE_MFA", False),
            oidc_provider_name=_env("ONTRAK_OIDC_PROVIDER_NAME", "Cerulean"),
            oidc_scopes=tuple(_env("ONTRAK_OIDC_SCOPES", "openid,profile,email,groups")
                              .replace(" ", ",").split(",")) or ("openid",),
            public_url=_env("ONTRAK_PUBLIC_URL"),
            session_secret=_env("ONTRAK_SESSION_SECRET"),
        )
