/*
  Warnings:

  - You are about to drop the column `reviewedAt` on the `Product` table. All the data in the column will be lost.
  - You are about to drop the column `reviewedById` on the `Product` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Product_source_reviewedAt_idx";

-- AlterTable
ALTER TABLE "Product" DROP COLUMN "reviewedAt",
DROP COLUMN "reviewedById",
ADD COLUMN     "lockedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Product_source_idx" ON "Product"("source");
