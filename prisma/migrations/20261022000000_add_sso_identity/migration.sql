-- Single sign-on accounts: a provider subject, and no local password to go with it.
--
-- `passwordHash` was NOT NULL, which assumed every account had one. An account
-- provisioned by the identity provider on a first sign-in does not, and inventing a
-- random hash it could never match would be a lie that reads as a credential. Null
-- means "no local password", and `verifyPassword` refuses a null outright, so the
-- email-and-password form cannot sign such an account in.
--
-- `externalId` holds the provider's stable `sub`. Matching a later sign-in on the
-- email alone would create a second account the moment somebody's address changed at
-- the provider, orphaning the first account's attempts, class memberships and
-- certificates. Unique (Postgres allows repeated NULLs), so one provider subject maps
-- to exactly one account here.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "externalId" TEXT,
ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_externalId_key" ON "User"("externalId");
