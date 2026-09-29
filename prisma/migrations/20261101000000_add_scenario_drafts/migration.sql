-- Practice scenarios drafted from solved support work.
--
-- OnTrak Tix's outcome sweep writes one of these when a ticket is resolved: the
-- reported problem and the fix become objectives a learner can practise. It is a
-- *draft* and deliberately not a `Scenario`: a graded scenario needs a platform, a
-- machine definition and checks that score a person, and no machine can honestly
-- produce those from a ticket. An instructor turns the draft into a scenario, so
-- `published` never appears here and nothing in this table is visible to a learner.
--
-- `sourceRef` is unique so the hand-off is idempotent: the sweep checks the ticket
-- before it sends, and the range refuses a second draft for the same ticket even if
-- the sweep's own bookkeeping is lost, which is what makes it safe on a schedule.

-- CreateTable
CREATE TABLE "ScenarioDraft" (
    "id" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'tix',
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "difficulty" "Difficulty" NOT NULL DEFAULT 'INTERMEDIATE',
    "objectives" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "steps" JSONB NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reviewedById" TEXT,
    "scenarioId" TEXT,

    CONSTRAINT "ScenarioDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScenarioDraft_sourceRef_key" ON "ScenarioDraft"("sourceRef");

-- CreateIndex
CREATE INDEX "ScenarioDraft_createdAt_idx" ON "ScenarioDraft"("createdAt");
