-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "listingNote" TEXT,
ADD COLUMN     "listingSuspendedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "contactEmail" TEXT,
ADD COLUMN     "contactName" TEXT,
ADD COLUMN     "contactPhone" TEXT;
