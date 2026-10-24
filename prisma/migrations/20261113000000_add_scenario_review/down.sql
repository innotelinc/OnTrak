-- Reverse the authoring-review migration.
DROP TABLE IF EXISTS "ScenarioComment";
ALTER TABLE "Scenario"
    DROP COLUMN IF EXISTS "reviewedAt",
    DROP COLUMN IF EXISTS "reviewedById",
    DROP COLUMN IF EXISTS "reviewNote",
    DROP COLUMN IF EXISTS "reviewStatus";
DROP TYPE IF EXISTS "ScenarioReviewStatus";
