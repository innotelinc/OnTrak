-- The in-house ticket: the incident write-up a student hands in with a submission
-- (docs/lab-port.md §2d/§3). Additive and reversible; `down.sql` in this directory
-- reverses it exactly.
--
-- Why a table of its own rather than a column on `LabResult`: the write-up is an
-- artefact, not a field. It is read on its own (the session page shows the student what
-- they wrote), it carries its own mark with its own rubric, and the admin view lists
-- tickets without unpacking a score report. `grade` and `values` are JSONB because they
-- are the lab's own `to_dict` shapes — a row written here is readable by the lab's tools,
-- and a row the lab wrote is readable by this port.
--
-- A **draft** is not a row here: an unsubmitted write-up lives in `LabMeta` under
-- `ticket_draft:<sessionId>`. The lab is results-only, and a draft in this table would
-- appear in a marking record as if it had been handed in.

-- CreateTable
CREATE TABLE "LabTicket" (
    "id" SERIAL NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "student" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "grade" JSONB NOT NULL,
    "values" JSONB NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "submitted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LabTicket_sessionId_idx" ON "LabTicket"("sessionId");

-- CreateIndex
CREATE INDEX "LabTicket_student_idx" ON "LabTicket"("student");

-- AddForeignKey
ALTER TABLE "LabTicket" ADD CONSTRAINT "LabTicket_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LabSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
