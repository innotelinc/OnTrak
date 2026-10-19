-- Every shape a scenario has had, so "what did that class actually run?" has an
-- answer.
--
-- The live row is the newest shape; a revision is the shape a save *replaced*.
-- Append-only: a rollback writes a new revision rather than deleting the ones
-- after it, because an attempt carries the score it earned under the definition
-- it ran, and history that can be edited cannot be cited.
--
-- `snapshot` holds the fields an attempt depends on (see src/lib/versions-rules.ts)
-- and deliberately not the slug: that is the catalog's address, unique across the
-- catalog, and restoring an old one would collide with whatever took it since.
--
-- Additive and reversible; `down.sql` reverses it exactly.

-- CreateTable
CREATE TABLE "ScenarioRevision" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "authorId" TEXT,
    "authorEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScenarioRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScenarioRevision_scenarioId_revision_key" ON "ScenarioRevision"("scenarioId", "revision");

-- CreateIndex
CREATE INDEX "ScenarioRevision_scenarioId_createdAt_idx" ON "ScenarioRevision"("scenarioId", "createdAt");

-- AddForeignKey
ALTER TABLE "ScenarioRevision" ADD CONSTRAINT "ScenarioRevision_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;
