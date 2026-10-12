# Unattended container rolls

Ontrak Sync's job is to keep the Network current, and until now it stopped one step short of
that: a scan found the images that were behind, and every one of them needed a person to read a
finding and press a button. That is the right posture for a package upgrade and it is not a
strategy for base images — an image with a known CVE sits there for as long as nobody opens the
dashboard, and "the dashboard is correct" is not what the Network needs.

So there is a second thing this service can do, and it is the Watchtower half: **keep a container
on its tag's current image on the timer, and undo it when the new image does not come up.**

It is off until somebody turns it on, and it acts only on containers this deployment has been
*given*. Both of those are deliberate, and everything below explains what each one is for.

## The remit: what "owned" means

Nothing here acts on a container nobody claimed. `rollout_targets` is the remit — a
(host, incus container, image ref) triple a person named, with the note recording who gave it up:

```http
POST /api/rollouts/claim
{ "host": "i1", "container": "monarch", "ref": "ghcr.io/innotelinc/monarch/api:1.4",
  "service": "api", "note": "the imaging VLAN's API" }
```

Four things about that are load-bearing:

- **Per image ref, not per stack and not per host.** A stack that shares one image with its
  sidecar should not have to give both up, and a host with forty containers should not be one
  decision.
- **Keyed on (host, container, ref)** because one host runs several incus containers with their
  own Docker daemons and one image can legitimately run twice inside one of them. A remit keyed
  on the image would restart both.
- **`auto: false` means watched, not rolled.** Findings are still raised and a person still
  clicks; the container is in the list so it is visible and *not* in the subset that moves on its
  own. "Unattended everywhere except these four" is the posture a Network actually wants, and a
  global flag cannot say it.
- **An empty remit is the shipped state**, and it means the feature cannot touch anything. Whole-
  network protection here is a list somebody wrote, which is the only version of it that is not
  also whole-network risk.

Claiming is `sync:configure` (the same capability as the timer, because a remit is what the
timer acts on), releasing is the same, and every claim, release and refusal is on the audit
trail with the actor's name.

## Turn it on

```bash
ONTRAK_ROLLOUT=true                      # the kill switch; off by default
ONTRAK_ROLLOUT_MAX_PER_RUN=3             # per pass, Network-wide
ONTRAK_ROLLOUT_MAX_PER_HOST=2            # per pass, per host
ONTRAK_ROLLOUT_COOLDOWN_HOURS=24         # per container, after it was rolled
ONTRAK_ROLLOUT_HEALTH_GRACE=90           # seconds before a rollback
ONTRAK_ROLLOUT_PROTECTED=postgres:16,ghcr.io/innotelinc/gateway:1 # never rolled
```

The roll runs at the end of a **scheduled scan**, in both `detect` and `auto` mode: the schedule
an operator already set is when this Network wants work done, and a second cron would only be a
second thing to keep in step. `detect` is a statement about packages — somebody who wants apt to
wait for an approval has said nothing about container rolls, and the roll has a kill switch of
its own plus a per-container `auto` flag. Folding the two together would make `detect` silently
mean "never roll these either", which is a different decision nobody made.

It also runs on demand:

```http
POST /api/rollouts/run                   # sync:apply — one pass, under the same rails
```

## The rails

Every one of these exists because unattended container updating has a specific way of taking a
Network down. All of them are pure functions of (container state, remit, config, policy) in
`ontrak/rollout.py`, so each one is replayable in a test:

| Rail | What it prevents |
|---|---|
| **Not owned** | The remit is the blast radius. No claim, no roll, no pull. |
| **The kill switch** (`ONTRAK_ROLLOUT`) | The feature ships inert; enabling it is a decision, not an upgrade. |
| **`auto: false`** | Watched containers raise findings and never move by themselves. |
| **Protected refs** | The database, the gateway: matched as written *and* without the registry prefix, because a protection that silently failed to match is worse than none. |
| **The window and the freeze** | Read from the deployment's own `Policy` — the same hours and the same moratorium as package work. A second window concept would eventually disagree with the first. A remit may narrow its hours further. |
| **The cooldown** | A tag republished twice an hour must not become a container restarted twice an hour. |
| **Batch and per-host caps** | One bad image is not a Network outage. |
| **Unjudged is not current** | The registry could not be asked → nothing happens. Collapsing that into "up to date" is the bug this project's README is written about; collapsing it into "roll it" would be the same bug with the sign flipped. |
| **The plan refusal** | A compose project whose services cannot all be seen is refused **before** anything is stopped — the same check the clicked path makes, made earlier. |
| **The health gate** | See below. |
| **The block after a failure** | A roll that had to be undone is held until somebody clears it. A roll that fails once will fail every night, and a container that flaps nightly is worse than one that is simply behind. |

## What a roll actually does

The finding from the scan is the **precondition** — that is what keeps a run over a hundred
owned containers from asking a registry about all of them — and the pull is the **verdict**:

1. **Read** the container's current image id, and open a roll row *before* anything is stopped.
   If this service dies mid-roll, that row is the only evidence that a container may have been
   left half-replaced.
2. **Log in** to the registry when a credential is configured for it, exactly as the clicked
   path does, so the pull spends the authenticated allowance.
3. **Pull** the ref. A registry that refuses is not a roll and not a failure: the attempt is
   recorded `untouched`, the container is not held back, and the next run tries again — a
   throttled registry clears on its own.
4. **Compare** the id the tag now resolves to against the id the container is running. Equal
   means nothing to do: the finding was stale, or the scan could not judge it and protected the
   row rather than deleting it. Nothing is stopped.
5. **Recreate** through the container's own compose invocation — its project name, working
   directory, `-f` set, `--env-file`, and the declared profiles only when the plain plan cannot
   see every running service.
6. **Verify**: the container must report `running` and, when the image defines a healthcheck,
   `healthy`, within the grace period. A container that is still `starting` when the clock runs
   out is **down**, not "up because it has not failed yet". A `restarting` container is down
   immediately — the process exited and the restart policy picked it up.
7. **Roll back** if it did not come up: the previous image id is tagged back onto the ref and the
   stack is recreated on it. That is only possible while the old layers are still on the host, and
   when they are not, the roll is recorded `failed` — never as a success, because "we replaced it
   and then undid it" and "we could not put it back" are the two facts an incident review needs
   to be able to tell apart.
8. **Close the finding**, so the Findings page and the Rollouts page cannot disagree about a
   container that was just updated.

Every outcome is a row in `container_rolls`: what was running, what it was asked to become, the
state (`rolled`, `rolled-back`, `failed`, `untouched`), the reason in the daemon's own words, and
how long it took.

## Undoing a roll by hand

The health gate catches an image that will not start. It cannot catch one that starts, reports
healthy and serves the wrong thing — a bad release, a regression nothing checks for.

```http
POST /api/rollouts/undo    { "roll_id": 41 }     # sync:apply
```

That puts the image that was running before back, records it as a second row (two facts with two
authors, rather than one row whose meaning changed), and **leaves the container held** so the next
scheduled pass does not roll it forward again while somebody is still working out why they
reached for the undo. Clearing the hold is `POST /api/rollouts/clear` (`sync:approve` — it restarts
nothing by itself; the next run is what makes it real).

## Reading it

```http
GET /api/rollouts          # sync:view
```

Returns `enabled`, the remit with each container's last successful roll and any hold, the recent
roll history, and the limits in force — so the page can show what a claimed container would be
subject to *before* anybody claims one. `enabled: false` with a full remit is a deployment
somebody prepared and did not switch on, which is a state worth being able to see rather than one
that should look like a Network that is simply up to date.

### The Rollouts page

The dashboard's **Rollouts** page is the whole of this feature in one screen, and it is written
to answer one question at a glance: *what is this deployment allowed to restart, and what happened
the last time it did?* Five panels, in that order:

1. **The banner, when it applies.** `ONTRAK_ROLLOUT` is off → every owned container is left alone
   however far behind it is, said in the operator's own vocabulary, because that is the string they
   will search for. It must never read as "nothing to do".
2. **Give a container to this deployment.** Host (the *configured* list, so a remit cannot name a
   machine this deployment does not reach), incus container, image ref, service, and the one
   checkbox that matters: *roll it unattended*, off for a container that should be watched and
   never moved. The note is where the next person finds out who decided it.
3. **The remit**, with the cooldown counted down (*in 6h (03:30)*), the hold on the row it applies
   to, who claimed it, and the two controls — **Clear hold** and **Release**.
4. **What the Network runs** — every docker image the scans have seen on every configured host,
   with whether this deployment owns it, and **Claim…** to load a row into the form above. This is
   the panel that makes an unclaimed container visible as *unclaimed*: a page that only lists
   claims makes "we have not covered that one" look exactly like "there is no such container".
5. **The rolls**, and **the rails in force** (per-pass and per-host caps, cooldown, health grace,
   protected refs) — so the posture is legible without reading this document.

The page never offers an **Undo** that would not mean anything: only the newest attempt on a
container can be put back, because the image to put back is the one *that* attempt replaced. A
roll a later row has already followed is history, and the API refuses it regardless.

Claiming is `sync:configure`, running a pass and undoing one are `sync:apply`, and reading any of
it is `sync:view` — the buttons are drawn from the same capability table the server authorises
with, so hiding one and refusing the call cannot drift apart.

### How the page is verified

`tests/browser/sync.spec.ts`, at the repository root, drives the whole of this section in
Chromium — the empty remit, the images the scans found and who owns them, the claim, a pass that
rolls, the `old → new` row, the undo that leaves the container *held*, **Clear hold**, and
**Release** — and one command runs it:

```bash
npm run test:e2e:sync
```

`playwright.sync.config.ts` boots both halves first: `backend/tests/serve_fake.py` serves the
**real** application over a throwaway database with `ssh`/`incus exec`/`docker` faked (reusing the
fake the roll's own unit tests are held to), and the dashboard is started against it on `:8451`
with the same-origin `/api/*` proxy the family stack ships. The API's unittest suite covers the
rails; this covers the page — and it is also the only check that would notice the console filling
with refused hot-reload handshakes, which no typecheck and no production build can see.

## What it deliberately does not do

- **It does not roll anything nobody claimed.** There is no "roll everything that is behind"
  call, and there is no setting that adds one.
- **It does not roll a non-compose container.** The correct replacement depends on the volumes,
  networks and entrypoint flags it was created with; guessing produces a container that works
  until the first restart. It is pulled and reported as needing a person.
- **It does not clean up images, or volumes, or the daemon.** No `docker system prune`, no
  registry garbage collection. The old layers have to stay on the host for a rollback to be
  possible at all.
- **It does not roll on a repeated failure.** One incident per container, not one a night.
- **It cannot tell a serving process from a crash-looping one that has not restarted yet** when
  the image defines no healthcheck. That is the honest limit of the gate, and an image without a
  healthcheck is a worse candidate for an unattended roll than one with.
