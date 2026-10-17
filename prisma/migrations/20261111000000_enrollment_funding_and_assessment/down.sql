-- The reverse of the migration in this directory.
--
--   psql "$DATABASE_URL" -f prisma/migrations/20261111000000_enrollment_funding_and_assessment/down.sql
--
-- Dropped by name and safe to run twice, for the same reason the rest of the history's down
-- migrations are: a half-failed rollout is when a human reaches for this file. The final
-- statement removes the migration's own row, which is what makes the migration *unapplied*
-- rather than merely ineffective.
--
-- Both columns are pure additions, so nothing else has to be rewritten to reverse them: the
-- rows keep their attendance and status, and an enrolment that was marked funded simply stops
-- carrying the flag `employerSlotUsage` reads. That reads as "funded" again, which is the
-- pre-migration meaning of rows written before this shipped.

-- AlterTable
ALTER TABLE "Enrollment" DROP COLUMN IF EXISTS "assessmentRecordedAt",
DROP COLUMN IF EXISTS "funded";

-- The migration's own record, so `migrate deploy` will replay the up migration.
DELETE FROM "_prisma_migrations"
WHERE "migration_name" = '20261111000000_enrollment_funding_and_assessment';
