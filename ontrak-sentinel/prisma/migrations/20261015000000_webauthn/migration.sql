-- WebAuthn second factors, and the ceremony state they need (S1).
--
-- The `MfaKind` enum, the `MfaFactor` table and the `secret` column have carried
-- WebAuthn since the first migration — the enum has had a member nothing issued,
-- which is the honest way to model a factor that was designed for and not built.
-- Two things were missing, and neither is a kind enum:
--
--   1. `MfaFactor.publicKey` / `signCount` — a security key has no shared secret.
--      What has to be stored is the *public* key an assertion is verified against
--      and the authenticator's last signature counter. Neither is a secret, which
--      is why these are the only two columns in Sentinel a support engineer can
--      read without a privilege: a public key is meant to be public, and the
--      counter is a number whose only job is to go up.
--   2. `WebAuthnChallenge` — the ceremony's replay defence. It is a row rather than
--      a signed blob in the page because "accepted exactly once" has to be a fact
--      about our database, and `usedAt` is written with a conditional `updateMany`
--      so two workers racing on one challenge produce one verified ceremony and one
--      refusal. The same isolation rule as every other table here: `organizationId`
--      with a cascading foreign key, so a challenge cannot outlive or cross its
--      tenant.

-- AlterTable
ALTER TABLE "MfaFactor" ADD COLUMN     "publicKey" TEXT,
ADD COLUMN     "signCount" INTEGER;

-- CreateTable
CREATE TABLE "WebAuthnChallenge" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "ceremony" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "rpId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "WebAuthnChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebAuthnChallenge_organizationId_identityId_ceremony_idx" ON "WebAuthnChallenge"("organizationId", "identityId", "ceremony");

-- CreateIndex
CREATE INDEX "WebAuthnChallenge_expiresAt_idx" ON "WebAuthnChallenge"("expiresAt");

-- AddForeignKey
ALTER TABLE "WebAuthnChallenge" ADD CONSTRAINT "WebAuthnChallenge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebAuthnChallenge" ADD CONSTRAINT "WebAuthnChallenge_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
