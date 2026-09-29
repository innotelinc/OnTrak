-- TOTP enrollment state (S1).
--
-- `MfaFactor` has existed since the first migration and was never written to:
-- S0 modelled the second factor and then refused every session while
-- `Identity.mfaEnrolled` was false, with nothing able to set it by *proving*
-- anything. These columns are what turn the row into a state machine:
--
--   1. `confirmedAt` — `null` means a secret was generated and nobody has proved
--      they hold it. A code that verifies against the secret is what sets it, and
--      setting it is the only thing that sets `Identity.mfaEnrolled` to true.
--   2. `lastUsedAt` / `lastUsedCounter` — the RFC 6238 step a code was last
--      accepted for. Without it a code captured off the wire stays valid for the
--      rest of its thirty-second window, which is exactly the replay a second
--      factor exists to stop.
--   3. `label` — what the user called the factor, because "which one do I delete?"
--      is a question an identity with an old phone and a new one actually asks.
--
-- The index change is deliberate too: `(organizationId, identityId, kind)` is how
-- every read in `mfa-store-prisma.ts` scopes itself, and the single-column
-- `organizationId` index it replaces is served by that prefix.

-- DropIndex
DROP INDEX "MfaFactor_organizationId_idx";

-- AlterTable
ALTER TABLE "MfaFactor" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "label" TEXT,
ADD COLUMN     "lastUsedAt" TIMESTAMP(3),
ADD COLUMN     "lastUsedCounter" INTEGER;

-- CreateIndex
CREATE INDEX "MfaFactor_organizationId_identityId_kind_idx" ON "MfaFactor"("organizationId", "identityId", "kind");
