-- Per-locale catalogue copy (2.3): the card a student reads, not the scenario they run.
--
-- Additive and nullable. Null means "not translated yet", which falls back to the authored
-- column field by field (`src/lib/catalog-i18n.ts`) — so a row that predates this migration
-- reads exactly as it did, and a half-finished translation reads as a mixture rather than a
-- blank line.
--
-- Two columns rather than a translations table: there is one non-default locale, the copy is
-- one title and one summary per scenario, and the catalogue list already selects these
-- columns beside `title`/`summary`. A table would turn one row per scenario into a join for
-- two strings.

-- AlterTable
ALTER TABLE "Scenario" ADD COLUMN "titleEs" TEXT,
ADD COLUMN "summaryEs" TEXT;
