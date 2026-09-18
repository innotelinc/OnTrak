"""Domain models shared by the CLI, the session manager and the portal."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None = None) -> str:
    return (dt or utcnow()).isoformat(timespec="seconds")


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def seconds_since(value: str | None) -> float | None:
    dt = parse_iso(value)
    return None if dt is None else (utcnow() - dt).total_seconds()


class SessionState(str, Enum):
    """Lifecycle of one student's VM.

    Transitions (the session manager enforces these):

        REQUESTED -> ALLOCATING -> PROVISIONING -> READY -> IN_USE
        IN_USE -> CHECKING -> IN_USE | PASSED | FAILED
        any -> RECYCLING -> DESTROYED
        any -> ERROR
    """

    REQUESTED = "requested"
    ALLOCATING = "allocating"
    PROVISIONING = "provisioning"
    READY = "ready"
    IN_USE = "in_use"
    CHECKING = "checking"
    PASSED = "passed"
    FAILED = "failed"
    RECYCLING = "recycling"
    DESTROYED = "destroyed"
    ERROR = "error"

    @property
    def is_live(self) -> bool:
        """True while the student can still be handed this VM."""
        return self in {
            SessionState.REQUESTED,
            SessionState.ALLOCATING,
            SessionState.PROVISIONING,
            SessionState.READY,
            SessionState.IN_USE,
            SessionState.CHECKING,
        }

    @property
    def is_terminal(self) -> bool:
        return self in {SessionState.DESTROYED, SessionState.ERROR}

    @property
    def needs_instance(self) -> bool:
        return self in {
            SessionState.ALLOCATING,
            SessionState.PROVISIONING,
            SessionState.READY,
            SessionState.IN_USE,
            SessionState.CHECKING,
        }


class Category(str, Enum):
    """Scenario families. Mirrors the training needs survey."""

    HARDWARE = "hardware"
    SOFTWARE = "software"
    NETWORK = "network"
    OS = "os"
    SECURITY = "security"
    IDENTITY = "identity"


CATEGORY_LABELS: dict[str, str] = {
    Category.HARDWARE.value: "Hardware & drivers",
    Category.SOFTWARE.value: "Applications & settings",
    Category.NETWORK.value: "Network & connectivity",
    Category.OS.value: "Boot & performance",
    Category.SECURITY.value: "Security incidents",
    Category.IDENTITY.value: "Identity & access",
}


@dataclass
class Objective:
    """One gradeable goal inside a scenario."""

    id: str
    text: str
    weight: float = 10.0
    critical: bool = False
    hint: str = ""

    @classmethod
    def from_dict(cls, data: dict) -> Objective:
        return cls(
            id=str(data["id"]),
            text=str(data.get("text", data["id"])),
            weight=float(data.get("weight", 10)),
            critical=bool(data.get("critical", False)),
            hint=str(data.get("hint", "")),
        )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "text": self.text,
            "weight": self.weight,
            "critical": self.critical,
            "hint": self.hint,
        }


@dataclass
class CheckOutcome:
    """What the guest reported for a single objective."""

    objective_id: str
    passed: bool
    detail: str = ""
    weight: float = 0.0
    critical: bool = False
    reported: bool = True

    def to_dict(self) -> dict:
        return {
            "objective_id": self.objective_id,
            "passed": self.passed,
            "detail": self.detail,
            "weight": self.weight,
            "critical": self.critical,
            "reported": self.reported,
        }

    @classmethod
    def from_dict(cls, data: dict) -> CheckOutcome:
        return cls(
            objective_id=str(data.get("objective_id", "")),
            passed=bool(data.get("passed", False)),
            detail=str(data.get("detail", "")),
            weight=float(data.get("weight", 0.0)),
            critical=bool(data.get("critical", False)),
            reported=bool(data.get("reported", True)),
        )


@dataclass
class ScoreReport:
    """Result of grading a session against its scenario."""

    session_id: int
    scenario_id: str
    score: float = 0.0
    resolved: bool = False
    outcomes: list[CheckOutcome] = field(default_factory=list)
    created_at: str = field(default_factory=iso)
    error: str = ""
    notes: list[str] = field(default_factory=list)
    # The grade is a blend: the machine state checked in the guest, plus the ticket
    # the student wrote. They are kept apart as well as combined, so feedback can
    # say which half was weak and a report can be audited later.
    machine_score: float = 0.0
    ticket_score: float | None = None
    ticket_weight: float = 0.0
    ticket_outcomes: list[dict] = field(default_factory=list)

    @property
    def passed_count(self) -> int:
        return sum(1 for o in self.outcomes if o.passed)

    @property
    def failed(self) -> list[CheckOutcome]:
        return [o for o in self.outcomes if not o.passed]

    def summary_line(self) -> str:
        if self.error:
            return f"grading failed: {self.error}"
        return f"{self.score:.0f}% ({self.passed_count}/{len(self.outcomes)} objectives)"

    @property
    def has_ticket(self) -> bool:
        return self.ticket_score is not None

    def breakdown(self) -> str:
        """One line naming each half of a blended grade."""
        if not self.has_ticket:
            return f"machine {self.score:.0f}%"
        return (
            f"machine {self.machine_score:.0f}% x {100 - self.ticket_weight:.0f}% "
            f"+ ticket {self.ticket_score:.0f}% x {self.ticket_weight:.0f}% "
            f"= {self.score:.0f}%"
        )

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "scenario_id": self.scenario_id,
            "score": self.score,
            "resolved": self.resolved,
            "created_at": self.created_at,
            "error": self.error,
            "notes": list(self.notes),
            "outcomes": [o.to_dict() for o in self.outcomes],
            "machine_score": self.machine_score,
            "ticket_score": self.ticket_score,
            "ticket_weight": self.ticket_weight,
            "ticket_outcomes": [dict(o) for o in self.ticket_outcomes],
        }

    @classmethod
    def from_dict(cls, data: dict) -> ScoreReport:
        return cls(
            session_id=int(data.get("session_id", 0)),
            scenario_id=str(data.get("scenario_id", "")),
            score=float(data.get("score", 0.0)),
            resolved=bool(data.get("resolved", False)),
            created_at=str(data.get("created_at", iso())),
            error=str(data.get("error", "")),
            notes=[str(n) for n in data.get("notes", [])],
            outcomes=[CheckOutcome.from_dict(o) for o in data.get("outcomes", [])],
            machine_score=float(data.get("machine_score", data.get("score", 0.0))),
            ticket_score=(
                None if data.get("ticket_score") is None else float(data["ticket_score"])
            ),
            ticket_weight=float(data.get("ticket_weight", 0.0)),
            ticket_outcomes=[dict(o) for o in data.get("ticket_outcomes", []) if isinstance(o, dict)],
        )


@dataclass
class Session:
    """A student's claimed VM."""

    id: int | None
    student: str
    scenario_id: str
    state: SessionState = SessionState.REQUESTED
    instance: str = ""
    host_ip: str = ""
    rdp_user: str = ""
    rdp_password: str = ""
    hint_level: int = 0
    checks_run: int = 0
    best_score: float = 0.0
    resolved: bool = False
    notes: str = ""
    error: str = ""
    created_at: str = field(default_factory=iso)
    ready_at: str = ""
    expires_at: str = ""
    last_activity_at: str = field(default_factory=iso)
    last_report: ScoreReport | None = None
    # The catalog entry the student picked. Empty means "the scenario's own default",
    # which is how scenarios built before the catalog existed keep working.
    workload: str = ""
    # The time limit the student was given, in minutes. 0 means the site default
    # (session.ttl_minutes) was used. Kept so the portal can show what was granted
    # and so extending a session is auditable.
    time_limit_minutes: int = 0

    @property
    def is_expired(self) -> bool:
        exp = parse_iso(self.expires_at)
        return exp is not None and utcnow() > exp

    def seconds_remaining(self) -> int | None:
        exp = parse_iso(self.expires_at)
        if exp is None:
            return None
        return max(0, int((exp - utcnow()).total_seconds()))

    def extend(self, minutes: int) -> None:
        base = parse_iso(self.expires_at) or utcnow()
        self.expires_at = iso(max(base, utcnow()) + timedelta(minutes=minutes))
        if self.time_limit_minutes:
            self.time_limit_minutes += int(minutes)

    def set_time_limit(self, minutes: int) -> None:
        """Reset the clock to ``minutes`` from now (used when a limit is chosen)."""
        self.time_limit_minutes = int(minutes)
        self.expires_at = iso(utcnow() + timedelta(minutes=int(minutes)))
        self.last_activity_at = iso()

    def to_dict(self, include_secrets: bool = False) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "student": self.student,
            "scenario_id": self.scenario_id,
            "state": self.state.value,
            "instance": self.instance,
            "host_ip": self.host_ip,
            "hint_level": self.hint_level,
            "checks_run": self.checks_run,
            "best_score": self.best_score,
            "resolved": self.resolved,
            "error": self.error,
            "created_at": self.created_at,
            "ready_at": self.ready_at,
            "expires_at": self.expires_at,
            "last_activity_at": self.last_activity_at,
            "seconds_remaining": self.seconds_remaining(),
            "workload": self.workload,
            "time_limit_minutes": self.time_limit_minutes,
        }
        if include_secrets:
            data["rdp_user"] = self.rdp_user
            data["rdp_password"] = self.rdp_password
        return data
