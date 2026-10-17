-- Two facts the funder's answers made necessary on an enrolment.
--
-- `funded` exists because an offering of an approved course may include participants who are
-- not funded through FAST AI, and then "attendance and completion records must identify which
-- participants are FAST AI trainees" (RFQ answers, 2026-10-13, §2.2). Default true so every
-- seat already recorded keeps the meaning it had: it was billed.
--
-- `assessmentRecordedAt` exists because a completion is only reimbursable when "the trainee
-- must complete any assessment or activity the course requires" (answers, §4), and the app held
-- no record of that at all. Null means not recorded, which is not the same as failed.
--
-- Additive and reversible; `down.sql` in this directory reverses it exactly.

-- AlterTable
ALTER TABLE "Enrollment" ADD COLUMN     "funded" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "assessmentRecordedAt" TIMESTAMP(3);
