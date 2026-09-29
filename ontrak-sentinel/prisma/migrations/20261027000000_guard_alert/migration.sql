-- Guard's conclusions, where they can be read (S3).
--
-- This migration adds one table, and the interesting part is what is *not* in it: the
-- telemetry. High-volume observations belong in a columnar or time-series store, and the
-- roadmap says so; a first release that put every packet in Postgres would be a detection
-- platform that gets slow exactly when it is needed. What is durable instead is the
-- conclusion — which rule fired, at which version, about whom, and when — plus the bounded
-- evidence that conclusion was drawn from, so what an operator reads at 09:00 is the same
-- bytes the rule saw at 03:00.
--
-- Three columns carry the milestone's promises:
--
--   1. `(organizationId, dedupeKey)` is UNIQUE. The key is derived from what the
--      observation *is* — the five-tuple and a coarse clock bucket — and never from a
--      vendor's alert id, because vendors disagree about whether a re-send reuses one and
--      the same connection often arrives from both ends. The uniqueness is what makes a
--      hundred packets one incident and a second sensor's copy an update, and it is a
--      constraint rather than a read-then-write because ingestion is concurrent.
--   2. `identityId` / `identityLabel` are nullable, and stay nullable. They are filled from
--      the address a session was granted from — the join between what the network saw and
--      who somebody is — and an event that cannot be attributed is left unattributed.
--      Inventing an owner for it would be worse than saying nobody knows.
--   3. `ruleVersion` fixes which code fired. A rule is edited far more often than an alert
--      is read, and an alert that cannot say which version judged it is an alert nobody can
--      reason about afterwards.
--
-- Every row carries `organizationId` with a cascading foreign key, as the rest of the
-- schema does, so one tenant's detections can never be read from another's.

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "ruleName" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'NEW',
    "dedupeKey" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "sourceAddress" TEXT,
    "identityId" TEXT,
    "identityLabel" TEXT,
    "device" TEXT,
    "asset" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "evidence" JSONB NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Alert_organizationId_state_lastSeenAt_idx" ON "Alert"("organizationId", "state", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_organizationId_dedupeKey_key" ON "Alert"("organizationId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

