-- AlterTable
ALTER TABLE "Attempt" ADD COLUMN     "certificate" JSONB,
ADD COLUMN     "certificateIssuedAt" TIMESTAMP(3),
ADD COLUMN     "certificateRevokedAt" TIMESTAMP(3);
