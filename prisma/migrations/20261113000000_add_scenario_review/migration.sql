-- Authoring review (2.1): a scenario is submitted, read, and approved before it
-- is published — by somebody other than the person who wrote it.
--
-- Existing published scenarios are backfilled as APPROVED: they went live under
-- the old rule, and a migration that un-publishes the catalog would take the
-- exercises out from under a class mid-term. Drafts stay DRAFT.
--
-- Additive and reversible; `down.sql` reverses it exactly.

-- CreateEnum
CREATE TYPE "ScenarioReviewStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED');

-- AlterTable
ALTER TABLE "Scenario"
    ADD COLUMN "reviewStatus" "ScenarioReviewStatus" NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN "reviewNote" TEXT,
    ADD COLUMN "reviewedById" TEXT,
    ADD COLUMN "reviewedAt" TIMESTAMP(3);

-- Backfill: what is already published was approved by the process that shipped it.
UPDATE "Scenario" SET "reviewStatus" = 'APPROVED' WHERE "published" = true;

-- CreateTable
CREATE TABLE "ScenarioComment" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorEmail" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "ScenarioComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScenarioComment_scenarioId_createdAt_idx" ON "ScenarioComment"("scenarioId", "createdAt");

-- AddForeignKey
ALTER TABLE "ScenarioComment" ADD CONSTRAINT "ScenarioComment_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;
