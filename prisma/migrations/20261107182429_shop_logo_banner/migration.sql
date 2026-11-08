/*
  Warnings:

  - A unique constraint covering the columns `[logoImageId]` on the table `Shop` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[bannerImageId]` on the table `Shop` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "bannerImageId" TEXT,
ADD COLUMN     "logoImageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Shop_logoImageId_key" ON "Shop"("logoImageId");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_bannerImageId_key" ON "Shop"("bannerImageId");

-- AddForeignKey
ALTER TABLE "Shop" ADD CONSTRAINT "Shop_logoImageId_fkey" FOREIGN KEY ("logoImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shop" ADD CONSTRAINT "Shop_bannerImageId_fkey" FOREIGN KEY ("bannerImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;
