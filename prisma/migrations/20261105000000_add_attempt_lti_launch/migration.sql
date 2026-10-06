-- The learning-platform launch an attempt came from, so a grade can find its way
-- back to the line item it belongs on.
--
-- It lives on the attempt rather than in the session or in a table of its own.
-- Not the session, because a launch and the grading of the attempt it started are
-- different requests and may be different people — an instructor re-grading is not
-- the learner, and the score still has to go to the platform that launched it. Not
-- a table of its own, because each row here is one launch narrowed to the four
-- facts grading needs (issuer, subject, line item, course), and it is read exactly
-- once, at the moment a score is written.
--
-- Nullable and additive: every attempt that did not come from a platform has no
-- launch, and the column's absence is that fact rather than an empty object.

-- AlterTable
ALTER TABLE "Attempt" ADD COLUMN "ltiLaunch" JSONB;
