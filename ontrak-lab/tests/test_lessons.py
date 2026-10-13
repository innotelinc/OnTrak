"""Lessons: the walkthroughs a scenario points a student at.

Two things are worth testing beyond "does it load": that the *shipped* library
validates (a lesson with no exercises is a read-through, and a scenario that links a
lesson which does not exist sends a student to a 404 mid-ticket), and that the
validator actually rejects a broken lesson rather than shrugging.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ontrak.catalog import Catalog
from ontrak.lessons import LessonError, LessonRepository
from ontrak.scenarios import ScenarioRepository
from tests.conftest import REPO_ROOT


@pytest.fixture()
def lessons(settings):
    return LessonRepository(settings.lessons_dir)


def test_the_shipped_library_validates(lessons):
    assert lessons.validate() == []
    assert len(lessons.list()) >= 5


def test_linux_and_windows_are_both_taught(lessons):
    platforms = {lesson.platform for lesson in lessons.list()}
    assert {"linux", "windows"} <= platforms


def test_every_lesson_has_commands_exercises_and_answers(lessons):
    for lesson in lessons.list():
        assert lesson.commands or lesson.steps, lesson.id
        assert lesson.exercises, lesson.id
        for exercise in lesson.exercises:
            assert exercise.solution.strip(), f"{lesson.id}/{exercise.id} has no answer"
            assert exercise.prompt.strip(), f"{lesson.id}/{exercise.id} has no prompt"


def test_dangerous_commands_are_flagged(lessons):
    """Some of these commands can destroy a machine, and the library says so."""
    flagged = {
        command.command
        for lesson in lessons.list()
        for command in lesson.commands
        if command.danger
    }
    assert any(command.startswith("rm ") for command in flagged)
    assert any("userdel" in command for command in flagged)


def test_prerequisites_resolve(lessons):
    for lesson in lessons.list():
        for prerequisite in lesson.prerequisites:
            assert lessons.find(prerequisite) is not None, f"{lesson.id} -> {prerequisite}"


def test_missing_lessons_directory_is_not_an_error(tmp_path):
    repository = LessonRepository(tmp_path / "nope")
    assert repository.list() == []
    assert repository.validate() == []


def test_get_unknown_lesson_explains_itself(lessons):
    with pytest.raises(LessonError, match="unknown lesson"):
        lessons.get("does-not-exist")


def test_every_scenario_lesson_link_exists(settings, lessons):
    """A dead link in a hint is a support call, so validation checks the other side too."""
    repository = ScenarioRepository(settings.scenarios_dir)
    catalog = Catalog(settings.catalog_dir)
    assert repository.validate(catalog=catalog, lessons=lessons) == []
    for scenario in repository.list():
        for lesson_id in scenario.lessons:
            assert lessons.find(lesson_id) is not None, f"{scenario.id} -> {lesson_id}"


def test_a_linux_scenario_with_hints_must_name_a_lesson(settings, tmp_path, lessons):
    """Handing a student a command-line fault with no way to learn it is unfair."""
    import shutil

    scenarios_dir = tmp_path / "scenarios"
    shutil.copytree(settings.scenarios_dir, scenarios_dir)
    manifest = scenarios_dir / "linux-perms-chmod-repair" / "scenario.yaml"
    text = manifest.read_text().replace("lessons: [linux-permissions, linux-files-and-dirs]", "")
    manifest.write_text(text)

    problems = ScenarioRepository(scenarios_dir).validate(lessons=lessons)
    assert any("names no lessons" in problem for problem in problems)


def test_lesson_written_in_the_wrong_filename_is_reported(tmp_path):
    (tmp_path / "mismatch.yaml").write_text(
        """
id: something-else
title: Mismatch
platform: linux
summary: The id and the filename disagree.
commands:
  - command: ls
    what: list
exercises:
  - id: one
    prompt: do it
    solution: ls
"""
    )
    problems = LessonRepository(tmp_path).validate()
    assert any("the two must match" in problem for problem in problems)


def test_lesson_without_exercises_is_reported(tmp_path):
    (tmp_path / "reading.yaml").write_text(
        """
id: reading
title: A read-through
platform: linux
summary: No practice.
steps:
  - title: Read this
    body: There is nothing to do.
"""
    )
    problems = LessonRepository(tmp_path).validate()
    assert any("no exercises" in problem for problem in problems)


def test_self_prerequisite_is_reported(tmp_path):
    (tmp_path / "loop.yaml").write_text(
        """
id: loop
title: Loop
platform: linux
summary: Depends on itself.
prerequisites: [loop]
commands:
  - command: ls
    what: list
exercises:
  - id: one
    prompt: do it
    solution: ls
"""
    )
    problems = LessonRepository(tmp_path).validate()
    assert any("lists itself" in problem for problem in problems)


def test_shell_block_collects_commands_in_order(lessons):
    lesson = lessons.get("linux-permissions")
    block = lesson.all_shell()
    assert "chmod" in block
    first, second = lesson.commands[0].command, lesson.commands[1].command
    assert block.index(first) < block.index(second)


def test_the_repo_lessons_directory_is_where_config_points(settings, lessons):
    assert settings.lessons_dir == REPO_ROOT / "lessons"
    assert Path(lessons.root).is_dir()
