-- How an attempt was graded: `simulated` by this app's in-browser engine, or `lab`
-- by the lab's checks against a live machine (docs/consolidation-audit.md §7 Step 6,
-- §6/C2). The family already records the certificate and the launch on the attempt,
-- and this is the third piece of the same story: what a score *means* depends on who
-- produced it, so the grading evidence names the grader.
--
-- Written when the attempt is graded rather than derived from the scenario's tags, so
-- a scenario retagged later cannot rewrite what yesterday's evidence says — the same
-- reason a certificate is stored rather than recomputed. `src/lib/grading-mode.ts`
-- owns the two values and the default; `tests/grading-mode.test.ts` holds the rules.
--
-- Nullable and additive: every attempt graded before this column existed has no mode,
-- and the absence reads back as `simulated` (which is what graded it) rather than
-- requiring a backfill that would guess.

-- AlterTable
ALTER TABLE "Attempt" ADD COLUMN "gradingMode" TEXT;
