-- Timing integrity (2.2): the opt-in record of time away from an attempt.
--
-- Additive and reversible; `down.sql` in this directory reverses it exactly.
--
-- One nullable JSONB column rather than a table: the record belongs to exactly
-- one attempt, is read only beside that attempt's result, and is replaced as the
-- learner's browser reports further intervals (merged, never appended blindly —
-- see `src/lib/timing-integrity-rules.ts`). A table would turn one row per
-- attempt into a second thing to join, expire and scope for no gain.
--
-- Null is the honest default and the state of every attempt that ran before this
-- control existed: "not recorded" is not "no time away".

-- AlterTable
ALTER TABLE "Attempt" ADD COLUMN "integrity" JSONB;
