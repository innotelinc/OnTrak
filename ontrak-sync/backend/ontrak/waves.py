"""Which machine an apply touches next — and when it stops touching any.

`applier.apply_findings` is the only code here that writes to machines. This module
decides the order it writes in, and it is deliberately pure: no database, no
transport, no clock. The property 2.2 has to prove is an *ordering* property — a
failed canary stops the run — and an order that can only be observed by watching a
real rollout is an order nobody can test. Keeping the plan a value means the test
that pins it is the same plan the applier executes.

A target here is the pair `apply_findings` already groups by, `(host, target)`. The
order is the order the caller passes in — the applier's own `ORDER BY host, name` —
so the plan does not invent a second notion of "first"; a plan that re-sorted
differently from the query would make the canary whichever machine happened to sort
first, which is precisely the choice an operator is trying to make on purpose.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

Target = tuple[str, str]        # (host name, target name); target == host for a host


@dataclass(frozen=True)
class Wave:
    """One step of an apply: either the canary, or a slice of what is left."""

    number: int
    kind: str                   # "canary" | "wave"
    targets: tuple[Target, ...]

    @property
    def label(self) -> str:
        """How this step is named in a run log, e.g. `canary` or `wave 2`."""
        return "canary" if self.kind == "canary" else f"wave {self.number}"


@dataclass(frozen=True)
class Plan:
    """The whole order, plus what this plan deliberately leaves alone."""

    waves: tuple[Wave, ...]
    attempted: tuple[Target, ...]
    capped: tuple[Target, ...]
    note: str = ""

    def used(self, targets: Iterable[Target]) -> tuple[Target, ...]:
        """The targets in `targets` that this plan actually attempts."""
        chosen = set(self.attempted)
        return tuple(t for t in targets if (str(t[0]), str(t[1])) in chosen)

    def after(self, wave: Wave) -> tuple[Target, ...]:
        """Every target in a later wave — the machines a halt is protecting.

        Read from the plan rather than from the grouped dict, because "later" has to
        be the plan's own word: a halt that recomputed it would be able to disagree
        with the order it just ran.
        """
        return tuple(t for w in self.waves if w.number > wave.number for t in w.targets)


def plan(targets: Iterable[Target], policy) -> Plan:
    """Order the targets: first `apply_canary_targets`, then waves of `apply_wave_size`.

    `apply_max_targets` bounds how much of a run is planned at all (0 = no bound).
    Targets beyond it are returned in `capped` instead of disappearing: the caller
    leaves them untouched and says so, because a cap an operator cannot see is
    indistinguishable from a bug that dropped their fleet.
    """
    order: list[Target] = []
    for host, name in targets:
        key = (str(host), str(name))
        if key not in order:
            order.append(key)

    cap = int(getattr(policy, "apply_max_targets", 0) or 0)
    if cap > 0:
        chosen, capped = order[:cap], tuple(order[cap:])
    else:
        chosen, capped = order, ()

    note = ""
    if capped:
        note = (f"{len(capped)} target(s) beyond apply_max_targets={cap} "
                "were left untouched")

    size = max(1, int(getattr(policy, "apply_wave_size", 5) or 5))
    # `validate()` refuses a canary larger than a wave; clamping here rather than
    # trusting the policy keeps a stored-but-unvalidated row from producing one
    # enormous first wave, which is the shape of the bug this whole module prevents.
    canary = max(0, min(int(getattr(policy, "apply_canary_targets", 1) or 0), size, len(chosen)))

    waves: list[Wave] = []
    if canary:
        waves.append(Wave(number=0, kind="canary", targets=tuple(chosen[:canary])))
    rest = chosen[canary:]
    for start in range(0, len(rest), size):
        waves.append(Wave(number=len(waves), kind="wave",
                          targets=tuple(rest[start:start + size])))

    return Plan(waves=tuple(waves), attempted=tuple(chosen), capped=capped, note=note)
