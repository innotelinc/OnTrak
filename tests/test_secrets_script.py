"""The generation script's half of the stale-setting contract.

``scripts/secrets.sh`` owns ``.env``: it creates it from ``.env.example`` and fills
the blanks. That makes it the one place an upgraded checkout can be told that a
line it is still carrying has stopped meaning anything — the container stack cannot
notice, because compose reads the file as its own variables and never parses it as
settings, so the stack comes up healthy while every host command dies on the key.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "secrets.sh"
EXAMPLE = REPO_ROOT / ".env.example"

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None or shutil.which("openssl") is None,
    reason="scripts/secrets.sh needs bash and openssl",
)


def _run(env_file: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(SCRIPT), str(env_file)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_a_spent_setting_is_reported_and_left_in_place(tmp_path):
    """Reported, never rewritten: the value may be the operator's own.

    The script's contract is that it fills blanks and touches nothing else, so the
    line stays exactly as it was — including when the key it names is one the
    gateway or compose still reads rather than the app.
    """
    env_file = tmp_path / ".env"
    env_file.write_text(EXAMPLE.read_text() + "ONTRAK_GUAC__PUBLIC_PORT=8081\n", encoding="utf-8")

    result = _run(env_file)

    assert result.returncode == 0, result.stderr
    assert "ONTRAK_GUAC__PUBLIC_PORT" in result.stdout
    assert "ONTRAK_GUAC__PUBLIC_PORT=8081" in env_file.read_text(encoding="utf-8")


def test_a_file_copied_from_the_template_reports_nothing(tmp_path):
    """The first-run and CI paths are generated from the template, so they are quiet.

    This is the property that keeps the report usable: a file that was just copied
    from ``.env.example`` has no spent keys, so the warning means something every
    time it appears.
    """
    env_file = tmp_path / ".env"
    env_file.write_text(EXAMPLE.read_text(), encoding="utf-8")

    result = _run(env_file)

    assert result.returncode == 0, result.stderr
    assert "does not list" not in result.stdout
