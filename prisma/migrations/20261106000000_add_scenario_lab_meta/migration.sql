-- The OnTrak-dev provenance of a scenario imported from the lab, kept beside the row.
--
-- The two scenario models are a mapping, not a merge (docs/consolidation-audit.md §6/C3):
-- the lab's `scenario.yaml` carries objective ids and weights, a category, the workloads a
-- fault is built on and the lessons it belongs to, and none of those has a column here. The
-- family's `ScenarioDefinition` cannot hold them either — `validateDefinition` names the keys
-- it knows and strips the rest — so a single explicit column is what makes the import
-- reversible instead of lossy. `src/lib/lab-scenario-import.ts` writes and reads it, and
-- `tests/lab-scenario-import.test.ts` holds the round trip over all 14 lab scenarios to it.
--
-- Nullable and additive: every scenario authored in this app has no lab provenance, and the
-- column's absence is that fact rather than an empty object.

-- AlterTable
ALTER TABLE "Scenario" ADD COLUMN "labMeta" JSONB;
