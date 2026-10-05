-- The mute (S4): the windows in which a detection is known and must not be raised.
--
-- The other half of "alerts have an off switch". Delivery stops a raised alert going unheard;
-- this stops a known one being raised at all, so a maintenance window, a scanner this desk has
-- accepted, or a load test it scheduled itself does not produce a row every scan forever.
--
--   * `matcher` is one JSONB column, read whole on every batch. A matcher spread across five
--     columns would be a set of silence nobody can reason about while it is being edited, and
--     the rules module is the one place that decides what it matches.
--   * `endsAt` is a required column, not nullable, because a mute with no end is a detection
--     gap that nobody remembers creating — the rules module refuses a window longer than a
--     week, and the column is what a review reads to check.
--   * `(organizationId, endsAt)` is indexed because "what is in force right now" is asked on
--     every ingestion and it is the rail that has to be cheap to check.
--
-- A suppressed detection is recorded on the evidence chain rather than forgotten, so the
-- silence is answerable afterwards instead of reading as a rule that stopped firing.

-- CreateTable
CREATE TABLE "AlertSuppression" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "matcher" JSONB NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdByLabel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlertSuppression_organizationId_endsAt_idx" ON "AlertSuppression"("organizationId", "endsAt");

-- AddForeignKey
ALTER TABLE "AlertSuppression" ADD CONSTRAINT "AlertSuppression_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
