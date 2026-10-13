"""Lessons: the command walkthroughs a scenario can point a student at.

A lesson is a *teaching* artefact, deliberately separate from a scenario:

``scenarios/linux-perms-chmod-repair``
    A broken machine and a grade. The student is expected to already know, or
    work out, what to do.
``lessons/linux-permissions``
    The same subject taught: what the bits mean, what each command does, a
    worked example and two exercises with the answer hidden behind a click.

Keeping them apart is what lets one lesson be referenced by several scenarios
(permissions are needed by the chmod fault, the deployment fault and the web
root fault) without the teaching text being duplicated or drifting.

Lessons are authored as YAML under ``lessons/`` so a trainer can add one without
touching Python::

    lessons/linux-permissions.yaml
        id: linux-permissions
        title: File permissions with chmod
        platform: linux
        commands:
          - command: chmod 640 file
            what: owner read+write, group read, nobody else
        steps:
          - title: Read the mode
            body: ...
        exercises:
          - id: tighten
            prompt: ...
            solution: ...

The portal renders them (``/lessons``) and the CLI prints them
(``ontrak lesson show``), including from inside a live session, which is when a
student actually wants them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .scenarios import LINUX, PLATFORMS

LESSON_SUFFIXES = (".yaml", ".yml")

# Command ids and exercise ids become anchors in the page and keys in URLs.
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class LessonError(RuntimeError):
    """Raised when a lesson is missing or malformed."""


@dataclass
class LessonCommand:
    """One command worth knowing, with what it does and a worked example."""

    command: str
    what: str
    example: str = ""
    danger: str = ""

    @classmethod
    def from_dict(cls, data: dict) -> LessonCommand:
        return cls(
            command=str(data.get("command") or "").strip(),
            what=str(data.get("what") or "").strip(),
            example=str(data.get("example") or "").strip(),
            # Filled in for the commands that can destroy a machine: shown in the
            # CLI and the portal next to the command, not buried in prose.
            danger=str(data.get("danger") or "").strip(),
        )

    def to_dict(self) -> dict:
        return {
            "command": self.command,
            "what": self.what,
            "example": self.example,
            "danger": self.danger,
        }


@dataclass
class LessonStep:
    """A narrative step: read this, then try that."""

    title: str
    body: str = ""
    command: str = ""

    @classmethod
    def from_dict(cls, data: dict) -> LessonStep:
        return cls(
            title=str(data.get("title") or "").strip(),
            body=str(data.get("body") or "").strip(),
            command=str(data.get("command") or "").strip(),
        )

    def to_dict(self) -> dict:
        return {"title": self.title, "body": self.body, "command": self.command}


@dataclass
class LessonExercise:
    """A practice task with an answer and a way to check it.

    ``verify`` is a shell snippet the student runs *in the lab machine* to see
    whether they got it right, so the lesson teaches self-verification rather
    than "ask the instructor".
    """

    id: str
    prompt: str
    solution: str = ""
    verify: str = ""

    @classmethod
    def from_dict(cls, data: dict) -> LessonExercise:
        return cls(
            id=str(data.get("id") or "").strip(),
            prompt=str(data.get("prompt") or "").strip(),
            solution=str(data.get("solution") or "").strip(),
            verify=str(data.get("verify") or "").strip(),
        )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "prompt": self.prompt,
            "solution": self.solution,
            "verify": self.verify,
        }


@dataclass
class Lesson:
    id: str
    title: str
    platform: str = LINUX
    summary: str = ""
    category: str = ""
    difficulty: int = 1
    minutes: int = 10
    prerequisites: list[str] = field(default_factory=list)
    objectives: list[str] = field(default_factory=list)
    commands: list[LessonCommand] = field(default_factory=list)
    steps: list[LessonStep] = field(default_factory=list)
    exercises: list[LessonExercise] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    docs: list[str] = field(default_factory=list)
    path: Path | None = None

    @property
    def is_linux(self) -> bool:
        return self.platform == LINUX

    def all_shell(self) -> str:
        """Every command in the lesson, in order, as a paste-able block."""
        lines = [c.command for c in self.commands if c.command]
        lines += [s.command for s in self.steps if s.command]
        return "\n".join(lines)

    def public(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "platform": self.platform,
            "summary": self.summary,
            "category": self.category,
            "difficulty": self.difficulty,
            "minutes": self.minutes,
            "prerequisites": list(self.prerequisites),
            "objectives": list(self.objectives),
            "commands": [c.to_dict() for c in self.commands],
            "steps": [s.to_dict() for s in self.steps],
            "exercises": [e.to_dict() for e in self.exercises],
            "tags": list(self.tags),
            "docs": list(self.docs),
        }


class LessonRepository:
    """Loads ``lessons/*.yaml``; missing directory is not an error."""

    def __init__(self, root: str | Path):
        self.root = Path(root)
        self._lessons: dict[str, Lesson] | None = None

    # -- loading -------------------------------------------------------
    def load(self, force: bool = False) -> dict[str, Lesson]:
        if self._lessons is None or force:
            self._lessons = self._discover()
        return self._lessons

    def reload(self) -> dict[str, Lesson]:
        return self.load(force=True)

    def _discover(self) -> dict[str, Lesson]:
        found: dict[str, Lesson] = {}
        if not self.root.exists():
            return found
        for path in sorted(self.root.iterdir()):
            if path.suffix.lower() not in LESSON_SUFFIXES or not path.is_file():
                continue
            lesson = self._load_one(path)
            found[lesson.id] = lesson
        return found

    def _load_one(self, path: Path) -> Lesson:
        try:
            data = yaml.safe_load(path.read_text()) or {}
        except yaml.YAMLError as exc:
            raise LessonError(f"{path}: invalid YAML: {exc}") from exc
        if not isinstance(data, dict):
            raise LessonError(f"{path}: top level must be a mapping")
        lesson_id = str(data.get("id") or path.stem)
        return Lesson(
            id=lesson_id,
            title=str(data.get("title") or lesson_id),
            platform=str(data.get("platform") or LINUX).strip().lower(),
            summary=str(data.get("summary") or "").strip(),
            category=str(data.get("category") or "").strip(),
            difficulty=int(data.get("difficulty", 1)),
            minutes=int(data.get("minutes", 10)),
            prerequisites=[str(p) for p in (data.get("prerequisites") or [])],
            objectives=[str(o) for o in (data.get("objectives") or [])],
            commands=[LessonCommand.from_dict(c) for c in (data.get("commands") or []) if isinstance(c, dict)],
            steps=[LessonStep.from_dict(s) for s in (data.get("steps") or []) if isinstance(s, dict)],
            exercises=[
                LessonExercise.from_dict(e) for e in (data.get("exercises") or []) if isinstance(e, dict)
            ],
            tags=[str(t) for t in (data.get("tags") or [])],
            docs=[str(d) for d in (data.get("docs") or [])],
            path=path,
        )

    # -- access --------------------------------------------------------
    def get(self, lesson_id: str) -> Lesson:
        lessons = self.load()
        if lesson_id not in lessons:
            raise LessonError(
                f"unknown lesson {lesson_id!r}; available: {', '.join(sorted(lessons)) or 'none'}"
            )
        return lessons[lesson_id]

    def find(self, lesson_id: str) -> Lesson | None:
        return self.load().get(lesson_id)

    def list(self) -> list[Lesson]:
        return sorted(self.load().values(), key=lambda lesson: (lesson.platform, lesson.id))

    def ids(self) -> list[str]:
        return [lesson.id for lesson in self.list()]

    def for_scenario(self, lesson_ids: list[str]) -> list[Lesson]:
        """Resolve a scenario's ``lessons:`` list, skipping ids that are missing.

        Missing ids are reported by :meth:`ScenarioRepository.validate` at build
        time; at request time a stale id must not break a student's page.
        """
        lessons = self.load()
        return [lessons[i] for i in lesson_ids if i in lessons]

    def by_platform(self) -> dict[str, list[Lesson]]:
        grouped: dict[str, list[Lesson]] = {}
        for lesson in self.list():
            grouped.setdefault(lesson.platform, []).append(lesson)
        return grouped

    # -- validation ----------------------------------------------------
    def validate(self) -> list[str]:
        """Human-readable problems; empty means healthy. Mirrors scenario validation."""
        problems: list[str] = []
        try:
            lessons = self.load(force=True)
        except LessonError as exc:
            return [str(exc)]
        for lesson in lessons.values():
            prefix = f"[lesson {lesson.id}]"
            if not _ID_RE.match(lesson.id):
                problems.append(f"{prefix} id must be lowercase and dash-separated")
            if lesson.path is not None and lesson.path.stem != lesson.id:
                problems.append(
                    f"{prefix} file is {lesson.path.name!r} but id is {lesson.id!r}; "
                    "the two must match so `ontrak lesson show <id>` finds it"
                )
            if lesson.platform not in PLATFORMS:
                problems.append(
                    f"{prefix} platform must be one of: {', '.join(PLATFORMS)}"
                )
            if not lesson.summary:
                problems.append(f"{prefix} needs a summary (one sentence, shown in the list)")
            if not 1 <= lesson.difficulty <= 4:
                problems.append(f"{prefix} difficulty must be 1..4")
            if lesson.minutes <= 0:
                problems.append(f"{prefix} minutes must be positive")
            if not lesson.commands and not lesson.steps:
                problems.append(f"{prefix} teaches nothing: add commands and/or steps")
            if not lesson.exercises:
                problems.append(
                    f"{prefix} has no exercises; a lesson students cannot practise is a read-through"
                )
            seen_commands: set[str] = set()
            for command in lesson.commands:
                if not command.command:
                    problems.append(f"{prefix} a commands entry has no 'command'")
                if not command.what:
                    problems.append(
                        f"{prefix} command {command.command!r} does not say what it does"
                    )
                key = command.command.strip()
                if key in seen_commands:
                    problems.append(f"{prefix} duplicate command entry {key!r}")
                seen_commands.add(key)
            seen_exercises: set[str] = set()
            for exercise in lesson.exercises:
                if not _ID_RE.match(exercise.id or ""):
                    problems.append(
                        f"{prefix} exercise id {exercise.id!r} must be lowercase and dash-separated"
                    )
                if not exercise.prompt:
                    problems.append(f"{prefix} exercise {exercise.id!r} has no prompt")
                if not exercise.solution:
                    problems.append(
                        f"{prefix} exercise {exercise.id!r} has no solution; students check "
                        "themselves against it"
                    )
                if exercise.id in seen_exercises:
                    problems.append(f"{prefix} duplicate exercise id {exercise.id!r}")
                seen_exercises.add(exercise.id)
        for lesson in lessons.values():
            for prerequisite in lesson.prerequisites:
                if prerequisite not in lessons:
                    problems.append(
                        f"[lesson {lesson.id}] prerequisite {prerequisite!r} is not a lesson"
                    )
                elif prerequisite == lesson.id:
                    problems.append(f"[lesson {lesson.id}] lists itself as a prerequisite")
        return problems


def default_lesson_repository(settings) -> LessonRepository:
    return LessonRepository(settings.lessons_dir)
