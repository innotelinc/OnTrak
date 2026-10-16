-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "aiTools" TEXT,
ADD COLUMN     "courseNumber" INTEGER,
ADD COLUMN     "credentials" TEXT,
ADD COLUMN     "languages" TEXT,
ADD COLUMN     "maxSlotsPerOffering" INTEGER,
ADD COLUMN     "targetIndustries" TEXT,
ADD COLUMN     "targetOccupations" TEXT,
ADD COLUMN     "workplaceTasks" TEXT;
