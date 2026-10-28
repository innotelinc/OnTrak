-- Reverse the attempt timing-integrity migration.
ALTER TABLE "Attempt" DROP COLUMN IF EXISTS "integrity";
