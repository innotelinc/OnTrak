-- A measured time-to-prevent (S4).
--
-- S4's exit names a *measured* time-to-prevent, and the figure has two ends: the detection
-- the action answers, and the moment the action was applied. Both instants have to be on the
-- action itself rather than looked up later, for the same reason the evidence and the inverse
-- are: an alert is closed out of the queue and a queue is read through a window, so a figure
-- that joined to today's alert list would silently lose its sample.
--
--   * `detectedAt` is carried from the alert when the action is proposed. Nullable, because a
--     proposal may name no detection instant — an older client, or a call made outside the
--     console — and a missing end is recorded as missing rather than invented.
--   * `timeToPreventMs` is `appliedAt − detectedAt`, written when the action goes ACTIVE. It
--     is null until then (a proposal waiting on a second administrator has prevented nothing)
--     and null for a negative interval (a clock that puts prevention before detection), so the
--     summary can tell "not measured" from "measured as instant".
--
-- Both are additive and nullable, so existing rows read as unmeasured and no backfill is
-- required or possible: the instant a past action's detection was seen was never stored.

-- AlterTable
ALTER TABLE "EnforcementAction" ADD COLUMN "detectedAt" TIMESTAMP(3);
ALTER TABLE "EnforcementAction" ADD COLUMN "timeToPreventMs" INTEGER;
