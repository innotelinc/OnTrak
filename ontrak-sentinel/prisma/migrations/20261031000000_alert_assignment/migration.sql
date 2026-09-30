-- Alert ownership (S3): who is working an alert.
--
-- The queue shipped with everything an operator needs to *read* an incident and nothing that
-- says who is holding it, so the documented working practice was "one alert is acted on at a
-- time, by whoever gets there first" — which is how two people acknowledge the same incident
-- and neither investigates it. Ownership is one nullable column away from being sayable.
--
-- Three columns rather than one, and each earns its place:
--
--   1. `assigneeId` — the identity the alert was handed to. Nullable, and *every* existing row
--      is null, which is not a backfill problem: an alert that was raised before this migration
--      genuinely has no owner, and inventing one (the acknowledger, say) would put a name on a
--      decision nobody made.
--
--   2. `assigneeLabel` — the identity's display name at the moment of handover. This is the
--      same reasoning as `identityLabel`, one level down: an identity is renamed, deactivated
--      and eventually deprovisioned, and a closed incident that reads "*unassigned*" because
--      the person who worked it has since left would be a worse record than one that names
--      them. The label is written when the alert is handed over, not resolved on every read,
--      so it cannot drift with the directory.
--
--   3. `assignedAt` — when the handover happened, so a row can say how long somebody has been
--      holding it. The queue ages an alert from `lastSeenAt` (a repeat is not an ignored
--      alert), and that is the wrong clock for "has this been sitting on somebody's desk".
--
-- Who *may* be handed one is a rule rather than a constraint, in
-- `alert-triage-rules.ts`'s `assignmentRefusal`: an active human in the same organization.
-- A foreign key on `assigneeId` would be a second, weaker statement of that — it would
-- enforce that the identity exists and say nothing about whether it is a machine account or
-- somebody who has been switched off, which is the half that matters here.
--
-- No index, deliberately. The queue filters by owner in memory (`matchesFilter`) alongside
-- the severity, state and free-text filters it is always combined with, so an index on one of
-- those alone would serve no query the console makes.

-- AlterTable
ALTER TABLE "Alert" ADD COLUMN     "assigneeId" TEXT,
ADD COLUMN     "assigneeLabel" TEXT,
ADD COLUMN     "assignedAt" TIMESTAMP(3);
