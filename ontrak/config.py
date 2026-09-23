"""Configuration loading.

Precedence, lowest to highest:

1. ``config/ontrak.yaml``
2. ``config/local.yaml`` (gitignored deployment overrides)
3. environment variables ``ONTRAK_<SECTION>__<KEY>``
4. explicit ``overrides`` argument (used by tests)

Nested values are addressed with a double underscore, e.g.
``ONTRAK_GUEST__PASSWORD`` -> ``guest.password``. Values are parsed as YAML,
so booleans/ints/lists do not need quoting — and one pair of surrounding quotes
is removed first, because `.env` is also meant to be *sourced* (``set -a; .
./.env; set +a``) and a value with a space or a comma has to be quoted for the
shell. See :func:`_unquote_shell`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import Any

import yaml

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = PROJECT_ROOT / "config" / "ontrak.yaml"
LOCAL_CONFIG = PROJECT_ROOT / "config" / "local.yaml"
ENV_PREFIX = "ONTRAK_"


class ConfigError(RuntimeError):
    """Raised when configuration is missing or unparseable."""


def slugify(value: object) -> str:
    """Lowercase, dash-separated, filesystem-and-Incus-safe name fragment."""
    import re

    return re.sub(r"[^a-z0-9]+", "-", str(value).strip().lower()).strip("-")


# --------------------------------------------------------------------------
# Sections
# --------------------------------------------------------------------------


@dataclass
class IncusConfig:
    remote: str = "local"
    project: str = "ontrak"
    storage_pool: str = "default"
    network: str = "ontrak0"
    profile: str = "ontrak-student"
    image_alias: str = "ontrak-win-base"
    template_prefix: str = "tpl"
    pool_prefix: str = "ontrak-pool"
    session_prefix: str = "ontrak-sess"
    operation_timeout_seconds: int = 300

    def instance_name(self, kind: str, *parts: str) -> str:
        """Build a deterministic instance name, e.g. ``tpl-net-dns-failure``."""
        slugs = [slugify(p) for p in parts if str(p).strip()]
        safe = "-".join(s for s in slugs if s)
        return f"{slugify(kind)}-{safe}" if safe else slugify(kind)

    # Templates and pooled VMs are keyed by (scenario, workload): the same fault on
    # Windows 11 and on Ubuntu are different machines with different images, so they
    # need different names. An empty workload means "the site's golden image", which is
    # how scenarios that do not name a platform keep working.
    def template_name(self, scenario_id: str, workload: str = "") -> str:
        return self.instance_name(self.template_prefix, scenario_id, workload or "")

    def pool_name(self, scenario_id: str, index: int | str, workload: str = "") -> str:
        return self.instance_name(self.pool_prefix, scenario_id, workload or "", str(index))

    def session_name(self, scenario_id: str, session_id: int | str, workload: str = "") -> str:
        return self.instance_name(self.session_prefix, scenario_id, workload or "", str(session_id))

    def parse_template_name(self, name: str) -> tuple[str, str]:
        """Inverse of :meth:`template_name`: ``tpl-<scenario>[-<workload>]``.

        Used by the reaper and by the pool views, which see instance names and have to
        work out which scenario-and-workload pair a machine belongs to. Scenarios whose
        own id ends in a known workload id cannot be distinguished by name alone, so the
        caller passes the known ids and we take the longest match.
        """
        return self._split_suffix(name, self.template_prefix)

    def parse_pool_name(self, name: str) -> tuple[str, str, int] | None:
        """``ontrak-pool-<scenario>[-<workload>]-<n>`` -> ``(scenario, workload, n)``."""
        prefix = f"{slugify(self.pool_prefix)}-"
        if not name.startswith(prefix):
            return None
        rest = name[len(prefix) :]
        index_text, _, remainder = rest.rpartition("-")
        if not remainder.isdigit():
            return None
        scenario, workload = self._split_suffix(index_text, "")
        return scenario, workload, int(remainder)

    def _split_suffix(self, name: str, prefix: str) -> tuple[str, str]:
        text = name
        if prefix:
            head = f"{slugify(prefix)}-"
            if text.startswith(head):
                text = text[len(head) :]
        # Instance names are slugified (git-style, dash-separated) while catalog ids
        # keep their dots — "ubuntu-24.04" becomes ``ubuntu-24-04`` in a name. Matching
        # on the slug and returning the original id is what keeps ``pool-x-ubuntu-24-04-1``
        # attributable to the catalog entry it was built from.
        candidates = sorted(
            ((slugify(w), w) for w in self.known_workloads if w), key=lambda pair: len(pair[0]),
            reverse=True,
        )
        for slug, workload in candidates:
            if slug and text.endswith(f"-{slug}"):
                return text[: -len(slug) - 1], workload
        return text, ""

    # Populated by the session manager from the catalog so name parsing stays a
    # string operation with no import cycle.
    known_workloads: tuple[str, ...] = ()


@dataclass
class GuestConfig:
    driver: str = "winrm"
    user: str = "student"
    password: str = ""
    admin_group: str = "Administrators"
    winrm_port: int = 5985
    winrm_transport: str = "ntlm"
    winrm_use_ssl: bool = False
    rdp_port: int = 3389
    boot_timeout_seconds: int = 300
    ready_timeout_seconds: int = 420
    static_host: str = ""

    # -- Linux guests -------------------------------------------------------
    # incus-shell (default): run inside the guest through the Incus agent, so no
    # sshd, key material or extra port is needed. ssh: for machines OnTrak does not
    # run on Incus, key-based only.
    linux_driver: str = "incus-shell"
    # The account shell scripts run as. Root is the honest default: grading reads
    # things an unprivileged user cannot see (/etc/shadow, /etc/sudoers, ownership),
    # and the guest is a disposable lab machine.
    linux_user: str = "root"
    linux_work_dir: str = "/var/lib/ontrak"
    linux_ready_timeout_seconds: int = 180
    ssh_port: int = 22
    ssh_key: str = ""
    work_dir: str = r"C:\ProgramData\OnTrak"


@dataclass
class SessionConfig:
    ttl_minutes: int = 90
    # A machine is taken back after this long with no *sign* of the student, and the sign
    # is the portal: the session page beats `/sessions/<id>/heartbeat` while it is open,
    # which is where the console lives. The console itself is the gateway's own upstream,
    # so working inside the machine reaches this app only through that beat — without it a
    # student using their machine reads as abandoned, and `idle_20m` destroyed a 45-minute
    # session mid-scenario while its console frame was still on screen.
    idle_recycle_minutes: int = 20
    max_per_student: int = 1

    # ── the portal's own housekeeping (ontrak/maintenance.py) ──
    # `ontrak reap` and `ontrak schedule tick` are written for cron, and the stack
    # `docker compose up` builds has no cron — so the portal runs the session half of
    # the reaper itself: expiry, idle recycling, and one history prune a day. Without
    # it a student's abandoned machine is only taken back when somebody runs a command,
    # which is how a session came to sit at `in_use` with `0:00` left. Turn it off for
    # a range where a session must outlive its own timer.
    maintenance_enabled: bool = True
    maintenance_interval_seconds: int = 60
    # How long a finished (destroyed or errored) session row is kept before that daily
    # prune deletes it. 0 keeps history forever. A session a submitted result or a
    # ticket points at is never deleted, whatever this says (see `Store.delete_sessions`).
    history_days: int = 30
    randomize_credentials: bool = False
    # A template is a snapshot of a scenario, and a snapshot goes stale: editing the
    # scenario, or turning a setting that is baked into the guest on or off
    # (`guac.linux_ssh` installs an sshd), leaves every existing template wrong. With
    # this on — the default — the portal brings the range up to date itself: a sweep
    # at startup builds what is missing and rebuilds what is stale, and a session that
    # still lands on an out-of-date template rebuilds it there and then. Off means
    # templates only ever change when an operator runs `ontrak template build`.
    auto_templates: bool = True
    check_timeout_seconds: int = 240
    # How long a template build keeps hunting for a setup script's marker file after
    # that script's own transport has died -- the case a fault that re-addresses the
    # guest creates. Counted in seconds because re-addressing a Windows guest also
    # makes it rebind its WinRM listener, and the guest answers again long before the
    # build has to give up. 0 disables the fallback (the build then trusts stdout
    # only), which is what the test suite runs with.
    setup_ok_grace_seconds: int = 240
    # Results-only by default: a student can check their work as often as they like,
    # but only the grade they submit at "Complete & End" is stored. Set this to true
    # if you want a record of every attempt (some courses mark the journey).
    persist_progress: bool = False
    # Time limits a student may pick from, in minutes; the first is the default.
    time_limit_choices: list[int] = field(default_factory=lambda: [45, 90, 180])
    # What happens when the student clicks Complete & End: the VM is graded once and
    # then destroyed, so "what happens now" is never ambiguous.
    destroy_on_complete: bool = True

    @property
    def default_time_limit(self) -> int:
        return self.time_limit_choices[0] if self.time_limit_choices else self.ttl_minutes


@dataclass
class SelectionConfig:
    """Automatic scenario assignment (see ontrak/selection.py)."""

    strategy: str = "balanced"
    auto_assign: bool = True
    max_difficulty: int = 4
    seed: int = 0


@dataclass
class ScheduleConfig:
    """Prewarm/teardown windows (see ontrak/scheduler.py)."""

    enabled: bool = False
    windows: list[dict] = field(default_factory=list)

    def to_schedule(self):
        from .scheduler import Schedule

        return Schedule.from_config({"enabled": self.enabled, "windows": self.windows})


@dataclass
class PoolConfig:
    enabled: bool = True
    default_target: int = 0
    targets: dict[str, int] = field(default_factory=dict)
    max_total: int = 60
    refill_interval_seconds: int = 120
    claim_timeout_seconds: int = 90

    def target_for(self, scenario_id: str, workload: str = "") -> int:
        """Warm-pool target for a (scenario, workload) pair.

        The explicit ``<scenario>@<workload>`` key wins, then the plain scenario key,
        then ``default_target``. That ordering is what lets a site say "30 Windows 11
        DNS machines, but only 5 of them on Ubuntu" without two config blocks per
        scenario.
        """
        if workload:
            label = f"{scenario_id}@{workload}"
            if label in self.targets:
                return int(self.targets[label])
        return int(self.targets.get(scenario_id, self.default_target))


@dataclass
class GuacConfig:
    # The address a *browser* uses. The console is a path on the stack's one
    # published port, so the default — `auto` — derives it from the address the
    # student's browser reached the portal on (`guac.resolve_base_url`). That is
    # what lets the same checkout serve `http://127.0.0.1:8080`, a LAN address and
    # a TLS host without editing anything; set an absolute URL when the browser
    # name differs from what the container answers on (behind Cerulean's edge).
    #
    # Prefer an address that shares the portal's origin. Guacamole stores its auth
    # token in the browser's `localStorage`, which is scoped to an origin, and the
    # portal's console bootstrap can only clear it when the two agree — so a console
    # on a *different* origin than the portal can leave a student looking at the last
    # machine that browser opened. `auto` always agrees; a name that serves both the
    # portal and `/guacamole/` (the shipped gateway does) agrees too.
    base_url: str = "auto"
    secret_key: str = ""
    link_ttl_minutes: int = 480
    recording: bool = False
    recording_path: str = "/recordings"
    server_layout: str = "en-us-qwerty"
    keyboard_layout: str = "en-us-qwerty"
    # A Linux *container* guest has no RDP server, so an RDP console pointed at it
    # is a page that says "the remote desktop server is currently unreachable" —
    # which is what the console iframe used to show for every container scenario.
    # On by default, and the console becomes SSH instead: `ontrak template build`
    # installs openssh-server, sets the Linux account's password to
    # `guest.password` and enables password login (sessions.console_transport_script),
    # so a Linux ticket is reachable from the dashboard with no extra step. The
    # build needs a non-empty password and refuses without one; turn the setting
    # off for a range whose Linux guests must not open port 22, and the portal
    # explains the missing console rather than embedding one that cannot connect.
    linux_ssh: bool = True

    def secret_bytes(self) -> bytes:
        key = (self.secret_key or "").strip()
        if len(key) != 32:
            raise ConfigError(
                "guac.secret_key must be exactly 32 hex characters "
                "(128-bit AES key). Set ONTRAK_GUAC__SECRET_KEY."
            )
        try:
            return bytes.fromhex(key)
        except ValueError as exc:  # pragma: no cover - config typo path
            raise ConfigError(f"guac.secret_key is not valid hex: {exc}") from exc


@dataclass
class PortalConfig:
    host: str = "0.0.0.0"
    port: int = 8080
    secret: str = ""
    title: str = "OnTrak"
    brand_note: str = "IT support training range — powered by Innotel OnTrak"
    allow_self_reset: bool = True
    hints_require_attempt: bool = True

    # ── Sign-in (docs/operations.md "Sign-in") ──
    # SSO is optional. This value is the *seed* for the admin toggle: the live
    # switch is stored in the portal database (`meta.sso_enabled`) so an
    # instructor can turn it on or off from the admin panel without editing files.
    # Default off, so a fresh range signs people in with local accounts and needs
    # no identity provider to be usable at all.
    sso_enabled: bool = False
    # Bootstrap instructor for a range whose SSO is off and which has no local
    # account yet. Set ONTRAK_PORTAL__ADMIN_PASSWORD to seed it on startup; with
    # neither this nor an existing local account, the portal offers a one-time
    # `/setup` page that creates the first account instead.
    admin_username: str = "admin"
    admin_password: str = ""

    # ── Cerulean / Authentik SSO ──
    # OnTrak is a relying party, not an identity provider: an instructor and a
    # student are Authentik accounts, and the portal only decides what a signed-in
    # account may do. All four below must be set for the SSO button to work — an
    # empty one makes the flow fail closed rather than half-work, and the admin
    # panel refuses to switch SSO on until they are.
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: str = ""
    # Comma-separated. The range answers on three names (see
    # scripts/cerulean-provision.py), so the callback follows the origin the
    # sign-in started on — and every listed URL must be registered on the
    # Authentik provider too, or that origin cannot sign in at all.
    oidc_redirect_uri: str = ""
    # Authentik group whose members are instructors. Empty promotes nobody.
    oidc_instructor_group: str = ""
    # Authentik group that must be present to sign in at all. Empty admits any
    # account that Authentik authenticates.
    oidc_required_group: str = ""


@dataclass
class PathsConfig:
    scenarios: str = "scenarios"
    state: str = "state"
    # The workload catalog (manifests for every OS and Microsoft product).
    catalog: str = "catalog"
    # Installation media: free media is downloaded here, licensed media is placed
    # here by the operator. Gitignored either way.
    media: str = "media"
    # Command walkthroughs a scenario can point a student at (see docs/lessons.md).
    lessons: str = "lessons"


@dataclass
class Settings:
    incus: IncusConfig = field(default_factory=IncusConfig)
    guest: GuestConfig = field(default_factory=GuestConfig)
    session: SessionConfig = field(default_factory=SessionConfig)
    pool: PoolConfig = field(default_factory=PoolConfig)
    guac: GuacConfig = field(default_factory=GuacConfig)
    portal: PortalConfig = field(default_factory=PortalConfig)
    paths: PathsConfig = field(default_factory=PathsConfig)
    selection: SelectionConfig = field(default_factory=SelectionConfig)
    schedule: ScheduleConfig = field(default_factory=ScheduleConfig)
    source_files: list[str] = field(default_factory=list)

    # -- derived paths -----------------------------------------------------
    def _path(self, value: str) -> Path:
        p = Path(value)
        return p if p.is_absolute() else PROJECT_ROOT / p

    @property
    def scenarios_dir(self) -> Path:
        return self._path(self.paths.scenarios)

    @property
    def state_dir(self) -> Path:
        return self._path(self.paths.state)

    @property
    def catalog_dir(self) -> Path:
        return self._path(self.paths.catalog)

    @property
    def media_dir(self) -> Path:
        return self._path(self.paths.media)

    @property
    def lessons_dir(self) -> Path:
        return self._path(self.paths.lessons)

    @property
    def db_path(self) -> Path:
        return self.state_dir / "ontrak.sqlite3"

    def ensure_dirs(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.media_dir.mkdir(parents=True, exist_ok=True)


# The sections an ``ONTRAK_<SECTION>__<KEY>`` variable can address, in one place:
# both :func:`load_settings` and :func:`_reject_unknown_env` need the same list,
# and they must never drift apart.
SECTIONS: dict[str, Any] = {
    "incus": IncusConfig,
    "guest": GuestConfig,
    "session": SessionConfig,
    "pool": PoolConfig,
    "guac": GuacConfig,
    "portal": PortalConfig,
    "paths": PathsConfig,
    "selection": SelectionConfig,
    "schedule": ScheduleConfig,
}


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------


def _deep_merge(base: dict, overlay: dict) -> dict:
    out = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _read_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    loaded = yaml.safe_load(path.read_text()) or {}
    if not isinstance(loaded, dict):
        raise ConfigError(f"{path} must contain a YAML mapping at the top level")
    return loaded


def _unquote_shell(text: str) -> str:
    """Remove one matching pair of surrounding quotes, the way a shell would.

    ``.env`` is written to be *sourced* — ``set -a; . ./.env; set +a`` is the
    documented way to run a host command with the range's own settings
    (scripts/cerulean-provision.py needs it) — and a value the shell has to quote,
    one with a space or a comma in it, arrives here with the quotes still on. This
    is what lets one file be both valid shell and the value the YAML parse below
    expects: ``ONTRAK_SESSION__TIME_LIMIT_CHOICES='[45, 90, 180]'`` stays a list
    rather than becoming the string ``"[45, 90, 180]"``.
    """
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"'", '"'}:
        return text[1:-1]
    return text


def _parse_env_value(raw: str) -> Any:
    """Parse one ``ONTRAK_<SECTION>__<KEY>`` value as YAML, shell quoting removed.

    An empty value is ``""`` and not ``None``: the field it lands in is typed
    ``str`` throughout, and ``ONTRAK_GUEST__PASSWORD=`` meaning *the string None*
    is a config file that reads as set when it is empty.
    """
    text = _unquote_shell(raw.strip())
    if not text:
        return ""
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError:
        return text


def _env_overrides(environ: dict[str, str] | None = None) -> dict:
    environ = environ if environ is not None else os.environ
    nested: dict[str, Any] = {}
    for key, raw in environ.items():
        if not key.startswith(ENV_PREFIX) or key == "ONTRAK_CONFIG":
            continue
        rest = key[len(ENV_PREFIX) :]
        if "__" not in rest:
            continue  # not a section-scoped override; ignore rather than guess
        section, _, leaf = rest.partition("__")
        nested.setdefault(section.lower(), {})[leaf.lower()] = _parse_env_value(raw)
    return nested


def _section(cls: Any, data: dict) -> Any:
    """Instantiate a dataclass section, rejecting unknown keys loudly."""
    known = {f.name for f in fields(cls)}
    unknown = set(data) - known
    if unknown:
        raise ConfigError(
            f"unknown setting(s) for {cls.__name__}: {', '.join(sorted(unknown))}. "
            f"Known: {', '.join(sorted(known))}"
        )
    return cls(**data)


def _reject_unknown_env(environ: dict[str, str] | None = None) -> None:
    """Reject an environment variable that names a setting the app cannot read.

    A spent ``ONTRAK_<SECTION>__<KEY>`` left in ``.env`` is not a typo to shrug off.
    ``.env`` is what an operator exports, so *every* command that loads config dies
    on it — and ``_section``'s error names the field but never the variable or the
    file, which leaves an upgraded checkout staring at ``unknown setting(s) for
    GuacConfig: public_port`` with nothing to grep for. Naming the variable here is
    what makes that self-diagnosing.

    Only sections the app models are held to this: ``ONTRAK_FOO__BAR`` addresses
    nothing the app knows, and stays ignored rather than becoming an error.
    """
    for section, values in _env_overrides(environ).items():
        cls = SECTIONS.get(section)
        if cls is None:
            continue
        known = {f.name for f in fields(cls)}
        for leaf in sorted(set(values) - known):
            raise ConfigError(
                f"unknown setting {ENV_PREFIX}{section.upper()}__{leaf.upper()} "
                f"for {cls.__name__}: not one of {', '.join(sorted(known))}. "
                f"Remove it from the environment — if it came from a .env file, "
                f"delete the line there."
            )


def load_settings(
    path: str | Path | None = None,
    overrides: dict | None = None,
    environ: dict[str, str] | None = None,
) -> Settings:
    """Load settings from disk + environment + explicit overrides."""
    env_path = (environ or os.environ).get("ONTRAK_CONFIG")
    config_path = Path(path) if path else Path(env_path) if env_path else DEFAULT_CONFIG

    data: dict = _read_yaml(config_path)
    sources = [str(config_path)] if config_path.exists() else []
    if config_path != LOCAL_CONFIG and LOCAL_CONFIG.exists():
        data = _deep_merge(data, _read_yaml(LOCAL_CONFIG))
        sources.append(str(LOCAL_CONFIG))
    _reject_unknown_env(environ)  # an operator's own .env gets named, not just the field
    data = _deep_merge(data, _env_overrides(environ))
    if overrides:
        data = _deep_merge(data, overrides)
        sources.append("<overrides>")

    settings = Settings(
        **{name: _section(cls, data.get(name, {})) for name, cls in SECTIONS.items()},
        source_files=sources,
    )
    return settings


def require_secrets(settings: Settings) -> list[str]:
    """Return a list of human-readable problems with missing secrets."""
    problems = []
    if not settings.guest.password:
        problems.append("guest.password is empty (set ONTRAK_GUEST__PASSWORD)")
    if not settings.portal.secret:
        problems.append("portal.secret is empty (set ONTRAK_PORTAL__SECRET)")
    try:
        settings.guac.secret_bytes()
    except ConfigError as exc:
        problems.append(str(exc))
    return problems


def dataclass_to_dict(obj: Any) -> dict:
    """Recursively convert dataclass sections to plain dicts."""
    if not is_dataclass(obj):
        return obj
    out: dict[str, Any] = {}
    for f in fields(obj):
        value = getattr(obj, f.name)
        out[f.name] = dataclass_to_dict(value) if is_dataclass(value) else value
    return out
