-- Enforcement, where it can be read and lifted (S4).
--
-- Two tables, and the interesting part is what is *not* here: nothing that pushes a block
-- to a firewall, proxy or agent. The enforcement *plane* is somebody else's API, and a first
-- release that wrote its own packet filter would be a detection platform pretending to be a
-- firewall. What is durable instead is the action — what was applied, against what, by whom,
-- with which inverse, and whether it is still in force — because the local decision is the
-- part this product owns, and the first question in an incident is "what is blocked right
-- now".
--
-- Three columns carry the milestone's promises:
--
--   1. `state` is stored, not derived. `PENDING` is an action waiting on a second
--      administrator, and a derived flag would make "waiting on somebody" indistinguishable
--      from "nobody asked". `REFUSED` is a state because a refused attempt is evidence: it
--      says somebody asked for a block and a rail stopped them.
--   2. `rollback` is stored beside the action. The inverse of an action is a fact about the
--      action, and recomputing it later would compute it from a policy that has since been
--      edited — which is how an action ends up unliftable by the rules that allowed it.
--   3. `(organizationId, appliedAt)` is an index because the rate limit is a question about
--      time. The rail that has to be cheap to check is the one that stops a response running
--      faster than a person can watch it.
--
-- Every row carries `organizationId` with a cascading foreign key, as the rest of the schema
-- does, so one tenant's actions can never be read from another's.
--
-- The policy is one JSON column rather than a column per rail: it is read whole on every
-- decision, and a policy half-written across six columns is a set of rails nobody can reason
-- about while it is being edited.

-- CreateTable
CREATE TABLE "EnforcementAction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "targets" JSONB NOT NULL,
    "alertId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedByLabel" TEXT NOT NULL,
    "requestedByRole" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedByLabel" TEXT,
    "appliedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "liftedAt" TIMESTAMP(3),
    "liftedById" TEXT,
    "liftedByLabel" TEXT,
    "liftReason" TEXT,
    "refusedCode" TEXT,
    "refusedReason" TEXT,
    "rollback" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnforcementAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnforcementPolicy" (
    "organizationId" TEXT NOT NULL,
    "policy" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnforcementPolicy_pkey" PRIMARY KEY ("organizationId")
);

-- CreateIndex
CREATE INDEX "EnforcementAction_organizationId_state_idx" ON "EnforcementAction"("organizationId", "state");

-- CreateIndex
CREATE INDEX "EnforcementAction_organizationId_appliedAt_idx" ON "EnforcementAction"("organizationId", "appliedAt");

-- CreateIndex
CREATE INDEX "EnforcementAction_organizationId_alertId_idx" ON "EnforcementAction"("organizationId", "alertId");

-- AddForeignKey
ALTER TABLE "EnforcementAction" ADD CONSTRAINT "EnforcementAction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnforcementPolicy" ADD CONSTRAINT "EnforcementPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
