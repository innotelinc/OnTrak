-- Provisioning: SCIM users, groups, and the tokens a connector arrives with (S2).
--
-- Until now every identity was created by a person in the console. A directory is
-- where identities actually live, and this migration is what lets one push them here.
-- Three separate things, each of which had to be a column or a table rather than a
-- convention:
--
--   1. `Identity.externalId` — the id the *source* directory knows somebody by.
--      Without it a connector can only match on the user name, and a person who
--      changes their name becomes a second identity while the first is orphaned, with
--      its sessions, its factors and its history still attached to the wrong row. The
--      uniqueness is `(organizationId, externalId)`, and it is deliberately *not*
--      unique across the NULLs: Postgres treats NULLs as distinct, so an identity
--      typed into the console and one provisioned by a directory are both ordinary.
--   2. `ScimToken` — the credential a connector authenticates with, stored as
--      `SHA-256(token)`. The plaintext exists once, in the response to the console
--      request that minted it, and never again. `revokedAt` is a timestamp rather than
--      a boolean so the record says *when* a connector stopped being trusted, and
--      `createdBy` is the delegation: every write the connector makes is audited as
--      `scim:<tokenId>`, never as the person who minted it.
--   3. `Group` / `GroupMember` — synced membership. The membership row's primary key is
--      the `(groupId, identityId)` pair, so a connector re-sending the same membership
--      is a no-op rather than a duplicate, which is what a retry needs. A group decides
--      nothing in v1: roles, groups and attribute-based policy are the rest of S1, and
--      that is stated in the schema rather than left to be discovered.
--
-- Every table carries `organizationId` with a cascading foreign key, exactly as the
-- rest of the schema does, so a provisioning row cannot cross or outlive its tenant.

-- AlterTable
ALTER TABLE "Identity" ADD COLUMN     "externalId" TEXT;

-- CreateTable
CREATE TABLE "ScimToken" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "label" TEXT,
    "tokenHash" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ScimToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMember" (
    "groupId" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("groupId","identityId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScimToken_tokenHash_key" ON "ScimToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ScimToken_organizationId_idx" ON "ScimToken"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Group_organizationId_displayName_key" ON "Group"("organizationId", "displayName");

-- CreateIndex
CREATE INDEX "GroupMember_identityId_idx" ON "GroupMember"("identityId");

-- CreateIndex
CREATE UNIQUE INDEX "Identity_organizationId_externalId_key" ON "Identity"("organizationId", "externalId");

-- AddForeignKey
ALTER TABLE "ScimToken" ADD CONSTRAINT "ScimToken_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
