-- The reverse of the migration in this directory.
--
-- Prisma will not generate a down migration: `migrate dev` and `migrate deploy` are
-- forward-only, and the tool's own answer to a mistaken rollout is a forward fix. The
-- integration brief asks for *reversible* migrations, so the reverse is here, written by
-- hand and checked by applying it (in a throwaway database) after the up migration, not
-- left as an assertion about what dropping a table would do.
--
--   psql "$DATABASE_URL" -f prisma/migrations/20261109000000_add_lab_runtime/down.sql
--
-- Every object is dropped by name in the opposite order to the way it was created, and
-- `IF EXISTS` is deliberate: a half-failed rollout is exactly when a human reaches for
-- this file, and it must be safe to run twice.
--
-- The last statement removes the migration's row from `_prisma_migrations`, which is
-- what makes the migration *unapplied* rather than merely ineffective — leaving it in
-- place would make a later `migrate deploy` skip the up migration and quietly believe a
-- schema it no longer has. `npx prisma migrate resolve --rolled-back
-- 20261109000000_add_lab_runtime` is the same intent through the tool.
--
-- Nothing outside these tables is touched: the app's own tables, including
-- `Attempt.labSessionId`, keep their data, and that column is a plain text reference
-- which simply stops being joined to anything.

-- DropForeignKey
ALTER TABLE IF EXISTS "LabEvent" DROP CONSTRAINT IF EXISTS "LabEvent_sessionId_fkey";

-- DropForeignKey
ALTER TABLE IF EXISTS "LabResult" DROP CONSTRAINT IF EXISTS "LabResult_sessionId_fkey";

-- DropTable
DROP TABLE IF EXISTS "LabEvent";

-- DropTable
DROP TABLE IF EXISTS "LabResult";

-- DropTable
DROP TABLE IF EXISTS "LabSession";

-- DropTable
DROP TABLE IF EXISTS "LabMeta";

-- DropEnum
DROP TYPE IF EXISTS "LabSessionState";

-- Forget the migration, so the history matches the schema it describes.
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261109000000_add_lab_runtime';
