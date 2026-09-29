-- Per-role session policies (S1).
--
-- S0 stored one policy per organization and every identity read it. That is the right
-- baseline and the wrong ceiling: an organization very often wants a stricter rule for
-- one class of identity than for the rest — an administrator's session lived short, a
-- service account allowed no interactive sign-in at all — and the only way to say so
-- was to tighten the policy for everybody.
--
-- `scope` carries the difference. `"ALL"` is the organization's baseline, which is what
-- the single existing row becomes; anything else is a role name and overrides the
-- baseline *for that role only*. Two decisions worth stating:
--
--   1. `"ALL"` is a value rather than an absent row. Expressing "everybody" as NULL
--      would mean every read special-casing it, and Postgres would happily allow two
--      NULL rows for the same organization, because NULLs are distinct.
--   2. The uniqueness moves from `(organizationId)` to `(organizationId, scope)`,
--      because the pair is now the row's identity: an administrator edits the AGENT
--      policy, they do not accumulate copies of it. The service writes it with an
--      upsert on exactly that pair.
--
-- `updatedAt` is added so the record names when a control last changed — a policy
-- question is nearly always also a "since when?" question. Nothing wrote this table
-- before this migration, so it is empty in every existing deployment and the
-- not-null column needs no backfill.
--
-- The read path is the pure `policyForRole`: an identity's own role first, then the
-- baseline, then the built-in default. The order matters — a falling back to the code's
-- default the moment a role row was missing would ignore an organization that had
-- deliberately loosened its baseline.

-- DropIndex
DROP INDEX "IdentityPolicy_organizationId_key";

-- AlterTable
ALTER TABLE "IdentityPolicy" ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'ALL',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "IdentityPolicy_organizationId_scope_key" ON "IdentityPolicy"("organizationId", "scope");

