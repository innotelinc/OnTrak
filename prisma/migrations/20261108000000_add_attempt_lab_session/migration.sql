-- The lab session an attempt was reported from, when the lab graded it
-- (docs/lab-completion.md). The lab grades a task against a live machine and reports
-- the completion to `POST /api/v1/lab/completions`; this column is that boundary's
-- idempotency key.
--
-- It is UNIQUE so a completion the lab sends twice — a sweep interrupted between
-- grading and reporting, a retry by hand — is recognised as one session rather than
-- creating a second attempt. That is the same shape the desk's scenario drafts use
-- for `sourceRef`, and it lets the database, rather than a read-then-write race,
-- decide which of two concurrent deliveries won.
--
-- Nullable: every attempt not produced by a lab has no session, and the column's
-- absence is that fact. Postgres allows many NULLs under a unique index, so those
-- rows do not collide.

-- AlterTable
ALTER TABLE "Attempt" ADD COLUMN "labSessionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Attempt_labSessionId_key" ON "Attempt"("labSessionId");
