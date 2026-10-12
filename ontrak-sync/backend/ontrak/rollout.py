"""Ontrak Sync — keeping a container current, across the whole Network, without a person watching.

A scan answers "which images are behind". Answering it is where this project used to
stop: every recreate needed somebody to read a finding and click a button, which is
correct and does not scale to a Network where nothing is allowed to sit on a known
vulnerable base image for three weeks because nobody opened the dashboard.

So this is the other half — the Watchtower half: given a container **this deployment
has been given**, keep it on its tag's current image on a timer, and undo it when the
new image does not come up. It is a *roll*, not a blind pull-and-restart, and the
difference is entirely in the rails below.

WHAT "OWNED" MEANS, AND WHY IT IS FIRST
---------------------------------------
Nothing here acts on a container nobody claimed. `db.rollout_targets` is the remit:
a (host, incus container, image ref) triple that a person named, with the note saying
who gave it up. A rollout run walks *the remit*, never "every container on the
Network" — so the set of things this code can touch is a list somebody wrote, which
is the only version of "whole-network protection" that is not also whole-network
risk. Claiming is per image ref, because a stack that shares one image with its sidecar
should not have to give up both.

THE RAILS, AND WHAT EACH ONE PREVENTS
-------------------------------------
Every one of these exists because unattended container updating has a specific way of
taking a Network down:

  * **The kill switch** (`RolloutConfig.enabled`, off unless configured) — the feature
    ships inert, so enabling it is a decision rather than an upgrade.
  * **Manual-only remits** — a container can be *watched* (findings still raised) and
    not rolled. Some things want a human every time; this is how to say so without
    losing the alert.
  * **The window and the freeze**, read from the deployment's `Policy` — the same hours
    that govern package work, and the same moratorium. A second window concept would
    eventually disagree with the first one.
  * **The cooldown** — a rolled container is left alone for a day. Without it, a tag
    that is being re-published twice an hour (or a build that publishes the same tag
    with different bytes) becomes a container restarted twice an hour, which reads as
    a broken service rather than as an update loop.
  * **Batch and per-host caps** — "roll everything at once" turns one bad image into a
    Network outage. Three per run, two per host, is the shipped posture.
  * **Protected refs** — a configured list that is never rolled automatically. The
    database, the gateway, whatever an operator knows they want a person on.
  * **Unjudged is not current** — `behind` is three-valued, exactly as
    `scanners.image_is_behind` is. A registry that refused a token, an image built
    locally and a multi-arch tag left deferred all read as *unknown*, and nothing is
    rolled on an unknown. Collapsing that into "up to date" is the failure mode this
    project's README is written about, and collapsing it into "roll it" would be the
    same bug with the sign flipped.
  * **A refused compose plan** — the reconcile refusal the applier already makes is
    honoured here *before* anything is stopped, so a rollout cannot become the thing
    that takes a service down on its way past.
  * **The health gate, and the rollback behind it** — a roll is not finished when
    `compose up` returns. The new container has to come up: `running`, and `healthy`
    when the image defines a healthcheck. If it does not, the previous image goes back
    and *that* is what is recorded — never "rolled, probably fine".
  * **Blocked after a failure** — a container whose roll had to be rolled back is not
    retried on the next timer. It is a decision somebody has to make (fix the image, or
    release the remit), because a roll that fails once will fail every night.

`policy.Cron` is reused for the schedule and `Policy` for the window, so the operator
has one timer and one set of hours. What is new here is the per-container remit and the
decision — both pure, both replayable in a test, which is what makes "it did not touch
that container" checkable rather than claimed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from .policy import Policy

# ── why a container was left alone ───────────────────────────────────────────
# Codes rather than sentences, because the dashboard groups by them and a sentence
# is what gets rendered from the code — see `describe`. A rollout run that does
# nothing is the normal case, and it has to be able to say *which* nothing.
NOT_OWNED = "not-owned"
HOST_NOT_CONFIGURED = "host-not-configured"
# Owned, behind, and nothing is running it: an image that was pulled and never started,
# or a container somebody stopped. There is nothing to restart, and saying so is more use
# than reporting it current — the finding is real and the remit is stale.
NOT_RUNNING = "not-running"
DISABLED = "rollout-disabled"
MANUAL_ONLY = "manual-only"
PROTECTED = "protected-image"
UNJUDGED = "registry-could-not-judge"
CURRENT = "already-current"
OUTSIDE_WINDOW = "outside-window"
FREEZE = "change-freeze"
COOLDOWN = "cooldown"
BLOCKED = "blocked-after-failure"
BATCH_LIMIT = "batch-limit"
HOST_LIMIT = "host-limit"
PLAN_REFUSED = "compose-plan-refused"
ROLL = "roll"

# Every code that means "this one is going to be rolled", as a set, so a caller can
# ask `is_roll(decision.code)` instead of comparing to the one constant and getting a
# second code wrong later.
ROLLING = frozenset({ROLL})

# Every code a `RollDecision` can carry, declared once. A dashboard grouping by code, a
# test asserting each one has a label, and a run report counting refusals all need the
# closed set, and three copies of it would drift the first time a rail was added.
REFUSAL_CODES = frozenset({
    NOT_OWNED, HOST_NOT_CONFIGURED, DISABLED, MANUAL_ONLY, NOT_RUNNING,
    PROTECTED, UNJUDGED, CURRENT, OUTSIDE_WINDOW, FREEZE, COOLDOWN, BLOCKED,
    BATCH_LIMIT, HOST_LIMIT, PLAN_REFUSED,
})
DECISION_CODES = REFUSAL_CODES | {ROLL}

# ── how a roll ended, as the `container_rolls.state` column spells it ─────────
# Three, and no fourth for "probably fine": a roll that could not be verified lands on one
# of the bad two, because the cooldown and the block-after-failure rail both read this
# column and a hopeful value would defeat both.
ROLLING_ROW = "rolling"          # written before anything is stopped; see db.start_container_roll
ROLLED = "rolled"                # the new container came up and the health gate passed
ROLLED_BACK = "rolled-back"      # it did not, and the previous image is running again
ROLL_FAILED = "failed"           # it did not, and nothing could put the old one back
# The attempt never got as far as the container: the registry refused the pull, or the
# plan it would have recreated from could not be read. Kept apart from `failed` because
# the two must not block the same way — a throttled registry clears on its own, a service
# that will not start does not, and a rail that treated them alike would either retry a
# broken image every night or give up on a rate limit.
ROLL_UNTOUCHED = "untouched"

# WHICH OF THOSE HOLD A CONTAINER BACK is the store's business rather than this file's:
# `db.container_roll_blocker` and `db.rollout_history` fold the history and are the ones
# that decide, because "has this been cleared" is a column and not a decision. The set is
# pinned by a test rather than by a constant in two places — see
# `test_rollout_apply.TheRecord.test_the_states_that_hold_a_container_back`.
#
#   blocked: rolled-back, failed, rolling      (a roll that changed it and ended badly,
#                                              or a row that opened and never closed)
#   not blocked: rolled, untouched             (it worked; or it never got that far)

# ── how a container came up ──────────────────────────────────────────────────
# Three answers, and the third is the one that matters: a container that is still
# starting at the end of the grace period is not up, and calling it up because it has
# not *failed* yet would leave a Network of crash-looping containers and a green
# dashboard.
UP = "up"
DOWN = "down"
STARTING = "starting"


@dataclass(frozen=True)
class RolloutConfig:
    """What this deployment is willing to do unattended.

    Read from the environment (`Settings.rollout_*`) and passed in rather than looked
    up here, so a test can replay any posture without a settings object — which is the
    same reason `Policy` is a parameter and not a global.
    """

    enabled: bool = False
    max_per_run: int = 3
    max_per_host: int = 2
    cooldown_hours: int = 24
    # How long a new container is given to become `running` and, when the image
    # defines one, `healthy`. A recreate that returns before the daemon is actually
    # serving is how a rollout reports success over a service that never started.
    health_grace_seconds: int = 90
    # Images that are never rolled automatically, whatever the remit says. Matched on
    # the ref as written (`postgres:16`), which is the string an operator recognises.
    protected_refs: tuple[str, ...] = ()
    # Who fills the remit: `off` (a person claims every row), `watched` (the scans fill
    # it, nothing rolls until somebody says so) or `unattended` (the scans fill it and
    # it rolls). The two properties below are the only places that spelling is read, so
    # a rail can ask `config.adopting` and never compare strings.
    adopt: str = "off"

    @property
    def adopting(self) -> bool:
        """Does this deployment claim what the scans find?

        Spelled as a list of the postures that adopt rather than as `!= "off"`, because
        the safe answer to a value this code does not recognise is *not to adopt*. A
        dataclass built by hand — a test, a future caller — with a typo in `adopt` would
        otherwise claim a Network on the strength of a misspelling. `config.py` refuses
        an unknown mode at boot; this is the second lock on the same door.
        """
        return self.adopt in ("watched", "unattended")

    @property
    def adopt_auto(self) -> bool:
        """Does what it adopts roll unattended, or is it only watched?"""
        return self.adopt == "unattended"


@dataclass
class Remit:
    """One container this deployment has been given, and the terms it was given on.

    Keyed on (host, container, ref) rather than on the container alone: the same
    image can legitimately run twice on one host under different containers, and a
    remit that could not say which one it meant would roll both.
    """

    host: str
    ref: str
    # The incus container the Docker daemon lives in, or "" when Docker runs on the
    # host itself — the same distinction `targets.kind` already makes for findings.
    container: str = ""
    project: str = ""
    service: str = ""
    # False means watched, not rolled: findings are still raised, a person still
    # clicks. Deliberately the per-remit switch rather than a global one, because
    # "unattended everywhere except these four" is the posture a Network actually
    # wants and a global flag cannot express it.
    auto: bool = True
    # The hours this one is rolled in, when it wants its own rather than the
    # deployment's. Both or neither: a half-written window is a form saved too early,
    # and reading it as "no window" would roll a container the operator was trying to
    # keep out of the maintenance hours.
    window_start_hour: int | None = None
    window_end_hour: int | None = None
    cooldown_hours: int | None = None
    note: str = ""
    created_by: str = ""
    created_at: str = ""

    def key(self) -> tuple[str, str, str]:
        return (self.host, self.container, self.ref)

    def as_dict(self) -> dict:
        return {
            "host": self.host, "ref": self.ref, "container": self.container,
            "project": self.project, "service": self.service, "auto": self.auto,
            "window_start_hour": self.window_start_hour,
            "window_end_hour": self.window_end_hour,
            "cooldown_hours": self.cooldown_hours, "note": self.note,
            "created_by": self.created_by, "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Remit":
        known = {f for f in cls(host="", ref="").__dict__}
        return cls(**{k: v for k, v in (data or {}).items() if k in known})

    def validate(self) -> list[str]:
        """Every complaint at once, like `Policy.validate`."""
        problems: list[str] = []
        if not (self.host or "").strip():
            problems.append("a remit has to name the host the container runs on")
        if not (self.ref or "").strip():
            problems.append("a remit has to name the image ref it owns")
        for label, hour in (("window_start_hour", self.window_start_hour),
                            ("window_end_hour", self.window_end_hour)):
            if hour is not None and not 0 <= hour <= 23:
                problems.append(f"{label} must be 0-23, not {hour}")
        if bool(self.window_start_hour is not None) != bool(self.window_end_hour is not None):
            problems.append("a per-container window needs both an opening and a closing hour")
        if self.cooldown_hours is not None and self.cooldown_hours < 0:
            problems.append("cooldown_hours cannot be negative")
        return problems

    def in_window(self, moment: datetime, policy: Policy) -> bool:
        """Is `moment` inside the hours this container is rolled in?

        The remit's own hours when it has them, the deployment's otherwise, and the
        wrap-past-midnight reading is `Policy.in_window`'s — one implementation, so
        `22`->`4` cannot mean two things in one deployment.
        """
        if self.window_start_hour is None or self.window_end_hour is None:
            return policy.in_window(moment)
        window = Policy(window_start_hour=self.window_start_hour,
                        window_end_hour=self.window_end_hour)
        return window.in_window(moment)

    def cooldown_for(self, config: RolloutConfig) -> int:
        return config.cooldown_hours if self.cooldown_hours is None else self.cooldown_hours


@dataclass(frozen=True)
class ContainerState:
    """What is known about one running container at the moment of the decision.

    Assembled by the caller from the scan's findings and one `docker inspect`, so that
    everything below is a pure function of these fields. `behind` keeps the scan's
    three-valued answer — see `UNJUDGED`.
    """

    host: str
    name: str
    ref: str
    container: str = ""
    behind: bool | None = None
    project: str = ""
    service: str = ""
    # Why the container cannot be recreated safely, if the plan check already said so
    # (`applier._compose_argv` / `_plan_services`). A sentence, because it is shown.
    plan_problem: str = ""
    # Whether anything is actually running this image on that host. An owned image that
    # was pulled and never started is behind and has nothing to restart; `NOT_RUNNING`
    # says so rather than reporting it current, because the finding is real and the
    # remit is the thing that is stale.
    running: bool = True
    last_roll_at: datetime | None = None
    # Set when a previous roll had to be rolled back and nobody has cleared it.
    blocked_reason: str = ""

    def key(self) -> tuple[str, str, str]:
        return (self.host, self.container, self.ref)


@dataclass(frozen=True)
class RollDecision:
    """The answer, with the reason and the sentence an operator reads.

    `roll` and `code` are both present on purpose: `ROLL` is a code like any other, so
    a run report can count what happened by grouping on one column instead of
    special-casing the interesting case.
    """

    roll: bool
    code: str
    detail: str
    state: ContainerState
    remit: Remit | None = None

    @property
    def owned(self) -> bool:
        return self.remit is not None


def _ago(moment: datetime | None, now: datetime) -> float | None:
    return None if moment is None else (now - moment).total_seconds()


def decide_roll(state: ContainerState, remit: Remit | None, config: RolloutConfig,
                policy: Policy, *, now: datetime | None = None,
                rolls_this_run: int = 0, rolls_this_host: int = 0,
                configured_hosts: set[str] | None = None) -> RollDecision:
    """May this container be rolled right now, and if not, why not?

    Ordered from the most absolute refusal to the most situational, because the first
    reason is the one reported and "it is not yours" is a more useful sentence than
    "you are outside the window". Pure: no clock of its own, no database, no ssh —
    every input arrives as an argument, so a test replays any Tuesday night.
    """
    moment = now or datetime.now(timezone.utc)

    def no(code: str, detail: str) -> RollDecision:
        return RollDecision(False, code, detail, state, remit)

    if remit is None:
        return no(NOT_OWNED,
                  f"{state.name}: not in the remit — this deployment has not been given "
                  f"{state.ref}, so it is scanned and left alone")
    if configured_hosts is not None and state.host not in configured_hosts:
        # The remit survives a host being taken out of `ONTRAK_HOSTS`; acting on it
        # would be reaching for a machine this deployment no longer claims.
        return no(HOST_NOT_CONFIGURED,
                  f"{state.name}: {state.host} is not in the configured host list")
    if not config.enabled:
        return no(DISABLED,
                  f"{state.name}: owned ({remit.ref}) but rollout is switched off — "
                  f"set ONTRAK_ROLLOUT=1 to let this deployment roll it")
    if not remit.auto:
        return no(MANUAL_ONLY, f"{state.name}: {remit.ref} is watched, not rolled")
    if state.blocked_reason:
        return no(BLOCKED,
                  f"{state.name}: held back after a failed roll ({state.blocked_reason}) — "
                  f"clear it once the image or the remit is fixed")
    if _is_protected(state.ref, config):
        return no(PROTECTED, f"{state.name}: {state.ref} is on the protected list")
    if state.behind is None:
        return no(UNJUDGED,
                  f"{state.name}: the registry could not be asked about {state.ref}, "
                  f"and an unknown is not a reason to restart a container")
    if not state.behind:
        return no(CURRENT, f"{state.name}: {state.ref} is current")
    if not state.running:
        return no(NOT_RUNNING,
                  f"{state.name}: {state.ref} is behind but no container is running it — "
                  f"pulled and never started, so there is nothing to roll")
    if state.plan_problem:
        return no(PLAN_REFUSED, f"{state.name}: {state.plan_problem}")
    if not remit.in_window(moment, policy):
        hours = (f"{remit.window_start_hour:02d}:00–{remit.window_end_hour:02d}:00"
                 if remit.window_start_hour is not None else
                 f"{policy.window_start_hour:02d}:00–{policy.window_end_hour:02d}:00")
        return no(OUTSIDE_WINDOW,
                  f"{state.name}: outside {hours} — a container is restarted in its "
                  f"maintenance hours, not whenever a tag moves")
    if policy.in_freeze(moment):
        return no(FREEZE, f"{state.name}: the change freeze is on until {policy.freeze_to}")
    cooldown = remit.cooldown_for(config)
    age = _ago(state.last_roll_at, moment)
    if cooldown > 0 and age is not None and age < cooldown * 3600:
        remaining = int((cooldown * 3600 - age) // 60)
        return no(COOLDOWN,
                  f"{state.name}: rolled {int(age // 60)} min ago; {remaining} min left of "
                  f"its {cooldown}h cooldown")
    if rolls_this_run >= config.max_per_run:
        return no(BATCH_LIMIT,
                  f"{state.name}: this run has already rolled {rolls_this_run} "
                  f"container(s), which is the limit")
    if rolls_this_host >= config.max_per_host:
        return no(HOST_LIMIT,
                  f"{state.name}: {state.host} has already had {rolls_this_host} roll(s) "
                  f"this run, which is the limit for one host")
    return RollDecision(True, ROLL, f"{state.name}: rolling {state.ref}", state, remit)


def _is_protected(ref: str, config: RolloutConfig) -> bool:
    """Is this ref on the protected list?

    Matched as written, and also ignoring the registry spelling that precedes it, so a
    list saying `postgres:16` protects `docker.io/library/postgres:16` too. A
    protection that silently failed to match would be worse than none, because it is
    believed.
    """
    wanted = (ref or "").strip()
    for entry in config.protected_refs:
        protected = (entry or "").strip()
        if not protected:
            continue
        if wanted == protected or wanted.endswith("/" + protected):
            return True
    return False


def health_verdict(*, status: str, health: str, has_healthcheck: bool,
                   elapsed_seconds: float, grace_seconds: int) -> str:
    """Did the new container come up? `UP`, `STARTING` or `DOWN`.

    `docker inspect` reports the daemon's view, and the two fields that matter are
    `State.Status` (`created`/`running`/`exited`/`restarting`) and `State.Health.Status`
    (`starting`/`healthy`/`unhealthy`) — the second only when the image defines a
    healthcheck, which is why `has_healthcheck` is an argument rather than a guess.

    A container with no healthcheck is judged by `running` alone, which is weaker and
    is stated in the plan rather than hidden: the honest limit of this gate is that it
    cannot tell a serving process from a crash-looping one that has not restarted yet.
    """
    status = (status or "").strip().lower()
    health = (health or "").strip().lower()
    # `restarting` is a DOWN and not a STARTING, and the difference is ninety seconds
    # of a Network being served by nothing: the daemon only says `restarting` once the
    # process has exited and the restart policy has picked it up, so the new image has
    # already failed. The old code waited out the grace period to learn the same thing.
    if status in ("exited", "dead", "removing", "restarting"):
        return DOWN
    if has_healthcheck and health == "unhealthy":
        return DOWN
    ready = status == "running" and (not has_healthcheck or health == "healthy")
    if ready:
        return UP
    if elapsed_seconds >= grace_seconds:
        # Still not there, and the clock ran out. `restarting` and a healthcheck stuck
        # on `starting` both land here: neither is a service, and waiting longer is a
        # decision for a person rather than for the timer.
        return DOWN
    return STARTING


def next_attempt(after: datetime, cooldown_hours: int) -> datetime:
    """When a rolled container becomes eligible again. Shown, so the wait is legible."""
    return after + timedelta(hours=max(0, cooldown_hours))


def summarize(decisions: list[RollDecision]) -> str:
    """One line for the run log: what was rolled, then why nothing else was.

    The refusals are counted by code rather than listed, because a Network with a
    hundred owned containers has a hundred reasons and one of them is interesting.
    """
    rolled = [d for d in decisions if d.roll]
    if not decisions:
        return "no containers in the remit"
    parts = [f"{len(rolled)} rolled"]
    counted: dict[str, int] = {}
    for decision in decisions:
        if decision.roll:
            continue
        counted[decision.code] = counted.get(decision.code, 0) + 1
    if counted:
        detail = ", ".join(f"{code} ×{count}" for code, count in sorted(counted.items()))
        parts.append(f"left alone: {detail}")
    return "; ".join(parts)


def describe(code: str) -> str:
    """A short label for a code, for a dashboard column that has no room for a sentence."""
    return {
        NOT_OWNED: "not owned", HOST_NOT_CONFIGURED: "host not configured",
        DISABLED: "rollout off", MANUAL_ONLY: "manual only",
        PROTECTED: "protected",
        UNJUDGED: "registry unknown", CURRENT: "current",
        NOT_RUNNING: "nothing running it",
        OUTSIDE_WINDOW: "outside window", FREEZE: "frozen",
        COOLDOWN: "cooling down", BLOCKED: "blocked", BATCH_LIMIT: "run limit",
        HOST_LIMIT: "host limit", PLAN_REFUSED: "plan refused", ROLL: "rolled",
    }.get(code, code)


@dataclass
class RollReport:
    """The tally a rollout run leaves behind.

    `manual` is separate from `failed` for the same reason the applier's is: a
    container that needs a person is not a container that went wrong, and a number
    that mixed them would hide a Network that is fine but not covered.
    """

    rolled: int = 0
    rolled_back: int = 0
    failed: int = 0
    skipped: int = 0
    decisions: list[RollDecision] = field(default_factory=list)
    messages: list[str] = field(default_factory=list)

    def note(self, message: str) -> None:
        self.messages.append(message[:400])
