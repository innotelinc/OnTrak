-- Access reviews and scheduled attestation (S2).
--
-- S2's other half is provisioning: a directory says who exists, and Sentinel keeps up.
-- This is the question provisioning cannot answer — *should these people still have
-- this access?* A directory drains on its own schedule, and the failure it produces is
-- silent: nobody removes a leaver's group membership, and a year later the roster is a
-- list of everybody who ever joined. An access review is the periodic act of a named
-- person saying, per identity, that the access is still warranted.
--
-- Three tables, and the shape of each is the point:
--
--   1. `AccessReview` — one campaign: who is being asked, about which scope, by when.
--      `reviewerId` is a **named identity, not a role**. Deriving the reviewer from a
--      role would mean a finished review changes meaning the day somebody's role does,
--      which is the one thing an attestation must not do: the record has to say who was
--      asked and keep saying it. Being late is *derived* from `dueAt` rather than stored
--      in `status`, because a stored `OVERDUE` flag is one a scheduler that did not run
--      leaves wrong — and the review that most needs to look late is the one nobody is
--      scheduling. `scheduleId` is `ON DELETE SET NULL`: deleting a schedule must not
--      delete the reviews it already opened, because those are the evidence.
--
--   2. `AccessReviewItem` — one person on one review's list. `decision` defaults to
--      `'PENDING'`, **not** to `'KEPT'`, and that default is the entire value of the
--      feature: an item nobody looked at is not an approval. The difference between
--      “reviewed and kept” and “nobody got to it” is the only thing an auditor is
--      actually asking about, and a schema that defaulted to `KEPT` would erase it on
--      the first review that ran out of time. The `(reviewId, identityId)` unique index
--      makes a second row for the same person impossible, so “how many are still
--      outstanding?” has one answer.
--
--   3. `AccessReviewSchedule` — the recurring part. A review that only happens when
--      somebody remembers is a review that happens for the first two quarters and then
--      stops, so the schedule is stored and the scheduler opens the review.
--      `intervalDays` is bounded by `access-review-rules.ts` rather than by a database
--      constraint, because the useful bound is a judgement (a zero interval would open
--      one review per tick; an interval measured in years is a schedule that exists to
--      be pointed at) and a check constraint is harder to change than a rule.
--
-- Every table carries `organizationId` with a cascading foreign key, as the rest of the
-- schema does, so a review cannot cross or outlive its tenant.

-- CreateTable
CREATE TABLE "AccessReview" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "scopeValue" TEXT NOT NULL DEFAULT '',
    "reviewerId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "scheduleId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AccessReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessReviewItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "decision" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "AccessReviewItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessReviewSchedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "scopeValue" TEXT NOT NULL DEFAULT '',
    "reviewerId" TEXT NOT NULL,
    "intervalDays" INTEGER NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessReviewSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccessReview_organizationId_status_idx" ON "AccessReview"("organizationId", "status");

-- CreateIndex
CREATE INDEX "AccessReview_reviewerId_idx" ON "AccessReview"("reviewerId");

-- CreateIndex
CREATE INDEX "AccessReviewItem_organizationId_idx" ON "AccessReviewItem"("organizationId");

-- CreateIndex
CREATE INDEX "AccessReviewItem_identityId_idx" ON "AccessReviewItem"("identityId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessReviewItem_reviewId_identityId_key" ON "AccessReviewItem"("reviewId", "identityId");

-- CreateIndex
CREATE INDEX "AccessReviewSchedule_organizationId_idx" ON "AccessReviewSchedule"("organizationId");

-- CreateIndex
CREATE INDEX "AccessReviewSchedule_nextRunAt_idx" ON "AccessReviewSchedule"("nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccessReviewSchedule_organizationId_name_key" ON "AccessReviewSchedule"("organizationId", "name");

-- AddForeignKey
ALTER TABLE "AccessReview" ADD CONSTRAINT "AccessReview_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReview" ADD CONSTRAINT "AccessReview_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "AccessReviewSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewItem" ADD CONSTRAINT "AccessReviewItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewItem" ADD CONSTRAINT "AccessReviewItem_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "AccessReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewItem" ADD CONSTRAINT "AccessReviewItem_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewSchedule" ADD CONSTRAINT "AccessReviewSchedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
