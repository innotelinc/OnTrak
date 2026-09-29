-- Logout + token revocation, and SAML 2.0 (S1).
--
-- Two changes, one migration, because they are the same milestone and neither
-- can ship without the other being the thing an integrator reaches for:
--
--   1. `AccessToken.revokedAt` — without it, sign-out can only end a *session*,
--      and a client holding an access token it already fetched keeps working
--      until the hour is up. The column is what makes "sign out" mean "stop
--      working now". Nullable and with `null` meaning *never revoked*: an
--      expired token is a different state, decided from `expiresAt`.
--   2. `SamlServiceProvider` — the SAML counterpart of `OidcClient`. Same
--      isolation rule as every other table here: `organizationId` with a
--      cascading foreign key, so a row cannot outlive or cross its tenant.

-- AlterTable
ALTER TABLE "AccessToken" ADD COLUMN     "revokedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SamlServiceProvider" (
    "entityId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "acsUrls" TEXT[],
    "nameIdFormat" TEXT NOT NULL DEFAULT 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SamlServiceProvider_pkey" PRIMARY KEY ("entityId")
);

-- CreateIndex
CREATE INDEX "SamlServiceProvider_organizationId_idx" ON "SamlServiceProvider"("organizationId");

-- CreateIndex
CREATE INDEX "AccessToken_organizationId_sessionId_revokedAt_idx" ON "AccessToken"("organizationId", "sessionId", "revokedAt");

-- AddForeignKey
ALTER TABLE "SamlServiceProvider" ADD CONSTRAINT "SamlServiceProvider_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
