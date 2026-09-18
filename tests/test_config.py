from __future__ import annotations

import pytest
import yaml

from ontrak.config import ConfigError, load_settings, require_secrets

from .conftest import GUAC_KEY, SCENARIOS_DIR


def test_defaults_load_and_resolve_paths(tmp_path):
    config = tmp_path / "cfg.yaml"
    config.write_text("guest:\n  user: alice\n")
    settings = load_settings(path=config, environ={})
    assert settings.guest.user == "alice"
    assert settings.incus.image_alias == "ontrak-win-base"  # from the repo defaults
    assert settings.scenarios_dir == SCENARIOS_DIR
    assert settings.db_path.name == "ontrak.sqlite3"


def test_section_key_env_override(settings):
    settings = load_settings(
        path=None,
        environ={
            "ONTRAK_GUEST__PASSWORD": "from-env",
            "ONTRAK_SESSION__TTL_MINUTES": "15",
            "ONTRAK_POOL__TARGETS": "{net-dns-failure: 30}",
            "IGNORED_KEY": "nope",
            "ONTRAK_NOT_SCOPED": "nope",
        },
    )
    assert settings.guest.password == "from-env"
    assert settings.session.ttl_minutes == 15
    assert settings.pool.target_for("net-dns-failure") == 30
    assert settings.pool.target_for("other") == settings.pool.default_target


def test_bad_key_is_rejected(tmp_path):
    config = tmp_path / "cfg.yaml"
    config.write_text("guest:\n  nope: 1\n")
    with pytest.raises(ConfigError, match="unknown setting"):
        load_settings(path=config, environ={})


def test_absolute_and_relative_state_paths(tmp_path):
    settings = load_settings(overrides={"paths": {"state": str(tmp_path / "s")}}, environ={})
    assert settings.state_dir == tmp_path / "s"
    settings.ensure_dirs()
    assert settings.state_dir.is_dir()


def test_guac_secret_parsing():
    settings = load_settings(overrides={"guac": {"secret_key": GUAC_KEY}}, environ={})
    assert settings.guac.secret_bytes() == bytes.fromhex(GUAC_KEY)


def test_guac_secret_must_be_32_hex():
    settings = load_settings(overrides={"guac": {"secret_key": "short"}}, environ={})
    with pytest.raises(ConfigError, match="32 hex"):
        settings.guac.secret_bytes()


def test_require_secrets_reports_each_problem():
    settings = load_settings(
        overrides={"guest": {"password": ""}, "portal": {"secret": ""}, "guac": {"secret_key": ""}},
        environ={},
    )
    problems = require_secrets(settings)
    assert len(problems) == 3
    assert any("guest.password" in p for p in problems)
    assert any("portal.secret" in p for p in problems)


def test_instance_name_helpers():
    settings = load_settings(environ={})
    incus = settings.incus
    assert incus.template_name("Net DNS Failure") == f"{incus.template_prefix}-net-dns-failure"
    assert incus.pool_name("sw-app-crash", 3) == f"{incus.pool_prefix}-sw-app-crash-3"
    assert incus.session_name("hw_driver_device", 12).startswith(f"{incus.session_prefix}-hw-driver-device-")


def test_shipped_yaml_is_parseable():
    from pathlib import Path

    from ontrak.config import DEFAULT_CONFIG

    data = yaml.safe_load(Path(DEFAULT_CONFIG).read_text())
    for section in ("incus", "guest", "session", "pool", "guac", "portal", "paths"):
        assert section in data, f"{section} missing from config/ontrak.yaml"
