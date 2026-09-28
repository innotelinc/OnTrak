# The rota and the handoff

A desk that never writes a rota still has one. It lives in somebody's head, and
it is wrong exactly when it matters: a handover nobody wrote down, an on-call
week nobody can name, an hour with nobody watching.

OnTrak Tix puts it in the product for three questions, all of which have a wrong
answer that costs money:

| Question | Answered by | Where |
| --- | --- | --- |
| Who is on call at 03:00 Thursday? | `coverageAt` | the *Cover right now* panel on `/handoff` |
| Where is nobody on call at all? | `coverageGaps` | the gap list, which is the loudest thing on the page |
| What did the last person tell the next one? | `Handoff` rows | the handoff list, newest first |

## Shifts and on-call windows

A `RotaShift` is one person, one window, and either:

- a **shift** — they are working, at their desk; or
- an **on-call** window — they are holding the pager.

Both are the same person's time, so the collision check ignores the kind: a desk
cannot have somebody working 09:00–17:00 *and* on call 09:00–17:00 and expect
either to mean anything. Two refusals keep the rota honest:

- **An overlapping window for the same person is refused**, and the refusal
  names the shift it collided with. A double-booked agent otherwise discovers it
  at 03:00.
- **A window longer than 24 hours is refused.** Past that it is not a rota entry,
  it is an unbroken on-call week typed into one field.

Covering the same hours as a colleague is called a team and is allowed. A
`null` queue means the whole desk; naming a queue scopes the window to it.

## Coverage, and the distinction that matters

`coverageAt` answers "who is covering this moment" — and splits the answer into
who is *working* and who is *on call*. `covered` is about on-call only, because
somebody being at their desk is not cover at 03:00, and a summary that conflated
the two would report a desk as covered through the night.

`coverageGaps` walks the on-call windows inside a window and returns the
intervals with nobody holding the pager. Overlapping windows merge, so a
handover from one person to the next does not report as a gap between them.

`rotaLoad` totals the on-call hours per person and flags anyone carrying more
than half of a window's total. One name on every window is invisible in a list of
shifts and obvious in a column of totals — which is why it is a column.

## The handoff

A `Handoff` outlives the shift it happened in. It records:

- **who handed over and who took it**,
- **a note** — required, at least a sentence. "Anything to report? — no" is
  information; an empty handoff is the failure mode this table exists to prevent,
- **the work still open**, named by ticket reference rather than counted, because
  "3 open tickets" tells the next person nothing they can act on, and
- **the moment**, plus the queue it belongs to.

Two guardrails, both about the record rather than the person:

- **The shift on now is resolved from the rota, not from the form.** Recording a
  handoff asks the store who is on at that instant, so "who was on when this was
  written" is a fact rather than somebody's claim.
- **Somebody who is not on duty cannot hand over** — unless they run the desk,
  because a manager covering for a colleague who went home is not a violation of
  anything. The refusal names who *is* on, so the handover can happen from there.

`outstandingFrom` answers the arriving shift's real question: the newest handoff
is what they inherit, and a ticket that appeared in an earlier handoff but not in
the latest one was resolved, moved, or taken.

## What this deliberately does not do

- **No shift swaps or approval flow.** Publishing is a manager's act; an agent
  cannot publish themselves cover, and cannot quietly remove a shift they do not
  fancy. A swap that routes through an approver is a later slice.
- **No timezone-per-person.** Windows are instants (stored UTC, shown as
  instants). A desk spanning offices needs a display timezone per user before the
  page can render local times honestly.
- **No automatic escalation into the on-call rota.** The escalation sweep raises
  what its rules say; pointing it at the rota is a separate decision about who is
  interrupted, and it belongs with the paging integration rather than here.
- **No holidays or coverage forecasting.** The gap list shows what the published
  rota covers, not what a public-holiday calendar should adjust for.
