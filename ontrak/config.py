"""Configuration loading.

Precedence, lowest to highest:

1. ``config/ontrak.yaml``
2. ``config/local.yaml`` (gitignored deployment overrides)
3. environment variables ``ONTRAK_<SECTION>__<KEY>``
4. explicit ``overrides`` argument (used by tests)

Nested values are addressed with a double underscore, e.g.
``ONTRAK_GUEST__PASSWORD`` -> ``guest.password``. Values are parsed as YAML,
so booleans/ints/lists do not need quoting.
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

    def template_name(self, scenario_id: str) -> str:
        return self.instance_name(self.template_prefix, scenario_id)

    def pool_name(self, scenario_id: str, index: int) -> str:
        return self.instance_name(self.pool_prefix, scenario_id, str(index))

    def session_name(self, scenario_id: str, session_id: int | str) -> str:
        return self.instance_name(self.session_prefix, scenario_id, str(session_id))


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
    work_dir: str = r"C:\ProgramData\OnTrak"


@dataclass
class SessionConfig:
    ttl_minutes: int = 90
    idle_recycle_minutes: int = 20
    max_per_student: int = 1
    randomize_credentials: bool = False
    check_timeout_seconds: int = 240
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
class DemoConfig:
    """Demo mode: the whole student flow with no hypervisor (see ontrak/demo.py)."""

    enabled: bool = False
    students: int = 6
    success_rate: float = 1.0
    reset_state: bool = True


@dataclass
class PoolConfig:
    enabled: bool = True
    default_target: int = 0
    targets: dict[str, int] = field(default_factory=dict)
    max_total: int = 60
    refill_interval_seconds: int = 120
    claim_timeout_seconds: int = 90

    def target_for(self, scenario_id: str) -> int:
        return int(self.targets.get(scenario_id, self.default_target))


@dataclass
class GuacConfig:
    base_url: str = "http://127.0.0.1:8080/guacamole/"
    secret_key: str = ""
    link_ttl_minutes: int = 480
    recording: bool = False
    recording_path: str = "/recordings"
    server_layout: str = "en-us-qwerty"
    keyboard_layout: str = "en-us-qwerty"

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
    admin_user: str = "instructor"
    admin_password: str = ""
    brand_note: str = "Tech support training range"
    allow_self_reset: bool = True
    hints_require_attempt: bool = True


@dataclass
class PathsConfig:
    scenarios: str = "scenarios"
    state: str = "state"
    # The workload catalog (manifests for every OS and Microsoft product).
    catalog: str = "catalog"
    # Installation media: free media is downloaded here, licensed media is placed
    # here by the operator. Gitignored either way.
    media: str = "media"


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
    demo: DemoConfig = field(default_factory=DemoConfig)
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
    def db_path(self) -> Path:
        return self.state_dir / "ontrak.sqlite3"

    def ensure_dirs(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.media_dir.mkdir(parents=True, exist_ok=True)


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


def _parse_env_value(raw: str) -> Any:
    try:
        return yaml.safe_load(raw)
    except yaml.YAMLError:
        return raw


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
    data = _deep_merge(data, _env_overrides(environ))
    if overrides:
        data = _deep_merge(data, overrides)
        sources.append("<overrides>")

    settings = Settings(
        incus=_section(IncusConfig, data.get("incus", {})),
        guest=_section(GuestConfig, data.get("guest", {})),
        session=_section(SessionConfig, data.get("session", {})),
        pool=_section(PoolConfig, data.get("pool", {})),
        guac=_section(GuacConfig, data.get("guac", {})),
        portal=_section(PortalConfig, data.get("portal", {})),
        paths=_section(PathsConfig, data.get("paths", {})),
        selection=_section(SelectionConfig, data.get("selection", {})),
        schedule=_section(ScheduleConfig, data.get("schedule", {})),
        demo=_section(DemoConfig, data.get("demo", {})),
        source_files=sources,
    )
    return settings


def require_secrets(settings: Settings) -> list[str]:
    """Return a list of human-readable problems with missing secrets."""
    problems = []
    if settings.demo.enabled:
        # Demo mode never touches a hypervisor or a guest, so it runs with no secrets
        # at all: that is what makes "clone and try it" a two-command experience.
        return problems
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
