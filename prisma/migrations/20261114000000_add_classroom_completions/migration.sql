-- A classroom completion (Class 2.1): the learning platform's own outcome, filed
-- in this deployment's ledger so it — not the classroom — holds the record.
--
-- Additive and reversible; `down.sql` in this directory reverses it exactly.
--
-- Why a table rather than an `Attempt`: an attempt is filed against a scenario
-- this app graded, and a generated classroom lesson is not one. Creating a
-- scenario per lesson would put machine-made exercises in the catalog, in every
-- analytics query and in every assignment picker, which is a worse lie than a
-- record that says plainly what it is. The certificate rides on this row for the
-- same reason an attempt stores its own: the code a learner was handed must keep
-- verifying when the classroom is rebuilt or a title changes.
--
-- `completionId` is the classroom's idempotency key and is unique by the
-- database, so a completion reported twice is one record even when two deliveries
-- race.

-- CreateTable
CREATE TABLE "ClassroomCompletion" (
    "id" TEXT NOT NULL,
    "completionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseRef" TEXT NOT NULL,
    "courseTitle" TEXT NOT NULL,
    "lessonRef" TEXT NOT NULL,
    "lessonTitle" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "maxScore" INTEGER NOT NULL,
    "passScore" INTEGER NOT NULL DEFAULT 70,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3) NOT NULL,
    "timeSpentSec" INTEGER NOT NULL DEFAULT 0,
    "certificate" JSONB,
    "certificateIssuedAt" TIMESTAMP(3),
    "certificateRevokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassroomCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClassroomCompletion_completionId_key" ON "ClassroomCompletion"("completionId");

-- CreateIndex
CREATE INDEX "ClassroomCompletion_userId_completedAt_idx" ON "ClassroomCompletion"("userId", "completedAt");

-- CreateIndex
CREATE INDEX "ClassroomCompletion_courseRef_completedAt_idx" ON "ClassroomCompletion"("courseRef", "completedAt");

-- AddForeignKey
ALTER TABLE "ClassroomCompletion" ADD CONSTRAINT "ClassroomCompletion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
