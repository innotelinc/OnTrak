-- OnTrak Sentinel S1 — the OIDC grant rows.
--
-- Generated from `prisma/schema.prisma` with `prisma migrate diff`; the only
-- edits are this header and the ordering (the three tables are created before
-- their foreign keys are added, so `AuthorizationCode` and `AccessToken` may
-- reference `OidcClient`). Applied by `npm run db:deploy`.
--
-- Two things to notice in what follows. Every table carries `organizationId`
-- and cascades from `Organization`, exactly as S0 does, so deleting a tenant
-- removes its clients and grants and nothing else. And `AccessToken` is keyed on
-- the token's *hash*: the provider hands the token out once and keeps only
-- `SHA-256(token)`, so a copy of this database is a list of sessions that have
-- ended rather than a set of credentials that work.

-- CreateTable
CREATE TABLE "OidcClient" (
    "clientId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "scopes" TEXT[],
    "kind" TEXT NOT NULL DEFAULT 'public',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OidcClient_pkey" PRIMARY KEY ("clientId")
);

-- CreateTable
CREATE TABLE "AuthorizationCode" (
    "code" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "scopes" TEXT[],
    "identityId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "nonce" TEXT,
    "codeChallenge" TEXT NOT NULL,
    "codeChallengeMethod" TEXT NOT NULL DEFAULT 'S256',
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "AuthorizationCode_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "AccessToken" (
    "tokenHash" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "scopes" TEXT[],
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessToken_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateIndex
CREATE INDEX "OidcClient_organizationId_idx" ON "OidcClient"("organizationId");

-- CreateIndex
CREATE INDEX "AuthorizationCode_organizationId_idx" ON "AuthorizationCode"("organizationId");

-- CreateIndex
CREATE INDEX "AuthorizationCode_expiresAt_idx" ON "AuthorizationCode"("expiresAt");

-- CreateIndex
CREATE INDEX "AccessToken_organizationId_idx" ON "AccessToken"("organizationId");

-- CreateIndex
CREATE INDEX "AccessToken_expiresAt_idx" ON "AccessToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "OidcClient" ADD CONSTRAINT "OidcClient_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorizationCode" ADD CONSTRAINT "AuthorizationCode_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorizationCode" ADD CONSTRAINT "AuthorizationCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OidcClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessToken" ADD CONSTRAINT "AccessToken_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessToken" ADD CONSTRAINT "AccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OidcClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;
