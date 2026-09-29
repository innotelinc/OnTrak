-- Reading a directory instead of being pushed to (S2).
--
-- S2's first half made Sentinel a SCIM *server*: a connector authenticates with a token
-- and pushes people in. That works, and it requires somebody to stand up a connector. This
-- is the other direction — Sentinel reads the directory itself — so an organization that
-- already runs Microsoft 365, Google Workspace or an LDAP directory gets its roster in
-- without a project, which is the difference between a feature that exists and a feature
-- it is plausible to turn on.
--
-- Two tables, and each column earns its place:
--
--   1. `DirectoryConnection` — one configured source. `conflictPolicy` says whose edit
--      wins when the directory and a change made here disagree, and it is a *named policy*
--      rather than a boolean because both answers are defensible: "the directory is the
--      source of truth" and "a change here was a decision" are different organizations,
--      not different bugs. `lastSyncedAt` is what makes a local edit detectable at all,
--      and it is advanced only by a run that finished cleanly — a failed sync that moved
--      it would silently stop protecting changes made in the console.
--   2. `DirectorySyncRun` — what each sync did, counts and all. "What did last night's
--      sync do?" is a question with a wrong answer people repeat, so the answer is stored
--      rather than reconstructed from a log. A run that failed to *pull* is recorded too,
--      because the sync that did not happen is exactly the one somebody asks about.
--
-- `DirectoryConnection.secret` is the one value here that has to be readable rather than
-- hashed: a client secret or bind password is needed to call the directory. It is
-- therefore documented — in the schema and in the README — as the deployment's to
-- encrypt, exactly as `MfaFactor.secret` is, and it never rides on the record the console
-- renders; a reader asks for it by id at the moment it uses it.
--
-- Every table carries `organizationId` with a cascading foreign key, as the rest of the
-- schema does, so a connection cannot cross or outlive its tenant.

-- CreateTable
CREATE TABLE "DirectoryConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "secret" TEXT,
    "conflictPolicy" TEXT NOT NULL DEFAULT 'preferDirectory',
    "defaultRole" "IdentityRole" NOT NULL DEFAULT 'AGENT',
    "lastSyncedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DirectoryConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DirectorySyncRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "counts" JSONB NOT NULL,
    "detail" TEXT,

    CONSTRAINT "DirectorySyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DirectoryConnection_organizationId_idx" ON "DirectoryConnection"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "DirectoryConnection_organizationId_name_key" ON "DirectoryConnection"("organizationId", "name");

-- CreateIndex
CREATE INDEX "DirectorySyncRun_organizationId_connectionId_startedAt_idx" ON "DirectorySyncRun"("organizationId", "connectionId", "startedAt");

-- AddForeignKey
ALTER TABLE "DirectoryConnection" ADD CONSTRAINT "DirectoryConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectorySyncRun" ADD CONSTRAINT "DirectorySyncRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectorySyncRun" ADD CONSTRAINT "DirectorySyncRun_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "DirectoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

