-- Threat intelligence, where a match can be read (S3).
--
-- This migration adds one table and one column, and the interesting part is that it does
-- **not** add a join table. An alert's matched indicators are a bounded JSON list on the
-- alert itself rather than rows pointing at the feed: a feed is edited, a list is pruned,
-- and an alert read next month has to say what was known when it was raised. A foreign key
-- would make yesterday's escalation unreadable the moment today's feed withdraws the
-- indicator it rested on — which is precisely the question an auditor asks.
--
-- The column is `NOT NULL DEFAULT '[]'` rather than nullable, so a deployment upgrading in
-- place gets an empty list rather than a null every reader would have to special-case. The
-- triage UI does not want two spellings of "nothing matched".
--
-- `Indicator` is the feed side, and three choices carry the milestone's promises:
--
--   1. The primary key is `(organizationId, id)` and `id` is *derived* from the kind and
--      the canonical value (`threat-intel-rules.ts`), not generated. Derived is what makes
--      polling a feed an UPDATE instead of a table that grows by the feed's size every hour;
--      scoping it to the organization is what keeps that honest across tenants, because two
--      organizations watching one address are two rows and one of them withdrawing it cannot
--      reach the other's. A global key on the derived id would make the second tenant's
--      first ingest a constraint violation — a cross-tenant denial of service.
--   2. `source` is NOT NULL and is never defaulted. An indicator whose provenance is unknown
--      cannot be withdrawn when the feed turns out to be wrong, and "which feed told us
--      this?" is the first question asked about a false positive.
--   3. `confidence` and `expiresAt` are stored rather than assumed. Below the matcher's
--      floor a hit annotates an alert instead of escalating it, and an expired indicator is
--      refused by the matcher itself rather than by a sweep that may not have run — so both
--      numbers have to survive the round trip exactly. `expiresAt` is nullable and null means
--      "does not expire", which the console counts, because a feed with no expiries is a feed
--      nobody pruned.
--
-- Every row carries `organizationId` with a cascading foreign key, as the rest of the schema
-- does, so one tenant's feeds can never be read from another's.

-- AlterTable
ALTER TABLE "Alert" ADD COLUMN "threatIntel" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "Indicator" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "wildcard" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL DEFAULT 60,
    "severity" TEXT,
    "labels" TEXT[],
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Indicator_pkey" PRIMARY KEY ("organizationId","id")
);

-- CreateIndex
CREATE INDEX "Indicator_organizationId_source_idx" ON "Indicator"("organizationId", "source");

-- AddForeignKey
ALTER TABLE "Indicator" ADD CONSTRAINT "Indicator_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
