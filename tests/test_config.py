from __future__ import annotations

import re

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


def test_the_shipped_env_template_is_loadable():
    """`.env` is generated from `.env.example`, so the app must be able to read it.

    The first run copies the template into `.env` and both the container stack and
    the host CLI read that file. A key in it that `load_settings` does not know is
    therefore not a typo warning — it is a first run that fails at boot, which is
    how `ONTRAK_GUAC__PUBLIC_PORT` (read by compose, rejected by GuacConfig) got
    caught: `docker compose up` was fine, the portal container was fine, and every
    host command died on a setting the documentation told operators to set. That
    key is gone now — the console is a path on the stack's single published port,
    not a service with a port of its own — and this test is what keeps its
    replacement honest.
    """
    from pathlib import Path

    template = Path(__file__).resolve().parent.parent / ".env.example"
    # Values may legitimately be blank (the secrets are filled in by the first
    # run), but every key must be one the app can read.
    listed = dict(re.findall(r"^([A-Z][A-Z0-9_]*)=(.*)$", template.read_text(), re.MULTILINE))
    for secret in ("ONTRAK_GUAC__SECRET_KEY", "ONTRAK_PORTAL__SECRET"):
        assert secret in listed, f"the template stopped listing {secret}"

    filled = {key: value for key, value in listed.items() if value.strip()}
    settings = load_settings(path=None, environ=dict(filled))

    # Spot-check that the values arrived rather than being swallowed. The console
    # address is the one the stack's gateway is configured against: a template
    # that listed it under a name the app could not read would send students to a
    # path that answers nothing. The shipped value is `auto` — the console follows
    # the address the student reached the portal on, which is what makes one
    # checkout work on a laptop, a LAN and a TLS host — so an absolute URL (what a
    # deployment behind an edge sets) is the other accepted shape.
    assert settings.guac.base_url == "auto" or settings.guac.base_url.endswith("/guacamole/")
    assert settings.guac.recording is False
    assert settings.session.ttl_minutes == 90
    assert settings.pool.targets == {}


def test_a_quoted_env_value_is_the_value_not_the_quotes():
    """`'[45, 90, 180]'` is the list, in a file that is both sourced *and* parsed.

    `.env.example` has to be valid shell and valid config at once: bash needs quotes
    around a value with a space or a comma in it, while YAML would read
    `'[45, 90, 180]'` as the *string* `"[45, 90, 180]"` — a time-limit list whose
    first entry is `[`, on every command that read it, with nothing in the failure
    pointing back at the quotes. The shell quotes are stripped before the YAML parse,
    which is what lets one file be both.
    """
    from ontrak.config import _parse_env_value

    assert _parse_env_value("'[45, 90, 180]'") == [45, 90, 180]
    assert _parse_env_value('"IT support range"') == "IT support range"
    assert _parse_env_value("90") == 90
    assert _parse_env_value("auto") == "auto"
    assert _parse_env_value("false") is False
    # `ONTRAK_GUEST__PASSWORD=` is an empty *string*, not the string "None": every
    # field it lands in is typed `str`, and `require_secrets` has to see it as unset.
    assert _parse_env_value("") == ""
    assert _parse_env_value("''") == ""


def test_the_shipped_env_template_sources_without_a_shell_error():
    """`set -a; . ./.env; set +a` is documented, so every line has to survive it.

    An unquoted value with a space is not an assignment to bash: it runs the second
    word as a *command*, prints `support: command not found`, and carries on with a
    half-set environment — one stray line, and then every command that follows runs
    against the shipped defaults instead of the operator's. `set -e` turns that into
    the failure this test wants, and the quoted values it reads back are the two the
    template used to carry unquoted.
    """
    import shutil
    import subprocess
    from pathlib import Path

    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash is not on this host, and this test is about bash")

    template = Path(__file__).resolve().parent.parent / ".env.example"
    script = (
        "set -eu; set -a; . \"$1\" >/dev/null; set +a; "
        "printf '%s\\n' \"$ONTRAK_SESSION__TIME_LIMIT_CHOICES\" \"$ONTRAK_PORTAL__BRAND_NOTE\""
    )
    done = subprocess.run(
        [bash, "-c", script, "bash", str(template)], capture_output=True, text=True
    )
    assert done.returncode == 0, f"sourcing .env.example failed: {done.stderr.strip()}"
    assert done.stderr == "", f"sourcing .env.example printed: {done.stderr.strip()}"
    assert done.stdout.splitlines() == [
        "[45, 90, 180]",
        "IT support training range — powered by Innotel OnTrak",
    ]

    # And the app reads the same two lines to the values they look like, quotes and all.
    listed = dict(re.findall(r"^([A-Z][A-Z0-9_]*)=(.*)$", template.read_text(), re.MULTILINE))
    settings = load_settings(
        path=None,
        environ={
            "ONTRAK_SESSION__TIME_LIMIT_CHOICES": listed["ONTRAK_SESSION__TIME_LIMIT_CHOICES"],
            "ONTRAK_PORTAL__BRAND_NOTE": listed["ONTRAK_PORTAL__BRAND_NOTE"],
        },
    )
    assert settings.session.time_limit_choices == [45, 90, 180]
    assert settings.session.default_time_limit == 45
    assert settings.portal.brand_note == "IT support training range — powered by Innotel OnTrak"


def test_bad_key_is_rejected(tmp_path):
    config = tmp_path / "cfg.yaml"
    config.write_text("guest:\n  nope: 1\n")
    with pytest.raises(ConfigError, match="unknown setting"):
        load_settings(path=config, environ={})


def test_a_spent_env_key_names_the_variable_that_carries_it():
    """A leftover `ONTRAK_...` in `.env` must point at the line to delete.

    This is the `ONTRAK_GUAC__PUBLIC_PORT` failure exactly: the value sat in the
    operator's `.env`, every command that loaded config died, and the error named
    `GuacConfig` and a bare field — nothing said which variable, or which file, to
    go and fix. `.env` is exported wholesale, so one spent line is not a stray
    value the loader can ignore: naming it is the difference between a self-
    diagnosing upgrade and a checkout that looks broken for no visible reason.
    """
    with pytest.raises(ConfigError, match=r"unknown setting ONTRAK_GUAC__PUBLIC_PORT"):
        load_settings(path=None, environ={"ONTRAK_GUAC__PUBLIC_PORT": "8081"})


def test_a_section_the_app_does_not_model_is_still_ignored():
    """`ONTRAK_FOO__BAR` addresses nothing the app knows, so it stays ignored.

    Only the app's own sections are held to the strict check. Other tooling shares
    this environment — a name that was never a setting must not become a boot
    failure, or the check would be worse than the problem it reports.
    """
    settings = load_settings(path=None, environ={"ONTRAK_FOO__BAR": "1"})
    assert settings.guac.base_url


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


def test_the_linux_console_is_on_in_the_shipped_configuration():
    """A Linux ticket opens an SSH console out of the box, in both halves of a range.

    The two halves read the setting from different places: `ontrak template build`
    (a host command) reads config/ontrak.yaml, while the portal container reads
    whatever compose forwards from .env. If they disagreed, a host would build a
    template with no sshd while the portal signed an SSH console onto it — a
    console that never opens, for a reason nothing states. So the shipped default is
    asserted in both at once.
    """
    from pathlib import Path

    from ontrak.config import DEFAULT_CONFIG

    assert yaml.safe_load(Path(DEFAULT_CONFIG).read_text())["guac"]["linux_ssh"] is True
    assert load_settings(environ={}).guac.linux_ssh is True

    # .env is generated from .env.example and interpolated by compose, so the
    # template has to carry the same answer the config does.
    template = Path(__file__).resolve().parent.parent / ".env.example"
    listed = dict(re.findall(r"^([A-Z][A-Z0-9_]*)=(.*)$", template.read_text(), re.MULTILINE))
    assert listed["ONTRAK_GUAC__LINUX_SSH"] == "true"
