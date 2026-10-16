-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "topicAreas" TEXT;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "eligibilityMemoExpiresOn" TIMESTAMP(3),
ADD COLUMN     "fein" TEXT;

-- AlterTable
ALTER TABLE "Program" ADD COLUMN     "allocationCents" INTEGER,
ADD COLUMN     "contractEndsOn" TIMESTAMP(3),
ADD COLUMN     "contractStartsOn" TIMESTAMP(3),
ADD COLUMN     "employerSlotCap" INTEGER,
ADD COLUMN     "maxCourses" INTEGER;
