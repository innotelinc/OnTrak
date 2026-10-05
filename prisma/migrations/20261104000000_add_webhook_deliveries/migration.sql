-- Graded attempts handed to a consumer outside this deployment, and the answer.
--
-- A webhook's promise is that "the consumer was told" is checkable, so the row is
-- written before the request goes out: an interrupted delivery is a PENDING row
-- naming its event, which cannot be reconstructed from a log. `eventId` is unique
-- because it is derived from the grading fact (event, attempt, graded-at instant)
-- rather than from the send, so retrying a failed delivery updates the row it
-- belongs to and a consumer can recognise a repeated effort as one fact.
--
-- `body` holds the exact canonical JSON that was signed, so a retry sends the
-- bytes the consumer's signature check already knows how to verify.
--
-- Nothing in this table is read by the training UI: it is an operations record
-- and a reconciliation feed for the consumer, not part of a learner's journey.

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "attemptId" TEXT,
    "url" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastStatus" INTEGER,
    "lastError" TEXT,
    "body" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_eventId_key" ON "WebhookDelivery"("eventId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_createdAt_idx" ON "WebhookDelivery"("status", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_attemptId_idx" ON "WebhookDelivery"("attemptId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_createdAt_idx" ON "WebhookDelivery"("createdAt");
