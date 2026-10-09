-- The lab runtime: the tables OnTrak-dev kept in a SQLite file of its own
-- (docs/lab-port.md). Sessions, the results they produced, the audit trail, and the
-- lab's small meta table.
--
-- Additive and reversible. Every statement here creates something; nothing alters or
-- drops a column of a table this deployment already has, so the migration can be
-- applied to a running installation without a data-shape change, and `down.sql` in
-- this directory reverses it exactly (see the note at the foot of that file).
--
-- Two deliberate choices:
--
--  * No separate lab user table. The lab's `users` table is superseded by this app's
--    identity (§3/C2), so `LabSession.student` holds the app's own student key. A lab
--    account beside it would be a second place to revoke someone from, and the two
--    would drift the first time a student was renamed.
--  * Results carry the whole graded report as JSONB. A report is the record of a
--    judgement made against a scenario at a moment in time; recomputing it after a
--    scenario's weights are edited would change a past grade's meaning.
--
-- Events survive their session: `ON DELETE SET NULL` rather than CASCADE, because the
-- events an operator most needs to read are the ones about a session that has since
-- been removed (a failed destroy, a recycle).

-- CreateEnum
CREATE TYPE "LabSessionState" AS ENUM ('REQUESTED', 'ALLOCATING', 'PROVISIONING', 'READY', 'IN_USE', 'CHECKING', 'PASSED', 'FAILED', 'RECYCLING', 'DESTROYED', 'ERROR');

-- CreateTable
CREATE TABLE "LabSession" (
    "id" SERIAL NOT NULL,
    "student" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "state" "LabSessionState" NOT NULL DEFAULT 'REQUESTED',
    "instance" TEXT NOT NULL DEFAULT '',
    "hostIp" TEXT NOT NULL DEFAULT '',
    "rdpUser" TEXT NOT NULL DEFAULT '',
    "rdpPassword" TEXT NOT NULL DEFAULT '',
    "hintLevel" INTEGER NOT NULL DEFAULT 0,
    "checksRun" INTEGER NOT NULL DEFAULT 0,
    "bestScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "workload" TEXT NOT NULL DEFAULT '',
    "timeLimitMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "LabSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabResult" (
    "id" SERIAL NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "student" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "report" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabEvent" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "sessionId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabMeta" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabMeta_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "LabSession_student_state_idx" ON "LabSession"("student", "state");

-- CreateIndex
CREATE INDEX "LabSession_state_idx" ON "LabSession"("state");

-- CreateIndex
CREATE INDEX "LabSession_lastActivityAt_idx" ON "LabSession"("lastActivityAt");

-- CreateIndex
CREATE INDEX "LabResult_sessionId_idx" ON "LabResult"("sessionId");

-- CreateIndex
CREATE INDEX "LabResult_student_scenarioId_idx" ON "LabResult"("student", "scenarioId");

-- CreateIndex
CREATE INDEX "LabEvent_kind_idx" ON "LabEvent"("kind");

-- CreateIndex
CREATE INDEX "LabEvent_sessionId_id_idx" ON "LabEvent"("sessionId", "id");

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LabSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabEvent" ADD CONSTRAINT "LabEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LabSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
